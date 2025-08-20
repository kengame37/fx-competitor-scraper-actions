// scrape.js
// Scrapes e9pay / gmoneytrans / gme and returns rows suitable for Google Sheets.
// Each row contains: timestamp, site, base, quote=KRW, service_krw_per_base, mid_krw_per_base, spread_krw_per_base, spread_pct, ok, error

// ---------- helpers ----------
async function getMidKrwPerBase(base) {
  // KRW per BASE (e.g., base=CNY -> ~193.5)
  const u = `https://api.exchangerate.host/latest?base=${encodeURIComponent(base)}&symbols=KRW`;
  const r = await fetch(u, { headers: { Accept: "application/json" }, cache: "no-store" });
  const j = await r.json();
  if (!j?.rates?.KRW) throw new Error("mid not found");
  return j.rates.KRW;
}

// very tolerant parser; understands:
//  - "1 CNY = 194.96 KRW"   -> 194.96
//  - "1 KRW = 0.005119 CNY" -> invert -> 195.37
function extractKrwPerBaseFromText(txt, base) {
  if (!txt) return NaN;
  const t = txt.replace(/\u00a0/g, " ").replace(/,/g, " ").replace(/\s+/g, " ").trim();

  // "1 BASE = N KRW"
  let m = t.match(new RegExp(`1\\s*${base}\\s*=\\s*([0-9.]+)\\s*KRW`, "i"));
  if (m) return parseFloat(m[1]);

  // "1 KRW = N BASE" -> invert
  m = t.match(new RegExp(`1\\s*KRW\\s*=\\s*([0-9.]+)\\s*${base}`, "i"));
  if (m) return 1 / parseFloat(m[1]);

  // fallback first number (only used if sanity passes)
  m = t.match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

// sanity vs mid
function gateAgainstMid(val, mid) {
  if (!Number.isFinite(val) || val <= 0) return { ok: false, val: NaN, why: "not finite" };
  if (!Number.isFinite(mid) || mid <= 0) return { ok: true, val };
  const lo = mid * 0.6, hi = mid * 1.4;
  if (val < lo || val > hi) return { ok: false, val: NaN, why: `sanity: ${val} vs mid ${mid}` };
  return { ok: true, val };
}

// best-effort amount fill (1,000,000 KRW)
async function setSendAmountKRW(page) {
  try {
    const inputs = page.locator("input[type=number], input[inputmode=numeric], input[mode=numeric]");
    if (await inputs.count()) {
      await inputs.first().fill("1000000");
      await page.waitForTimeout(500);
    }
  } catch {}
}

// ---------- site scrapers ----------

// e9pay: #display-exrate contains "1 BASE = N KRW"
async function scrape_e9pay(page, base) {
  await page.goto("https://www.e9pay.co.kr/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await setSendAmountKRW(page);
  // try to switch language to English if visible (optional)
  try { await page.getByText("English", { exact: false }).first().click({ timeout: 1500 }); } catch {}
  await page.waitForSelector("#display-exrate", { timeout: 12000 });
  const raw = await page.locator("#display-exrate").innerText().catch(() => "");
  const parsed = extractKrwPerBaseFromText(raw, base);
  return { value: parsed, raw };
}

// gmoneytrans: #rate has "1 KRW = 0.005119 CNY" (invert)
async function scrape_gmoneytrans(page, base) {
  await page.goto("https://gmoneytrans.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await setSendAmountKRW(page);
  await page.waitForSelector("#rate", { timeout: 12000 });
  const raw = await page.locator("#rate").innerText().catch(() => "");
  const parsed = extractKrwPerBaseFromText(raw, base);
  return { value: parsed, raw };
}

// GME: #currentRate shows TARGET per KRW; we invert.
// We try to choose the country to match the BASE where possible.
const GME_COUNTRY_BY_BASE = {
  VND: "Vietnam",
  CNY: "China",
  NPR: "Nepal",
  KHR: "Cambodia"
};

async function trySelectGmeCountry(page, base) {
  const country = GME_COUNTRY_BY_BASE[base];
  if (!country) return;
  // The UI is a custom dropdown; try clicking the label then the country by text.
  try {
    // Click near "Select Your Country" area
    await page.getByText("Select Your Country", { exact: false }).first().click({ timeout: 2000 });
  } catch {}
  try {
    await page.getByText(country, { exact: false }).first().click({ timeout: 2000 });
    await page.waitForTimeout(700);
  } catch {}
}

async function scrape_gme(page, base) {
  await page.goto("https://www.gmeremit.com/personal/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await setSendAmountKRW(page);
  await trySelectGmeCountry(page, base);
  await page.waitForSelector("#currentRate", { timeout: 12000 });
  const raw = (await page.locator("#currentRate").innerText().catch(() => "")).replace(/,/g, "");
  const targetPerKRW = parseFloat(raw); // e.g., CNY per KRW
  const parsed = Number.isFinite(targetPerKRW) && targetPerKRW > 0 ? (1 / targetPerKRW) : NaN; // KRW per TARGET
  return { value: parsed, raw: `currentRate=${raw}` };
}

// ---------- main entry ----------

export async function scrapeAll() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "en-US" });

  const BASES = ["VND", "CNY", "NPR", "KHR"]; // quote is always KRW
  const SITES = ["e9pay", "gmoneytrans", "gme"];

  const rows = [];

  for (const base of BASES) {
    const mid = await getMidKrwPerBase(base).catch(() => null); // KRW per BASE
    for (const site of SITES) {
      try {
        let res;
        if (site === "e9pay") res = await scrape_e9pay(page, base);
        else if (site === "gmoneytrans") res = await scrape_gmoneytrans(page, base);
        else res = await scrape_gme(page, base);

        const { ok, val, why } = gateAgainstMid(res.value, mid);

        rows.push({
          timestamp: new Date().toISOString(),
          site,
          base,
          quote: "KRW",
          service_krw_per_base: ok ? val : null,
          mid_krw_per_base: mid ?? null,
          spread_krw_per_base: ok && mid ? (val - mid) : null,
          spread_pct: ok && mid ? (val - mid) / mid : null,
          ok,
          error: ok ? `raw:${res.raw}` : `raw:${res.raw} | ${why || "parse failed"}`
        });
      } catch (e) {
        rows.push({
          timestamp: new Date().toISOString(),
          site,
          base,
          quote: "KRW",
          service_krw_per_base: null,
          mid_krw_per_base: mid ?? null,
          spread_krw_per_base: null,
          spread_pct: null,
          ok: false,
          error: (e?.message || String(e)).slice(0, 240)
        });
      }
    }
  }

  await browser.close();
  return rows;
}
