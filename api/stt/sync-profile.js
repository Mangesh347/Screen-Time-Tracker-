/**
 * POST /api/stt/sync-profile
 * Upserts the signed-in user's leaderboard profile via service role.
 *
 * Body may include:
 *   name, picture, handle, region, country,
 *   total_browse_sec, total_focus_sec, public_score, streak_days, streak_best,
 *   usage_today_sec, usage_week_sec, usage_month_sec, usage_year_sec,
 *   period_stats, public_top_sites, streaks
 *
 * Fallbacks drop columns gradually — never wipe usage/score on a single unknown-column error.
 */
import { sbFetch, supabaseConfig } from '../_lib/supabase.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

async function userFromToken(token) {
  const { url, key } = supabaseConfig();
  if (!url || !key || !token) return null;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

function stripUndefined(obj) {
  const out = { ...obj };
  Object.keys(out).forEach(k => {
    if (out[k] === undefined) delete out[k];
  });
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ok: cfgOk } = supabaseConfig();
    if (!cfgOk) {
      return res.status(500).json({ error: 'Profile sync temporarily unavailable' });
    }

    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    const token = auth.slice(7).trim();
    const u = await userFromToken(token);
    if (!u?.id) return res.status(401).json({ error: 'Invalid session' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const name =
      body.name ||
      u.user_metadata?.full_name ||
      u.user_metadata?.name ||
      (u.email ? String(u.email).split('@')[0] : 'Member');
    const picture = body.picture || u.user_metadata?.avatar_url || u.user_metadata?.picture || null;
    const handle =
      body.handle ||
      String(name).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) ||
      `u${u.id.slice(0, 6)}`;

    const regionVal = body.region || body.country || undefined;
    const countryVal = body.country || body.region || undefined;

    const row = stripUndefined({
      id: u.id,
      email: u.email || null,
      name,
      picture,
      handle,
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
      region: regionVal,
      country: countryVal,
      total_browse_sec: body.total_browse_sec != null ? Number(body.total_browse_sec) || 0 : undefined,
      total_focus_sec: body.total_focus_sec != null ? Number(body.total_focus_sec) || 0 : undefined,
      public_score: body.public_score != null ? Number(body.public_score) || 0 : undefined,
      streak_days: body.streak_days != null ? Number(body.streak_days) || 0 : undefined,
      streak_best: body.streak_best != null ? Number(body.streak_best) || 0 : undefined,
      streaks: body.streaks && typeof body.streaks === 'object' ? body.streaks : undefined,
      usage_today_sec: body.usage_today_sec != null ? Number(body.usage_today_sec) || 0 : undefined,
      usage_week_sec: body.usage_week_sec != null ? Number(body.usage_week_sec) || 0 : undefined,
      usage_month_sec: body.usage_month_sec != null ? Number(body.usage_month_sec) || 0 : undefined,
      usage_year_sec: body.usage_year_sec != null ? Number(body.usage_year_sec) || 0 : undefined,
      period_stats: body.period_stats && typeof body.period_stats === 'object' ? body.period_stats : undefined,
      public_top_sites: Array.isArray(body.public_top_sites) ? body.public_top_sites.slice(0, 12) : undefined,
    });

    // Privacy only on first insert — never flip existing public/private from score sync
    const insertOnlyPrivacy = {
      is_private: true,
      is_public: false,
    };

    const attempts = [
      row,
      stripUndefined({ ...row, period_stats: undefined, streaks: undefined, country: undefined }),
      stripUndefined({
        ...row,
        period_stats: undefined,
        streaks: undefined,
        country: undefined,
        usage_today_sec: undefined,
        usage_week_sec: undefined,
        usage_month_sec: undefined,
        usage_year_sec: undefined,
      }),
      stripUndefined({
        id: row.id,
        email: row.email,
        name: row.name,
        picture: row.picture,
        handle: row.handle,
        total_browse_sec: row.total_browse_sec,
        total_focus_sec: row.total_focus_sec,
        public_score: row.public_score,
        public_top_sites: row.public_top_sites,
        streak_days: row.streak_days,
        region: row.region,
        updated_at: row.updated_at,
        last_active_at: row.last_active_at,
      }),
      stripUndefined({
        id: row.id,
        email: row.email,
        name: row.name,
        picture: row.picture,
        total_browse_sec: row.total_browse_sec,
        total_focus_sec: row.total_focus_sec,
        public_score: row.public_score,
        updated_at: row.updated_at,
      }),
    ];

    // Ensure row exists with private default if brand-new (ignore conflict)
    await sbFetch('/rest/v1/stt_profiles?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=ignore-duplicates,return=minimal',
      body: stripUndefined({
        id: u.id,
        email: u.email || null,
        name,
        picture,
        handle,
        ...insertOnlyPrivacy,
        updated_at: new Date().toISOString(),
      }),
    }).catch(() => {});

    let result = null;
    for (const payload of attempts) {
      result = await sbFetch('/rest/v1/stt_profiles?on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: payload,
      });
      if (result.ok) break;
    }

    if (!result?.ok) {
      console.error('[stt/sync-profile] upsert failed', result?.data);
      return res.status(500).json({ error: 'Could not sync profile right now' });
    }

    const profile = Array.isArray(result.data) ? result.data[0] : result.data;
    return res.status(200).json({ ok: true, profile });
  } catch (e) {
    console.error('[stt/sync-profile]', e);
    return res.status(500).json({ error: 'Could not sync profile right now' });
  }
}
