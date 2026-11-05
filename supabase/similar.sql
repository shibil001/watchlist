-- "Similar taste" (Watched tab, sparkle button). Run this whole file once in Supabase -> SQL Editor. Safe to run again.
-- Nobody can read or write these tables directly: only the "similar" Edge Function (service role) can.

-- finished suggestion lists, one per title (rebuilt after 14 days)
create table if not exists public.similar_cache (
  seed_key  text primary key,            -- v1:movie:603
  list      jsonb not null,
  built_at  timestamptz not null default now()
);

-- the learned scoring weights (one row). Starts empty: the function then uses its built-in defaults.
create table if not exists public.similar_weights (
  id         int primary key default 1 check (id = 1),
  w          jsonb not null default '{}'::jsonb,
  n          int not null default 0,      -- how many "Add selected" actions it has learned from
  updated_at timestamptz not null default now()
);

-- IMDb / Rotten Tomatoes / Metacritic scores fetched through the OMDb API (kept 30 days)
create table if not exists public.title_ratings (
  imdb_id    text primary key,
  imdb       numeric,
  votes      int,
  rt         int,
  meta       int,
  fetched_at timestamptz not null default now()
);

-- "miss" = OMDb does not know this title: remembered so it is not asked about again for 14 days
alter table public.title_ratings add column if not exists miss boolean not null default false;

-- OMDb calls made per UTC day, shared by every list (the free plan allows 1000 a day)
create table if not exists public.omdb_usage (
  day     date primary key,
  calls   int not null default 0,
  blocked boolean not null default false   -- set when OMDb itself says "limit reached": no more calls until the next day
);

-- Asks for p_n calls; returns how many may be made (0 when the day's cap or a "limit reached" was hit). Counted atomically.
create or replace function public.omdb_reserve(p_n int, p_cap int)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  d date := (now() at time zone 'utc')::date;
  v_calls int; v_blocked boolean; v_grant int;
begin
  insert into public.omdb_usage(day) values (d) on conflict (day) do nothing;
  select calls, blocked into v_calls, v_blocked from public.omdb_usage where day = d for update;
  if v_blocked then return 0; end if;
  v_grant := greatest(0, least(p_n, p_cap - v_calls));
  update public.omdb_usage set calls = calls + v_grant where day = d;
  delete from public.omdb_usage where day < d - 30;
  return v_grant;
end $$;

create or replace function public.omdb_block()
returns void
language sql security definer
set search_path = public
as $$
  insert into public.omdb_usage(day, blocked) values ((now() at time zone 'utc')::date, true)
  on conflict (day) do update set blocked = true;
$$;

revoke execute on function public.omdb_reserve(int, int), public.omdb_block() from public, anon, authenticated;
grant  execute on function public.omdb_reserve(int, int), public.omdb_block() to service_role;

alter table public.omdb_usage      enable row level security;
revoke all on public.omdb_usage from anon, authenticated;
alter table public.similar_cache   enable row level security;
alter table public.similar_weights enable row level security;
alter table public.title_ratings   enable row level security;
revoke all on public.similar_cache, public.similar_weights, public.title_ratings from anon, authenticated;


-- ===== v6: rough inputs, per-language weights, weekly lists =====
-- The rough answers (TMDB details and lists, Wikipedia + reviews, Wikidata tags, Trakt) are kept here, so the same
-- title is never asked about twice. k = what + which title, v = the answer, t = when it was saved (old rows are removed by the function).
create table if not exists public.similar_raw (
  k text primary key,
  v jsonb not null,
  t timestamptz not null default now()
);
create index if not exists similar_raw_t on public.similar_raw (t);
alter table public.similar_raw enable row level security;
revoke all on public.similar_raw from anon, authenticated;

-- Learned weights, one row per language group (south, north, eastasia, europe, middleeast, sea, slavic, en, other).
create table if not exists public.similar_weights_g (
  grp text primary key,
  w jsonb not null default '{}'::jsonb,
  n int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.similar_weights_g enable row level security;
revoke all on public.similar_weights_g from anon, authenticated;

-- Lists saved by older versions are rebuilt under v15; this clears them.
delete from public.similar_cache where seed_key ~ '^v[1-6]:';


-- ===== v13: what people actually pick =====
-- Every "Add selected" in the Similar panel is counted per (original title, suggested title): how often it was on screen and how often it was ticked.
-- Only keys (movie:603) are stored, nothing about a person. The function reads these counts as the "crowd" signal.
create table if not exists public.similar_votes (
  seed_key text not null,
  cand_key text not null,
  yes      int  not null default 0,
  shown    int  not null default 0,
  primary key (seed_key, cand_key)
);
alter table public.similar_votes enable row level security;
revoke all on public.similar_votes from anon, authenticated;

create or replace function public.similar_vote(p_seed text, p_picked text[], p_shown text[])
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.similar_votes(seed_key, cand_key, yes, shown)
    select p_seed, k, 0, 1 from unnest(p_shown) as k
    on conflict (seed_key, cand_key) do update set shown = public.similar_votes.shown + 1;
  update public.similar_votes set yes = yes + 1 where seed_key = p_seed and cand_key = any(p_picked);
end $$;
revoke execute on function public.similar_vote(text, text[], text[]) from public, anon, authenticated;
grant  execute on function public.similar_vote(text, text[], text[]) to service_role;
