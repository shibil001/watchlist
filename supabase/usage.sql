-- Usage stats (web, Mac, Windows, Android). Run this whole file once in Supabase -> SQL Editor. Safe to run again.
-- It stores only: a random device id, the platform, a 2-letter country code and first/last seen times.
-- No email, no titles, no IP address, no computer name.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.usage_devices (
  device_id  text primary key,
  platform   text not null,
  country    text,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
create index if not exists usage_devices_last_seen_idx on public.usage_devices (last_seen);

create table if not exists public.usage_admin (
  id        int primary key default 1 check (id = 1),
  username  text not null,
  pass_hash text not null,
  pin_hash  text not null
);

create table if not exists public.usage_admin_fails (
  id bigserial primary key,
  at timestamptz not null default now()
);

-- Nobody can read or write these tables directly. Only the functions below can.
alter table public.usage_devices     enable row level security;
alter table public.usage_admin       enable row level security;
alter table public.usage_admin_fails enable row level security;
revoke all on public.usage_devices, public.usage_admin, public.usage_admin_fails from anon, authenticated;

-- Called by every app about once a minute while it is open.
create or replace function public.ping_usage(p_device_id text, p_platform text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_country text;
  v_platform text;
begin
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9-]{16,64}$' then return; end if;
  v_platform := case when p_platform in ('Mac app','Windows app','Android app','Web (phone)','Web (computer)') then p_platform else 'Other' end;
  begin
    v_country := upper(coalesce(current_setting('request.headers', true)::json ->> 'cf-ipcountry', ''));
  exception when others then v_country := '';
  end;
  if v_country !~ '^[A-Z]{2}$' or v_country in ('XX','T1') then v_country := null; end if;

  insert into public.usage_devices (device_id, platform, country)
  values (p_device_id, v_platform, v_country)
  on conflict (device_id) do update
    set last_seen = now(),
        platform  = excluded.platform,
        country   = coalesce(excluded.country, public.usage_devices.country);
end $$;
revoke all on function public.ping_usage(text, text) from public;
grant execute on function public.ping_usage(text, text) to anon, authenticated;

-- Set (or change) the admin login. Run it yourself in the SQL Editor, see the bottom of this file.
create or replace function public.set_usage_admin(p_user text, p_password text, p_pin text)
returns void
language plpgsql security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_user,'')) < 3 then raise exception 'Username must be at least 3 characters'; end if;
  if length(coalesce(p_password,'')) < 12 then raise exception 'Password must be at least 12 characters'; end if;
  if p_pin !~ '^[0-9]{6}$' then raise exception 'PIN must be exactly 6 digits'; end if;
  insert into public.usage_admin (id, username, pass_hash, pin_hash)
  values (1, lower(trim(p_user)), crypt(p_password, gen_salt('bf', 10)), crypt(p_pin, gen_salt('bf', 10)))
  on conflict (id) do update
    set username = excluded.username, pass_hash = excluded.pass_hash, pin_hash = excluded.pin_hash;
  delete from public.usage_admin_fails;
end $$;
revoke all on function public.set_usage_admin(text, text, text) from public, anon, authenticated;

-- The dashboard calls this. It needs the right username + password + PIN, and locks for 15 minutes after 5 wrong tries.
create or replace function public.admin_stats(p_user text, p_password text, p_pin text)
returns json
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  a public.usage_admin%rowtype;
  ok boolean;
begin
  delete from public.usage_admin_fails where at < now() - interval '1 day';
  if (select count(*) from public.usage_admin_fails where at > now() - interval '15 minutes') >= 5 then
    raise exception 'Too many wrong tries. Wait 15 minutes.';
  end if;

  select * into a from public.usage_admin where id = 1;
  if not found then raise exception 'Admin login is not set up yet.'; end if;

  ok := lower(trim(coalesce(p_user,''))) = a.username
        and a.pass_hash = crypt(coalesce(p_password,''), a.pass_hash)
        and a.pin_hash  = crypt(coalesce(p_pin,''), a.pin_hash);
  if not ok then
    insert into public.usage_admin_fails default values;
    -- Return the error instead of raising it: a raised error rolls the insert back, so wrong tries were never counted.
    return json_build_object('error', 'Wrong username, password or PIN.');
  end if;

  return json_build_object(
    'generated_at', now(),
    'accounts', (select count(*) from auth.users),
    'total',    (select count(*) from public.usage_devices),
    'live',     (select count(*) from public.usage_devices where last_seen > now() - interval '3 minutes'),
    'day',      (select count(*) from public.usage_devices where last_seen > now() - interval '1 day'),
    'week',     (select count(*) from public.usage_devices where last_seen > now() - interval '7 days'),
    'month',    (select count(*) from public.usage_devices where last_seen > now() - interval '30 days'),
    'new_today',(select count(*) from public.usage_devices where first_seen > now() - interval '1 day'),
    'platforms',(select coalesce(json_agg(t order by t.total desc), '[]'::json) from (
                   select platform, count(*) as total,
                          count(*) filter (where last_seen > now() - interval '3 minutes') as live
                   from public.usage_devices group by platform) t),
    'countries',(select coalesce(json_agg(t order by t.total desc), '[]'::json) from (
                   select coalesce(country, '??') as country, count(*) as total,
                          count(*) filter (where last_seen > now() - interval '3 minutes') as live
                   from public.usage_devices group by 1 order by 2 desc limit 20) t),
    'daily_new',(select coalesce(json_agg(t order by t.day), '[]'::json) from (
                   select (first_seen at time zone 'UTC')::date as day, count(*) as total
                   from public.usage_devices
                   where first_seen > now() - interval '14 days' group by 1) t)
  );
end $$;
revoke all on function public.admin_stats(text, text, text) from public;
grant execute on function public.admin_stats(text, text, text) to anon, authenticated;

-- ===== AFTER running the file above, run THIS ONE LINE separately with your own values (do not save the query): =====
-- select public.set_usage_admin('your-username', 'a-long-password-12+chars', '123456');
