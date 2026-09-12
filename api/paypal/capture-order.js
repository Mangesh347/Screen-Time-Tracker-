import { computeExpiresAt, quoteUSD, paymentMode, getPlan } from "../_lib/pricing.js";
import { upsertEntitlement, claimPaymentEvent, markEventProcessed } from "../_lib/entitlement.js";
import { resolveCheckoutUser } from "../_lib/auth.js";
import { sbFetch } from "../_lib/supabase.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const mode = paymentMode();
  const clientId =
    mode === "live"
      ? process.env.PAYPAL_LIVE_CLIENT_ID || process.env.PAYPAL_CLIENT_ID
      : process.env.PAYPAL_TEST_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
  const clientSecret =
    mode === "live"
      ? process.env.PAYPAL_LIVE_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET
      : process.env.PAYPAL_TEST_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET;
  const apiBase = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  try {
    const body = req.body || {};
    const { order_id, email = "", cycle = "yearly" } = body;
    if (!order_id) return res.status(400).json({ error: "order_id required", is_pro: false });

    if (String(order_id).startsWith("SIM_")) {
      return res.status(400).json({
        error: "simulated_not_allowed",
        message: "Simulated PayPal orders are disabled. Complete a real sandbox checkout.",
        is_pro: false,
        mode,
      });
    }

    if (!clientId || !clientSecret) {
      return res.status(503).json({
        error: "paypal_keys_missing",
        message:
          "Add PAYPAL_TEST_CLIENT_ID + PAYPAL_TEST_CLIENT_SECRET in Vercel env, set MODE=sandbox, redeploy.",
        is_pro: false,
        mode,
      });
    }

    const authUser = await resolveCheckoutUser(req, body);
    if (!authUser?.id) {
      return res.status(401).json({
        error: "sign_in_required",
        message: "Authenticated user_id required",
        is_pro: false,
      });
    }

    const userId = authUser.id;
    const sess = await sbFetch(
      `/rest/v1/stt_checkout_sessions?user_id=eq.${encodeURIComponent(userId)}&order_id=eq.${encodeURIComponent(order_id)}&select=*&limit=1`,
    );
    const session = sess.data?.[0];
    if (!session) {
      return res.status(403).json({
        error: "Checkout session not found for this user",
        is_pro: false,
      });
    }

    const planCycle = session?.cycle || cycle;
    const quote = quoteUSD(planCycle);
    const plan = getPlan(planCycle);
    const expiresAt = computeExpiresAt(planCycle);
    const billingEmail = authUser.email || String(email || "").toLowerCase().trim();

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!tokenRes.ok) {
      return res.status(502).json({ error: "PayPal OAuth failed", is_pro: false });
    }
    const { access_token } = await tokenRes.json();

    const capRes = await fetch(`${apiBase}/v2/checkout/orders/${order_id}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
    });
    const cap = await capRes.json();
    if (!capRes.ok && cap.status !== "COMPLETED") {
      const already = String(cap?.details?.[0]?.issue || "").includes("ORDER_ALREADY_CAPTURED");
      if (!already) {
        return res.status(capRes.status).json({
          error: cap.message || "Capture failed",
          details: cap,
          is_pro: false,
        });
      }
    }

    const paymentId =
      cap?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
      cap?.id ||
      order_id;

    const eventId = `pp_capture_${paymentId}`;
    const claim = await claimPaymentEvent({
      provider: "paypal",
      eventId,
      eventType: "client_capture",
      paymentId,
      orderId: order_id,
      userId,
      email: billingEmail,
      cycle: plan.id,
      verified: true,
      payload: body,
    });

    if (!claim.claimed && !claim.error) {
      return res.status(200).json({
        success: true,
        status: "COMPLETED",
        plan: plan.id,
        duplicate: true,
        provider: "paypal",
        expiresAt,
        is_pro: true,
      });
    }

    await upsertEntitlement({
      email: billingEmail,
      userId,
      plan: quote.cycle,
      cycle: quote.cycle,
      provider: "paypal",
      expiresAt,
      externalId: paymentId,
      paymentId,
      orderId: order_id,
      amount: quote.total,
      currency: "USD",
      webhookVerified: true,
      metadata: { via: "vercel_capture", mode },
    });

    await markEventProcessed("paypal", eventId, "processed");

    return res.status(200).json({
      success: true,
      status: "COMPLETED",
      plan: quote.cycle,
      cycle: quote.cycle,
      email: billingEmail,
      user_id: userId,
      expiresAt,
      provider: "paypal",
      is_pro: true,
      mode,
    });
  } catch (err) {
    console.error("[STT PayPal capture]", err);
    return res.status(500).json({ error: err.message, is_pro: false });
  }
}
