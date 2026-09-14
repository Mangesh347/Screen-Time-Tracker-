# Payment mode — LIVE now

Site: `https://screen-time-tracker-seven.vercel.app`  
After any env change → **Redeploy**, then check  
`https://screen-time-tracker-seven.vercel.app/api/config` → `"paymentMode": "live"`.

---

## LIVE (default)

Server code now defaults to **live** when `PAYMENT_TEST_MODE` is unset.

Set these on Vercel → **Project → Settings → Environment Variables** for **Production** (and Preview if you use it):

| Variable | Value |
|----------|--------|
| `PAYMENT_TEST_MODE` | `false` |
| `PAYPAL_MODE` | `live` |
| `ALLOW_LIVE_PAYMENTS` | `true` |
| `SITE_URL` | `https://screen-time-tracker-seven.vercel.app` |
| `INR_USD_RATE` | `95.12` |

### Live secrets (required)

| Variable | Notes |
|----------|--------|
| `PAYPAL_LIVE_CLIENT_ID` | PayPal live app Client ID |
| `PAYPAL_LIVE_CLIENT_SECRET` | Matching live secret |
| `RAZORPAY_LIVE_KEY_ID` | Must start with `rzp_live_` |
| `RAZORPAY_LIVE_KEY_SECRET` | Matching live secret |

If `PAYMENT_TEST_MODE` is still `true` on Vercel, change it to `false` and redeploy or live will not activate.

---

## TEST / sandbox (only when you need it)

| Variable | Value |
|----------|--------|
| `PAYMENT_TEST_MODE` | `true` |
| `PAYPAL_MODE` | `sandbox` |
| `PAYPAL_TEST_CLIENT_ID` / `PAYPAL_TEST_CLIENT_SECRET` | Sandbox app |
| `RAZORPAY_TEST_KEY_ID` / `RAZORPAY_TEST_KEY_SECRET` | `rzp_test_*` |

Sandbox PayPal requires a **Sandbox buyer** from developer.paypal.com — personal PayPal login will fail.

---

## Mode resolution (server)

1. `PAYMENT_TEST_MODE=true` → **sandbox** (always wins)  
2. `PAYMENT_TEST_MODE=false` → **live**  
3. Unset → **live**  
4. `MODE` / `PAYPAL_MODE=sandbox|test` → sandbox when unset  

---

## Current list prices (USD → INR @ 95.12)

| Plan | USD | INR |
|------|-----|-----|
| Monthly | $3.99 | ₹380 |
| Yearly | $29.99 | ₹2,853 |
| Lifetime | $79.99 | ₹7,609 |
