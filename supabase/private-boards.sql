-- JamBoard: private boards ("anyone with the link"). Run once in Supabase → SQL Editor,
-- after schema.sql and security.sql (safe to run again).
--
-- What it does:
--   1. The browser key can no longer read or write the `docs` table directly. It goes through four
--      functions (jb_get, jb_list, jb_put, jb_del) that only accept paths inside one board,
--      boards/<id>/..., with an id of 20+ characters. Nothing lists boards, so a board can only be
--      opened by someone who has its link.
--   2. Live updates: every change to a board is broadcast on that board's own realtime topic
--      `jb:<id>` (from the database, so edits made through the MCP arrive live too).
--      Table-wide postgres_changes are switched off.
--   3. Images: the bucket stays public for direct links, but its file list can no longer be read
--      (folders are named by board id).
--   4. Old boards ("main" and short ids) are copied to new random ids, then removed from `docs`
--      (they stay in docs_trash). The demo board gets the fixed id from config.js, since it is public anyway.
--      The last query prints the new links: copy them, they are not stored anywhere public.

-- ---------- 1. access only through board-scoped functions ----------
create or replace function public.jb_path_ok(p text, is_coll boolean default false) returns boolean
language sql immutable set search_path = public as $$
  select case when is_coll then p ~ '^boards/[A-Za-z0-9_-]{20,64}(/[A-Za-z0-9_-]{1,64}){1,2}$'
              else p ~ '^boards/[A-Za-z0-9_-]{20,64}(/[A-Za-z0-9_-]{1,64}){0,3}$' end
$$;

create or replace function public.jb_get(p_path text) returns table (path text, data jsonb)
language sql stable security definer set search_path = public as $$
  select d.path, d.data from public.docs d where public.jb_path_ok(p_path) and d.path = p_path
$$;

create or replace function public.jb_list(p_coll text) returns table (path text, data jsonb)
language sql stable security definer set search_path = public as $$
  select d.path, d.data from public.docs d where public.jb_path_ok(p_coll, true) and d.coll = p_coll
$$;

create or replace function public.jb_put(p_path text, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.jb_path_ok(p_path) then raise exception 'Not a board path' using errcode = '42501'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'Data must be an object' using errcode = '22023'; end if;
  insert into public.docs (path, coll, data, updated_at)
  values (p_path, regexp_replace(p_path, '/[^/]+$', ''), p_data, now())
  on conflict (path) do update set data = excluded.data, coll = excluded.coll, updated_at = now();
end $$;

create or replace function public.jb_del(p_path text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.jb_path_ok(p_path) then raise exception 'Not a board path' using errcode = '42501'; end if;
  delete from public.docs where path = p_path;
end $$;

revoke execute on function public.jb_get(text), public.jb_list(text), public.jb_put(text, jsonb), public.jb_del(text) from public;
grant execute on function public.jb_get(text), public.jb_list(text), public.jb_put(text, jsonb), public.jb_del(text) to anon, authenticated, service_role;
grant execute on function public.jb_path_ok(text, boolean) to anon, authenticated, service_role;

-- the table itself: service role only (the MCP server)
drop policy if exists "open board read"   on public.docs;
drop policy if exists "open board insert" on public.docs;
drop policy if exists "open board update" on public.docs;
drop policy if exists "open board delete" on public.docs;
revoke select, insert, update, delete on table public.docs from anon, authenticated;
grant select, insert, update, delete on table public.docs to service_role;

-- ---------- 4. move old boards to new random ids (before the broadcast trigger, so this stays quiet) ----------
create table if not exists public.jb_moved (
  old text primary key,
  new text not null,
  title text,
  moved_at timestamptz not null default now()
);
alter table public.jb_moved enable row level security; -- no policies: invisible to the browser
revoke all on table public.jb_moved from anon, authenticated;

do $$
declare
  b record; nid text; old_rows text[];
  demo_old constant text := 'budslw073hv';
  demo_new constant text := '7JnHshrp8cN4tGnQKPoY2Ifp'; -- same as defaultBoard in config.js
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  -- the original board: items/*, board/meta, board/timer
  if not exists (select 1 from public.jb_moved where old = 'main')
     and exists (select 1 from public.docs where coll = 'items' or path in ('board/meta', 'board/timer')) then
    nid := replace(gen_random_uuid()::text, '-', '');
    insert into public.jb_moved (old, new, title)
      values ('main', nid, coalesce((select data->>'title' from public.docs where path = 'board/meta'), 'Спринт 48 · планінг'));
    insert into public.docs (path, coll, data)
      values ('boards/' || nid, 'boards',
              jsonb_build_object('title', (select title from public.jb_moved where old = 'main'), 'at', now_ms, 'by', ''));
    insert into public.docs (path, coll, data)
      select 'boards/' || nid || '/items/' || split_part(d.path, '/', 2), 'boards/' || nid || '/items', d.data
      from public.docs d where d.coll = 'items';
    insert into public.docs (path, coll, data)
      select 'boards/' || nid || '/timer/state', 'boards/' || nid || '/timer', d.data
      from public.docs d where d.path = 'board/timer';
    delete from public.docs where coll = 'items' or path in ('board/meta', 'board/timer');
  end if;

  -- every other board whose id is too short to be a secret
  for b in
    select distinct split_part(d.path, '/', 2) as id from public.docs d
    where d.path like 'boards/%' and split_part(d.path, '/', 2) !~ '^[A-Za-z0-9_-]{20,64}$'
  loop
    if exists (select 1 from public.jb_moved where old = b.id) then
      nid := (select new from public.jb_moved where old = b.id);
    elsif b.id = demo_old then
      nid := demo_new;
    else
      nid := replace(gen_random_uuid()::text, '-', '');
    end if;
    insert into public.jb_moved (old, new, title)
      values (b.id, nid, (select data->>'title' from public.docs where path = 'boards/' || b.id))
      on conflict (old) do nothing;
    select array_agg(d.path) into old_rows from public.docs d
      where d.path = 'boards/' || b.id or starts_with(d.path, 'boards/' || b.id || '/');
    insert into public.docs (path, coll, data)
      select np, regexp_replace(np, '/[^/]+$', ''), d.data
      from public.docs d, lateral (select 'boards/' || nid || substr(d.path, length('boards/' || b.id) + 1) as np) x
      where d.path = any (old_rows)
      on conflict (path) do nothing;
    delete from public.docs where path = any (old_rows);
  end loop;
end $$;

-- ---------- 2. live updates on each board's own topic ----------
create or replace function public.docs_broadcast() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record; bid text; msg jsonb;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  bid := substring(r.path from '^boards/([A-Za-z0-9_-]{20,64})(?:/|$)');
  if bid is null then return null; end if;
  if tg_op = 'DELETE' then msg := jsonb_build_object('path', r.path, 'gone', true);
  elsif pg_column_size(r.data) > 200000 then msg := jsonb_build_object('path', r.path, 'big', true); -- too big for a broadcast: clients fetch it
  else msg := jsonb_build_object('path', r.path, 'data', r.data); end if;
  begin
    perform realtime.send(msg, 'row', 'jb:' || bid, false);
  exception when others then null; -- never fail a write because realtime is unavailable; clients fall back to polling
  end;
  return null;
end $$;
drop trigger if exists docs_broadcast on public.docs;
create trigger docs_broadcast after insert or update or delete on public.docs
  for each row execute function public.docs_broadcast();

do $$ begin
  alter publication supabase_realtime drop table public.docs;
exception when others then null; end $$;

-- ---------- 3. images: direct links only, no file list ----------
update storage.buckets set public = true where id = 'jamboard';
drop policy if exists "jamboard images read" on storage.objects;

-- ---------- the new links (copy them; old links no longer open) ----------
select coalesce(title, '') as title, old as old_id, new as new_id,
       'https://olbdck.github.io/jamboard/#b=' || new as link
from public.jb_moved order by moved_at, title;
