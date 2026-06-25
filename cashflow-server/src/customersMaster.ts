/**
 * Customer master list (the same sheet the AR dashboard reads). The "Private
 * Label" column marks which customers are private-label / co-pack ("Infused")
 * rather than Little Tree wholesale retail. We use that tick - NOT a hardcoded
 * brand regex - to classify private label, so the AR numbers here match the AR
 * dashboard exactly (no "two places, two amounts").
 *
 * Sheet: 15Xztf… gid=1813610735. Columns: Customer Name, Private Label, …, Brand.
 */

const SHEET_ID = '15XztfUmjiPbfh-ublCPZAVpA6MrCumytbOmhbzfGIUg';
const GID = '1813610735';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

/** Normalise a customer name for matching across sheets: drop the "Little Tree-"
 *  prefix and any non-alphanumerics, lowercase. */
export function normCustomer(s: string): string {
 return String(s || '').toLowerCase().replace(/little tree-?\s*/i, '').replace(/[^a-z0-9]/g, '');
}

function parseCsv(text: string): string[][] {
 const rows: string[][] = [];
 let cur: string[] = [], field = '', q = false;
 for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (q) {
   if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
   else field += c;
  } else {
   if (c === '"') q = true;
   else if (c === ',') { cur.push(field); field = ''; }
   else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
   else if (c !== '\r') field += c;
  }
 }
 if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
 return rows;
}

const PL_TICK = /^\s*(true|yes|1|x|✓)\s*$/i;

let cache: { at: number; set: Set<string> } | null = null;
const TTL_MS = 5 * 60 * 1000;

/** Set of normalised customer names flagged Private Label in the master list. */
export async function getPrivateLabelCustomers(): Promise<Set<string>> {
 if (cache && Date.now() - cache.at < TTL_MS) return cache.set;
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Customer master fetch failed: ${res.status}`);
 const rows = parseCsv(await res.text());
 if (rows.length === 0) return new Set();
 const header = rows[0];
 const nameI = header.findIndex((h) => /customer name/i.test(h));
 const plI = header.findIndex((h) => /private label/i.test(h));
 const set = new Set<string>();
 if (nameI >= 0 && plI >= 0) {
  for (let i = 1; i < rows.length; i++) {
   const r = rows[i];
   const name = r[nameI];
   if (name && PL_TICK.test(r[plI] ?? '')) set.add(normCustomer(name));
  }
 }
 cache = { at: Date.now(), set };
 return set;
}
