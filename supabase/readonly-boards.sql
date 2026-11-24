-- JamBoard: view-only boards. Run once in Supabase → SQL Editor, after private-boards.sql (safe to run again).
--
-- A board whose meta (boards/<id>) has "ro": true can be read by anyone with its link, but the browser
-- can't change it: no items, timer, title or meta. Only its cover thumbnail (boards/<id>/cover/v1) may be
-- refreshed. The MCP server writes with the service role straight to the table, so it can still edit the board.
-- The browser can never set or clear "ro" itself; only this script (or SQL / the MCP) does.
-- The last statement marks the demo board (config.js defaultBoard) as view-only.

create or replace function public.jb_board_ro(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (d.data->>'ro')::boolean from public.docs d
                   where d.path = 'boards/' || substring(p_path from '^boards/([A-Za-z0-9_-]{20,64})')), false)
$$;
revoke execute on function public.jb_board_ro(text) from public, anon, authenticated;

create or replace function public.jb_put(p_path text, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.jb_path_ok(p_path) then raise exception 'Not a board path' using errcode = '42501'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'Data must be an object' using errcode = '22023'; end if;
  if p_data ? 'ro' then raise exception 'Only the owner can make a board view-only' using errcode = '42501'; end if;
  if public.jb_board_ro(p_path) and p_path !~ '^boards/[A-Za-z0-9_-]{20,64}/cover/v1$' then
    raise exception 'This board is view-only' using errcode = '42501';
  end if;
  insert into public.docs (path, coll, data, updated_at)
  values (p_path, regexp_replace(p_path, '/[^/]+$', ''), p_data, now())
  on conflict (path) do update set data = excluded.data, coll = excluded.coll, updated_at = now();
end $$;

create or replace function public.jb_del(p_path text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.jb_path_ok(p_path) then raise exception 'Not a board path' using errcode = '42501'; end if;
  if public.jb_board_ro(p_path) then raise exception 'This board is view-only' using errcode = '42501'; end if;
  delete from public.docs where path = p_path;
end $$;

revoke execute on function public.jb_put(text, jsonb), public.jb_del(text) from public;
grant execute on function public.jb_put(text, jsonb), public.jb_del(text) to anon, authenticated, service_role;

-- the demo board becomes view-only (same id as defaultBoard in config.js)
update public.docs set data = data || '{"ro": true}'::jsonb where path = 'boards/7JnHshrp8cN4tGnQKPoY2Ifp';
select path, data->>'title' as title, data->>'ro' as ro from public.docs where path = 'boards/7JnHshrp8cN4tGnQKPoY2Ifp';
