// index.js
import { scrapeAll } from "./scrape.js";
import { google } from "googleapis";

const SHEET_ID = process.env.SHEET_ID;
const SHEET_VND = process.env.SHEET_VND || "VND";
const SHEET_CNY = process.env.SHEET_CNY || "CNY";
const SHEET_NPR = process.env.SHEET_NPR || "NPR";
const SHEET_KHR = process.env.SHEET_KHR || "KHR";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function nowKST() {
  const d = new Date();
  const tz = "Asia/Seoul";
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, dateStyle: "medium" })
    .format(d)
    .replace(/\./g, "-")
    .replace(/\s/g, "")
    .replace(/,$/, ""); // keep it clean
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, timeStyle: "medium" }).format(d);
  // standardize date to YYYY-MM-DD
  const iso = new Date(d.toLocaleString("en-CA", { timeZone: tz })).toISOString().slice(0, 10);
  return { date: iso, time };
}

async function appendRow(tab, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

function toRow(date, time, r) {
  return [
    date,
    time,
    r.e9pay_krw_per_base ?? "",
    r.gmoney_krw_per_base ?? "",
    r.gme_krw_per_base ?? "",
    "", // mid_krw_per_base (optional — leave blank or fill later)
    r.best_site ?? "",
    r.best_rate_krw_per_base ?? "",
    r.notes ?? "",
  ];
}

const TAB_BY_BASE = { VND: SHEET_VND, CNY: SHEET_CNY, NPR: SHEET_NPR, KHR: SHEET_KHR };

(async () => {
  const data = await scrapeAll();
  const { date, time } = nowKST();

  for (const r of data) {
    const tab = TAB_BY_BASE[r.base] || r.base;
    await appendRow(tab, toRow(date, time, r));
  }
  console.log("OK");
})();
