import crypto from "crypto";
import Razorpay from "razorpay";
import {
  computeExpiresAt,
  quoteINR,
  getPlan,
  paymentMode,
  razorpayCredentials,
  missingRazorpayEnvVars,
  allowSimulatedCheckout,
} from "../pricing.js";
import { upsertEntitlement } from "../entitlement.js";
import { ensureCheckoutUser } from "../auth.js";
import { sbFetch } from "../supabase.js";
import { fulfillVerifiedPayment, buildSuccessRedirect } from "../fulfill.js";

async function findSession(orderId, userId, email) {
  if (!orderId) return null;
  const byOrder = await sbFetch(
    `/rest/v1/stt_checkout_sessions?order_id=eq.${encodeURIComponent(orderId)}&select=*&order=created_at.desc&limit=1`,
  );
  if (byOrder.data?.[0]) return byOrder.data[0];

  if (userId) {
    const byUser = await sbFetch(
      `/rest/v1/stt_checkout_sessions?user_id=eq.${encodeURIComponent(userId)}&order_id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`,
    );
    if (byUser.data?.[0]) return byUser.data[0];
  }

  const billingLookup = String(email || "").toLowerCase().trim();
  if (billingLookup) {
    const byEmail = await sbFetch(
      `/rest/v1/stt_checkout_sessions?email=eq.${encodeURIComponent(billingLookup)}&order_id=eq.${encodeURIComponent(orderId)}&select=*&limit=1`,
    );
    if (byEmail.data?.[0]) return byEmail.data[0];
  }
  return null;
}

async function fetchRazorpayOrderNotes(orderId, creds) {
  try {
    const rzp = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
    const order = await rzp.orders.fetch(orderId);
    return { notes: order?.notes || {}, status: order?.status };
  } catch (e) {
    console.warn("[STT Razorpay verify] order fetch failed:", e.message);
    return null;
  }
}

async function markSessionPaid({ session, userId, email, cycle, orderId, paymentId, quote, mode }) {
  if (session?.id) {
    await sbFetch(`/rest/v1/stt_checkout_sessions?id=eq.${encodeURIComponent(session.id)}`, {
      method: "PATCH",
      body: {
        status: "paid",
        payment_id: paymentId,
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
    return;
  }
  if (!orderId || !userId || !email) return;
  await sbFetch(`/rest/v1/stt_checkout_sessions`, {
    method: "POST",
    prefer: "return=minimal",
    body: {
      user_id: userId,
      email,
      provider: "razorpay",
      cycle,
      currency: "INR",
      amount: quote.total,
      status: "paid",
      order_id: orderId,
      payment_id: paymentId,
      expires_at: computeExpiresAt(cycle),
      duration_days: getPlan(cycle).days,
      metadata: { mode, via: "verify_backfill" },
      updated_at: new Date().toISOString(),
    },
  }).catch(() => {});
}

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
      ext_id = "",
    } = body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        error: "Missing payment fields",
        message: "Payment incomplete — you remain on Free.",
        is_pro: false,
      });
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
          message: "Billing email required. You remain on Free.",
          is_pro: false,
        });
      }

      const quote = quoteINR(cycle);
      const billingEmail = authUser.email || String(email || "").toLowerCase().trim();
      const expiresAt = computeExpiresAt(cycle);

      const ent = await upsertEntitlement({
        email: billingEmail,
        userId: authUser.id,
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

      if (!ent?.ok) {
        return res.status(502).json({
          error: "entitlement_write_failed",
          message: "Could not save Pro. You remain on Free.",
          is_pro: false,
        });
      }

      return res.status(200).json({
        success: true,
        plan: quote.cycle,
        cycle: quote.cycle,
        email: billingEmail,
        user_id: authUser.id,
        expiresAt,
        provider: "razorpay",
        payment_id: razorpay_payment_id,
        is_pro: true,
        mode: "simulated_preview",
        redirect: buildSuccessRedirect({
          email: billingEmail,
          cycle: quote.cycle,
          provider: "razorpay",
          userId: authUser.id,
          extId: ext_id,
        }),
      });
    }

    const missing = missingRazorpayEnvVars();
    if (missing.length) {
      return res.status(503).json({
        error: "razorpay_keys_missing",
        message: `Missing Vercel env: ${missing.join(", ")}.`,
        missing_env: missing,
        is_pro: false,
        mode,
      });
    }

    // 1) Verify with Razorpay signature FIRST — never mark Pro before this
    const expected = crypto
      .createHmac("sha256", creds.keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(400).json({
        error: "Invalid payment signature",
        message: "Payment could not be verified — you remain on Free.",
        is_pro: false,
      });
    }

    // 2) Bind to billing email / user
    const authUser = await ensureCheckoutUser(req, body);
    const orderMeta = await fetchRazorpayOrderNotes(razorpay_order_id, creds);
    const notes = orderMeta?.notes || {};

    const billingEmail =
      authUser?.email ||
      String(notes.email || email || "").toLowerCase().trim();

    if (!billingEmail || !billingEmail.includes("@")) {
      return res.status(400).json({
        error: "email_required",
        message: "Billing email required to activate Pro. Payment was received — contact support with your payment id.",
        payment_id: razorpay_payment_id,
        is_pro: false,
      });
    }

    let userId = authUser?.id || notes.user_id || null;
    if (!userId) {
      const ensured = await ensureCheckoutUser(req, { ...body, email: billingEmail, user_id: undefined });
      userId = ensured?.id || null;
    }
    if (!userId) {
      return res.status(401).json({
        error: "sign_in_required",
        message: "Could not bind Pro to this email. Sign in from the extension with the same Gmail.",
        payment_id: razorpay_payment_id,
        email: billingEmail,
        is_pro: false,
      });
    }

    const session = await findSession(razorpay_order_id, userId, billingEmail);
    const planCycle = session?.cycle || notes.cycle || notes.plan || cycle || "yearly";
    const quote = quoteINR(planCycle);
    const plan = getPlan(planCycle);

    await markSessionPaid({
      session,
      userId,
      email: billingEmail,
      cycle: plan.id,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      quote,
      mode,
    });

    // 3) Write Pro + deadline to Supabase ONLY after provider verify
    const result = await fulfillVerifiedPayment({
      provider: "razorpay",
      eventId: `rzp_verify_${razorpay_payment_id}`,
      eventType: "client_verify",
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      userId,
      email: billingEmail,
      cycle: plan.id,
      amount: quote.total,
      currency: "INR",
      mode,
      extId: ext_id,
      metadata: { via: "vercel_verify", session_found: !!session },
      payload: body,
    });

    if (!result.ok) {
      return res.status(result.status || 502).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error("[STT Razorpay verify]", err);
    return res.status(500).json({
      error: err.message,
      message: "Verification error — you remain on Free. If you were charged, contact support with your payment id.",
      is_pro: false,
    });
  }
}
