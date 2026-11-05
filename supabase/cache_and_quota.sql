-- v93: (1) a database cache for the most searched titles / directors / actors, (2) a call counter for outside APIs (Watchmode).
-- Run this whole file once in Supabase -> SQL Editor. Safe to run again.
-- Nobody can read or write these tables directly: only the Edge Functions (service role) can.

-- ===== 1. Hot cache: what people search most is answered from here, not from TMDB =====
-- k    = the TMDB request (path + sorted params), e.g. "/person/525?append_to_response=combined_credits"
-- body = TMDB's answer, saved only once the same request has been seen twice (so one-off searches never fill the database)
-- hits = how many times it was asked (this is the "most searched" count)
create table if not exists public.hot_cache (
  k        text primary key,
  body     text,
  hits     int         not null default 0,
  saved_at timestamptz,
  last_hit timestamptz not null default now()
);
create index if not exists hot_cache_last_hit on public.hot_cache (last_hit);
alter table public.hot_cache enable row level security;
revoke all on public.hot_cache from anon, authenticated;

-- Ask for one request. Counts the hit. Returns the saved body only while it is younger than p_ttl seconds.
create or replace function public.hot_get(p_k text, p_ttl int)
returns table (body text, hits int)
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  insert into public.hot_cache(k, hits, last_hit) values (p_k, 1, now())
    on conflict (k) do update set hits = public.hot_cache.hits + 1, last_hit = now();
  -- housekeeping, about 1 call in 100: forget what nobody asks for
  if random() < 0.01 then
    delete from public.hot_cache
     where last_hit < now() - interval '30 days'
        or (hits < 3 and last_hit < now() - interval '3 days');
  end if;
  return query
    select case when c.saved_at is not null and c.saved_at > now() - make_interval(secs => p_ttl) then c.body else null end, c.hits
      from public.hot_cache c where c.k = p_k;
end $$;

-- Save TMDB's answer, but only when this request has been asked at least p_min times.
create or replace function public.hot_put(p_k text, p_body text, p_min int)
returns void
language sql security definer
set search_path = public
as $$
  update public.hot_cache set body = p_body, saved_at = now() where k = p_k and hits >= p_min;
$$;

revoke execute on function public.hot_get(text, int), public.hot_put(text, text, int) from public, anon, authenticated;
grant  execute on function public.hot_get(text, int), public.hot_put(text, text, int) to service_role;

-- See what is searched most (run in the SQL Editor any time):
--   select k, hits, saved_at from public.hot_cache order by hits desc limit 50;

-- ===== 2. Outside API call counter (Watchmode free plan = 1000 calls a month) =====
create table if not exists public.api_usage (
  api     text not null,
  period  text not null,          -- '2026-11' for a month, '2026-11-05' for a day
  calls   int  not null default 0,
  blocked boolean not null default false,
  primary key (api, period)
);
alter table public.api_usage enable row level security;
revoke all on public.api_usage from anon, authenticated;

-- Asks for p_n calls; returns how many may be made (0 when the cap is reached). Counted atomically.
create or replace function public.api_reserve(p_api text, p_period text, p_n int, p_cap int)
returns int
language plpgsql security definer
set search_path = public
as $$
declare v_calls int; v_blocked boolean; v_grant int;
begin
  insert into public.api_usage(api, period) values (p_api, p_period) on conflict do nothing;
  select calls, blocked into v_calls, v_blocked from public.api_usage where api = p_api and period = p_period for update;
  if v_blocked then return 0; end if;
  v_grant := greatest(0, least(p_n, p_cap - v_calls));
  update public.api_usage set calls = calls + v_grant where api = p_api and period = p_period;
  if random() < 0.02 then delete from public.api_usage where period < to_char(now() - interval '120 days', 'YYYY-MM-DD'); end if;
  return v_grant;
end $$;

revoke execute on function public.api_reserve(text, text, int, int) from public, anon, authenticated;
grant  execute on function public.api_reserve(text, text, int, int) to service_role;
