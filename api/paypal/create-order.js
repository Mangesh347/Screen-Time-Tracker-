import { quoteUSD, computeExpiresAt, paymentMode, getPlan } from "../_lib/pricing.js";
import { resolveCheckoutUser } from "../_lib/auth.js";
import { sbFetch } from "../_lib/supabase.js";

function siteUrl() {
  return (process.env.SITE_URL || "https://screen-time-tracker-seven.vercel.app").replace(/\/$/, "");
}

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
    const { cycle = "yearly", email = "" } = body;
    const authUser = await resolveCheckoutUser(req, body);
    const plan = getPlan(cycle);
    const quote = quoteUSD(cycle);
    const amount = quote.total.toFixed(2);

    if (!authUser?.id) {
      return res.status(401).json({
        error: "sign_in_required",
        message: "Sign in to Screen Time Tracker first, then open checkout from the extension (Pro tab).",
      });
    }

    const userId = authUser.id;
    const billingEmail = authUser.email || String(email || "").toLowerCase().trim();

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

    if (!clientId || !clientSecret) {
      return res.status(503).json({
        error: "paypal_keys_missing",
        message:
          "Add PAYPAL_TEST_CLIENT_ID + PAYPAL_TEST_CLIENT_SECRET (sandbox) in Vercel env, set MODE=sandbox, redeploy.",
        mode,
      });
    }

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
      paid: "paypal",
      cycle: quote.cycle,
      email: billingEmail,
      user_id: userId,
    });
    if (extId) returnQs.set("ext_id", extId);
    if (body.access_token) returnQs.set("access_token", String(body.access_token).slice(0, 2000));

    const orderRes = await fetch(`${apiBase}/v2/checkout/orders`, {
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
          return_url: `${siteUrl()}/checkout.html?${returnQs.toString()}`,
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
      user_id: userId,
    });
  } catch (err) {
    console.error("[STT PayPal create]", err);
    return res.status(500).json({ error: err.message });
  }
}
