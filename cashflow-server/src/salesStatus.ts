/**
 * Sales Status - 2026-focused invoicing view (sibling of AR Status).
 *
 * Built from the LT Financials sheet (source of truth for invoices). Answers
 * the operational sales questions:
 *
 *   "Is month ka kitna sales hua?"            → invoicedThisMonth
 *   "Per week ka kitna sales hua?"            → invoicedByWeekCurrentMonth
 *   "YTD kitna sales hua aur kitna collect?"  → invoicedYtd / collectedFromYtd
 *
 * Difference vs AR Status:
 *   - AR Status buckets by PAID DATE (cash arrival)
 *   - Sales Status buckets by INVOICE DATE (billing run-rate)
 *
 * Gelato excluded - own pipeline. 2026 invoice-date-filtered.
 */

import { getLtFinancialsSales, type LtFinancialsInvoice } from './ltFinancialsSales.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Excluded customers: Gelato (own pipeline) + brand-side / co-pack partners
// (Alien Brainz, Funk'd Up, Yacht Fuel). These three are NOT retail/wholesale
// revenue - they're separate brand deals that have their own AR pipelines.
// Per user direction (consistency with Sales Forecast's Little Tree bucket).
const EXCLUDED_CUSTOMER_RX = /(?:little tree[- ]+)?(gelato|alien\s+(?:brainz|brains|arainz)\b|funk'?d?\s*up\b|(?:yacht|tacht)\s+fuel)/i;

export type SalesStatusResult = {
 fetchedAt: string;
 year: number;
 asOfDate: string;
 currentMonth: { ym: string; label: string };
 /** Total $ invoiced in 2026 (any customer). */
 invoicedYtd: number;
 invoicedYtdCount: number;
 /** $ invoiced this calendar month. */
 invoicedThisMonth: number;
 invoicedThisMonthCount: number;
 /** Per-month invoiced ($) for the year. */
 invoicedByMonth: Array<{ ym: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 /** Per-week breakdown of CURRENT month's invoicing (clipped to month). */
 invoicedByWeekCurrentMonth: Array<{ weekStart: string; weekEnd: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 /** How much of YTD invoiced has been collected so far (any time). */
 collectedFromYtd: number;
 collectedFromYtdCount: number;
 /** Outstanding from YTD invoices (amount - paid where invoice was issued in `year`). */
 outstandingFromYtd: number;
 outstandingFromYtdCount: number;
 /** Top 10 customers by 2026 invoiced $. */
 topCustomersYtd: Array<{
   customer: string;
   invoicedAmount: number;
   paidAmount: number;
   outstandingAmount: number;
   invoiceCount: number;
   lastInvoiceDate: string | null;
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

function mondayOf(d: Date): Date {
 const day = d.getUTCDay();
 const shift = day === 0 ? 6 : day - 1;
 const r = new Date(d);
 r.setUTCDate(r.getUTCDate() - shift);
 r.setUTCHours(0, 0, 0, 0);
 return r;
}

/** Mon-Sun weeks touching a month, CLIPPED to the month boundary (same as
 *  arStatus). First/last buckets get trimmed to in-month days only. */
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

export async function getSalesStatus(): Promise<SalesStatusResult> {
 const ltFin = await getLtFinancialsSales();
 const now = new Date();
 const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
 const year = today.getUTCFullYear();
 const currentMonth0 = today.getUTCMonth();
 const currentYm = ymKey(today);

 // Pre-seed monthly buckets so months with $0 still show up.
 const invoicedByMonthMap = new Map<string, { amount: number; invoiceCount: number }>();
 for (let m = 0; m <= currentMonth0; m++) {
   const ym = `${year}-${String(m + 1).padStart(2, '0')}`;
   invoicedByMonthMap.set(ym, { amount: 0, invoiceCount: 0 });
 }
 const currentMonthWeeks = weeksTouchingMonth(year, currentMonth0, today);
 const weekBuckets = currentMonthWeeks.map(() => ({ amount: 0, invoiceCount: 0 }));

 let invoicedYtd = 0;
 let invoicedYtdCount = 0;
 let invoicedThisMonth = 0;
 let invoicedThisMonthCount = 0;
 let collectedFromYtd = 0;
 let collectedFromYtdCount = 0;
 let outstandingFromYtd = 0;
 let outstandingFromYtdCount = 0;

 // Per-customer accumulator over 2026 invoices.
 const custMap = new Map<string, { customer: string; invoicedAmount: number; paidAmount: number; invoiceCount: number; lastInvoiceDate: Date | null }>();

 for (const inv of ltFin.invoices) {
   if (EXCLUDED_CUSTOMER_RX.test(inv.customer)) continue;
   if (inv.amount <= 0) continue;
   if (inv.invoiceDate.getUTCFullYear() !== year) continue;

   invoicedYtd += inv.amount;
   invoicedYtdCount += 1;

   const paid = inv.paid || 0;
   collectedFromYtd += paid;
   if (paid > 0) collectedFromYtdCount += 1;

   const outstanding = inv.amount - paid;
   if (outstanding > 0.5) {
     outstandingFromYtd += outstanding;
     outstandingFromYtdCount += 1;
   }

   const ym = ymKey(inv.invoiceDate);
   const monthBucket = invoicedByMonthMap.get(ym);
   if (monthBucket) {
     monthBucket.amount += inv.amount;
     monthBucket.invoiceCount += 1;
   }

   if (ym === currentYm) {
     invoicedThisMonth += inv.amount;
     invoicedThisMonthCount += 1;
     // Per-week bucket using invoiceDate.
     const t = inv.invoiceDate.getTime();
     for (let wi = 0; wi < currentMonthWeeks.length; wi++) {
       const w = currentMonthWeeks[wi];
       if (t >= w.weekStart.getTime() && t <= w.weekEnd.getTime() + (MS_PER_DAY - 1)) {
         weekBuckets[wi].amount += inv.amount;
         weekBuckets[wi].invoiceCount += 1;
         break;
       }
     }
   }

   // Per-customer tally (2026 only).
   let c = custMap.get(inv.customer);
   if (!c) {
     c = { customer: inv.customer, invoicedAmount: 0, paidAmount: 0, invoiceCount: 0, lastInvoiceDate: null };
     custMap.set(inv.customer, c);
   }
   c.invoicedAmount += inv.amount;
   c.paidAmount += paid;
   c.invoiceCount += 1;
   if (!c.lastInvoiceDate || inv.invoiceDate > c.lastInvoiceDate) c.lastInvoiceDate = inv.invoiceDate;
 }

 const topCustomersYtd = [...custMap.values()]
   .sort((a, b) => b.invoicedAmount - a.invoicedAmount)
   .slice(0, 10)
   .map((c) => ({
     customer: c.customer,
     invoicedAmount: +c.invoicedAmount.toFixed(2),
     paidAmount: +c.paidAmount.toFixed(2),
     outstandingAmount: +(c.invoicedAmount - c.paidAmount).toFixed(2),
     invoiceCount: c.invoiceCount,
     lastInvoiceDate: c.lastInvoiceDate ? ymdOf(c.lastInvoiceDate) : null,
   }));

 const invoicedByMonth = [...invoicedByMonthMap.entries()].map(([ym, b]) => {
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
 const invoicedByWeekCurrentMonth = currentMonthWeeks.map((w, i) => {
   const mo = MONTH_SHORT[w.weekStart.getUTCMonth()];
   const d1 = w.weekStart.getUTCDate();
   const d2 = w.weekEnd.getUTCDate();
   const label = d1 === d2 ? `${mo} ${d1}` : `${mo} ${d1}-${d2}`;
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
   invoicedYtd: +invoicedYtd.toFixed(2),
   invoicedYtdCount,
   invoicedThisMonth: +invoicedThisMonth.toFixed(2),
   invoicedThisMonthCount,
   invoicedByMonth,
   invoicedByWeekCurrentMonth,
   collectedFromYtd: +collectedFromYtd.toFixed(2),
   collectedFromYtdCount,
   outstandingFromYtd: +outstandingFromYtd.toFixed(2),
   outstandingFromYtdCount,
   topCustomersYtd,
 };
}

// Mark unused-import friendly (helps strict mode without affecting runtime).
void ({} as LtFinancialsInvoice);
