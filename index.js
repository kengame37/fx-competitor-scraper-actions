// index.js
import { scrapeOnce } from "./scrape.js";
import { google } from "googleapis";

const {
  SHEET_ID,
  GOOGLE_CREDENTIALS,
  SHEET_VND = "VND",
  SHEET_CNY = "CNY",
  SHEET_NPR = "NPR",
  SHEET_KHR = "KHR",
} = process.env;

function authSheets() {
  const creds = JSON.parse(GOOGLE_CREDENTIALS);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth: jwt });
}

function groupByBase(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.base)) map.set(r.base, []);
    map.get(r.base).push(r);
  }
  return map;
}

function makeRow(nowKST, itemsForBase) {
  const kstDate = nowKST.toISOString().slice(0, 10);
  const kstTime = nowKST.toTimeString().slice(0, 8);

  const bySite = Object.fromEntries(itemsForBase.map(r => [r.site, r]));
  const e9 = bySite.e9pay?.krwPerBase || 0;
  const gm = bySite.gmoneytrans?.krwPerBase || 0;
  const gme = bySite.gme?.krwPerBase || 0;
  const mid = itemsForBase[0]?.mid || 0;

  const candidates = [
    ["e9pay", e9], ["gmoney", gm], ["gme", gme],
  ].filter(([, v]) => v > 0);

  const best = candidates.length ? candidates.sort((a, b) => b[1] - a[1])[0] : ["", 0];
  const note = itemsForBase.map(r => r.note).filter(Boolean).join(" | ") || "0";

  // EXACT column order to match your sheets:
  return [kstDate, kstTime, e9, gm, gme, mid, best[0], best[1], note];
}

async function writeAll() {
  const sheets = authSheets();
  const data = await scrapeOnce();
  const byBase = groupByBase(data);

  const nowKST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));

  const baseToTab = new Map([
    ["VND", SHEET_VND],
    ["CNY", SHEET_CNY],
    ["NPR", SHEET_NPR],
    ["KHR", SHEET_KHR],
  ]);

  for (const [base, items] of byBase.entries()) {
    const values = [makeRow(nowKST, items)];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${baseToTab.get(base)}!A:I`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });
  }
}

writeAll().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
