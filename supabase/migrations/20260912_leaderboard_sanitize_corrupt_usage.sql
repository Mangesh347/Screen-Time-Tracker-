-- Clamp corrupt leaderboard usage (ms-as-sec / runaway totals → fake 496977h rows)
-- Run in Supabase → SQL Editor → Run

update public.stt_profiles
set usage_today_sec = 0
where coalesce(usage_today_sec, 0) > (24 * 3600 * 1.25);

update public.stt_profiles
set usage_week_sec = 0
where coalesce(usage_week_sec, 0) > (7 * 24 * 3600 * 1.25);

update public.stt_profiles
set usage_month_sec = 0
where coalesce(usage_month_sec, 0) > (31 * 24 * 3600 * 1.25);

update public.stt_profiles
set usage_year_sec = 0
where coalesce(usage_year_sec, 0) > (366 * 24 * 3600 * 1.25);

update public.stt_profiles
set total_browse_sec = least(coalesce(total_browse_sec, 0), 7 * 24 * 3600)
where coalesce(total_browse_sec, 0) > (7 * 24 * 3600 * 1.25);

update public.stt_profiles
set total_focus_sec = least(coalesce(total_focus_sec, 0), 7 * 24 * 3600)
where coalesce(total_focus_sec, 0) > (7 * 24 * 3600 * 1.25);

update public.stt_profiles
set period_stats = '{}'::jsonb
where period_stats is not null
  and (
    coalesce((period_stats->'week'->>'browse')::numeric, 0) > (7 * 24 * 3600 * 1.25)
    or coalesce((period_stats->'today'->>'browse')::numeric, 0) > (24 * 3600 * 1.25)
    or coalesce((period_stats->'month'->>'browse')::numeric, 0) > (31 * 24 * 3600 * 1.25)
    or coalesce((period_stats->'year'->>'browse')::numeric, 0) > (366 * 24 * 3600 * 1.25)
  );

update public.stt_usage_days
set total_sec = least(total_sec, 24 * 3600),
    focus_sec = least(focus_sec, 24 * 3600),
    social_sec = least(coalesce(social_sec, 0), 24 * 3600)
where total_sec > 24 * 3600
   or focus_sec > 24 * 3600
   or coalesce(social_sec, 0) > 24 * 3600;

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
