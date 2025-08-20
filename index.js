import dayjs from "dayjs";
import { google } from "googleapis";
import { scrapeAll } from "./scrape.js";

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "FX Competitor Log";
const LOG_SHEET_TITLE = process.env.LOG_SHEET_TITLE || "log";
const GOOGLE_CREDENTIALS = process.env.GOOGLE_CREDENTIALS;

if (!SHEET_ID) { console.error("Missing SHEET_ID secret"); process.exit(1); }
if (!GOOGLE_CREDENTIALS) { console.error("Missing GOOGLE_CREDENTIALS secret"); process.exit(1); }

const creds = JSON.parse(GOOGLE_CREDENTIALS);
const scopes = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive"
];
const jwt = new google.auth.JWT(creds.client_email, null, creds.private_key, scopes);
const sheets = google.sheets({ version: "v4", auth: jwt });

async function ensureSheetAndHeader() {
  const getRes = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = getRes.data.sheets.some(s => s.properties.title === LOG_SHEET_TITLE);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: LOG_SHEET_TITLE } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${LOG_SHEET_TITLE}!A1:I1`,
      valueInputOption: "RAW",
      requestBody: { values: [[
        "timestamp","site","pair","implied_base_per_KRW","mid_raw_from_api",
        "margin_abs_base_per_KRW","margin_pct","ok","error"
      ]]}
    });
  }
}

async function appendRows(rows) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${LOG_SHEET_TITLE}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows }
  });
}

(async () => {
  try {
    await ensureSheetAndHeader();
    const batch = await scrapeAll();
    const ts = dayjs().format("YYYY-MM-DDTHH:mm:ssZ");
    const rows = batch.map(r => [
      ts, r.site, r.pair,
      r.implied_base_per_KRW ?? "",
      r.mid_raw_from_api ?? "",
      r.margin_abs_base_per_KRW ?? "",
      r.margin_pct ?? "",
      r.ok === true,
      r.error || ""
    ]);
    await appendRows(rows);
    console.log(`Appended ${rows.length} rows at ${ts}`);
  } catch (e) {
    console.error("Run failed:", e?.message || e);
    process.exit(1);
  }
})();
