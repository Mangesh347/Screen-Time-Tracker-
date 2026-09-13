/**
 * Catch-all webhooks router — one function for /api/webhooks/*
 * Preserves raw-body parsing required for PayPal/Razorpay signature verify.
 */
import paypalWebhook from "../_lib/handlers/webhook-paypal.js";
import razorpayWebhook from "../_lib/handlers/webhook-razorpay.js";

export const config = { api: { bodyParser: false } };

const ROUTES = {
  paypal: paypalWebhook,
  razorpay: razorpayWebhook,
};

function routeKey(req) {
  const p = req.query?.path;
  if (Array.isArray(p) && p.length) return String(p[0] || "").toLowerCase();
  if (typeof p === "string" && p) return p.split("/")[0].toLowerCase();
  const url = String(req.url || "");
  const m = url.match(/\/api\/webhooks\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

export default async function handler(req, res) {
  const key = routeKey(req);
  const fn = ROUTES[key];
  if (!fn) {
    return res.status(404).json({
      error: "Unknown webhook endpoint",
      path: key || null,
      available: Object.keys(ROUTES),
    });
  }
  return fn(req, res);
}
