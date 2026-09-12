/**
 * POST /api/webhooks/razorpay — verify signature, grant/demote Pro (idempotent)
 */
import crypto from "crypto";
import {
  claimPaymentEvent,
  markEventProcessed,
  upsertEntitlement,
  demoteEntitlement,
} from "../_lib/entitlement.js";
import { computeExpiresAt, getPlan } from "../_lib/pricing.js";
import { sbFetch } from "../_lib/supabase.js";

export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch {
    return res.status(400).json({ error: "Failed to read body" });
  }

  const signature = req.headers["x-razorpay-signature"] || "";
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  if (!secret) return res.status(500).json({ error: "Webhook secret not configured" });
  if (!signature) return res.status(401).json({ error: "Missing signature" });

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    if (
      !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(String(signature), "hex"))
    ) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  } catch {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const eventType = event.event || "";
  const eventId = event.id || `${eventType}_${Date.now()}`;
  const claim = await claimPaymentEvent({
    provider: "razorpay",
    eventId,
    eventType,
    verified: true,
    payload: event,
  });
  if (!claim.claimed) return res.status(200).json({ ok: true, duplicate: true });

  try {
    const payload = event.payload || {};
    if (eventType === "payment.captured") {
      const payment = payload.payment?.entity || {};
      const notes = payment.notes || {};
      let userId = notes.user_id || null;
      let email = String(notes.email || "").toLowerCase().trim();
      let cycle = notes.cycle || notes.plan || "yearly";
      const orderId = payment.order_id || "";
      const paymentId = payment.id || "";

      if (!userId && orderId) {
        const sess = await sbFetch(
          `/rest/v1/stt_checkout_sessions?provider=eq.razorpay&order_id=eq.${encodeURIComponent(orderId)}&select=user_id,email,cycle&limit=1`,
        );
        const s = sess.data?.[0];
        if (s) {
          userId = s.user_id;
          email = s.email || email;
          cycle = s.cycle || cycle;
        }
      }

      if (!userId) {
        await markEventProcessed("razorpay", eventId, "error", "missing user_id");
        return res.status(400).json({ error: "Cannot bind payment to user_id" });
      }

      const plan = getPlan(cycle);
      await upsertEntitlement({
        userId,
        email,
        plan: plan.id,
        cycle: plan.id,
        provider: "razorpay",
        expiresAt: computeExpiresAt(plan.id),
        paymentId,
        orderId,
        externalId: paymentId,
        amount: typeof payment.amount === "number" ? payment.amount / 100 : null,
        currency: payment.currency || "INR",
        webhookVerified: true,
        metadata: { event_id: eventId },
      });
      await markEventProcessed("razorpay", eventId, "processed");
      return res.status(200).json({ ok: true, plan: plan.id, user_id: userId });
    }

    if (
      ["payment.failed", "refund.processed", "refund.created", "subscription.cancelled", "subscription.halted"].includes(
        eventType,
      )
    ) {
      const entity =
        payload.payment?.entity || payload.refund?.entity || payload.subscription?.entity || {};
      const notes = entity.notes || {};
      let userId = notes.user_id || null;
      const orderId = entity.order_id || "";
      if (!userId && orderId) {
        const sess = await sbFetch(
          `/rest/v1/stt_checkout_sessions?order_id=eq.${encodeURIComponent(orderId)}&select=user_id,email&limit=1`,
        );
        userId = sess.data?.[0]?.user_id || null;
      }
      const reason = eventType.startsWith("refund")
        ? "refunded"
        : eventType.includes("cancel") || eventType.includes("halt")
          ? "cancelled"
          : "failed";
      if (userId) await demoteEntitlement({ userId, reason });
      await markEventProcessed("razorpay", eventId, "processed");
      return res.status(200).json({ ok: true, demoted: !!userId });
    }

    await markEventProcessed("razorpay", eventId, "ignored");
    return res.status(200).json({ ok: true, ignored: eventType });
  } catch (err) {
    await markEventProcessed("razorpay", eventId, "error", err.message);
    return res.status(500).json({ error: err.message });
  }
}
