-- v97: extra films from IMDb's free text files, matched to TMDB, kept per person (small JSON only).
-- Run once in Supabase -> SQL Editor. Safe to run again.
alter table public.person_store add column if not exists imdb    jsonb;        -- [{id, media_type, title, date, poster, votes, roles, src:"imdb"}]
alter table public.person_store add column if not exists imdb_at timestamptz;  -- null = not looked up yet
create index if not exists person_store_imdb_at on public.person_store (imdb_at nulls first);
