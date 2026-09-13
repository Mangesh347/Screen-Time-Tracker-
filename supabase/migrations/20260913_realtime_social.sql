-- Screen Time Tracker — social count triggers + Realtime publication
-- Run in Supabase SQL Editor AFTER relying on live dashboard sync.
-- Safe / additive. Also: Dashboard → Replication → enable tables if UI requires.
--
-- WHY: profile RLS only allows updating your own row. Client REST fallbacks
-- cannot bump another user's followers_count — counts stay 0 without triggers
-- or the service-role API. Triggers keep counts correct for every path.

-- ─── Ensure count columns exist ─────────────────────────────────────────────
alter table public.stt_profiles
  add column if not exists followers_count int default 0,
  add column if not exists following_count int default 0,
  add column if not exists posts_count int default 0;

alter table public.stt_posts
  add column if not exists likes_count int default 0,
  add column if not exists comments_count int default 0,
  add column if not exists views_count int default 0;

-- ─── Follow counts (SECURITY DEFINER bypasses RLS) ──────────────────────────
create or replace function public.stt_recount_follow_counts(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then return; end if;
  update public.stt_profiles
  set
    followers_count = (
      select count(*)::int from public.stt_friendships
      where friend_id = p_user_id and status = 'accepted'
    ),
    following_count = (
      select count(*)::int from public.stt_friendships
      where user_id = p_user_id and status = 'accepted'
    ),
    updated_at = now()
  where id = p_user_id;
end;
$$;

create or replace function public.stt_trg_friendships_counts()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  b uuid;
begin
  if tg_op = 'DELETE' then
    a := old.user_id;
    b := old.friend_id;
  elsif tg_op = 'UPDATE' then
    a := new.user_id;
    b := new.friend_id;
    -- also recount old endpoints if ids somehow changed (shouldn't)
    if old.user_id is distinct from new.user_id then
      perform public.stt_recount_follow_counts(old.user_id);
    end if;
    if old.friend_id is distinct from new.friend_id then
      perform public.stt_recount_follow_counts(old.friend_id);
    end if;
  else
    a := new.user_id;
    b := new.friend_id;
  end if;
  perform public.stt_recount_follow_counts(a);
  perform public.stt_recount_follow_counts(b);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists stt_friendships_counts_aiud on public.stt_friendships;
create trigger stt_friendships_counts_aiud
  after insert or update of status or delete on public.stt_friendships
  for each row execute function public.stt_trg_friendships_counts();

-- ─── Posts count on profile ─────────────────────────────────────────────────
create or replace function public.stt_recount_posts_count(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then return; end if;
  update public.stt_profiles
  set
    posts_count = (
      select count(*)::int from public.stt_posts where user_id = p_user_id
    ),
    updated_at = now()
  where id = p_user_id;
end;
$$;

create or replace function public.stt_trg_posts_profile_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.stt_recount_posts_count(old.user_id);
    return old;
  end if;
  perform public.stt_recount_posts_count(new.user_id);
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    perform public.stt_recount_posts_count(old.user_id);
  end if;
  return new;
end;
$$;

drop trigger if exists stt_posts_profile_count_aid on public.stt_posts;
create trigger stt_posts_profile_count_aid
  after insert or delete on public.stt_posts
  for each row execute function public.stt_trg_posts_profile_count();

-- ─── Like / comment / view counters on posts ────────────────────────────────
create or replace function public.stt_trg_likes_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.stt_posts
      set likes_count = coalesce(likes_count, 0) + 1, updated_at = now()
      where id = new.post_id;
    return new;
  end if;
  update public.stt_posts
    set likes_count = greatest(0, coalesce(likes_count, 0) - 1), updated_at = now()
    where id = old.post_id;
  return old;
end;
$$;

drop trigger if exists stt_likes_count_aid on public.stt_post_likes;
create trigger stt_likes_count_aid
  after insert or delete on public.stt_post_likes
  for each row execute function public.stt_trg_likes_count();

create or replace function public.stt_trg_comments_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.stt_posts
      set comments_count = coalesce(comments_count, 0) + 1, updated_at = now()
      where id = new.post_id;
    return new;
  end if;
  update public.stt_posts
    set comments_count = greatest(0, coalesce(comments_count, 0) - 1), updated_at = now()
    where id = old.post_id;
  return old;
end;
$$;

drop trigger if exists stt_comments_count_aid on public.stt_post_comments;
create trigger stt_comments_count_aid
  after insert or delete on public.stt_post_comments
  for each row execute function public.stt_trg_comments_count();

-- Views: only if stt_post_views exists (schema-post-views.sql)
do $$
begin
  if to_regclass('public.stt_post_views') is null then
    raise notice 'stt_post_views missing — skip views trigger (run schema-post-views.sql)';
    return;
  end if;

  execute $fn$
    create or replace function public.stt_trg_views_count()
    returns trigger
    language plpgsql
    security definer
    set search_path = public
    as $f$
    begin
      if tg_op = 'INSERT' then
        update public.stt_posts
          set views_count = coalesce(views_count, 0) + 1, updated_at = now()
          where id = new.post_id;
        return new;
      end if;
      update public.stt_posts
        set views_count = greatest(0, coalesce(views_count, 0) - 1), updated_at = now()
        where id = old.post_id;
      return old;
    end;
    $f$;
  $fn$;

  execute 'drop trigger if exists stt_views_count_aid on public.stt_post_views';
  execute $trg$
    create trigger stt_views_count_aid
      after insert or delete on public.stt_post_views
      for each row execute function public.stt_trg_views_count()
  $trg$;
end;
$$;

-- ─── One-shot backfill (fixes existing 0-stats) ─────────────────────────────
update public.stt_profiles p
set
  followers_count = coalesce((
    select count(*)::int from public.stt_friendships f
    where f.friend_id = p.id and f.status = 'accepted'
  ), 0),
  following_count = coalesce((
    select count(*)::int from public.stt_friendships f
    where f.user_id = p.id and f.status = 'accepted'
  ), 0),
  posts_count = coalesce((
    select count(*)::int from public.stt_posts x where x.user_id = p.id
  ), 0),
  updated_at = now()
where true;

update public.stt_posts p
set
  likes_count = coalesce((
    select count(*)::int from public.stt_post_likes l where l.post_id = p.id
  ), 0),
  comments_count = coalesce((
    select count(*)::int from public.stt_post_comments c where c.post_id = p.id
  ), 0)
where true;

do $$
begin
  if to_regclass('public.stt_post_views') is not null then
    update public.stt_posts p
    set views_count = coalesce((
      select count(*)::int from public.stt_post_views v where v.post_id = p.id
    ), 0)
    where true;
  end if;
end;
$$;

-- ─── Realtime publication (postgres_changes) ────────────────────────────────
-- Extension uses soft-poll + these events when Realtime is enabled.
do $$
begin
  -- Tables may already be in publication — ignore duplicate errors
  begin
    alter publication supabase_realtime add table public.stt_posts;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.stt_friendships;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.stt_post_likes;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.stt_post_comments;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.stt_messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.stt_profiles;
  exception when duplicate_object then null;
  end;
  if to_regclass('public.stt_post_views') is not null then
    begin
      alter publication supabase_realtime add table public.stt_post_views;
    exception when duplicate_object then null;
    end;
  end if;
end;
$$;

-- Replica identity FULL helps Realtime send old+new row payloads
alter table public.stt_posts replica identity full;
alter table public.stt_friendships replica identity full;
alter table public.stt_profiles replica identity full;
alter table public.stt_messages replica identity full;

notify pgrst, 'reload schema';
