import { chromium } from "playwright";

const PAIRS = [["USD","KRW"],["CNY","KRW"],["NPR","KRW"],["KHR","KRW"]];
const SITES = ["gmoneytrans","e9pay","gme"];
const SEND_KRW_AMOUNT = 1_000_000;

async function getMid(base, quote) {
  const url = `https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`mid fetch failed ${res.status}`);
  const js = await res.json();
  return js.rates[quote]; // KRW per BASE if quote = KRW
}
function cleanAmount(txt) {
  if (!txt) return NaN;
  const m = txt.replaceAll("\xa0"," ").match(/[-+]?\d[\d,]*\.?\d*/g);
  if (!m) return NaN;
  return parseFloat(m[m.length-1].replace(/,/g,""));
}

async function scrape_gmoneytrans(page, base="USD", quote="KRW") {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000 });
  if (!(await page.content()).toLowerCase().includes("calculator")) {
    try { await page.goto("https://gmoneytrans.com/global-transfer/", { timeout: 60000 }); } catch {}
  }
  try {
    const inputs = page.locator("input[type=number]");
    if (await inputs.count() > 0) {
      await inputs.nth(0).fill(String(SEND_KRW_AMOUNT));
      await page.waitForTimeout(800);
    }
  } catch {}
  try { await page.getByText(base, { exact:false }).first().click({ timeout:2000 }); await page.waitForTimeout(500); } catch {}
  let txt = null;
  for (const sel of ["text=You get","text=받는", `text=${base}`]) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        const box = el.locator("xpath=following::*[self::span or self::div][1]");
        if (await box.count()) {
          const t = (await box.first().innerText()).trim();
          if (cleanAmount(t) > 0) { txt = t; break; }
        }
      }
    } catch {}
  }
  const amt = cleanAmount(txt);
  return isNaN(amt) ? NaN : (amt / SEND_KRW_AMOUNT);
}

async function scrape_e9pay(page, base="USD", quote="KRW") {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000 });
  try {
    const inputs = page.locator("input[type=number]");
    if (await inputs.count() > 0) {
      await inputs.nth(0).fill(String(SEND_KRW_AMOUNT));
      await page.waitForTimeout(800);
    }
  } catch {}
  try { await page.getByText(base, { exact:false }).first().click({ timeout:2000 }); await page.waitForTimeout(500); } catch {}
  let txt = null;
  for (const sel of ["text=송금 받는 금액","text=적용 환율", `text=${base}`]) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) {
        const box = el.locator("xpath=following::*[self::span or self::div][1]");
        if (await box.count()) {
          const t = (await box.first().innerText()).trim();
          if (cleanAmount(t) > 0) { txt = t; break; }
        }
      }
    } catch {}
  }
  const amt = cleanAmount(txt);
  return isNaN(amt) ? NaN : (amt / SEND_KRW_AMOUNT);
}

async function scrape_gme(page, base="USD", quote="KRW") {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000 });
  try {
    const html = await page.content();
    const m = html.match(/1\s*([A-Z]{3})\s*=\s*([\d,\.]+)\s*([A-Z]{3})/);
    if (m) {
      const cur1 = m[1], val = parseFloat(m[2].replace(/,/g,"")), cur2 = m[3];
      if (cur1 === base && cur2 === quote) return 1.0 / val; // KRW per USD -> USD per KRW
    }
  } catch {}
  return NaN; // often only in app
}

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
