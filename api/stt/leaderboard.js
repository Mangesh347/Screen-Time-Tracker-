/**
 * GET /api/stt/leaderboard
 * Query: limit, region=global|in|us|uk|eu|sea|other,
 *        domain=youtube.com (website scope),
 *        period=today|week|month|year
 *
 * Ranking:
 *  - Global / Region: period usage (usage_*_sec or period_stats or usage_days rollup)
 *    then score then streak
 *  - Website (domain set): time on that domain from period_stats[period].sites
 *    or public_top_sites fallback — only members who used that site
 *
 * Never invent zero rows that hide real synced totals: period columns of 0
 * fall through to period_stats → total_browse_sec → stt_usage_days rebuild.
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

function normDomain(d) {
  return String(d || '').toLowerCase().replace(/^www\./, '').trim();
}

/** YYYY-MM-DD minus n calendar days (UTC noon avoids DST edges). */
function dayMinus(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

function daysAgoIso(n) {
  return dayMinus(new Date().toISOString().slice(0, 10), n - 1);
}

/**
 * Prefer real period usage — never treat explicit 0 as blocking a richer fallback.
 * Order: positive flat → period_stats.browse → total_browse_sec (legacy) → flat 0 → 0
 */
function periodBrowse(p, period) {
  const flat = {
    today: p.usage_today_sec,
    week: p.usage_week_sec,
    month: p.usage_month_sec,
    year: p.usage_year_sec,
  };
  const flatVal = flat[period];
  if (flatVal != null && Number(flatVal) > 0) return Number(flatVal);

  const ps = p?.period_stats;
  if (ps && typeof ps === 'object' && ps[period] && ps[period].browse != null) {
    const b = Number(ps[period].browse) || 0;
    if (b > 0) return b;
  }

  const total = Number(p.total_browse_sec) || 0;
  if (total > 0) {
    if (period === 'week') return total;
    if (period === 'today') return Math.min(total, Math.round(total / 7));
    if (period === 'month') return Math.round(total * (30 / 7));
    if (period === 'year') return Math.round(total * (365 / 7));
  }

  if (flatVal != null) return Math.max(0, Number(flatVal) || 0);
  if (ps?.[period]?.browse != null) return Math.max(0, Number(ps[period].browse) || 0);
  return 0;
}

function periodFocus(p, period) {
  const ps = p?.period_stats;
  if (ps?.[period]?.focus != null && Number(ps[period].focus) > 0) {
    return Number(ps[period].focus);
  }
  return Number(p.total_focus_sec) || 0;
}

function periodScore(p, period) {
  const ps = p?.period_stats;
  if (ps?.[period]?.score != null) return Number(ps[period].score) || 0;
  return Number(p.public_score) || 0;
}

/** Seconds on a specific domain for the period */
function siteSecForPeriod(p, domain, period) {
  const needle = normDomain(domain);
  const ps = p?.period_stats;
  if (ps && typeof ps === 'object' && Array.isArray(ps[period]?.sites)) {
    const hit = ps[period].sites.find(s => normDomain(s.domain) === needle);
    if (hit) return Number(hit.sec) || 0;
  }
  const sites = Array.isArray(p.public_top_sites) ? p.public_top_sites : [];
  const hit = sites.find(s => normDomain(s.domain) === needle);
  return hit ? Number(hit.sec) || 0 : 0;
}

function needsUsageRebuild(p) {
  const hasFlat =
    Number(p.usage_today_sec) > 0 ||
    Number(p.usage_week_sec) > 0 ||
    Number(p.usage_month_sec) > 0 ||
    Number(p.usage_year_sec) > 0;
  if (hasFlat) return false;
  const ps = p.period_stats;
  if (ps && typeof ps === 'object') {
    for (const k of ['today', 'week', 'month', 'year']) {
      if (Number(ps[k]?.browse) > 0) return false;
    }
  }
  if (Number(p.total_browse_sec) > 0) return false;
  return true;
}

/** Roll up stt_usage_days — anchor windows to each user's latest tracked day (local date keys). */
function rollupUsageDays(rows) {
  const byUser = new Map();

  for (const row of rows || []) {
    const uid = row?.user_id;
    if (!uid) continue;
    const day = String(row.day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    let list = byUser.get(uid);
    if (!list) {
      list = [];
      byUser.set(uid, list);
    }
    list.push({
      day,
      total: Number(row.total_sec) || 0,
      focus: Number(row.focus_sec) || 0,
      score: Number(row.score) || 0,
      sites: Array.isArray(row.top_sites) ? row.top_sites : [],
    });
  }

  const out = new Map();
  for (const [uid, list] of byUser) {
    list.sort((a, b) => b.day.localeCompare(a.day));
    const anchor = list[0].day;
    const starts = {
      today: anchor,
      week: dayMinus(anchor, 6),
      month: dayMinus(anchor, 29),
      year: dayMinus(anchor, 364),
    };
    const wins = {
      today: { browse: 0, focus: 0, sites: new Map() },
      week: { browse: 0, focus: 0, sites: new Map() },
      month: { browse: 0, focus: 0, sites: new Map() },
      year: { browse: 0, focus: 0, sites: new Map() },
    };
    const lastScore = list[0].score || 0;

    const apply = (win, row) => {
      win.browse += row.total;
      win.focus += row.focus;
      for (const s of row.sites) {
        const dom = normDomain(s.domain);
        if (!dom) continue;
        const prev = win.sites.get(dom) || { domain: dom, sec: 0, category: s.category || 'other' };
        prev.sec += Number(s.sec) || 0;
        prev.category = s.category || prev.category;
        win.sites.set(dom, prev);
      }
    };

    for (const row of list) {
      if (row.day >= starts.year) apply(wins.year, row);
      if (row.day >= starts.month) apply(wins.month, row);
      if (row.day >= starts.week) apply(wins.week, row);
      if (row.day === anchor) apply(wins.today, row);
    }

    const toWin = (w) => ({
      browse: w.browse,
      focus: w.focus,
      score: lastScore || 0,
      streak: 0,
      sites: [...w.sites.values()].sort((a, b) => b.sec - a.sec).slice(0, 12),
    });
    const period_stats = {
      today: toWin(wins.today),
      week: toWin(wins.week),
      month: toWin(wins.month),
      year: toWin(wins.year),
    };
    out.set(uid, {
      usage_today_sec: period_stats.today.browse,
      usage_week_sec: period_stats.week.browse,
      usage_month_sec: period_stats.month.browse,
      usage_year_sec: period_stats.year.browse,
      total_browse_sec: period_stats.week.browse,
      total_focus_sec: period_stats.week.focus,
      public_score: lastScore || 0,
      public_top_sites: period_stats.week.sites,
      period_stats,
      _from_usage_days: true,
    });
  }
  return out;
}

async function fetchUsageDayRollups() {
  const since = daysAgoIso(365);
  const path =
    `/rest/v1/stt_usage_days?select=user_id,day,total_sec,focus_sec,score,top_sites` +
    `&day=gte.${since}&order=day.desc&limit=20000`;
  const r = await sbFetch(path);
  if (!r.ok || !Array.isArray(r.data)) return new Map();
  return rollupUsageDays(r.data);
}

/** Optional: pull screentime blobs for users still empty after usage_days */
async function fetchSyncRollups(userIds) {
  if (!userIds.length) return new Map();
  const ids = userIds.slice(0, 80).map(id => `"${id}"`).join(',');
  const path = `/rest/v1/stt_sync?select=user_id,screentime,streaks,daily&user_id=in.(${ids})`;
  const r = await sbFetch(path);
  if (!r.ok || !Array.isArray(r.data)) return new Map();

  const out = new Map();
  for (const row of r.data) {
    const st = row.screentime && typeof row.screentime === 'object' ? row.screentime : null;
    if (!st) continue;
    const dayKeys = Object.keys(st).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    if (!dayKeys.length) continue;
    const anchor = dayKeys[dayKeys.length - 1];
    const starts = {
      today: anchor,
      week: dayMinus(anchor, 6),
      month: dayMinus(anchor, 29),
      year: dayMinus(anchor, 364),
    };
    const period_stats = {};
    let weekBrowse = 0;
    let weekFocus = 0;
    let todayScore = Number(row.daily?.score) || 0;
    let weekSites = [];

    for (const [key, start] of Object.entries(starts)) {
      let browse = 0;
      let focus = 0;
      const siteMap = new Map();
      for (const dk of dayKeys) {
        if (dk < start || dk > anchor) continue;
        if (key === 'today' && dk !== anchor) continue;
        const dayObj = st[dk] || {};
        for (const [domain, e] of Object.entries(dayObj)) {
          const sec = Number(e?.totalTime) || 0;
          if (sec <= 0) continue;
          browse += sec;
          if (['productivity', 'coding', 'education'].includes(e?.category)) focus += sec;
          const prev = siteMap.get(domain) || { domain, sec: 0, category: e?.category || 'other' };
          prev.sec += sec;
          siteMap.set(domain, prev);
        }
      }
      const sites = [...siteMap.values()].sort((a, b) => b.sec - a.sec).slice(0, 12);
      period_stats[key] = { browse, focus, score: todayScore, streak: 0, sites };
      if (key === 'week') {
        weekBrowse = browse;
        weekFocus = focus;
        weekSites = sites;
      }
    }

    if (weekBrowse <= 0 && Number(period_stats.year?.browse) <= 0) continue;

    const streakDays = Number(row.streaks?.current) || 0;
    out.set(row.user_id, {
      usage_today_sec: period_stats.today.browse,
      usage_week_sec: period_stats.week.browse,
      usage_month_sec: period_stats.month.browse,
      usage_year_sec: period_stats.year.browse,
      total_browse_sec: weekBrowse,
      total_focus_sec: weekFocus,
      public_score: todayScore,
      public_top_sites: weekSites,
      period_stats,
      streak_days: streakDays,
      _from_sync: true,
    });
  }
  return out;
}

function mergeStats(base, overlay) {
  if (!overlay) return base;
  return {
    ...base,
    usage_today_sec: Number(overlay.usage_today_sec) || Number(base.usage_today_sec) || 0,
    usage_week_sec: Number(overlay.usage_week_sec) || Number(base.usage_week_sec) || 0,
    usage_month_sec: Number(overlay.usage_month_sec) || Number(base.usage_month_sec) || 0,
    usage_year_sec: Number(overlay.usage_year_sec) || Number(base.usage_year_sec) || 0,
    total_browse_sec: Number(overlay.total_browse_sec) || Number(base.total_browse_sec) || 0,
    total_focus_sec: Number(overlay.total_focus_sec) || Number(base.total_focus_sec) || 0,
    public_score: Number(overlay.public_score) || Number(base.public_score) || 0,
    public_top_sites: (Array.isArray(overlay.public_top_sites) && overlay.public_top_sites.length)
      ? overlay.public_top_sites
      : (base.public_top_sites || []),
    period_stats: overlay.period_stats || base.period_stats || null,
    streak_days: Number(overlay.streak_days) || Number(base.streak_days) || 0,
  };
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

    const selectFull =
      'id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,streak_days,period_stats,usage_today_sec,usage_week_sec,usage_month_sec,usage_year_sec,last_active_at';
    const attempts = [
      `/rest/v1/stt_profiles?select=${selectFull}&order=usage_week_sec.desc.nullslast&limit=${limit}`,
      `/rest/v1/stt_profiles?select=id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,streak_days,period_stats,last_active_at&order=total_browse_sec.desc.nullslast&limit=${limit}`,
      `/rest/v1/stt_profiles?select=id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,last_active_at&order=public_score.desc.nullslast,total_browse_sec.desc.nullslast&limit=${limit}`,
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

    // Rebuild missing aggregates from daily usage (and sync blobs as last resort)
    let usageRollups = new Map();
    try {
      usageRollups = await fetchUsageDayRollups();
    } catch (e) {
      console.warn('[stt/leaderboard] usage_days rollup', e);
    }

    const byId = new Map();
    for (const p of profiles) {
      if (!p?.id) continue;
      let row = { ...p };
      if (needsUsageRebuild(row) && usageRollups.has(row.id)) {
        row = mergeStats(row, usageRollups.get(row.id));
      }
      byId.set(row.id, row);
    }

    // Auth directory: enrich names only — do NOT invent zero usage shells that look like real members
    const authUsers = await listAuthUsers(limit);
    const stillEmpty = [];
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
        if (needsUsageRebuild(existing)) stillEmpty.push(au.id);
      } else if (usageRollups.has(au.id)) {
        // Has usage days but no profile yet — still show on board with real numbers
        const rolled = usageRollups.get(au.id);
        byId.set(au.id, mergeStats({
          id: au.id,
          email: au.email,
          name: au.user_metadata?.full_name || au.user_metadata?.name || (au.email ? au.email.split('@')[0] : 'Member'),
          picture: au.user_metadata?.avatar_url || null,
          handle: null,
          region: null,
          streak_days: 0,
        }, rolled));
      }
      // Skip auth-only accounts with no profile and no usage — not leaderboard members yet
    }

    // Last resort: stt_sync.screentime for still-empty profile rows
    const emptyIds = [...byId.values()].filter(needsUsageRebuild).map(p => p.id).concat(stillEmpty);
    if (emptyIds.length) {
      try {
        const syncRollups = await fetchSyncRollups([...new Set(emptyIds)]);
        for (const [uid, rolled] of syncRollups) {
          const existing = byId.get(uid);
          if (!existing) continue;
          if (needsUsageRebuild(existing)) {
            byId.set(uid, mergeStats(existing, rolled));
          }
        }
      } catch (e) {
        console.warn('[stt/leaderboard] sync rollup', e);
      }
    }

    let users = [...byId.values()];

    if (region && region !== 'global' && region !== 'sites') {
      users = users.filter(u => u.region && String(u.region).toLowerCase() === region);
    }

    if (domain) {
      users = users
        .map(p => {
          const site_sec = siteSecForPeriod(p, domain, period);
          if (site_sec <= 0) return null;
          return {
            ...p,
            site_sec,
            site_domain: domain,
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
      users = users.map(p => ({
        ...p,
        _period_browse: periodBrowse(p, period),
        _period_focus: periodFocus(p, period),
        _period_score: periodScore(p, period),
      }));
      users.sort((a, b) => {
        const bt = Number(b._period_browse) || 0;
        const at = Number(a._period_browse) || 0;
        if (bt !== at) return bt - at;
        const bs = Number(b._period_score) || Number(b.public_score) || 0;
        const as = Number(a._period_score) || Number(a.public_score) || 0;
        if (bs !== as) return bs - as;
        return (Number(b.streak_days) || 0) - (Number(a.streak_days) || 0);
      });
    }

    if (lastErr) console.warn('[stt/leaderboard] select warning', lastErr);

    return res.status(200).json({
      users: users.slice(0, limit),
      guests: [],
      region,
      domain: domain || null,
      period,
      count: users.length,
      ranking: domain
        ? `time_on_${domain}`
        : region !== 'global'
          ? `total_tracked_time_${region}`
          : 'total_tracked_time_global',
      source: 'supabase-service-role',
    });
  } catch (e) {
    console.error('[stt/leaderboard]', e);
    return res.status(500).json({ error: 'Leaderboard temporarily unavailable', users: [] });
  }
}
