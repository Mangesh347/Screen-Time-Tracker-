/**
 * Vercel Serverless Function: /api/config
 * Public client config — never exposes secrets.
 */

import {
  paymentMode,
  getInrUsdRate,
  publicPlans,
  GST_RATE,
  paypalCredentials,
  razorpayCredentials,
  allowSimulatedCheckout,
  siteUrl,
} from "./_lib/pricing.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const mode = paymentMode();
  const pp = paypalCredentials();
  const rz = razorpayCredentials();
  const { plans, inrUsdRate } = publicPlans();

  return res.status(200).json({
    paymentMode: mode,
    payment_mode: mode,
    inrUsdRate,
    inr_usd_rate: inrUsdRate,
    gst_rate: GST_RATE,
    gstRate: GST_RATE,
    plans,
    providers: {
      paypal: Boolean(pp.clientId && pp.clientSecret),
      razorpay: Boolean(rz.keyId && rz.keySecret),
    },
    // Public key ids only (safe for Checkout.js / PayPal SDK) — never secrets
    paypal_client_id: pp.clientId || "",
    razorpay_key_id: rz.keyId || "",
    allow_simulated_checkout: allowSimulatedCheckout(),
    site_url: siteUrl(),
    company_name: "Screen Time Tracker — Fenwick Labs",
    support_email: "support@fenwicklabs.com",
    checkout_url: `${siteUrl()}/checkout.html`,
  });
}
