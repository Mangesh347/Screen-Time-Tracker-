/**
 * Recover Pro after a successful Razorpay charge when client verify failed.
 * Fetches payment from Razorpay — only unlocks if status is captured/authorized.
 *
 * POST { payment_id, email, order_id?, cycle?, ext_id? }
 */
import Razorpay from "razorpay";
import {
  quoteINR,
  getPlan,
  paymentMode,
  razorpayCredentials,
  missingRazorpayEnvVars,
} from "../pricing.js";
import { ensureCheckoutUser } from "../auth.js";
import { fulfillVerifiedPayment } from "../fulfill.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const mode = paymentMode();
  const creds = razorpayCredentials();
  const missing = missingRazorpayEnvVars();
  if (missing.length) {
    return res.status(503).json({
      error: "razorpay_keys_missing",
      missing_env: missing,
      is_pro: false,
      mode,
    });
  }

  try {
    const body = req.body || {};
    const paymentId = String(body.payment_id || body.razorpay_payment_id || "").trim();
    const orderIdHint = String(body.order_id || body.razorpay_order_id || "").trim();
    const emailHint = String(body.email || "").toLowerCase().trim();
    const extId = String(body.ext_id || "").replace(/[^a-z0-9]/gi, "");

    if (!paymentId) {
      return res.status(400).json({ error: "payment_id required", is_pro: false });
    }

    const rzp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
    const payment = await rzp.payments.fetch(paymentId);
    const status = String(payment?.status || "").toLowerCase();
    if (!["captured", "authorized"].includes(status)) {
      return res.status(400).json({
        error: "payment_not_captured",
        message: `Razorpay status is "${status || "unknown"}" — you remain on Free until payment is captured.`,
        is_pro: false,
      });
    }

    const notes = payment.notes || {};
    let orderNotes = {};
    const orderId = orderIdHint || payment.order_id || "";
    if (orderId) {
      try {
        const order = await rzp.orders.fetch(orderId);
        orderNotes = order?.notes || {};
      } catch {}
    }

    const billingEmail =
      emailHint ||
      String(notes.email || orderNotes.email || payment.email || "").toLowerCase().trim();

    if (!billingEmail || !billingEmail.includes("@")) {
      return res.status(400).json({
        error: "email_required",
        message: "Provide the billing email used at checkout.",
        is_pro: false,
      });
    }

    const notedEmail = String(notes.email || orderNotes.email || "").toLowerCase().trim();
    if (notedEmail && notedEmail !== billingEmail) {
      return res.status(403).json({
        error: "email_mismatch",
        message: "This payment is bound to a different billing email.",
        is_pro: false,
      });
    }

    const authUser = await ensureCheckoutUser(req, {
      ...body,
      email: billingEmail,
      user_id: notes.user_id || orderNotes.user_id || body.user_id,
    });
    if (!authUser?.id) {
      return res.status(401).json({
        error: "sign_in_required",
        message: "Could not resolve an account for this email. You remain on Free.",
        is_pro: false,
      });
    }

    const planCycle = notes.cycle || orderNotes.cycle || orderNotes.plan || body.cycle || "yearly";
    const quote = quoteINR(planCycle);
    const plan = getPlan(planCycle);

    const result = await fulfillVerifiedPayment({
      provider: "razorpay",
      eventId: `rzp_claim_${paymentId}`,
      eventType: "manual_claim",
      paymentId,
      orderId,
      userId: authUser.id,
      email: billingEmail,
      cycle: plan.id,
      amount: typeof payment.amount === "number" ? payment.amount / 100 : quote.total,
      currency: payment.currency || "INR",
      mode,
      extId,
      metadata: { via: "claim_payment", status },
      payload: { payment_id: paymentId, status },
    });

    if (!result.ok) {
      return res.status(result.status || 502).json(result);
    }

    return res.status(200).json({ ...result, recovered: true });
  } catch (err) {
    console.error("[STT Razorpay claim]", err);
    return res.status(500).json({
      error: err.message || String(err),
      message: "Claim failed — you remain on Free.",
      is_pro: false,
    });
  }
}
