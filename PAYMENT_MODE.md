# Payment mode — TEST now, LIVE later

Site: `https://screen-time-tracker-seven.vercel.app`  
After any env change → **Redeploy**, then check  
`https://screen-time-tracker-seven.vercel.app/api/config` → `"paymentMode": "sandbox"`.

---

## PayPal “session timed out / log in again”

That message is from **PayPal’s site**, not ours. In **sandbox** mode the approve URL is `sandbox.paypal.com` — you must log in with a **Sandbox buyer** from [developer.paypal.com → Sandbox → Accounts](https://developer.paypal.com/dashboard/accounts). Your personal/live PayPal account will show session / “use other credentials” errors and **will not complete payment** (login alone ≠ paid).

To charge real money: set `PAYMENT_TEST_MODE=false` + live PayPal keys, redeploy, then use your real PayPal.

---

## NOW (TEST / sandbox)

Set these on Vercel → **Project → Settings → Environment Variables** for **Production** and **Preview**:

| Variable | Value |
|----------|--------|
| `PAYMENT_TEST_MODE` | `true` |
| `PAYPAL_MODE` | `sandbox` |
| `ALLOW_LIVE_PAYMENTS` | `false` |
| `SITE_URL` | `https://screen-time-tracker-seven.vercel.app` |

### Test secrets (required for real sandbox checkout)

| Variable | Notes |
|----------|--------|
| `PAYPAL_TEST_CLIENT_ID` | PayPal Developer → Sandbox app |
| `PAYPAL_TEST_CLIENT_SECRET` | Matching sandbox secret |
| *or* `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` | Only if those are **sandbox** credentials |
| `RAZORPAY_TEST_KEY_ID` | Must start with `rzp_test_` |
| `RAZORPAY_TEST_KEY_SECRET` | Matching test secret |

Do **not** leave only `rzp_live_*` / live PayPal as the active keys while in sandbox — checkout will 503 or show `key_mode_mismatch`.

Optional: `MODE=sandbox` (redundant when `PAYMENT_TEST_MODE=true`).

---

## LATER (LIVE)

When you are ready to charge real money:

| Variable | Change to |
|----------|-----------|
| `PAYMENT_TEST_MODE` | `false` |
| `PAYPAL_MODE` | `live` |
| `ALLOW_LIVE_PAYMENTS` | `true` (optional dual gate; not required if `PAYMENT_TEST_MODE=false`) |

And ensure live credentials are set:

- `PAYPAL_LIVE_CLIENT_ID` + `PAYPAL_LIVE_CLIENT_SECRET` (or live `PAYPAL_CLIENT_*`)
- `RAZORPAY_LIVE_KEY_ID` + `RAZORPAY_LIVE_KEY_SECRET` (or live `RAZORPAY_KEY_*`)

Redeploy → `/api/config` should show `"paymentMode": "live"` and `rzp_live_*` / live PayPal client id.

---

## Mode resolution (server)

1. `PAYMENT_TEST_MODE=true` → **sandbox** (always wins)  
2. `PAYMENT_TEST_MODE=false` → **live** (required to charge real money)  
3. Unset → **sandbox** (safe default; `PAYPAL_MODE=live` / live keys alone do **not** flip mode)  
4. `MODE`/`PAYPAL_MODE=sandbox|test` → sandbox when unset

---

## CLI (if logged in)

```bash
# From website/ — do not print secret values
echo true | npx vercel env add PAYMENT_TEST_MODE production
echo true | npx vercel env add PAYMENT_TEST_MODE preview
echo sandbox | npx vercel env add PAYPAL_MODE production
echo sandbox | npx vercel env add PAYPAL_MODE preview
echo false | npx vercel env add ALLOW_LIVE_PAYMENTS production
echo false | npx vercel env add ALLOW_LIVE_PAYMENTS preview
npx vercel --prod
```

If CLI shows **Logged out**, use the Vercel dashboard instead (table above).
