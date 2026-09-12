/**
 * STT server pricing — never trust client amounts
 * Keep in sync with supabase/functions/_shared/pricing.ts
 */
export const GST_RATE = 0.18;

export const PLANS = {
  monthly: {
    id: "monthly",
    name: "Pro Monthly",
    priceUSD: 4.99,
    priceINR: 299,
    days: 30,
    durationLabel: "30 days",
    desc: "Screen Time Tracker Pro — Monthly",
  },
  quarterly: {
    id: "quarterly",
    name: "Pro 3 Months",
    priceUSD: 12.99,
    priceINR: 799,
    days: 90,
    durationLabel: "90 days",
    desc: "Screen Time Tracker Pro — 3 Months",
  },
  yearly: {
    id: "yearly",
    name: "Pro Yearly",
    priceUSD: 39,
    priceINR: 2499,
    days: 365,
    durationLabel: "365 days",
    desc: "Screen Time Tracker Pro — Yearly",
  },
  years_2: {
    id: "years_2",
    name: "Pro 2 Years",
    priceUSD: 69,
    priceINR: 4499,
    days: 730,
    durationLabel: "730 days",
    desc: "Screen Time Tracker Pro — 2 Years",
  },
  lifetime: {
    id: "lifetime",
    name: "Pro Lifetime",
    priceUSD: 79,
    priceINR: 4999,
    days: null,
    durationLabel: "lifetime",
    desc: "Screen Time Tracker Pro — Lifetime",
  },
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

export function getPlan(cycle) {
  return PLANS[cycle] || PLANS.yearly;
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

/** Fixed INR list prices (GST included in display; still break out for invoices) */
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

export function paymentMode() {
  const raw = (
    process.env.MODE ||
    process.env.PAYMENT_MODE ||
    process.env.PAYPAL_MODE ||
    "sandbox"
  ).toLowerCase();
  return raw === "live" ? "live" : "sandbox";
}
