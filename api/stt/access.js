/**
 * GET /api/stt/access?email=
 * Used by the Chrome extension to refresh Pro entitlement.
 * Also accepts Authorization: Bearer <supabase access token>
 */
import { findEntitlementByEmail, normalizeEmail } from "../_lib/entitlement.js";
import { supabaseConfig } from "../_lib/supabase.js";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

async function emailFromToken(token) {
  const { url, key } = supabaseConfig();
  if (!url || !key || !token) return null;
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return normalizeEmail(user.email);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    let email = normalizeEmail(req.query?.email || "");
    const auth = req.headers.authorization || "";
    if (auth.startsWith("Bearer ")) {
      const fromTok = await emailFromToken(auth.slice(7).trim());
      if (fromTok) email = fromTok;
    }

    if (!email) {
      return res.status(200).json({ plan: "free", pro: false, providers: ["paypal", "razorpay"] });
    }

    const row = await findEntitlementByEmail(email);
    if (!row) {
      return res.status(200).json({
        plan: "free",
        pro: false,
        email,
        providers: ["paypal", "razorpay"],
      });
    }

    const plan = row.plan || row.cycle || "yearly";
    return res.status(200).json({
      plan,
      cycle: row.cycle || plan,
      pro: true,
      provider: row.provider || null,
      expiresAt: row.expires_at || null,
      email,
      status: row.status || "active",
      providers: ["paypal", "razorpay"],
    });
  } catch (err) {
    console.error("[stt/access]", err);
    return res.status(500).json({ error: err.message || "access failed" });
  }
}
