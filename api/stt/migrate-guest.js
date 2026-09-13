/**
 * POST /api/stt/migrate-guest
 * Claim guest leaderboard score into the signed-in account (no duplicates).
 * Body: { device_id }
 */
import { sbFetch, supabaseConfig } from "../_lib/supabase.js";
import { requireAuth } from "../_lib/gates.js";
import { rateLimit, clientKey } from "../_lib/rate-limit.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const rl = rateLimit(clientKey(req, "migrate-guest"), { limit: 20, windowMs: 60_000 });
  if (!rl.ok) return res.status(429).json({ error: "Too many requests" });

  try {
    const { ok: cfgOk } = supabaseConfig();
    if (!cfgOk) return res.status(503).json({ error: "Temporarily unavailable" });

    const user = await requireAuth(req, res);
    if (!user) return;

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const deviceId = String(body.device_id || "").trim().slice(0, 80);
    if (!deviceId) return res.status(400).json({ error: "device_id required" });

    const guestRes = await sbFetch(
      `/rest/v1/stt_guest_scores?device_id=eq.${encodeURIComponent(deviceId)}&select=*&limit=1`,
    );
    const guest = guestRes.ok ? guestRes.data?.[0] : null;

    // Stamp profile so we never re-claim the same guest row
    await sbFetch(`/rest/v1/stt_profiles?id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      body: {
        guest_claimed_from: deviceId,
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});

    if (!guest) {
      return res.status(200).json({ ok: true, claimed: false, reason: "no_guest_row" });
    }

    // Merge guest totals into profile only when profile is weaker (never overwrite richer account data)
    const profRes = await sbFetch(
      `/rest/v1/stt_profiles?id=eq.${encodeURIComponent(user.id)}&select=id,total_browse_sec,total_focus_sec,public_score,usage_today_sec&limit=1`,
    );
    const prof = profRes.ok ? profRes.data?.[0] : null;
    if (prof) {
      const gBrowse = Number(guest.total_sec) || 0;
      const gFocus = Number(guest.focus_sec) || 0;
      const gScore = Number(guest.score) || 0;
      const patch = {
        updated_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      };
      if (gBrowse > (Number(prof.total_browse_sec) || 0)) patch.total_browse_sec = gBrowse;
      if (gFocus > (Number(prof.total_focus_sec) || 0)) patch.total_focus_sec = gFocus;
      if (gScore > (Number(prof.public_score) || 0)) patch.public_score = Math.min(100, gScore);
      if (Object.keys(patch).length > 2) {
        await sbFetch(`/rest/v1/stt_profiles?id=eq.${encodeURIComponent(user.id)}`, {
          method: "PATCH",
          body: patch,
        }).catch(() => {});
      }
    }

    // Remove guest row so leaderboard has one identity (account), not guest + user
    await sbFetch(
      `/rest/v1/stt_guest_scores?device_id=eq.${encodeURIComponent(deviceId)}`,
      { method: "DELETE" },
    ).catch(() => {});

    return res.status(200).json({
      ok: true,
      claimed: true,
      device_id: deviceId,
      merged_browse: Number(guest.total_sec) || 0,
    });
  } catch (err) {
    console.error("[stt/migrate-guest]", err);
    return res.status(500).json({ error: "Migration failed" });
  }
}
