-- =============================================================================
-- Screen Time Tracker — Leaderboard: all signed-up users + country/region
-- Run in Supabase → SQL Editor → Run (entire file). Additive / safe.
--
-- Goals:
--   • Keep region (and optional country alias) on stt_profiles for regional boards
--   • Ensure every auth.users row can have a public profile shell (honest zeros OK)
--   • Backfill missing profiles for already-signed-up users so they appear on board
-- =============================================================================

-- 1) Region + country (country mirrors region for clarity / future ISO codes)
alter table public.stt_profiles
  add column if not exists region text,
  add column if not exists country text,
  add column if not exists is_public boolean default true,
  add column if not exists usage_today_sec bigint default 0,
  add column if not exists usage_week_sec bigint default 0,
  add column if not exists usage_month_sec bigint default 0,
  add column if not exists usage_year_sec bigint default 0,
  add column if not exists total_browse_sec bigint default 0,
  add column if not exists total_focus_sec bigint default 0,
  add column if not exists public_score int default 0,
  add column if not exists streak_days int default 0,
  add column if not exists last_active_at timestamptz,
  add column if not exists updated_at timestamptz default now();

create index if not exists stt_profiles_region_idx
  on public.stt_profiles (region);
create index if not exists stt_profiles_country_idx
  on public.stt_profiles (country);

-- Keep country in sync with region when country is empty
update public.stt_profiles
set country = region
where country is null and region is not null and region <> '' and region <> 'global';

update public.stt_profiles
set region = country
where (region is null or region = '' or region = 'global')
  and country is not null and country <> '' and country <> 'global';

update public.stt_profiles set is_public = true where is_public is distinct from true;

-- 2) RLS — authenticated can read all profiles for the board; write own only
alter table public.stt_profiles enable row level security;

drop policy if exists "stt_profiles_select_members" on public.stt_profiles;
drop policy if exists "stt_profiles_insert_own" on public.stt_profiles;
drop policy if exists "stt_profiles_update_own" on public.stt_profiles;

create policy "stt_profiles_select_members" on public.stt_profiles
  for select to authenticated using (true);

create policy "stt_profiles_insert_own" on public.stt_profiles
  for insert to authenticated with check (auth.uid() = id);

create policy "stt_profiles_update_own" on public.stt_profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- 3) Backfill profile shells for Auth users missing a row (honest zeros)
insert into public.stt_profiles (
  id, email, name, picture, is_public,
  usage_today_sec, usage_week_sec, usage_month_sec, usage_year_sec,
  total_browse_sec, total_focus_sec, public_score, streak_days,
  region, country, updated_at, last_active_at
)
select
  u.id,
  u.email,
  coalesce(
    u.raw_user_meta_data->>'full_name',
    u.raw_user_meta_data->>'name',
    split_part(coalesce(u.email, 'member'), '@', 1)
  ),
  u.raw_user_meta_data->>'avatar_url',
  true,
  0, 0, 0, 0,
  0, 0, 0, 0,
  nullif(u.raw_user_meta_data->>'region', ''),
  coalesce(
    nullif(u.raw_user_meta_data->>'country', ''),
    nullif(u.raw_user_meta_data->>'region', '')
  ),
  now(),
  coalesce(u.last_sign_in_at, u.created_at, now())
from auth.users u
left join public.stt_profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;

-- 4) Reload PostgREST schema cache
notify pgrst, 'reload schema';
