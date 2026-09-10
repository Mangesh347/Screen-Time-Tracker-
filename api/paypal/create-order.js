import { quoteUSD } from "../_lib/pricing.js";

function siteUrl() {
  return (process.env.SITE_URL || "https://screentime-tracker.vercel.app").replace(/\/$/, "");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const mode = (process.env.PAYPAL_MODE || "sandbox").toLowerCase();
  const apiBase = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

  try {
    const { cycle = "yearly", email = "" } = req.body || {};
    const quote = quoteUSD(cycle);
    const amount = quote.total.toFixed(2);
    const billingEmail = String(email || "").toLowerCase().trim();

    if (!clientId || !clientSecret) {
      return res.status(200).json({
        success: true,
        order_id: `SIM_PP_${Date.now()}`,
        status: "CREATED",
        amount,
        currency: "USD",
        quote,
        mode: "simulated_preview",
        approve_url: `${siteUrl()}/success.html?sim=1&provider=paypal&cycle=${quote.cycle}&email=${encodeURIComponent(billingEmail)}`,
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
      return res.status(502).json({ error: await tokenRes.text() });
    }
    const { access_token } = await tokenRes.json();

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
            custom_id: JSON.stringify({
              email: billingEmail,
              product: "stt",
              plan: quote.cycle,
              cycle: quote.cycle,
            }),
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
          return_url: `${siteUrl()}/checkout.html?paid=paypal&cycle=${quote.cycle}&email=${encodeURIComponent(billingEmail)}`,
          cancel_url: `${siteUrl()}/checkout.html?cancel=1`,
        },
      }),
    });

    const orderData = await orderRes.json();
    if (!orderRes.ok) {
      return res.status(orderRes.status).json({ error: orderData.message || "PayPal failed", details: orderData });
    }

    const approve = (orderData.links || []).find((l) => l.rel === "approve")?.href;
    return res.status(200).json({
      success: true,
      order_id: orderData.id,
      status: orderData.status,
      amount,
      currency: "USD",
      quote,
      approve_url: approve,
      mode,
    });
  } catch (err) {
    console.error("[STT PayPal create]", err);
    return res.status(500).json({ error: err.message });
  }
}
