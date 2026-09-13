/**
 * Server-side auth + Pro gates — never trust client UI alone.
 */
import { userFromAuthHeader } from "./auth.js";
import {
  findEntitlementByUserId,
  findEntitlementByEmail,
  computeIsPro,
} from "./entitlement.js";

export async function requireAuth(req, res) {
  const user = await userFromAuthHeader(req);
  if (!user?.id) {
    res.status(401).json({ error: "Sign in required", code: "AUTH_REQUIRED" });
    return null;
  }
  return user;
}

export async function resolveIsPro(user) {
  if (!user?.id) return { isPro: false, plan: "free", row: null };
  let row = await findEntitlementByUserId(user.id);
  if (!row && user.email) row = await findEntitlementByEmail(user.email);
  if (!row || !computeIsPro(row)) {
    return { isPro: false, plan: "free", row: row || null };
  }
  return {
    isPro: true,
    plan: row.plan || row.cycle || "yearly",
    expiresAt: row.expires_at || null,
    provider: row.provider || null,
    row,
  };
}

/** Auth + active Pro entitlement. */
export async function requirePro(req, res, { feature = null } = {}) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  const ent = await resolveIsPro(user);
  if (!ent.isPro) {
    res.status(403).json({
      error: feature
        ? `Pro required for ${feature}`
        : "Pro subscription required",
      code: "PRO_REQUIRED",
      is_pro: false,
      plan: "free",
    });
    return null;
  }
  return { user, ...ent };
}
