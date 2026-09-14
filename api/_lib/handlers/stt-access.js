/**
 * GET /api/stt/access
 * Auto-checks Free vs Pro for the signed-in user (Bearer) or ?email=.
 * Reads stt_entitlements first, then stt_profiles.plan — no manual steps.
 */
import {
  resolveEntitlement,
  normalizeEmail,
  computeIsPro,
  demoteEntitlement,
} from "../entitlement.js";
import { userFromAuthHeader } from "../auth.js";

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
    const authUser = await userFromAuthHeader(req).catch(() => null);
    const queryEmail = normalizeEmail(req.query?.email || "");
    const email = normalizeEmail(authUser?.email || queryEmail);

    let row = await resolveEntitlement({
      userId: authUser?.id || null,
      email,
    });

    // Demote expired active rows so the next check stays accurate
    if (
      row &&
      !computeIsPro(row) &&
      authUser?.id &&
      row.expires_at &&
      String(row.plan || "").toLowerCase() !== "lifetime"
    ) {
      await demoteEntitlement({
        userId: authUser.id,
        email: authUser.email || email,
        reason: "expired",
      }).catch(() => {});
      row = null;
    }

    if (!row || !computeIsPro(row)) {
      return res.status(200).json(freePayload({ email: email || undefined }));
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
      email: row.email || email || null,
      user_id: row.user_id || authUser?.id || null,
      status: row.status || "active",
      providers: ["paypal", "razorpay"],
      source: "auto",
    });
  } catch (err) {
    console.error("[stt/access]", err);
    // Never hard-fail the extension — treat as Free and keep UI usable
    return res.status(200).json(
      freePayload({
        error: err.message || "access failed",
        degraded: true,
      }),
    );
  }
}
