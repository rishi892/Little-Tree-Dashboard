/**
 * Sales by Sales Reps - joins LT Financials invoices (sales-of-truth) with
 * the commission sheet's invoice -> rep mapping.
 *
 * Approach (per user direction):
 *   1. Sales $ comes from LT Financials (same source as Sales by Channel /
 *      Sales Status / etc.) - we don't recompute revenue.
 *   2. Sales rep for each invoice is looked up in the commission workbook
 *      via commissionSheet.ts.
 *   3. Output mirrors Sales-by-Channel shape: per-rep row with monthly[]
 *      and total + top customers, plus per-month subtotals across all reps.
 *
 * Gelato excluded (own pipeline).  Invoices not found in the commission
 * sheet land in a "Unmapped" row so we can show the coverage gap.
 */

import { getLtFinancialsSales, type LtFinancialsInvoice } from './ltFinancialsSales.js';
import { getCommissionSheet } from './commissionSheet.js';

// Excluded customers: Gelato (own pipeline) + brand-side / co-pack partners
// (Alien Brainz, Funk'd Up, Yacht Fuel). Same scope as Sales Status / Sales
// Forecast's Little Tree bucket - keeps the 3 "Sales" views consistent.
const EXCLUDED_CUSTOMER_RX = /(?:little tree[- ]+)?(gelato|alien\s+(?:brainz|brains|arainz)\b|funk'?d?\s*up\b|(?:yacht|tacht)\s+fuel)/i;
const YEAR_FLOOR = 2025;     // per user direction: 2025 + 2026 only

export type SalesByRepsMonth = { key: string; label: string };

export type SalesByRepsYearly = {
 year: string;
 confirmed: number;
 predicted: number;
 total: number;                     // confirmed + predicted
 invoiceCount: number;              // confirmed + predicted
 isPartial: boolean;                // true for the current year (YTD)
 yoyDelta: number | null;           // $ change vs prior year
 yoyPct: number | null;             // % change vs prior year (null if no prior year)
 monthsInYearReported: number;      // 1..12 (12 = full year, <12 for current YTD)
};

/** Apples-to-apples YoY trend for a rep - excludes the current incomplete
 *  month so the comparison is honest. Matches Sales Forecast page's
 *  YoY KPI card shape. */
export type SalesByRepsYoyTrend = {
 currYearLabel: string;
 prevYearLabel: string;
 monthsCompared: number;     // count of CLOSED months in current year (excludes running month)
 currYTD: number;            // current-year sum across closed months only
 prevYTD: number;            // prior-year sum across same months
 rate: number;               // clamped to [-1, 1] for stable UI tone
 rawRate: number;            // unclamped raw % for transparency
};

/** Year × 12-month pivot. Months are calendar Jan(0) .. Dec(11). */
export type SalesByRepsMonthlyMatrixRow = {
 year: string;
 monthly: number[];          // length 12 (Jan..Dec, 0 for months outside window)
 total: number;
 isPartial: boolean;
};

export type SalesByRepsRow = {
 rep: string;                       // canonical name (Manny, Dave, etc., or "Unmapped")
 monthly: number[];                 // length = months.length (CONFIRMED only - from commission sheet)
 total: number;                     // confirmed $ (sheet-attributed)
 invoiceCount: number;              // confirmed invoice count
 avgPerMonth: number;
 monthsActive: number;
 lastInvoiceMonth: string | null;
 topCustomers: Array<{ customer: string; total: number; invoiceCount: number }>;
 rawVariants: string[];
 /** Predicted (from past behaviour): unmapped invoices whose CUSTOMER has a
  *  dominant historical rep get attributed there too, but separately so the
  *  UI can show "confirmed vs predicted" honestly. */
 predictedMonthly: number[];
 predictedTotal: number;
 predictedInvoiceCount: number;
 /** Customers whose mappings drove the prediction (with how confident we were). */
 predictedFromCustomers: Array<{ customer: string; total: number; invoiceCount: number; confidence: number }>;
 /** Yearly aggregates with YoY % growth - same shape as Sales by Channel's
  *  yearly history but per-rep. Uses confirmed + predicted combined. */
 yearly: SalesByRepsYearly[];
 /** Rep's share of the grand total (combined confirmed + predicted), as a 0..100 %. */
 shareOfTotalPct: number;
 /** Rep's grand total = confirmed + predicted. Cached so UI doesn't have to recompute. */
 grandTotal: number;
 /** Per-month combined (confirmed + predicted) - convenience for charts. */
 combinedMonthly: number[];
 /** YoY KPI card data (current YTD excluding running month vs prior year same months). */
 yoyTrend: SalesByRepsYoyTrend | null;
 /** Year × 12-month pivot for this rep. */
 monthlyMatrix: SalesByRepsMonthlyMatrixRow[];
};

export type SalesByRepsResult = {
 fetchedAt: string;
 sourceLtFinancialsUrl: string;
 sourceCommissionSheetUrl: string;
 months: SalesByRepsMonth[];
 rows: SalesByRepsRow[];            // sorted by total desc, "Unmapped" last
 totals: {
   monthly: number[];
   grandTotal: number;
   invoiceCount: number;
   unmappedInvoiceCount: number;     // truly unmapped (no rep + no historical match)
   unmappedAmount: number;
   predictedInvoiceCount: number;    // unmapped that we predicted from customer history
   predictedAmount: number;
   coveragePct: number;              // % with confirmed rep
   coveragePctIncludingPredicted: number;
   /** Aggregate yearly totals across ALL reps (incl. unmapped). */
   yearly: SalesByRepsYearly[];
   /** Aggregate YoY KPI - same shape as the Sales Forecast page's card. */
   yoyTrend: SalesByRepsYoyTrend | null;
   /** Aggregate year × 12-month pivot. */
   monthlyMatrix: SalesByRepsMonthlyMatrixRow[];
 };
 /** Customer -> dominant rep mapping derived from confirmed data, exposed for
  *  transparency so the user can see why a prediction was made. */
 customerRepLearned: Array<{
   customer: string;
   dominantRep: string;
   confidence: number;          // 0..1, share of customer's confirmed invoices going to this rep
   confirmedInvoiceCount: number;
 }>;
 warnings: string[];
};

function ymKey(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(ym: string): string {
 const [y, m] = ym.split('-');
 const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
 return `${names[Number(m) - 1]} ${y.slice(2)}`;
}

function buildMonthsBetween(earliestYm: string, latestYm: string): SalesByRepsMonth[] {
 const out: SalesByRepsMonth[] = [];
 let [y, m] = earliestYm.split('-').map(Number);
 const [ey, em] = latestYm.split('-').map(Number);
 while (y < ey || (y === ey && m <= em)) {
   const ym = `${y}-${String(m).padStart(2, '0')}`;
   out.push({ key: ym, label: monthLabel(ym) });
   m += 1;
   if (m > 12) { m = 1; y += 1; }
 }
 return out;
}

export async function getSalesByReps(): Promise<SalesByRepsResult> {
 const warnings: string[] = [];
 const [ltFin, commission] = await Promise.all([
   getLtFinancialsSales(),
   getCommissionSheet(),
 ]);
 for (const f of commission.tabsFailed) warnings.push(`Commission tab "${f.tab}" failed: ${f.reason}`);

 // Determine month window from the LT Financials data (skip Gelato + 0-amount).
 let earliestYm = '9999-12', latestYm = '0000-01';
 for (const inv of ltFin.invoices) {
   if (inv.amount <= 0) continue;
   if (EXCLUDED_CUSTOMER_RX.test(inv.customer)) continue;
   if (inv.invoiceDate.getUTCFullYear() < YEAR_FLOOR) continue;
   const ym = ymKey(inv.invoiceDate);
   if (ym < earliestYm) earliestYm = ym;
   if (ym > latestYm) latestYm = ym;
 }
 if (earliestYm > latestYm) {
    return {
      fetchedAt: new Date().toISOString(),
      sourceLtFinancialsUrl: ltFin.sheetUrl,
      sourceCommissionSheetUrl: commission.sheetUrl,
      months: [],
      rows: [],
      totals: {
        monthly: [],
        grandTotal: 0,
        invoiceCount: 0,
        unmappedInvoiceCount: 0,
        unmappedAmount: 0,
        predictedInvoiceCount: 0,
        predictedAmount: 0,
        coveragePct: 0,
        coveragePctIncludingPredicted: 0,
        yearly: [],
        yoyTrend: null,
        monthlyMatrix: [],
      },
      customerRepLearned: [],
      warnings: [...warnings, 'no non-Gelato invoices found in LT Financials'],
    };
 }
 const months = buildMonthsBetween(earliestYm, latestYm);
 const monthIdx = new Map(months.map((m, i) => [m.key, i]));

 type RepAccum = {
   rep: string;
   monthly: number[];
   total: number;
   invoiceCount: number;
   monthsActive: Set<string>;
   lastInvoiceMonth: string;
   customers: Map<string, { total: number; invoiceCount: number }>;
   rawVariants: Set<string>;
   predictedMonthly: number[];
   predictedTotal: number;
   predictedInvoiceCount: number;
   predictedCustomers: Map<string, { total: number; invoiceCount: number; confidence: number }>;
 };
 const accum = new Map<string, RepAccum>();
 function ensure(rep: string): RepAccum {
   let a = accum.get(rep);
   if (!a) {
     a = {
       rep,
       monthly: new Array(months.length).fill(0),
       total: 0,
       invoiceCount: 0,
       monthsActive: new Set<string>(),
       lastInvoiceMonth: '',
       customers: new Map(),
       rawVariants: new Set(),
       predictedMonthly: new Array(months.length).fill(0),
       predictedTotal: 0,
       predictedInvoiceCount: 0,
       predictedCustomers: new Map(),
     };
     accum.set(rep, a);
   }
   return a;
 }

 // ============================================================
 // PASS 1 - confirmed attributions (rep is in commission sheet)
 // ============================================================
 // Build a per-customer rep tally as we go so we can predict the unmapped
 // invoices in pass 2.
 type CustomerRepTally = Map<string, number>;       // rep -> confirmed invoice count
 const customerRepStats = new Map<string, CustomerRepTally>();
 const unmappedInvoices: LtFinancialsInvoice[] = [];

 let mappedAmount = 0;

 for (const inv of ltFin.invoices) {
   if (inv.amount <= 0) continue;
   if (EXCLUDED_CUSTOMER_RX.test(inv.customer)) continue;
   if (inv.invoiceDate.getUTCFullYear() < YEAR_FLOOR) continue;
   const ym = ymKey(inv.invoiceDate);
   const idx = monthIdx.get(ym);
   if (idx === undefined) continue;

   const key = (inv.invoiceNumber || '').trim().toLowerCase();
   const attr = key ? commission.invoiceToRep[key] : undefined;
   if (!attr) {
     unmappedInvoices.push(inv);
     continue;
   }

   const a = ensure(attr.rep);
   a.monthly[idx] += inv.amount;
   a.total += inv.amount;
   a.invoiceCount += 1;
   a.monthsActive.add(ym);
   if (ym > a.lastInvoiceMonth) a.lastInvoiceMonth = ym;
   const c = a.customers.get(inv.customer) ?? { total: 0, invoiceCount: 0 };
   c.total += inv.amount;
   c.invoiceCount += 1;
   a.customers.set(inv.customer, c);
   if (attr.rawRep) a.rawVariants.add(attr.rawRep);
   mappedAmount += inv.amount;

   // Tally customer -> rep for prediction in pass 2.
   const tally = customerRepStats.get(inv.customer) ?? (new Map() as CustomerRepTally);
   tally.set(attr.rep, (tally.get(attr.rep) ?? 0) + 1);
   customerRepStats.set(inv.customer, tally);
 }

 // ============================================================
 // Derive dominant rep per customer from confirmed tally
 // ============================================================
 // For each customer we record the rep that handled most of their invoices
 // and the confidence (share of that rep's invoices over total). Confidence
 // is informational - we attribute regardless, since the alternative is
 // leaving it Unmapped which is worse signal.
 type LearnedRow = { customer: string; dominantRep: string; confidence: number; confirmedInvoiceCount: number };
 const customerRepLearned: LearnedRow[] = [];
 const customerToDominantRep = new Map<string, string>();
 for (const [customer, tally] of customerRepStats) {
   let bestRep = '', bestCount = 0, totalCount = 0;
   for (const [rep, count] of tally) {
     totalCount += count;
     if (count > bestCount) { bestCount = count; bestRep = rep; }
   }
   if (bestRep && bestRep !== 'Little Tree') {  // skip "house" - don't predict to it
     customerToDominantRep.set(customer, bestRep);
     customerRepLearned.push({
       customer,
       dominantRep: bestRep,
       confidence: totalCount > 0 ? +(bestCount / totalCount).toFixed(2) : 0,
       confirmedInvoiceCount: bestCount,
     });
   }
 }
 customerRepLearned.sort((a, b) => b.confirmedInvoiceCount - a.confirmedInvoiceCount);

 // ============================================================
 // PASS 2 - predict unmapped invoices from learned customer-rep mapping
 // ============================================================
 let unmappedAmount = 0, unmappedInvoiceCount = 0;
 let predictedAmount = 0, predictedInvoiceCount = 0;

 for (const inv of unmappedInvoices) {
   const ym = ymKey(inv.invoiceDate);
   const idx = monthIdx.get(ym);
   if (idx === undefined) continue;
   const predictedRep = customerToDominantRep.get(inv.customer);
   if (predictedRep) {
     const a = ensure(predictedRep);
     a.predictedMonthly[idx] += inv.amount;
     a.predictedTotal += inv.amount;
     a.predictedInvoiceCount += 1;
     const pc = a.predictedCustomers.get(inv.customer) ?? { total: 0, invoiceCount: 0, confidence: 0 };
     pc.total += inv.amount;
     pc.invoiceCount += 1;
     pc.confidence = customerRepLearned.find((c) => c.customer === inv.customer)?.confidence ?? 0;
     a.predictedCustomers.set(inv.customer, pc);
     predictedAmount += inv.amount;
     predictedInvoiceCount += 1;
   } else {
     // No historical signal - keep as "Unmapped".
     const a = ensure('Unmapped');
     a.monthly[idx] += inv.amount;
     a.total += inv.amount;
     a.invoiceCount += 1;
     a.monthsActive.add(ym);
     if (ym > a.lastInvoiceMonth) a.lastInvoiceMonth = ym;
     const c = a.customers.get(inv.customer) ?? { total: 0, invoiceCount: 0 };
     c.total += inv.amount;
     c.invoiceCount += 1;
     a.customers.set(inv.customer, c);
     unmappedAmount += inv.amount;
     unmappedInvoiceCount += 1;
   }
 }

 const rows: SalesByRepsRow[] = [...accum.values()]
   .map((a) => ({
     rep: a.rep,
     monthly: a.monthly.map((v) => +v.toFixed(2)),
     total: +a.total.toFixed(2),
     invoiceCount: a.invoiceCount,
     avgPerMonth: +(a.total / months.length).toFixed(2),
     monthsActive: a.monthsActive.size,
     lastInvoiceMonth: a.lastInvoiceMonth || null,
     topCustomers: [...a.customers.entries()]
       .map(([customer, v]) => ({ customer, total: +v.total.toFixed(2), invoiceCount: v.invoiceCount }))
       .sort((x, y) => y.total - x.total)
       .slice(0, 10),
     rawVariants: [...a.rawVariants].sort(),
     predictedMonthly: a.predictedMonthly.map((v) => +v.toFixed(2)),
     predictedTotal: +a.predictedTotal.toFixed(2),
     predictedInvoiceCount: a.predictedInvoiceCount,
     predictedFromCustomers: [...a.predictedCustomers.entries()]
       .map(([customer, v]) => ({ customer, total: +v.total.toFixed(2), invoiceCount: v.invoiceCount, confidence: v.confidence }))
       .sort((x, y) => y.total - x.total)
       .slice(0, 10),
     // Populated below after grandTotal is known.
     yearly: [],
     shareOfTotalPct: 0,
     grandTotal: 0,
     combinedMonthly: [],
     yoyTrend: null,
     monthlyMatrix: [],
   }))
   .sort((a, b) => {
     if (a.rep === 'Unmapped' && b.rep !== 'Unmapped') return 1;
     if (b.rep === 'Unmapped' && a.rep !== 'Unmapped') return -1;
     return (b.total + b.predictedTotal) - (a.total + a.predictedTotal);
   });

 const monthlyTotals = new Array(months.length).fill(0);
 let invoiceCount = 0;
 for (const r of rows) {
   for (let i = 0; i < months.length; i++) monthlyTotals[i] += r.monthly[i] + r.predictedMonthly[i];
   invoiceCount += r.invoiceCount + r.predictedInvoiceCount;
 }
 const grandTotal = monthlyTotals.reduce((s, v) => s + v, 0);
 const coveragePct = grandTotal > 0 ? +((mappedAmount / grandTotal) * 100).toFixed(1) : 0;
 const coveragePctIncludingPredicted = grandTotal > 0
   ? +(((mappedAmount + predictedAmount) / grandTotal) * 100).toFixed(1) : 0;

 // ============================================================
 // Year-by-year per rep + aggregate, with YoY %  growth
 // ============================================================
 const today = new Date();
 const currentYear = today.getUTCFullYear();
 const currentMonth0 = today.getUTCMonth();
 const yearsInWindow = [...new Set(months.map((m) => m.key.split('-')[0]))].sort();

 function yearlyForRow(row: SalesByRepsRow): SalesByRepsYearly[] {
   const out: SalesByRepsYearly[] = [];
   const byYear = new Map<string, { conf: number; pred: number; invConf: number; invPred: number; monthsSeen: Set<string> }>();
   for (let i = 0; i < months.length; i++) {
     const ym = months[i].key;
     const y = ym.split('-')[0];
     const slot = byYear.get(y) ?? { conf: 0, pred: 0, invConf: 0, invPred: 0, monthsSeen: new Set() };
     slot.conf += row.monthly[i];
     slot.pred += row.predictedMonthly[i];
     if (row.monthly[i] > 0 || row.predictedMonthly[i] > 0) slot.monthsSeen.add(ym);
     byYear.set(y, slot);
   }
   // Approximate per-year invoice count by allocating proportionally (no
   // per-invoice year breakdown exists in this view - it's a small simplification
   // that's good enough for the UI sanity column).
   const totalConfInv = row.invoiceCount, totalPredInv = row.predictedInvoiceCount;
   const totalConfAmt = row.total, totalPredAmt = row.predictedTotal;
   for (const y of yearsInWindow) {
     const slot = byYear.get(y);
     if (!slot) continue;
     const invConf = totalConfAmt > 0 ? Math.round((slot.conf / totalConfAmt) * totalConfInv) : 0;
     const invPred = totalPredAmt > 0 ? Math.round((slot.pred / totalPredAmt) * totalPredInv) : 0;
     const isPartial = Number(y) === currentYear;
     out.push({
       year: y,
       confirmed: +slot.conf.toFixed(2),
       predicted: +slot.pred.toFixed(2),
       total: +(slot.conf + slot.pred).toFixed(2),
       invoiceCount: invConf + invPred,
       isPartial,
       yoyDelta: null,
       yoyPct: null,
       monthsInYearReported: slot.monthsSeen.size,
     });
   }
   // Compute YoY based on the prior year's total. For partial current year
   // we compare against same months prior year so the % is apples-to-apples.
   for (let i = 1; i < out.length; i++) {
     const prev = out[i - 1];
     const curr = out[i];
     if (curr.isPartial) {
       // Same-months-of-prior-year basis: walk months[] for prev.year and
       // sum only those months whose number <= currentMonth0+1.
       const cutoffMonth = currentMonth0 + 1;
       let prevYTD = 0;
       for (let m = 0; m < months.length; m++) {
         const [yy, mm] = months[m].key.split('-');
         if (yy !== prev.year) continue;
         if (Number(mm) > cutoffMonth) continue;
         prevYTD += row.monthly[m] + row.predictedMonthly[m];
       }
       if (prevYTD > 0) {
         curr.yoyDelta = +(curr.total - prevYTD).toFixed(2);
         curr.yoyPct = +(((curr.total - prevYTD) / prevYTD) * 100).toFixed(1);
       }
     } else if (prev.total > 0) {
       curr.yoyDelta = +(curr.total - prev.total).toFixed(2);
       curr.yoyPct = +(((curr.total - prev.total) / prev.total) * 100).toFixed(1);
     }
   }
   return out;
 }

 // Build aggregate yearly across all reps (using monthlyTotals).
 const aggregateYearly: SalesByRepsYearly[] = (() => {
   const out: SalesByRepsYearly[] = [];
   const byYear = new Map<string, { total: number; monthsSeen: Set<string> }>();
   for (let i = 0; i < months.length; i++) {
     const y = months[i].key.split('-')[0];
     const slot = byYear.get(y) ?? { total: 0, monthsSeen: new Set() };
     slot.total += monthlyTotals[i];
     if (monthlyTotals[i] > 0) slot.monthsSeen.add(months[i].key);
     byYear.set(y, slot);
   }
   for (const y of yearsInWindow) {
     const slot = byYear.get(y);
     if (!slot) continue;
     out.push({
       year: y,
       confirmed: 0,                     // breakdown not tracked at aggregate level
       predicted: 0,
       total: +slot.total.toFixed(2),
       invoiceCount: 0,
       isPartial: Number(y) === currentYear,
       yoyDelta: null,
       yoyPct: null,
       monthsInYearReported: slot.monthsSeen.size,
     });
   }
   for (let i = 1; i < out.length; i++) {
     const prev = out[i - 1], curr = out[i];
     if (curr.isPartial) {
       const cutoffMonth = currentMonth0 + 1;
       let prevYTD = 0;
       for (let m = 0; m < months.length; m++) {
         const [yy, mm] = months[m].key.split('-');
         if (yy !== prev.year || Number(mm) > cutoffMonth) continue;
         prevYTD += monthlyTotals[m];
       }
       if (prevYTD > 0) {
         curr.yoyDelta = +(curr.total - prevYTD).toFixed(2);
         curr.yoyPct = +(((curr.total - prevYTD) / prevYTD) * 100).toFixed(1);
       }
     } else if (prev.total > 0) {
       curr.yoyDelta = +(curr.total - prev.total).toFixed(2);
       curr.yoyPct = +(((curr.total - prev.total) / prev.total) * 100).toFixed(1);
     }
   }
   return out;
 })();

 /**
  * Apples-to-apples YoY: take closed months in the current year only (so we
  * exclude the in-progress current month, which would understate the
  * trailing year) and compare against the same months of the prior year.
  * Returns null if there's no prior-year history to compare to.
  *
  * `sumByMonth` is a length-N array indexed by `months[]`, where each entry
  * is the rep's $ for that month (already includes confirmed + predicted).
  */
 function yoyTrendFromSeries(sumByMonth: number[]): SalesByRepsYoyTrend | null {
   const currYearStr = String(currentYear);
   const prevYearStr = String(currentYear - 1);
   const cutoffMonth = currentMonth0;       // 0..11, exclusive (running month not counted)
   if (cutoffMonth === 0) return null;       // it's January 1, no closed months yet
   let currYTD = 0, prevYTD = 0, monthsCompared = 0;
   for (let m = 0; m < cutoffMonth; m++) {
     const currKey = `${currYearStr}-${String(m + 1).padStart(2, '0')}`;
     const prevKey = `${prevYearStr}-${String(m + 1).padStart(2, '0')}`;
     const ic = months.findIndex((mm) => mm.key === currKey);
     const ip = months.findIndex((mm) => mm.key === prevKey);
     if (ic < 0 || ip < 0) continue;
     const cv = sumByMonth[ic];
     const pv = sumByMonth[ip];
     if (cv > 0 && pv > 0) { currYTD += cv; prevYTD += pv; monthsCompared++; }
     else if (pv > 0)      { prevYTD += pv; }
     // Note: we tally prevYTD even when cv === 0 to give an honest "you USED
     // to make $X here and now you make $0" signal. But we only INCREMENT
     // monthsCompared on a paired data point so the count reflects real overlap.
   }
   if (prevYTD <= 0) return null;
   const rawRate = (currYTD - prevYTD) / prevYTD;
   const rate = Math.max(-1, Math.min(1, rawRate));
   return {
     currYearLabel: currYearStr,
     prevYearLabel: prevYearStr,
     monthsCompared: monthsCompared || cutoffMonth,
     currYTD: +currYTD.toFixed(2),
     prevYTD: +prevYTD.toFixed(2),
     rate: +rate.toFixed(3),
     rawRate: +rawRate.toFixed(3),
   };
 }

 /**
  * Year × 12-month pivot. For each year in window we lay out a 12-entry
  * monthly array indexed Jan..Dec (months outside the window are 0).
  */
 function monthlyMatrixFromSeries(sumByMonth: number[]): SalesByRepsMonthlyMatrixRow[] {
   const byYear = new Map<string, number[]>();
   for (let i = 0; i < months.length; i++) {
     const [y, m] = months[i].key.split('-');
     const arr = byYear.get(y) ?? new Array(12).fill(0);
     arr[Number(m) - 1] = sumByMonth[i];
     byYear.set(y, arr);
   }
   return yearsInWindow.map((y) => {
     const arr = byYear.get(y) ?? new Array(12).fill(0);
     return {
       year: y,
       monthly: arr.map((v) => +Number(v).toFixed(2)),
       total: +arr.reduce((s, v) => s + v, 0).toFixed(2),
       isPartial: Number(y) === currentYear,
     };
   });
 }

 // Decorate rows with yearly + share + combined views + YoY + matrix.
 for (const r of rows) {
   r.yearly = yearlyForRow(r);
   r.grandTotal = +(r.total + r.predictedTotal).toFixed(2);
   r.shareOfTotalPct = grandTotal > 0 ? +((r.grandTotal / grandTotal) * 100).toFixed(1) : 0;
   r.combinedMonthly = r.monthly.map((v, i) => +(v + r.predictedMonthly[i]).toFixed(2));
   r.yoyTrend = yoyTrendFromSeries(r.combinedMonthly);
   r.monthlyMatrix = monthlyMatrixFromSeries(r.combinedMonthly);
 }
 const aggregateYoyTrend = yoyTrendFromSeries(monthlyTotals);
 const aggregateMonthlyMatrix = monthlyMatrixFromSeries(monthlyTotals);

 return {
   fetchedAt: new Date().toISOString(),
   sourceLtFinancialsUrl: ltFin.sheetUrl,
   sourceCommissionSheetUrl: commission.sheetUrl,
   months,
   rows,
   totals: {
     monthly: monthlyTotals.map((v) => +v.toFixed(2)),
     grandTotal: +grandTotal.toFixed(2),
     invoiceCount,
     unmappedInvoiceCount,
     unmappedAmount: +unmappedAmount.toFixed(2),
     predictedInvoiceCount,
     predictedAmount: +predictedAmount.toFixed(2),
     coveragePct,
     coveragePctIncludingPredicted,
     yearly: aggregateYearly,
     yoyTrend: aggregateYoyTrend,
     monthlyMatrix: aggregateMonthlyMatrix,
   },
   customerRepLearned,
   warnings,
 };
}

// Re-export type for callers (keeps imports tidy).
export type { LtFinancialsInvoice };
