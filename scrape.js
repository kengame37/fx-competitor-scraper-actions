import { chromium } from "playwright";

// ---- currencies & sites ----
const PAIRS = [["VND","KRW"],["KHR","KRW"],["CNY","KRW"],["NPR","KRW"]];
const SITES = ["gmoneytrans","e9pay","gme"];
const SEND_KRW_AMOUNT = 1_000_000; // we "send" 1,000,000 KRW to read the receive amount

// ---- per-row timestamp in your local TZ (set TZ in workflow) ----
function nowLocalISO() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  const y = d.getFullYear(), m = pad(d.getMonth()+1), day = pad(d.getDate());
  const hh = pad(d.getHours()), mm = pad(d.getMinutes()), ss = pad(d.getSeconds());
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off)/60)), om = pad(Math.abs(off)%60);
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
}

// ---- mid-rate helpers (KRW per BASE) with fallback provider ----
async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store", headers: { "Accept": "application/json" } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error("mid payload not JSON"); }
}
async function getMid(base, quote) {
  try {
    const a = await fetchJSON(`https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`);
    if (a?.rates?.[quote] != null) return a.rates[quote];
    throw new Error("missing rates");
  } catch (e1) {
    const b = await fetchJSON(`https://open.er-api.com/v6/latest/${base}`);
    if (b?.result === "success" && b?.rates?.[quote] != null) return b.rates[quote];
    throw new Error(`mid fetch failed: ${e1.message}`);
  }
}

// ---- utilities ----
function cleanNumbers(txt) {
  if (!txt) return [];
  if (txt.includes("%")) return []; // ignore fees like "0.5%"
  const m = txt.replaceAll("\xa0"," ").match(/[-+]?\d[\d,]*\.?\d*/g);
  if (!m) return [];
  return m.map(s => parseFloat(s.replace(/,/g,""))).filter(v => Number.isFinite(v));
}

// expected receive amount ranges for 1,000,000 KRW (to avoid grabbing wrong numbers)
const EXPECTED = {
  VND: [8_000_000, 40_000_000],   // ~ 18–20M typical, be generous
  KHR: [1_500_000, 5_000_000],    // ~ 2.8–3.1M typical
  CNY: [2_000, 10_000],           // ~ 4–6k typical
  NPR: [50_000, 150_000]          // ~ ~100k typical
};

async function clickSome(page, labels) {
  for (const t of labels) {
    try {
      const el = page.getByText(t, { exact:false }).first();
      if (await el.count()) await el.click({ timeout: 1200 });
    } catch {}
  }
}
async function waitIdle(page) {
  try { await page.waitForLoadState("networkidle", { timeout: 9000 }); } catch {}
  await page.waitForTimeout(800);
}

// Given a block of text, pick the number that looks like the receive amount for the BASE currency
function pickReceiveAmount(text, base) {
  const nums = cleanNumbers(text);
  if (!nums.length) return NaN;
  const [lo, hi] = EXPECTED[base] || [1, 1e12];
  // prefer a number within the expected range
  const inRange = nums.find(v => v >= lo && v <= hi);
  if (inRange) return inRange;
  // otherwise fallback to the largest number (often the receive amount)
  return Math.max(...nums);
}

// ---------- site scrapers (return implied_base_per_KRW = BASE per KRW) ----------
async function scrape_gmoneytrans(page, base="VND") {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000 });
  await clickSome(page, ["Accept","Agree","동의","확인","OK"]);
  await waitIdle(page);

  // try global calculator page too
  if (!(await page.content()).toLowerCase().includes("calculator")) {
    try { await page.goto("https://gmoneytrans.com/global-transfer/", { timeout: 60000 }); } catch {}
    await clickSome(page, ["Accept","Agree","동의","확인","OK"]);
    await waitIdle(page);
  }

  // enter KRW amount
  try {
    const inputs = page.locator("input[type=number], input[mode=numeric], input[inputmode=numeric]");
    if (await inputs.count()) { await input
