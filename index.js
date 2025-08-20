// index.js — writes exactly the columns you want into Google Sheets

import { google } from "googleapis";
import { scrapeAll } from "./scrape.js";

const SHEET_ID = process.env.SHEET_ID;                           // e.g. 19H0TIMF...
const SHEET_NAME = process.env.SHEET_NAME || "log";              // tab name to write into
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS || "{}");

const HEADER = [
  "timestamp",
  "site",
  "base",
  "quote",
  "service_krw_per_base",
  "mid_krw_per_base",
  "spread_krw_per_base",
  "spread_pct",
  "ok",
  "error",
];

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

async function ensureHeaderIfBlank(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1:J1`,
  }).catch(() => null);

  const hasHeader =
    res && res.data && Array.isArray(res.data.values) && res.data.values.length > 0;

  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
}

async function appendRows(sheets, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function toFixedOrBlank(n) {
  return n == null ? "" : n;   // leave formatting to Sheets
}

(async () => {
  try {
    const sheets = await getSheets();
    await ensureHeaderIfBlank(sheets);

    // Run the scraper once (it returns one record per site × pair)
    const batch = await scrapeAll();

    // Convert to your desired 10-column row shape
    const rows = batch.map((r) => {
      const [base, quote] = (r.pair || "").split("/");
      // implied_base_per_KRW is BASE per KRW  -> convert to KRW per BASE
      const service = r.implied_base_per_KRW != null ? 1 / r.implied_base_per_KRW : null;
      const mid = toNumber(r.mid_raw_from_api);

      let spread = null, spreadPct = null;
      if (service != null && mid != null) {
        spread = service - mid;
        spreadPct = mid !== 0 ? spread / mid : null;
      }

      return [
        r.ts || "",               // timestamp
        r.site || "",             // site
        base || "",               // base
        quote || "",              // quote
        toFixedOrBlank(service),  // service_krw_per_base
        toFixedOrBlank(mid),      // mid_krw_per_base
        toFixedOrBlank(spread),   // spread_krw_per_base
        toFixedOrBlank(spreadPct),// spread_pct
        r.ok === true,            // ok (TRUE/FALSE)
        r.error || ""             // error
      ];
    });

    await appendRows(sheets, rows);
    console.log(`Wrote ${rows.length} rows to ${SHEET_NAME}`);
  } catch (e) {
    console.error("Run failed:", e?.message || e);
    process.exit(1);
  }
})();
