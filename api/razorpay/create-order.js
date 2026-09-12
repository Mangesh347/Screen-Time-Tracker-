import Razorpay from "razorpay";
import { quoteINR, computeExpiresAt, paymentMode, getPlan } from "../_lib/pricing.js";
import { resolveCheckoutUser } from "../_lib/auth.js";
import { sbFetch } from "../_lib/supabase.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const mode = paymentMode();
  const keyId =
    mode === "live"
      ? process.env.RAZORPAY_LIVE_KEY_ID || process.env.RAZORPAY_KEY_ID
      : process.env.RAZORPAY_TEST_KEY_ID || process.env.RAZORPAY_KEY_ID;
  const keySecret =
    mode === "live"
      ? process.env.RAZORPAY_LIVE_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET
      : process.env.RAZORPAY_TEST_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET;

  try {
    const body = req.body || {};
    const { cycle = "yearly", email = "" } = body;
    const authUser = await resolveCheckoutUser(req, body);
    const plan = getPlan(cycle);
    const quote = quoteINR(cycle);
    const receiptId = `stt_${quote.cycle}_${Date.now()}`.slice(0, 40);

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
      provider: "razorpay",
      cycle: plan.id,
      currency: "INR",
      amount: quote.total,
      status: "created",
      expires_at: computeExpiresAt(plan.id),
      duration_days: plan.days,
      metadata: { mode, receipt: receiptId },
    };

    if (!keyId || !keySecret || String(keyId).includes("placeholder")) {
      return res.status(503).json({
        error: "razorpay_keys_missing",
        message:
          "Add RAZORPAY_TEST_KEY_ID + RAZORPAY_TEST_KEY_SECRET in Vercel env (test mode keys start with rzp_test_), set MODE=sandbox, redeploy.",
        mode,
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
        user_id: userId,
      },
    });

    await sbFetch(`/rest/v1/stt_checkout_sessions`, {
      method: "POST",
      body: { ...sessionRow, order_id: order.id },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      key_id: keyId,
      quote,
      mode,
      user_id: userId,
    });
  } catch (err) {
    console.error("[STT Razorpay create]", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
