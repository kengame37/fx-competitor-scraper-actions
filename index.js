// index.js
import { google } from "googleapis";
import { scrapeAll } from "./scrape.js";

const SHEET_ID = process.env.SHEET_ID;
const CREDS = JSON.parse(process.env.GOOGLE_CREDENTIALS);

// Tabs (must exist in the spreadsheet)
const TABS = ["VND", "CNY", "NPR", "KHR"];

// Column header
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

async function getSheetsClient() {
  const auth = new google.auth.JWT(
    CREDS.client_email,
    null,
    CREDS.private_key.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

async function ensureHeader(sheets, tab) {
  const range = `${tab}!A1:I1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range,
  }).catch(() => null);

  const have = res?.data?.values?.[0] || [];
  const same = have.length === HEADER.length && have.every((v, i) => v === HEADER[i]);
  if (!same) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
  }
}

function pickBestSite(row) {
  const candidates = [
    { site: "e9pay", rate: row.e9pay || 0 },
    { site: "gmoney", rate: row.gmoney || 0 },
    { site: "gme", rate: row.gme || 0 },
  ].filter(x => x.rate > 0);

  if (!candidates.length) return { bestSite: "", bestRate: 0 };
  const best = candidates.reduce((a, b) => (b.rate > a.rate ? b : a));
  return { bestSite: best.site, bestRate: best.rate };
}

function groupRowsByBase(rows) {
  const out = {};
  for (const r of rows) {
    const base = r.base;
    if (!out[base]) {
      out[base] = {
        date: r.date, time: r.time, mid: r.mid_krw_per_base ?? null,
        e9pay: 0, gmoney: 0, gme: 0, notes: []
      };
    }
    if (r.ok && r.service_krw_per_base) {
      if (r.site === "e9pay") out[base].e9pay = r.service_krw_per_base;
      if (r.site === "gmoneytrans") out[base].gmoney = r.service_krw_per_base;
      if (r.site === "gme") out[base].gme = r.service_krw_per_base;
    } else if (r.error) {
      out[base].notes.push(`${r.site}: ${r.error}`);
    }
  }
  return out;
}

async function main() {
  const sheets = await getSheetsClient();
  for (const tab of TABS) await ensureHeader(sheets, tab);

  const rows = await scrapeAll();
  const grouped = groupRowsByBase(rows);

  for (const base of Object.keys(grouped)) {
    const tab = base; // tab names equal to base: VND/CNY/NPR/KHR
    if (!TABS.includes(tab)) continue;

    const g = grouped[base];
    const { bestSite, bestRate } = pickBestSite(g);
    const notes = g.notes.join(" | ");

    const append = [
      g.date,
      g.time,
      g.e9pay || 0,
      g.gmoney || 0,
      g.gme || 0,
      g.mid ?? "",
      bestSite,
      bestRate || 0,
      notes,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A:A`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [append] },
    });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
