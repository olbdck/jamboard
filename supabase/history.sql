-- JamBoard: version history. Run once in Supabase → SQL Editor, after private-boards.sql and readonly-boards.sql
-- (safe to run again).
--
-- What it does:
--   1. Every change to a board's items (boards/<id>/items/<item>) is written to `docs_log`: the new state of the item
--      (or null when it was deleted), who made it and when. Quick edits of the same item by the same person within
--      two minutes are folded into one row, so dragging or typing does not flood the log.
--   2. jb_put / jb_del take an optional last argument p_who = {n, e, c, v, r} (name, animal, colour, voter id;
--      r while restoring a version),
--      so the history can say who changed what. Older pages that call them with two arguments keep working.
--      Writes by the MCP server (service role) are signed as Claude.
--   3. Two read functions for the browser, scoped to one board like jb_get / jb_list:
--        jb_history(p_bid, p_before, p_limit)  the latest changes (newest first): id, path, at, who, op, type, label
--        jb_at(p_bid, p_id)                    the whole board as it was right after change p_id: path, data
--   4. The current state of every existing board is saved as the starting point of its history.
-- The log itself is invisible to the browser key. Restoring is done by the page, as ordinary single-item writes.
--
-- Housekeeping (optional): jb_log_compact(days) forgets the steps older than `days`, keeping the last state of every
-- item before that, so old versions can still be restored to the cut-off. With pg_cron enabled:
--   select cron.schedule('jamboard-log-compact', '17 3 * * *', $$select public.jb_log_compact(120)$$);

-- ---------- 1. the log ----------
create table if not exists public.docs_log (
  id   bigint generated always as identity primary key,
  bid  text not null,
  path text not null,
  data jsonb,                          -- the item after the change; null = deleted
  who  jsonb,                          -- {n, e, c, v} from the page, {n:'Claude', mcp:true} from the MCP, {seed:true} for the starting point
  wk   text not null default '',       -- who, as a key for folding quick edits together
  at   timestamptz not null default now()
);
create index if not exists docs_log_bid_idx  on public.docs_log (bid, id desc);
create index if not exists docs_log_path_idx on public.docs_log (path, id desc);
alter table public.docs_log enable row level security; -- no policies: invisible to anon / authenticated
revoke all on table public.docs_log from anon, authenticated;

create or replace function public.docs_log_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r record; d jsonb; b text; w jsonb; k text; last record; claims jsonb;
begin
  if tg_op = 'DELETE' then r := old; d := null; else r := new; d := new.data; end if;
  b := substring(r.path from '^boards/([A-Za-z0-9_-]{20,64})/items/[A-Za-z0-9_-]+$');
  if b is null then return null; end if;
  -- nothing really changed (a new revision, or a field set to null that was not there)
  if tg_op = 'UPDATE' and (jsonb_strip_nulls(old.data) - 'rev') = (jsonb_strip_nulls(new.data) - 'rev') then return null; end if;
  begin w := nullif(current_setting('jb.who', true), '')::jsonb; exception when others then w := null; end;
  if w is null then
    begin claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then claims := null; end;
    if coalesce(claims->>'role', '') = 'service_role' then w := '{"n":"Claude","e":"✦","mcp":true}'::jsonb; end if;
  end if;
  k := coalesce(w->>'v', w->>'n', '') || coalesce('/' || (w->>'r'), ''); -- a restore never folds into ordinary edits
  if d is not null then
    select l.id, l.wk, l.at, l.data is not null as live into last
      from public.docs_log l where l.path = r.path order by l.id desc limit 1;
    if found and last.live and last.wk = k and k <> '' and last.at > now() - interval '2 minutes' then
      update public.docs_log set data = d, who = coalesce(w, who), at = now() where id = last.id;
      return null;
    end if;
  end if;
  insert into public.docs_log (bid, path, data, who, wk) values (b, r.path, d, w, k);
  return null;
exception when others then
  return null; -- the history never blocks a write
end $$;
drop trigger if exists docs_log_write on public.docs;
create trigger docs_log_write after insert or update or delete on public.docs
  for each row execute function public.docs_log_write();

-- ---------- 2. jb_put / jb_del with who (same checks as readonly-boards.sql) ----------
drop function if exists public.jb_put(text, jsonb);
drop function if exists public.jb_del(text);

create or replace function public.jb_who(p_who jsonb) returns void
language plpgsql set search_path = public as $$
begin
  if p_who is null or jsonb_typeof(p_who) <> 'object' then return; end if;
  perform set_config('jb.who', jsonb_strip_nulls(jsonb_build_object(
    'n', left(p_who->>'n', 32), 'e', left(p_who->>'e', 8), 'c', left(p_who->>'c', 16), 'v', left(p_who->>'v', 40),
    'r', left(p_who->>'r', 40)))::text, true); -- r: set while restoring an older version (its time, for the list)
end $$;
revoke execute on function public.jb_who(jsonb) from public, anon, authenticated;

create or replace function public.jb_put(p_path text, p_data jsonb, p_who jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.jb_path_ok(p_path) then raise exception 'Not a board path' using errcode = '42501'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'Data must be an object' using errcode = '22023'; end if;
  if p_data ? 'ro' then raise exception 'Only the owner can make a board view-only' using errcode = '42501'; end if;
  if public.jb_board_ro(p_path) and p_path !~ '^boards/[A-Za-z0-9_-]{20,64}/cover/v1$' then
    raise exception 'This board is view-only' using errcode = '42501';
  end if;
  perform public.jb_who(p_who);
  insert into public.docs (path, coll, data, updated_at)
  values (p_path, regexp_replace(p_path, '/[^/]+$', ''), p_data, now())
  on conflict (path) do update set data = excluded.data, coll = excluded.coll, updated_at = now();
end $$;

create or replace function public.jb_del(p_path text, p_who jsonb default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.jb_path_ok(p_path) then raise exception 'Not a board path' using errcode = '42501'; end if;
  if public.jb_board_ro(p_path) then raise exception 'This board is view-only' using errcode = '42501'; end if;
  perform public.jb_who(p_who);
  delete from public.docs where path = p_path;
end $$;

revoke execute on function public.jb_put(text, jsonb, jsonb), public.jb_del(text, jsonb) from public;
grant execute on function public.jb_put(text, jsonb, jsonb), public.jb_del(text, jsonb) to anon, authenticated, service_role;

-- ---------- 3. reading the history ----------
-- op: add | edit | move (only position / order changed) | del; label: a short text of the item (none while it is hidden)
create or replace function public.jb_history(p_bid text, p_before bigint default null, p_limit int default 200)
returns table (id bigint, path text, at timestamptz, who jsonb, op text, type text, label text)
language sql stable security definer set search_path = public as $$
  select l.id, l.path, l.at, l.who,
         case when l.data is null then 'del'
              when p.data is null then 'add'
              when (jsonb_strip_nulls(l.data) - array['x','y','z','rev','sec','grid','cell']) = (jsonb_strip_nulls(p.data) - array['x','y','z','rev','sec','grid','cell']) then 'move'
              else 'edit' end,
         coalesce(l.data, p.data)->>'type',
         case when coalesce(l.data, p.data) ? 'hid' then null
              else left(coalesce(nullif(coalesce(l.data, p.data)->>'text', ''), nullif(coalesce(l.data, p.data)->>'title', ''),
                                 nullif(coalesce(l.data, p.data)->>'label', ''), nullif(coalesce(l.data, p.data)->>'emoji', '')), 80) end
  from public.docs_log l
  left join lateral (select q.data from public.docs_log q where q.path = l.path and q.id < l.id order by q.id desc limit 1) p on true
  where public.jb_path_ok('boards/' || p_bid) and l.bid = p_bid and (p_before is null or l.id < p_before)
  order by l.id desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

create or replace function public.jb_at(p_bid text, p_id bigint) returns table (path text, data jsonb)
language sql stable security definer set search_path = public as $$
  select s.path, s.data from (
    select distinct on (l.path) l.path, l.data from public.docs_log l
    where public.jb_path_ok('boards/' || p_bid) and l.bid = p_bid and l.id <= p_id
    order by l.path, l.id desc
  ) s where s.data is not null
$$;

revoke execute on function public.jb_history(text, bigint, int), public.jb_at(text, bigint) from public;
grant execute on function public.jb_history(text, bigint, int), public.jb_at(text, bigint) to anon, authenticated, service_role;

-- ---------- housekeeping ----------
create or replace function public.jb_log_compact(days int default 120) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  with old as (
    select l.id, row_number() over (partition by l.path order by l.id desc) as k
    from public.docs_log l where l.at < now() - make_interval(days => greatest(days, 1))
  )
  delete from public.docs_log l using old
  where l.id = old.id and (old.k > 1 or l.data is null); -- keep the last state of each item from before the cut-off
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.jb_log_compact(int) from public, anon, authenticated;

-- ---------- 4. the starting point: what every board looks like now ----------
insert into public.docs_log (bid, path, data, who, wk, at)
select substring(d.path from '^boards/([A-Za-z0-9_-]{20,64})/items/'), d.path, d.data, '{"seed":true}'::jsonb, '', d.updated_at
from public.docs d
where d.path ~ '^boards/[A-Za-z0-9_-]{20,64}/items/[A-Za-z0-9_-]+$'
  and not exists (select 1 from public.docs_log l where l.path = d.path)
order by d.updated_at, d.path;

notify pgrst, 'reload schema';
select count(*) as items_in_history, count(distinct bid) as boards from public.docs_log;
