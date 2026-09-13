/**
 * POST/GET /api/stt/social
 * Auth-validated social network API (service role + JWT user).
 *
 * POST body: { action, ... }
 * Actions:
 *   follow | unfollow | accept_follow | reject_follow
 *   create_post | update_post | delete_post | like_post | unlike_post | comment_post
 *   view_post
 *   send_message | mark_messages_read
 *   update_privacy | update_profile
 *
 * GET ?action=
 *   feed | profile | requests | followers | following | thread | inbox | comments | can_message
 */
import { supabaseConfig, sbFetch } from "../supabase.js";
import { userFromAuthHeader } from "../auth.js";
import {
  corsSocial,
  userFacingError,
  getProfile,
  getFollowRelation,
  canMessage,
  refreshFollowCounts,
  refreshPostsCount,
  reconcileProfileCounts,
  notify,
  parseBody,
} from "../social.js";
import { rateLimit, clientKey } from "../rate-limit.js";
import { resolveIsPro } from "../gates.js";

async function requireUser(req, res) {
  const { ok: cfgOk } = supabaseConfig();
  if (!cfgOk) {
    res.status(503).json({ error: "Social temporarily unavailable" });
    return null;
  }
  const u = await userFromAuthHeader(req);
  if (!u?.id) {
    res.status(401).json({ error: "Sign in required" });
    return null;
  }
  return u;
}

async function actionFollow(me, targetId) {
  if (!targetId || targetId === me.id) throw new Error("Cannot follow yourself");
  const target = await getProfile(targetId, "id,is_private,handle,name");
  if (!target) throw new Error("Profile not found");
  // Private-by-default: null/undefined is_private â†’ pending request
  const status = target.is_private === false ? "accepted" : "pending";
  const r = await sbFetch("/rest/v1/stt_friendships?on_conflict=user_id,friend_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      user_id: me.id,
      friend_id: targetId,
      status,
      updated_at: new Date().toISOString(),
    },
  });
  if (!r.ok) throw new Error(userFacingError(r.data?.message || r.data, "Follow failed"));
  await notify(
    targetId,
    status === "pending" ? "follow_request" : "follow",
    status === "pending" ? "Follow request" : "New follower",
    `${me.email || "Someone"} ${status === "pending" ? "requested to follow you" : "started following you"}`,
    { from: me.id },
  );
  if (status === "accepted") {
    await refreshFollowCounts(me.id);
    await refreshFollowCounts(targetId);
  }
  return { status };
}

async function actionUnfollow(me, targetId) {
  await sbFetch(
    `/rest/v1/stt_friendships?user_id=eq.${me.id}&friend_id=eq.${targetId}`,
    { method: "DELETE" },
  );
  await refreshFollowCounts(me.id);
  await refreshFollowCounts(targetId);
  return { ok: true };
}

async function actionAccept(me, fromId) {
  if (!fromId) throw new Error("User required");
  const r = await sbFetch(
    `/rest/v1/stt_friendships?user_id=eq.${fromId}&friend_id=eq.${me.id}&status=eq.pending`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: { status: "accepted", updated_at: new Date().toISOString() },
    },
  );
  if (!r.ok) throw new Error("Could not confirm request");
  const rows = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
  if (!rows.length) throw new Error("Request not found");
  await notify(fromId, "follow_accept", "Follow accepted", "Your follow request was accepted", {
    from: me.id,
  });
  await refreshFollowCounts(me.id);
  await refreshFollowCounts(fromId);
  return { ok: true };
}

async function actionReject(me, fromId) {
  if (!fromId) throw new Error("User required");
  await sbFetch(
    `/rest/v1/stt_friendships?user_id=eq.${fromId}&friend_id=eq.${me.id}&status=eq.pending`,
    { method: "DELETE" },
  );
  return { ok: true };
}

async function actionCreatePost(me, body) {
  const text = String(body || "").trim().slice(0, 500);
  if (!text) throw new Error("Write a thought first");
  const r = await sbFetch("/rest/v1/stt_posts", {
    method: "POST",
    prefer: "return=representation",
    body: {
      user_id: me.id,
      body: text,
      kind: "thought",
      likes_count: 0,
      comments_count: 0,
      views_count: 0,
      updated_at: new Date().toISOString(),
    },
  });
  if (!r.ok) {
    // Retry without optional columns
    const r2 = await sbFetch("/rest/v1/stt_posts", {
      method: "POST",
      prefer: "return=representation",
      body: { user_id: me.id, body: text, kind: "thought" },
    });
    if (!r2.ok) throw new Error(userFacingError(r2.data?.message || r2.data, "Could not post"));
    await refreshPostsCount(me.id);
    return { post: Array.isArray(r2.data) ? r2.data[0] : r2.data };
  }
  await refreshPostsCount(me.id);
  return { post: Array.isArray(r.data) ? r.data[0] : r.data };
}

async function actionUpdatePost(me, postId, body) {
  const text = String(body || "").trim().slice(0, 500);
  if (!text) throw new Error("Thought cannot be empty");
  const r = await sbFetch(
    `/rest/v1/stt_posts?id=eq.${postId}&user_id=eq.${me.id}`,
    {
      method: "PATCH",
      prefer: "return=representation",
      body: { body: text, updated_at: new Date().toISOString() },
    },
  );
  if (!r.ok) throw new Error("Could not update thought");
  return { post: Array.isArray(r.data) ? r.data[0] : r.data };
}

async function actionDeletePost(me, postId) {
  await sbFetch(`/rest/v1/stt_posts?id=eq.${postId}&user_id=eq.${me.id}`, {
    method: "DELETE",
  });
  await refreshPostsCount(me.id);
  return { ok: true };
}

async function actionLike(me, postId, like = true) {
  if (like) {
    await sbFetch("/rest/v1/stt_post_likes?on_conflict=post_id,user_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: { post_id: Number(postId), user_id: me.id },
    });
  } else {
    await sbFetch(
      `/rest/v1/stt_post_likes?post_id=eq.${postId}&user_id=eq.${me.id}`,
      { method: "DELETE" },
    );
  }
  const likes = await sbFetch(
    `/rest/v1/stt_post_likes?post_id=eq.${postId}&select=user_id`,
  );
  const count = Array.isArray(likes.data) ? likes.data.length : 0;
  await sbFetch(`/rest/v1/stt_posts?id=eq.${postId}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { likes_count: count },
  }).catch(() => {});
  return { liked: like, likes_count: count };
}

async function actionComment(me, postId, body) {
  const text = String(body || "").trim().slice(0, 300);
  if (!text) throw new Error("Write a comment first");
  const r = await sbFetch("/rest/v1/stt_post_comments", {
    method: "POST",
    prefer: "return=representation",
    body: { post_id: Number(postId), user_id: me.id, body: text },
  });
  if (!r.ok) throw new Error(userFacingError(r.data?.message || r.data, "Could not comment"));
  const comments = await sbFetch(
    `/rest/v1/stt_post_comments?post_id=eq.${postId}&select=id`,
  );
  const count = Array.isArray(comments.data) ? comments.data.length : 0;
  await sbFetch(`/rest/v1/stt_posts?id=eq.${postId}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { comments_count: count },
  }).catch(() => {});
  return { comment: Array.isArray(r.data) ? r.data[0] : r.data, comments_count: count };
}

/**
 * Unique view per signed-in viewer. Author viewing own thought does not increment.
 * PK (post_id, user_id) + ignore-duplicates prevents inflate / rapid double-count.
 */
async function actionViewPost(me, postId) {
  const id = Number(postId);
  if (!id) throw new Error("post_id required");
  const pr = await sbFetch(
    `/rest/v1/stt_posts?id=eq.${id}&select=id,user_id,views_count&limit=1`,
  );
  const post = Array.isArray(pr.data) ? pr.data[0] : null;
  if (!post) throw new Error("Post not found");
  const current = Number(post.views_count) || 0;
  if (post.user_id === me.id) {
    return { views_count: current, counted: false };
  }
  await sbFetch("/rest/v1/stt_post_views?on_conflict=post_id,user_id", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: { post_id: id, user_id: me.id },
  });
  const views = await sbFetch(
    `/rest/v1/stt_post_views?post_id=eq.${id}&select=user_id`,
  );
  const count = Array.isArray(views.data) ? views.data.length : current;
  await sbFetch(`/rest/v1/stt_posts?id=eq.${id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { views_count: count },
  }).catch(() => {});
  return { views_count: count, counted: count !== current };
}

async function actionSendMessage(me, recipientId, body) {
  const ent = await resolveIsPro(me);
  if (!ent.isPro) {
    const err = new Error("Direct messages are Pro — upgrade to chat privately");
    err.code = "PRO_REQUIRED";
    throw err;
  }
  if (!recipientId || recipientId === me.id) throw new Error("Invalid recipient");
  const target = await getProfile(recipientId, "id,is_private,name,handle");
  if (!target) throw new Error("Profile not found");
  const rel = await getFollowRelation(me.id, recipientId);
  const gate = canMessage({
    isSelf: false,
    isPrivate: target.is_private === true,
    outStatus: rel.status,
    inStatus: rel.incoming,
  });
  if (!gate.ok) {
    throw new Error(
      gate.reason === "private_no_follow"
        ? "Follow each other or wait for acceptance before messaging private accounts"
        : "Cannot message this user",
    );
  }
  const text = String(body || "").trim().slice(0, 1000);
  if (!text) throw new Error("Write a message first");
  const r = await sbFetch("/rest/v1/stt_messages", {
    method: "POST",
    prefer: "return=representation",
    body: {
      sender_id: me.id,
      recipient_id: recipientId,
      body: text,
    },
  });
  if (!r.ok) throw new Error(userFacingError(r.data?.message || r.data, "Could not send"));
  await notify(recipientId, "message", "New message", text.slice(0, 80), { from: me.id });
  return { message: Array.isArray(r.data) ? r.data[0] : r.data };
}

async function filterVisiblePosts(me, posts) {
  if (!Array.isArray(posts) || !posts.length) return [];
  const authorIds = [...new Set(posts.map((p) => p.user_id).filter(Boolean))];
  const profiles = await sbFetch(
    `/rest/v1/stt_profiles?id=in.(${authorIds.join(",")})&select=id,name,handle,picture,is_private`,
  );
  const map = Object.fromEntries((profiles.data || []).map((p) => [p.id, p]));
  const privateIds = authorIds.filter((id) => map[id]?.is_private === true && id !== me.id);
  let allowedPrivate = new Set();
  if (privateIds.length) {
    const friendships = await sbFetch(
      `/rest/v1/stt_friendships?user_id=eq.${me.id}&friend_id=in.(${privateIds.join(",")})&status=eq.accepted&select=friend_id`,
    );
    allowedPrivate = new Set((friendships.data || []).map((f) => f.friend_id));
  }
  const visible = posts.filter((p) => {
    if (p.user_id === me.id) return true;
    const author = map[p.user_id];
    if (!author) return false;
    if (author.is_private !== true) return true;
    return allowedPrivate.has(p.user_id);
  });

  // Attach like state + counts
  const ids = visible.map((p) => p.id);
  let likedSet = new Set();
  if (ids.length) {
    const likes = await sbFetch(
      `/rest/v1/stt_post_likes?user_id=eq.${me.id}&post_id=in.(${ids.join(",")})&select=post_id`,
    );
    likedSet = new Set((likes.data || []).map((l) => l.post_id));
  }
  return visible.map((p) => ({
    ...p,
    author: map[p.user_id] || null,
    liked_by_me: likedSet.has(p.id),
    likes_count: p.likes_count || 0,
    comments_count: p.comments_count || 0,
    views_count: p.views_count || 0,
  }));
}

async function getFeed(me, limit = 40) {
  const r = await sbFetch(
    `/rest/v1/stt_posts?select=id,body,kind,created_at,updated_at,user_id,likes_count,comments_count,views_count&order=created_at.desc&limit=${Math.min(Number(limit) || 40, 80)}`,
  );
  if (!r.ok) {
    const r2 = await sbFetch(
      `/rest/v1/stt_posts?select=id,body,kind,created_at,updated_at,user_id,likes_count,comments_count&order=created_at.desc&limit=${Math.min(Number(limit) || 40, 80)}`,
    );
    if (r2.ok) return filterVisiblePosts(me, r2.data || []);
    const r3 = await sbFetch(
      `/rest/v1/stt_posts?select=id,body,kind,created_at,user_id&order=created_at.desc&limit=${Math.min(Number(limit) || 40, 80)}`,
    );
    return filterVisiblePosts(me, r3.data || []);
  }
  return filterVisiblePosts(me, r.data || []);
}

async function getProfileView(me, targetId) {
  let profile = await getProfile(targetId);
  if (!profile) throw new Error("Profile not found");
  // Always reconcile counts from friendships/posts - fixes stale 0-stats
  profile = await reconcileProfileCounts(profile);
  const rel = await getFollowRelation(me.id, targetId);
  const isSelf = me.id === targetId;
  const canSee = isSelf || profile.is_private !== true || rel.status === "accepted";
  const msgGate = canMessage({
    isSelf,
    isPrivate: profile.is_private === true,
    outStatus: rel.status,
    inStatus: rel.incoming,
  });

  let posts = [];
  let topSites = [];
  if (canSee) {
    const pr = await sbFetch(
      `/rest/v1/stt_posts?user_id=eq.${targetId}&select=id,body,kind,created_at,updated_at,likes_count,comments_count,views_count,user_id&order=created_at.desc&limit=40`,
    );
    if (pr.ok && Array.isArray(pr.data)) {
      posts = pr.data;
    } else {
      const pr2 = await sbFetch(
        `/rest/v1/stt_posts?user_id=eq.${targetId}&select=id,body,kind,created_at,updated_at,likes_count,comments_count,user_id&order=created_at.desc&limit=40`,
      );
      posts = Array.isArray(pr2.data) ? pr2.data : [];
    }
    posts = posts.map((p) => ({
      ...p,
      likes_count: p.likes_count || 0,
      comments_count: p.comments_count || 0,
      views_count: p.views_count || 0,
    }));
    // Prefer live post list length when column still lags
    if (posts.length > (Number(profile.posts_count) || 0)) {
      profile = { ...profile, posts_count: posts.length };
    }
    topSites = Array.isArray(profile.public_top_sites) ? profile.public_top_sites : [];
  }

  return {
    profile,
    relation: rel,
    isSelf,
    canSee,
    canMessage: msgGate.ok,
    messageReason: msgGate.reason,
    posts,
    topSites,
  };
}

export default async function handler(req, res) {
  corsSocial(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const rl = rateLimit(clientKey(req, "social"), { limit: 120, windowMs: 60_000 });
  if (!rl.ok) {
    res.setHeader("Retry-After", String(rl.retryAfter));
    return res.status(429).json({ error: "Too many requests. Try again shortly." });
  }

  try {
    const me = await requireUser(req, res);
    if (!me) return;

    if (req.method === "GET") {
      const action = String(req.query?.action || "feed");
      const limit = Number(req.query?.limit) || 40;
      const targetId = String(req.query?.user_id || req.query?.id || "");
      const postId = String(req.query?.post_id || "");

      if (action === "feed") {
        const feed = await getFeed(me, limit);
        return res.status(200).json({ ok: true, feed });
      }
      if (action === "profile") {
        if (!targetId) return res.status(400).json({ error: "user_id required" });
        const view = await getProfileView(me, targetId);
        return res.status(200).json({ ok: true, ...view });
      }
      if (action === "requests") {
        const rows = await sbFetch(
          `/rest/v1/stt_friendships?friend_id=eq.${me.id}&status=eq.pending&select=*`,
        );
        const list = rows.data || [];
        if (!list.length) return res.status(200).json({ ok: true, requests: [] });
        const ids = list.map((r) => r.user_id).join(",");
        const people = await sbFetch(
          `/rest/v1/stt_profiles?id=in.(${ids})&select=id,name,handle,picture`,
        );
        const map = Object.fromEntries((people.data || []).map((p) => [p.id, p]));
        return res.status(200).json({
          ok: true,
          requests: list.map((r) => ({
            ...r,
            profile: map[r.user_id] || { id: r.user_id, name: "Member" },
          })),
        });
      }
      if (action === "followers" || action === "following") {
        if (!targetId) return res.status(400).json({ error: "user_id required" });
        const profile = await getProfile(targetId, "id,is_private");
        const rel = await getFollowRelation(me.id, targetId);
        const isSelf = me.id === targetId;
        if (profile?.is_private && !isSelf && rel.status !== "accepted") {
          return res.status(200).json({ ok: true, people: [], locked: true });
        }
        const q =
          action === "followers"
            ? `/rest/v1/stt_friendships?friend_id=eq.${targetId}&status=eq.accepted&select=user_id`
            : `/rest/v1/stt_friendships?user_id=eq.${targetId}&status=eq.accepted&select=friend_id`;
        const rows = await sbFetch(q);
        const ids = (rows.data || []).map((r) =>
          action === "followers" ? r.user_id : r.friend_id,
        );
        if (!ids.length) return res.status(200).json({ ok: true, people: [] });
        const people = await sbFetch(
          `/rest/v1/stt_profiles?id=in.(${ids.join(",")})&select=id,name,handle,picture,is_private,public_score`,
        );
        return res.status(200).json({ ok: true, people: people.data || [] });
      }
      if (action === "comments") {
        if (!postId) return res.status(400).json({ error: "post_id required" });
        const rows = await sbFetch(
          `/rest/v1/stt_post_comments?post_id=eq.${postId}&select=id,body,user_id,created_at&order=created_at.asc&limit=50`,
        );
        const list = rows.data || [];
        const ids = [...new Set(list.map((c) => c.user_id))];
        let map = {};
        if (ids.length) {
          const people = await sbFetch(
            `/rest/v1/stt_profiles?id=in.(${ids.join(",")})&select=id,name,handle,picture`,
          );
          map = Object.fromEntries((people.data || []).map((p) => [p.id, p]));
        }
        return res.status(200).json({
          ok: true,
          comments: list.map((c) => ({ ...c, author: map[c.user_id] || null })),
        });
      }
      if (action === "thread") {
        if (!targetId) return res.status(400).json({ error: "user_id required" });
        const rows = await sbFetch(
          `/rest/v1/stt_messages?or=(and(sender_id.eq.${me.id},recipient_id.eq.${targetId}),and(sender_id.eq.${targetId},recipient_id.eq.${me.id}))&select=*&order=created_at.asc&limit=100`,
        );
        return res.status(200).json({ ok: true, messages: rows.data || [] });
      }
      if (action === "inbox") {
        const rows = await sbFetch(
          `/rest/v1/stt_messages?or=(sender_id.eq.${me.id},recipient_id.eq.${me.id})&select=id,sender_id,recipient_id,body,read_at,created_at&order=created_at.desc&limit=200`,
        );
        const messages = Array.isArray(rows.data) ? rows.data : [];
        const latestByPeer = new Map();
        let unreadTotal = 0;
        for (const m of messages) {
          const peerId = m.sender_id === me.id ? m.recipient_id : m.sender_id;
          if (!peerId || peerId === me.id) continue;
          if (m.recipient_id === me.id && !m.read_at) unreadTotal += 1;
          if (!latestByPeer.has(peerId)) latestByPeer.set(peerId, m);
        }
        const peerIds = [...latestByPeer.keys()];
        let map = {};
        if (peerIds.length) {
          const people = await sbFetch(
            `/rest/v1/stt_profiles?id=in.(${peerIds.join(",")})&select=id,name,handle,picture,is_private`,
          );
          map = Object.fromEntries((people.data || []).map((p) => [p.id, p]));
        }
        const conversations = peerIds.map((peerId) => {
          const last = latestByPeer.get(peerId);
          const unread = messages.filter(
            (m) => m.sender_id === peerId && m.recipient_id === me.id && !m.read_at,
          ).length;
          return {
            peer_id: peerId,
            peer: map[peerId] || { id: peerId, name: "Member" },
            last_message: last,
            unread,
          };
        });
        return res.status(200).json({ ok: true, conversations, unread_total: unreadTotal });
      }
      if (action === "can_message") {
        if (!targetId) return res.status(400).json({ error: "user_id required" });
        const profile = await getProfile(targetId, "id,is_private");
        if (!profile) return res.status(404).json({ error: "Profile not found" });
        const rel = await getFollowRelation(me.id, targetId);
        const gate = canMessage({
          isSelf: me.id === targetId,
          isPrivate: profile.is_private === true,
          outStatus: rel.status,
          inStatus: rel.incoming,
        });
        return res.status(200).json({ ok: true, ...gate });
      }
      return res.status(400).json({ error: "Unknown action" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const body = parseBody(req);
    const action = String(body.action || "");

    let result;
    switch (action) {
      case "follow":
        result = await actionFollow(me, body.user_id || body.target_id);
        break;
      case "unfollow":
        result = await actionUnfollow(me, body.user_id || body.target_id);
        break;
      case "accept_follow":
        result = await actionAccept(me, body.user_id || body.from_id);
        break;
      case "reject_follow":
        result = await actionReject(me, body.user_id || body.from_id);
        break;
      case "create_post":
        result = await actionCreatePost(me, body.body || body.text);
        break;
      case "update_post":
        result = await actionUpdatePost(me, body.post_id, body.body || body.text);
        break;
      case "delete_post":
        result = await actionDeletePost(me, body.post_id);
        break;
      case "like_post":
        result = await actionLike(me, body.post_id, true);
        break;
      case "unlike_post":
        result = await actionLike(me, body.post_id, false);
        break;
      case "comment_post":
        result = await actionComment(me, body.post_id, body.body || body.text);
        break;
      case "view_post":
        result = await actionViewPost(me, body.post_id);
        break;
      case "send_message":
        result = await actionSendMessage(me, body.user_id || body.recipient_id, body.body || body.text);
        break;
      case "mark_messages_read": {
        const peer = body.user_id || body.sender_id;
        await sbFetch(
          `/rest/v1/stt_messages?recipient_id=eq.${me.id}&sender_id=eq.${peer}&read_at=is.null`,
          {
            method: "PATCH",
            prefer: "return=minimal",
            body: { read_at: new Date().toISOString() },
          },
        );
        result = { ok: true };
        break;
      }
      case "update_privacy": {
        const isPrivate = body.is_private === true;
        await sbFetch(`/rest/v1/stt_profiles?id=eq.${me.id}`, {
          method: "PATCH",
          prefer: "return=minimal",
          body: {
            is_private: isPrivate,
            is_public: !isPrivate,
            updated_at: new Date().toISOString(),
          },
        });
        result = { ok: true, is_private: isPrivate };
        break;
      }
      case "update_profile": {
        const patch = {
          updated_at: new Date().toISOString(),
        };
        if (body.name != null) patch.name = String(body.name).slice(0, 48);
        if (body.handle != null) {
          patch.handle = String(body.handle)
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "")
            .slice(0, 16);
        }
        if (body.bio != null) patch.bio = String(body.bio).slice(0, 160);
        if (typeof body.is_private === "boolean") {
          patch.is_private = body.is_private;
          patch.is_public = !body.is_private;
        }
        const r = await sbFetch(`/rest/v1/stt_profiles?id=eq.${me.id}`, {
          method: "PATCH",
          prefer: "return=representation",
          body: patch,
        });
        if (!r.ok) throw new Error(userFacingError(r.data?.message || r.data, "Could not save profile"));
        result = { ok: true, profile: Array.isArray(r.data) ? r.data[0] : r.data };
        break;
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error("[stt/social]", e);
    if (e?.code === "PRO_REQUIRED") {
      return res.status(403).json({
        ok: false,
        code: "PRO_REQUIRED",
        feature: "messaging",
        error: userFacingError(e.message, "Direct messages are Pro"),
      });
    }
    return res.status(400).json({ error: userFacingError(e.message, "Request failed") });
  }
}
