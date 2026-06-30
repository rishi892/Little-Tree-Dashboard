/**
 * Compute weekly actuals from Tiller transactions, used to pair with stored
 * forecast snapshots for variance ("ki hum kya bole the vs kya hua actual").
 *
 * We mirror the cashflow definition exactly:
 *   - Inflow  = positive amounts on business bank accounts
 *   - Outflow = abs(negatives) on business bank accounts (covers payroll,
 *               vendor cheques, CC payoff transfers, etc.)
 *   - Net     = inflow - outflow
 *
 * Only the two business cash accounts contribute (matches BUSINESS_CASH_RE in
 * cashflow13.ts): CRB Indirect / 7561 and Business MM / 0910. Personal banks
 * are excluded.
 *
 * Output buckets:
 *   - byLine = per-category breakdown so we can also reconcile against the
 *              specific forecast lines (Payroll, Inventory, AR, etc.).
 */

import { getTillerTransactions, type TillerTxn } from './tillerTransactions.js';
import { getInvoiceTracker } from './invoiceTracker.js';
import { getLtFinancialsSales } from './ltFinancialsSales.js';
import { channelOf } from './salesByChannel.js';

const BUSINESS_CASH_RE = /crb indirect|7561|business mm|0910/i;

export type InvoiceDetail = {
 invoiceNumber: string;
 customer: string;
 channel: 'Gelato' | string;
 invoiceDate: string;       // YYYY-MM-DD
 paidDate: string;          // YYYY-MM-DD (empty for unpaid)
 amount: number;
 paid: number;
};

/**
 * One invoice the AR projection said "should pay this week".
 *
 * Built from the same lag-curve model that drives the 13-week cashflow:
 * each open invoice has expected payment portions distributed across the
 * window's weeks (per its channel's historical lag curve). If any portion
 * lands in Wk 1 of the snapshot, the invoice is "expected this week" with
 * `projectedAmountThisWeek` = the model's predicted contribution.
 *
 * Status answers the user's question: "for the ones we expected, who
 * actually paid and who didn't".
 */
export type ForecastInvoiceRow = InvoiceDetail & {
 /** Open balance at the START of the snapshot week. */
 openAtWeekStart: number;
 /** Dollar amount the lag-curve model predicted would land in this week. */
 projectedAmountThisWeek: number;
 status: 'paid' | 'partial' | 'unpaid';
 /** True if the payment landed in [weekStart, weekEnd]. */
 paidThisWeek: boolean;
};

export type WeekActuals = {
 weekStart: string;
 weekEnd: string;
 inflow: number;
 outflow: number;
 netChange: number;
 byCategory: Array<{ category: string; inflow: number; outflow: number }>;
 txnCount: number;
 /** Per-channel AR collection actuals: paid invoices whose paidDate falls
  *  in [weekStart, weekEnd]. */
 arActuals: {
  gelato: { amount: number; invoiceCount: number };
  // sameWeek = invoiced AND paid in the SAME week (immediate cash from that week's
  // new sales -> Actual "Projected AR"). lagged = paid this week but invoiced
  // earlier (older sale collecting now -> Actual "Little Tree AR"). sameWeek +
  // lagged = amount.
  nonGelato: { amount: number; invoiceCount: number; sameWeek: number; lagged: number };
  total: number;
 };
 /** Sales INVOICED in this week (issue date inside the range). */
 salesInvoiced: {
  gelato: { amount: number; invoiceCount: number };
  nonGelato: { amount: number; invoiceCount: number };
  total: number;
 };
 /** Total open AR balance as of weekEnd (or today if week is in-progress).
  *  Sum of (amount - paid) for invoices with invoiceDate <= effectiveEnd,
  *  excluding Gelato (which has its own Net 97 schedule). */
 arOpenAtEnd: {
  amount: number;
  invoiceCount: number;
 };
 /** Drill-down lists for the user: every paid + every newly-issued invoice
  *  that fell into this week. Capped at 100 each to keep payload small. */
 paidInvoices: InvoiceDetail[];
 invoicedInvoices: InvoiceDetail[];
 /** "What's in the AR forecast for this week?" - open non-Gelato invoices
  *  as of weekStart, annotated with current paid status. Lets the user
  *  see the projection's composition and which ones have since been paid. */
 forecastBasisInvoices: ForecastInvoiceRow[];
};

function txnInBusinessCash(txn: TillerTxn): boolean {
 return BUSINESS_CASH_RE.test(txn.account);
}

function txnInWindow(txn: TillerTxn, start: string, end: string): boolean {
 return txn.date >= start && txn.date <= end;
}

const ymdUtc = (d: Date): string =>
 `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** invoiceNumber (lowercased) -> authoritative invoice date taken from the
 *  Invoice Tracker, which mirrors the ACTUAL QuickBooks bill date (verified:
 *  the Tracker's "Date" column matches the date embedded in each bill's Intuit
 *  share link). The LT Financials *sales* sheet date is occasionally off by ~1
 *  day; when an invoice number matches, we trust the Tracker/bill date so the
 *  weekly "who invoiced what, when" buckets line up with the real bills. */
async function getBillInvoiceDates(): Promise<Map<string, Date>> {
 const tr = await getInvoiceTracker();
 const m = new Map<string, Date>();
 for (const inv of tr.invoices) {
  const key = inv.invoiceNumber.trim().toLowerCase();
  if (key && inv.invoiceDate) m.set(key, inv.invoiceDate);
 }
 return m;
}

/** Per-channel AR actuals: dollars actually collected in [weekStart, weekEnd]
 *  per LT Financials (the company source-of-truth for invoice + payment data).
 *  Sums `paid` for any invoice whose paidDate falls in the week. Gelato bucket
 *  rarely lands here since Gelato sales come from a separate sheet - included
 *  defensively in case any rows are tagged Gelato.
 *  Invoice date for the same-week/lagged split is taken from the Invoice Tracker
 *  (bill date) when the invoice number matches - see getBillInvoiceDates. */
export async function getArActualsForWeek(weekStart: string, weekEnd: string): Promise<WeekActuals['arActuals']> {
 const [ltFin, billDates] = await Promise.all([getLtFinancialsSales(), getBillInvoiceDates()]);
 let gelatoAmt = 0, gelatoCount = 0, nonGelatoAmt = 0, nonGelatoCount = 0;
 let sameWeekAmt = 0, laggedAmt = 0;  // non-Gelato split by how fast the sale collected
 for (const inv of ltFin.invoices) {
  if (inv.paid <= 0) continue;
  if (!inv.paidDate) continue;
  const pd = `${inv.paidDate.getUTCFullYear()}-${String(inv.paidDate.getUTCMonth() + 1).padStart(2, '0')}-${String(inv.paidDate.getUTCDate()).padStart(2, '0')}`;
  if (pd < weekStart || pd > weekEnd) continue;
  const isGelato = inv.channel === 'Gelato';
  if (isGelato) { gelatoAmt += inv.paid; gelatoCount++; }
  else {
   nonGelatoAmt += inv.paid; nonGelatoCount++;
   // Was this sale invoiced in the same week it got paid? If yes -> immediate
   // (Collected from sales). If invoiced earlier -> lag collection (Past AR).
   // Use the Invoice Tracker (bill) date when the invoice number matches.
   const billDate = billDates.get(inv.invoiceNumber.trim().toLowerCase()) ?? inv.invoiceDate;
   const id = ymdUtc(billDate);
   if (id >= weekStart && id <= weekEnd) sameWeekAmt += inv.paid;
   else laggedAmt += inv.paid;
  }
 }
 return {
  gelato: { amount: +gelatoAmt.toFixed(2), invoiceCount: gelatoCount },
  nonGelato: {
   amount: +nonGelatoAmt.toFixed(2), invoiceCount: nonGelatoCount,
   sameWeek: +sameWeekAmt.toFixed(2), lagged: +laggedAmt.toFixed(2),
  },
  total: +(gelatoAmt + nonGelatoAmt).toFixed(2),
 };
}

/**
 * Collected DETAIL for any date range [start, end] (YYYY-MM-DD inclusive), by
 * PAID date - the actual invoices behind the "collected" number. Powers (a) the
 * variance drill-down (click a line → what was collected, from whom, how much)
 * and (b) the calendar-period actual, so Month mode = the FULL month (Jun 1-25),
 * matching the AR page - not just the complete Mon-Sun weeks. From LT Financials.
 */
export async function getCollectedDetail(start: string, end: string): Promise<{
 start: string; end: string;
 nonGelato: { total: number; count: number; invoices: InvoiceDetail[] };
 gelato: { total: number; count: number; invoices: InvoiceDetail[] };
 // Sales INVOICED (gross, by bill date) over the SAME [start, end] window - so the
 // Variance "Little Tree Sales" REF actual covers the full period (incl. the
 // in-progress week), instead of only the complete closed weeks. This makes it
 // match the month-to-date sales shown on the KPI / AR page.
 salesInvoiced: WeekActuals['salesInvoiced'];
}> {
 const ltFin = await getLtFinancialsSales();
 const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
 const ng: InvoiceDetail[] = [], gel: InvoiceDetail[] = [];
 let ngT = 0, gT = 0;
 for (const inv of ltFin.invoices) {
  if (inv.paid <= 0 || !inv.paidDate) continue;
  const pd = ymd(inv.paidDate);
  if (pd < start || pd > end) continue;
  const d: InvoiceDetail = {
   invoiceNumber: inv.invoiceNumber, customer: inv.customer,
   channel: inv.channel === 'Gelato' ? 'Gelato' : 'Little Tree',
   invoiceDate: inv.invoiceDate ? ymd(inv.invoiceDate) : '', paidDate: pd, amount: inv.amount, paid: inv.paid,
  };
  if (inv.channel === 'Gelato') { gel.push(d); gT += inv.paid; }
  else { ng.push(d); ngT += inv.paid; }
 }
 ng.sort((a, b) => b.paid - a.paid); gel.sort((a, b) => b.paid - a.paid);
 // Gross sales invoiced (by bill date) across the WHOLE window - the Variance
 // sales actual reads this so it spans the full month-to-date, not just closed weeks.
 const salesInvoiced = await getSalesInvoicedForWeek(start, end);
 return {
  start, end,
  nonGelato: { total: +ngT.toFixed(2), count: ng.length, invoices: ng },
  gelato: { total: +gT.toFixed(2), count: gel.length, invoices: gel },
  salesInvoiced,
 };
}

/** Historical share of non-Gelato dollars collected in the SAME (Monday-anchored)
 *  week the invoice was issued - i.e. "sale hua aur usi week paisa aa gaya". Used
 *  to split BUDGET new-sales collections into immediate (Projected AR) vs lagged
 *  (Little Tree AR), using the exact same definition the Actual tab uses, so the
 *  two tabs measure the same thing. Returns a fraction 0..1. */
export async function getSameWeekCollectionRate(): Promise<number> {
 const [ltFin, billDates] = await Promise.all([getLtFinancialsSales(), getBillInvoiceDates()]);
 const mondayKey = (d: Date): string => {
  const dow = d.getUTCDay();              // 0=Sun..6=Sat
  const back = dow === 0 ? 6 : dow - 1;   // days back to Monday
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
  return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}-${String(m.getUTCDate()).padStart(2, '0')}`;
 };
 // Group collections by the MONTH the payment landed, then average each month's
 // same-week share with EQUAL weight (simple average of the monthly rates, ~15%)
 // - per user preference - rather than dollar-weighting the whole period (~13%,
 // which a few big-collection months drag down). Each month counts the same.
 const byMonth = new Map<string, { same: number; total: number; ord: number }>();
 for (const inv of ltFin.invoices) {
  if (inv.paid <= 0 || !inv.paidDate) continue;
  if (inv.channel === 'Gelato') continue;     // non-Gelato only (Gelato is Net 97)
  const yr = inv.paidDate.getUTCFullYear(), mo = inv.paidDate.getUTCMonth();
  const ym = `${yr}-${mo}`;
  const m = byMonth.get(ym) ?? { same: 0, total: 0, ord: yr * 12 + mo };
  m.total += inv.paid;
  // Invoice date from the Tracker (bill) when the invoice number matches.
  const billDate = billDates.get(inv.invoiceNumber.trim().toLowerCase()) ?? inv.invoiceDate;
  if (mondayKey(billDate) === mondayKey(inv.paidDate)) m.same += inv.paid;
  byMonth.set(ym, m);
 }
 // Average each month's same-week share with EQUAL weight over the LAST 12 months
 // with collections (per user preference, ~15%) - not dollar-weighted (~13%) and
 // not all-time (older months drag it to ~12.6%). Each recent month counts once.
 const monthlyRates = [...byMonth.values()].filter((m) => m.total > 0).sort((a, b) => b.ord - a.ord).slice(0, 12).map((m) => m.same / m.total);
 return monthlyRates.length ? monthlyRates.reduce((s, r) => s + r, 0) / monthlyRates.length : 0;
}

let _lagCurveCache: { at: number; curve: number[] } | null = null;
/**
 * Empirical non-Gelato COLLECTION LAG CURVE from LT Financials paid history
 * (last 12 months): the share of dollars collected in the SAME Monday-week the
 * invoice was issued (index 0), +1 week (index 1), ... up to +12 weeks. Returns
 * a 13-element array summing to ~1. This is the real "kab kitna paisa aata hai"
 * shape - ~16% the first week, ~33% within two, then a long tail out past two
 * months. The 13-week cashflow uses it to spread BOTH the open AR and new-sales
 * collections realistically, instead of cramming everything into 4 weeks.
 */
export async function getCollectionLagCurve(): Promise<number[]> {
 if (_lagCurveCache && Date.now() - _lagCurveCache.at < 10 * 60 * 1000) return _lagCurveCache.curve;
 const N = 12;
 const fallback = new Array(N + 1).fill(1 / (N + 1));
 try {
  const ltFin = await getLtFinancialsSales();
  const mondayKey = (d: Date): string => {
   const dow = d.getUTCDay(); const back = dow === 0 ? 6 : dow - 1;
   const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back));
   return `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}-${String(m.getUTCDate()).padStart(2, '0')}`;
  };
  const buckets = new Array(N + 1).fill(0); let tot = 0;
  const cutoff = Date.now() - 365 * 86400000;
  for (const inv of ltFin.invoices) {
   if (inv.paid <= 0 || !inv.paidDate || inv.channel === 'Gelato') continue;
   if (inv.paidDate.getTime() < cutoff) continue;
   const bw = Date.parse(mondayKey(inv.invoiceDate)), pw = Date.parse(mondayKey(inv.paidDate));
   let wk = Math.round((pw - bw) / (7 * 86400000));
   wk = Math.max(0, Math.min(wk, N));
   buckets[wk] += inv.paid; tot += inv.paid;
  }
  const curve = tot > 0 ? buckets.map((v) => v / tot) : fallback;
  _lagCurveCache = { at: Date.now(), curve };
  return curve;
 } catch {
  return fallback;
 }
}

/** Simple direct check - the dashboard only cares about Gelato vs Non-Gelato,
 *  not the full channelOf classification (which can return verbose labels
 *  like "Little Tree (Gelato channel)" that confuse the UI). */
function simpleChannel(customer: string): 'Gelato' | 'Little Tree' {
 return /^little tree-?\s*gelato\b/i.test(customer) ? 'Gelato' : 'Little Tree';
}

/** Drill-down: every invoice with paidDate in this week (capped at 100). */
export async function getPaidInvoicesForWeek(weekStart: string, weekEnd: string): Promise<InvoiceDetail[]> {
 const tracker = await getInvoiceTracker();
 const out: InvoiceDetail[] = [];
 for (const inv of tracker.invoices) {
  if (inv.paid <= 0) continue;
  const pd = inv.paidDate;
  if (!pd || pd < weekStart || pd > weekEnd) continue;
  out.push({
   invoiceNumber: inv.invoiceNumber,
   customer: inv.customer,
   channel: simpleChannel(inv.customer),
   invoiceDate: `${inv.invoiceDate.getUTCFullYear()}-${String(inv.invoiceDate.getUTCMonth() + 1).padStart(2, '0')}-${String(inv.invoiceDate.getUTCDate()).padStart(2, '0')}`,
   paidDate: pd,
   amount: inv.amount,
   paid: inv.paid,
  });
 }
 out.sort((a, b) => b.paid - a.paid);
 return out.slice(0, 100);
}

/** Drill-down: every invoice with invoiceDate in this week (capped at 100). */
export async function getInvoicedInvoicesForWeek(weekStart: string, weekEnd: string): Promise<InvoiceDetail[]> {
 const tracker = await getInvoiceTracker();
 const start = new Date(weekStart + 'T00:00:00Z').getTime();
 const end = new Date(weekEnd + 'T23:59:59Z').getTime();
 const out: InvoiceDetail[] = [];
 for (const inv of tracker.invoices) {
  if (inv.amount <= 0) continue;
  const t = inv.invoiceDate.getTime();
  if (t < start || t > end) continue;
  out.push({
   invoiceNumber: inv.invoiceNumber,
   customer: inv.customer,
   channel: simpleChannel(inv.customer),
   invoiceDate: `${inv.invoiceDate.getUTCFullYear()}-${String(inv.invoiceDate.getUTCMonth() + 1).padStart(2, '0')}-${String(inv.invoiceDate.getUTCDate()).padStart(2, '0')}`,
   paidDate: inv.paidDate || '',
   amount: inv.amount,
   paid: inv.paid,
  });
 }
 out.sort((a, b) => b.amount - a.amount);
 return out.slice(0, 100);
}

/**
 * Invoices the model would have projected to pay in this week, computed AS
 * OF weekStart (not today). Reconstructs the projection's view from the
 * week's perspective so invoices that have since been paid still appear -
 * letting the user see "what we expected" vs "what came in".
 *
 * Steps for each non-Gelato invoice issued before weekStart:
 *   1. Compute openAtWeekStart = amount - (paid with paidDate < weekStart).
 *      Treat missing paidDate as "paid before weekStart" (sheet says paid
 *      but doesn't say when, so don't speculate).
 *   2. If openAtWeekStart > $200, project across the channel's lag curve.
 *      For lag = currentLag(invoiceDate → weekStart) onward, target month
 *      = invoiceMonth + lag. If that month overlaps [weekStart, weekEnd],
 *      portion lands in Wk 1 of this snapshot.
 *   3. Annotate with current paid status.
 *
 * Capped at 150 rows; smallest projected portions trimmed first.
 */
export async function getForecastBasisInvoices(weekStart: string, weekEnd: string): Promise<ForecastInvoiceRow[]> {
 const tracker = await getInvoiceTracker();
 const weekStartDate = new Date(weekStart + 'T00:00:00Z');
 const weekEndDate = new Date(weekEnd + 'T23:59:59Z');

 // --- 1. Build per-channel + global lag curves from ALL paid history. ---
 const MAX_LAG = 12;
 type Curve = { lagPaid: number[]; total: number; samples: number };
 const empty = (): Curve => ({ lagPaid: new Array(MAX_LAG + 1).fill(0), total: 0, samples: 0 });
 const globalCurve = empty();
 const channelCurves = new Map<string, Curve>();
 for (const inv of tracker.invoices) {
  if (simpleChannel(inv.customer) === 'Gelato') continue;
  if (/write\s*off/i.test(inv.status)) continue;
  if (inv.amount <= 0) continue;
  globalCurve.total += inv.amount;
  globalCurve.samples++;
  const ch = channelOf(inv.customer);
  let cc = channelCurves.get(ch);
  if (!cc) { cc = empty(); channelCurves.set(ch, cc); }
  cc.total += inv.amount;
  cc.samples++;
  if (inv.paid <= 0 || !inv.paidDate) continue;
  const paid = new Date(inv.paidDate + 'T00:00:00Z');
  const lag = (paid.getUTCFullYear() - inv.invoiceDate.getUTCFullYear()) * 12
   + (paid.getUTCMonth() - inv.invoiceDate.getUTCMonth());
  if (lag < 0 || lag > MAX_LAG) continue;
  globalCurve.lagPaid[lag] += inv.paid;
  cc.lagPaid[lag] += inv.paid;
 }
 const curveFor = (channel: string): number[] => {
  const cc = channelCurves.get(channel);
  if (cc && cc.samples >= 5 && cc.total > 0) return cc.lagPaid.map((p) => p / cc.total);
  if (globalCurve.total > 0) return globalCurve.lagPaid.map((p) => p / globalCurve.total);
  return new Array(MAX_LAG + 1).fill(0);
 };

 // --- 2. For each historical invoice, compute its projected Wk-1 portion. ---
 const out: ForecastInvoiceRow[] = [];
 const MIN_PORTION = 5;
 for (const inv of tracker.invoices) {
  if (simpleChannel(inv.customer) === 'Gelato') continue;
  if (/write\s*off/i.test(inv.status)) continue;
  if (inv.invoiceDate >= weekStartDate) continue; // not yet issued at week start

  // Open balance at week start = amount minus any payment that landed before.
  let paidBeforeWeek = 0;
  if (inv.paid > 0) {
   if (!inv.paidDate || inv.paidDate < weekStart) paidBeforeWeek = inv.paid;
  }
  const openAtWeekStart = inv.amount - paidBeforeWeek;
  if (openAtWeekStart < 200) continue;

  // Project remaining curve from current lag onward (as of weekStart).
  const currentLag = (weekStartDate.getUTCFullYear() - inv.invoiceDate.getUTCFullYear()) * 12
   + (weekStartDate.getUTCMonth() - inv.invoiceDate.getUTCMonth());
  if (currentLag > MAX_LAG) continue;       // too stale
  const startLag = Math.max(currentLag, 0);
  const curve = curveFor(channelOf(inv.customer));
  let remainingPct = 0;
  for (let lag = startLag; lag <= MAX_LAG; lag++) remainingPct += curve[lag] ?? 0;
  if (remainingPct <= 0.0001) continue;

  // Find the lag whose TARGET MONTH overlaps the snapshot week.
  let projectedWk1 = 0;
  for (let lag = startLag; lag <= MAX_LAG; lag++) {
   const pct = curve[lag] ?? 0;
   if (pct === 0) continue;
   const targetMonthStart = new Date(Date.UTC(
    inv.invoiceDate.getUTCFullYear(),
    inv.invoiceDate.getUTCMonth() + lag,
    1,
   ));
   const targetMonthEnd = new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth() + 1,
    0, 23, 59, 59,
   ));
   // Does target month overlap [weekStart, weekEnd]?
   if (targetMonthEnd < weekStartDate || targetMonthStart > weekEndDate) continue;
   // Portion = openAtWeekStart × (pct / remainingPct), spread across all weeks
   // of target month. Approx as portion / weeksInTargetMonth ≈ 4.
   const portion = openAtWeekStart * (pct / remainingPct);
   // Weeks of target month that fall in the visible 13-week window starting
   // weekStart: target month has ~4 weeks. We only count the one(s) that
   // overlap the snapshot's Wk 1.
   // For simplicity, allocate portion / 4 (an even spread approximation
   // matching arProjection's spreadAcrossMonth).
   projectedWk1 += portion / 4;
  }
  if (projectedWk1 < MIN_PORTION) continue;

  // Current paid status.
  let status: ForecastInvoiceRow['status'] = 'unpaid';
  if (inv.paid >= inv.amount - 0.01) status = 'paid';
  else if (inv.paid > 0) status = 'partial';
  const paidThisWeek = !!(inv.paidDate && inv.paidDate >= weekStart && inv.paidDate <= weekEnd);

  const issuedYmd = `${inv.invoiceDate.getUTCFullYear()}-${String(inv.invoiceDate.getUTCMonth() + 1).padStart(2, '0')}-${String(inv.invoiceDate.getUTCDate()).padStart(2, '0')}`;
  out.push({
   invoiceNumber: inv.invoiceNumber,
   customer: inv.customer,
   channel: simpleChannel(inv.customer),
   invoiceDate: issuedYmd,
   paidDate: inv.paidDate || '',
   amount: inv.amount,
   paid: inv.paid,
   openAtWeekStart: +openAtWeekStart.toFixed(2),
   projectedAmountThisWeek: +projectedWk1.toFixed(2),
   status,
   paidThisWeek,
  });
 }
 out.sort((a, b) => b.projectedAmountThisWeek - a.projectedAmountThisWeek);
 return out.slice(0, 150);
}

/** Total open non-Gelato AR balance as of asOfDate (inclusive). Sum of
 *  (amount - paid) for invoices issued on/before asOfDate, where status is
 *  not write-off, paid < amount, and channel is not Gelato. */
export async function getOpenArAsOf(asOfDate: string): Promise<{ amount: number; invoiceCount: number }> {
 const tracker = await getInvoiceTracker();
 const cutoff = new Date(asOfDate + 'T23:59:59Z').getTime();
 let amount = 0;
 let count = 0;
 for (const inv of tracker.invoices) {
  if (simpleChannel(inv.customer) === 'Gelato') continue;
  if (/write\s*off/i.test(inv.status)) continue;
  if (inv.invoiceDate.getTime() > cutoff) continue;
  // Open amount = (issued amount) - (cash that landed by asOfDate).
  // If paidDate is later than asOfDate, that payment hasn't happened yet.
  let paidByAsOf = inv.paid;
  if (inv.paid > 0 && inv.paidDate && inv.paidDate > asOfDate) {
   paidByAsOf = 0;
  }
  const open = inv.amount - paidByAsOf;
  if (open > 0.01) {
   amount += open;
   count++;
  }
 }
 return { amount: +amount.toFixed(2), invoiceCount: count };
}

/** Per-channel sales INVOICED in [weekStart, weekEnd] from LT Financials -
 *  the company source-of-truth invoice ledger (sales projection also reads
 *  from here, so weekly actuals reconcile against the same source).
 *  The invoice date that decides the week is taken from the Invoice Tracker
 *  (bill date) when the invoice number matches - see getBillInvoiceDates. */
export async function getSalesInvoicedForWeek(weekStart: string, weekEnd: string): Promise<WeekActuals['salesInvoiced']> {
 const [ltFin, billDates] = await Promise.all([getLtFinancialsSales(), getBillInvoiceDates()]);
 const start = new Date(weekStart + 'T00:00:00Z').getTime();
 const end = new Date(weekEnd + 'T23:59:59Z').getTime();
 let gelatoAmt = 0, gelatoCount = 0, nonGelatoAmt = 0, nonGelatoCount = 0;
 for (const inv of ltFin.invoices) {
  if (inv.amount <= 0) continue;
  const billDate = billDates.get(inv.invoiceNumber.trim().toLowerCase()) ?? inv.invoiceDate;
  const t = billDate.getTime();
  if (t < start || t > end) continue;
  const isGelato = inv.channel === 'Gelato';
  if (isGelato) { gelatoAmt += inv.amount; gelatoCount++; }
  else { nonGelatoAmt += inv.amount; nonGelatoCount++; }
 }
 return {
  gelato: { amount: +gelatoAmt.toFixed(2), invoiceCount: gelatoCount },
  nonGelato: { amount: +nonGelatoAmt.toFixed(2), invoiceCount: nonGelatoCount },
  total: +(gelatoAmt + nonGelatoAmt).toFixed(2),
 };
}

export async function getWeekActuals(weekStart: string, weekEnd: string): Promise<WeekActuals> {
 const [tiller, arActuals, salesInvoiced, paidInvoices, invoicedInvoices, arOpenAtEnd, forecastBasisInvoices] = await Promise.all([
  getTillerTransactions(),
  getArActualsForWeek(weekStart, weekEnd),
  getSalesInvoicedForWeek(weekStart, weekEnd),
  getPaidInvoicesForWeek(weekStart, weekEnd),
  getInvoicedInvoicesForWeek(weekStart, weekEnd),
  getOpenArAsOf(weekEnd),
  getForecastBasisInvoices(weekStart, weekEnd),
 ]);
 const bucket = new Map<string, { inflow: number; outflow: number }>();
 let inflow = 0;
 let outflow = 0;
 let txnCount = 0;
 for (const t of tiller.transactions) {
  if (!txnInBusinessCash(t)) continue;
  if (!txnInWindow(t, weekStart, weekEnd)) continue;
  txnCount++;
  const cat = t.category || '(uncategorised)';
  const cur = bucket.get(cat) ?? { inflow: 0, outflow: 0 };
  if (t.amount > 0) {
   inflow += t.amount;
   cur.inflow += t.amount;
  } else if (t.amount < 0) {
   outflow += Math.abs(t.amount);
   cur.outflow += Math.abs(t.amount);
  }
  bucket.set(cat, cur);
 }
 const byCategory = [...bucket.entries()]
  .map(([category, v]) => ({ category, inflow: +v.inflow.toFixed(2), outflow: +v.outflow.toFixed(2) }))
  .sort((a, b) => (b.outflow + b.inflow) - (a.outflow + a.inflow));
 return {
  weekStart,
  weekEnd,
  inflow: +inflow.toFixed(2),
  outflow: +outflow.toFixed(2),
  netChange: +(inflow - outflow).toFixed(2),
  byCategory,
  txnCount,
  arActuals,
  salesInvoiced,
  arOpenAtEnd,
  paidInvoices,
  invoicedInvoices,
  forecastBasisInvoices,
 };
}
