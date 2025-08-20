// scrape.js
import { chromium } from "playwright";

const SEND_KRW = 1_000_000; // helps stabilize widgets that need an amount
const BASES = ["VND", "CNY", "NPR", "KHR"];
const SITES = ["e9pay", "gmoneytrans", "gme"];

/** Utility */
const toNumber = (s) => {
  if (!s) return NaN;
  const m = String(s).match(/[-+]?\d[\d,]*\.?\d*/g);
  if (!m) return NaN;
  return parseFloat(m[m.length - 1].replace(/,/g, ""));
};

/** mid: KRW per BASE via exchangerate.host */
async function getMidKrwPerBase(base) {
  const r = await fetch(`https://api.exchangerate.host/latest?base=${base}&symbols=KRW`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const j = await r.json().catch(() => ({}));
  return j?.rates?.KRW ?? NaN;
}

/** ----------------- SITE SCRAPERS (KRW per BASE) ------------------ */

/** E9Pay: looks like “1 CNY = 194.96 KRW” */
async function scrape_e9pay(page, base) {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  // Close cookie/permission popups if any
  for (const label of ["동의", "확인", "허용", "Agree", "Accept"]) {
    try { await page.getByText(label, { exact: false }).first().click({ timeout: 1000 }); } catch {}
  }
  // Fill amount to force calculation (if visible anywhere)
  try {
    const num = page.locator("input[type=number], input[inputmode=numeric]");
    if (await num.count()) { await num.first().fill(String(SEND_KRW)); }
  } catch {}

  // The visible rate text block near “Applicable exchange rate”
  // e.g. “1 CNY = 194.96 KRW”
  const text = await page.locator("span#display-exrate, .display-exrate, .right_box .txt_box").first().innerText().catch(() => "");
  if (!text) return { ok: false, val: NaN, note: "e9pay: rate text not found" };

  const re = new RegExp(`1\\s*${base}\\s*=\\s*([\\d,.]+)\\s*KRW`, "i");
  const m = text.match(re);
  if (!m) return { ok: false, val: NaN, note: `e9pay: pattern not found in "${text.slice(0,120)}..."` };

  return { ok: true, val: toNumber(m[1]), note: "" };
}

/** GMoneyTrans: shows “1 KRW = 0.005119 CNY” -> invert to KRW per BASE */
async function scrape_gmoney(page, base) {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  for (const label of ["동의", "확인", "Agree", "Accept"]) {
    try { await page.getByText(label, { exact: false }).first().click({ timeout: 1000 }); } catch {}
  }
  try { // put some amount
    const num = page.locator("input[type=number], input[inputmode=numeric]");
    if (await num.count()) { await num.first().fill(String(SEND_KRW)); }
  } catch {}

  // The small text near the form: e.g. “1 KRW = 0.005119 CNY”
  const txt = await page.locator("span#rate, .txt_info_group #rate").first().innerText().catch(() => "");
  if (!txt) return { ok: false, val: NaN, note: "gmoney: rate text not found" };

  const re = new RegExp(`1\\s*KRW\\s*=\\s*([\\d,.]+)\\s*${base}`, "i");
  const m = txt.match(re);
  if (!m) return { ok: false, val: NaN, note: `gmoney: pattern not found in "${txt.slice(0,120)}..."` };

  const basePerKRW = toNumber(m[1]);         // BASE per KRW
  if (!basePerKRW) return { ok: false, val: NaN, note: "gmoney: parsed zero" };

  const krwPerBase = 1 / basePerKRW;         // KRW per BASE
  return { ok: true, val: krwPerBase, note: "" };
}

/** GME: shows a tiny number like 0.000710353 (BASE per KRW) -> invert */
async function scrape_gme(page, base) {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000 });
  await page.waitForLoadState("domcontentloaded");
  for (const label of ["동의", "확인", "Agree", "Accept"]) {
    try { await page.getByText(label, { exact: false }).first().click({ timeout: 1000 }); } catch {}
  }

  // The widget is KRW -> (country). We read the “Real Time Exchange Rate”:
  // it's BASE per KRW (very small). Invert to get KRW per BASE.
  const t = await page.locator("#currentRate, span#currentRate, #rate span#currentRate").first().innerText().catch(() => "");
  const v = toNumber(t);
  if (!v) return { ok: false, val: NaN, note: `gme: rate missing at currentRate (text="${t}")` };

  return { ok: true, val: 1 / v, note: "" };
}

/** --------------------------------------------------------------- */

export async function scrapeOnce() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "en-US" });

  const out = []; // rows with: {base, site, krwPerBase, mid, note}

  for (const base of BASES) {
    const mid = await getMidKrwPerBase(base).catch(() => NaN);

    for (const site of SITES) {
      let r = { ok: false, val: NaN, note: "" };
      try {
        if (site === "e9pay") r = await scrape_e9pay(page, base);
        if (site === "gmoneytrans") r = await scrape_gmoney(page, base);
        if (site === "gme") r = await scrape_gme(page, base);
      } catch (e) {
        r = { ok: false, val: NaN, note: `${site}: ${e?.message?.slice(0,120) || e}` };
      }

      out.push({
        base, site,
        krwPerBase: Number.isFinite(r.val) ? r.val : 0,
        mid: Number.isFinite(mid) ? mid : 0,
        note: r.note || "",
      });
    }
  }

  await browser.close();
  return out;
}
