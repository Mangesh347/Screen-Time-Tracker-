-- ============================================================
-- Screen Time Tracker — REQUIRED payment / Pro tables
-- Run once in Supabase → SQL Editor → New query → Run
-- Project must match Vercel SUPABASE_URL
-- ============================================================

create table if not exists public.stt_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  name text,
  picture text,
  handle text,
  bio text default '',
  is_public boolean default true,
  is_private boolean default false,
  region text default 'global',
  guest_claimed_from text,
  total_focus_sec bigint default 0,
  total_browse_sec bigint default 0,
  last_active_at timestamptz,
  plan text default 'free',
  plan_expires_at timestamptz,
  plan_provider text,
  plan_updated_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.stt_entitlements (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  plan text not null default 'free',
  cycle text,
  provider text,
  status text default 'active',
  expires_at timestamptz,
  starts_at timestamptz,
  external_id text,
  payment_id text,
  order_id text,
  subscription_id text,
  duration_days int,
  duration_label text,
  amount numeric,
  currency text,
  webhook_verified boolean default false,
  webhook_verified_at timestamptz,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists stt_entitlements_email_uidx
  on public.stt_entitlements (email);

create unique index if not exists stt_entitlements_user_uidx
  on public.stt_entitlements (user_id)
  where user_id is not null;

create table if not exists public.stt_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  provider text not null,
  cycle text not null,
  currency text not null,
  amount numeric not null,
  status text not null default 'created',
  order_id text,
  payment_id text,
  expires_at timestamptz,
  duration_days int,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stt_checkout_sessions_user_idx
  on public.stt_checkout_sessions (user_id, created_at desc);

create index if not exists stt_checkout_sessions_order_idx
  on public.stt_checkout_sessions (order_id)
  where order_id is not null;

create table if not exists public.stt_payment_events (
  id bigserial primary key,
  provider text not null,
  event_id text not null,
  event_type text,
  payment_id text,
  order_id text,
  user_id uuid,
  email text,
  cycle text,
  status text default 'processing',
  verified boolean default false,
  error text,
  payload jsonb default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz default now(),
  unique (provider, event_id)
);

create table if not exists public.stt_checkout_events (
  id bigserial primary key,
  email text,
  provider text,
  cycle text,
  amount numeric,
  currency text,
  payload jsonb,
  created_at timestamptz default now()
);

alter table public.stt_profiles enable row level security;
alter table public.stt_entitlements enable row level security;
alter table public.stt_checkout_sessions enable row level security;
alter table public.stt_payment_events enable row level security;

drop policy if exists "stt_profiles_own" on public.stt_profiles;
create policy "stt_profiles_own" on public.stt_profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "stt_entitlements_read_own" on public.stt_entitlements;
create policy "stt_entitlements_read_own" on public.stt_entitlements
  for select using (auth.uid() = user_id or email = auth.jwt()->>'email');

drop policy if exists "stt_checkout_sessions_read_own" on public.stt_checkout_sessions;
create policy "stt_checkout_sessions_read_own" on public.stt_checkout_sessions
  for select using (auth.uid() = user_id);

drop policy if exists "stt_payment_events_read_own" on public.stt_payment_events;
create policy "stt_payment_events_read_own" on public.stt_payment_events
  for select using (auth.uid() = user_id);

-- Notify PostgREST to reload schema
notify pgrst, 'reload schema';

-- ============================================================
-- Recover Pro for the billing email that paid (yearly, +365 days)
-- ============================================================
do $$
declare
  uid uuid;
  exp timestamptz := now() + interval '365 days';
begin
  select id into uid from auth.users where lower(email) = 'mangesh.lokade.dev@gmail.com' limit 1;
  if uid is null then
    raise notice 'No auth.users row for mangesh.lokade.dev@gmail.com — sign in once from the extension, then re-run the recover block.';
    return;
  end if;

  insert into public.stt_profiles (id, email, plan, plan_expires_at, plan_provider, plan_updated_at, updated_at)
  values (uid, 'mangesh.lokade.dev@gmail.com', 'yearly', exp, 'razorpay', now(), now())
  on conflict (id) do update set
    email = excluded.email,
    plan = 'yearly',
    plan_expires_at = exp,
    plan_provider = 'razorpay',
    plan_updated_at = now(),
    updated_at = now();

  insert into public.stt_entitlements (
    user_id, email, plan, cycle, provider, status, expires_at, starts_at,
    duration_days, duration_label, webhook_verified, webhook_verified_at, metadata, updated_at
  ) values (
    uid, 'mangesh.lokade.dev@gmail.com', 'yearly', 'yearly', 'razorpay', 'active', exp, now(),
    365, '365 days', true, now(),
    '{"via":"manual_recover_after_missing_tables","note":"Recovered after 4 paid Razorpay attempts"}'::jsonb,
    now()
  )
  on conflict (email) do update set
    user_id = excluded.user_id,
    plan = 'yearly',
    cycle = 'yearly',
    provider = 'razorpay',
    status = 'active',
    expires_at = exp,
    starts_at = now(),
    duration_days = 365,
    duration_label = '365 days',
    webhook_verified = true,
    webhook_verified_at = now(),
    metadata = excluded.metadata,
    updated_at = now();
end $$;
