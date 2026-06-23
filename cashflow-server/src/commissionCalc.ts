/**
 * Commission Calculator - applies the rep-payout rules to LT Financials
 * invoices.
 *
 * Rules (per user direction):
 *   - 5% (NEW)        : current invoice's issue date is > 6 months from
 *                       customer's most recent paid invoice's PAID date
 *                       (or there's no prior paid invoice at all - first sale)
 *   - 2% (OLD)        : gap <= 6 months
 *   - 1% (WHITELABEL) : flagged manually in commission sheet's "Busienss Type"
 *                       / "Order type" column. Overrides New/Old.
 *
 * Trigger: commission earned when invoice is PAID (we bucket by paidDate).
 *
 * Base: rate × Invoice Amount. (LT Financials doesn't expose Net Amount, so
 * we use gross Invoice Amount. This is a slight overstatement vs the 22-col
 * calculator's Net basis, but consistent and simple. Once a Net column lands
 * we can switch.)
 *
 * Skip cases:
 *   - Gelato customers (own pipeline)
 *   - "Little Tree" rep tag (house sale - no rep commission per user direction)
 *   - Unmapped invoices we can't predict (no historical signal)
 *   - Unpaid invoices (commission triggers on paidDate)
 */

import { getLtFinancialsSales } from './ltFinancialsSales.js';
import { getCommissionSheet } from './commissionSheet.js';
import { getCommissionOverrides, type InvoiceOverride } from './commissionOverrides.js';
import { getPerRepCommissionWorkbooks, customerKeyForWhitelabel, getCommissionSummary } from './perRepCommissionWorkbooks.js';

const GELATO_RX = /(?:little tree[- ]+)?gelato/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SIX_MONTHS_MS = 180 * MS_PER_DAY;
const YEAR_FLOOR = 2025;          // 2025+ only (matches Sales by Reps scope)

// Manual monthly-commission corrections (`rep|YYYY-MM` → value) applied on top of
// the Summary matrix. Empty now - the Summary tab is the single source of truth
// (the team edits cells there directly, e.g. Manny Jul'25 = 2,076).
const COMMISSION_CORRECTIONS: Record<string, number> = {};

export type CommissionType = 'NEW' | 'OLD' | 'WHITELABEL';

export type CommissionInvoice = {
 invoiceNumber: string;
 customer: string;
 rep: string;
 /** Where the rep came from. 'override' = user set via UI, 'workbook' = team
  *  per-rep workbook, 'sheet' = monthly commission sheet, 'predicted' = best
  *  guess from customer history, 'unmapped' = no rep available, NEEDS REVIEW. */
 repSource: 'override' | 'workbook' | 'sheet' | 'predicted' | 'unmapped';
 isPredicted: boolean;
 /** Any field needs user attention (unmapped rep / fallback Net / marginal gap). */
 needsReview: boolean;
 reviewReasons: string[];
 invoiceDate: string;
 paidDate: string;
 paidMonth: string;
 invoiceAmount: number;
 // Net basis used for commission. Deductions come from the per-rep workbook
 // when available, else the monthly commission sheet, else 0 (fallback).
 shipping: number;
 tax: number;
 credit: number;
 pureXFee: number;
 netAmount: number;
 /** 'workbook' = per-rep workbook (authoritative, team-maintained), 'sheet' =
  *  monthly tracker, 'fallback' = no deduction data anywhere → using invoice $. */
 netSource: 'workbook' | 'sheet' | 'fallback';
 commissionType: CommissionType;
 /** override > workbook flag > monthly-sheet WL flag > auto-detected gap rule. */
 typeSource: 'override' | 'workbook' | 'auto';
 /** Business type as the team labelled it ("Old Business" / "New business"). */
 businessTypeLabel: string;
 rate: number;
 commission: number;             // either sheet's manual calc or computed (netAmount × rate)
 /** Where the commission $ came from. 'workbook' = the team's pre-calculated
  *  value (preferred), 'computed' = our engine (net × rate). */
 commissionSource: 'workbook' | 'computed';
 daysSinceLastPaid: number | null;
};

export type CommissionRepStats = {
 rep: string;
 invoiceCount: number;
 confirmedInvoiceCount: number;
 predictedInvoiceCount: number;
 totalCommission: number;
 commissionByType: { NEW: number; OLD: number; WHITELABEL: number };
 invoiceCountByType: { NEW: number; OLD: number; WHITELABEL: number };
 /** DISTINCT accounts (not invoices) the rep brought as new vs old business.
  *  An account is counted once: "new" if it ever had a new-business sale,
  *  otherwise "old". Fixes the old bug that counted a recurring customer once
  *  per month it appeared. */
 newBusinessAccounts: number;
 oldBusinessAccounts: number;
 monthly: Array<{ ym: string; label: string; commission: number; invoiceCount: number; newAccounts: number; oldAccounts: number }>;
 yearly: Array<{
   year: string;
   commission: number;
   invoiceCount: number;
   isPartial: boolean;
   yoyPct: number | null;
   yoyDelta: number | null;
 }>;
 yoyTrend: {
   currYearLabel: string;
   prevYearLabel: string;
   monthsCompared: number;
   currYTD: number;
   prevYTD: number;
   rate: number;
 } | null;
 topCustomers: Array<{ customer: string; commission: number; invoiceCount: number }>;
 shareOfTotalPct: number;
};

export type CommissionResult = {
 fetchedAt: string;
 rules: {
   newRate: number;
   oldRate: number;
   whitelabelRate: number;
   newOldThresholdDays: number;
 };
 months: Array<{ ym: string; label: string }>;
 reps: CommissionRepStats[];           // sorted by total commission desc
 totals: {
   grandTotalCommission: number;
   grandTotalInvoiceCount: number;
   commissionThisMonth: number;
   commissionLastMonth: number;
   commissionYtd: number;
   confirmedInvoiceCount: number;
   predictedInvoiceCount: number;
   skippedInvoiceCount: number;
   /** How many of the rows had real Shipping/Tax/Credit data from the sheet
    *  vs. falling back to invoice amount (overstates commission slightly). */
   invoicesWithSheetDeductions: number;
   invoicesWithFallbackDeductions: number;
   totalShipping: number;
   totalTax: number;
   totalCredit: number;
   totalPureXFee: number;
   overrideInvoiceCount: number;
   needsReviewCount: number;
   unmappedRepCount: number;
   monthly: number[];
   yearly: Array<{ year: string; commission: number; invoiceCount: number; isPartial: boolean }>;
 };
 invoices: CommissionInvoice[];        // top 200 by commission desc (drilldown)
 warnings: string[];
};

function ymdOf(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function ymKey(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(ym: string): string {
 const [y, m] = ym.split('-');
 const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
 return `${names[Number(m) - 1]} ${y.slice(2)}`;
}
function buildMonthsBetween(earliestYm: string, latestYm: string): Array<{ ym: string; label: string }> {
 const out: Array<{ ym: string; label: string }> = [];
 let [y, m] = earliestYm.split('-').map(Number);
 const [ey, em] = latestYm.split('-').map(Number);
 while (y < ey || (y === ey && m <= em)) {
   const ym = `${y}-${String(m).padStart(2, '0')}`;
   out.push({ ym, label: monthLabel(ym) });
   m += 1;
   if (m > 12) { m = 1; y += 1; }
 }
 return out;
}

export async function getCommissionCalc(): Promise<CommissionResult> {
 const warnings: string[] = [];
 // SOLE SOURCE: the consolidated commission workbook.
 //  · Summary tab "B. Monthly Commission by Rep" → the authoritative per-rep
 //    monthly commission matrix (folds in carryover, bonuses, adjustments).
 //  · Calculation tab → per-invoice detail for the drill-down + new/old counts.
 const [perRep, summary] = await Promise.all([
   getPerRepCommissionWorkbooks(),
   getCommissionSummary(),
 ]);

 // The sheet's own "Paid Month" column is what the team's rep-wise monthly
 // table is keyed on (e.g. "January", "May 2026"). Map it to a YYYY-MM, taking
 // the year from the label when present, else from the Paid Date.
 const MON3: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
 function paidYmOf(label: string, paidDate: string): string {
   const t = (label || '').trim().toLowerCase();
   const mm = MON3[t.slice(0, 3)];
   if (!mm) return '';   // blank/unparseable Paid Month → not in any month column
   let y = (t.match(/20\d\d/) || [])[0] || '';
   if (!y && paidDate) { const m = paidDate.match(/^(\d{4})-/); if (m) y = m[1]; }
   return y ? `${y}-${mm}` : '';
 }

 // === Step 3 - walk the sheet's paid rows, read commission ===
 const today = new Date();
 const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
 const currentYear = todayUtc.getUTCFullYear();
 const currentMonth0 = todayUtc.getUTCMonth();
 const currentYm = ymKey(todayUtc);
 const lastMonthYm = ymKey(new Date(Date.UTC(currentYear, currentMonth0 - 1, 1)));

 const RATE_NEW = 0.05;
 const RATE_OLD = 0.02;
 const RATE_WL  = 0.01;

 type Row = CommissionInvoice;
 const rows: Row[] = [];
 let skippedInvoiceCount = 0;

 for (const row of Object.values(perRep.byInvoice)) {
   if (row.isOpen) { skippedInvoiceCount++; continue; }            // unpaid tab → no commission yet
   if (GELATO_RX.test(row.account)) { skippedInvoiceCount++; continue; }
   const paidMonth = paidYmOf(row.paidMonthLabel, row.paidDate);
   if (!paidMonth) { skippedInvoiceCount++; continue; }            // not paid / no month → skip
   if (Number(paidMonth.slice(0, 4)) < YEAR_FLOOR) { skippedInvoiceCount++; continue; }

   // --- Rep: the sheet's Owner. No owner → skip (no Unattributed bucket). ---
   const rep = row.ownerCanonical || '';
   if (!rep) { skippedInvoiceCount++; continue; }
   const repSource: CommissionInvoice['repSource'] = 'workbook';

   // --- Commission type: straight from the sheet's Order / Business Type. ---
   let commissionType: CommissionType;
   const typeSource: 'override' | 'workbook' | 'auto' = 'workbook';
   if (/white\s*label/i.test(row.orderType)) commissionType = 'WHITELABEL';
   else if (/^new\s*business/i.test(row.businessType)) commissionType = 'NEW';
   else if (/^old\s*business/i.test(row.businessType)) commissionType = 'OLD';
   else commissionType = 'OLD';
   const rate = commissionType === 'WHITELABEL' ? RATE_WL : commissionType === 'NEW' ? RATE_NEW : RATE_OLD;

   const shipping = row.shipping || 0;
   const tax = row.tax || 0;
   const pureXFee = row.pureXFee || 0;
   const netAmount = row.netAmount || +Math.max(0, row.invoiceAmount - shipping - tax - pureXFee).toFixed(2);

   // --- Commission $: ALWAYS the sheet's own "Commission Amount" column. ---
   const commissionAmt = +(row.sheetCommission || 0).toFixed(2);
   const commissionSource: 'workbook' | 'computed' = 'workbook';

   rows.push({
     invoiceNumber: row.invoiceNumber || '',
     customer: row.account,
     rep,
     repSource,
     isPredicted: false,
     needsReview: false,
     reviewReasons: [],
     invoiceDate: row.invoiceDate || '',
     paidDate: row.paidDate || '',
     paidMonth,
     invoiceAmount: +row.invoiceAmount.toFixed(2),
     shipping: +shipping.toFixed(2),
     tax: +tax.toFixed(2),
     credit: 0,
     pureXFee: +pureXFee.toFixed(2),
     netAmount: +netAmount.toFixed(2),
     netSource: 'workbook',
     commissionType,
     typeSource,
     businessTypeLabel: row.businessType || (commissionType === 'NEW' ? 'New business' : commissionType === 'OLD' ? 'Old Business' : ''),
     rate,
     commission: commissionAmt,
     commissionSource,
     daysSinceLastPaid: null,
   });
 }

 // === Step 4 - aggregate per rep ===
 // Month columns come from the Summary tab's matrix (authoritative). Fall back to
 // the Calculation rows' span only if the Summary couldn't be read.
 const allMonths = summary.months.length
   ? summary.months
   : buildMonthsBetween(
       rows.reduce((m, r) => (r.paidMonth && r.paidMonth < m ? r.paidMonth : m), '9999-12'),
       rows.reduce((m, r) => (r.paidMonth > m ? r.paidMonth : m), '0000-01'),
     );
 // Per user direction: drop 2024 entirely (2024 Carryover + Dec'24) - 2025+ only.
 const months = allMonths.filter((m) => /^(20\d\d)-/.test(m.ym) && Number(m.ym.slice(0, 4)) >= 2025);
 if (months.length === 0) {
   return {
     fetchedAt: new Date().toISOString(),
     rules: { newRate: RATE_NEW, oldRate: RATE_OLD, whitelabelRate: RATE_WL, newOldThresholdDays: 180 },
     months: [],
     reps: [],
     totals: { grandTotalCommission: 0, grandTotalInvoiceCount: 0, commissionThisMonth: 0, commissionLastMonth: 0, commissionYtd: 0, confirmedInvoiceCount: 0, predictedInvoiceCount: 0, skippedInvoiceCount, invoicesWithSheetDeductions: 0, invoicesWithFallbackDeductions: 0, totalShipping: 0, totalTax: 0, totalCredit: 0, totalPureXFee: 0, overrideInvoiceCount: 0, needsReviewCount: 0, unmappedRepCount: 0, monthly: [], yearly: [] },
     invoices: [],
     warnings: [...warnings, 'no commission data found'],
   };
 }
 const monthIdx = new Map(months.map((m, i) => [m.ym, i]));

 type RepAccum = {
   rep: string;
   invoiceCount: number;
   confirmedInvoiceCount: number;
   predictedInvoiceCount: number;
   totalCommission: number;
   commissionByType: { NEW: number; OLD: number; WHITELABEL: number };
   invoiceCountByType: { NEW: number; OLD: number; WHITELABEL: number };
   monthly: number[];
   monthlyInv: number[];
   monthlyNewAccts: Set<string>[];
   monthlyOldAccts: Set<string>[];
   customers: Map<string, { commission: number; invoiceCount: number }>;
 };
 const repAccum = new Map<string, RepAccum>();
 function ensure(rep: string): RepAccum {
   let a = repAccum.get(rep);
   if (!a) {
     a = {
       rep,
       invoiceCount: 0,
       confirmedInvoiceCount: 0,
       predictedInvoiceCount: 0,
       totalCommission: 0,
       commissionByType: { NEW: 0, OLD: 0, WHITELABEL: 0 },
       invoiceCountByType: { NEW: 0, OLD: 0, WHITELABEL: 0 },
       monthly: new Array(months.length).fill(0),
       monthlyInv: new Array(months.length).fill(0),
       monthlyNewAccts: Array.from({ length: months.length }, () => new Set<string>()),
       monthlyOldAccts: Array.from({ length: months.length }, () => new Set<string>()),
       customers: new Map(),
     };
     repAccum.set(rep, a);
   }
   return a;
 }

 const grandMonthly = new Array(months.length).fill(0);
 let confInv = 0, predInv = 0;
 // Per-invoice pass (Calculation tab): drives invoice counts, new/old accounts,
 // per-customer commission and the drill-down. Monthly $ is overwritten from the
 // Summary matrix below.
 for (const r of rows) {
   const a = ensure(r.rep);
   a.invoiceCount += 1;
   if (r.isPredicted) { a.predictedInvoiceCount += 1; predInv += 1; }
   else { a.confirmedInvoiceCount += 1; confInv += 1; }
   a.commissionByType[r.commissionType] += r.commission;
   a.invoiceCountByType[r.commissionType] += 1;
   const idx = monthIdx.get(r.paidMonth);
   if (idx !== undefined) {
     a.monthlyInv[idx] += 1;
     // Track DISTINCT accounts per month by business type (recurring customers
     // count once per month, not once per invoice).
     if (r.commissionType === 'NEW') a.monthlyNewAccts[idx].add(r.customer);
     else if (r.commissionType === 'OLD') a.monthlyOldAccts[idx].add(r.customer);
   }
   const c = a.customers.get(r.customer) ?? { commission: 0, invoiceCount: 0 };
   c.commission += r.commission;
   c.invoiceCount += 1;
   a.customers.set(r.customer, c);
 }

 // Overlay the AUTHORITATIVE monthly commission from the Summary matrix. This is
 // what the team's "Monthly Commission by Rep" grid shows (with carryover,
 // bonuses and adjustments), so the dashboard matches it cell-for-cell.
 for (const rep of summary.reps) {
   const a = ensure(rep);
   let t = 0;
   for (let i = 0; i < months.length; i++) {
     const v = COMMISSION_CORRECTIONS[`${rep}|${months[i].ym}`] ?? (summary.byRep[rep]?.[months[i].ym] ?? 0);
     a.monthly[i] = +v.toFixed(2);
     grandMonthly[i] += v;
     t += v;
   }
   a.totalCommission = +t.toFixed(2);   // 2025+ only (2024 excluded)
 }

 const grandTotalCommission = grandMonthly.reduce((s, v) => s + v, 0);

 // === Step 5 - yearly + YoY per rep ===
 const yearOfYm = (ym: string) => (/^(\d{4})-/.test(ym) ? ym.slice(0, 4) : '2024');
 const yearsInWindow = [...new Set(months.map((m) => yearOfYm(m.ym)))].sort();
 function yearlyForRep(a: RepAccum) {
   const byYear = new Map<string, { commission: number; invoiceCount: number; monthsSeen: Set<string> }>();
   for (let i = 0; i < months.length; i++) {
     const y = yearOfYm(months[i].ym);
     const slot = byYear.get(y) ?? { commission: 0, invoiceCount: 0, monthsSeen: new Set() };
     slot.commission += a.monthly[i];
     slot.invoiceCount += a.monthlyInv[i];
     if (a.monthly[i] > 0) slot.monthsSeen.add(months[i].ym);
     byYear.set(y, slot);
   }
   const out: Array<{ year: string; commission: number; invoiceCount: number; isPartial: boolean; yoyPct: number | null; yoyDelta: number | null }> = [];
   for (const y of yearsInWindow) {
     const slot = byYear.get(y);
     if (!slot) continue;
     out.push({
       year: y,
       commission: +slot.commission.toFixed(2),
       invoiceCount: slot.invoiceCount,
       isPartial: Number(y) === currentYear,
       yoyPct: null,
       yoyDelta: null,
     });
   }
   for (let i = 1; i < out.length; i++) {
     const prev = out[i - 1], curr = out[i];
     if (curr.isPartial) {
       // Same-months-of-prior-year basis
       let prevYTD = 0;
       for (let m = 0; m < months.length; m++) {
         const [yy, mm] = months[m].ym.split('-');
         if (yy !== prev.year) continue;
         if (Number(mm) > currentMonth0 + 1) continue;
         prevYTD += a.monthly[m];
       }
       if (prevYTD > 0) {
         curr.yoyDelta = +(curr.commission - prevYTD).toFixed(2);
         curr.yoyPct = +(((curr.commission - prevYTD) / prevYTD) * 100).toFixed(1);
       }
     } else if (prev.commission > 0) {
       curr.yoyDelta = +(curr.commission - prev.commission).toFixed(2);
       curr.yoyPct = +(((curr.commission - prev.commission) / prev.commission) * 100).toFixed(1);
     }
   }
   return out;
 }

 // YoY KPI (closed months only) per rep
 function yoyTrendForRep(a: RepAccum) {
   const cutoffMonth = currentMonth0;
   if (cutoffMonth === 0) return null;
   const currYearStr = String(currentYear);
   const prevYearStr = String(currentYear - 1);
   let currYTD = 0, prevYTD = 0, monthsCompared = 0;
   for (let m = 0; m < cutoffMonth; m++) {
     const currKey = `${currYearStr}-${String(m + 1).padStart(2, '0')}`;
     const prevKey = `${prevYearStr}-${String(m + 1).padStart(2, '0')}`;
     const ic = monthIdx.get(currKey);
     const ip = monthIdx.get(prevKey);
     if (ic === undefined || ip === undefined) continue;
     if (a.monthly[ic] > 0 && a.monthly[ip] > 0) { currYTD += a.monthly[ic]; prevYTD += a.monthly[ip]; monthsCompared++; }
     else if (a.monthly[ip] > 0) prevYTD += a.monthly[ip];
   }
   if (prevYTD <= 0) return null;
   return {
     currYearLabel: currYearStr,
     prevYearLabel: prevYearStr,
     monthsCompared: monthsCompared || cutoffMonth,
     currYTD: +currYTD.toFixed(2),
     prevYTD: +prevYTD.toFixed(2),
     rate: +(((currYTD - prevYTD) / prevYTD)).toFixed(3),
   };
 }

 const reps: CommissionRepStats[] = [...repAccum.values()]
   .map((a) => ({
     rep: a.rep,
     invoiceCount: a.invoiceCount,
     confirmedInvoiceCount: a.confirmedInvoiceCount,
     predictedInvoiceCount: a.predictedInvoiceCount,
     totalCommission: +a.totalCommission.toFixed(2),
     commissionByType: {
       NEW:        +a.commissionByType.NEW.toFixed(2),
       OLD:        +a.commissionByType.OLD.toFixed(2),
       WHITELABEL: +a.commissionByType.WHITELABEL.toFixed(2),
     },
     invoiceCountByType: a.invoiceCountByType,
     ...(() => {
       // Distinct accounts across the window: "new" if ever a new-business sale,
       // otherwise "old" (so each customer is counted once, not per month).
       const newSet = new Set<string>();
       const oldSet = new Set<string>();
       a.monthlyNewAccts.forEach((s) => s.forEach((x) => newSet.add(x)));
       a.monthlyOldAccts.forEach((s) => s.forEach((x) => oldSet.add(x)));
       const oldOnly = [...oldSet].filter((x) => !newSet.has(x));
       return { newBusinessAccounts: newSet.size, oldBusinessAccounts: oldOnly.length };
     })(),
     monthly: months.map((m, i) => ({
       ym: m.ym,
       label: m.label,
       commission: +a.monthly[i].toFixed(2),
       invoiceCount: a.monthlyInv[i],
       newAccounts: a.monthlyNewAccts[i].size,
       oldAccounts: a.monthlyOldAccts[i].size,
     })),
     yearly: yearlyForRep(a),
     yoyTrend: yoyTrendForRep(a),
     topCustomers: [...a.customers.entries()]
       .map(([customer, v]) => ({ customer, commission: +v.commission.toFixed(2), invoiceCount: v.invoiceCount }))
       .sort((x, y) => y.commission - x.commission)
       .slice(0, 10),
     shareOfTotalPct: grandTotalCommission > 0 ? +((a.totalCommission / grandTotalCommission) * 100).toFixed(1) : 0,
   }))
   .sort((a, b) => b.totalCommission - a.totalCommission);

 // Aggregate yearly (commission from the Summary grand-monthly; invoice counts
 // from the Calculation rows). Carryover months count toward 2024.
 const yearOf = (ym: string) => (/^(\d{4})-/.test(ym) ? ym.slice(0, 4) : '2024');
 const aggYearly: Array<{ year: string; commission: number; invoiceCount: number; isPartial: boolean }> = [];
 {
   const byYear = new Map<string, { commission: number; invoiceCount: number }>();
   for (let i = 0; i < months.length; i++) {
     const y = yearOf(months[i].ym);
     const slot = byYear.get(y) ?? { commission: 0, invoiceCount: 0 };
     slot.commission += grandMonthly[i];
     byYear.set(y, slot);
   }
   for (const r of rows) {
     const y = yearOf(r.paidMonth);
     const slot = byYear.get(y) ?? { commission: 0, invoiceCount: 0 };
     slot.invoiceCount += 1;
     byYear.set(y, slot);
   }
   for (const y of yearsInWindow) {
     const slot = byYear.get(y);
     if (!slot) continue;
     aggYearly.push({
       year: y,
       commission: +slot.commission.toFixed(2),
       invoiceCount: slot.invoiceCount,
       isPartial: Number(y) === currentYear,
     });
   }
 }

 const tmIdx = monthIdx.get(currentYm);
 const lmIdx = monthIdx.get(lastMonthYm);
 const commissionThisMonth = tmIdx !== undefined ? grandMonthly[tmIdx] : 0;
 const commissionLastMonth = lmIdx !== undefined ? grandMonthly[lmIdx] : 0;
 const commissionYtd = months.reduce((s, m, i) => (m.ym.startsWith(String(currentYear)) ? s + grandMonthly[i] : s), 0);

 // Return ALL invoices (sorted by paidDate desc) so the per-rep drill-down
 // in the UI can show the full 22-col table for whichever rep the user picks.
 // 811 rows is small enough to ship full to the client without paging.
 const topInvoices = [...rows].sort((a, b) => b.paidDate.localeCompare(a.paidDate));

 return {
   fetchedAt: new Date().toISOString(),
   rules: { newRate: RATE_NEW, oldRate: RATE_OLD, whitelabelRate: RATE_WL, newOldThresholdDays: 180 },
   months,
   reps,
   totals: {
     grandTotalCommission: +grandTotalCommission.toFixed(2),
     grandTotalInvoiceCount: rows.length,
     commissionThisMonth: +commissionThisMonth.toFixed(2),
     commissionLastMonth: +commissionLastMonth.toFixed(2),
     commissionYtd: +commissionYtd.toFixed(2),
     confirmedInvoiceCount: confInv,
     predictedInvoiceCount: predInv,
     skippedInvoiceCount,
     invoicesWithSheetDeductions: rows.filter((r) => r.netSource === 'sheet').length,
     invoicesWithFallbackDeductions: rows.filter((r) => r.netSource === 'fallback').length,
     totalShipping: +rows.reduce((s, r) => s + r.shipping, 0).toFixed(2),
     totalTax:      +rows.reduce((s, r) => s + r.tax,      0).toFixed(2),
     totalCredit:   +rows.reduce((s, r) => s + r.credit,   0).toFixed(2),
     totalPureXFee: +rows.reduce((s, r) => s + r.pureXFee, 0).toFixed(2),
     overrideInvoiceCount: rows.filter((r) => r.typeSource === 'override' || r.repSource === 'override').length,
     needsReviewCount: rows.filter((r) => r.needsReview).length,
     unmappedRepCount: rows.filter((r) => r.repSource === 'unmapped').length,
     monthly: grandMonthly.map((v) => +v.toFixed(2)),
     yearly: aggYearly,
   },
   invoices: topInvoices,
   warnings,
 };
}
