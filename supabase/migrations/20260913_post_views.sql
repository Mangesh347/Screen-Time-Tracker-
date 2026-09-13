-- Additive: unique thought views (Instagram-like — one count per viewer)
-- Safe to re-run. Mirror of supabase/migrations/20260913_post_views.sql

alter table public.stt_posts
  add column if not exists views_count int default 0;

create table if not exists public.stt_post_views (
  post_id bigint not null references public.stt_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (post_id, user_id)
);

create index if not exists stt_post_views_user_idx on public.stt_post_views (user_id);
create index if not exists stt_post_views_post_idx on public.stt_post_views (post_id);

alter table public.stt_post_views enable row level security;

drop policy if exists "stt_views_read" on public.stt_post_views;
create policy "stt_views_read" on public.stt_post_views for select using (true);

drop policy if exists "stt_views_write" on public.stt_post_views;
create policy "stt_views_write" on public.stt_post_views
  for insert with check (auth.uid() = user_id);

update public.stt_posts p
set views_count = coalesce((
  select count(*)::int from public.stt_post_views v where v.post_id = p.id
), 0)
where true;

notify pgrst, 'reload schema';
