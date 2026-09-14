import {
  computeExpiresAt,
  quoteUSD,
  paymentMode,
  getPlan,
  paypalCredentials,
  missingPaypalEnvVars,
  allowSimulatedCheckout,
} from "../pricing.js";
import { upsertEntitlement } from "../entitlement.js";
import { ensureCheckoutUser } from "../auth.js";
import { sbFetch } from "../supabase.js";
import { fulfillVerifiedPayment, buildSuccessRedirect } from "../fulfill.js";

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
    // Prefer order_id alone — capture/signature path already authenticates the order
    let session = null;
    {
      const byOrder = await sbFetch(
        `/rest/v1/stt_checkout_sessions?order_id=eq.${encodeURIComponent(order_id)}&select=*&order=created_at.desc&limit=1`,
      );
      session = byOrder.data?.[0] || null;
    }
    if (!session) {
      const sess = await sbFetch(
        `/rest/v1/stt_checkout_sessions?user_id=eq.${encodeURIComponent(userId)}&order_id=eq.${encodeURIComponent(order_id)}&select=*&limit=1`,
      );
      session = sess.data?.[0];
    }
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
    // Do not hard-fail if session is missing — capture still proves payment.
    // Session is preferred for cycle; body.cycle is the fallback.

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

    // Provider capture succeeded → write Pro + deadline, then redirect
    const result = await fulfillVerifiedPayment({
      provider: "paypal",
      eventId: `pp_capture_${paymentId}`,
      eventType: "client_capture",
      paymentId,
      orderId: order_id,
      userId,
      email: billingEmail,
      cycle: plan.id,
      amount: quote.total,
      currency: "USD",
      mode,
      extId: String(body.ext_id || "").replace(/[^a-z0-9]/gi, ""),
      metadata: { via: "vercel_capture" },
      payload: body,
    });

    if (!result.ok) {
      return res.status(result.status || 502).json({
        ...result,
        message:
          result.message ||
          "PayPal payment captured but Pro could not be saved. You remain Free — contact support with your order id.",
      });
    }

    return res.status(200).json({
      ...result,
      status: "COMPLETED",
      redirect:
        result.redirect ||
        buildSuccessRedirect({
          email: billingEmail,
          cycle: plan.id,
          provider: "paypal",
          userId,
          extId: body.ext_id,
        }),
    });
  } catch (err) {
    console.error("[STT PayPal capture]", err);
    return res.status(500).json({
      error: err.message,
      message: "Capture error — you remain on Free.",
      is_pro: false,
    });
  }
}
