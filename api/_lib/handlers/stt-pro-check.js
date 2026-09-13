/**
 * GET /api/stt/pro-check?feature=cloudSync
 * Server-side Pro gate probe for clients / future Pro APIs.
 */
import { requireAuth, resolveIsPro } from "../gates.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

const PRO_FEATURES = new Set([
  "cloudSync",
  "emailReports",
  "pdfReport",
  "hardLock",
  "nuclear",
  "history90",
  "cleanerDeep",
  "visualThemesAll",
  "messaging",
  "history30",
  "history90",
]);

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const user = await requireAuth(req, res);
  if (!user) return;

  const feature = String(req.query?.feature || "").trim();
  const ent = await resolveIsPro(user);

  if (feature && PRO_FEATURES.has(feature) && !ent.isPro) {
    return res.status(403).json({
      ok: false,
      code: "PRO_REQUIRED",
      feature,
      is_pro: false,
      plan: "free",
    });
  }

  return res.status(200).json({
    ok: true,
    is_pro: ent.isPro,
    plan: ent.plan,
    expires_at: ent.expiresAt || null,
    provider: ent.provider || null,
    feature: feature || null,
    allowed: !feature || !PRO_FEATURES.has(feature) || ent.isPro,
  });
}
