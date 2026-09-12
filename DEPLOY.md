# Deploy Screen Time Tracker website (Vercel)

Your Supabase: `https://mproxhlssrniwlcywfhq.supabase.co`  
Google Web Client ID: `179379728844-5tq61kd6dj85mulki8oftakk37je16jr.apps.googleusercontent.com`

## Leaderboard not listing members?

If the board shows only you, check this URL in a browser:

`https://screen-time-tracker-seven.vercel.app/api/stt/leaderboard?limit=5`

| Response | Meaning |
|----------|---------|
| **404** | API not deployed — redeploy this `website/` folder (env key alone cannot fix a missing route) |
| `{"error":"SUPABASE_SERVICE_ROLE_KEY missing..."}` | Add exact name `SUPABASE_SERVICE_ROLE_KEY` on **this** Vercel project → Redeploy |
| `{"users":[...],"source":"supabase-service-role"}` | Working — refresh Leaderboard in the extension |

`/api/stt/access` can work while `/api/stt/leaderboard` 404s — they are separate functions. `vercel.json` must rewrite all of them (access, leaderboard, sync-profile, guest-score).

Redeploy from this folder:

```bash
cd "C:\Extension\WEB SCREEN TIME (LATEST)\Screen_Time_Tracker\website"
npx vercel login
npx vercel --prod
```

## 1) Supabase SQL (required)

SQL Editor → paste and run **in order**:

1. `../supabase/schema.sql` (base tables, if not already applied)
2. `../supabase/schema-v5.sql` (usage days, social, notifications, guest scores)
3. If you see missing-column errors: `../supabase/fix-profiles.sql` then wait a few seconds (or run `notify pgrst, 'reload schema';`)
4. **Leaderboard real stats (required for Global/Today non-zero peers):**  
   `supabase/migrations/20260912_global_leaderboard_real_stats.sql`  
   (same file also at `../supabase/migrations/20260912_global_leaderboard_real_stats.sql` in the extension tree)

Also enable **Email** provider (Auth → Providers → Email) for password sign-up.

## 2) Supabase Auth → Google

1. Authentication → Providers → **Google** → Enable  
2. Client ID = the Google Web client above  
3. Client Secret = from Google Cloud (the one ending `…S6qB` / rotate if lost)  
4. Redirect URL already in Google:  
   `https://mproxhlssrniwlcywfhq.supabase.co/auth/v1/callback`  
5. Auth → URL Configuration → add:  
   `https://pnpaojmenmeplajemjhjpjckcngbpeno.chromiumapp.org/`  
   (and your live extension ID URI if different)

## 3) Deploy this folder to Vercel

```bash
cd "C:\Extension\WEB SCREEN TIME (LATEST)\Screen_Time_Tracker\website"
npm install
npx vercel
```

Create a **new** Vercel project (don’t overwrite Claude Enhancer).

## 4) Vercel Environment Variables

Copy from `.env.example`:

| Key | Value |
|-----|--------|
| `SITE_URL` | `https://YOUR-PROJECT.vercel.app` |
| `SUPABASE_URL` | `https://mproxhlssrniwlcywfhq.supabase.co` |
| `SUPABASE_ANON_KEY` | Project Settings → API → anon |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → service_role (**secret**) |
| `MODE` | `sandbox` (default) or `live` |
| `PAYPAL_TEST_CLIENT_ID` / `PAYPAL_TEST_CLIENT_SECRET` | PayPal Developer → Sandbox app |
| `PAYPAL_LIVE_CLIENT_ID` / `PAYPAL_LIVE_CLIENT_SECRET` | Live app (only when MODE=live) |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Fallback aliases if TEST_/LIVE_ not set |
| `RAZORPAY_TEST_KEY_ID` / `RAZORPAY_TEST_KEY_SECRET` | Razorpay Dashboard → Test (`rzp_test_*`) |
| `RAZORPAY_LIVE_KEY_ID` / `RAZORPAY_LIVE_KEY_SECRET` | Live keys only when MODE=live |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Fallback aliases |

Missing payment keys return **503** (no simulated Pro). Redeploy after saving env vars.

## 5) Point the extension at your site

In `src/config.js`:

```js
checkoutBaseUrl: "https://YOUR-PROJECT.vercel.app/checkout.html",
billingApiUrl: "https://YOUR-PROJECT.vercel.app/api/stt/access",
```

Add host permission for your Vercel domain in `manifest.json` if needed.

## 6) Test flow

1. Load unpacked extension  
2. Sign in with Google  
3. Open Pro → PayPal or Razorpay  
4. Pay (sandbox)  
5. Reopen popup → plan should become Pro  

## API map

| Route | Purpose |
|-------|---------|
| `GET /api/stt/access?email=` | Extension entitlement check |
| `POST /api/paypal/create-order` | Start PayPal |
| `POST /api/paypal/capture-order` | Finish PayPal → `stt_entitlements` |
| `POST /api/razorpay/create-order` | Start Razorpay |
| `POST /api/razorpay/verify-payment` | Verify → `stt_entitlements` |
