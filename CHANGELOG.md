# Website changelog

## 1.2.7 — 2026-09-13
- **Vercel Hobby fix**: consolidate 16 serverless functions → **6** (Hobby max 12)
- Catch-all routers: `/api/stt/[...path]`, `/api/paypal/[...path]`, `/api/razorpay/[...path]`, `/api/webhooks/[...path]`
- Handlers moved to `api/_lib/handlers/` (not counted as functions); public URLs unchanged
- Kept: `/api/config`, `/api/cron/expire-subscriptions`

## 1.2.6 — 2026-09-13
- Payment audit: `/api/config` exposes `ready` + `key_mode_mismatch` (no secrets) so checkout banner flags incomplete keys / test-vs-live key mismatch
- Checkout banner warns when PayPal/Razorpay secrets missing for active mode
- Pair with extension `ext_id` on checkout URLs + Edge `PAYMENT_TEST_MODE` alignment for post-pay Pro deep-link / sandbox routing
- Redeploy Vercel; set `PAYMENT_TEST_MODE=true` + `PAYPAL_TEST_*` / `RAZORPAY_TEST_*` for sandbox

## 1.2.5 — 2026-09-13
- `/api/stt/migrate-guest` — claim guest score into signed-in account (no LB duplicates)
- `/api/stt/delete-account` — auth-gated product data wipe + profile anonymize
- `/api/stt/pro-check` + `api/_lib/gates.js` (`requireAuth` / `requirePro`)
- Pair with extension **5.4.38** — redeploy Vercel

## 1.2.4 — 2026-09-13
- Security headers in `vercel.json` (CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, nosniff)
- Rate limits: `/api/stt/social` (120/min), `/api/stt/guest-score` (30/min)
- Guest-score: strip DB error detail from client responses
- Privacy + Terms: Community data (posts, follows, messages), Ghost Mode, honest DevTools note
- Pair with extension **5.4.37** — redeploy Vercel

## 1.2.3 — 2026-09-13
- Profile GET: `reconcileProfileCounts` — live recount followers/following/posts from friendships + posts (fixes stale 0-stats)
- Pair with extension **5.4.36** + `supabase/schema-realtime-social.sql` (triggers + Realtime publication)
- Package **1.2.3** — redeploy Vercel after SQL

## 1.2.2 — 2026-09-13
- Social API: `view_post` unique thought views; feed/profile payloads include `views_count`
- Requires Supabase `schema-post-views.sql` (or `migrations/20260913_post_views.sql`)

## 1.2.1 — 2026-09-13
- Follow API: treat missing/`null` `is_private` as private (pending request)
- `accept_follow` / `reject_follow`: scope to pending rows; Confirm returns error if request missing
- Package **1.2.1** — redeploy Vercel for production

## 1.2.0 — 2026-09-13
- **Social API** `GET/POST /api/stt/social` — follow graph, thoughts, likes, comments, DMs, feed, profile views (JWT + service role)
- Shared helpers in `api/_lib/social.js` (Instagram-like message gate, count refresh, user-facing errors)
- `sync-profile` no longer forces public; new profile inserts default private
- Requires Supabase migration `../supabase/schema-social-network.sql` + `SUPABASE_SERVICE_ROLE_KEY`

## 1.1.0 — 2026-09-13
- Aligned site chrome with extension visual themes: **Material You** (default), **Editorial**, **Minimal**
- Added `theme-tokens.css` + `site-theme.js` (persisted light/dark + visual skin)
- Restyled marketing, legal, success, and checkout surfaces to shared M3 tokens
