# Website changelog

## 1.2.14 — 2026-09-14
- **Post-payment redirect**: successful pay → `/success.html` only (never `chrome-extension://`, which Chrome blocks as ERR_BLOCKED_BY_CLIENT). Dashboard opens via extension messaging. Failed/cancel stays on checkout.

## 1.2.13 — 2026-09-14
- **Success page**: continuous moving wavy borders on card + **Back to dashboard** Material You button; tonal fact rows; secondary home CTA; richer M3 surfaces

## 1.2.12 — 2026-09-14
- **Success page UI**: richer Material You — brand header, dual wavy orbits + check badge, tonal plan/email/provider facts, clearer copy when `ext_id` is missing; dedicated `success.css`

## 1.2.11 — 2026-09-14
- **Success / Pro welcome page**: Material You redesign — tonal ambient blobs, brand mark inside moving wavy orbit rings, status chip, clearer CTAs; respects reduced-motion + dark/editorial/minimal. Redirect logic unchanged.

## 1.2.10 — 2026-09-14
- **Payment pipeline**: provider verify FIRST → Supabase Pro + `expires_at` deadline → redirect to extension dashboard; fail stays Free on checkout
- Deadlines: monthly +30d, yearly +365d, lifetime `null` (never expires)
- Hourly cron `/api/cron/expire-subscriptions` demotes expired Pro → Free (no errors)
- Shared `fulfillVerifiedPayment` — Pro only after entitlement write succeeds
- Razorpay verify no longer fails with “Checkout session not found”
- `/api/razorpay/claim-payment` recovery for already-captured payments
- Redeploy Vercel required

## 1.2.9 — 2026-09-14
- **Sandbox-first payments**: `paymentMode()` defaults to sandbox when `PAYMENT_TEST_MODE` unset; live only if `PAYMENT_TEST_MODE=false`
- Razorpay sandbox ignores `rzp_live_*` legacy `RAZORPAY_KEY_*` fallbacks (avoids accidental live keys)
- Added `PAYMENT_MODE.md` — exact Vercel TEST-now / LIVE-later vars
- Redeploy + set `PAYMENT_TEST_MODE=true`, `PAYPAL_MODE=sandbox`, `ALLOW_LIVE_PAYMENTS=false` + TEST secrets

## 1.2.8 — 2026-09-13
- Social API: reject `send_message` for non-Pro (`PRO_REQUIRED` / 403) via `resolveIsPro`
- `/api/stt/pro-check`: add `messaging`, `history30`, `history90`; remove `petDesktop`
- Marketing `index.html`: Free vs Pro — Messaging Pro; Today+7d Free / 30+90 Pro; community feed Free; no Pet
- Pair with extension **5.4.42** — redeploy Vercel

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
