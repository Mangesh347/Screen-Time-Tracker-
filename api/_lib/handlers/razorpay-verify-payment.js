import crypto from "crypto";
import {
  computeExpiresAt,
  quoteINR,
  getPlan,
  paymentMode,
  razorpayCredentials,
  missingRazorpayEnvVars,
  allowSimulatedCheckout,
} from "../pricing.js";
import { upsertEntitlement, claimPaymentEvent, markEventProcessed } from "../entitlement.js";
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
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      email = "",
      cycle = "yearly",
    } = body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment fields", is_pro: false });
    }

    const isSim =
      String(razorpay_order_id).startsWith("SIM_") ||
      String(razorpay_order_id).startsWith("order_sim_") ||
      String(razorpay_payment_id).startsWith("pay_sim_") ||
      String(razorpay_payment_id).startsWith("SIM_");

    if (isSim) {
      if (!allowSimulatedCheckout()) {
        return res.status(400).json({
          error: "simulated_not_allowed",
          message: "Simulated payments are disabled. Complete a real Razorpay checkout.",
          is_pro: false,
          mode,
        });
      }

      const authUser = await ensureCheckoutUser(req, body);
      if (!authUser?.id) {
        return res.status(401).json({
          error: "sign_in_required",
          message: "Authenticated user or billing email required to activate Pro.",
          is_pro: false,
        });
      }

      const userId = authUser.id;
      const quote = quoteINR(cycle);
      const plan = getPlan(cycle);
      const expiresAt = computeExpiresAt(cycle);
      const billingEmail = authUser.email || String(email || "").toLowerCase().trim();

      await upsertEntitlement({
        email: billingEmail,
        userId,
        plan: quote.cycle,
        cycle: quote.cycle,
        provider: "razorpay_simulated",
        expiresAt,
        externalId: razorpay_payment_id,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        amount: quote.total,
        currency: "INR",
        webhookVerified: false,
        metadata: { via: "simulated_preview", mode: "simulated_preview" },
      });

      return res.status(200).json({
        success: true,
        plan: quote.cycle,
        cycle: quote.cycle,
        email: billingEmail,
        user_id: userId,
        expiresAt,
        provider: "razorpay",
        payment_id: razorpay_payment_id,
        is_pro: true,
        mode: "simulated_preview",
      });
    }

    const missing = missingRazorpayEnvVars();
    if (missing.length) {
      return res.status(503).json({
        error: "razorpay_keys_missing",
        message: `Missing Vercel env: ${missing.join(", ")}. Add them, then redeploy.`,
        missing_env: missing,
        is_pro: false,
        mode,
      });
    }

    const expected = crypto
      .createHmac("sha256", creds.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({ error: "Invalid payment signature", is_pro: false });
    }

    const authUser = await ensureCheckoutUser(req, body);
    if (!authUser?.id) {
      return res.status(401).json({
        error: "sign_in_required",
        message: "Authenticated user or billing email required to activate Pro.",
        is_pro: false,
      });
    }

    const userId = authUser.id;
    const sess = await sbFetch(
      `/rest/v1/stt_checkout_sessions?user_id=eq.${encodeURIComponent(userId)}&order_id=eq.${encodeURIComponent(razorpay_order_id)}&select=*&limit=1`,
    );
    let session = sess.data?.[0];
    if (!session) {
      const billingLookup = authUser.email || String(email || "").toLowerCase().trim();
      if (billingLookup) {
        const byEmail = await sbFetch(
          `/rest/v1/stt_checkout_sessions?email=eq.${encodeURIComponent(billingLookup)}&order_id=eq.${encodeURIComponent(razorpay_order_id)}&select=*&limit=1`,
        );
        session = byEmail.data?.[0];
      }
    }
    if (!session) {
      return res.status(403).json({
        error: "Checkout session not found for this user",
        is_pro: false,
      });
    }

    const planCycle = session?.cycle || cycle;
    const quote = quoteINR(planCycle);
    const plan = getPlan(planCycle);
    const expiresAt = computeExpiresAt(planCycle);
    const billingEmail = authUser.email || String(email || "").toLowerCase().trim();

    const eventId = `rzp_verify_${razorpay_payment_id}`;
    const claim = await claimPaymentEvent({
      provider: "razorpay",
      eventId,
      eventType: "client_verify",
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      userId,
      email: billingEmail,
      cycle: plan.id,
      verified: true,
      payload: body,
    });

    if (!claim.claimed && !claim.error) {
      return res.status(200).json({
        success: true,
        plan: plan.id,
        cycle: plan.id,
        duplicate: true,
        provider: "razorpay",
        expiresAt,
        is_pro: true,
      });
    }

    await upsertEntitlement({
      email: billingEmail,
      userId,
      plan: quote.cycle,
      cycle: quote.cycle,
      provider: "razorpay",
      expiresAt,
      externalId: razorpay_payment_id,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amount: quote.total,
      currency: "INR",
      webhookVerified: true,
      metadata: { via: "vercel_verify", mode },
    });

    await markEventProcessed("razorpay", eventId, "processed");

    return res.status(200).json({
      success: true,
      plan: quote.cycle,
      cycle: quote.cycle,
      email: billingEmail,
      user_id: userId,
      expiresAt,
      provider: "razorpay",
      payment_id: razorpay_payment_id,
      is_pro: true,
      mode,
    });
  } catch (err) {
    console.error("[STT Razorpay verify]", err);
    return res.status(500).json({ error: err.message, is_pro: false });
  }
}
