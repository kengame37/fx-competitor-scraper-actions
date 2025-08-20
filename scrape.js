// scrape.js
import { chromium } from "playwright";

const PAIRS = [
  ["VND", "KRW"],
  ["CNY", "KRW"],
  ["NPR", "KRW"],
  ["KHR", "KRW"],
];

const SITES = ["e9pay", "gmoneytrans", "gme"];

// country labels we try clicking, per site (multiple fallbacks)
const LABELS = {
  e9pay: {
    VND: ["VI", "Vietnam", "베트남"],
    CNY: ["CHN", "China", "중국"],
    NPR: ["NP", "Nepal", "네팔"],
    KHR: ["KH", "Cambodia", "캄보디아"],
  },
  gmoneytrans: {
    VND: ["Vietnam"],
    CNY: ["China"],
    NPR: ["Nepal"],
    KHR: ["Cambodia"],
  },
  gme: {
    VND: ["Vietnam"],
    CNY: ["China"],
    NPR: ["Nepal"],
    KHR: ["Cambodia"],
  },
};

const SEND_KRW = "1000000"; // we use it to wake the calculators, but we NEVER parse it

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => {
  if (!s) return NaN;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/g);
  return m ? parseFloat(m[m.length - 1]) : NaN; // last number in the string
};

async function clickAny(page, texts) {
  for (const t of texts) {
    try {
      const el = page.getByText(t, { exact: false }).first();
      if (await el.count()) {
        await el.click({ timeout: 1500 });
        await sleep(300);
        return true;
      }
    } catch {}
  }
  return false;
}

async function e9payKRWperBASE(page, base) {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000, waitUntil: "domcontentloaded" });
  await clickAny(page, ["동의", "확인", "Accept", "Agree"]);
  await sleep(600);

  // Try to pick the country from the little language/country list
  try {
    // open the language/country popover near the top (where it shows KOR/flags)
    await clickAny(page, ["KOR", "English", "언어", "language"]);
    await clickAny(page, LABELS.e9pay[base] || []);
    await sleep(800);
  } catch {}

  // e9pay shows:  "1 CNY = 194.96 KRW" in #display-exrate
  await page.waitForSelector("#display-exrate", { timeout: 10000 });
  const t = await page.locator("#display-exrate").innerText();

  const m = t.replace(/\s+/g, " ").match(new RegExp(`1\\s*${base}\\s*=\\s*([\\d,.]+)\\s*KRW`, "i"));
  if (m) return parseFloat(m[1].replace(/,/g, ""));

  // fallback: take the last number from the element
  return num(t);
}

async function gmoneyKRWperBASE(page, base) {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000, waitUntil: "domcontentloaded" });
  await sleep(800);

  // Pick receiving country
  await clickAny(page, ["Receiving Country", "Select Country", "국가"]);
  await clickAny(page, LABELS.gmoneytrans[base] || []);
  await sleep(600);

  // Fill the KRW amount to trigger calculation
  try {
    const amt = page.locator('input[type="text"], input[type="number"]');
    if (await amt.count()) {
      await amt.first().fill(SEND_KRW);
    }
  } catch {}
  await sleep(800);

  // gmoneytrans shows: "1 KRW = 0.005119 CNY" in #rate
  await page.waitForSelector("#rate", { timeout: 10000 });
  const t = await page.locator("#rate").innerText();

  const m = t.replace(/\s+/g, " ").match(/1\s*KRW\s*=\s*([\d.,]+)\s*[A-Z]+/i);
  if (!m) return NaN;
  const basePerKRW = parseFloat(m[1].replace(/,/g, ""));
  if (!basePerKRW || isNaN(basePerKRW)) return NaN;

  // We need KRW per BASE -> invert
  return 1 / basePerKRW;
}

async function gmeKRWperBASE(page, base) {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000, waitUntil: "domcontentloaded" });
  await sleep(800);
  await clickAny(page, ["Accept", "동의", "확인"]);

  // Pick recipient country so the currency changes
  await clickAny(page, ["Select Your Country", "Select Country", "국가"]);
  await clickAny(page, LABELS.gme[base] || []);
  await sleep(800);

  // GME shows a small number in #currentRate (BASE per KRW) → invert it
  await page.waitForSelector("#currentRate", { timeout: 10000 });
  const t = (await page.locator("#currentRate").innerText()) || "";
  const basePerKRW = num(t);
  if (!basePerKRW || isNaN(basePerKRW)) return NaN;

  return 1 / basePerKRW; // KRW per BASE
}

export async function scrapeAll() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "en-US" });

  const rows = [];

  for (const [base, quote] of PAIRS) {
    const siteVals = {};
    const notes = [];

    // e9pay
    try {
      siteVals.e9pay = await e9payKRWperBASE(page, base);
      if (!siteVals.e9pay || !isFinite(siteVals.e9pay)) {
        notes.push("e9pay: no implied rate");
        siteVals.e9pay = null;
      }
    } catch (e) {
      notes.push("e9pay: " + (e?.message || "error"));
      siteVals.e9pay = null;
    }

    // gmoneytrans
    try {
      siteVals.gmoneytrans = await gmoneyKRWperBASE(page, base);
      if (!siteVals.gmoneytrans || !isFinite(siteVals.gmoneytrans)) {
        notes.push("gmoneytrans: no implied rate");
        siteVals.gmoneytrans = null;
      }
    } catch (e) {
      notes.push("gmoneytrans: " + (e?.message || "error"));
      siteVals.gmoneytrans = null;
    }

    // gme
    try {
      siteVals.gme = await gmeKRWperBASE(page, base);
      if (!siteVals.gme || !isFinite(siteVals.gme)) {
        notes.push("gme: no implied rate");
        siteVals.gme = null;
      }
    } catch (e) {
      notes.push("gme: " + (e?.message || "error"));
      siteVals.gme = null;
    }

    // choose best site/value among non-null
    const candidates = Object.entries(siteVals).filter(([, v]) => v != null && isFinite(v));
    let bestSite = "", bestRate = null;
    if (candidates.length) {
      candidates.sort((a, b) => b[1] - a[1]); // highest KRW per BASE is best
      [bestSite, bestRate] = candidates[0];
    }

    rows.push({
      base,
      quote,
      e9pay_krw_per_base: siteVals.e9pay,
      gmoney_krw_per_base: siteVals.gmoneytrans,
      gme_krw_per_base: siteVals.gme,
      best_site: bestSite || "",
      best_rate_krw_per_base: bestRate ?? "",
      notes: notes.join(" | ") || "",
    });
  }

  await browser.close();
  return rows;
}
