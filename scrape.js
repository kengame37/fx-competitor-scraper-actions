import { chromium } from "playwright";

const PAIRS = [["USD","KRW"],["CNY","KRW"],["NPR","KRW"],["KHR","KRW"]];
const SITES = ["gmoneytrans","e9pay","gme"];
const SEND_KRW_AMOUNT = 1_000_000;

// ---- add per-row timestamp (uses the runner's TZ) ----
function nowLocalISO() {
  const d = new Date(); // respects TZ from workflow env
  const pad = n => String(n).padStart(2, "0");
  const y = d.getFullYear(), m = pad(d.getMonth()+1), day = pad(d.getDate());
  const hh = pad(d.getHours()), mm = pad(d.getMinutes()), ss = pad(d.getSeconds());
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off)/60)), om = pad(Math.abs(off)%60);
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}${sign}${oh}:${om}`;
}

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
function cleanAmount(txt) {
  if (!txt || txt.includes("%")) return NaN; // ignore percents (fees)
  const m = txt.replaceAll("\xa0"," ").match(/[-+]?\d[\d,]*\.?\d*/g);
  if (!m) return NaN;
  return Math.max(...m.map(s => parseFloat(s.replace(/,/g,""))).filter(v => !Number.isNaN(v)));
}
async function clickSome(page, labels) {
  for (const t of labels) {
    try {
      const el = page.getByText(t, { exact:false }).first();
      if (await el.count()) await el.click({ timeout: 1200 });
    } catch {}
  }
}
async function waitIdle(page) {
  try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
  await page.waitForTimeout(800);
}

async function scrape_gmoneytrans(page, base="USD") {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000 });
  await clickSome(page, ["Accept","Agree","동의","확인","OK"]);
  await waitIdle(page);
  try {
    const inputs = page.locator("input[type=number], input[mode=numeric], input[inputmode=numeric]");
    if (await inputs.count()) { await inputs.nth(0).fill(String(SEND_KRW_AMOUNT)); await page.waitForTimeout(800); }
  } catch {}
  try { await page.getByText(base, { exact:false }).first().click({ timeout:1200 }); } catch {}
  const body = await page.innerText("body").catch(()=> "");
  const val = cleanAmount(body);
  return (!Number.isNaN(val) && val>0) ? (val / SEND_KRW_AMOUNT) : NaN;
}

async function scrape_e9pay(page, base="USD") {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000 });
  await clickSome(page, ["동의","확인","허용","Accept","Agree"]);
  await waitIdle(page);
  try {
    const inputs = page.locator("input[type=number], input[mode=numeric], input[inputmode=numeric]");
    if (await inputs.count()) { await inputs.nth(0).fill(String(SEND_KRW_AMOUNT)); await page.waitForTimeout(1000); }
  } catch {}
  try { await page.getByText(base, { exact:false }).first().click({ timeout:1200 }); } catch {}
  const nearby = await page.innerText("body").catch(()=> "");
  const val = cleanAmount(nearby);                         // e.g., ~700–900 (USD received)
  return (!Number.isNaN(val) && val>0) ? (val / SEND_KRW_AMOUNT) : NaN; // BASE per KRW
}

async function scrape_gme(page, base="USD", quote="KRW") {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000 });
  await clickSome(page, ["Accept","Agree","동의","확인"]);
  await waitIdle(page);
  const html = await page.content();
  const m = html.match(new RegExp(`1\\s*${base}\\s*=\\s*([\\d,\\.]+)\\s*${quote}`));
  if (m && m[1]) return 1.0 / parseFloat(m[1].replace(/,/g,""));
  return NaN;
}

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
          // sanity gate: implied must be within ±40% of mid
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

        // ---- include per-row timestamp here ----
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
