import Razorpay from "razorpay";
import {
  quoteINR,
  computeExpiresAt,
  paymentMode,
  getPlan,
  razorpayCredentials,
  missingRazorpayEnvVars,
  allowSimulatedCheckout,
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
  const creds = razorpayCredentials();

  try {
    const body = req.body || {};
    const { cycle = "yearly", email = "" } = body;
    const authUser = await ensureCheckoutUser(req, body);
    const plan = getPlan(cycle);
    const quote = quoteINR(cycle);
    const receiptId = `stt_${quote.cycle}_${Date.now()}`.slice(0, 40);

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
      provider: "razorpay",
      cycle: plan.id,
      currency: "INR",
      amount: quote.total,
      status: "created",
      expires_at: computeExpiresAt(plan.id),
      duration_days: plan.days,
      metadata: { mode, receipt: receiptId },
    };

    const missing = missingRazorpayEnvVars();
    if (missing.length) {
      if (allowSimulatedCheckout()) {
        const orderId = `SIM_RZP_${Date.now()}`;
        await sbFetch(`/rest/v1/stt_checkout_sessions`, {
          method: "POST",
          body: {
            ...sessionRow,
            order_id: orderId,
            metadata: { ...sessionRow.metadata, mode: "simulated_preview", missing },
          },
        }).catch(() => {});
        return res.status(200).json({
          success: true,
          order_id: orderId,
          amount: quote.amountPaise,
          currency: "INR",
          receipt: receiptId,
          key_id: creds.keyId || "rzp_test_sim",
          quote,
          mode: "simulated_preview",
          payment_mode: mode,
          missing_env: missing,
          user_id: userId,
          message:
            "Simulated Razorpay preview — no charge. Verify will not unlock Pro unless ALLOW_SIMULATED_CHECKOUT and SIM_ order.",
        });
      }
      return res.status(503).json({
        error: "razorpay_keys_missing",
        message: `Missing Vercel env: ${missing.join(", ")}. Add them, then redeploy.`,
        missing_env: missing,
        mode,
      });
    }

    const rzp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
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
      key_id: creds.keyId,
      quote,
      mode,
      user_id: userId,
    });
  } catch (err) {
    console.error("[STT Razorpay create]", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
