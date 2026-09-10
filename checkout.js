const PRICES = {
  monthly: { usd: "$4.99", inr: "₹299", note: "Billed monthly · cancel anytime" },
  yearly: { usd: "$39", inr: "₹2,499", note: "Best value · ~35% off monthly" },
  lifetime: { usd: "$79", inr: "₹4,999", note: "One payment · all future updates" },
};

const params = new URLSearchParams(location.search);
let cycle = params.get("cycle") || "yearly";
let currencyMode = "USD";

const emailEl = document.getElementById("email");
const msgEl = document.getElementById("msg");
emailEl.value = params.get("email") || "";

function setMsg(text, ok) {
  msgEl.textContent = text || "";
  msgEl.className = "msg " + (ok ? "ok" : text ? "err" : "");
}

function render() {
  document.querySelectorAll("#cycles button").forEach((b) => {
    b.classList.toggle("on", b.dataset.cycle === cycle);
  });
  const p = PRICES[cycle] || PRICES.yearly;
  document.getElementById("priceBig").textContent = currencyMode === "INR" ? p.inr : p.usd;
  document.getElementById("priceNote").textContent = p.note;

  const sub = currencyMode === "INR"
    ? { monthly: 253, yearly: 2118, lifetime: 4236 }[cycle]
    : { monthly: 4.99, yearly: 39, lifetime: 79 }[cycle];
  const gst = Math.round(sub * 0.18 * 100) / 100;
  const total = Math.round((sub + (currencyMode === "INR" ? 0 : gst)) * 100) / 100;
  // INR list prices already GST-inclusive display
  const showGst = currencyMode === "USD";
  document.getElementById("breakdown").innerHTML = `
    <div class="row"><span>${cycle} plan</span><strong>${currencyMode === "INR" ? p.inr : "$" + sub}</strong></div>
    ${showGst ? `<div class="row"><span>GST (18%)</span><strong>$${gst.toFixed(2)}</strong></div>` : `<div class="row"><span>Taxes</span><strong>Included</strong></div>`}
    <div class="row total"><span>Total due</span><strong>${currencyMode === "INR" ? p.inr : "$" + (sub + gst).toFixed(2)}</strong></div>
  `;
}

document.getElementById("cycles").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cycle]");
  if (!b) return;
  cycle = b.dataset.cycle;
  render();
});

async function payPaypal() {
  const email = emailEl.value.trim();
  if (!email) return setMsg("Enter the Gmail you use in the extension");
  setMsg("Creating PayPal order…", true);
  currencyMode = "USD";
  render();
  try {
    const res = await fetch("/api/paypal/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cycle, email }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "PayPal failed");
    if (data.approve_url) {
      location.href = data.approve_url;
      return;
    }
    throw new Error("No PayPal approve URL");
  } catch (err) {
    setMsg(err.message);
  }
}

async function payRazorpay() {
  const email = emailEl.value.trim();
  if (!email) return setMsg("Enter the Gmail you use in the extension");
  setMsg("Opening Razorpay…", true);
  currencyMode = "INR";
  render();
  try {
    const res = await fetch("/api/razorpay/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cycle, email }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "Razorpay failed");

    if (data.mode === "simulated_preview" || String(data.order_id).startsWith("order_sim_")) {
      const verify = await fetch("/api/razorpay/verify-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_order_id: data.order_id,
          razorpay_payment_id: `pay_sim_${Date.now()}`,
          razorpay_signature: "sim",
          email,
          cycle,
        }),
      });
      const v = await verify.json();
      if (!verify.ok || !v.success) throw new Error(v.error || "Verify failed");
      location.href = `/success.html?email=${encodeURIComponent(email)}&cycle=${cycle}&provider=razorpay&sim=1`;
      return;
    }

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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...response,
            email,
            cycle,
          }),
        });
        const v = await verify.json();
        if (!verify.ok || !v.success) {
          setMsg(v.error || "Payment verify failed");
          return;
        }
        location.href = `/success.html?email=${encodeURIComponent(email)}&cycle=${cycle}&provider=razorpay`;
      },
    });
    rzp.open();
    setMsg("");
  } catch (err) {
    setMsg(err.message);
  }
}

document.getElementById("btnPaypal").onclick = payPaypal;
document.getElementById("btnRazorpay").onclick = payRazorpay;

// Return from PayPal approve
async function maybeCapturePaypal() {
  if (params.get("paid") !== "paypal") return;
  const orderId = params.get("token") || params.get("order_id");
  const email = params.get("email") || emailEl.value.trim();
  const cyc = params.get("cycle") || cycle;
  if (!orderId) return;
  setMsg("Confirming PayPal payment…", true);
  try {
    const res = await fetch("/api/paypal/capture-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: orderId, email, cycle: cyc }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "Capture failed");
    location.href = `/success.html?email=${encodeURIComponent(email)}&cycle=${cyc}&provider=paypal`;
  } catch (err) {
    setMsg(err.message);
  }
}

render();
maybeCapturePaypal();
