-- =============================================================================
-- Screen Time Tracker — Global leaderboard: real stats for ALL members
-- Run in Supabase → SQL Editor → Run (entire file). Additive / safe.
--
-- Fixes:
--   • Ensure period usage + streak columns exist on stt_profiles
--   • Authenticated members can SELECT everyone's public leaderboard fields
--   • Users can UPDATE only their own row
--   • Backfill usage_* / period_stats from stt_usage_days when profile stats are empty
--   • Helper RPC to refresh one user's board stats from daily rows
-- =============================================================================

-- 1) Columns
alter table public.stt_profiles
  add column if not exists handle text,
  add column if not exists bio text default '',
  add column if not exists is_public boolean default true,
  add column if not exists is_private boolean default false,
  add column if not exists region text,
  add column if not exists total_focus_sec bigint default 0,
  add column if not exists total_browse_sec bigint default 0,
  add column if not exists public_score int default 0,
  add column if not exists public_top_sites jsonb default '[]'::jsonb,
  add column if not exists streak_days int default 0,
  add column if not exists streak_best int default 0,
  add column if not exists streaks jsonb default '{}'::jsonb,
  add column if not exists usage_today_sec bigint default 0,
  add column if not exists usage_week_sec bigint default 0,
  add column if not exists usage_month_sec bigint default 0,
  add column if not exists usage_year_sec bigint default 0,
  add column if not exists period_stats jsonb default '{}'::jsonb,
  add column if not exists last_active_at timestamptz,
  add column if not exists updated_at timestamptz default now();

create index if not exists stt_profiles_usage_today_idx
  on public.stt_profiles (usage_today_sec desc nulls last);
create index if not exists stt_profiles_usage_week_idx
  on public.stt_profiles (usage_week_sec desc nulls last);
create index if not exists stt_profiles_usage_month_idx
  on public.stt_profiles (usage_month_sec desc nulls last);
create index if not exists stt_profiles_usage_year_idx
  on public.stt_profiles (usage_year_sec desc nulls last);
create index if not exists stt_profiles_streak_idx
  on public.stt_profiles (streak_days desc nulls last);
create index if not exists stt_profiles_region_idx
  on public.stt_profiles (region);

update public.stt_profiles set is_public = true where is_public is distinct from true;

-- 2) Daily usage table (source of truth for rebuild)
create table if not exists public.stt_usage_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  total_sec int not null default 0,
  focus_sec int not null default 0,
  social_sec int not null default 0,
  score int default 0,
  top_sites jsonb default '[]'::jsonb,
  updated_at timestamptz default now(),
  primary key (user_id, day)
);
create index if not exists stt_usage_days_day_idx on public.stt_usage_days (day);
create index if not exists stt_usage_days_user_day_idx on public.stt_usage_days (user_id, day desc);

-- 3) RLS — profiles: all authenticated can READ; own WRITE only
alter table public.stt_profiles enable row level security;

drop policy if exists "stt_profiles_own" on public.stt_profiles;
drop policy if exists "stt_profiles_public_read" on public.stt_profiles;
drop policy if exists "stt_profiles_select_members" on public.stt_profiles;
drop policy if exists "stt_profiles_insert_own" on public.stt_profiles;
drop policy if exists "stt_profiles_update_own" on public.stt_profiles;
drop policy if exists "stt_profiles_delete_own" on public.stt_profiles;

create policy "stt_profiles_select_members" on public.stt_profiles
  for select to authenticated using (true);

create policy "stt_profiles_insert_own" on public.stt_profiles
  for insert to authenticated with check (auth.uid() = id);

create policy "stt_profiles_update_own" on public.stt_profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create policy "stt_profiles_delete_own" on public.stt_profiles
  for delete to authenticated using (auth.uid() = id);

-- 4) RLS — usage days (own read/write; board uses profile columns + service role)
alter table public.stt_usage_days enable row level security;
drop policy if exists "stt_usage_own" on public.stt_usage_days;
drop policy if exists "stt_usage_select_own" on public.stt_usage_days;
drop policy if exists "stt_usage_write_own" on public.stt_usage_days;

create policy "stt_usage_select_own" on public.stt_usage_days
  for select to authenticated using (auth.uid() = user_id);

create policy "stt_usage_write_own" on public.stt_usage_days
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 5) Refresh one user's leaderboard aggregates from stt_usage_days
create or replace function public.stt_refresh_profile_leaderboard(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('utc', now()))::date;
  v_today_sec bigint;
  v_week_sec bigint;
  v_month_sec bigint;
  v_year_sec bigint;
  v_week_focus bigint;
  v_score int;
  v_sites jsonb;
begin
  select coalesce(sum(total_sec), 0) into v_today_sec
  from public.stt_usage_days where user_id = p_user_id and day = v_today;

  select coalesce(sum(total_sec), 0), coalesce(sum(focus_sec), 0)
    into v_week_sec, v_week_focus
  from public.stt_usage_days
  where user_id = p_user_id and day >= (v_today - 6);

  select coalesce(sum(total_sec), 0) into v_month_sec
  from public.stt_usage_days
  where user_id = p_user_id and day >= (v_today - 29);

  select coalesce(sum(total_sec), 0) into v_year_sec
  from public.stt_usage_days
  where user_id = p_user_id and day >= (v_today - 364);

  select coalesce(score, 0), coalesce(top_sites, '[]'::jsonb)
    into v_score, v_sites
  from public.stt_usage_days
  where user_id = p_user_id and day = v_today
  limit 1;

  if v_score is null then v_score := 0; end if;
  if v_sites is null then v_sites := '[]'::jsonb; end if;

  insert into public.stt_profiles as p (
    id,
    usage_today_sec, usage_week_sec, usage_month_sec, usage_year_sec,
    total_browse_sec, total_focus_sec, public_score, public_top_sites,
    period_stats, is_public, updated_at, last_active_at
  ) values (
    p_user_id,
    v_today_sec, v_week_sec, v_month_sec, v_year_sec,
    v_week_sec, v_week_focus, v_score, v_sites,
    jsonb_build_object(
      'today', jsonb_build_object('browse', v_today_sec, 'focus', 0, 'score', v_score, 'streak', 0, 'sites', v_sites),
      'week', jsonb_build_object('browse', v_week_sec, 'focus', v_week_focus, 'score', v_score, 'streak', 0, 'sites', v_sites),
      'month', jsonb_build_object('browse', v_month_sec, 'focus', 0, 'score', v_score, 'streak', 0, 'sites', '[]'::jsonb),
      'year', jsonb_build_object('browse', v_year_sec, 'focus', 0, 'score', v_score, 'streak', 0, 'sites', '[]'::jsonb)
    ),
    true,
    now(),
    now()
  )
  on conflict (id) do update set
    usage_today_sec = excluded.usage_today_sec,
    usage_week_sec = excluded.usage_week_sec,
    usage_month_sec = excluded.usage_month_sec,
    usage_year_sec = excluded.usage_year_sec,
    total_browse_sec = greatest(coalesce(p.total_browse_sec, 0), excluded.total_browse_sec),
    total_focus_sec = greatest(coalesce(p.total_focus_sec, 0), excluded.total_focus_sec),
    public_score = case when excluded.public_score > 0 then excluded.public_score else p.public_score end,
    public_top_sites = case
      when jsonb_array_length(excluded.public_top_sites) > 0 then excluded.public_top_sites
      else p.public_top_sites
    end,
    period_stats = excluded.period_stats,
    is_public = true,
    updated_at = now(),
    last_active_at = now();
end;
$$;

revoke all on function public.stt_refresh_profile_leaderboard(uuid) from public;
grant execute on function public.stt_refresh_profile_leaderboard(uuid) to authenticated;
grant execute on function public.stt_refresh_profile_leaderboard(uuid) to service_role;

-- 6) Backfill: refresh every user who has usage days but empty week stats
do $$
declare
  r record;
begin
  for r in
    select distinct d.user_id
    from public.stt_usage_days d
    left join public.stt_profiles p on p.id = d.user_id
    where coalesce(p.usage_week_sec, 0) = 0
      and coalesce(p.total_browse_sec, 0) = 0
  loop
    perform public.stt_refresh_profile_leaderboard(r.user_id);
  end loop;
end $$;

-- 7) Reload PostgREST schema cache
notify pgrst, 'reload schema';
