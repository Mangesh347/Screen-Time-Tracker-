/**
 * STT server pricing — never trust client amounts
 */
export const GST_RATE = 0.18;

export const PLANS = {
  monthly: {
    id: "monthly",
    name: "Pro Monthly",
    priceUSD: 4.99,
    priceINR: 299,
    days: 30,
    desc: "Screen Time Tracker Pro — Monthly",
  },
  yearly: {
    id: "yearly",
    name: "Pro Yearly",
    priceUSD: 39,
    priceINR: 2499,
    days: 365,
    desc: "Screen Time Tracker Pro — Yearly",
  },
  lifetime: {
    id: "lifetime",
    name: "Pro Lifetime",
    priceUSD: 79,
    priceINR: 4999,
    days: null,
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
