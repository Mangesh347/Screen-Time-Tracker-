/**
 * Catch-all Razorpay router — one function for /api/razorpay/*
 */
import createOrder from "../_lib/handlers/razorpay-create-order.js";
import verifyPayment from "../_lib/handlers/razorpay-verify-payment.js";

const ROUTES = {
  "create-order": createOrder,
  "verify-payment": verifyPayment,
};

function routeKey(req) {
  const p = req.query?.path;
  if (Array.isArray(p) && p.length) return String(p[0] || "").toLowerCase();
  if (typeof p === "string" && p) return p.split("/")[0].toLowerCase();
  const url = String(req.url || "");
  const m = url.match(/\/api\/razorpay\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

export default async function handler(req, res) {
  const key = routeKey(req);
  const fn = ROUTES[key];
  if (!fn) {
    return res.status(404).json({
      error: "Unknown Razorpay endpoint",
      path: key || null,
      available: Object.keys(ROUTES),
    });
  }
  return fn(req, res);
}
