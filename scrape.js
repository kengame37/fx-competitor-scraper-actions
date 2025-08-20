import { chromium } from "playwright";

// ===== WHAT TO SCRAPE =====
const PAIRS = [
  ["VND", "KRW"],
  ["KHR", "KRW"],
  ["CNY", "KRW"],
  ["NPR", "KRW"],
];
const SITES = ["gmoneytrans", "e9pay", "gme"];

const SEND_KRW_AMOUNT = 1_000_000; // we simulate sending 1,000,000 KRW

// ===== MID (KRW per BASE) =====
async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error("mid payload not JSON"); }
}
async function getMid(base, quote) {
  try {
    const a = await fetchJSON(`https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`);
    if (a?.rates?.[quote] != null) return a.rates[quote];         // KRW per BASE
    throw new Error("missing rates");
  } catch (e1) {
    const b = await fetchJSON(`https://open.er-api.com/v6/latest/${base}`);
    if (b?.result === "success" && b?.rates?.[quote] != null) return b.rates[quote];
    throw new Error(`mid fetch failed: ${e1.message}`);
  }
}

// ===== HELPERS: picking the correct receive amount =====
const EXPECTED = {
  // expected RECEIVE amounts when sending 1,000,000 KRW
  VND: [8_000_000, 40_000_000],  // ~18–20M typical
  KHR: [1_500_000, 5_000_000],   // ~2.5–3.5M typical
  CNY: [2_000, 10_000],          // ~4–6k typical
  NPR: [50_000, 150_000],        // ~100k typical
};

function toNumber(s) {
  return parseFloat(String(s).replace(/[,\s]/g, ""));
}
function allNumbers(text) {
  if (!text) return [];
  const m = text.match(/[-+]?\d[\d,]*\.?\d*/g);
  if (!m) return [];
  return m.map(toNumber).filter(Number.isFinite);
}
function numbersLabeledWithBase(text, base) {
  if (!text) return [];
  const out = [];
  // e.g., "18,900,000 VND"
  const rx1 = new RegExp(`(?:^|\\D)([0-9][\\d,\\.]+)\\s*${base}\\b`, "gi");
  // e.g., "VND 18,900,000"
  const rx2 = new RegExp(`\\b${base}\\b\\s*([0-9][\\d,\\.]+)`, "gi");
  let m;
  while ((m = rx1.exec(text)) !== null) out.push(toNumber(m[1]));
  while ((m = rx2.exec(text)) !== null) out.push(toNumber(m[1]));
  return out.filter(Number.isFinite);
}
function pickByExpected(nums, base) {
  const [lo, hi] = EXPECTED[base] || [1, 1e12];
  const inRange = nums.filter(v => v >= lo && v <= hi);
  if (inRange.length) return Math.max(...inRange); // usually "receive" is the largest in range
  return NaN;
}

// click some common consent/ok buttons
async function clickSome(page, labels) {
  for (const t of labels) {
    try {
      const el = page.getByText(t, { exact: false }).first();
      if (await el.count()) await el.click({ timeout: 1200 });
    } catch {}
  }
}
async function waitIdle(page) {
  try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
  await page.waitForTimeout(800);
}

// pull the receive amount in "base" currency, validated by expected range
async function pullReceiveAmount(page, base) {
  // 1) look across the whole page for numbers labeled with the base
  try {
    const body = await page.innerText("body").catch(()=>"");
    const labeled = numbersLabeledWithBase(body, base);
    const chosen = pickByExpected(labeled, base);
    if (Number.isFinite(chosen)) return chosen;
  } catch {}

  // 2) try a local block near "Receive / You get / 받는 금액 / 수취"
  try {
    const el = page.getByText(/(Receive|You get|받는 금액|수취)/i).first();
    if (await el.count()) {
      const txt = await el.evaluate(node => (node.closest("section,article,div,li,form") || node).innerText);
      const labeled = numbersLabeledWithBase(txt, base);
      const chosen = pickByExpected(labeled, base);
      if (Number.isFinite(chosen)) return chosen;
      const any = pickByExpected(allNumbers(txt), base);
      if (Number.isFinite(any)) return any;
    }
  } catch {}

  // 3) fallback: any number on the page within expected range
  try {
    const body = await page.innerText("body").catch(()=>"");
    const any = pickByExpected(allNumbers(body), base);
    if (Number.isFinite(any)) return any;
  } catch {}

  return NaN;
}

// ===== SITE SCRAPERS: return BASE per KRW (implied) =====
async function scrape_gmoneytrans(page, base="VND") {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000 });
  await clickSome(page, ["Accept","Agree","동의","확인","OK","허용"]);
  await waitIdle(page);

  // try to select base currency if visible
  try { await page.getByText(base, { exact:false }).first().click({ timeout:1200 }); } catch {}

  const amt = await pullReceiveAmount(page, base);
  return Number.isFinite(amt) && amt > 0 ? (amt / SEND_KRW_AMOUNT) : NaN; // BASE per KRW
}

async function scrape_e9pay(page, base="VND") {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000 });
  await clickSome(page, ["동의","확인","허용","Accept","Agree"]);
  await waitIdle(page);

  try { await page.getByText(base, { exact:false }).first().click({ timeout:1200 }); } catch {}

  const amt = await pullReceiveAmount(page, base);
  return Number.isFinite(amt) && amt > 0 ? (amt / SEND_KRW_AMOUNT) : NaN; // BASE per KRW
}

// gme site often shows "1 BASE = X KRW" — handle that explicitly, else fallback
async function scrape_gme(page, base="VND", quote="KRW") {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000 });
  await clickSome(page, ["Accept","Agree","동의","확인","허용"]);
  await waitIdle(page);

  // Try to parse "1 BASE = X KRW" (then implied BASE per KRW = 1/X)
  try {
    const html = await page.content();
    const m = html.match(new RegExp(`1\\s*${base}\\s*=\\s*([\\d,\\.]+)\\s*${quote}`, "i"));
    if (m && m[1]) {
      const x = toNumber(m[1]); // KRW per BASE
      if (x > 0) return 1 / x;  // BASE per KRW
    }
  } catch {}

  // fallback to the generic receive-amount picker
  const amt = await pullReceiveAmount(page, base);
  return Number.isFinite(amt) && amt > 0 ? (amt / SEND_KRW_AMOUNT) : NaN;
}

// ===== MAIN LOOP =====
export async function scrapeAll() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "en-US" });

  const rows = [];
  for (const [base, quote] of PAIRS) {
    for (const site of SITES) {
      const ts = new Date().toISOString();
      try {
        let implied = NaN;
        if (site === "gmoneytrans") implied = await scrape_gmoneytrans(page, base);
        else if (site === "e9pay") implied = await scrape_e9pay(page, base);
        else if (site === "gme") implied = await scrape_gme(page, base, quote);

        const mid_raw = await getMid(base, quote);     // KRW per BASE
        let ok = false, err = null;

        // sanity: implied is BASE per KRW; mid_base_per_krw = 1 / (KRW per BASE)
        const mid_base_per_krw = 1.0 / mid_raw;

        if (!Number.isNaN(implied)) {
          // keep wide band initially; we just want to filter obvious junk (year “2023”, etc.)
          if (implied > mid_base_per_krw * 0.2 && implied < mid_base_per_krw * 5.0) {
            ok = true;
          } else {
            err = `sanity fail: implied ${implied} vs mid_base_per_KRW ${mid_base_per_krw}`;
            implied = null;
          }
        } else {
          err = "no implied rate found";
        }

        rows.push({
          ts, site, pair: `${base}/${quote}`,
          implied_base_per_KRW: implied,
          mid_raw_from_api: mid_raw,
          ok, error: err
        });
      } catch (e) {
        rows.push({
          ts, site, pair: `${base}/${quote}`,
          implied_base_per_KRW: null,
          mid_raw_from_api: null,
          ok: false,
          error: (e?.message || String(e)).slice(0,200)
        });
      }
    }
  }

  await browser.close();
  return rows;
}
