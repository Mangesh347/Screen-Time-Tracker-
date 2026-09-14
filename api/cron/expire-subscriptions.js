/**
 * GET|POST /api/cron/expire-subscriptions
 * Hourly: any non-lifetime Pro past expires_at → Free (no errors).
 * Auth: Authorization: Bearer CRON_SECRET  or  x-cron-secret
 * Vercel Cron sends Authorization: Bearer <CRON_SECRET> when env is set.
 */
import { demoteEntitlement } from "../_lib/entitlement.js";
import { sbFetch } from "../_lib/supabase.js";

function authorized(req) {
  const secret = process.env.CRON_SECRET || "";
  if (!secret) return false;
  const auth = req.headers.authorization || "";
  const header = req.headers["x-cron-secret"] || "";
  return header === secret || auth === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });

  const now = new Date().toISOString();
  const raw = await sbFetch(
    `/rest/v1/stt_entitlements?status=in.(active,paid)&plan=neq.lifetime&cycle=neq.lifetime&expires_at=not.is.null&expires_at=lte.${encodeURIComponent(now)}&select=id,user_id,email,plan,cycle,expires_at&limit=500`,
  );

  if (!raw.ok) {
    return res.status(500).json({ error: raw.data || "query failed", demoted: 0 });
  }

  const rows = Array.isArray(raw.data) ? raw.data : [];
  let demoted = 0;
  const errors = [];

  for (const row of rows) {
    if (row.plan === "lifetime" || row.cycle === "lifetime") continue;
    try {
      await demoteEntitlement({
        userId: row.user_id,
        email: row.email,
        reason: "expired",
      });
      demoted++;
    } catch (e) {
      errors.push({ id: row.id, error: e.message || String(e) });
    }
  }

  return res.status(200).json({
    ok: true,
    scanned: rows.length,
    demoted,
    errors: errors.length ? errors : undefined,
    at: now,
  });
}
