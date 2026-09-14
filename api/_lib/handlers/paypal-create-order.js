import {
  quoteUSD,
  computeExpiresAt,
  paymentMode,
  getPlan,
  paypalCredentials,
  missingPaypalEnvVars,
  allowSimulatedCheckout,
  siteUrl,
} from "../pricing.js";
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
    const { cycle = "yearly", email = "" } = body;
    const authUser = await ensureCheckoutUser(req, body);
    const plan = getPlan(cycle);
    const quote = quoteUSD(cycle);
    const amount = quote.total.toFixed(2);

    const billingEmail =
      authUser?.email || String(email || "").toLowerCase().trim();

    if (!billingEmail || !billingEmail.includes("@")) {
      return res.status(400).json({
        error: "email_required",
        message: "Enter a billing email for Pro activation.",
        mode,
      });
    }

    if (!authUser?.id) {
      return res.status(401).json({
        error: "sign_in_required",
        message:
          "Could not resolve a Screen Time Tracker account for this email. Sign in from the extension, or use the same Gmail you will use in the app.",
        mode,
      });
    }

    const userId = authUser.id;

    const sessionRow = {
      user_id: userId,
      email: billingEmail,
      provider: "paypal",
      cycle: plan.id,
      currency: "USD",
      amount: quote.total,
      status: "created",
      expires_at: computeExpiresAt(plan.id),
      duration_days: plan.days,
      metadata: { mode },
    };

    const missing = missingPaypalEnvVars();
    if (missing.length) {
      if (allowSimulatedCheckout()) {
        const orderId = `SIM_PP_${Date.now()}`;
        await sbFetch(`/rest/v1/stt_checkout_sessions`, {
          method: "POST",
          body: {
            ...sessionRow,
            order_id: orderId,
            metadata: { mode: "simulated_preview", missing },
          },
        }).catch(() => {});
        return res.status(200).json({
          success: true,
          order_id: orderId,
          status: "CREATED",
          amount,
          currency: "USD",
          quote,
          approve_url: null,
          mode: "simulated_preview",
          payment_mode: mode,
          missing_env: missing,
          user_id: userId,
          message:
            "Simulated PayPal preview — no charge. Capture will not unlock Pro unless ALLOW_SIMULATED_CHECKOUT and SIM_ order.",
        });
      }
      return res.status(503).json({
        error: "paypal_keys_missing",
        message: `Missing Vercel env: ${missing.join(", ")}. Add them, then redeploy.`,
        missing_env: missing,
        mode,
      });
    }

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
      return res.status(502).json({
        error: "paypal_oauth_failed",
        message: await tokenRes.text(),
        mode,
      });
    }
    const { access_token } = await tokenRes.json();

    const customId = JSON.stringify({
      user_id: userId,
      email: billingEmail,
      product: "stt",
      plan: quote.cycle,
      cycle: quote.cycle,
    }).slice(0, 127);

    const extId = String(body.ext_id || "").replace(/[^a-z]+/gi, "");
    const returnQs = new URLSearchParams({
      provider: "paypal",
      paid: "paypal",
      cycle: quote.cycle,
      email: billingEmail,
      user_id: userId,
    });
    if (extId) returnQs.set("ext_id", extId);
    // Do NOT put access_token in return_url — long JWTs break PayPal redirects / look like expired sessions.
    // Success page restores session from sessionStorage (stt_pp_order). PayPal appends token + PayerID.

    const orderRes = await fetch(`${creds.apiBase}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: `stt_${quote.cycle}_${Date.now()}`,
            description: `${quote.desc} (incl. GST)`,
            custom_id: customId,
            amount: {
              currency_code: "USD",
              value: amount,
              breakdown: {
                item_total: { currency_code: "USD", value: quote.subtotal.toFixed(2) },
                tax_total: { currency_code: "USD", value: quote.gst.toFixed(2) },
              },
            },
            items: [
              {
                name: quote.name,
                quantity: "1",
                unit_amount: { currency_code: "USD", value: quote.subtotal.toFixed(2) },
                tax: { currency_code: "USD", value: quote.gst.toFixed(2) },
                category: "DIGITAL_GOODS",
              },
            ],
          },
        ],
        application_context: {
          brand_name: "Screen Time Tracker — Fenwick Labs",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          // BILLING = card/guest first; reduces “log in with other credentials” vs forced LOGIN
          landing_page: "BILLING",
          return_url: `${siteUrl()}/success.html?${returnQs.toString()}`,
          cancel_url: `${siteUrl()}/checkout.html?cancel=1&email=${encodeURIComponent(billingEmail)}`,
        },
      }),
    });

    const orderData = await orderRes.json();
    if (!orderRes.ok) {
      return res.status(orderRes.status).json({
        error: orderData.message || "PayPal order failed",
        details: orderData,
        mode,
      });
    }

    await sbFetch(`/rest/v1/stt_checkout_sessions`, {
      method: "POST",
      body: { ...sessionRow, order_id: orderData.id },
    }).catch(() => {});

    const approve = (orderData.links || []).find((l) => l.rel === "approve")?.href;
    if (!approve) {
      return res.status(502).json({ error: "No PayPal approve URL", details: orderData, mode });
    }

    return res.status(200).json({
      success: true,
      order_id: orderData.id,
      status: orderData.status,
      amount,
      currency: "USD",
      quote,
      approve_url: approve,
      mode,
      paypal_is_sandbox: mode === "sandbox",
      user_id: userId,
    });
  } catch (err) {
    console.error("[STT PayPal create]", err);
    return res.status(500).json({ error: err.message });
  }
}
