/**
 * Diagnose STT supabase tables + apply minimal payment schema if missing.
 * Uses service role from Extension .env (same project as config.js).
 */
const fs = require("fs");
const path = require("path");

function loadEnv(p) {
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(p, "utf8")
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

const env = {
  ...loadEnv("C:/Users/Lenovo/Projects/Extension/.env"),
  ...loadEnv("C:/Extension/WEB SCREEN TIME (LATEST)/Screen_Time_Tracker/website/.env"),
};

const url = (env.SUPABASE_URL || "").replace(/\/$/, "");
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function tableExists(name) {
  const res = await fetch(`${url}/rest/v1/${name}?select=*&limit=1`, { headers });
  const text = await res.text();
  if (res.status === 404 || /PGRST205|Could not find the table/i.test(text)) return false;
  return res.ok || res.status === 200 || res.status === 206;
}

async function main() {
  console.log("project", url);
  for (const t of [
    "stt_profiles",
    "stt_entitlements",
    "stt_checkout_sessions",
    "stt_payment_events",
    "stt_checkout_events",
  ]) {
    console.log(t, (await tableExists(t)) ? "EXISTS" : "MISSING");
  }

  // Auth user for recovery email
  const email = "mangesh.lokade.dev@gmail.com";
  const auth = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=200`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const aj = await auth.json();
  const hit = (aj.users || []).find((u) => String(u.email || "").toLowerCase() === email);
  console.log("auth_user", hit?.id || "none");

  const sqlPath = path.join(
    "C:/Extension/WEB SCREEN TIME (LATEST)/Screen_Time_Tracker/supabase",
    "APPLY_PAYMENTS_SCHEMA.sql",
  );
  console.log("\nACTION REQUIRED:");
  console.log("1) Open Supabase SQL Editor for this project");
  console.log("2) Run file:", sqlPath);
  console.log("3) Then reopen extension signed in as", email);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
