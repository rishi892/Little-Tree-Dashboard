/**
 * Little Tree Financials sheet (gid=0) - alternate sales-history source.
 *
 * User explicitly directed: the SALES FORECAST should be driven from this
 * sheet (the company's source-of-truth invoice ledger) rather than the
 * Invoice Tracker, which is the operational AR/aging workbook.
 *
 * Both sheets carry essentially the same invoices (totals match to within
 * a few dollars across 2024/2025), but the company anchors year-end and
 * tax-prep reporting on this one - so the forecast should anchor here too.
 *
 * Schema (per row, after header):
 *   col 0  Inv #
 *   col 1  Date  (M/D/YY or M/D/YYYY)            - invoice date
 *   col 2  Vendor (customer)
 *   col 3  QTY
 *   col 4  Invoice Amount
 *   col 5  Invoice Paid                          - dollar amount paid
 *   col 6  Paid Date  (M/D/YY or M/D/YYYY)       - when the payment landed
 *
 * No brand column - per-brand forecasts continue to use Invoice Tracker.
 * No cell-level hyperlinks - sheet pulled as CSV (fast).
 */

import { channelOf } from './salesByChannel.js';

const SHEET_ID = '1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes';
const GID = '0';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

export type LtFinancialsInvoice = {
 invoiceNumber: string;
 date: string;                  // raw text from sheet (M/D/YY)
 invoiceDate: Date;             // parsed UTC date
 customer: string;
 amount: number;
 paid: number;
 paidDate: Date | null;         // when payment landed (col 6), null if unpaid/partial
 paidDateRaw: string;           // raw text from sheet for paid date
 channel: 'Gelato' | string;    // 'Gelato' or whatever channelOf returns
};

export type LtFinancialsResult = {
 fetchedAt: string;
 sheetUrl: string;
 invoices: LtFinancialsInvoice[];
};

// --- Parsers ---

function parseCsv(text: string): string[][] {
 const rows: string[][] = [];
 let cur: string[] = [];
 let field = '';
 let inQuotes = false;
 for (let i = 0; i < text.length; i++) {
 const c = text[i];
 if (inQuotes) {
 if (c === '"') {
 if (text[i + 1] === '"') { field += '"'; i++; }
 else inQuotes = false;
 } else field += c;
 } else {
 if (c === '"') inQuotes = true;
 else if (c === ',') { cur.push(field); field = ''; }
 else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
 else if (c !== '\r') field += c;
 }
 }
 if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
 return rows;
}

function parseMoney(s: string): number {
 const t = (s ?? '').trim();
 if (!t || t === '-' || t === '$ -') return 0;
 const neg = /\(.*\)/.test(t);
 const cleaned = t.replace(/[\$,()\s]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

/** Parse M/D/YY or M/D/YYYY into a UTC date. Defensive against the typo
 *  "2/3/206" (i.e. someone meant 2026) - if the parsed year is < 100 we
 *  treat it as 20xx; if 100-999 it's a typo and we discard. */
function parseSheetDate(s: string): Date | null {
 // Collapse common typos:
 //   - "04//24/2023" → "04/24/2023" (extra slash)
 //   - "10/23//2024" → "10/23/2024" (extra slash)
 //   - "10/20/0202" → "10/20/2020" (looks like a transposed-digit year - we'll
 //     still bail if the result is wildly wrong, but recover the obvious ones)
 const t = (s ?? '').trim().replace(/\/+/g, '/');
 if (!t) return null;
 const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
 if (!m) return null;
 const mo = Number(m[1]);
 const day = Number(m[2]);
 let yr: number;
 if (m[3].length === 2) {
   yr = 2000 + Number(m[3]);
 } else if (m[3].length === 4) {
   // Handle "0202" / "0203" / "0205" style typos (someone hit 0 instead of 2
   // for the second digit). If year starts with "020", assume "202".
   if (/^020\d$/.test(m[3])) yr = 2020 + Number(m[3].slice(3));
   else yr = Number(m[3]);
 } else if (m[3].length === 3) {
   // "206" → "2026" (most likely - user truncated leading zero)
   yr = 2000 + Number(m[3].slice(-2));
 } else {
   yr = Number(m[3]);
 }
 if (yr < 1900 || yr > 2100) return null;
 if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
 return new Date(Date.UTC(yr, mo - 1, day));
}

// --- Cache ---

let _cache: { at: number; data: LtFinancialsResult } | null = null;
const _CACHE_TTL_MS = 60 * 1000;

export function invalidateLtFinancialsCache(): void { _cache = null; }

// --- Main ---

export async function getLtFinancialsSales(): Promise<LtFinancialsResult> {
 if (_cache && Date.now() - _cache.at < _CACHE_TTL_MS) return _cache.data;

 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`LT Financials fetch failed: ${res.status} ${res.statusText}`);
 const text = await res.text();
 const rows = parseCsv(text);

 const invoices: LtFinancialsInvoice[] = [];
 const seen = new Set<string>();
 for (const r of rows) {
 const inv = (r[0] ?? '').trim();
 if (!inv || /^inv\s*#?$/i.test(inv)) continue;          // header rows
 const dateStr = (r[1] ?? '').trim();
 const invDate = parseSheetDate(dateStr);
 if (!invDate) continue;
 const customer = (r[2] ?? '').trim();
 if (!customer) continue;
 const amount = parseMoney(r[4] ?? '');
 if (amount === 0) continue;
 const paid = parseMoney(r[5] ?? '');
 const paidDateRaw = (r[6] ?? '').trim();
 const paidDate = parseSheetDate(paidDateRaw);
 const key = `${inv}|${customer.toLowerCase()}`;
 if (seen.has(key)) continue;
 seen.add(key);
 invoices.push({
 invoiceNumber: inv,
 date: dateStr,
 invoiceDate: invDate,
 customer,
 amount,
 paid,
 paidDate,
 paidDateRaw,
 channel: channelOf(customer),
 });
 }

 const data: LtFinancialsResult = {
 fetchedAt: new Date().toISOString(),
 sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${GID}`,
 invoices,
 };
 _cache = { at: Date.now(), data };
 return data;
}
