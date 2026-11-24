-- JamBoard: run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Boards are open to anyone with the link, like the prototype: no sign-in.

create table if not exists public.docs (
  path       text primary key check (char_length(path) <= 200),
  coll       text not null check (char_length(coll) <= 200),
  data       jsonb not null check (pg_column_size(data) < 400000),
  updated_at timestamptz not null default now()
);
create index if not exists docs_coll_idx on public.docs (coll);

-- newer Supabase projects don't expose new tables to the browser roles by default
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on table public.docs to anon, authenticated, service_role;

alter table public.docs enable row level security;
drop policy if exists "open board read"   on public.docs;
drop policy if exists "open board insert" on public.docs;
drop policy if exists "open board update" on public.docs;
drop policy if exists "open board delete" on public.docs;
create policy "open board read"   on public.docs for select using (true);
create policy "open board insert" on public.docs for insert with check (true);
create policy "open board update" on public.docs for update using (true) with check (true);
create policy "open board delete" on public.docs for delete using (true);

-- live updates for the board
alter table public.docs replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- pasted images
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('jamboard', 'jamboard', true, 20971520, array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;
drop policy if exists "jamboard images read"   on storage.objects;
drop policy if exists "jamboard images upload" on storage.objects;
create policy "jamboard images read"   on storage.objects for select using (bucket_id = 'jamboard');
create policy "jamboard images upload" on storage.objects for insert with check (bucket_id = 'jamboard');
