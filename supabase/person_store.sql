-- v96: permanent person store. Every director / actor / composer page that anybody opens is saved here (TMDB profile + filmography,
-- Wikidata filmography, Wikipedia bio) and served from the database. It is refreshed on a schedule, so new releases and corrections arrive by themselves.
-- Run this whole file once in Supabase -> SQL Editor. Safe to run again.
create table if not exists public.person_store (
  id          int primary key,            -- TMDB person id
  name        text,
  data        jsonb not null,             -- { tmdb: <TMDB /person answer with combined_credits>, wd: {credits, desc}, bio: {bio, url} }
  has_upcoming boolean not null default false, -- the person has a title not released yet: refreshed more often
  hits        int not null default 0,     -- how often the page was opened (most opened people are refreshed first)
  fetched_at  timestamptz not null default now(),
  last_hit    timestamptz not null default now()
);
create index if not exists person_store_fetched on public.person_store (fetched_at);
alter table public.person_store enable row level security;
revoke all on public.person_store from anon, authenticated;

-- Scheduled refresh (pg_cron + pg_net). Replace <PROJECT-REF> and <ANON-KEY>, then run this block once.
-- Every 6 hours the server refreshes up to 25 people whose saved data is old (people with an upcoming title: 1 day, others: 7 days).
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select cron.schedule('person-store-refresh', '0 */6 * * *', $$
--   select net.http_get(
--     url := 'https://<PROJECT-REF>.supabase.co/functions/v1/similar?personrefresh=1&id=1&token=<REFRESH_TOKEN>',
--     headers := jsonb_build_object('Authorization', 'Bearer <ANON-KEY>', 'apikey', '<ANON-KEY>'));
-- $$);
