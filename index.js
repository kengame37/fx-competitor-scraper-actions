// index.js  (ESM)
// Make sure package.json has: { "type": "module" }
import { google } from 'googleapis';
import { scrapeAll } from './scrape.js';   // your existing scraper; must return rows

const TAB_KEYS = ['SHEET_VND', 'SHEET_CNY', 'SHEET_NPR', 'SHEET_KHR'];

function nowKST() {
  // date/time columns in Asia/Seoul
  const fmt = (opts) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', ...opts });
  const d = new Date();
  return {
    date: fmt({ year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(d)         // 2025-08-20
      .replace(/\//g, '-'),
    time: fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .format(d),        // 14:10:15
    iso: d.toISOString()
  };
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

function getSheetsClient() {
  const raw = requireEnv('GOOGLE_CREDENTIALS');
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    // When pasting service-account JSON into a secret it’s easy to break quoting
    throw new Error(`GOOGLE_CREDENTIALS is not valid JSON: ${e.message}`);
  }
  // GitHub often stores newlines as "\n"
  if (creds.private_key && typeof creds.private_key === 'string') {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

async function appendRows(sheets, sheetId, a1Range, values) {
  if (!values.length) return 0;
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: a1Range,                // e.g. 'CNY!A1'
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  const count = values.length;
  console.log(`✓ Appended ${count} row(s) to ${a1Range} (status ${res.status})`);
  return count;
}

function summarizeByCurrency(rows, base) {
  // rows are expected to contain: { site, base, quote, service_krw_per_base, mid_krw_per_base, note }
  const slice = rows.filter(r => r.base === base && r.quote === 'KRW');

  const bySite = { e9pay: 0, gmoneytrans: 0, gme: 0 };
  let mid = '';
  const notes = [];

  for (const r of slice) {
    if (Number.isFinite(r.service_krw_per_base)) {
      bySite[r.site] = r.service_krw_per_base;
    }
    if (Number.isFinite(r.mid_krw_per_base)) {
      mid = r.mid_krw_per_base;
    }
    if (r.note) notes.push(`${r.site}: ${r.note}`);
  }

  // choose best site (largest KRW per base)
  const bestEntry = Object.entries(bySite)
    .reduce((best, cur) => (cur[1] > (best?.[1] ?? -Infinity) ? cur : best), null);
  const bestSite = bestEntry?.[0] ?? '';
  const bestRate = bestEntry?.[1] ?? 0;

  return { bySite, mid, bestSite, bestRate, noteText: notes.join(' | ') };
}

async function main() {
  // 1) Validate env / config
  const SHEET_ID = requireEnv('SHEET_ID');
  const tabs = Object.fromEntries(TAB_KEYS.map(k => [k, requireEnv(k)]));
  console.log(
    `Tabs: VND=${tabs.SHEET_VND}, CNY=${tabs.SHEET_CNY}, NPR=${tabs.SHEET_NPR}, KHR=${tabs.SHEET_KHR}`
  );

  const { date, time, iso } = nowKST();

  // 2) Create Sheets client
  const sheets = getSheetsClient();

  // (Optional) tiny heartbeat write to "log" tab so we always see *something*
  try {
    await appendRows(sheets, SHEET_ID, 'log!A1', [[iso, 'start']]);
  } catch (e) {
    console.warn('log tab append failed (optional):', e.message);
  }

  // 3) Scrape
  console.log('Starting scrapeAll()…');
  const rows = await scrapeAll();  // << must return an array
  if (!Array.isArray(rows)) {
    throw new Error('scrapeAll() did not return an array');
  }
  console.log(`scrapeAll() returned ${rows.length} raw row(s).`);

  // 4) Build one line per currency and write
  const bases = ['VND', 'CNY', 'NPR', 'KHR'];
  for (const base of bases) {
    const { bySite, mid, bestSite, bestRate, noteText } = summarizeByCurrency(rows, base);
    const line = [date, time, bySite.e9pay || 0, bySite.gmoneytrans || 0, bySite.gme || 0, mid || '', bestSite, bestRate, noteText];
    const tab = tabs[`SHEET_${base}`];
    await appendRows(sheets, SHEET_ID, `${tab}!A1`, [line]);
  }

  // 5) Tail log
  await appendRows(sheets, SHEET_ID, 'log!A1', [[iso, 'done']]);
  console.log('All writes completed.');
}

// Make sure Node **waits** for async work and fails if something throws
(async () => {
  try {
    await main();
  } catch (e) {
    console.error('FATAL:', e.stack || e.message);
    process.exit(1);
  }
})();
