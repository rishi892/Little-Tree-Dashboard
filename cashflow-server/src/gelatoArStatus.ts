/**
 * Gelato AR Status - 2026-focused cash-collection view.
 *
 * Source: Gelato Invoice Tracker Google Sheet
 *   https://docs.google.com/spreadsheets/d/12Ql1knwLc8BLarffTirH8II_lgSkpuFB0nad82K5JeE/edit?gid=1025747160
 *
 * Schema (per row, after the header row):
 *   col 0  Invoice #
 *   col 1  Date            - invoice date (mixed formats: "05 May 2023", "M/D/YYYY", etc.)
 *   col 2  Vendor          - customer like "Gelato- Pure Options"
 *   col 3  Invoice Amount  - "$1,234.56" or "1234.56" with $/, signs
 *   col 4  Amount Paid     - same format
 *   col 5  Money Owed      - outstanding (may be negative for overpayment)
 *   col 6  Payment Date    - when payment landed (M/D/YYYY)
 *   col 7  Link
 *   col 8  Status          - Paid | Write Off | Pending | etc.
 *
 * Mirrors arStatus.ts in shape so the UI can reuse the same component
 * structure. Buckets by paidDate (cash arrival year), excludes Write-Offs
 * from outstanding totals.
 */

const SHEET_ID = '12Ql1knwLc8BLarffTirH8II_lgSkpuFB0nad82K5JeE';
const GID = '1025747160';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${GID}#gid=${GID}`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
                     'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type GelatoArStatusResult = {
 fetchedAt: string;
 sheetUrl: string;
 year: number;
 asOfDate: string;
 currentMonth: { ym: string; label: string };
 collectedYtd: number;
 collectedYtdInvoiceCount: number;
 collectedThisMonth: number;
 collectedThisMonthInvoiceCount: number;
 collectedByMonth: Array<{ ym: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 collectedByWeekCurrentMonth: Array<{ weekStart: string; weekEnd: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 ytdFromPriorYearInvoices: number;
 ytdFromPriorYearInvoiceCount: number;
 paidWithMissingDate: number;
 paidWithMissingDateCount: number;
 paidWithMissingDateSamples: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   paidDateRaw: string;
 }>;
 outstandingTotal: number;
 outstandingCount: number;
 outstandingByAge: {
   current: { amount: number; count: number };
   d31_60: { amount: number; count: number };
   d61_90: { amount: number; count: number };
   d91Plus: { amount: number; count: number };
 };
 topOpenInvoices: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   outstanding: number;
   daysOpen: number;
   status: string;
 }>;
 writeOffStats: { count: number; amount: number };
};

// --- CSV parser (matches the one in salesByChannel) ---
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
 const negative = /\(.*\)/.test(t);
 const cleaned = t.replace(/[$,()\s]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

/** Parse any of: "M/D/YYYY", "M/D/YY", "DD Month YYYY", "DD MMM YYYY", "YYYY-MM-DD". */
function parseAnyDate(s: string): Date | null {
 const t = (s ?? '').trim().replace(/\/+/g, '/');
 if (!t) return null;
 // ISO
 const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
 if (iso) {
   const y = Number(iso[1]); const mo = Number(iso[2]); const d = Number(iso[3]);
   if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo - 1, d));
 }
 // M/D/YYYY or M/D/YY
 const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
 if (mdy) {
   const mo = Number(mdy[1]); const d = Number(mdy[2]);
   let y: number;
   if (mdy[3].length === 2) y = 2000 + Number(mdy[3]);
   else if (mdy[3].length === 4 && /^020\d$/.test(mdy[3])) y = 2020 + Number(mdy[3].slice(3));
   else y = Number(mdy[3]);
   if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
     return new Date(Date.UTC(y, mo - 1, d));
   }
 }
 // "DD Month YYYY" or "DD MMM YYYY"
 const dmy = t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
 if (dmy) {
   const d = Number(dmy[1]);
   const prefix = dmy[2].toLowerCase().substring(0, 3);
   const mo = MONTH_NAMES.findIndex((m) => m.startsWith(prefix));
   const y = Number(dmy[3]);
   if (mo >= 0 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
     return new Date(Date.UTC(y, mo, d));
   }
 }
 return null;
}

function ymdOf(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function ymKey(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(year: number, month0: number): string {
 return `${MONTH_SHORT[month0]} ${String(year).slice(-2)}`;
}
function mondayOf(d: Date): Date {
 const day = d.getUTCDay();
 const shift = day === 0 ? 6 : day - 1;
 const r = new Date(d);
 r.setUTCDate(r.getUTCDate() - shift);
 r.setUTCHours(0, 0, 0, 0);
 return r;
}
function weeksTouchingMonth(year: number, month0: number, today: Date): Array<{ weekStart: Date; weekEnd: Date; isCurrent: boolean }> {
 const monthStart = new Date(Date.UTC(year, month0, 1));
 const monthEnd = new Date(Date.UTC(year, month0 + 1, 0));
 const firstWeekMon = mondayOf(monthStart);
 const out: Array<{ weekStart: Date; weekEnd: Date; isCurrent: boolean }> = [];
 const todayMon = mondayOf(today);
 let cur = new Date(firstWeekMon);
 while (cur <= monthEnd) {
   const rawEnd = new Date(cur.getTime() + 6 * MS_PER_DAY);
   const clippedStart = cur < monthStart ? monthStart : cur;
   const clippedEnd   = rawEnd > monthEnd ? monthEnd : rawEnd;
   out.push({
     weekStart: clippedStart,
     weekEnd: clippedEnd,
     isCurrent: cur.getTime() === todayMon.getTime(),
   });
   cur = new Date(cur.getTime() + 7 * MS_PER_DAY);
 }
 return out;
}

// --- Cache (60s TTL) ---
let _cache: { at: number; data: GelatoArStatusResult } | null = null;
const CACHE_TTL_MS = 60 * 1000;
export function invalidateGelatoArStatusCache(): void { _cache = null; }

export async function getGelatoArStatus(): Promise<GelatoArStatusResult> {
 if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;

 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Gelato AR sheet fetch failed: ${res.status} ${res.statusText}`);
 const rows = parseCsv(await res.text());

 const now = new Date();
 const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
 const year = today.getUTCFullYear();
 const currentMonth0 = today.getUTCMonth();
 const currentYm = ymKey(today);

 // Pre-seed monthly buckets up to current month.
 const collectedByMonthMap = new Map<string, { amount: number; invoiceCount: number }>();
 for (let m = 0; m <= currentMonth0; m++) {
   collectedByMonthMap.set(`${year}-${String(m + 1).padStart(2, '0')}`, { amount: 0, invoiceCount: 0 });
 }
 const currentMonthWeeks = weeksTouchingMonth(year, currentMonth0, today);
 const weekBuckets = currentMonthWeeks.map(() => ({ amount: 0, invoiceCount: 0 }));

 let collectedYtd = 0, collectedYtdCount = 0;
 let collectedThisMonth = 0, collectedThisMonthCount = 0;
 let ytdFromPriorYear = 0, ytdFromPriorYearCount = 0;
 let paidWithMissingDate = 0, paidWithMissingDateCount = 0;
 let writeOffCount = 0, writeOffAmount = 0;
 const missingDateList: Array<{ inv: string; cust: string; invDate: Date | null; amount: number; paid: number; paidRaw: string }> = [];

 const outstandingByAge = {
   current: { amount: 0, count: 0 },
   d31_60:  { amount: 0, count: 0 },
   d61_90:  { amount: 0, count: 0 },
   d91Plus: { amount: 0, count: 0 },
 };
 let outstandingTotal = 0, outstandingCount = 0;
 const openList: Array<{ inv: string; cust: string; invDate: Date | null; amount: number; paid: number; out: number; daysOpen: number; status: string }> = [];

 for (let i = 1; i < rows.length; i++) {  // skip header at row 0
   const r = rows[i];
   const invNum = (r[0] ?? '').trim();
   if (!invNum || /^invoice/i.test(invNum)) continue;          // header / empty
   const dateRaw = (r[1] ?? '').trim();
   const customer = (r[2] ?? '').trim();
   if (!customer) continue;
   const amount = parseMoney(r[3] ?? '');
   const paid = parseMoney(r[4] ?? '');
   // r[5] (Money Owed) can drift from amount-paid for credits/overpays, so we
   // recompute from amount/paid below for consistency with the LT pipeline.
   const paidDateRaw = (r[6] ?? '').trim();
   const status = (r[8] ?? '').trim();
   const invDate = parseAnyDate(dateRaw);
   const paidDate = parseAnyDate(paidDateRaw);

   // Write-offs: count but don't include in outstanding/collection.
   if (/write[\s-]?off/i.test(status)) {
     writeOffCount++;
     writeOffAmount += amount;
     continue;
   }

   // --- COLLECTION side ---
   if (paid > 0) {
     if (!paidDate) {
       paidWithMissingDate += paid;
       paidWithMissingDateCount += 1;
       missingDateList.push({ inv: invNum, cust: customer, invDate, amount, paid, paidRaw: paidDateRaw });
     } else if (paidDate.getUTCFullYear() === year) {
       collectedYtd += paid;
       collectedYtdCount += 1;
       if (invDate && invDate.getUTCFullYear() < year) {
         ytdFromPriorYear += paid;
         ytdFromPriorYearCount += 1;
       }
       const ym = ymKey(paidDate);
       const monthBucket = collectedByMonthMap.get(ym);
       if (monthBucket) {
         monthBucket.amount += paid;
         monthBucket.invoiceCount += 1;
       }
       if (ym === currentYm) {
         collectedThisMonth += paid;
         collectedThisMonthCount += 1;
         const t = paidDate.getTime();
         for (let wi = 0; wi < currentMonthWeeks.length; wi++) {
           const w = currentMonthWeeks[wi];
           if (t >= w.weekStart.getTime() && t <= w.weekEnd.getTime() + (MS_PER_DAY - 1)) {
             weekBuckets[wi].amount += paid;
             weekBuckets[wi].invoiceCount += 1;
             break;
           }
         }
       }
     }
   }

   // --- OUTSTANDING side ---
   if (amount > 0) {
     const outstanding = +(amount - paid).toFixed(2);
     if (outstanding > 0.5) {
       outstandingTotal += outstanding;
       outstandingCount += 1;
       const daysOpen = invDate
         ? Math.max(0, Math.floor((today.getTime() - invDate.getTime()) / MS_PER_DAY))
         : 9999;
       openList.push({ inv: invNum, cust: customer, invDate, amount, paid, out: outstanding, daysOpen, status });
       if      (daysOpen <= 30)  { outstandingByAge.current.amount += outstanding; outstandingByAge.current.count += 1; }
       else if (daysOpen <= 60)  { outstandingByAge.d31_60.amount  += outstanding; outstandingByAge.d31_60.count  += 1; }
       else if (daysOpen <= 90)  { outstandingByAge.d61_90.amount  += outstanding; outstandingByAge.d61_90.count  += 1; }
       else                      { outstandingByAge.d91Plus.amount += outstanding; outstandingByAge.d91Plus.count += 1; }
     }
   }
 }

 const collectedByMonth = [...collectedByMonthMap.entries()].map(([ym, b]) => {
   const m0 = Number(ym.split('-')[1]) - 1;
   return {
     ym, label: monthLabel(year, m0),
     amount: +b.amount.toFixed(2), invoiceCount: b.invoiceCount,
     isCurrent: ym === currentYm,
   };
 });

 const collectedByWeekCurrentMonth = currentMonthWeeks.map((w, i) => {
   const mo = MONTH_SHORT[w.weekStart.getUTCMonth()];
   const d1 = w.weekStart.getUTCDate();
   const d2 = w.weekEnd.getUTCDate();
   return {
     weekStart: ymdOf(w.weekStart),
     weekEnd: ymdOf(w.weekEnd),
     label: d1 === d2 ? `${mo} ${d1}` : `${mo} ${d1}-${d2}`,
     amount: +weekBuckets[i].amount.toFixed(2),
     invoiceCount: weekBuckets[i].invoiceCount,
     isCurrent: w.isCurrent,
   };
 });

 const result: GelatoArStatusResult = {
   fetchedAt: new Date().toISOString(),
   sheetUrl: SHEET_URL,
   year,
   asOfDate: ymdOf(today),
   currentMonth: { ym: currentYm, label: monthLabel(year, currentMonth0) },
   collectedYtd: +collectedYtd.toFixed(2),
   collectedYtdInvoiceCount: collectedYtdCount,
   collectedThisMonth: +collectedThisMonth.toFixed(2),
   collectedThisMonthInvoiceCount: collectedThisMonthCount,
   collectedByMonth,
   collectedByWeekCurrentMonth,
   ytdFromPriorYearInvoices: +ytdFromPriorYear.toFixed(2),
   ytdFromPriorYearInvoiceCount: ytdFromPriorYearCount,
   paidWithMissingDate: +paidWithMissingDate.toFixed(2),
   paidWithMissingDateCount,
   paidWithMissingDateSamples: missingDateList
     .sort((a, b) => b.paid - a.paid)
     .slice(0, 10)
     .map((m) => ({
       invoiceNumber: m.inv,
       customer: m.cust,
       invoiceDate: m.invDate ? ymdOf(m.invDate) : '',
       amount: +m.amount.toFixed(2),
       paid: +m.paid.toFixed(2),
       paidDateRaw: m.paidRaw,
     })),
   outstandingTotal: +outstandingTotal.toFixed(2),
   outstandingCount,
   outstandingByAge: {
     current: { amount: +outstandingByAge.current.amount.toFixed(2), count: outstandingByAge.current.count },
     d31_60:  { amount: +outstandingByAge.d31_60.amount.toFixed(2),  count: outstandingByAge.d31_60.count  },
     d61_90:  { amount: +outstandingByAge.d61_90.amount.toFixed(2),  count: outstandingByAge.d61_90.count  },
     d91Plus: { amount: +outstandingByAge.d91Plus.amount.toFixed(2), count: outstandingByAge.d91Plus.count },
   },
   topOpenInvoices: openList
     .sort((a, b) => b.out - a.out)
     .slice(0, 10)
     .map((o) => ({
       invoiceNumber: o.inv,
       customer: o.cust,
       invoiceDate: o.invDate ? ymdOf(o.invDate) : '',
       amount: +o.amount.toFixed(2),
       paid: +o.paid.toFixed(2),
       outstanding: +o.out.toFixed(2),
       daysOpen: o.daysOpen,
       status: o.status,
     })),
   writeOffStats: { count: writeOffCount, amount: +writeOffAmount.toFixed(2) },
 };

 _cache = { at: Date.now(), data: result };
 return result;
}
