/**
 * POST /api/stt/sync-profile
 * Upserts the signed-in user's leaderboard profile via service role
 * (works even when client RLS can't see other members).
 *
 * Headers: Authorization: Bearer <supabase access token>
 * Body: { name?, picture?, handle?, region?, total_browse_sec?, total_focus_sec?, public_score?, public_top_sites? }
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
  // Prefer user JWT validation
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ok: cfgOk } = supabaseConfig();
    if (!cfgOk) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY missing on Vercel' });
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

    const row = {
      id: u.id,
      email: u.email || null,
      name,
      picture,
      handle,
      is_public: true,
      updated_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
    };

    if (body.region) row.region = body.region;
    if (body.total_browse_sec != null) row.total_browse_sec = Number(body.total_browse_sec) || 0;
    if (body.total_focus_sec != null) row.total_focus_sec = Number(body.total_focus_sec) || 0;
    if (body.public_score != null) row.public_score = Number(body.public_score) || 0;
    if (Array.isArray(body.public_top_sites)) row.public_top_sites = body.public_top_sites.slice(0, 8);

    // Try full upsert; fall back to core columns if schema incomplete
    let result = await sbFetch('/rest/v1/stt_profiles?on_conflict=id', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: row,
    });

    if (!result.ok) {
      const core = {
        id: row.id,
        email: row.email,
        name: row.name,
        picture: row.picture,
        updated_at: row.updated_at,
      };
      result = await sbFetch('/rest/v1/stt_profiles?on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: core,
      });
    }

    if (!result.ok) {
      return res.status(500).json({
        error: result.data?.message || result.data?.error || 'Profile upsert failed',
        hint: 'Run supabase/fix-all-schema.sql in Supabase SQL Editor',
      });
    }

    const profile = Array.isArray(result.data) ? result.data[0] : result.data;
    return res.status(200).json({ ok: true, profile });
  } catch (e) {
    console.error('[stt/sync-profile]', e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
