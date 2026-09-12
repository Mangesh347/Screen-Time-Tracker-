/**
 * GET /api/stt/leaderboard
 * Query: limit, region=global|in|us|uk|eu|sea|other,
 *        domain=youtube.com (website scope),
 *        period=today|week|month|year
 *
 * Real Supabase stats only:
 *  - Sanitize corrupt usage (rejects fake multi-year hour totals)
 *  - Hide zero shells (File Forge–style empty profiles)
 *  - Dedupe by user id / email
 */
import { sbFetch, supabaseConfig } from '../_lib/supabase.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function normDomain(d) {
  return String(d || '').toLowerCase().replace(/^www\./, '').trim();
}

const PERIOD_MAX_SEC = {
  today: 24 * 3600,
  week: 7 * 24 * 3600,
  month: 31 * 24 * 3600,
  year: 366 * 24 * 3600,
};

/** Reject ms-as-sec / runaway counters that become "496977h" on the board. */
function sanitizeSec(raw, period = 'week') {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const max = PERIOD_MAX_SEC[period] || PERIOD_MAX_SEC.week;
  if (n > max * 2 && n / 1000 <= max * 1.5) n = Math.round(n / 1000);
  if (n > max * 1.25) return 0;
  return Math.round(n);
}

function sanitizeSites(sites, period = 'week') {
  if (!Array.isArray(sites)) return [];
  return sites
    .map((s) => {
      const sec = sanitizeSec(s?.sec, period);
      if (sec <= 0 || !s?.domain) return null;
      return { ...s, domain: normDomain(s.domain), sec };
    })
    .filter(Boolean)
    .sort((a, b) => b.sec - a.sec)
    .slice(0, 12);
}

function periodBrowse(p, period) {
  const flat = {
    today: p.usage_today_sec,
    week: p.usage_week_sec,
    month: p.usage_month_sec,
    year: p.usage_year_sec,
  };
  const flatVal = sanitizeSec(flat[period], period);
  if (flatVal > 0) return flatVal;

  const ps = p?.period_stats;
  if (ps && typeof ps === 'object' && ps[period]?.browse != null) {
    const b = sanitizeSec(ps[period].browse, period);
    if (b > 0) return b;
  }

  // Legacy total only for today/week — never scale into fake month/year hours
  const total = sanitizeSec(p.total_browse_sec, period === 'today' ? 'today' : 'week');
  if (total > 0 && (period === 'week' || period === 'today')) {
    return period === 'today' ? Math.min(total, PERIOD_MAX_SEC.today) : total;
  }
  return 0;
}

function periodFocus(p, period) {
  const ps = p?.period_stats;
  if (ps?.[period]?.focus != null) return sanitizeSec(ps[period].focus, period);
  return sanitizeSec(p.total_focus_sec, period);
}

function periodScore(p, period) {
  const ps = p?.period_stats;
  if (ps?.[period]?.score != null) return Math.min(100, Math.max(0, Number(ps[period].score) || 0));
  return Math.min(100, Math.max(0, Number(p.public_score) || 0));
}

function siteSecForPeriod(p, domain, period) {
  const needle = normDomain(domain);
  const ps = p?.period_stats;
  if (ps && typeof ps === 'object' && Array.isArray(ps[period]?.sites)) {
    const hit = ps[period].sites.find((s) => normDomain(s.domain) === needle);
    if (hit) return sanitizeSec(hit.sec, period);
  }
  const sites = Array.isArray(p.public_top_sites) ? p.public_top_sites : [];
  const hit = sites.find((s) => normDomain(s.domain) === needle);
  return hit ? sanitizeSec(hit.sec, period) : 0;
}

function hasRealUsage(p) {
  for (const per of ['today', 'week', 'month', 'year']) {
    if (periodBrowse(p, per) > 0) return true;
  }
  return false;
}

function dedupeProfiles(list) {
  const byId = new Map();
  for (const p of list || []) {
    if (!p?.id) continue;
    const prev = byId.get(p.id);
    if (!prev) {
      byId.set(p.id, p);
      continue;
    }
    const a = periodBrowse(prev, 'week') + periodBrowse(prev, 'today');
    const b = periodBrowse(p, 'week') + periodBrowse(p, 'today');
    if (b > a) byId.set(p.id, p);
  }
  const byEmail = new Map();
  const noEmail = [];
  for (const p of byId.values()) {
    const email = String(p.email || '').trim().toLowerCase();
    if (!email) {
      noEmail.push(p);
      continue;
    }
    const prev = byEmail.get(email);
    if (!prev) {
      byEmail.set(email, p);
      continue;
    }
    const a = periodBrowse(prev, 'week') + (Number(prev.public_score) || 0);
    const b = periodBrowse(p, 'week') + (Number(p.public_score) || 0);
    const newer = String(p.last_active_at || '') > String(prev.last_active_at || '');
    if (b > a || (b === a && newer)) byEmail.set(email, p);
  }
  return [...byEmail.values(), ...noEmail];
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ok: cfgOk } = supabaseConfig();
    if (!cfgOk) {
      console.error('[stt/leaderboard] missing service role');
      return res.status(500).json({ error: 'Leaderboard temporarily unavailable', users: [] });
    }

    const limit = Math.min(200, Math.max(5, Number(req.query?.limit) || 100));
    const region = String(req.query?.region || 'global').toLowerCase();
    const domain = normDomain(req.query?.domain || '');
    const periodRaw = String(req.query?.period || 'week').toLowerCase();
    const period = ['today', 'week', 'month', 'year'].includes(periodRaw) ? periodRaw : 'week';

    const orderCol = {
      today: 'usage_today_sec',
      week: 'usage_week_sec',
      month: 'usage_month_sec',
      year: 'usage_year_sec',
    }[period] || 'usage_week_sec';

    const selectFull =
      'id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,streak_days,period_stats,usage_today_sec,usage_week_sec,usage_month_sec,usage_year_sec,last_active_at';
    const attempts = [
      `/rest/v1/stt_profiles?select=${selectFull}&order=${orderCol}.desc.nullslast&limit=${limit}`,
      `/rest/v1/stt_profiles?select=id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,streak_days,period_stats,last_active_at&order=total_browse_sec.desc.nullslast&limit=${limit}`,
      `/rest/v1/stt_profiles?select=id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,last_active_at&order=public_score.desc.nullslast,total_browse_sec.desc.nullslast&limit=${limit}`,
      `/rest/v1/stt_profiles?select=id,name,picture,email,total_browse_sec,total_focus_sec&order=total_browse_sec.desc.nullslast&limit=${limit}`,
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

    let users = dedupeProfiles(Array.isArray(profiles) ? profiles : []);

    if (region && region !== 'global' && region !== 'sites') {
      users = users.filter((u) => u.region && String(u.region).toLowerCase() === region);
    }

    if (domain) {
      users = users
        .map((p) => {
          const site_sec = siteSecForPeriod(p, domain, period);
          if (site_sec <= 0) return null;
          return {
            ...p,
            site_sec,
            site_domain: domain,
            public_top_sites: sanitizeSites(p.public_top_sites, period),
            _period_browse: periodBrowse(p, period),
            _period_focus: periodFocus(p, period),
            _period_score: periodScore(p, period),
          };
        })
        .filter(Boolean)
        .sort((a, b) => {
          if ((b.site_sec || 0) !== (a.site_sec || 0)) return (b.site_sec || 0) - (a.site_sec || 0);
          return (Number(b.public_score) || 0) - (Number(a.public_score) || 0);
        });
    } else {
      users = users
        .filter((u) => u?.id && (u.name || u.email || u.handle) && hasRealUsage(u))
        .map((p) => {
          const browse = periodBrowse(p, period);
          const top = sanitizeSites(
            (p.period_stats && p.period_stats[period]?.sites) || p.public_top_sites,
            period
          );
          return {
            ...p,
            public_top_sites: top,
            _period_browse: browse,
            _period_focus: periodFocus(p, period),
            _period_score: periodScore(p, period),
          };
        })
        .filter((u) => Number(u._period_browse) > 0 || hasRealUsage(u));
      users.sort((a, b) => {
        const bt = Number(b._period_browse) || 0;
        const at = Number(a._period_browse) || 0;
        if (bt !== at) return bt - at;
        const bs = Number(b._period_score) || Number(b.public_score) || 0;
        const as = Number(a._period_score) || Number(a.public_score) || 0;
        if (bs !== as) return bs - as;
        return (Number(b.streak_days) || 0) - (Number(a.streak_days) || 0);
      });
      // For the selected period, prefer rows that actually have time (corrupt→0 drop out of top)
      users = users.filter((u) => Number(u._period_browse) > 0);
    }

    if (lastErr) console.warn('[stt/leaderboard] select warning', lastErr);

    return res.status(200).json({
      users: users.slice(0, limit),
      guests: [],
      region,
      domain: domain || null,
      period,
      count: Math.min(users.length, limit),
      ranking: domain
        ? `time_on_${domain}`
        : region !== 'global'
          ? `total_tracked_time_${region}`
          : 'total_tracked_time_global',
      source: 'supabase-service-role',
      real_usage_only: true,
    });
  } catch (e) {
    console.error('[stt/leaderboard]', e);
    return res.status(500).json({ error: 'Leaderboard temporarily unavailable', users: [] });
  }
}
