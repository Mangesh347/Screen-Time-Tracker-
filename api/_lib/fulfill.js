/**
 * Shared Pro fulfillment after a payment provider confirms success.
 * Never marks Pro until Supabase entitlement write succeeds.
 */
import { upsertEntitlement, claimPaymentEvent, markEventProcessed } from "./entitlement.js";
import { computeExpiresAt, getPlan } from "./pricing.js";

function siteBase() {
  return (
    process.env.SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://screen-time-tracker-seven.vercel.app"
  ).replace(/\/$/, "");
}

export function buildSuccessRedirect({ email, cycle, provider, userId, extId }) {
  const qs = new URLSearchParams({
    email: email || "",
    cycle: cycle || "yearly",
    provider: provider || "",
    is_pro: "1",
  });
  if (userId) qs.set("user_id", userId);
  if (extId) qs.set("ext_id", String(extId).replace(/[^a-z0-9]/gi, ""));
  return `${siteBase()}/success.html?${qs.toString()}`;
}

/**
 * Idempotent: claim payment event → write Pro + deadline → return redirect.
 * @returns {{ ok: true, ... } | { ok: false, error, status }}
 */
export async function fulfillVerifiedPayment({
  provider,
  eventId,
  eventType = "client_verify",
  paymentId,
  orderId = null,
  userId,
  email,
  cycle,
  amount = null,
  currency = null,
  mode = "sandbox",
  extId = "",
  metadata = {},
  payload = {},
}) {
  const plan = getPlan(cycle);
  const expiresAt = computeExpiresAt(plan.id); // null for lifetime
  const billingEmail = String(email || "").toLowerCase().trim();

  if (!userId && !billingEmail) {
    return { ok: false, status: 400, error: "user_id or email required", is_pro: false };
  }

  const claim = await claimPaymentEvent({
    provider,
    eventId,
    eventType,
    paymentId,
    orderId,
    userId,
    email: billingEmail,
    cycle: plan.id,
    verified: true,
    payload,
  });

  // Duplicate successful payment → still Pro (idempotent)
  if (!claim.claimed && !claim.error) {
    return {
      ok: true,
      success: true,
      duplicate: true,
      plan: plan.id,
      cycle: plan.id,
      email: billingEmail,
      user_id: userId,
      expiresAt,
      provider,
      payment_id: paymentId,
      is_pro: true,
      mode,
      redirect: buildSuccessRedirect({
        email: billingEmail,
        cycle: plan.id,
        provider,
        userId,
        extId,
      }),
    };
  }

  const ent = await upsertEntitlement({
    email: billingEmail,
    userId,
    plan: plan.id,
    cycle: plan.id,
    provider,
    status: "active",
    expiresAt,
    externalId: paymentId,
    paymentId,
    orderId,
    amount,
    currency,
    webhookVerified: true,
    metadata: { ...metadata, mode, expiresAt, duration_days: plan.days },
  });

  if (!ent?.ok) {
    console.error("[STT fulfill] entitlement write failed", ent?.status, ent?.data);
    await markEventProcessed(provider, eventId, "error", "entitlement_write_failed");
    return {
      ok: false,
      status: 502,
      error: "entitlement_write_failed",
      message:
        "Payment verified with the provider, but Pro could not be saved. Contact support with your payment id — you will not be charged again.",
      payment_id: paymentId,
      email: billingEmail,
      is_pro: false,
    };
  }

  await markEventProcessed(provider, eventId, "processed");

  return {
    ok: true,
    success: true,
    plan: plan.id,
    cycle: plan.id,
    email: billingEmail,
    user_id: userId,
    expiresAt,
    duration_days: plan.days,
    duration_label: plan.durationLabel,
    provider,
    payment_id: paymentId,
    is_pro: true,
    mode,
    redirect: buildSuccessRedirect({
      email: billingEmail,
      cycle: plan.id,
      provider,
      userId,
      extId,
    }),
  };
}
