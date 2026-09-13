/** Shared social helpers for STT API routes */
import { sbFetch } from "./supabase.js";

export function corsSocial(res, methods = "GET, POST, PATCH, DELETE, OPTIONS") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

export function userFacingError(raw, fallback = "Something went wrong. Try again.") {
  const m = String(raw || "");
  if (/sign in|unauthorized|401|jwt|session/i.test(m)) return "Sign in required";
  if (/duplicate|unique|conflict/i.test(m)) return "Already done";
  if (/not found|404|PGRST116/i.test(m)) return "Not found";
  if (/stt_post_views|views_count/i.test(m)) {
    return "Thought views need a database update. Run supabase/schema-post-views.sql then reload schema.";
  }
  if (/stt_posts|stt_messages|stt_friendships|schema cache|column|relation/i.test(m)) {
    return "Social features need a database update. Run supabase/schema-social-network.sql then reload schema.";
  }
  if (m.length && m.length < 120 && !/supabase|postgres|stack|at Object/i.test(m)) return m;
  return fallback;
}

export async function getProfile(id, select = "id,name,handle,picture,bio,is_private,is_public,followers_count,following_count,posts_count,public_score,total_browse_sec,public_top_sites") {
  const r = await sbFetch(
    `/rest/v1/stt_profiles?id=eq.${encodeURIComponent(id)}&select=${select}&limit=1`,
  );
  return r.ok && Array.isArray(r.data) ? r.data[0] : null;
}

export async function getFollowRelation(viewerId, targetId) {
  const [out, inn] = await Promise.all([
    sbFetch(
      `/rest/v1/stt_friendships?user_id=eq.${viewerId}&friend_id=eq.${targetId}&select=status&limit=1`,
    ),
    sbFetch(
      `/rest/v1/stt_friendships?user_id=eq.${targetId}&friend_id=eq.${viewerId}&select=status&limit=1`,
    ),
  ]);
  return {
    status: out.ok && out.data?.[0] ? out.data[0].status : null,
    incoming: inn.ok && inn.data?.[0] ? inn.data[0].status : null,
  };
}

/**
 * Messaging rules (Instagram-like):
 * - Self: never
 * - Public account: any signed-in user may message
 * - Private account: only if either direction has an accepted follow
 *   (you follow them, or they follow you — includes mutual)
 */
export function canMessage({ isSelf, isPrivate, outStatus, inStatus }) {
  if (isSelf) return { ok: false, reason: "self" };
  if (!isPrivate) return { ok: true, reason: "public" };
  if (outStatus === "accepted" || inStatus === "accepted") {
    return { ok: true, reason: outStatus === "accepted" && inStatus === "accepted" ? "mutual" : "follow" };
  }
  return { ok: false, reason: "private_no_follow" };
}

export async function refreshFollowCounts(userId) {
  const [followers, following] = await Promise.all([
    sbFetch(
      `/rest/v1/stt_friendships?friend_id=eq.${userId}&status=eq.accepted&select=user_id`,
    ),
    sbFetch(
      `/rest/v1/stt_friendships?user_id=eq.${userId}&status=eq.accepted&select=friend_id`,
    ),
  ]);
  const followers_count = Array.isArray(followers.data) ? followers.data.length : 0;
  const following_count = Array.isArray(following.data) ? following.data.length : 0;
  await sbFetch(`/rest/v1/stt_profiles?id=eq.${userId}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: {
      followers_count,
      following_count,
      updated_at: new Date().toISOString(),
    },
  });
  return { followers_count, following_count };
}

export async function refreshPostsCount(userId) {
  const r = await sbFetch(
    `/rest/v1/stt_posts?user_id=eq.${userId}&select=id`,
  );
  const n = Array.isArray(r.data) ? r.data.length : 0;
  await sbFetch(`/rest/v1/stt_profiles?id=eq.${userId}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { posts_count: n, updated_at: new Date().toISOString() },
  });
  return n;
}

/**
 * Live recount from friendships + posts (source of truth).
 * Patches stt_profiles when columns drift (fixes stale 0-stats).
 */
export async function reconcileProfileCounts(profile) {
  if (!profile?.id) return profile;
  const id = profile.id;
  const [followers, following, posts] = await Promise.all([
    sbFetch(
      `/rest/v1/stt_friendships?friend_id=eq.${id}&status=eq.accepted&select=user_id`,
    ),
    sbFetch(
      `/rest/v1/stt_friendships?user_id=eq.${id}&status=eq.accepted&select=friend_id`,
    ),
    sbFetch(`/rest/v1/stt_posts?user_id=eq.${id}&select=id`),
  ]);
  const followers_count = Array.isArray(followers.data) ? followers.data.length : Number(profile.followers_count) || 0;
  const following_count = Array.isArray(following.data) ? following.data.length : Number(profile.following_count) || 0;
  const posts_count = Array.isArray(posts.data) ? posts.data.length : Number(profile.posts_count) || 0;
  const drifted =
    Number(profile.followers_count) !== followers_count ||
    Number(profile.following_count) !== following_count ||
    Number(profile.posts_count) !== posts_count;
  if (drifted) {
    await sbFetch(`/rest/v1/stt_profiles?id=eq.${id}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        followers_count,
        following_count,
        posts_count,
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
  }
  return { ...profile, followers_count, following_count, posts_count };
}

export async function notify(userId, type, title, body, payload = {}) {
  await sbFetch("/rest/v1/stt_notifications", {
    method: "POST",
    prefer: "return=minimal",
    body: { user_id: userId, type, title, body, payload },
  }).catch(() => {});
}

export function parseBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body || "{}");
    } catch {
      return {};
    }
  }
  return req.body || {};
}
