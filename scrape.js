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
    if (await inputs.count()) { await inputs.nth(0).fill(String(SEND_KRW_AMOUNT)); await page.waitForTimeout(800); }
  } catch {}

  // try selecting base currency
  try { await page.getByText(base, { exact:false }).first().click({ timeout:1200 }); } catch {}

  // read a nearby container around labels like "You get"/"받는 금액"
  const body = await page.innerText("body").catch(()=> "");
  const amt = pickReceiveAmount(body, base);
  return Number.isFinite(amt) && amt > 0 ? (amt / SEND_KRW_AMOUNT) : NaN; // BASE per KRW
}

async function scrape_e9pay(page, base="VND") {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000 });
  await clickSome(page, ["동의","확인","허용","Accept","Agree"]);
  await waitIdle(page);

  // enter KRW amount
  try {
    const inputs = page.locator("input[type=number], input[mode=numeric], input[inputmode=numeric]");
    if (await inputs.count()) { await inputs.nth(0).fill(String(SEND_KRW_AMOUNT)); await page.waitForTimeout(1000); }
  } catch {}

  // select base currency if visible
  try { await page.getByText(base, { exact:false }).first().click({ timeout:1200 }); } catch {}

  // prefer blocks containing receive words
  let container = await page.innerText("body").catch(()=> "");
  try {
    const el = page.getByText(/(송금 받는 금액|수취|받는 금액|Receive)/, { exact:false }).first();
    if (await el.count()) {
      container = await el.evaluate(node => {
        const box = node.closest("section,article,div,li,form") || node.parentElement;
        return box ? box.innerText : node.innerText;
      });
    }
  } catch {}

  const amt = pickReceiveAmount(container, base);
  return Number.isFinite(amt) && amt > 0 ? (amt / SEND_KRW_AMOUNT) : NaN; // BASE per KRW
}

async function scrape_gme(page, base="VND", quote="KRW") {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000 });
  await clickSome(page, ["Accept","Agree","동의","확인"]);
  await waitIdle(page);

  // If they show text "1 VND = 0.053 KRW"
  const html = await page.content();
  const rx = new RegExp(`1\\s*${base}\\s*=\\s*([\\d,\\.]+)\\s*${quote}`);
  const m = html.match(rx);
  if (m && m[1]) {
    const krwPerBase = parseFloat(m[1].replace(/,/g,""));
    if (krwPerBase > 0) return 1.0 / krwPerBase; // BASE per KRW
  }
  return NaN; // often app-only
}

// ---------- main loop ----------
export async function scrapeAll() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "en-US" });

  const rows = [];
  for (const [base, quote] of PAIRS) {
    for (const site of SITES) {
      try {
        let implied = NaN;
        if (site === "gmoneytrans") implied = await scrape_gmoneytrans(page, base);
        else if (site === "e9pay") implied = await scrape_e9pay(page, base);
        else if (site === "gme") implied = await scrape_gme(page, base, quote);

        let mid = null, margin_abs = null, margin_pct = null, ok = false, err = null;
        const mid_raw = await getMid(base, quote);          // KRW per BASE
        mid = mid_raw;
        if (!Number.isNaN(implied)) {
          const mid_base_per_krw = 1.0 / mid_raw;          // BASE per KRW
          // sanity gate: implied must be within ±40% of mid (tune if needed)
          if (implied > mid_base_per_krw * 0.6 && implied < mid_base_per_krw * 1.4) {
            margin_abs = implied - mid_base_per_krw;
            margin_pct = margin_abs / mid_base_per_krw;
            ok = true;
          } else {
            err = `sanity fail: implied ${implied} vs mid_base_per_KRW ${mid_base_per_krw}`;
            implied = null;
          }
        } else {
          err = "no implied rate found";
        }

        rows.push({
          ts: nowLocalISO(),
          site,
          pair: `${base}/${quote}`,
          implied_base_per_KRW: implied,
          mid_raw_from_api: mid,
          margin_abs_base_per_KRW: margin_abs,
          margin_pct,
          ok,
          error: err
        });

      } catch (e) {
        rows.push({
          ts: nowLocalISO(),
          site,
          pair: `${base}/${quote}`,
          implied_base_per_KRW: null,
          mid_raw_from_api: null,
          margin_abs_base_per_KRW: null,
          margin_pct: null,
          ok: false,
          error: (e?.message || String(e)).slice(0,200)
        });
      }
    }
  }

  await browser.close();
  return rows;
}
