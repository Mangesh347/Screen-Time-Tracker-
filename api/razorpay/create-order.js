import Razorpay from "razorpay";
import { quoteINR } from "../_lib/pricing.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  try {
    const { cycle = "yearly", email = "" } = req.body || {};
    const quote = quoteINR(cycle);
    const receiptId = `stt_${quote.cycle}_${Date.now()}`.slice(0, 40);
    const billingEmail = String(email || "").toLowerCase().trim();

    if (!keyId || !keySecret) {
      return res.status(200).json({
        success: true,
        order_id: `order_sim_${Date.now()}`,
        amount: quote.amountPaise,
        currency: "INR",
        receipt: receiptId,
        key_id: keyId || "rzp_test_placeholder",
        quote,
        mode: "simulated_preview",
      });
    }

    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await rzp.orders.create({
      amount: quote.amountPaise,
      currency: "INR",
      receipt: receiptId,
      notes: {
        product: "stt",
        cycle: quote.cycle,
        email: billingEmail,
      },
    });

    return res.status(200).json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      key_id: keyId,
      quote,
    });
  } catch (err) {
    console.error("[STT Razorpay create]", err);
    return res.status(500).json({ error: err.message });
  }
}
