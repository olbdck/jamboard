-- JamBoard hardening. Run once in Supabase → SQL Editor (safe to run again).
-- Boards are open to everyone without sign-in, so the public key can read and write `docs`.
-- This does not close that (it is the product), but it stops the cheap ways to break it:
--   1. one request can no longer wipe or rewrite the whole table (max 20 rows per delete/update from the browser);
--   2. every deleted row is kept in `docs_trash`, which the public key cannot read or touch, so anything can be restored;
--   3. junk is bounded: path format, 1 MB per document, 5 MB per image.
-- The MCP server uses the service role and is not limited.

-- 1 + 2: trash and per-request limits
create table if not exists public.docs_trash (
  id bigint generated always as identity primary key,
  path text not null,
  data jsonb,
  deleted_at timestamptz not null default now(),
  deleted_by text
);
alter table public.docs_trash enable row level security; -- no policies: invisible to anon / authenticated
revoke all on table public.docs_trash from anon, authenticated;

create or replace function public.docs_keep_deleted() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.docs_trash (path, data, deleted_by) select o.path, o.data, coalesce(nullif(current_setting('role', true), 'none'), session_user) from old_rows o;
  return null;
end $$;

create or replace function public.docs_limit_rows() returns trigger
language plpgsql set search_path = public as $$ -- not security definer: it must see the caller's role
declare n int;
begin
  if current_user not in ('anon', 'authenticated') then return null; end if; -- service role / dashboard: no limit
  if tg_op = 'DELETE' then select count(*) into n from old_rows; else select count(*) into n from new_rows; end if;
  if n > 20 then raise exception 'Too many rows in one request (%). JamBoard changes one item at a time.', n using errcode = '42501'; end if;
  return null;
end $$;

drop trigger if exists docs_keep_deleted on public.docs;
create trigger docs_keep_deleted after delete on public.docs
  referencing old table as old_rows for each statement execute function public.docs_keep_deleted();
drop trigger if exists docs_limit_delete on public.docs;
create trigger docs_limit_delete after delete on public.docs
  referencing old table as old_rows for each statement execute function public.docs_limit_rows();
drop trigger if exists docs_limit_update on public.docs;
create trigger docs_limit_update after update on public.docs
  referencing new table as new_rows for each statement execute function public.docs_limit_rows();

-- 3: bounds on what can be stored (NOT VALID: checks new writes, leaves existing rows alone)
alter table public.docs drop constraint if exists docs_path_ok;
alter table public.docs add constraint docs_path_ok check (path ~ '^(items|board|boards)(/[A-Za-z0-9_-]{1,64}){1,4}$') not valid;
alter table public.docs drop constraint if exists docs_size_ok;
alter table public.docs add constraint docs_size_ok check (pg_column_size(data) <= 1048576) not valid;
update storage.buckets set file_size_limit = 5242880 where id = 'jamboard';

-- Restore everything deleted in the last hour (change the interval as needed):
--   insert into public.docs (path, coll, data)
--   select distinct on (path) path, regexp_replace(path, '/[^/]+$', ''), data from public.docs_trash
--   where deleted_at > now() - interval '1 hour' order by path, deleted_at desc
--   on conflict (path) do nothing;
