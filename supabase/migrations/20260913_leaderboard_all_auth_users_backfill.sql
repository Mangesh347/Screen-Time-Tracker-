-- Backfill every Auth user into stt_profiles so they appear on the leaderboard
-- after a single signup/login (including accounts from weeks/months ago).
-- Run in Supabase → SQL Editor → Run

alter table public.stt_profiles
  add column if not exists is_public boolean default true,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists last_active_at timestamptz;

update public.stt_profiles
set is_public = true
where is_public is distinct from true;

insert into public.stt_profiles (
  id, email, name, picture, is_public, updated_at, last_active_at,
  usage_today_sec, usage_week_sec, usage_month_sec, usage_year_sec,
  total_browse_sec, total_focus_sec, public_score, streak_days
)
select
  u.id,
  u.email,
  coalesce(
    nullif(u.raw_user_meta_data->>'full_name', ''),
    nullif(u.raw_user_meta_data->>'name', ''),
    split_part(coalesce(u.email, 'member'), '@', 1)
  ) as name,
  nullif(u.raw_user_meta_data->>'avatar_url', '') as picture,
  true,
  now(),
  coalesce(u.last_sign_in_at, u.created_at, now()),
  0, 0, 0, 0,
  0, 0, 0, 0
from auth.users u
where not exists (select 1 from public.stt_profiles p where p.id = u.id)
on conflict (id) do nothing;

do $$
declare
  r record;
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'stt_refresh_profile_leaderboard'
  ) then
    for r in select id from public.stt_profiles loop
      perform public.stt_refresh_profile_leaderboard(r.id);
    end loop;
  end if;
end $$;

notify pgrst, 'reload schema';
