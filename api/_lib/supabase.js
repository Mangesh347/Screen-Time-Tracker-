/** Supabase admin helpers for STT */

export function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || "https://mproxhlssrniwlcywfhq.supabase.co").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key, ok: Boolean(url && key) };
}

export async function sbFetch(path, { method = "GET", body, prefer } = {}) {
  const { url, key, ok } = supabaseConfig();
  if (!ok) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
  if (body) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}
