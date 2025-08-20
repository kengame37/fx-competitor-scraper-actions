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
  const tz = "Asia/Seoul";
  const d = new Date();

  // Build YYYY-MM-DD
  const dParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const date = `${dParts.find(p => p.type === "year").value}-${dParts.find(p => p.type === "month").value}-${dParts.find(p => p.type === "day").value}`;

  // Build HH:mm:ss (24h)
  const tParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const time = `${tParts.find(p => p.type === "hour").value}:${tParts.find(p => p.type === "minute").value}:${tParts.find(p => p.type === "second").value}`;

  return { date, time };
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
