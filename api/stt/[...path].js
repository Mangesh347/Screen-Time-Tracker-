/**
 * Catch-all STT router — one Vercel serverless function for all /api/stt/* routes.
 * Public URLs unchanged: /api/stt/social, /leaderboard, /access, etc.
 */
import social from "../_lib/handlers/stt-social.js";
import leaderboard from "../_lib/handlers/stt-leaderboard.js";
import migrateGuest from "../_lib/handlers/stt-migrate-guest.js";
import proCheck from "../_lib/handlers/stt-pro-check.js";
import deleteAccount from "../_lib/handlers/stt-delete-account.js";
import access from "../_lib/handlers/stt-access.js";
import guestScore from "../_lib/handlers/stt-guest-score.js";
import syncProfile from "../_lib/handlers/stt-sync-profile.js";

const ROUTES = {
  social,
  leaderboard,
  "migrate-guest": migrateGuest,
  "pro-check": proCheck,
  "delete-account": deleteAccount,
  access,
  "guest-score": guestScore,
  "sync-profile": syncProfile,
};

function routeKey(req) {
  const p = req.query?.path;
  if (Array.isArray(p) && p.length) return String(p[0] || "").toLowerCase();
  if (typeof p === "string" && p) return p.split("/")[0].toLowerCase();
  const url = String(req.url || "");
  const m = url.match(/\/api\/stt\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

export default async function handler(req, res) {
  const key = routeKey(req);
  const fn = ROUTES[key];
  if (!fn) {
    return res.status(404).json({
      error: "Unknown STT endpoint",
      path: key || null,
      available: Object.keys(ROUTES),
    });
  }
  return fn(req, res);
}
