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
 * Create a lightweight Auth user for marketing-link checkout (?email= only).
 * Idempotent: if the email already exists, returns that user.
 */
export async function createCheckoutUserByEmail(email) {
  const e = normalizeEmail(email);
  if (!e || !e.includes("@")) return null;

  const existing = await userIdFromEmail(e);
  if (existing?.id) return existing;

  const { url, key, ok } = supabaseConfig();
  if (!ok) return null;

  try {
    const res = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: e,
        email_confirm: true,
        user_metadata: { source: "website_checkout" },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.id) {
      await sbFetch(`/rest/v1/stt_profiles?on_conflict=id`, {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          id: data.id,
          email: e,
          is_private: true,
          is_public: false,
          updated_at: new Date().toISOString(),
        },
      }).catch(() => {});
      return { id: data.id, email: e, created: true };
    }
    // Already registered — look up again
    if (res.status === 422 || String(data?.msg || data?.message || "").toLowerCase().includes("already")) {
      return userIdFromEmail(e);
    }
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

/**
 * Like resolveCheckoutUser, but for email-only marketing checkout creates a user when missing.
 * Prefer Bearer / user_id when present; never invent a user when a claimed user_id fails.
 */
export async function ensureCheckoutUser(req, body = {}) {
  const resolved = await resolveCheckoutUser(req, body);
  if (resolved?.id) return resolved;

  const email = normalizeEmail(body.email);
  const claimedId = body.user_id ? String(body.user_id) : null;
  // Do not create if they claimed a specific user_id that we couldn't verify
  if (claimedId) return null;
  if (!email || !email.includes("@")) return null;

  return createCheckoutUserByEmail(email);
}
