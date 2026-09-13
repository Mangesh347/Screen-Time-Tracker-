import {
  computeExpiresAt,
  quoteUSD,
  paymentMode,
  getPlan,
  paypalCredentials,
  missingPaypalEnvVars,
  allowSimulatedCheckout,
} from "../pricing.js";
import { upsertEntitlement, claimPaymentEvent, markEventProcessed } from "../entitlement.js";
import { ensureCheckoutUser } from "../auth.js";
import { sbFetch } from "../supabase.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const mode = paymentMode();
  const creds = paypalCredentials();

  try {
    const body = req.body || {};
    const { order_id, email = "", cycle = "yearly" } = body;
    if (!order_id) return res.status(400).json({ error: "order_id required", is_pro: false });

    const isSim = String(order_id).startsWith("SIM_");

    // Simulated path: only grant Pro when explicitly allowed + SIM_ order
    if (isSim) {
      if (!allowSimulatedCheckout()) {
        return res.status(400).json({
          error: "simulated_not_allowed",
          message: "Simulated PayPal orders are disabled. Complete a real checkout.",
          is_pro: false,
          mode,
        });
      }

      const authUser = await ensureCheckoutUser(req, body);
      if (!authUser?.id) {
        return res.status(401).json({
          error: "sign_in_required",
          message: "Authenticated user or billing email required",
          is_pro: false,
        });
      }

      const userId = authUser.id;
      const planCycle = cycle;
      const quote = quoteUSD(planCycle);
      const plan = getPlan(planCycle);
      const expiresAt = computeExpiresAt(planCycle);
      const billingEmail = authUser.email || String(email || "").toLowerCase().trim();

      await sbFetch(`/rest/v1/stt_checkout_sessions`, {
        method: "POST",
        body: {
          user_id: userId,
          email: billingEmail,
          provider: "paypal_simulated",
          cycle: plan.id,
          currency: "USD",
          amount: quote.total,
          status: "completed",
          order_id,
          expires_at: expiresAt,
          duration_days: plan.days,
          metadata: { mode: "simulated_preview" },
        },
      }).catch(() => {});

      await upsertEntitlement({
        email: billingEmail,
        userId,
        plan: quote.cycle,
        cycle: quote.cycle,
        provider: "paypal_simulated",
        expiresAt,
        externalId: order_id,
        paymentId: order_id,
        orderId: order_id,
        amount: quote.total,
        currency: "USD",
        webhookVerified: false,
        metadata: { via: "simulated_preview", mode: "simulated_preview" },
      });

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
        mode: "simulated_preview",
      });
    }

    const missing = missingPaypalEnvVars();
    if (missing.length) {
      return res.status(503).json({
        error: "paypal_keys_missing",
        message: `Missing Vercel env: ${missing.join(", ")}. Add them, then redeploy.`,
        missing_env: missing,
        is_pro: false,
        mode,
      });
    }

    const authUser = await ensureCheckoutUser(req, body);
    if (!authUser?.id) {
      return res.status(401).json({
        error: "sign_in_required",
        message: "Authenticated user_id or billing email required",
        is_pro: false,
      });
    }

    const userId = authUser.id;
    const sess = await sbFetch(
      `/rest/v1/stt_checkout_sessions?user_id=eq.${encodeURIComponent(userId)}&order_id=eq.${encodeURIComponent(order_id)}&select=*&limit=1`,
    );
    let session = sess.data?.[0];
    if (!session) {
      // Fallback: email-only order lookup (marketing return URL)
      const billingLookup = authUser.email || String(email || "").toLowerCase().trim();
      if (billingLookup) {
        const byEmail = await sbFetch(
          `/rest/v1/stt_checkout_sessions?email=eq.${encodeURIComponent(billingLookup)}&order_id=eq.${encodeURIComponent(order_id)}&select=*&limit=1`,
        );
        session = byEmail.data?.[0];
      }
    }
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

    const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const tokenRes = await fetch(`${creds.apiBase}/v1/oauth2/token`, {
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

    const capRes = await fetch(`${creds.apiBase}/v2/checkout/orders/${order_id}/capture`, {
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
