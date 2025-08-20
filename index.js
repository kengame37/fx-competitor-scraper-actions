// index.js — tabs per currency (VND/CNY/NPR/KHR), one row per run with all 3 sites
import { google } from "googleapis";
import { scrapeAll } from "./scrape.js";

// ---- ENV ----
const SPREADSHEET_ID = process.env.SHEET_ID; // Google Sheet ID
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}");
const TIMEZONE = process.env.TIMEZONE || "Asia/Seoul"; // for date/time split

// Tabs are the BASE currencies
const TAB_BY_BASE = {
  VND: process.env.SHEET_VND || "VND",
  CNY: process.env.SHEET_CNY || "CNY",
  NPR: process.env.SHEET_NPR || "NPR",
  KHR: process.env.SHEET_KHR || "KHR",
};

const HEADER = [
  "date",
  "time",
  "e9pay_krw_per_base",
  "gmoney_krw_per_base",
  "gme_krw_per_base",
  "mid_krw_per_base",
  "best_site",
  "best_rate_krw_per_base",
  "notes",
];

function formatDate(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function formatTime(d, tz) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
}

function safeRateKRWPerBaseFromImplied(impliedBasePerKRW) {
  // implied = BASE per 1 KRW; we want KRW per 1 BASE
  if (impliedBasePerKRW == null) return null;
  const r = 1 / impliedBasePerKRW;
  return Number.isFinite(r) && r > 0 ? r : null;
}

async function getSheets() {
  const auth = new google.auth.JWT(
    GOOGLE_CREDENTIALS.client_email,
    null,
    GOOGLE_CREDENTIALS.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function listSheetTitles(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  return new Set((meta.data.sheets || []).map(s => s.properties?.title));
}

async function ensureSheetAndHeader(sheets, title) {
  const titles = await listSheetTitles(sheets);
  if (!titles.has(title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A1:I1`,
  }).catch(() => null);
  const hasHeader = res?.data?.values?.length > 0;
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${title}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
}

async function appendRow(sheets, title, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

(async () => {
  try {
    const sheets = await getSheets();

    // Ensure all currency tabs exist with headers
    for (const tab of Object.values(TAB_BY_BASE)) {
      await ensureSheetAndHeader(sheets, tab);
    }

    // Scrape results (site × pair)
    const results = await scrapeAll();

    const now = new Date(results?.[0]?.ts || Date.now());
    const dateStr = formatDate(now, TIMEZONE);
    const timeStr = formatTime(now, TIMEZONE);

    // Prepare per-currency records
    const bases = ["VND", "CNY", "NPR", "KHR"];
    const perBase = Object.fromEntries(
      bases.map(b => [b, { e9pay: null, gmoneytrans: null, gme: null, mid: null, notes: [] }])
    );

    // Fill from raw rows
    for (const r of results) {
      const [base, quote] = (r.pair || "").split("/");
      if (!bases.includes(base) || quote !== "KRW") continue;

      // mid is KRW per BASE from API (same across sites). Keep first seen.
      if (perBase[base].mid == null && r.mid_raw_from_api != null) {
        perBase[base].mid = r.mid_raw_from_api;
      }

      // Only keep service rate if sanity check passed (ok === true)
      if (r.ok === true) {
        const rateKRWPerBase = safeRateKRWPerBaseFromImplied(r.implied_base_per_KRW);
        if (rateKRWPerBase != null) {
          if (r.site === "e9pay") perBase[base].e9pay = rateKRWPerBase;
          else if (r.site === "gmoneytrans") perBase[base].gmoneytrans = rateKRWPerBase;
          else if (r.site === "gme") perBase[base].gme = rateKRWPerBase;
        } else if (r.error) {
          perBase[base].notes.push(`${r.site}: ${r.error}`);
        }
      } else if (r.error) {
        perBase[base].notes.push(`${r.site}: ${r.error}`);
      }
    }

    // One row per currency tab
    for (const base of bases) {
      const tab = TAB_BY_BASE[base];
      const entry = perBase[base];

      // choose best among non-null
      const cands = [
        ["e9pay", entry.e9pay],
        ["gmoney", entry.gmoneytrans],
        ["gme", entry.gme],
      ].filter(([_n, v]) => Number.isFinite(v));

      let bestSite = "";
      let bestRate = "";
      if (cands.length) {
        const [n, v] = cands.reduce((a, b) => (a[1] > b[1] ? a : b));
        bestSite = n;
        bestRate = v;
      }

      const row = [
        dateStr,
        timeStr,
        entry.e9pay ?? "",        // blanks if missing, not 0
        entry.gmoneytrans ?? "",
        entry.gme ?? "",
        entry.mid ?? "",
        bestSite,
        bestRate,
        entry.notes.join(" | "),
      ];

      await appendRow(sheets, tab, row);
    }

    console.log("OK: appended rows to currency tabs.");
  } catch (e) {
    console.error("Run failed:", e?.message || e);
    process.exit(1);
  }
})();
