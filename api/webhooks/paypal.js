/**
 * POST /api/webhooks/paypal — verify with PayPal API, grant/demote (idempotent)
 */
import {
  claimPaymentEvent,
  markEventProcessed,
  upsertEntitlement,
  demoteEntitlement,
} from "../_lib/entitlement.js";
import { computeExpiresAt, getPlan, paymentMode } from "../_lib/pricing.js";
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

function apiBase() {
  return paymentMode() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function getAccessToken() {
  const mode = paymentMode();
  const clientId =
    mode === "live"
      ? process.env.PAYPAL_LIVE_CLIENT_ID || process.env.PAYPAL_CLIENT_ID
      : process.env.PAYPAL_TEST_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
  const clientSecret =
    mode === "live"
      ? process.env.PAYPAL_LIVE_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET
      : process.env.PAYPAL_TEST_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token;
}

function parseCustom(raw) {
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw || {};
    return {
      userId: obj.user_id || "",
      email: String(obj.email || "").toLowerCase().trim(),
      cycle: obj.cycle || obj.plan || "yearly",
    };
  } catch {
    return { userId: "", email: "", cycle: "yearly" };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch {
    return res.status(400).json({ error: "Failed to read body" });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (webhookId) {
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(500).json({ error: "PayPal OAuth failed" });
    const verifyRes = await fetch(`${apiBase()}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: req.headers["paypal-auth-algo"],
        cert_url: req.headers["paypal-cert-url"],
        transmission_id: req.headers["paypal-transmission-id"],
        transmission_sig: req.headers["paypal-transmission-sig"],
        transmission_time: req.headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
    const verifyData = await verifyRes.json();
    if (verifyData.verification_status !== "SUCCESS") {
      return res.status(401).json({ error: "Webhook verification failed" });
    }
  } else if (String(process.env.ALLOW_UNVERIFIED_PAYPAL_WEBHOOK || "").toLowerCase() !== "true") {
    return res.status(500).json({ error: "PAYPAL_WEBHOOK_ID not configured" });
  }

  const eventType = event.event_type || "";
  const eventId = event.id || `${eventType}_${Date.now()}`;
  const claim = await claimPaymentEvent({
    provider: "paypal",
    eventId,
    eventType,
    verified: true,
    payload: event,
  });
  if (!claim.claimed) return res.status(200).json({ ok: true, duplicate: true });

  try {
    const resource = event.resource || {};

    if (eventType === "PAYMENT.CAPTURE.COMPLETED" || eventType === "CHECKOUT.ORDER.COMPLETED") {
      const custom =
        resource.custom_id ||
        resource.purchase_units?.[0]?.custom_id ||
        "";
      let { userId, email, cycle } = parseCustom(custom);
      const paymentId = resource.id || "";
      const orderId =
        resource.supplementary_data?.related_ids?.order_id || resource.id || "";

      if (!userId && orderId) {
        const sess = await sbFetch(
          `/rest/v1/stt_checkout_sessions?provider=eq.paypal&order_id=eq.${encodeURIComponent(orderId)}&select=user_id,email,cycle&limit=1`,
        );
        const s = sess.data?.[0];
        if (s) {
          userId = s.user_id;
          email = s.email || email;
          cycle = s.cycle || cycle;
        }
      }

      if (!userId) {
        await markEventProcessed("paypal", eventId, "error", "missing user_id");
        return res.status(400).json({ error: "Cannot bind payment to user_id" });
      }

      const plan = getPlan(cycle);
      await upsertEntitlement({
        userId,
        email,
        plan: plan.id,
        cycle: plan.id,
        provider: "paypal",
        expiresAt: computeExpiresAt(plan.id),
        paymentId,
        orderId,
        externalId: paymentId,
        amount: resource.amount?.value ? Number(resource.amount.value) : null,
        currency: resource.amount?.currency_code || "USD",
        webhookVerified: true,
        metadata: { event_id: eventId },
      });
      await markEventProcessed("paypal", eventId, "processed");
      return res.status(200).json({ ok: true, plan: plan.id, user_id: userId });
    }

    if (eventType === "CHECKOUT.ORDER.APPROVED") {
      await markEventProcessed("paypal", eventId, "ignored");
      return res.status(200).json({ ok: true, ignored: "await_capture" });
    }

    if (
      [
        "PAYMENT.CAPTURE.DENIED",
        "PAYMENT.CAPTURE.REFUNDED",
        "PAYMENT.CAPTURE.REVERSED",
        "BILLING.SUBSCRIPTION.CANCELLED",
        "BILLING.SUBSCRIPTION.EXPIRED",
      ].includes(eventType)
    ) {
      let { userId, email } = parseCustom(resource.custom_id || "");
      const paymentId = resource.id || "";
      if (!userId && paymentId) {
        const ent = await sbFetch(
          `/rest/v1/stt_entitlements?provider=eq.paypal&payment_id=eq.${encodeURIComponent(paymentId)}&select=user_id,email&limit=1`,
        );
        userId = ent.data?.[0]?.user_id || null;
        email = ent.data?.[0]?.email || email;
      }
      const reason = /REFUND|REVERSED/.test(eventType)
        ? "refunded"
        : /CANCEL/.test(eventType)
          ? "cancelled"
          : /EXPIRED/.test(eventType)
            ? "expired"
            : "failed";
      if (userId) await demoteEntitlement({ userId, email, reason });
      await markEventProcessed("paypal", eventId, "processed");
      return res.status(200).json({ ok: true, demoted: !!userId });
    }

    await markEventProcessed("paypal", eventId, "ignored");
    return res.status(200).json({ ok: true, ignored: eventType });
  } catch (err) {
    await markEventProcessed("paypal", eventId, "error", err.message);
    return res.status(500).json({ error: err.message });
  }
}
