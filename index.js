// index.js — tabs per currency (VND/CNY/NPR/KHR), one row per run with all 3 sites
import { google } from "googleapis";
import { scrapeAll } from "./scrape.js";

// ---- ENV ----
const SPREADSHEET_ID = process.env.SHEET_ID; // Google Sheet ID
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}");
const TIMEZONE = process.env.TIMEZONE || "Asia/Seoul"; // for date/time split

// Tabs are the BASE currencies (you can rename via secrets if you want)
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
function n(x) { const v = Number(x); return Number.isFinite(v) ? v : null; }

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

    // Build per-currency aggregates for this run
    // { VND: { e9pay: number|null, gmoneytrans: number|null, gme: number|null, mid: number|null, notes: [] }, ... }
    const bases = ["VND", "CNY", "NPR", "KHR"];
    const byBase = Object.fromEntries(bases.map(b => [b, { e9pay: null, gmoneytrans: null, gme: null, mid: null, notes: [] }]));

    for (const r of results) {
      const [base, quote] = (r.pair || "").split("/");
      if (!bases.includes(base) || quote !== "KRW") continue;

      // Convert implied (BASE per KRW) -> KRW per BASE
      const rate = r.implied_base_per_KRW ? (1 / r.implied_base_per_KRW) : null;
      if (rate != null) {
        if (r.site === "e9pay") byBase[base].e9pay = rate;
        else if (r.site === "gmoneytrans") byBase[base].gmoneytrans = rate;
        else if (r.site === "gme") byBase[base].gme = rate;
      } else if (r.error) {
        byBase[base].notes.push(`${r.site}: ${r.error}`);
      }

      // mid from API (they're the same across sites; take first non-null)
      const mid = n(r.mid_raw_from_api);
      if (byBase[base].mid == null && mid != null) byBase[base].mid = mid;
    }

    // Emit one row per currency tab
    for (const base of bases) {
      const tab = TAB_BY_BASE[base];
      const entry = byBase[base];

      const e9 = n(entry.e9pay);
      const gm = n(entry.gmoneytrans);
      const ge = n(entry.gme);

      // choose best (highest KRW per BASE)
      const candidates = [
        ["e9pay", e9],
        ["gmoney", gm],
        ["gme", ge],
      ].filter(([_name, v]) => v != null);

      let bestSite = "";
      let bestRate = "";
      if (candidates.length) {
        const [bName, bVal] = candidates.reduce((a, b) => (a[1] > b[1] ? a : b));
        bestSite = bName;
        bestRate = bVal;
      }

      const notes = entry.notes.join(" | ");

      const row = [
        dateStr,
        timeStr,
        e9 ?? "",
        gm ?? "",
        ge ?? "",
        entry.mid ?? "",
        bestSite,
        bestRate,
        notes
      ];

      await appendRow(sheets, tab, row);
    }

    console.log("Appended rows to tabs:", Object.values(TAB_BY_BASE).join(", "));
  } catch (e) {
    console.error("Run failed:", e?.message || e);
    process.exit(1);
  }
})();
