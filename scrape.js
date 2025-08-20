// scrape.js
import { chromium } from "playwright";

const PAIRS = [
  ["VND","KRW"],
  ["CNY","KRW"],
  ["NPR","KRW"],
  ["KHR","KRW"],
];

const SITES = ["e9pay","gmoneytrans","gme"];

// ---------- helpers ----------
async function fetchJSON(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error("mid payload not JSON"); }
}
async function getMidKRWperBASE(base) {
  // returns KRW per BASE
  try {
    const a = await fetchJSON(`https://api.exchangerate.host/latest?base=${base}&symbols=KRW`);
    if (a?.rates?.KRW) return a.rates.KRW;
  } catch {}
  const b = await fetchJSON(`https://open.er-api.com/v6/latest/${base}`);
  if (b?.result === "success" && b?.rates?.KRW) return b.rates.KRW;
  throw new Error("mid fetch failed");
}
function num(x) { return Number(String(x).replace(/[^0-9.]/g, "")); }
function parseBody(body, re) {
  // returns Number from first capture; commas allowed
  const m = body.replaceAll(",", "").match(re);
  return m ? Number(m[1]) : NaN;
}
async function bodyText(page) {
  return (await page.locator("body").innerText().catch(()=>"")) || "";
}
async function open(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1000);
}

// ---------- site scrapers (all return KRW per BASE) ----------
async function scrape_e9pay(page, base) {
  // page prints: "1 BASE = N KRW"
  await open(page, "https://www.e9pay.co.kr/");
  const body = await bodyText(page);
  const re = new RegExp(`1\\s*${base}\\s*=\\s*([\\d.]+)\\s*KRW`, "i");
  const v = parseBody(body, re);
  return Number.isFinite(v) && v > 0 ? v : NaN; // already KRW/BASE
}

async function scrape_gmoneytrans(page, base) {
  // page prints: "1 KRW = n BASE"
  await open(page, "https://gmoneytrans.com/");
  const body = await bodyText(page);
  const re = new RegExp(`1\\s*KRW\\s*=\\s*([\\d.]+)\\s*${base}`, "i");
  const n = parseBody(body, re);
  return Number.isFinite(n) && n > 0 ? 1 / n : NaN; // invert -> KRW/BASE
}

async function scrape_gme(page, base) {
  // #currentRate shows BASE per KRW (e.g. 0.00071 for USD), invert.
  await open(page, "https://www.gmeremit.com/personal/");
  const txt = await page.locator("#currentRate").first().innerText().catch(()=>"");
  const v = num(txt);
  return Number.isFinite(v) && v > 0 ? 1 / v : NaN; // KRW/BASE
}

// ---------- main ----------
export async function scrapeAll() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "en-US" });

  const rows = [];
  for (const [base, quote] of PAIRS) {
    let mid = null;
    try { mid = await getMidKRWperBASE(base); } catch (e) {}

    for (const site of SITES) {
      let rate = NaN, error = null;
      try {
        if (site === "e9pay")       rate = await scrape_e9pay(page, base);
        else if (site === "gmoneytrans") rate = await scrape_gmoneytrans(page, base);
        else if (site === "gme")    rate = await scrape_gme(page, base);
        if (!Number.isFinite(rate)) error = "no rate found";
      } catch (e) {
        error = (e?.message || String(e)).slice(0, 180);
      }

      const ok = Number.isFinite(rate);
      rows.push({
        site,
        base,
        quote,
        service_krw_per_base: ok ? rate : null,   // <-- KRW per BASE (normalized)
        mid_krw_per_base: mid,
        spread_krw_per_base: ok && mid ? rate - mid : null,
        spread_pct: ok && mid ? (rate - mid) / mid : null,
        ok,
        error
      });
    }
  }

  await browser.close();
  return rows;
}
