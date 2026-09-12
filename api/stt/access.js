/**
 * GET /api/stt/access
 * Prefer Authorization Bearer → user_id entitlement.
 * Returns { plan, is_pro, expires_at, provider } (+ legacy pro/expiresAt aliases).
 */
import {
  findEntitlementByEmail,
  findEntitlementByUserId,
  normalizeEmail,
  computeIsPro,
  demoteEntitlement,
} from "../_lib/entitlement.js";
import { userFromAuthHeader } from "../_lib/auth.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function freePayload(extra = {}) {
  return {
    plan: "free",
    is_pro: false,
    pro: false,
    expires_at: null,
    expiresAt: null,
    provider: null,
    providers: ["paypal", "razorpay"],
    ...extra,
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authUser = await userFromAuthHeader(req);
    let row = null;

    if (authUser?.id) {
      row = await findEntitlementByUserId(authUser.id);
      // If row exists but expired, demote
      if (!row) {
        // Check raw expired row to demote
        const { sbFetch } = await import("../_lib/supabase.js");
        const raw = await sbFetch(
          `/rest/v1/stt_entitlements?user_id=eq.${encodeURIComponent(authUser.id)}&select=*&limit=1`,
        );
        const r = raw.data?.[0];
        if (
          r &&
          ["active", "paid"].includes(String(r.status || "").toLowerCase()) &&
          r.plan !== "lifetime" &&
          r.expires_at &&
          new Date(r.expires_at).getTime() <= Date.now()
        ) {
          await demoteEntitlement({ userId: authUser.id, email: authUser.email, reason: "expired" });
        }
      }
    } else {
      // Legacy email query — read-only; does not prove ownership for upgrades
      const email = normalizeEmail(req.query?.email || "");
      if (email) row = await findEntitlementByEmail(email);
    }

    if (!row || !computeIsPro(row)) {
      return res.status(200).json(freePayload({ email: authUser?.email || normalizeEmail(req.query?.email || "") || undefined }));
    }

    const plan = row.plan || row.cycle || "yearly";
    return res.status(200).json({
      plan,
      cycle: row.cycle || plan,
      is_pro: true,
      pro: true,
      provider: row.provider || null,
      expires_at: row.expires_at || null,
      expiresAt: row.expires_at || null,
      email: row.email || authUser?.email || null,
      user_id: row.user_id || authUser?.id || null,
      status: row.status || "active",
      providers: ["paypal", "razorpay"],
    });
  } catch (err) {
    console.error("[stt/access]", err);
    return res.status(500).json({ error: err.message || "access failed" });
  }
}
