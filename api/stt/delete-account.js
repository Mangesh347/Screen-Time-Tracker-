/**
 * POST /api/stt/delete-account
 * Authenticated soft-delete of product data bound to the user.
 * Does not destroy Auth user by default (Supabase dashboard / Auth admin).
 * Cloud is source of truth until this runs — logout alone never deletes.
 */
import { sbFetch, supabaseConfig } from "../_lib/supabase.js";
import { requireAuth } from "../_lib/gates.js";
import { rateLimit, clientKey } from "../_lib/rate-limit.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

const TABLES = [
  { path: (id) => `/rest/v1/stt_post_comments?user_id=eq.${id}`, label: "comments" },
  { path: (id) => `/rest/v1/stt_post_likes?user_id=eq.${id}`, label: "likes" },
  { path: (id) => `/rest/v1/stt_post_views?user_id=eq.${id}`, label: "views" },
  { path: (id) => `/rest/v1/stt_posts?user_id=eq.${id}`, label: "posts" },
  { path: (id) => `/rest/v1/stt_messages?or=(sender_id.eq.${id},recipient_id.eq.${id})`, label: "messages" },
  { path: (id) => `/rest/v1/stt_notifications?or=(user_id.eq.${id},actor_id.eq.${id})`, label: "notifications" },
  { path: (id) => `/rest/v1/stt_friendships?or=(user_id.eq.${id},friend_id.eq.${id})`, label: "friendships" },
  { path: (id) => `/rest/v1/stt_usage_days?user_id=eq.${id}`, label: "usage_days" },
  { path: (id) => `/rest/v1/stt_sync?user_id=eq.${id}`, label: "sync" },
];

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const rl = rateLimit(clientKey(req, "delete-account"), { limit: 5, windowMs: 60_000 });
  if (!rl.ok) return res.status(429).json({ error: "Too many requests" });

  try {
    const { ok: cfgOk } = supabaseConfig();
    if (!cfgOk) return res.status(503).json({ error: "Temporarily unavailable" });

    const user = await requireAuth(req, res);
    if (!user) return;

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    if (body.confirm !== true && body.confirm !== "DELETE") {
      return res.status(400).json({
        error: 'Pass { "confirm": true } to permanently delete product data for this account.',
      });
    }

    const id = encodeURIComponent(user.id);
    const results = {};

    for (const t of TABLES) {
      const r = await sbFetch(t.path(id), { method: "DELETE" }).catch((e) => ({
        ok: false,
        error: String(e?.message || e),
      }));
      results[t.label] = r?.ok !== false;
    }

    // Demote entitlement (keep payment audit rows)
    await sbFetch(`/rest/v1/stt_entitlements?user_id=eq.${id}`, {
      method: "PATCH",
      body: {
        plan: "free",
        cycle: "free",
        status: "deleted",
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});

    // Anonymize profile rather than hard-delete (FK safety)
    await sbFetch(`/rest/v1/stt_profiles?id=eq.${id}`, {
      method: "PATCH",
      body: {
        name: "Deleted user",
        handle: `deleted_${user.id.slice(0, 8)}`,
        email: null,
        picture: null,
        bio: null,
        is_private: true,
        is_public: false,
        public_top_sites: [],
        period_stats: {},
        total_browse_sec: 0,
        total_focus_sec: 0,
        public_score: 0,
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});

    return res.status(200).json({
      ok: true,
      message: "Account product data deleted. Sign out on all devices. Auth user may remain until removed in Supabase Auth.",
      results,
    });
  } catch (err) {
    console.error("[stt/delete-account]", err);
    return res.status(500).json({ error: "Delete failed" });
  }
}
