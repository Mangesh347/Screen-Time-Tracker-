// POST guest leaderboard score (service role)
import { sbFetch } from '../_lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const device_id = String(body.device_id || '').slice(0, 80);
    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    const row = {
      device_id,
      display_name: String(body.display_name || 'Guest').slice(0, 40),
      region: String(body.region || 'global').slice(0, 32),
      total_sec: Math.max(0, Math.min(86400 * 30, Number(body.total_sec) || 0)),
      focus_sec: Math.max(0, Math.min(86400 * 30, Number(body.focus_sec) || 0)),
      top_domain: body.top_domain ? String(body.top_domain).slice(0, 120) : null,
      top_domain_sec: Math.max(0, Number(body.top_domain_sec) || 0),
      updated_at: new Date().toISOString(),
    };

    const r = await sbFetch('/rest/v1/stt_guest_scores', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: row,
    });
    if (!r.ok && r.status !== 201 && r.status !== 200) {
      return res.status(502).json({ error: 'Upsert failed', detail: r.data });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
