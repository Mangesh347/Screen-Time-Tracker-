/**
 * GET /api/stt/leaderboard
 * Query: limit, region|country=global|in|us|uk|eu|sea|other,
 *        domain=youtube.com (website scope),
 *        period=today|week|month|year
 *
 * Lists every public signed-up Auth / stt_profiles member in scope.
 * Real synced numbers when available; honest 0 until they browse.
 * Never invent fake brand shells (File Forge / Clixy).
 *
 * Ranking:
 *  - Global / Region: period usage â†’ score â†’ streak
 *  - Website: time on that domain (members who used it only)
 *
 * Period columns of 0 fall through to period_stats â†’ totals â†’
 * stt_usage_days rebuild â†’ stt_sync.screentime last resort.
 * sanitizeSec rejects ms-as-sec / runaway counters.
 */
import { sbFetch, supabaseConfig } from "../supabase.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

async function listAuthUsers(limit = 500) {
  const { url, key, ok } = supabaseConfig();
  if (!ok) return [];
  const out = [];
  const perPage = 200;
  const maxPages = Math.ceil(Math.min(1000, limit) / perPage);
  try {
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!res.ok) break;
      const data = await res.json();
      const users = data?.users || data || [];
      if (!Array.isArray(users) || !users.length) break;
      out.push(...users);
      if (users.length < perPage || out.length >= limit) break;
    }
  } catch {
    return out;
  }
  return out.slice(0, limit);
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
 * Prefer real period usage - never treat explicit 0 as blocking a richer fallback.
 * Order: positive flat â†’ period_stats.browse â†’ total_browse_sec (legacy week/today) â†’ flat 0
 */
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

  const total = sanitizeSec(p.total_browse_sec, period === 'today' ? 'today' : 'week');
  if (total > 0 && (period === 'week' || period === 'today')) {
    return period === 'today' ? Math.min(total, PERIOD_MAX_SEC.today) : total;
  }

  if (flat[period] != null) return sanitizeSec(flat[period], period);
  if (ps?.[period]?.browse != null) return sanitizeSec(ps[period].browse, period);
  return 0;
}

function periodFocus(p, period) {
  const ps = p?.period_stats;
  if (ps?.[period]?.focus != null) {
    const f = sanitizeSec(ps[period].focus, period);
    if (f > 0) return f;
  }
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

function needsUsageRebuild(p) {
  for (const per of ['today', 'week', 'month', 'year']) {
    if (periodBrowse(p, per) > 0) return false;
  }
  return true;
}

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

    const toWin = (w, per) => ({
      browse: sanitizeSec(w.browse, per),
      focus: sanitizeSec(w.focus, per),
      score: Math.min(100, lastScore || 0),
      streak: 0,
      sites: sanitizeSites([...w.sites.values()], per),
    });
    const period_stats = {
      today: toWin(wins.today, 'today'),
      week: toWin(wins.week, 'week'),
      month: toWin(wins.month, 'month'),
      year: toWin(wins.year, 'year'),
    };
    out.set(uid, {
      usage_today_sec: period_stats.today.browse,
      usage_week_sec: period_stats.week.browse,
      usage_month_sec: period_stats.month.browse,
      usage_year_sec: period_stats.year.browse,
      total_browse_sec: period_stats.week.browse,
      total_focus_sec: period_stats.week.focus,
      public_score: Math.min(100, lastScore || 0),
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

async function fetchSyncRollups(userIds) {
  if (!userIds.length) return new Map();
  const ids = userIds.slice(0, 80).map((id) => `"${id}"`).join(',');
  const path = `/rest/v1/stt_sync?select=user_id,screentime,streaks,daily&user_id=in.(${ids})`;
  const r = await sbFetch(path);
  if (!r.ok || !Array.isArray(r.data)) return new Map();

  const out = new Map();
  for (const row of r.data) {
    const st = row.screentime && typeof row.screentime === 'object' ? row.screentime : null;
    if (!st) continue;
    const dayKeys = Object.keys(st).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
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
    let todayScore = Math.min(100, Number(row.daily?.score) || 0);
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
      const sites = sanitizeSites([...siteMap.values()], key);
      period_stats[key] = {
        browse: sanitizeSec(browse, key),
        focus: sanitizeSec(focus, key),
        score: todayScore,
        streak: 0,
        sites,
      };
      if (key === 'week') {
        weekBrowse = period_stats.week.browse;
        weekFocus = period_stats.week.focus;
        weekSites = sites;
      }
    }

    if (weekBrowse <= 0 && Number(period_stats.year?.browse) <= 0) continue;

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
      streak_days: Number(row.streaks?.current) || 0,
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

function emptyMemberShell(au, displayName) {
  return {
    id: au.id,
    email: au.email || null,
    name: displayName,
    picture: au.user_metadata?.avatar_url || null,
    handle: null,
    region: null,
    streak_days: 0,
    usage_today_sec: 0,
    usage_week_sec: 0,
    usage_month_sec: 0,
    usage_year_sec: 0,
    total_browse_sec: 0,
    total_focus_sec: 0,
    public_score: 0,
    public_top_sites: [],
    is_public: true,
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
    const region = String(req.query?.region || req.query?.country || 'global').toLowerCase();
    const domain = normDomain(req.query?.domain || '');
    const periodRaw = String(req.query?.period || 'week').toLowerCase();
    const period = ['today', 'week', 'month', 'year'].includes(periodRaw) ? periodRaw : 'week';
    const fetchLimit = Math.max(limit, 200);

    const orderCol = {
      today: 'usage_today_sec',
      week: 'usage_week_sec',
      month: 'usage_month_sec',
      year: 'usage_year_sec',
    }[period] || 'usage_week_sec';

    const selectFull =
      'id,name,handle,picture,email,region,is_public,is_private,total_browse_sec,total_focus_sec,public_score,public_top_sites,streak_days,period_stats,usage_today_sec,usage_week_sec,usage_month_sec,usage_year_sec,last_active_at';
    const attempts = [
      `/rest/v1/stt_profiles?select=${selectFull}&order=${orderCol}.desc.nullslast&limit=${fetchLimit}`,
      `/rest/v1/stt_profiles?select=id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,streak_days,period_stats,last_active_at&order=total_browse_sec.desc.nullslast&limit=${fetchLimit}`,
      `/rest/v1/stt_profiles?select=id,name,handle,picture,email,region,total_browse_sec,total_focus_sec,public_score,public_top_sites,last_active_at&order=public_score.desc.nullslast,total_browse_sec.desc.nullslast&limit=${fetchLimit}`,
      `/rest/v1/stt_profiles?select=id,name,picture,email,region&limit=${fetchLimit}`,
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

    let usageRollups = new Map();
    try {
      usageRollups = await fetchUsageDayRollups();
    } catch (e) {
      console.warn('[stt/leaderboard] usage_days rollup', e);
    }

    const byId = new Map();
    for (const p of profiles) {
      if (!p?.id) continue;
      if (p.is_public === false || p.is_private === true) continue;
      let row = { ...p };
      if (needsUsageRebuild(row) && usageRollups.has(row.id)) {
        row = mergeStats(row, usageRollups.get(row.id));
      }
      byId.set(row.id, row);
    }

    // Every signed-up Auth user belongs on the board (real Auth identities only).
    const authUsers = await listAuthUsers(fetchLimit);
    const stillEmpty = [];
    const missingProfiles = [];
    for (const au of authUsers) {
      if (!au?.id) continue;
      const displayName =
        au.user_metadata?.full_name ||
        au.user_metadata?.name ||
        (au.email ? String(au.email).split('@')[0] : 'Member');
      const existing = byId.get(au.id);
      if (existing) {
        byId.set(au.id, {
          ...existing,
          email: existing.email || au.email,
          name: existing.name || displayName,
          picture: existing.picture || au.user_metadata?.avatar_url || null,
        });
        if (needsUsageRebuild(existing)) stillEmpty.push(au.id);
      } else if (usageRollups.has(au.id)) {
        byId.set(au.id, mergeStats(emptyMemberShell(au, displayName), usageRollups.get(au.id)));
      } else {
        byId.set(au.id, emptyMemberShell(au, displayName));
        missingProfiles.push({ au, displayName });
      }
    }

    if (missingProfiles.length) {
      try {
        await Promise.all(missingProfiles.slice(0, 50).map(({ au, displayName }) =>
          sbFetch('/rest/v1/stt_profiles?on_conflict=id', {
            method: 'POST',
            prefer: 'resolution=merge-duplicates,return=minimal',
            body: {
              id: au.id,
              email: au.email || null,
              name: displayName,
              picture: au.user_metadata?.avatar_url || null,
              is_public: true,
              updated_at: new Date().toISOString(),
              last_active_at: new Date().toISOString(),
            },
          })
        ));
      } catch (e) {
        console.warn('[stt/leaderboard] seed profiles', e);
      }
    }

    const emptyIds = [...byId.values()].filter(needsUsageRebuild).map((p) => p.id).concat(stillEmpty);
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

    let users = [...byId.values()].filter((u) => {
      if (!u?.id) return false;
      if (u.is_public === false || u.is_private === true) return false;
      return !!(u.name || u.email || u.handle);
    });

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
      users = users.map((p) => {
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
      });
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
      country: region === 'global' ? null : region,
      domain: domain || null,
      period,
      count: Math.min(users.length, limit),
      ranking: domain
        ? `time_on_${domain}`
        : region !== 'global'
          ? `total_tracked_time_${region}`
          : 'total_tracked_time_global',
      source: 'supabase-service-role',
      include_zero_members: !domain,
    });
  } catch (e) {
    console.error('[stt/leaderboard]', e);
    return res.status(500).json({ error: 'Leaderboard temporarily unavailable', users: [] });
  }
}
