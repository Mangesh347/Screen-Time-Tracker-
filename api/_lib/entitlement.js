/**
 * Write / read stt_entitlements in Supabase — bound to user_id when available
 */
import { sbFetch } from "./supabase.js";
import { getPlan } from "./pricing.js";

export function normalizeEmail(email) {
  return String(email || "").toLowerCase().trim();
}

export function computeIsPro(row) {
  if (!row) return false;
  const status = String(row.status || "").toLowerCase();
  if (["canceled", "cancelled", "refunded", "expired", "failed", "unverified"].includes(status)) {
    return false;
  }
  if (status && !["active", "paid"].includes(status)) return false;
  const plan = String(row.plan || row.cycle || "free").toLowerCase();
  if (!plan || plan === "free") return false;
  if (plan === "lifetime") return true;
  if (!row.expires_at) return true;
  return new Date(row.expires_at).getTime() > Date.now();
}

export async function upsertEntitlement({
  email,
  userId = null,
  plan = "yearly",
  cycle,
  provider,
  status = "active",
  expiresAt = null,
  externalId = null,
  paymentId = null,
  orderId = null,
  amount = null,
  currency = null,
  webhookVerified = false,
  metadata = {},
}) {
  const billingEmail = normalizeEmail(email);
  if (!billingEmail && !userId) return { ok: false, error: "user_id or email required" };

  const planDef = getPlan(cycle || plan);
  const now = new Date().toISOString();
  const row = {
    email: billingEmail || null,
    user_id: userId,
    plan: planDef.id,
    cycle: planDef.id,
    provider: provider || null,
    status,
    expires_at: expiresAt,
    starts_at: now,
    external_id: externalId || paymentId || orderId,
    payment_id: paymentId,
    order_id: orderId,
    duration_days: planDef.days,
    duration_label: planDef.durationLabel,
    amount,
    currency,
    webhook_verified: !!webhookVerified,
    webhook_verified_at: webhookVerified ? now : null,
    metadata,
    updated_at: now,
  };

  // Prefer user_id upsert
  if (userId) {
    const existing = await sbFetch(
      `/rest/v1/stt_entitlements?user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
    );
    const id = existing.data?.[0]?.id;
    if (id) {
      const upd = await sbFetch(`/rest/v1/stt_entitlements?id=eq.${id}`, {
        method: "PATCH",
        prefer: "return=representation",
        body: row,
      });
      await mirrorProfile(userId, billingEmail, planDef.id, expiresAt, provider);
      await logEvent(billingEmail, provider, planDef.id, { externalId, expiresAt, status, userId });
      return upd;
    }
  }

  // Legacy email upsert
  const res = await sbFetch(`/rest/v1/stt_entitlements?on_conflict=email`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: { ...row, created_at: now },
  });

  if (!res.ok && billingEmail) {
    const upd = await sbFetch(`/rest/v1/stt_entitlements?email=eq.${encodeURIComponent(billingEmail)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: row,
    });
    if (!upd.ok || !upd.data?.length) {
      const ins = await sbFetch(`/rest/v1/stt_entitlements`, {
        method: "POST",
        prefer: "return=representation",
        body: { ...row, created_at: now },
      });
      if (userId) await mirrorProfile(userId, billingEmail, planDef.id, expiresAt, provider);
      await logEvent(billingEmail, provider, planDef.id, { externalId, expiresAt, status, userId });
      return ins;
    }
    if (userId) await mirrorProfile(userId, billingEmail, planDef.id, expiresAt, provider);
    await logEvent(billingEmail, provider, planDef.id, { externalId, expiresAt, status, userId });
    return upd;
  }

  if (userId) await mirrorProfile(userId, billingEmail, planDef.id, expiresAt, provider);
  await logEvent(billingEmail, provider, planDef.id, { externalId, expiresAt, status, userId });
  return res;
}

async function mirrorProfile(userId, email, plan, expiresAt, provider) {
  if (!userId) return;
  const now = new Date().toISOString();
  await sbFetch(`/rest/v1/stt_profiles?on_conflict=id`, {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: {
      id: userId,
      email: email || null,
      plan,
      plan_expires_at: expiresAt,
      plan_provider: provider || null,
      plan_updated_at: now,
      updated_at: now,
    },
  }).catch(() => {});
}

async function logEvent(email, provider, cycle, payload) {
  await sbFetch(`/rest/v1/stt_checkout_events`, {
    method: "POST",
    body: {
      email,
      provider,
      cycle,
      payload,
    },
  }).catch(() => {});
}

/** Idempotent payment event insert. Returns { claimed: boolean } */
export async function claimPaymentEvent({
  provider,
  eventId,
  eventType,
  paymentId = null,
  orderId = null,
  userId = null,
  email = null,
  cycle = null,
  verified = false,
  payload = {},
}) {
  const res = await sbFetch(`/rest/v1/stt_payment_events`, {
    method: "POST",
    prefer: "return=representation",
    body: {
      provider,
      event_id: eventId,
      event_type: eventType,
      payment_id: paymentId,
      order_id: orderId,
      user_id: userId,
      email: email ? normalizeEmail(email) : null,
      cycle,
      status: "processing",
      verified,
      payload,
    },
  });
  if (!res.ok) {
    const msg = typeof res.data === "string" ? res.data : JSON.stringify(res.data || "");
    if (res.status === 409 || /duplicate|unique/i.test(msg)) {
      return { claimed: false };
    }
    return { claimed: false, error: res.data };
  }
  return { claimed: true, row: res.data?.[0] || res.data };
}

export async function markEventProcessed(provider, eventId, status, error = null) {
  await sbFetch(
    `/rest/v1/stt_payment_events?provider=eq.${encodeURIComponent(provider)}&event_id=eq.${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: {
        status,
        error,
        processed_at: new Date().toISOString(),
      },
    },
  ).catch(() => {});
}

export async function findEntitlementByUserId(userId) {
  if (!userId) return null;
  const res = await sbFetch(
    `/rest/v1/stt_entitlements?user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`,
  );
  if (!res.ok) return null;
  const row = Array.isArray(res.data) ? res.data[0] : null;
  if (!computeIsPro(row)) return null;
  return row;
}

export async function findEntitlementByEmail(email) {
  const billingEmail = normalizeEmail(email);
  if (!billingEmail) return null;
  const res = await sbFetch(
    `/rest/v1/stt_entitlements?email=eq.${encodeURIComponent(billingEmail)}&select=*&limit=1`,
  );
  if (!res.ok) return null;
  const row = Array.isArray(res.data) ? res.data[0] : null;
  if (!computeIsPro(row)) return null;
  return row;
}

export async function demoteEntitlement({ userId, email, reason }) {
  const now = new Date().toISOString();
  const body = {
    plan: "free",
    cycle: "free",
    status: reason || "expired",
    expires_at: now,
    webhook_verified: true,
    webhook_verified_at: now,
    updated_at: now,
  };
  if (userId) {
    await sbFetch(`/rest/v1/stt_entitlements?user_id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body,
    });
    await sbFetch(`/rest/v1/stt_profiles?id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: {
        plan: "free",
        plan_expires_at: null,
        plan_provider: null,
        plan_updated_at: now,
        updated_at: now,
      },
    }).catch(() => {});
  }
  if (email) {
    await sbFetch(`/rest/v1/stt_entitlements?email=eq.${encodeURIComponent(normalizeEmail(email))}`, {
      method: "PATCH",
      body,
    });
  }
  // Also demote by email when we have userId (covers duplicate rows)
  if (userId && email) {
    await sbFetch(
      `/rest/v1/stt_entitlements?email=eq.${encodeURIComponent(normalizeEmail(email))}&user_id=neq.${encodeURIComponent(userId)}`,
      { method: "PATCH", body },
    ).catch(() => {});
  }
}
