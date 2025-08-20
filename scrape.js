// scrape.js
import { chromium } from "playwright";
import fs from "fs/promises";

// ---------- WHAT WE SCRAPE ----------
const PAIRS = [
  ["VND", "KRW"],
  ["CNY", "KRW"],
  ["NPR", "KRW"],
  ["KHR", "KRW"],
];

// ---------- UTIL ----------
function asNumber(s) {
  return parseFloat(String(s).replace(/[,\s]/g, ""));
}

async function waitIdle(page) {
  try { await page.waitForLoadState("networkidle", { timeout: 12000 }); } catch {}
  await page.waitForTimeout(600);
}

async function clickAwayBanners(page) {
  for (const t of ["동의","확인","허용","Agree","Accept","OK"]) {
    try { const el = page.getByText(t, { exact:false }).first(); if (await el.count()) await el.click({ timeout: 800 }); } catch {}
  }
}

async function capture(page, tag) {
  try {
    await fs.mkdir("artifacts", { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g,"-");
    await page.screenshot({ path: `artifacts/${tag}_${ts}.png`, fullPage: true });
    const html = await page.content();
    await fs.writeFile(`artifacts/${tag}_${ts}.html`, html.slice(0, 400000));
  } catch {}
}

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-store", headers: { "Accept": "application/json" } });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error("mid payload not JSON"); }
}
async function getMid(base, quote) {
  // prefer exchangerate.host; fallback to open.er-api
  try {
    const a = await fetchJSON(`https://api.exchangerate.host/latest?base=${base}&symbols=${quote}`);
    if (a?.rates?.[quote] != null) return a.rates[quote];
    throw new Error("exchangerate.host missing");
  } catch (e1) {
    const b = await fetchJSON(`https://open.er-api.com/v6/latest/${base}`);
    if (b?.result === "success" && b?.rates?.[quote] != null) return b.rates[quote];
    throw new Error(`mid fetch failed: ${e1.message}`);
  }
}

function nowKST() {
  // produce "YYYY-MM-DD" & "HH:mm:ss" in Asia/Seoul
  const z = "Asia/Seoul";
  const d = new Date();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d); // 2025-08-20
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .format(d); // 16:42:57
  return { date, time };
}

// ---------- SITE SCRAPERS (return KRW per BASE) ----------

// e9pay: #display-exrate > font[dir=auto] => "1 CNY = 194.96 KRW"
async function scrape_e9pay(page, base="CNY") {
  await page.goto("https://www.e9pay.co.kr/", { timeout: 60000 });
  await clickAwayBanners(page); await waitIdle(page);

  const el = page.locator("#display-exrate font[dir='auto']");
  try { await el.waitFor({ timeout: 15000 }); }
  catch { await capture(page, `e9pay_${base}_no-el`); throw new Error("e9pay: rate node not found"); }

  const raw = (await el.innerText()).replace(/\s+/g," ").trim(); // "1 CNY = 194.96 KRW"
  const m = raw.match(/1\s*([A-Z]{3})\s*=\s*([\d.,]+)\s*(?:KRW|₩|원)/i);
  if (!m) { await capture(page, `e9pay_${base}_no-match`); throw new Error(`e9pay: pattern not found in "${raw}"`); }
  if (m[1].toUpperCase() !== base.toUpperCase()) throw new Error(`e9pay: base mismatch: saw ${m[1]} wanted ${base}`);
  return asNumber(m[2]); // already KRW per BASE
}

// GMoneyTrans: span#rate => "1 KRW = 0.005119 CNY" → invert
async function scrape_gmoneytrans(page, base="CNY") {
  await page.goto("https://gmoneytrans.com/", { timeout: 60000 });
  await clickAwayBanners(page); await waitIdle(page);

  const el = page.locator("span#rate");
  await el.scrollIntoViewIfNeeded();
  try { await el.waitFor({ timeout: 15000 }); }
  catch { await capture(page, `gmoney_${base}_no-el`); throw new Error("gmoneytrans: rate node not found"); }

  const raw = (await el.innerText()).replace(/\s+/g," ").trim(); // "1 KRW = 0.005119 CNY"
  const m = raw.match(/1\s*(?:KRW|₩|원)\s*=\s*([\d.,]+)\s*([A-Z]{3})/i);
  if (!m) { await capture(page, `gmoney_${base}_no-match`); throw new Error(`gmoneytrans: pattern not found in "${raw}"`); }
  if (m[2].toUpperCase() !== base.toUpperCase()) throw new Error(`gmoneytrans: base mismatch: saw ${m[2]} wanted ${base}`);
  const basePerKRW = asNumber(m[1]);
  if (!(basePerKRW > 0)) { await capture(page, `gmoney_${base}_bad-num`); throw new Error(`gmoneytrans: bad number "${raw}"`); }
  return 1 / basePerKRW; // → KRW per BASE
}

// GME: #currentRate ⇒ BASE per KRW (tiny) → invert
async function scrape_gme(page, base="USD") {
  await page.goto("https://www.gmeremit.com/personal/", { timeout: 60000 });
  await clickAwayBanners(page); await waitIdle(page);

  const el = page.locator("#currentRate, span#currentRate, [id*='currentRate']");
  await el.scrollIntoViewIfNeeded();
  try { await el.waitFor({ timeout: 15000 }); }
  catch { await capture(page, `gme_${base}_no-el`); throw new Error("gme: rate node not found"); }

  const raw = (await el.innerText()).trim();            // e.g. "0.000710353"
  const basePerKRW = asNumber(raw);
  if (!(basePerKRW > 0 && basePerKRW < 0.1)) {
    await capture(page, `gme_${base}_bad-num`);
    throw new Error(`gme: invalid rate "${raw}"`);
  }
  return 1 / basePerKRW; // → KRW per BASE
}

// ---------- MAIN LOOPER ----------
export async function scrapeAll() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "ko-KR",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  const rows = [];
  const { date, time } = nowKST();

  for (const [base, quote] of PAIRS) {
    // mid = KRW per BASE for BASE/quote=KRW
    let midKRWPerBASE = null;
    try { midKRWPerBASE = await getMid(base, quote); } catch {}
    const perSite = { e9pay: null, gmoneytrans: null, gme: null };
    const notes = [];

    // e9pay
    try { perSite.e9pay = await scrape_e9pay(page, base); }
    catch (e) { notes.push(String(e.message || e)); }

    // gmoney
    try { perSite.gmoneytrans = await scrape_gmoneytrans(page, base); }
    catch (e) { notes.push(String(e.message || e)); }

    // gme
    try { perSite.gme = await scrape_gme(page, base); }
    catch (e) { notes.push(String(e.message || e)); }

    // pick best (max KRW per BASE)
    const candidates = Object.entries(perSite).filter(([,v]) => typeof v === "number" && v > 0);
    const best = candidates.length ? candidates.sort((a,b)=>b[1]-a[1])[0] : [null, 0];

    rows.push({
      date, time,
      pair: `${base}/${quote}`,
      e9pay_krw_per_base: perSite.e9pay || 0,
      gmoney_krw_per_base: perSite.gmoneytrans || 0,
      gme_krw_per_base: perSite.gme || 0,
      mid_krw_per_base: midKRWPerBASE || 0,
      best_site: best[0] ? (best[0] === "gmoneytrans" ? "gmoney" : best[0]) : "",
      best_rate_krw_per_base: best[1] || 0,
      notes: notes.join(" | "),
    });
  }

  await browser.close();
  return rows;
}
