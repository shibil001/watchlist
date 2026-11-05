-- "Trending in <country>" in the Discover tab. Run this whole file once in Supabase -> SQL Editor. Safe to run again.
-- One count per title added to a list, per country and day. Nothing about a person: no user, no device, no IP. Rows older than 30 days are deleted.
-- Only the "discover" Edge Function (service role) can read or write it.
create table if not exists public.discover_region_adds (
  country  text not null,                   -- IN
  cand_key text not null,                   -- movie:603
  day      date not null default current_date,
  added    int  not null default 0,
  primary key (country, cand_key, day)
);
create index if not exists discover_region_adds_day on public.discover_region_adds (day);
alter table public.discover_region_adds enable row level security;
revoke all on public.discover_region_adds from anon, authenticated;

create or replace function public.discover_region_add(p_country text, p_keys text[])
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_country !~ '^[A-Z]{2}$' then return; end if;
  insert into public.discover_region_adds (country, cand_key, day, added)
    select p_country, k, current_date, 1 from unnest(p_keys) as k
    on conflict (country, cand_key, day) do update set added = public.discover_region_adds.added + 1;
  delete from public.discover_region_adds where day < current_date - 30;
end $$;
revoke execute on function public.discover_region_add(text, text[]) from public, anon, authenticated;
grant  execute on function public.discover_region_add(text, text[]) to service_role;

-- Saved trending answers (so a Gemini / TMDB answer is built once per few hours for everyone, not on every open). Only the "discover" function can read or write it.
create table if not exists public.discover_trend_cache (
  k          text primary key,              -- glob2, reg2:IN ...
  body       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.discover_trend_cache enable row level security;
revoke all on public.discover_trend_cache from anon, authenticated;
