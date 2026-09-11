/**
 * GET /api/stt/leaderboard
 * Lists ALL signed-up members for the leaderboard (service role — bypasses RLS).
 * Optional: merges Auth users so every login appears even before first sync.
 */
import { sbFetch, supabaseConfig } from '../_lib/supabase.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

async function listAuthUsers(limit = 200) {
  const { url, key, ok } = supabaseConfig();
  if (!ok) return [];
  try {
    const res = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=${Math.min(200, limit)}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const users = data?.users || data || [];
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ok: cfgOk } = supabaseConfig();
    if (!cfgOk) {
      return res.status(500).json({
        error: 'SUPABASE_SERVICE_ROLE_KEY missing on Vercel',
        users: [],
        hint: 'Add SUPABASE_SERVICE_ROLE_KEY in Vercel env, redeploy',
      });
    }

    const limit = Math.min(200, Math.max(5, Number(req.query?.limit) || 100));
    const region = String(req.query?.region || 'global').toLowerCase();
    const domain = String(req.query?.domain || '').toLowerCase().replace(/^www\./, '');

    const attempts = [
      `/rest/v1/stt_profiles?select=id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,last_active_at&order=public_score.desc.nullslast,total_browse_sec.desc.nullslast&limit=${limit}`,
      `/rest/v1/stt_profiles?select=id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score&order=total_browse_sec.desc.nullslast&limit=${limit}`,
      `/rest/v1/stt_profiles?select=id,name,picture,email&limit=${limit}`,
    ];

    let profiles = [];
    let lastErr = null;
    for (const path of attempts) {
      const r = await sbFetch(path);
      if (r.ok && Array.isArray(r.data)) {
        profiles = r.data;
        break;
      }
      lastErr = r.data?.message || r.data?.error || `HTTP ${r.status}`;
    }

    // Merge every Auth login so users appear even with empty profile rows
    const authUsers = await listAuthUsers(limit);
    const byId = new Map();
    for (const p of profiles) {
      if (p?.id) byId.set(p.id, p);
    }
    for (const au of authUsers) {
      if (!au?.id) continue;
      const existing = byId.get(au.id);
      if (existing) {
        byId.set(au.id, {
          ...existing,
          email: existing.email || au.email,
          name: existing.name || au.user_metadata?.full_name || au.user_metadata?.name || (au.email ? au.email.split('@')[0] : 'Member'),
          picture: existing.picture || au.user_metadata?.avatar_url || null,
        });
      } else {
        byId.set(au.id, {
          id: au.id,
          email: au.email,
          name: au.user_metadata?.full_name || au.user_metadata?.name || (au.email ? au.email.split('@')[0] : 'Member'),
          picture: au.user_metadata?.avatar_url || null,
          handle: null,
          region: null,
          total_browse_sec: 0,
          total_focus_sec: 0,
          public_score: 0,
          public_top_sites: [],
        });
      }
    }

    let users = [...byId.values()];

    if (region && region !== 'global' && region !== 'sites') {
      users = users.filter(u => u.region && String(u.region).toLowerCase() === region);
    }

    if (domain) {
      users = users
        .map(p => {
          const sites = Array.isArray(p.public_top_sites) ? p.public_top_sites : [];
          const hit = sites.find(s => String(s.domain || '').toLowerCase().replace(/^www\./, '') === domain);
          if (!hit) return null;
          return { ...p, site_sec: Number(hit.sec) || 0, site_category: hit.category || 'other' };
        })
        .filter(Boolean)
        .sort((a, b) => b.site_sec - a.site_sec);
    } else {
      users.sort((a, b) => {
        const as = Number(a.public_score) || 0;
        const bs = Number(b.public_score) || 0;
        if (bs !== as) return bs - as;
        return (Number(b.total_browse_sec) || 0) - (Number(a.total_browse_sec) || 0);
      });
    }

    return res.status(200).json({
      users: users.slice(0, limit),
      guests: [],
      region,
      domain: domain || null,
      count: users.length,
      source: 'supabase-service-role',
      warning: profiles.length === 0 && lastErr ? lastErr : null,
    });
  } catch (e) {
    console.error('[stt/leaderboard]', e);
    return res.status(500).json({ error: e.message || 'Server error', users: [] });
  }
}
