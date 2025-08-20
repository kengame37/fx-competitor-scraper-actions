// index.js — append 5 columns to 3 separate tabs: e9pay, gmoney, gme
import { google } from "googleapis";
import { scrapeAll } from "./scrape.js";

// ---- ENV ----
const SPREADSHEET_ID = process.env.SHEET_ID;                  // your sheet id
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}");
const TIMEZONE = process.env.TIMEZONE || "Asia/Seoul";        // separate date/time in this TZ

// Tab names (override via secrets if you want different names)
const SHEET_TABS = {
  e9pay: process.env.SHEET_E9PAY || "e9pay",
  gmoneytrans: process.env.SHEET_GMONEY || "gmoney",
  gme: process.env.SHEET_GME || "gme",
};

// Header for each tab
const HEADER = ["date", "time", "site", "base", "quote"];

// ---- Helpers ----
function formatDate(d, tz) {
  // YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}
function formatTime(d, tz) {
  // HH:mm:ss (24h)
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(d);
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
  // ensure header A1:E1
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A1:E1`,
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

async function appendRows(sheets, title, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

(async () => {
  try {
    const sheets = await getSheets();

    // Ensure the three tabs exist (with headers)
    const titles = [
      SHEET_TABS.e9pay,
      SHEET_TABS.gmoneytrans,
      SHEET_TABS.gme,
    ];
    for (const t of titles) {
      await ensureSheetAndHeader(sheets, t);
    }

    // Scrape once (returns one record per site × pair)
    const batch = await scrapeAll();

    // Build rows per tab with just the 5 requested columns
    const perTab = { [SHEET_TABS.e9pay]: [], [SHEET_TABS.gmoneytrans]: [], [SHEET_TABS.gme]: [] };

    for (const r of batch) {
      const [base, quote] = (r.pair || "").split("/");
      const d = new Date(r.ts || Date.now());
      const row = [
        formatDate(d, TIMEZONE),     // date
        formatTime(d, TIMEZONE),     // time
        r.site || "",                // site
        base || "",                  // base
        quote || "",                 // quote
      ];
      const tab = SHEET_TABS[r.site] || SHEET_TABS.gmoneytrans; // fallback
      if (!perTab[tab]) perTab[tab] = [];
      perTab[tab].push(row);
    }

    // Append to each tab
    for (const [tab, rows] of Object.entries(perTab)) {
      if (rows?.length) await appendRows(sheets, tab, rows);
    }

    console.log("Appended rows:", Object.fromEntries(Object.entries(perTab).map(([t, rows]) => [t, rows.length])));
  } catch (e) {
    console.error("Run failed:", e?.message || e);
    process.exit(1);
  }
})();
