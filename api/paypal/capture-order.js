import { computeExpiresAt, quoteUSD } from "../_lib/pricing.js";
import { upsertEntitlement } from "../_lib/entitlement.js";

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
    const { order_id, email = "", cycle = "yearly" } = req.body || {};
    if (!order_id) return res.status(400).json({ error: "order_id required" });

    const quote = quoteUSD(cycle);
    const expiresAt = computeExpiresAt(cycle);
    const billingEmail = String(email || "").toLowerCase().trim();

    if (!clientId || !clientSecret || String(order_id).startsWith("SIM_")) {
      await upsertEntitlement({
        email: billingEmail,
        plan: quote.cycle,
        cycle: quote.cycle,
        provider: "paypal",
        expiresAt,
        externalId: order_id,
      });
      return res.status(200).json({
        success: true,
        status: "COMPLETED",
        plan: quote.cycle,
        cycle: quote.cycle,
        email: billingEmail,
        expiresAt,
        provider: "paypal",
        simulated: true,
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
    if (!tokenRes.ok) return res.status(502).json({ error: "PayPal OAuth failed" });
    const { access_token } = await tokenRes.json();

    const capRes = await fetch(`${apiBase}/v2/checkout/orders/${order_id}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
    });
    const cap = await capRes.json();
    if (!capRes.ok) {
      return res.status(capRes.status).json({ error: cap.message || "Capture failed", details: cap });
    }

    await upsertEntitlement({
      email: billingEmail,
      plan: quote.cycle,
      cycle: quote.cycle,
      provider: "paypal",
      expiresAt,
      externalId: order_id,
    });

    return res.status(200).json({
      success: true,
      status: cap.status || "COMPLETED",
      plan: quote.cycle,
      cycle: quote.cycle,
      email: billingEmail,
      expiresAt,
      provider: "paypal",
    });
  } catch (err) {
    console.error("[STT PayPal capture]", err);
    return res.status(500).json({ error: err.message });
  }
}
