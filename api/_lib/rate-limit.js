/**
 * Lightweight in-memory rate limit for Vercel serverless.
 * Best-effort (per-instance); slows abuse, not a hard global quota.
 */

const buckets = new Map();
const MAX_KEYS = 5000;

function prune(now) {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, v] of buckets) {
    if (now > v.reset) buckets.delete(k);
  }
  if (buckets.size >= MAX_KEYS) {
    const first = buckets.keys().next().value;
    if (first != null) buckets.delete(first);
  }
}

/**
 * @returns {{ ok: true } | { ok: false, retryAfter: number }}
 */
export function rateLimit(key, { limit = 60, windowMs = 60_000 } = {}) {
  const now = Date.now();
  prune(now);
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
  }
  return { ok: true };
}

export function clientKey(req, suffix = "") {
  const xf = req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || "";
  const ip = String(xf).split(",")[0].trim() || "unknown";
  return suffix ? `${ip}:${suffix}` : ip;
}
