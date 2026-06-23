/**
 * AR Status - 2026-focused cash-collection view.
 *
 * Built from the LT Financials sheet (source of truth for invoices + paid
 * dates). Answers the operational questions the user actually asks:
 *
 *   "Is month ka kitna collection hai?"      → collectedThisMonth
 *   "Per week ka kitna hai?"                  → collectedByWeekCurrentMonth
 *   "Sab outstanding kitna hai?"              → outstandingTotal (+ aging buckets)
 *
 * Important rule (per user direction):
 *   Collection is bucketed by PAID DATE, not invoice date. So a Dec-2025
 *   invoice that gets paid in Jan-2026 counts as 2026 collection. The 2025
 *   number is the invoice's issue year - irrelevant for cash arrival.
 *
 * Only the current calendar year (2026 right now) is shown.
 */

import { getLtFinancialsSales, type LtFinancialsInvoice } from './ltFinancialsSales.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Gelato has its own AR pipeline (Net 97, dedicated Gelato Sales sheet) so
 *  we exclude it from the LT-Financials-driven AR Status view to avoid mixing
 *  apples & oranges. Matches "Little Tree Gelato" / "Gelato" variants. */
const GELATO_CUSTOMER_RX = /(?:little tree[- ]+)?gelato/i;

export type ArStatusResult = {
 fetchedAt: string;
 year: number;                                         // calendar year reported
 asOfDate: string;                                     // YYYY-MM-DD
 currentMonth: { ym: string; label: string };
 /** Total $ collected so far this year (any invoice age). */
 collectedYtd: number;
 collectedYtdInvoiceCount: number;
 /** $ collected this calendar month. */
 collectedThisMonth: number;
 collectedThisMonthInvoiceCount: number;
 /** Per-month collection ($) for the year. */
 collectedByMonth: Array<{ ym: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 /** Per-week breakdown of the CURRENT month's collection (Mon-Sun weeks). */
 collectedByWeekCurrentMonth: Array<{ weekStart: string; weekEnd: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 /** How much of YTD collection came from invoices issued in PRIOR years
  *  (the "Dec invoice paid in 2026" leakage the user asked us to capture). */
 ytdFromPriorYearInvoices: number;
 ytdFromPriorYearInvoiceCount: number;
 /** Paid amount that has NO paidDate set on the sheet - flagged so the user
  *  can chase down which rows need a date filled in. These dollars are
  *  excluded from the monthly buckets above (we can't bucket by date if
  *  there isn't one) - they're shown separately as a data-quality leak. */
 paidWithMissingDate: number;
 paidWithMissingDateCount: number;
 paidWithMissingDateSamples: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   paidDateRaw: string;       // empty or unparseable
 }>;
 /** Total open AR (sum of amount - paid, where invoice is not fully paid). */
 outstandingTotal: number;
 outstandingCount: number;
 /** Aging buckets relative to today (days since invoice issue date). */
 outstandingByAge: {
   current: { amount: number; count: number };       // ≤ 30 days
   d31_60: { amount: number; count: number };
   d61_90: { amount: number; count: number };
   d91Plus: { amount: number; count: number };
 };
 /** Top 10 open invoices by dollar amount, for the at-risk list. */
 topOpenInvoices: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   outstanding: number;
   daysOpen: number;
 }>;
};

function ymdOf(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function ymKey(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(year: number, month0: number): string {
 const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
 return `${NAMES[month0]} ${String(year).slice(-2)}`;
}

/** Monday on or before d (UTC). */
function mondayOf(d: Date): Date {
 const day = d.getUTCDay();
 const shift = day === 0 ? 6 : day - 1;
 const r = new Date(d);
 r.setUTCDate(r.getUTCDate() - shift);
 r.setUTCHours(0, 0, 0, 0);
 return r;
}

/** Build week-buckets for a calendar month. Each bucket spans a Mon-Sun week,
 *  CLIPPED to the month boundary - so the first bucket may be Wed-Sun and the
 *  last may be Mon-Wed, both labelled with their in-month days only. This
 *  avoids the confusing "label says Apr 27 but $200k actually paid May 1" UX
 *  bug where the bucket Monday fell in the prior month. */
function weeksTouchingMonth(year: number, month0: number, today: Date): Array<{ weekStart: Date; weekEnd: Date; isCurrent: boolean }> {
 const monthStart = new Date(Date.UTC(year, month0, 1));
 const monthEnd = new Date(Date.UTC(year, month0 + 1, 0));    // last day of month
 const firstWeekMon = mondayOf(monthStart);
 const out: Array<{ weekStart: Date; weekEnd: Date; isCurrent: boolean }> = [];
 const todayMon = mondayOf(today);
 let cur = new Date(firstWeekMon);
 while (cur <= monthEnd) {
   const rawEnd = new Date(cur.getTime() + 6 * MS_PER_DAY);
   // Clip to month: first bucket starts at monthStart (not the Monday before it),
   // last bucket ends at monthEnd (not the Sunday after it).
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

export async function getArStatus(): Promise<ArStatusResult> {
 const ltFin = await getLtFinancialsSales();
 const now = new Date();
 const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
 const year = today.getUTCFullYear();
 const currentMonth0 = today.getUTCMonth();
 const currentYm = ymKey(today);

 // --- Bucket: collection by month / by week (paid in `year`) ---
 const collectedByMonthMap = new Map<string, { amount: number; invoiceCount: number }>();
 for (let m = 0; m <= currentMonth0; m++) {
   const ym = `${year}-${String(m + 1).padStart(2, '0')}`;
   collectedByMonthMap.set(ym, { amount: 0, invoiceCount: 0 });
 }
 const currentMonthWeeks = weeksTouchingMonth(year, currentMonth0, today);
 const weekBuckets = currentMonthWeeks.map(() => ({ amount: 0, invoiceCount: 0 }));

 let collectedYtd = 0;
 let collectedYtdCount = 0;
 let collectedThisMonth = 0;
 let collectedThisMonthCount = 0;
 let ytdFromPriorYearInvoices = 0;
 let ytdFromPriorYearCount = 0;
 let paidWithMissingDate = 0;
 let paidWithMissingDateCount = 0;
 const missingDateList: Array<{ inv: LtFinancialsInvoice; outstanding: number }> = [];

 for (const inv of ltFin.invoices) {
   if (GELATO_CUSTOMER_RX.test(inv.customer)) continue;   // own pipeline, excluded
   if (inv.paid <= 0) continue;
   if (!inv.paidDate) {
     // Data leak: invoice has a paid amount but no parseable paid date.
     // Tracked separately so the user can fix the sheet.
     paidWithMissingDate += inv.paid;
     paidWithMissingDateCount += 1;
     missingDateList.push({ inv, outstanding: inv.amount - inv.paid });
     continue;
   }
   if (inv.paidDate.getUTCFullYear() !== year) continue;

   collectedYtd += inv.paid;
   collectedYtdCount += 1;
   if (inv.invoiceDate.getUTCFullYear() < year) {
     ytdFromPriorYearInvoices += inv.paid;
     ytdFromPriorYearCount += 1;
   }

   const ym = ymKey(inv.paidDate);
   const monthBucket = collectedByMonthMap.get(ym);
   if (monthBucket) {
     monthBucket.amount += inv.paid;
     monthBucket.invoiceCount += 1;
   }

   if (ym === currentYm) {
     collectedThisMonth += inv.paid;
     collectedThisMonthCount += 1;
     // Bucket into current month weeks (using paidDate).
     const paidT = inv.paidDate.getTime();
     for (let wi = 0; wi < currentMonthWeeks.length; wi++) {
       const w = currentMonthWeeks[wi];
       if (paidT >= w.weekStart.getTime() && paidT <= w.weekEnd.getTime() + (MS_PER_DAY - 1)) {
         weekBuckets[wi].amount += inv.paid;
         weekBuckets[wi].invoiceCount += 1;
         break;
       }
     }
   }
 }

 // --- Outstanding AR (any year, not fully paid). Aging by issue date. ---
 const outstandingByAge = {
   current: { amount: 0, count: 0 },
   d31_60:  { amount: 0, count: 0 },
   d61_90:  { amount: 0, count: 0 },
   d91Plus: { amount: 0, count: 0 },
 };
 let outstandingTotal = 0;
 let outstandingCount = 0;
 const openInvoiceList: Array<{ inv: LtFinancialsInvoice; outstanding: number; daysOpen: number }> = [];

 for (const inv of ltFin.invoices) {
   if (GELATO_CUSTOMER_RX.test(inv.customer)) continue;   // own pipeline, excluded
   if (inv.amount <= 0) continue;
   const outstanding = +(inv.amount - (inv.paid || 0)).toFixed(2);
   if (outstanding <= 0.5) continue;  // fully (or near-fully) paid

   outstandingTotal += outstanding;
   outstandingCount += 1;
   const daysOpen = Math.max(0, Math.floor((today.getTime() - inv.invoiceDate.getTime()) / MS_PER_DAY));
   openInvoiceList.push({ inv, outstanding, daysOpen });

   if      (daysOpen <= 30)  { outstandingByAge.current.amount += outstanding; outstandingByAge.current.count += 1; }
   else if (daysOpen <= 60)  { outstandingByAge.d31_60.amount  += outstanding; outstandingByAge.d31_60.count  += 1; }
   else if (daysOpen <= 90)  { outstandingByAge.d61_90.amount  += outstanding; outstandingByAge.d61_90.count  += 1; }
   else                      { outstandingByAge.d91Plus.amount += outstanding; outstandingByAge.d91Plus.count += 1; }
 }

 // Top-10 open invoices by outstanding $.
 const topOpenInvoices = openInvoiceList
   .sort((a, b) => b.outstanding - a.outstanding)
   .slice(0, 10)
   .map((o) => ({
     invoiceNumber: o.inv.invoiceNumber || '',
     customer: o.inv.customer || '',
     invoiceDate: ymdOf(o.inv.invoiceDate),
     amount: +o.inv.amount.toFixed(2),
     paid: +(o.inv.paid || 0).toFixed(2),
     outstanding: +o.outstanding.toFixed(2),
     daysOpen: o.daysOpen,
   }));

 const collectedByMonth = [...collectedByMonthMap.entries()].map(([ym, b]) => {
   const m0 = Number(ym.split('-')[1]) - 1;
   return {
     ym,
     label: monthLabel(year, m0),
     amount: +b.amount.toFixed(2),
     invoiceCount: b.invoiceCount,
     isCurrent: ym === currentYm,
   };
 });

 const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
 const collectedByWeekCurrentMonth = currentMonthWeeks.map((w, i) => {
   const mo = MONTH_SHORT[w.weekStart.getUTCMonth()];
   const d1 = w.weekStart.getUTCDate();
   const d2 = w.weekEnd.getUTCDate();
   // Compact label: same day = "May 3", same month = "May 1-3", spans months = "Apr 27 - May 3" (rare since we clip)
   const label = d1 === d2
     ? `${mo} ${d1}`
     : `${mo} ${d1}-${d2}`;
   return {
     weekStart: ymdOf(w.weekStart),
     weekEnd: ymdOf(w.weekEnd),
     label,
     amount: +weekBuckets[i].amount.toFixed(2),
     invoiceCount: weekBuckets[i].invoiceCount,
     isCurrent: w.isCurrent,
   };
 });

 return {
   fetchedAt: new Date().toISOString(),
   year,
   asOfDate: ymdOf(today),
   currentMonth: { ym: currentYm, label: monthLabel(year, currentMonth0) },
   collectedYtd: +collectedYtd.toFixed(2),
   collectedYtdInvoiceCount: collectedYtdCount,
   collectedThisMonth: +collectedThisMonth.toFixed(2),
   collectedThisMonthInvoiceCount: collectedThisMonthCount,
   collectedByMonth,
   collectedByWeekCurrentMonth,
   ytdFromPriorYearInvoices: +ytdFromPriorYearInvoices.toFixed(2),
   ytdFromPriorYearInvoiceCount: ytdFromPriorYearCount,
   paidWithMissingDate: +paidWithMissingDate.toFixed(2),
   paidWithMissingDateCount,
   paidWithMissingDateSamples: missingDateList
     .sort((a, b) => b.inv.paid - a.inv.paid)
     .slice(0, 10)
     .map((m) => ({
       invoiceNumber: m.inv.invoiceNumber || '',
       customer: m.inv.customer || '',
       invoiceDate: ymdOf(m.inv.invoiceDate),
       amount: +m.inv.amount.toFixed(2),
       paid: +m.inv.paid.toFixed(2),
       paidDateRaw: m.inv.paidDateRaw || '',
     })),
   outstandingTotal: +outstandingTotal.toFixed(2),
   outstandingCount,
   outstandingByAge: {
     current: { amount: +outstandingByAge.current.amount.toFixed(2), count: outstandingByAge.current.count },
     d31_60:  { amount: +outstandingByAge.d31_60.amount.toFixed(2),  count: outstandingByAge.d31_60.count  },
     d61_90:  { amount: +outstandingByAge.d61_90.amount.toFixed(2),  count: outstandingByAge.d61_90.count  },
     d91Plus: { amount: +outstandingByAge.d91Plus.amount.toFixed(2), count: outstandingByAge.d91Plus.count },
   },
   topOpenInvoices,
 };
}
