import { chromium } from "playwright";
import fs from "fs/promises";

const PAIRS = [
  ["VND", "KRW"],
  ["CNY", "KRW"],
  ["NPR", "KRW"],
  ["KHR", "KRW"],
];
const SITES = ["gmoneytrans", "e9pay", "gme"];

// For send-amount method (fill KRW and read BASE receive)
const SEND_KRW_AMOUNT = 100000; // 100k won

// Currency code -> optional symbol/label hints
const CODE_HINTS = {
  KRW: ["KRW", "원", "₩"],
  VND: ["VND", "₫"],
  CNY: ["CNY", "¥", "RMB", "CNH"],
  NPR: ["NPR", "रू", "Rs"],
  KHR: ["KHR", "៛"],
};

// ---------- utilities ----------

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store", headers: { "Accept": "application/json" } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error("mid payload not JSON"); }
}

async function getMid(base, quote) {
  try {
    const a = await fetchJSON(`https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`);
    if (a?.rates?.[quote] != null) return a.rates[quote]; // KRW per BASE
    throw new Error("missing rates");
  } catch (e1) {
    const b = await fetchJSON(`https://open.er-api.com/v6/latest/${base}`);
    if (b?.result === "success" && b?.rates?.[quote] != null) return b.rates[quote];
    throw new Error(`mid fetch failed: ${e1.message}`);
  }
}

function mostPlausibleNumberAroundBase(body, base, expectedBaseAmount) {
  // Find numbers adjacent to base code/symbol: "123.45 VND", "VND 123.45", etc.
  const hints = (CODE_HINTS[base] || [base]).concat(base);
  const re = new RegExp(
    `(?:${hints.join("|")})\\s*([\\d,\\.]+)|([\\d,\\.]+)\\s*(?:${hints.join("|")})`,
    "gi"
  );
  let cand = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    const raw = (m[1] || m[2] || "").replace(/,/g, "");
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) cand.push(v);
  }
  if (!cand.length) return null;

  // Choose the one closest to expectedBaseAmount
  if (Number.isFinite(expectedBaseAmount) && expectedBaseAmount > 0) {
    cand.sort((a, b) => Math.abs(a - expectedBaseAmount) - Math.abs(b - expectedBaseAmount));
  } else {
    cand.sort((a, b) => b - a); // fallback: pick largest
  }
  return cand[0] ?? null;
}

async function clickSome(page, labels) {
  for (const t of labels) {
    try {
      const el = page.getByText(t, { exact:false }).first();
      if (await el.count()) { await el.click({ timeout: 1200 }); await page.waitForTimeout(300); }
    } catch {}
  }
}
async function waitIdle(page) {
  try { await page.waitForLoadState("networkidle", { timeout: 8000 }); } catch {}
  await page.waitForTimeout(600);
}

async function saveDebug(page, name) {
  try {
    await fs.mkdir("debug", { recursive: true });
    await page.screenshot({ path: `debug/${name}.png`, fullPage: true });
    await fs.writeFile(`debug/${name}.html`, await page.content(), "utf8");
  } catch {}
}

// sanity: implied_base_per_KRW must be within ±40% of mid_base_per_KRW
function isSane(implied_base_per_KRW, mid_krw_per_base) {
  if (!Number.isFinite(implied_base_per_KRW) || implied_base_per_KRW <= 0) return false;
  if (!Number.isFinite(mid_krw_per_base) || mid_krw_per_base <= 0) return false;
  const mid_base_per_krw = 1 / mid_krw_per_base;
  return implied_base_per_KRW > mid_base_per_krw * 0.6 && implied_base_per_KRW < mid_base_per_krw * 1.4;
}

// ---------- scrapers per site ----------

async function scrape_gme(page, base="USD", quote="KRW", mid_krw_per_base) {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000 });
  await clickSome(page, ["Accept", "Agree", "동의", "확인", "OK"]);
  await waitIdle(page);

  // Try "1 BASE = X KRW"
  const html = await page.content();
  const m = html.match(new RegExp(`1\\s*${base}\\s*=\\s*([\\d,\\.]+)\\s*${quote}`, "i"));
  if (m && m[1]) {
    const krw_per_base = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(krw_per_base) && krw_per_base > 0) {
      const implied = 1 / krw_per_base; // BASE per KRW
      if (isSane(implied, mid_krw_per_base)) return { implied_base_per_KRW: implied, ok: true };
    }
  }

  await saveDebug(page, `gme-${base}`);
  return { implied_base_per_KRW: null, ok: false, error: "no 1 BASE = KRW pattern" };
}

async function scrape_e9pay(page, base="USD", quote="KRW", mid_krw_per_base) {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000 });
  await clickSome(page, ["동의","확인","허용","Accept","Agree"]);
  await waitIdle(page);

  // Try to find direct 1 BASE = KRW
  let html = await page.content();
  let m = html.match(new RegExp(`1\\s*${base}\\s*=\\s*([\\d,\\.]+)\\s*${quote}`, "i"));
  if (m && m[1]) {
    const krw_per_base = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(krw_per_base) && krw_per_base > 0) {
      const implied = 1 / krw_per_base;
      if (isSane(implied, mid_krw_per_base)) return { implied_base_per_KRW: implied, ok: true };
    }
  }

  // Fallback: type KRW and read BASE amount near BASE code
  try {
    const inputs = page.locator('input[type="number"], input[mode=numeric], input[inputmode=numeric]');
    if (await inputs.count()) {
      await inputs.first().click({ timeout: 1200 });
      await page.keyboard.press("Control+A").catch(()=>{});
      await page.keyboard.type(String(SEND_KRW_AMOUNT));
      await waitIdle(page);
    }
  } catch {}

  html = await page.innerText("body").catch(()=> "");
  const expectedBaseAmount = SEND_KRW_AMOUNT / mid_krw_per_base;
  const baseAmt = mostPlausibleNumberAroundBase(html, base, expectedBaseAmount);
  if (Number.isFinite(baseAmt) && baseAmt > 0) {
    const implied = baseAmt / SEND_KRW_AMOUNT; // BASE per KRW
    if (isSane(implied, mid_krw_per_base)) return { implied_base_per_KRW: implied, ok: true };
  }

  await saveDebug(page, `e9pay-${base}`);
  return { implied_base_per_KRW: null, ok: false, error: "no reliable amount found" };
}

async function scrape_gmoneytrans(page, base="USD", quote="KRW", mid_krw_per_base) {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000 });
  await clickSome(page, ["Accept","Agree","동의","확인","OK"]);
  await waitIdle(page);

  // Try 1 BASE = KRW
  let html = await page.content();
  let m = html.match(new RegExp(`1\\s*${base}\\s*=\\s*([\\d,\\.]+)\\s*${quote}`, "i"));
  if (m && m[1]) {
    const krw_per_base = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(krw_per_base) && krw_per_base > 0) {
      const implied = 1 / krw_per_base;
      if (isSane(implied, mid_krw_per_base)) return { implied_base_per_KRW: implied, ok: true };
    }
  }

  // Fallback: type KRW and read BASE amount near symbol/code
  try {
    const inputs = page.locator('input[type="number"], input[mode=numeric], input[inputmode=numeric]');
    if (await inputs.count()) {
      await inputs.first().click({ timeout: 1200 });
      await page.keyboard.press("Control+A").catch(()=>{});
      await page.keyboard.type(String(SEND_KRW_AMOUNT));
      await waitIdle(page);
    }
  } catch {}

  html = await page.innerText("body").catch(()=> "");
  const expectedBaseAmount = SEND_KRW_AMOUNT / mid_krw_per_base;
  const baseAmt = mostPlausibleNumberAroundBase(html, base, expectedBaseAmount);
  if (Number.isFinite(baseAmt) && baseAmt > 0) {
    const implied = baseAmt / SEND_KRW_AMOUNT;
    if (isSane(implied, mid_krw_per_base)) return { implied_base_per_KRW: implied, ok: true };
  }

  await saveDebug(page, `gmoney-${base}`);
  return { implied_base_per_KRW: null, ok: false, error: "no reliable amount found" };
}

// ---------- main driver used by index.js ----------

export async function scrapeAll() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "en-US" });

  const rows = [];
  const ts = new Date().toISOString();

  for (const [base, quote] of PAIRS) {
    const mid_krw_per_base = await getMid(base, quote);

    for (const site of SITES) {
      try {
        let res;
        if (site === "gmoneytrans") res = await scrape_gmoneytrans(page, base, quote, mid_krw_per_base);
        else if (site === "e9pay") res = await scrape_e9pay(page, base, quote, mid_krw_per_base);
        else if (site === "gme") res = await scrape_gme(page, base, quote, mid_krw_per_base);

        if (res?.ok) {
          rows.push({
            ts, site, pair: `${base}/${quote}`,
            implied_base_per_KRW: res.implied_base_per_KRW,
            mid_raw_from_api: mid_krw_per_base,
            margin_abs_base_per_KRW: res.implied_base_per_KRW - (1 / mid_krw_per_base),
            margin_pct: (res.implied_base_per_KRW / (1 / mid_krw_per_base)) - 1,
            ok: true,
            error: null
          });
        } else {
          rows.push({
            ts, site, pair: `${base}/${quote}`,
            implied_base_per_KRW: null,
            mid_raw_from_api: mid_krw_per_base,
            margin_abs_base_per_KRW: null,
            margin_pct: null,
            ok: false,
            error: res?.error || "unknown scrape failure"
          });
        }
      } catch (e) {
        rows.push({
          ts, site, pair: `${base}/${quote}`,
          implied_base_per_KRW: null,
          mid_raw_from_api: mid_krw_per_base,
          margin_abs_base_per_KRW: null, margin_pct: null,
          ok: false,
          error: (e?.message || String(e)).slice(0, 200)
        });
        await saveDebug(page, `${site}-${base}-exception`);
      }
    }
  }

  await browser.close();
  return rows;
}
