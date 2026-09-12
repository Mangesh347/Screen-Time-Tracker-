/**
 * Checkout client — used if linked from checkout.html; keep in sync with inline script.
 * Reads auth query params and opens real PayPal sandbox / Razorpay test checkout.
 */
/** Mirror website/api/_lib/pricing.js at INR_USD_RATE=95.12 */
const PRICES = {
  monthly: { usd: "$4.99", inr: "₹475", note: "Billed monthly · cancel anytime" },
  yearly: { usd: "$39", inr: "₹3,710", note: "Best value · ~35% off monthly" },
  lifetime: { usd: "$79", inr: "₹7,514", note: "One payment · all future updates" },
};

const params = new URLSearchParams(location.search);
const checkoutCtx = {
  email: (params.get("email") || "").trim().toLowerCase(),
  access_token: params.get("access_token") || "",
  user_id: params.get("user_id") || "",
  ext_id: (params.get("ext_id") || "").replace(/[^a-z0-9]/gi, ""),
  cycle: params.get("cycle") || "yearly",
  provider: params.get("provider") || "",
  paid: params.get("paid") || "",
  token: params.get("token") || "",
  PayerID: params.get("PayerID") || "",
};

let cycle = ["monthly", "yearly", "lifetime"].includes(checkoutCtx.cycle)
  ? checkoutCtx.cycle
  : "yearly";
const curQ = (params.get("currency") || "").toUpperCase();
let currencyMode =
  curQ === "INR" || curQ === "USD"
    ? curQ
    : checkoutCtx.provider === "razorpay"
      ? "INR"
      : "USD";

const emailEl = document.getElementById("email") || document.getElementById("buyerEmail");
const msgEl = document.getElementById("msg") || document.getElementById("statusMsg");
if (emailEl && checkoutCtx.email) emailEl.value = checkoutCtx.email;

function setMsg(text, ok) {
  if (!msgEl) return;
  msgEl.textContent = text || "";
  msgEl.className = (msgEl.classList.contains("ck-status") ? "ck-status" : "msg") +
    (ok === true ? " ok" : text ? (ok === false || ok === undefined ? " err error" : "") : "");
  if (ok === false || (text && ok !== true)) {
    if (msgEl.classList.contains("ck-status")) msgEl.className = "ck-status error";
  }
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (checkoutCtx.access_token) h.Authorization = "Bearer " + checkoutCtx.access_token;
  return h;
}

function authBody(extra = {}) {
  return {
    user_id: checkoutCtx.user_id || undefined,
    access_token: checkoutCtx.access_token || undefined,
    email: extra.email || checkoutCtx.email || undefined,
    cycle: extra.cycle || cycle,
    ext_id: checkoutCtx.ext_id || undefined,
    ...extra,
  };
}

function apiError(data, fallback) {
  return (data && (data.message || data.error)) || fallback || "Request failed";
}

function goSuccess(data) {
  const email = (data.email || checkoutCtx.email || "").trim().toLowerCase();
  const qs = new URLSearchParams({
    email,
    cycle: data.cycle || cycle,
    provider: data.provider || "",
    is_pro: data.is_pro === false ? "0" : "1",
  });
  if (checkoutCtx.ext_id) qs.set("ext_id", checkoutCtx.ext_id);
  if (checkoutCtx.user_id) qs.set("user_id", checkoutCtx.user_id);
  location.href = "/success.html?" + qs.toString();
}

function render() {
  const cyclesRoot = document.getElementById("cycles");
  if (cyclesRoot) {
    cyclesRoot.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.cycle === cycle);
    });
  }
  const p = PRICES[cycle] || PRICES.yearly;
  const priceBig = document.getElementById("priceBig");
  const priceNote = document.getElementById("priceNote");
  if (priceBig) priceBig.textContent = currencyMode === "INR" ? p.inr : p.usd;
  if (priceNote) priceNote.textContent = p.note;
}

async function payPaypal() {
  const email = (emailEl?.value || "").trim().toLowerCase();
  if (!email) return setMsg("Enter the Gmail you use in the extension", false);
  checkoutCtx.email = email;
  if (!checkoutCtx.access_token && !checkoutCtx.user_id) {
    return setMsg("Open Plans in the extension while signed in, then tap Upgrade.", false);
  }
  setMsg("Creating PayPal sandbox order…", true);
  currencyMode = "USD";
  render();
  try {
    const res = await fetch("/api/paypal/create-order", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(authBody({ cycle, email })),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(apiError(data, "PayPal failed"));
    if (!data.approve_url) throw new Error("No PayPal approve URL");
    sessionStorage.setItem(
      "stt_pp_order",
      JSON.stringify({
        order_id: data.order_id,
        email,
        cycle,
        access_token: checkoutCtx.access_token,
        user_id: checkoutCtx.user_id,
        ext_id: checkoutCtx.ext_id,
      }),
    );
    location.href = data.approve_url;
  } catch (err) {
    setMsg(err.message, false);
  }
}

async function payRazorpay() {
  const email = (emailEl?.value || "").trim().toLowerCase();
  if (!email) return setMsg("Enter the Gmail you use in the extension", false);
  checkoutCtx.email = email;
  if (!checkoutCtx.access_token && !checkoutCtx.user_id) {
    return setMsg("Open Plans in the extension while signed in, then tap Upgrade.", false);
  }
  setMsg("Opening Razorpay test checkout…", true);
  currencyMode = "INR";
  render();
  try {
    const res = await fetch("/api/razorpay/create-order", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(authBody({ cycle, email })),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(apiError(data, "Razorpay failed"));
    if (!data.key_id || !data.order_id) throw new Error("Razorpay keys missing on server");
    if (typeof Razorpay === "undefined") throw new Error("Razorpay script not loaded");

    const rzp = new Razorpay({
      key: data.key_id,
      amount: data.amount,
      currency: data.currency,
      name: "Screen Time Tracker Pro",
      description: data.quote?.desc || "Pro",
      order_id: data.order_id,
      prefill: { email },
      handler: async function (response) {
        const verify = await fetch("/api/razorpay/verify-payment", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(authBody({ ...response, email, cycle })),
        });
        const v = await verify.json().catch(() => ({}));
        if (!verify.ok || !v.success || v.is_pro !== true) {
          setMsg(apiError(v, "Payment verify failed — still Free"), false);
          return;
        }
        goSuccess(v);
      },
      modal: {
        ondismiss: function () {
          setMsg("Checkout closed. You’re still on Free.", false);
        },
      },
    });
    rzp.on("payment.failed", function (resp) {
      setMsg(
        (resp && resp.error && (resp.error.description || resp.error.reason)) ||
          "Payment failed — still Free",
        false,
      );
    });
    rzp.open();
    setMsg("");
  } catch (err) {
    setMsg(err.message, false);
  }
}

const btnPaypal = document.getElementById("btnPaypal") || document.getElementById("payPaypal");
const btnRazorpay = document.getElementById("btnRazorpay") || document.getElementById("payRazorpay");
if (btnPaypal) btnPaypal.onclick = payPaypal;
if (btnRazorpay) btnRazorpay.onclick = payRazorpay;

async function maybeCapturePaypal() {
  if (checkoutCtx.paid !== "paypal" && !checkoutCtx.token) return;
  const stored = (() => {
    try { return JSON.parse(sessionStorage.getItem("stt_pp_order") || "{}"); } catch { return {}; }
  })();
  if (stored.access_token && !checkoutCtx.access_token) checkoutCtx.access_token = stored.access_token;
  if (stored.user_id && !checkoutCtx.user_id) checkoutCtx.user_id = stored.user_id;
  if (stored.ext_id && !checkoutCtx.ext_id) checkoutCtx.ext_id = stored.ext_id;

  const orderId = checkoutCtx.token || params.get("order_id") || stored.order_id;
  const email = checkoutCtx.email || stored.email || (emailEl && emailEl.value) || "";
  const cyc = checkoutCtx.cycle || stored.cycle || cycle;
  if (!orderId) return;
  setMsg("Confirming PayPal payment…", true);
  try {
    const res = await fetch("/api/paypal/capture-order", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(authBody({ order_id: orderId, email, cycle: cyc })),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success || data.is_pro !== true) {
      throw new Error(apiError(data, "Capture failed — still Free"));
    }
    goSuccess(data);
  } catch (err) {
    setMsg(err.message, false);
  }
}

const cyclesRoot = document.getElementById("cycles");
if (cyclesRoot) {
  cyclesRoot.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cycle]");
    if (!b) return;
    cycle = b.dataset.cycle;
    render();
  });
}

render();
maybeCapturePaypal();
