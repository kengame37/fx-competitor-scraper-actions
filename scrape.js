// scrape.js
import { chromium, devices } from "playwright";

/** Pairs we care about (BASE/KRW) and the human country name to select per site */
const CORRIDORS = [
  { base: "CNY", country: "China" },
  { base: "VND", country: "Vietnam" },
  { base: "NPR", country: "Nepal" },
  { base: "KHR", country: "Cambodia" },
];

// Use a common amount so the widgets render a rate
const SEND_KRW_AMOUNT = 1_000_000;

// --- helpers ---------------------------------------------------------------

/** read numeric from "1 XXX = 194.96 KRW" or "1 KRW = 0.005119 XXX" */
function extractKrwPerBaseFromText(txt, base) {
  // remove commas & NBSPs
  const t = (txt || "").replace(/\u00a0/g, " ").replace(/,/g, "").trim();

  // Case A: 1 BASE = N KRW   -> direct
  let m = t.match(new RegExp(`1\\s*${base}\\s*=\\s*([0-9.]+)\\s*KRW`, "i"));
  if (m) return parseFloat(m[1]);

  // Case B: 1 KRW = N BASE   -> invert
  m = t.match(new RegExp(`1\\s*KRW\\s*=\\s*([0-9.]+)\\s*${base}`, "i"));
  if (m) return 1 / parseFloat(m[1]);

  // plain number? return NaN if not found
  const onlyNum = t.match(/([0-9]+(?:\.[0-9]+)?)/);
  return onlyNum ? parseFloat(onlyNum[1]) : NaN;
}

/** convenience: click anything that looks like it */
async function clickOneOf(page, selectors) {
  for (const s of selectors) {
    const loc = page.locator(s);
    if (await loc.first().count()) {
      try { await loc.first().click({ timeout: 1500 }); return true; } catch {}
    }
  }
  return false;
}

async function setSendAmountKRW(page) {
  // Try common number boxes (each site uses different markup)
  const candidates = [
    'input[type="number"]',
    'input[inputmode="numeric"]',
    'input[mode="numeric"]',
    'input[name*="amount" i]',
    'input[name*="send" i]',
  ];
  for (const s of candidates) {
    const loc = page.locator(s).first();
    if (await loc.count()) {
      await loc.fill(""); await loc.type(String(SEND_KRW_AMOUNT));
      await page.waitForTimeout(300);
      break;
    }
  }
}

function resultRow({ site, base, krwPerBase, mid, ok, note }) {
  const now = new Date();
  const date = now.toISOString().slice(0,10);
  const time = now.toTimeString().slice(0,8);
  return {
    date,
    time,
    site,
    base,
    quote: "KRW",
    service_krw_per_base: Number.isFinite(krwPerBase) ? krwPerBase : 0,
    mid_krw_per_base: Number.isFinite(mid) ? mid : null,
    spread_krw_per_base: Number.isFinite(krwPerBase) && Number.isFinite(mid) ? (krwPerBase - mid) : null,
    spread_pct: Number.isFinite(krwPerBase) && Number.isFinite(mid) ? ((krwPerBase - mid) / mid) : null,
    ok: !!ok,
    error: ok ? "" : (note || "no implied rate found"),
  };
}

/** public FX mid (KRW per BASE) – exchangerate.host */
async function getMidKrwPerBase(base) {
  // mid is KRW per BASE => ask base=BASE, symbols=KRW → return KRW/BASE
  const url = `https://api.exchangerate.host/latest?base=${base}&symbols=KRW`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  const j = await r.json().catch(() => null);
  if (j && j.rates && j.rates.KRW) return j.rates.KRW;
  throw new Error("mid fetch failed");
}

// --- site scrapers ---------------------------------------------------------

/** e9pay: rate appears under #display-exrate (e.g., "1 CNY = 194.96 KRW") */
async function scrape_e9pay(page, base, country) {
  await page.goto("https://www.e9pay.co.kr/", { waitUntil: "domcontentloaded", timeout: 60000 });

  // try to pick the country in the little flag picker under "Amount to be remitted"
  // open the country list near that widget (click the small flag dropdown in the amount box)
  await clickOneOf(page, [
    // openers
    'div:has-text("Amount to be remitted") button',
    'div.inner .box .ico_arrow_img', // fallback
    'div.inner .box [role="button"]'
  ]);

  // click one of these country names
  await clickOneOf(page, [
    `text=${country}`, // English
    `text=${country.toUpperCase()}`,
  ]);

  await setSendAmountKRW(page);

  // The exact rate node:
  const ex = page.locator("#display-exrate").first();
  await ex.waitFor({ timeout: 8000 });
  const txt = await ex.innerText().catch(() => "");
  const krwPerBase = extractKrwPerBaseFromText(txt, base);

  if (!Number.isFinite(krwPerBase)) throw new Error(`e9pay: bad text "${txt}"`);

  return { krwPerBase, note: "" };
}

/** Gmoneytrans: the page shows "1 KRW = 0.005119 CNY" inside #rate (invert it) */
async function scrape_gmoneytrans(page, base, country) {
  await page.goto("https://gmoneytrans.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

  // open Receiving Country picker and choose
  await clickOneOf(page, [
    'div:has-text("Receiving Country")',
    'div:has-text("Select Country")',
    '.box_group .box_title_group',
  ]);
  await clickOneOf(page, [
    `text=${country}`,
    `text=${country.toUpperCase()}`,
  ]);

  await setSendAmountKRW(page);

  // exact node with the rate text
  const rateNode = page.locator("#rate").first();
  await rateNode.waitFor({ timeout: 8000 });
  const txt = await rateNode.innerText().catch(() => "");
  // Example: "1 KRW = 0.005119 CNY" → invert
  const krwPerBase = extractKrwPerBaseFromText(txt, base);

  if (!Number.isFinite(krwPerBase)) throw new Error(`gmoneytrans: bad text "${txt}"`);

  return { krwPerBase, note: "" };
}

/** GME: span#currentRate shows TARGET per KRW → invert to KRW per BASE */
async function scrape_gme(page, base, country) {
  await page.goto("https://www.gmeremit.com/personal/", { waitUntil: "domcontentloaded", timeout: 60000 });

  // open "Select Your Country" / recipient combobox and choose
  await clickOneOf(page, [
    'text=Select Your Country',
    'text=Recipient',
    'label:has-text("Select Your Country") + *',
  ]);
  await clickOneOf(page, [
    `text=${country}`,
    `text=${country.toUpperCase()}`,
  ]);

  await setSendAmountKRW(page);

  // exact node: Real Time Exchange Rate
  const node = page.locator("#currentRate").first();
  await node.waitFor({ timeout: 8000 });
  const raw = (await node.innerText().catch(() => "")).replace(/,/g, "").trim();
  const targetPerKRW = parseFloat(raw); // e.g., CNY per KRW
  if (!Number.isFinite(targetPerKRW) || targetPerKRW <= 0) {
    throw new Error(`gme: bad currentRate "${raw}"`);
  }
  // Convert to KRW per BASE
  const krwPerBase = 1 / targetPerKRW;
  return { krwPerBase, note: "" };
}

// --- main orchestrator -----------------------------------------------------

export async function scrapeAll() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
    locale: "en-US",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
  });

  const page = await context.newPage();

  const out = [];
  for (const { base, country } of CORRIDORS) {
    const mid = await getMidKrwPerBase(base).catch(() => null);

    for (const site of ["e9pay", "gmoneytrans", "gme"]) {
      try {
        let krwPerBase, note = "";
        if (site === "e9pay") {
          ({ krwPerBase, note } = await scrape_e9pay(page, base, country));
        } else if (site === "gmoneytrans") {
          ({ krwPerBase, note } = await scrape_gmoneytrans(page, base, country));
        } else {
          ({ krwPerBase, note } = await scrape_gme(page, base, country));
        }
        out.push(resultRow({ site, base, krwPerBase, mid, ok: true, note }));
      } catch (e) {
        out.push(resultRow({
          site,
          base,
          krwPerBase: NaN,
          mid,
          ok: false,
          note: (e?.message || String(e)).slice(0, 240)
        }));
      }
    }
  }

  await browser.close();
  return out;
}
