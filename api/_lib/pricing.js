/**
 * STT server pricing — never trust client amounts.
 * Keep in sync with supabase/functions/_shared/pricing.ts
 *
 * INR = Math.round(USD × INR_USD_RATE). Default rate 95.12 (set on Vercel).
 * INR totals are tax-included; USD quotes add GST on top.
 */

export const GST_RATE = 0.18;
export const DEFAULT_INR_USD_RATE = 95.12;

function envTruthy(v) {
  return ["1", "true", "yes", "on"].includes(String(v ?? "").trim().toLowerCase());
}

function envFalsy(v) {
  return ["0", "false", "no", "off"].includes(String(v ?? "").trim().toLowerCase());
}

export function getInrUsdRate() {
  const n = Number(process.env.INR_USD_RATE);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INR_USD_RATE;
}

/** Whole-rupee FX from USD list price */
export function usdToInr(usd) {
  return Math.round(Number(usd) * getInrUsdRate());
}

const PLAN_DEFS = {
  monthly: {
    id: "monthly",
    name: "Pro Monthly",
    priceUSD: 3.99,
    days: 30,
    durationLabel: "30 days",
    desc: "Screen Time Tracker Pro — Monthly",
  },
  quarterly: {
    id: "quarterly",
    name: "Pro 3 Months",
    priceUSD: 10.99,
    days: 90,
    durationLabel: "90 days",
    desc: "Screen Time Tracker Pro — 3 Months",
  },
  yearly: {
    id: "yearly",
    name: "Pro Yearly",
    priceUSD: 29.99,
    days: 365,
    durationLabel: "365 days",
    desc: "Screen Time Tracker Pro — Yearly",
  },
  years_2: {
    id: "years_2",
    name: "Pro 2 Years",
    priceUSD: 54.99,
    days: 730,
    durationLabel: "730 days",
    desc: "Screen Time Tracker Pro — 2 Years",
  },
  lifetime: {
    id: "lifetime",
    name: "Pro Lifetime",
    priceUSD: 79.99,
    days: null,
    durationLabel: "lifetime",
    desc: "Screen Time Tracker Pro — Lifetime",
  },
};

/** Snapshot at load with default/current env rate (for docs & static mirrors) */
export const PLANS = Object.fromEntries(
  Object.entries(PLAN_DEFS).map(([k, p]) => [k, { ...p, priceINR: usdToInr(p.priceUSD) }]),
);

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function getPlan(cycle) {
  const base = PLAN_DEFS[cycle] || PLAN_DEFS.yearly;
  return { ...base, priceINR: usdToInr(base.priceUSD) };
}

export function quoteUSD(cycle) {
  const plan = getPlan(cycle);
  const subtotal = plan.priceUSD;
  const gst = round2(subtotal * GST_RATE);
  const total = round2(subtotal + gst);
  return {
    cycle: plan.id,
    name: plan.name,
    currency: "USD",
    subtotal,
    gstRate: GST_RATE,
    gst,
    total,
    days: plan.days,
    durationLabel: plan.durationLabel,
    desc: plan.desc,
  };
}

/** INR list price from FX (GST included; break out for invoices) */
export function quoteINR(cycle) {
  const plan = getPlan(cycle);
  const total = plan.priceINR;
  const subtotal = round2(total / (1 + GST_RATE));
  const gst = round2(total - subtotal);
  return {
    cycle: plan.id,
    name: plan.name,
    currency: "INR",
    subtotal,
    gstRate: GST_RATE,
    gst,
    total,
    amountPaise: Math.round(total * 100),
    fxRate: getInrUsdRate(),
    days: plan.days,
    durationLabel: plan.durationLabel,
    desc: plan.desc,
  };
}

export function computeExpiresAt(cycle, from = new Date()) {
  const plan = getPlan(cycle);
  if (!plan.days) return null;
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + plan.days);
  return d.toISOString();
}

/**
 * Resolve sandbox vs live (live by default for production checkout).
 *
 * - PAYMENT_TEST_MODE=true|1|yes|on  → sandbox (always wins)
 * - PAYMENT_TEST_MODE=false|0|no|off → live
 * - unset → live (use PAYMENT_TEST_MODE=true only when you need sandbox)
 * - MODE / PAYPAL_MODE = sandbox|test → sandbox when PAYMENT_TEST_MODE unset
 */
export function paymentMode() {
  const ptm = process.env.PAYMENT_TEST_MODE;
  if (envTruthy(ptm)) return "sandbox";
  if (envFalsy(ptm)) return "live";

  const raw = String(
    process.env.MODE || process.env.PAYMENT_MODE || process.env.PAYPAL_MODE || "",
  )
    .trim()
    .toLowerCase();
  if (raw === "sandbox" || raw === "test") return "sandbox";

  return "live";
}

export function allowSimulatedCheckout() {
  return envTruthy(process.env.ALLOW_SIMULATED_CHECKOUT);
}

function firstFilled(...pairs) {
  for (const [value, name] of pairs) {
    const v = String(value || "").trim();
    if (v && !v.includes("paste_here") && !v.includes("placeholder")) {
      return { value: v, name };
    }
  }
  return { value: "", name: pairs[0]?.[1] || "" };
}

/** PayPal client id/secret for current paymentMode */
export function paypalCredentials() {
  const mode = paymentMode();
  if (mode === "live") {
    const id = firstFilled(
      [process.env.PAYPAL_LIVE_CLIENT_ID, "PAYPAL_LIVE_CLIENT_ID"],
      [process.env.PAYPAL_CLIENT_ID, "PAYPAL_CLIENT_ID"],
    );
    const secret = firstFilled(
      [process.env.PAYPAL_LIVE_CLIENT_SECRET, "PAYPAL_LIVE_CLIENT_SECRET"],
      [process.env.PAYPAL_CLIENT_SECRET, "PAYPAL_CLIENT_SECRET"],
    );
    return {
      mode,
      clientId: id.value,
      clientSecret: secret.value,
      clientIdVar: id.name || "PAYPAL_LIVE_CLIENT_ID",
      clientSecretVar: secret.name || "PAYPAL_LIVE_CLIENT_SECRET",
      apiBase: "https://api-m.paypal.com",
    };
  }
  const id = firstFilled(
    [process.env.PAYPAL_TEST_CLIENT_ID, "PAYPAL_TEST_CLIENT_ID"],
    [process.env.PAYPAL_CLIENT_ID, "PAYPAL_CLIENT_ID"],
  );
  const secret = firstFilled(
    [process.env.PAYPAL_TEST_CLIENT_SECRET, "PAYPAL_TEST_CLIENT_SECRET"],
    [process.env.PAYPAL_CLIENT_SECRET, "PAYPAL_CLIENT_SECRET"],
  );
  return {
    mode,
    clientId: id.value,
    clientSecret: secret.value,
    clientIdVar: id.name || "PAYPAL_TEST_CLIENT_ID",
    clientSecretVar: secret.name || "PAYPAL_TEST_CLIENT_SECRET",
    apiBase: "https://api-m.sandbox.paypal.com",
  };
}

export function missingPaypalEnvVars() {
  const c = paypalCredentials();
  const missing = [];
  if (!c.clientId) missing.push(c.clientIdVar);
  if (!c.clientSecret) missing.push(c.clientSecretVar);
  return missing;
}

/** Razorpay key id/secret for current paymentMode (+ RAZORPAY_KEY_* fallbacks) */
export function razorpayCredentials() {
  const mode = paymentMode();
  if (mode === "live") {
    const id = firstFilled(
      [process.env.RAZORPAY_LIVE_KEY_ID, "RAZORPAY_LIVE_KEY_ID"],
      [process.env.RAZORPAY_KEY_ID, "RAZORPAY_KEY_ID"],
    );
    const secret = firstFilled(
      [process.env.RAZORPAY_LIVE_KEY_SECRET, "RAZORPAY_LIVE_KEY_SECRET"],
      [process.env.RAZORPAY_KEY_SECRET, "RAZORPAY_KEY_SECRET"],
    );
    return {
      mode,
      keyId: id.value,
      keySecret: secret.value,
      keyIdVar: id.name || "RAZORPAY_LIVE_KEY_ID",
      keySecretVar: secret.name || "RAZORPAY_LIVE_KEY_SECRET",
    };
  }
  // Sandbox: prefer TEST_* ; only fall back to RAZORPAY_KEY_* if it looks like test (rzp_test_)
  const legacyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const legacyOk = /^rzp_test_/i.test(legacyId);
  const id = firstFilled(
    [process.env.RAZORPAY_TEST_KEY_ID, "RAZORPAY_TEST_KEY_ID"],
    [legacyOk ? legacyId : "", "RAZORPAY_KEY_ID"],
  );
  const secret = firstFilled(
    [process.env.RAZORPAY_TEST_KEY_SECRET, "RAZORPAY_TEST_KEY_SECRET"],
    [legacyOk ? process.env.RAZORPAY_KEY_SECRET : "", "RAZORPAY_KEY_SECRET"],
  );
  return {
    mode,
    keyId: id.value,
    keySecret: secret.value,
    keyIdVar: id.name || "RAZORPAY_TEST_KEY_ID",
    keySecretVar: secret.name || "RAZORPAY_TEST_KEY_SECRET",
  };
}

export function missingRazorpayEnvVars() {
  const c = razorpayCredentials();
  const missing = [];
  if (!c.keyId) missing.push(c.keyIdVar);
  if (!c.keySecret) missing.push(c.keySecretVar);
  return missing;
}

export function siteUrl() {
  return (process.env.SITE_URL || "https://screen-time-tracker-seven.vercel.app").replace(/\/$/, "");
}

/** Public checkout plans (monthly / yearly / lifetime storefront) */
export function publicPlans() {
  const rate = getInrUsdRate();
  const cycles = ["monthly", "yearly", "lifetime"];
  const out = {};
  for (const id of cycles) {
    const p = getPlan(id);
    out[id] = {
      id: p.id,
      name: p.name,
      priceUSD: p.priceUSD,
      priceINR: p.priceINR,
      days: p.days,
    };
  }
  return { plans: out, inrUsdRate: rate, gstRate: GST_RATE };
}
