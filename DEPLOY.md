# Deploy Screen Time Tracker website (Vercel)

Your Supabase: `https://mproxhlssrniwlcywfhq.supabase.co`  
Google Web Client ID: `179379728844-5tq61kd6dj85mulki8oftakk37je16jr.apps.googleusercontent.com`

## 1) Supabase SQL (required)

SQL Editor → paste and run:

`../supabase/schema.sql`

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
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | PayPal Developer |
| `PAYPAL_MODE` | `sandbox` then `live` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay Dashboard |

Redeploy after saving env vars.

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
