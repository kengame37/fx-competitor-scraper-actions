import { chromium } from "playwright";

const PAIRS = [["USD","KRW"],["CNY","KRW"],["NPR","KRW"],["KHR","KRW"]];
const SITES = ["gmoneytrans","e9pay","gme"];
const SEND_KRW_AMOUNT = 1_000_000;

// ---------- helpers ----------
async function fetchJSON(url) {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch {
    throw new Error(`mid payload not JSON (len ${text.length})`);
  }
}

async function getMid(base, quote) {
  // primary
  try {
    const u = `https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`;
    const js = await fetchJSON(u);
    if (js && js.rates && js.rates[quote] != null) return js.rates[quote];
    throw new Error("mid payload missing rates");
  } catch (e1) {
    // fallback provider
    const u2 = `https://open.er-api.com/v6/latest/${base}`;
    const js2 = await fetchJSON(u2);
    if (js2 && js2.result === "success" && js2.rates && js2.rates[quote] != null) return js2.rates[quote];
    throw new Error(`mid fetch failed for ${base}/${quote}: ${e1.message}`);
  }
}

function cleanAmount(txt) {
  if (!txt) return NaN;
  const m = txt.replaceAll("\xa0"," ").match(/[-+]?\d[\d,]*\.?\d*/g);
  if (!m) return NaN;
  return parseFloat(m[m.length-1].replace(/,/g,""));
}

async function clickIfVisible(page, texts = []) {
  for (const t of texts) {
    try {
      const btn = page.getByText(t, { exact: false }).first();
      if (await btn.count()) { await btn.click({ timeout: 1500 }).catch(()=>{}); }
    } catch {}
  }
}

async function waitIdle(page) {
  try { await page.waitForLoadState("networkidle", { timeout: 10000 }); } catch {}
  await page.waitForTimeout(800);
}

function rateFromPattern(html, base="USD", quote="KRW") {
  // matches: 1 USD = 1,234.56 KRW  OR  USD 1 = KRW 1,234.56
  const patterns = [
    new RegExp(`1\\s*${base}\\s*=\\s*([\\d,\\.]+)\\s*${quote}`),
    new RegExp(`${base}\\s*1\\s*=\\s*${quote}\\s*([\\d,\\.]+)`),
    /1\s*[A-Z]{3}\s*=\s*[\d,\.]+\s*[A-Z]{3}/
  ];
  for (const rx of patterns) {
    const m = html.match(rx);
    if (m && m[1]) return 1.0 / parseFloat(m[1].replace(/,/g,"")); // KRW per BASE -> BASE per KRW
  }
  return NaN;
}

// ---------- site scrapers ----------
async function scrape_gmoneytrans(page, base="USD", quote="KRW") {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000 });
  await clickIfVisible(page, ["Accept", "Agree", "동의", "확인", "OK"]);
  await waitIdle(page);

  // try calculator page as fallback
  if (!(await page.content()).toLowerCase().includes("calculator")) {
    try { await page.goto("https://gmoneytrans.com/global-transfer/", { timeout: 60000 }); } catch {}
    await clickIfVisible(page, ["Accept", "Agree", "동의", "확인", "OK"]);
    await waitIdle(page);
  }

  // try to enter KRW amount
  try {
    const inputs = page.locator("input[type=number], input[mode=numeric], input[inputmode=numeric]");
    if (await inputs.count() > 0) {
      await inputs.nth(0).fill(String(SEND_KRW_AMOUNT));
      await page.waitForTimeout(1000);
    }
  } catch {}

  // try to select base currency
  try { await page.getByText(base, { exact:false }).first().click({ timeout: 1500 }); } catch {}

  // try to read receive amount near labels
  for (const sel of ["text=You get", "text=받는", `text=${base}`]) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        const box = el.locator("xpath=following::*[self::span or self::div or self::p][1]");
        if (await box.count()) {
          const t = (await box.first().innerText()).trim();
          const amt = cleanAmount(t);
          if (!Number.isNaN(amt) && amt > 0) return amt / SEND_KRW_AMOUNT;
        }
      }
    } catch {}
  }

  // last resort: pattern search in HTML
  const implied = rateFromPattern(await page.content(), base, quote);
  return implied; // may be NaN
}

async function scrape_e9pay(page, base="USD", quote="KRW") {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000 });
  await clickIfVisible(page, ["동의", "확인", "허용", "Accept", "Agree"]);
  await waitIdle(page);

  // type KRW send amount
  try {
    const inputs = page.locator("input[type=number], input[mode=numeric], input[inputmode=numeric]");
    if (await inputs.count() > 0) {
      await inputs.nth(0).fill(String(SEND_KRW_AMOUNT));
      await page.waitForTimeout(1000);
    }
  } catch {}

  // select currency if visible
  try { await page.getByText(base, { exact:false }).first().click({ timeout: 1500 }); } catch {}

  // read applied rate or receive amount
  for (const sel of ["text=송금 받는 금액", "text=적용 환율", `text=${base}`]) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        const box = el.locator("xpath=following::*[self::span or self::div or self::p][1]");
        if (await box.count()) {
          const t = (await box.first().innerText()).trim();
          const val = cleanAmount(t);
          if (!Number.isNaN(val) && val > 0) {
            // If this is an applied rate (KRW per BASE), invert; if it's a receive amount, divide by send amount.
            if (t.includes("환율") || t.includes("rate")) return 1.0 / val;       // KRW per BASE -> BASE per KRW
            return val / SEND_KRW_AMOUNT;                                        // BASE amount per KRW sent
          }
        }
      }
    } catch {}
  }

  const implied = rateFromPattern(await page.content(), base, quote);
  return implied;
}

async function scrape_gme(page, base="USD", quote="KRW") {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000 });
  await clickIfVisible(page, ["Accept", "Agree", "동의", "확인"]);
  await waitIdle(page);

  const implied = rateFromPattern(await page.content(), base, quote);
  return implied; // often NaN if only in app
}

// ---------- main ----------
export async function scrapeAll() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();

  const rows = [];
  for (const [base, quote] of PAIRS) {
    for (const site of SITES) {
      try {
        let implied = NaN;
        if (site === "gmoneytrans") implied = await scrape_gmoneytrans(page, base, quote);
        else if (site === "e9pay") implied = await scrape_e9pay(page, base, quote);
        else if (site === "gme") implied = await scrape_gme(page, base, quote);

        let mid = null, margin_abs = null, margin_pct = null;
        if (!Number.isNaN(implied)) {
          const mid_raw = await getMid(base, quote);         // KRW per BASE
          const mid_base_per_krw = 1.0 / mid_raw;            // BASE per KRW
          mid = mid_raw;
          margin_abs = implied - mid_base_per_krw;
          margin_pct = margin_abs / mid_base_per_krw;
        }
        rows.push({
          site,
          pair: `${base}/${quote}`,
          implied_base_per_KRW: Number.isNaN(implied) ? null : implied,
          mid_raw_from_api: mid,
          margin_abs_base_per_KRW: margin_abs,
          margin_pct: margin_pct,
          ok: !Number.isNaN(implied),
          error: null
        });
      } catch (e) {
        rows.push({
          site,
          pair: `${base}/${quote}`,
          implied_base_per_KRW: null,
          mid_raw_from_api: null,
          margin_abs_base_per_KRW: null,
          margin_pct: null,
          ok: false,
          error: (e && e.message) ? e.message.substring(0,200) : String(e).substring(0,200)
        });
      }
    }
  }

  await browser.close();
  return rows;
}
