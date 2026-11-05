-- "Discover" tab. Run this whole file once in Supabase -> SQL Editor. Safe to run again.
-- What people of the app SEE (shown) and what they ADD (added), per title, for everyone. Only keys (movie:603) and counts, nothing about a person.
-- Only the "discover" Edge Function (service role) can read or write it.
create table if not exists public.discover_votes (
  cand_key   text primary key,             -- movie:603
  shown      int  not null default 0,
  added      int  not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.discover_votes enable row level security;
revoke all on public.discover_votes from anon, authenticated;

create or replace function public.discover_vote(p_shown text[], p_added text[])
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.discover_votes(cand_key, shown, added)
    select k, 1, 0 from unnest(p_shown) as k
    on conflict (cand_key) do update set shown = public.discover_votes.shown + 1, updated_at = now();
  insert into public.discover_votes(cand_key, shown, added)
    select k, 0, 1 from unnest(p_added) as k
    on conflict (cand_key) do update set added = public.discover_votes.added + 1, updated_at = now();
end $$;
revoke execute on function public.discover_vote(text[], text[]) from public, anon, authenticated;
grant  execute on function public.discover_vote(text[], text[]) to service_role;
