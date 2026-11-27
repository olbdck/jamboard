-- JamBoard: personal MCP tokens. Run once in Supabase → SQL Editor, after private-boards.sql (safe to run again).
--
-- Anyone can connect JamBoard to their own Claude without the admin key: «Налаштування» in the app makes a
-- random token in the browser (jbt_ + 40 chars, ~238 bits) and registers it here together with the boards
-- it may reach (the boards that browser created or opened, which it already has the links to).
--   * Only the SHA-256 of the token is stored. The token itself lives only in that browser and in Claude.
--   * A token reaches only its own list of boards; it can never list other boards. View-only boards stay view-only.
--   * Whoever knows the token can change its board list or revoke it (that is the same browser).
--   * A token that has not been used or refreshed for 90 days stops working (the MCP server checks).
-- The browser can't read this table; it only calls the two functions below. The MCP server reads it with the service role.

create table if not exists public.mcp_tokens (
  hash text primary key,                         -- encode(sha256(token), 'hex')
  boards text[] not null default '{}',           -- board ids this token may open
  name text,                                      -- the visitor's name on the board, for the dashboard only
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.mcp_tokens enable row level security; -- no policies: invisible to anon / authenticated
revoke all on table public.mcp_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.mcp_tokens to service_role;

create or replace function public.jb_token_hash(p_token text) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

-- register a token or replace its board list; returns { boards: <kept>, used_at }
create or replace function public.jb_mcp_token_put(p_token text, p_boards text[], p_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare keep text[]; h text; used timestamptz;
begin
  if p_token is null or p_token !~ '^jbt_[A-Za-z0-9]{40}$' then raise exception 'Bad token' using errcode = '22023'; end if;
  h := public.jb_token_hash(p_token);
  -- only real boards, each once, at most 300 (a board id is itself the secret, so this grants nothing new)
  select coalesce(array_agg(b order by b), '{}') into keep from (
    select distinct b from unnest(coalesce(p_boards, '{}')) as b
    where b ~ '^[A-Za-z0-9_-]{20,64}$' and exists (select 1 from public.docs d where d.path = 'boards/' || b)
    limit 300) s;
  if not exists (select 1 from public.mcp_tokens where hash = h)
     and (select count(*) from public.mcp_tokens) >= 100000 then
    raise exception 'Too many tokens' using errcode = '54000';
  end if;
  insert into public.mcp_tokens (hash, boards, name) values (h, keep, left(p_name, 40))
  on conflict (hash) do update set boards = excluded.boards, name = coalesce(excluded.name, public.mcp_tokens.name), updated_at = now()
  returning used_at into used;
  return jsonb_build_object('boards', cardinality(keep), 'used_at', used);
end $$;

-- revoke: the token stops working at once
create or replace function public.jb_mcp_token_del(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.mcp_tokens where p_token ~ '^jbt_[A-Za-z0-9]{40}$' and hash = public.jb_token_hash(p_token)
$$;

revoke execute on function public.jb_token_hash(text) from public, anon, authenticated;
revoke execute on function public.jb_mcp_token_put(text, text[], text), public.jb_mcp_token_del(text) from public;
grant execute on function public.jb_mcp_token_put(text, text[], text), public.jb_mcp_token_del(text) to anon, authenticated, service_role;
