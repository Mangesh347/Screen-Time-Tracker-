# Deploy Screen Time Tracker website (Vercel)

Your Supabase: `https://mproxhlssrniwlcywfhq.supabase.co`  
Live site (example): `https://screen-time-tracker-seven.vercel.app`  
Repo: push this `website/` folder to GitHub → Vercel auto-redeploys.

## Leaderboard not listing members?

If the board shows only you, check:

`https://screen-time-tracker-seven.vercel.app/api/stt/leaderboard?limit=5`

| Response | Meaning |
|----------|---------|
| **404** | API not deployed — redeploy this `website/` folder |
| `{"error":"SUPABASE_SERVICE_ROLE_KEY missing..."}` | Add exact name `SUPABASE_SERVICE_ROLE_KEY` → Redeploy |
| `{"users":[...],"source":"supabase-service-role"}` | Working |

## 1) Supabase SQL (required)

SQL Editor → run in order:

1. `../supabase/schema.sql` (if not applied)
2. `../supabase/schema-v5.sql`
3. Fix-ups: `../supabase/fix-profiles.sql` / `../supabase/fix-stt-posts.sql` if needed
4. **Social network**: `../supabase/schema-social-network.sql` (private profiles, follows, posts, likes, comments, DMs)
5. **Thought views**: `../supabase/schema-post-views.sql` (if posts predate views)
6. **Live counts + Realtime**: `../supabase/schema-realtime-social.sql` (triggers, backfill, realtime publication — fixes 0-stats)
7. Leaderboard migrations under `supabase/migrations/`

Enable **Email** provider for password sign-up.

After social SQL: Project Settings → API → Reload schema (or wait ~1 min). Smoke `GET /api/stt/social?action=feed` with a Bearer JWT.
Optional: Dashboard → Database → Publications → confirm `stt_posts`, `stt_friendships`, `stt_profiles`, `stt_messages` are in `supabase_realtime`.

## 2) Deploy / redeploy

```bash
cd "C:\Extension\WEB SCREEN TIME (LATEST)\Screen_Time_Tracker\website"
git push origin main
# or: npx vercel --prod
```

## 3) Vercel Environment Variables

Copy from `.env.example`. Names must match exactly.

### Already on many STT projects (keep / verify)

| Key | Notes |
|-----|--------|
| `PAYMENT_TEST_MODE` | `true` = sandbox, `false` = live |
| `ALLOW_LIVE_PAYMENTS` | Optional live override when not in test |
| `ALLOW_SIMULATED_CHECKOUT` | Soft SIM preview if keys missing; Pro only for `SIM_*` orders when true |
| `PAYPAL_TEST_CLIENT_ID` | Sandbox app client id |
| `PAYPAL_*SECRET` / `PAYPAL_TEST_CLIENT_SECRET` | Sandbox secret (fix truncated values) |
| `PAYPAL_LIVE_CLIENT_ID` | Live app (used only in live mode) |
| `PAYPAL_WEBHOOK_ID` | Optional |
| `RAZORPAY_TEST_KEY_ID` | `rzp_test_*` |
| `RAZORPAY_LIVE_KEY_ID` | Live key id |
| `SUPABASE_*` | URL + anon + service role |
| `MAIL_FROM` | Receipt / welcome from-address |
| `ENTITLEMENT_SECRET` | Signing / entitlement ops |
| `CRON_SECRET` | Cron routes |

### Must add now (if missing)

| Key | Suggested value |
|-----|-----------------|
| **`RAZORPAY_TEST_KEY_SECRET`** | Razorpay Dashboard → API Keys → Test **Key Secret** (required if KEY_ID is set) |
| **`SITE_URL`** | `https://screen-time-tracker-seven.vercel.app` (no trailing slash) |
| **`INR_USD_RATE`** | `95.12` |
| `MODE` | `sandbox` (optional; `PAYMENT_TEST_MODE` wins when set) |
| `PAYPAL_TEST_CLIENT_SECRET` | Re-paste if truncated / wrong |

Legacy fallbacks still work: `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`, `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.

After saving env vars → **Redeploy**.

### Mode resolution (server)

1. `PAYMENT_TEST_MODE` true → sandbox; **false → live** (only way to go live)  
2. Unset → **sandbox** (ignores `PAYPAL_MODE=live`, `ALLOW_LIVE_PAYMENTS`, and LIVE keys alone)  
3. `MODE` / `PAYPAL_MODE=sandbox|test` → sandbox (when unset)  

See **`PAYMENT_MODE.md`** for exact TEST-now / LIVE-later Vercel values.

Missing provider keys return **503** with `missing_env: ["VAR_NAME", …]`.  
If `ALLOW_SIMULATED_CHECKOUT=true`, create-order may return `mode: "simulated_preview"` (`SIM_*` ids). Capture/verify unlocks Pro for those **only** when that flag is on.

## 4) Point the extension at your site

In `src/config.js`:

```js
checkoutBaseUrl: "https://YOUR-PROJECT.vercel.app/checkout.html",
billingApiUrl: "https://YOUR-PROJECT.vercel.app/api/stt/access",
```

## 5) Test flow

1. Open `https://YOUR-PROJECT.vercel.app/api/config` — check `paymentMode`, `plans`, `providers`  
2. Open checkout with `?email=you@gmail.com` (no extension token required)  
3. PayPal sandbox or Razorpay test → Pro on that email / user_id  
4. Reopen extension → Pro  

## API map

| Route | Purpose |
|-------|---------|
| `GET /api/config` | Public mode, FX, plans, provider booleans |
| `GET /api/stt/access?email=` | Extension entitlement check |
| `POST /api/paypal/create-order` | Start PayPal |
| `POST /api/paypal/capture-order` | Finish PayPal → `stt_entitlements` |
| `POST /api/razorpay/create-order` | Start Razorpay |
| `POST /api/razorpay/verify-payment` | Verify → `stt_entitlements` |
