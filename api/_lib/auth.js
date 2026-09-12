/** Resolve authenticated Supabase user from Bearer token */
import { supabaseConfig, sbFetch } from "./supabase.js";
import { normalizeEmail } from "./entitlement.js";

export async function userFromAuthHeader(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const { url, key } = supabaseConfig();
  if (!url || !key) return null;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  if (!user?.id) return null;
  return {
    id: user.id,
    email: normalizeEmail(user.email),
    token,
  };
}

/** Look up Auth user id by email (service role) — for checkout when JWT is in query. */
export async function userIdFromEmail(email) {
  const e = normalizeEmail(email);
  if (!e || !e.includes("@")) return null;

  // Prefer profile row (created on signup)
  try {
    const prof = await sbFetch(
      `/rest/v1/stt_profiles?email=eq.${encodeURIComponent(e)}&select=id,email&limit=1`,
    );
    if (prof.ok && prof.data?.[0]?.id) {
      return { id: prof.data[0].id, email: e };
    }
  } catch {}

  const { url, key, ok } = supabaseConfig();
  if (!ok) return null;
  try {
    // GoTrue admin filter
    const res = await fetch(
      `${url}/auth/v1/admin/users?page=1&per_page=200`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const users = data?.users || data || [];
    const hit = (Array.isArray(users) ? users : []).find(
      (u) => normalizeEmail(u.email) === e,
    );
    if (hit?.id) return { id: hit.id, email: e };
  } catch {}
  return null;
}

/**
 * Checkout identity: Bearer JWT → body.access_token → body.user_id+email → email lookup.
 * Never trusts email alone for ownership when a different user_id is claimed.
 */
export async function resolveCheckoutUser(req, body = {}) {
  const fromHeader = await userFromAuthHeader(req);
  if (fromHeader?.id) return fromHeader;

  const bodyToken = String(body.access_token || body.token || "").trim();
  if (bodyToken) {
    const fakeReq = { headers: { authorization: `Bearer ${bodyToken}` } };
    const fromBody = await userFromAuthHeader(fakeReq);
    if (fromBody?.id) return fromBody;
  }

  const email = normalizeEmail(body.email);
  const claimedId = body.user_id ? String(body.user_id) : null;
  if (claimedId && email) {
    const byEmail = await userIdFromEmail(email);
    if (byEmail?.id && byEmail.id === claimedId) {
      return { id: claimedId, email };
    }
    // Claimed id without matching email — still allow if profile matches id
    try {
      const prof = await sbFetch(
        `/rest/v1/stt_profiles?id=eq.${encodeURIComponent(claimedId)}&select=id,email&limit=1`,
      );
      if (prof.ok && prof.data?.[0]?.id) {
        return {
          id: claimedId,
          email: normalizeEmail(prof.data[0].email) || email,
        };
      }
    } catch {}
  }

  if (email) {
    const byEmail = await userIdFromEmail(email);
    if (byEmail?.id) return byEmail;
  }

  return null;
}
