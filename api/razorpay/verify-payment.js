import crypto from "crypto";
import { computeExpiresAt, quoteINR } from "../_lib/pricing.js";
import { upsertEntitlement } from "../_lib/entitlement.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      email = "",
      cycle = "yearly",
    } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment fields" });
    }

    if (keySecret && !String(razorpay_order_id).startsWith("order_sim_")) {
      const expected = crypto
        .createHmac("sha256", keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(String(razorpay_signature));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: "Invalid payment signature" });
      }
    }

    const quote = quoteINR(cycle);
    const expiresAt = computeExpiresAt(cycle);
    const billingEmail = String(email || "").toLowerCase().trim();

    await upsertEntitlement({
      email: billingEmail,
      plan: quote.cycle,
      cycle: quote.cycle,
      provider: "razorpay",
      expiresAt,
      externalId: razorpay_payment_id,
    });

    return res.status(200).json({
      success: true,
      plan: quote.cycle,
      cycle: quote.cycle,
      email: billingEmail,
      expiresAt,
      provider: "razorpay",
      payment_id: razorpay_payment_id,
    });
  } catch (err) {
    console.error("[STT Razorpay verify]", err);
    return res.status(500).json({ error: err.message });
  }
}
