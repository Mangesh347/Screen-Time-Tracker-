/**
 * Catch-all PayPal router — one function for /api/paypal/*
 */
import createOrder from "../_lib/handlers/paypal-create-order.js";
import captureOrder from "../_lib/handlers/paypal-capture-order.js";

const ROUTES = {
  "create-order": createOrder,
  "capture-order": captureOrder,
};

function routeKey(req) {
  const p = req.query?.path;
  if (Array.isArray(p) && p.length) return String(p[0] || "").toLowerCase();
  if (typeof p === "string" && p) return p.split("/")[0].toLowerCase();
  const url = String(req.url || "");
  const m = url.match(/\/api\/paypal\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

export default async function handler(req, res) {
  const key = routeKey(req);
  const fn = ROUTES[key];
  if (!fn) {
    return res.status(404).json({
      error: "Unknown PayPal endpoint",
      path: key || null,
      available: Object.keys(ROUTES),
    });
  }
  return fn(req, res);
}
