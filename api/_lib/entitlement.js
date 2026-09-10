/**
 * Write / read stt_entitlements in Supabase
 */
import { sbFetch } from "./supabase.js";

export function normalizeEmail(email) {
  return String(email || "").toLowerCase().trim();
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
}) {
  const billingEmail = normalizeEmail(email);
  if (!billingEmail) return { ok: false, error: "email required" };

  const row = {
    email: billingEmail,
    user_id: userId,
    plan: plan === "pro" ? cycle || "yearly" : plan,
    cycle: cycle || plan,
    provider: provider || null,
    status,
    expires_at: expiresAt,
    external_id: externalId,
    updated_at: new Date().toISOString(),
  };

  // Prefer upsert on email unique index
  const res = await sbFetch(`/rest/v1/stt_entitlements?on_conflict=email`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: row,
  });

  if (!res.ok) {
    // Fallback: try update then insert
    const upd = await sbFetch(`/rest/v1/stt_entitlements?email=eq.${encodeURIComponent(billingEmail)}`, {
      method: "PATCH",
      prefer: "return=representation",
      body: row,
    });
    if (!upd.ok || !upd.data?.length) {
      const ins = await sbFetch(`/rest/v1/stt_entitlements`, {
        method: "POST",
        prefer: "return=representation",
        body: { ...row, created_at: new Date().toISOString() },
      });
      return ins;
    }
    return upd;
  }

  // Log checkout event (best-effort)
  await sbFetch(`/rest/v1/stt_checkout_events`, {
    method: "POST",
    body: {
      email: billingEmail,
      provider,
      cycle: cycle || plan,
      payload: { externalId, expiresAt, status },
    },
  }).catch(() => {});

  return res;
}

export async function findEntitlementByEmail(email) {
  const billingEmail = normalizeEmail(email);
  if (!billingEmail) return null;
  const res = await sbFetch(
    `/rest/v1/stt_entitlements?email=eq.${encodeURIComponent(billingEmail)}&select=*&limit=1`
  );
  if (!res.ok) return null;
  const row = Array.isArray(res.data) ? res.data[0] : null;
  if (!row || row.status === "canceled") return null;
  if (row.plan === "lifetime" || row.cycle === "lifetime") return row;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}
