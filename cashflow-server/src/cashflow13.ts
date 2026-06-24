/**
 * 13-Week Cash Flow - primary lender-facing artifact, rolling.
 *
 * Week 1 = the Monday of the current ISO week. Every Monday the schedule rolls
 * forward by one week automatically.
 *
 * All values are live - no spreadsheet-hardcoded fallbacks. Where a source is
 * missing, the row is 0 and the UI shows it as such.
 *
 * Live sources:
 * - Opening Cash Wk1 ← Tiller cash accounts (Section 1 sum)
 * - CC Payoff Wk1 ← Tiller credit-card balances (Section 2 sum)
 * - AR Collections ← Gelato AR sheet (each Pending invoice placed in
 * expected collection week = issue + 90 days)
 * Outflows are PATTERN-BASED, not flat. Run-rates use the recent 3 months
 * (spend has stepped down through 2026, so a full-history avg over-forecasts),
 * and each category gets its real weekly shape:
 * - Payroll (per week) ← QB Combined expenses · recent 3-mo run-rate of the
 * Payroll group, distributed BI-WEEKLY (a pay event every other week)
 * - Inventory & RM ← QB Combined expenses · recent 3-mo run-rate, BACK-LOADED
 * within the month (18/26/26/30% by week-of-month, from 1,162 purchase dates)
 * - Rent ← recent 3-mo run-rate, lumped on the 1st of each month (fixed cost)
 * - Software & Subscriptions ← QB Combined expenses · recent 3-mo run-rate
 * - Other Expenses ← QB Combined expenses · recent 3-mo run-rate of all other
 * non-payroll/non-inventory/non-rent categories, spread evenly
 */

import { getTillerBalances } from './tiller.js';
import { getGelatoAr } from './gelatoAr.js';
import { getArProjection, type ArProjectionResult } from './arProjection.js';
import { getMappedExpenses } from './mappedExpenses.js';
import { getCcPaymentSchedule, type CcScheduledPayment } from './ccSchedule.js';
import { getSalesForecast, type SalesForecastResult } from './salesForecast.js';
import { captureSnapshotIfNeeded, type WeeklySnapshot } from './weeklySnapshots.js';

const WEEKS = 13;

// Status thresholds
const STATUS_CRITICAL = 10_000;
const STATUS_TIGHT = 30_000;

// --- Types ---

export type CashflowWeek = { label: string; start: string; end: string };
export type CashflowSource = 'live' | 'computed' | 'none';
export type CashflowStatus = 'HEALTHY' | 'TIGHT' | 'CRITICAL';

export type CashflowBreakdownItem = { label: string; amount: number; sub?: string };
export type CashflowLine = {
 label: string;
 source: CashflowSource;
 note?: string;
 values: number[];
 // What makes up this row - the underlying line items (categories, invoices,
 // cards, subscriptions...) so the user can see exactly what's included.
 breakdown?: CashflowBreakdownItem[];
 // Display-only row: shown for context but NOT summed into total inflows/outflows.
 // Used for the gross "Sales (this week)" row - the cash from those sales is
 // already counted via the same-week + lagged AR collection rows, so adding the
 // gross sales again would double-count. This row is purely informational.
 displayOnly?: boolean;
};

export type CashflowResult = {
 asOf: string;
 anchor: string;
 weeks: CashflowWeek[];
 openingCashWk1: number;
 openingCashSource: CashflowSource;
 bankCashWk1: number;            // pure bank balance (opening minus the Due From PureX fold)
 openingCashNote?: string;       // plain-English make-up of opening cash
 openingCashBreakdown?: CashflowBreakdownItem[]; // overdue Gelato batches folded into opening
 inflows: CashflowLine[];
 outflows: CashflowLine[];
 ccPayments: CcScheduledPayment[];
 arProjection: ArProjectionResult | null;
 salesForecast: SalesForecastResult | null;
 totals: {
 inflows: number[];
 outflows: number[];
 netChange: number[];
 openingCash: number[];
 closingCash: number[];
 status: CashflowStatus[];
 };
 assumptions: {
 ccPayoffWk1: number;
 payrollPerWeek: number;
 inventoryPerWeek: number;
 otherPerWeek: number;
 };
 warnings: string[];
};

// --- Date helpers ---

/** Today (UTC), 00:00. */
function todayUtc(): Date {
 const now = new Date();
 return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Monday-on-or-before(today). Week 1 of the 13-week plan always starts on a
 * Monday so each row covers a clean Mon-Sun calendar week. Today (May 14 Thu)
 * → Mon May 11. Today (Mon) → same day.
 */
function mondayAnchor(from: Date = todayUtc()): Date {
 // JS: Sun=0, Mon=1, ..., Sat=6. We want shift back to Monday.
 const day = from.getUTCDay();
 const shift = day === 0 ? 6 : day - 1; // Sunday → 6 days back, otherwise (day-1)
 return addDays(from, -shift);
}

function addDays(d: Date, n: number): Date {
 const r = new Date(d);
 r.setUTCDate(d.getUTCDate() + n);
 return r;
}
function ymd(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function fmtMMDD(d: Date): string {
 return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}
function daysInMonth(year: number, month: number): number {
 return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
function buildWeeks(start: Date, count: number): CashflowWeek[] {
 const w: CashflowWeek[] = [];
 for (let i = 0; i < count; i++) {
 const ws = addDays(start, i * 7);
 const we = addDays(ws, 6);
 w.push({ label: fmtMMDD(ws), start: ymd(ws), end: ymd(we) });
 }
 return w;
}

/** Place a date into one of the 13-week buckets; returns -1 if outside window. */
function weekIndexFor(date: Date, weeks: CashflowWeek[]): number {
 for (let i = 0; i < weeks.length; i++) {
 const ws = new Date(weeks[i].start + 'T00:00:00Z');
 const we = new Date(weeks[i].end + 'T23:59:59Z');
 if (date >= ws && date <= we) return i;
 }
 return -1;
}

/** Spread a monthly amount on `billDay` of each month touched by the window. */
function projectMonthly(billDay: number, monthly: number, weeks: CashflowWeek[]): number[] {
 const out = new Array(weeks.length).fill(0);
 if (monthly <= 0 || weeks.length === 0) return out;
 const start = new Date(weeks[0].start + 'T00:00:00Z');
 const end = new Date(weeks[weeks.length - 1].end + 'T23:59:59Z');
 let curYear = start.getUTCFullYear();
 let curMonth = start.getUTCMonth();
 for (let i = 0; i < 6; i++) {
 const day = Math.min(billDay, daysInMonth(curYear, curMonth));
 const billDate = new Date(Date.UTC(curYear, curMonth, day));
 if (billDate > end) break;
 if (billDate >= start) {
 const idx = weekIndexFor(billDate, weeks);
 if (idx >= 0) out[idx] += monthly;
 }
 curMonth++;
 if (curMonth > 11) { curMonth = 0; curYear++; }
 }
 return out;
}

// --- Outflow weekly-distribution patterns (research-derived) ---------------
//
// Real outflow is NOT flat. From 17 months of QB history (2025-01 → 2026-05):
//  - Inventory hits all month but back-loaded - 18/26/26/30% by week-of-month
//    (measured from 1,162 real purchase dates). CV 0.39, declining through 2026.
//  - Payroll is steady monthly (~$170k, CV 0.17) and runs a bi-weekly cycle.
//  - Rent is a fixed ~$20k/mo lump on the 1st (CV 0.00), not a weekly trickle.

/** Week-of-month (1-5) inferred from a week's Monday start date. */
function weekOfMonth(weekStartYmd: string): number {
 const d = new Date(weekStartYmd + 'T00:00:00Z');
 return Math.min(Math.floor((d.getUTCDate() - 1) / 7) + 1, 5);
}

/** Inventory: back-loaded within the month (mean factor = 1.0 so the monthly
 *  total is preserved). Factors are 4x the 18/26/26/30% week-of-month split. */
const INV_WEEK_FACTOR: Record<number, number> = { 1: 0.72, 2: 1.04, 3: 1.04, 4: 1.20, 5: 1.20 };
function inventoryByWeek(monthly: number, weeks: CashflowWeek[]): number[] {
 const base = monthly / 4.33;
 return weeks.map((w) => +(base * (INV_WEEK_FACTOR[weekOfMonth(w.start)] ?? 1)).toFixed(2));
}

/** Payroll: bi-weekly cadence - a pay event every other week (wk 1,3,5,...).
 *  Per-pay amount is scaled so the 13-week total = ~3 monthly run-rates.
 *  NOTE: cadence is ASSUMED bi-weekly; exact pay weeks need the live QB pay
 *  dates to confirm (semi-monthly would shift placement, not the monthly total). */
function payrollByWeekBiweekly(monthly: number, weeks: CashflowWeek[]): number[] {
 const out = new Array(weeks.length).fill(0);
 if (monthly <= 0) return out;
 const payIdx = weeks.map((_, i) => i).filter((i) => i % 2 === 0);
 const perPay = payIdx.length > 0 ? (monthly * (weeks.length / 4.33)) / payIdx.length : 0;
 for (const i of payIdx) out[i] = +perPay.toFixed(2);
 return out;
}

function classifyStatus(closing: number): CashflowStatus {
 if (closing < STATUS_CRITICAL) return 'CRITICAL';
 if (closing < STATUS_TIGHT) return 'TIGHT';
 return 'HEALTHY';
}

const MONTH_NAMES_FULL = ['january', 'february', 'march', 'april', 'may', 'june',
 'july', 'august', 'september', 'october', 'november', 'december'];

function parseDateAny(s: string): Date | null {
 const t = (s ?? '').trim();
 if (!t) return null;
 if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(t + 'T00:00:00Z');
 const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
 if (m) {
 const yr = m[3].length === 2 ? Number('20' + m[3]) : Number(m[3]);
 return new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2])));
 }
 // "Month YYYY" → use last day of that month as issue date (e.g. "January 2026"
 // means the January 2026 batch invoice, billed end-of-month). Tolerates
 // sheet typos like "Janurary" / "Feburary" by matching first 3 chars.
 const mn = t.match(/^([A-Za-z]{3,})\s+(\d{4})$/);
 if (mn) {
 const prefix = mn[1].toLowerCase().substring(0, 3);
 const monthIdx = MONTH_NAMES_FULL.findIndex((m) => m.startsWith(prefix));
 if (monthIdx >= 0) {
 const yr = Number(mn[2]);
 const lastDay = new Date(Date.UTC(yr, monthIdx + 1, 0)).getUTCDate();
 return new Date(Date.UTC(yr, monthIdx, lastDay));
 }
 }
 return null;
}

// --- Main entry ---

export async function getCashflow13Week(opts: { direction?: 'future' | 'past' } = {}): Promise<CashflowResult> {
 // Week 1 always starts on a Monday (Mon-Sun calendar weeks). For 'past'
 // mode we anchor 13 weeks BEFORE the current Monday so the view covers
 // weeks that have already closed.
 const monday = mondayAnchor();
 // Past view anchors at the FIRST MONDAY OF MAY 2026 (matches the past-weeks
 // grid). The as-of forecast runs from there - "the budget we'd have made at
 // the start of May", projected forward over the elapsed weeks.
 const MAY1 = new Date(Date.UTC(2026, 4, 1));
 const mayDow = MAY1.getUTCDay();
 const firstMondayMay = addDays(MAY1, mayDow === 1 ? 0 : (8 - mayDow) % 7);
 const ANCHOR = opts.direction === 'past' ? firstMondayMay : monday;
 const weeks = buildWeeks(ANCHOR, WEEKS);
 // PAST view: run the sales forecast + AR projection AS-OF the window start, so
 // each elapsed week is predicted exactly the way we'd have predicted it then
 // (same trend/seasonality/lag-curve logic, data truncated to that date).
 // Anchor the as-of at the END of the month before the window start (complete
 // month) - not the 4th of the month, which would make the forecast extrapolate
 // a 4-day partial month to a full one (~7x) and wildly over-state the base.
 const _w0 = new Date(weeks[0].start + 'T00:00:00Z');
 const asOf = opts.direction === 'past'
 ? new Date(Date.UTC(_w0.getUTCFullYear(), _w0.getUTCMonth(), 0))
 : undefined;
 const warnings: string[] = [];

 // 1. Opening cash + CC payoff - Tiller live.
 // Business accounts only (match what Current Position counts):
 // - CRB Indirect / 7561 (primary checking)
 // - Business MM / 0910 (secondary MM)
 // Personal accounts (Regular Chk, New Personal MM) excluded.
 const BUSINESS_CASH_RE = /crb indirect|7561|business mm|0910/i;
 let openingCashWk1 = 0;
 let openingCashSource: CashflowSource = 'none';
 let ccPayoff = 0;
 try {
 const tiller = await getTillerBalances();
 openingCashWk1 = tiller.cashAccounts
 .filter((a) => BUSINESS_CASH_RE.test(a.name))
 .reduce((s, a) => s + a.balance, 0);
 // CC payoff: include both creditCards bucket AND loans bucket (MC Consumer
 // is categorised as a loan by Tiller but is functionally a CC).
 ccPayoff = [...tiller.creditCards, ...tiller.loans].reduce((s, a) => s + Math.abs(a.balance), 0);
 openingCashSource = 'live';
 } catch (e) {
 warnings.push(`Tiller fetch failed (${e instanceof Error ? e.message : '?'}) - opening cash and CC payoff = 0.`);
 }

 // 1b. CC Payment Schedule per week - replaces the legacy Wk 1 dump with a
 // proper per-card schedule (each card paid at its monthly due date).
 let ccByWeek: number[] = new Array(WEEKS).fill(0);
 let ccPayments: CcScheduledPayment[] = [];
 let ccScheduleSource: CashflowSource = 'none';
 try {
 const sch = await getCcPaymentSchedule(weeks);
 ccByWeek = sch.byWeek;
 ccPayments = sch.payments;
 for (const w of sch.warnings) warnings.push(w);
 if (ccPayments.length > 0) ccScheduleSource = 'live';
 } catch (e) {
 warnings.push(`CC schedule failed (${e instanceof Error ? e.message : '?'}).`);
 }

 // 1c. CC Utilisation removed - the 13-week plan no longer shows a CC-financing
 // inflow line, and no longer auto-draws on the credit cards to cover weekly
 // shortfalls. Closing cash now reflects the real (un-plugged) position.

 // 2a. Gelato AR Collections per week - Net 97 terms (Net 90 + 7-day payment
 // processing buffer). Each Gelato Pending invoice placed at issue + 97 days.
 const gelatoArCollections: number[] = new Array(WEEKS).fill(0);
 let gelatoArSource: CashflowSource = 'none';
 // Overdue Gelato batches (past their Net-97 date) are money PureX already owes
 // = the "Due From PureX (Gelato Net 90)" receivable. Per the user's model,
 // OPENING CASH = "Total Cash on Hand" = bank + Due From PureX, so the overdue
 // amount is folded into Wk1 opening cash instead of being collected again.
 // Batches not yet due still show as collections in the week they land (e.g.
 // the March batch in ~Wk3) so you can watch that money arrive.
 let gelatoOverdueToOpening = 0;
 const gelatoBreakdown: CashflowBreakdownItem[] = [];
 const openingGelatoBreakdown: CashflowBreakdownItem[] = [];
 try {
 const gelato = await getGelatoAr();
 for (const inv of gelato.pendingInvoices) {
 // Only the amount STILL to collect counts: billed − whatever the Invoice
 // Tracker shows already received. Fully-paid batch dropped; underpaid one
 // contributes just its shortfall.
 const received = inv.receivedAmount ?? 0;
 const remaining = +Math.max(0, inv.amount - received).toFixed(2);
 if (remaining <= 0.5) continue;
 const issue = parseDateAny(inv.period) ?? parseDateAny(inv.comment);
 const expected = issue ? addDays(issue, 97) : ANCHOR; // Net 97
 const idx = weekIndexFor(expected, weeks);
 const idParts = [inv.invoiceNumber, inv.period].filter(Boolean).join(' · ');
 const bdItem: CashflowBreakdownItem = {
 label: inv.description || inv.invoiceNumber || inv.period,
 amount: remaining,
 sub: received > 0
 ? `${idParts} · billed $${Math.round(inv.amount).toLocaleString()}, received $${Math.round(received).toLocaleString()}`
 : idParts,
 };
 if (expected < ANCHOR) {
 // Already owed (past Net 97) → part of Total Cash on Hand → opening cash.
 gelatoOverdueToOpening += remaining;
 openingGelatoBreakdown.push(bdItem);
 } else if (idx >= 0) {
 gelatoArCollections[idx] += remaining;
 gelatoBreakdown.push(bdItem);
 }
 }
 if (gelato.pendingInvoices.length > 0) gelatoArSource = 'live';
 } catch (e) {
 warnings.push(`Gelato AR fetch failed (${e instanceof Error ? e.message : '?'}) - Gelato AR = 0.`);
 }

 // Opening cash = Total Cash on Hand = bank cash + overdue Gelato (Due From PureX).
 // bankCashWk1 keeps the pure bank balance for callers that want just liquid cash.
 const bankCashWk1 = openingCashWk1;
 openingCashWk1 = +(openingCashWk1 + gelatoOverdueToOpening).toFixed(2);
 const openingCashNote = gelatoOverdueToOpening > 0
 ? `Total Cash on Hand: bank $${Math.round(bankCashWk1).toLocaleString()} + Due From PureX (overdue Gelato already owed) $${Math.round(gelatoOverdueToOpening).toLocaleString()}`
 : `Bank cash $${Math.round(bankCashWk1).toLocaleString()}`;

 // 2b. Real AR projection (replaces blanket Net 30) - uses per-customer
 // collection-day patterns from paid history + future sales run-rate.
 let arProjection: ArProjectionResult | null = null;
 const nonGelatoArCollections: number[] = new Array(WEEKS).fill(0);
 let nonGelatoArSource: CashflowSource = 'none';
 try {
 arProjection = await getArProjection(weeks, asOf);
 for (let i = 0; i < WEEKS; i++) nonGelatoArCollections[i] = arProjection.arByWeek[i];
 for (const w of arProjection.warnings) warnings.push(w);
 if (arProjection.arByWeek.some((v) => v > 0)) nonGelatoArSource = 'live';
 } catch (e) {
 warnings.push(`AR projection failed (${e instanceof Error ? e.message : '?'}) - non-Gelato AR = 0.`);
 }

 // PAST view: the live AR projection + Gelato-pending placement are forward-
 // looking and read ~0 on already-collected weeks. Recompute the inflow the
 // BUDGETED way - "what we'd have forecast for that week": every Gelato batch
 // (incl. already-collected) placed at issue + Net 97, every AR invoice at
 // issue + Net 90. So Past = the budgeted calc for the elapsed weeks, not blank.
 if (opts.direction === 'past') {
 try {
 const { getExpectedInflowByWeek } = await import('./weeklyActuals.js');
 const exp = await getExpectedInflowByWeek(weeks.map((w) => ({ start: w.start, end: w.end })));
 for (let i = 0; i < WEEKS; i++) {
 gelatoArCollections[i] = exp[i]?.gelato ?? 0;
 }
 if (exp.some((x) => x.gelato > 0)) gelatoArSource = 'computed';
 // (Little Tree AR is predicted below from the sales run-rate, not the open-
 // invoice estimate, which reads ~0 for already-collected past weeks.)
 } catch (e) {
 warnings.push(`Past expected-inflow failed (${e instanceof Error ? e.message : '?'}).`);
 }
 }

 // 2c. Forward-looking sales forecast (non-Gelato) - covers FUTURE invoices
 // that don't exist yet. Linear-trend per brand over 6m lookback, distributed
 // to weeks via brand-specific collection lag curve. Only meaningful for the
 // 'future' direction view; on 'past' we skip (those weeks are settled).
 // Pulled in future direction only. The forecast is NOT shown as an inflow
 // row in the 13-Week table - it has its own dedicated Sales Forecast tab.
 // We still compute it here so the snapshot capture records what we
 // projected at the same Monday (used by the Past Weeks variance view).
 // Sales forecast is also computed for the PAST view now - "if we'd budgeted on
 // that date, how much new-sales AR would we have projected for that week" -
 // so the "Projected AR from new sales" inflow row fills on the Past tab too.
 let salesForecast: SalesForecastResult | null = null;
 try {
 salesForecast = await getSalesForecast(weeks, asOf);
 for (const w of salesForecast.warnings) warnings.push(w);
 } catch (e) {
 warnings.push(`Sales forecast failed (${e instanceof Error ? e.message : '?'}).`);
 }

 // Combined AR collections (kept for legacy callers; UI shows the split rows
 // below as separate inflow lines).
 const arCollections: number[] = weeks.map((_, i) => gelatoArCollections[i] + nonGelatoArCollections[i]);
 const arSource: CashflowSource =
 gelatoArSource === 'live' || nonGelatoArSource === 'live' ? 'live' : 'none';
 void arCollections; void arSource;

 // 3. (Subscription projection removed - Software & Subscriptions now flows
 // through the unified Combined-view formula below, same as every other
 // expense category.)

 // 4. Single-source expense projection - pull every row from Mapped
 // Expenses Combined view, calc monthly_avg = total / non-zero-months,
 // weekly = monthly_avg / 4.33, then flat-distribute across all 13 weeks.
 // This way the projection numbers match exactly what the Combined view
 // shows on the Expenses tab. Single formula for all expense categories.
 let payrollByWeek: number[] = new Array(WEEKS).fill(0);
 let invByWeek: number[] = new Array(WEEKS).fill(0);
 let subsByWeek: number[] = new Array(WEEKS).fill(0);
 let otherByWeek: number[] = new Array(WEEKS).fill(0);
 let payrollMonthlyAvg = 0;
 let invMonthlyAvg = 0;
 let subsMonthlyAvg = 0;
 let otherMonthlyAvg = 0;
 let rentMonthly = 0;
 let payrollSource: CashflowSource = 'none';
 let opexSource: CashflowSource = 'none';
 // EVERYTHING (Payroll, Inventory, Subscriptions, Other) comes from the
 // Combined view - that's the single source of truth the user sees on the
 // Expenses tab. No more separate getInventoryPurchases() trace; whatever
 // Combined shows IS the cashflow input.
 const payrollItems: { label: string; monthly: number }[] = [];
 const invItems: { label: string; monthly: number }[] = [];
 const otherItems: { label: string; monthly: number }[] = [];
 let subsItems: { label: string; monthly: number }[] = [];
 try {
 const combined = await getMappedExpenses('Combined');
 // Monthly run-rate from the RECENT 3 months - reflects the current spend
 // level, not a stale full-history average (spend stepped down through 2026).
 function monthlyRunRate(values: number[]): number {
 const v = (values ?? []).filter((x) => typeof x === 'number');
 if (v.length === 0) return 0;
 const recent = v.slice(-3);
 return recent.length > 0 ? recent.reduce((s, x) => s + x, 0) / recent.length : 0;
 }
 for (const r of combined.rows ?? []) {
 const monthly = monthlyRunRate(r.values ?? []);
 if (monthly === 0) continue;
 const cat = r.category;
 // Split a category's monthly figure across the QB accounts that fed it
 // (e.g. each payroll payee: execs, contractors, the payroll-sheet bulk),
 // proportional to each account's share - so the breakdown shows WHO/WHAT.
 const rowTotal = (r.values ?? []).reduce((s, v) => s + v, 0) || 1;
 const srcs = (r.qbSources ?? []).filter((s) => s.total > 0);
 const pushExploded = (target: { label: string; monthly: number }[]) => {
 if (srcs.length > 0) {
 for (const s of srcs) target.push({ label: s.name, monthly: monthly * (s.total / rowTotal) });
 } else {
 target.push({ label: cat, monthly });
 }
 };
 if (r.group === 'Payroll') {
 payrollMonthlyAvg += monthly;
 pushExploded(payrollItems);
 } else if (/^inventory\s*&\s*raw materials$/i.test(cat)) {
 invMonthlyAvg += monthly;
 pushExploded(invItems);
 } else if (/software\s*&\s*subscriptions/i.test(cat)) {
 // Software & Subscriptions comes from the SAME Combined expense source as
 // every other category (per request) - not a separate subscription audit.
 subsMonthlyAvg += monthly;
 pushExploded(subsItems);
 } else if (/rent|building lease/i.test(cat)) {
 // Rent is a fixed monthly lump (paid on the 1st), not a weekly trickle.
 // Kept inside the Other Expenses row but distributed as a month-start lump.
 rentMonthly += monthly;
 otherItems.push({ label: cat, monthly });
 } else {
 otherMonthlyAvg += monthly;
 otherItems.push({ label: cat, monthly });
 }
 }
 // Pattern-based distribution (not flat): each category gets its real weekly
 // shape - payroll bi-weekly, inventory back-loaded, rent a month-start lump,
 // the rest spread evenly.
 payrollByWeek = payrollByWeekBiweekly(payrollMonthlyAvg, weeks);
 invByWeek = inventoryByWeek(invMonthlyAvg, weeks);
 subsByWeek = new Array(WEEKS).fill(subsMonthlyAvg / 4.33);
 const rentByWeek = projectMonthly(1, rentMonthly, weeks);
 const otherEvenByWeek = new Array(WEEKS).fill(otherMonthlyAvg / 4.33);
 otherByWeek = weeks.map((_, i) => +((otherEvenByWeek[i] ?? 0) + (rentByWeek[i] ?? 0)).toFixed(2));
 } catch (e) {
 warnings.push(`Combined-view expense fetch failed (${e instanceof Error ? e.message : '?'}) - all expense rows = 0.`);
 }

 if (payrollMonthlyAvg > 0) payrollSource = 'live';
 if (invMonthlyAvg > 0 || otherMonthlyAvg > 0 || subsMonthlyAvg > 0 || rentMonthly > 0) opexSource = 'live';

 // Surface monthly run-rates in the legacy `assumptions` block for the UI.
 const payrollWeekly = payrollMonthlyAvg / 4.33;
 const invWeekly = invMonthlyAvg / 4.33;
 const otherWeekly = otherMonthlyAvg / 4.33;

 // Sales projection row - Little Tree (wholesale) new-invoice projection ONLY.
 // Private label is excluded per user; Gelato new invoices are NOT added here
 // because Gelato cash already comes through the "Gelato AR Collections
 // (Net 97)" row above (adding it here would double-count). Placed RIGHT BELOW
 // "Non-Gelato AR Collections" so existing open invoices vs new (not-yet-booked)
 // invoices can be compared.
 const bWholesale = salesForecast?.buckets.wholesale.weeklyInflow ?? new Array(WEEKS).fill(0);
 const projectedRaw = new Array(WEEKS).fill(0).map((_, i) =>
  +(bWholesale[i] ?? 0).toFixed(2),
 );
 // For the PAST view the forecast above is already anchored AS-OF the window
 // start (getSalesForecast + getArProjection received asOf), so Projected sales
 // + Little Tree AR are the proper "budget we'd have made then" - no override.
 const projectedSalesWeekly = projectedRaw;
 const projectedSalesSource: CashflowSource = projectedSalesWeekly.some((v) => v > 0)
 ? 'computed'
 : 'none';
 const projectedSalesNote = salesForecast
 ? `Little Tree (wholesale) new-sales cash only: $${Math.round(projectedSalesWeekly.reduce((s,v)=>s+v,0)).toLocaleString()} over 13 weeks. Private Label & Gelato excluded from this row.`
 : 'Forecast unavailable';

 // --- User's model: split new-sales collections into same-week (immediate) vs
 // lagged. "Projected AR from new sales" should be only the cash that arrives
 // the SAME week the sale is invoiced (sale hua aur usi week paisa aaya). The
 // lagged remainder collects later and belongs with the existing open invoices
 // in "Little Tree AR Collections (lag-curve)". We split by the historical
 // same-week collection rate (share of $ collected the same week invoiced, from
 // LT Financials) - the SAME definition the Actual tab uses - so the combined
 // total is unchanged; we only move the lagged part of new sales across.
 let sameWeekRate = 0;
 try {
 const { getSameWeekCollectionRate } = await import('./snapshotActuals.js');
 sameWeekRate = await getSameWeekCollectionRate();
 } catch (e) {
 warnings.push(`Same-week rate failed (${e instanceof Error ? e.message : '?'}) - new sales treated as all-lag.`);
 }
 for (let i = 0; i < WEEKS; i++) {
 const newSales = projectedSalesWeekly[i];
 const immediate = +(newSales * sameWeekRate).toFixed(2);
 nonGelatoArCollections[i] = +(nonGelatoArCollections[i] + (newSales - immediate)).toFixed(2);
 projectedSalesWeekly[i] = immediate;
 }
 if (nonGelatoArCollections.some((v) => v > 0)) nonGelatoArSource = nonGelatoArSource === 'none' ? 'computed' : nonGelatoArSource;
 const sameWeekPct = (sameWeekRate * 100).toFixed(0);

 // --- Gross new-sales forecast per week (non-Gelato), for the DISPLAY-ONLY
 // "Sales (this week)" row. Distribute each bucket's gross MONTHLY forecast
 // (forecastedSales) across that month's days, then sum the days in each week.
 // This is the "itna sales hoga" number - NOT added to cash (the cash from it
 // is already captured by the same-week + lagged AR rows). Context only.
 const salesGrossWeekly: number[] = new Array(WEEKS).fill(0);
 if (salesForecast) {
 // Use the SAME week-of-month gross distribution the Sales Projection page
 // shows (buckets[].weeklyGross, built from real invoice dates) so this row
 // matches that tab exactly - instead of an even day-split. Display-only
 // (not added to cash; the cash is already in the same-week + lagged rows).
 const wg = salesForecast.buckets.wholesale.weeklyGross ?? [];
 for (let i = 0; i < WEEKS; i++) salesGrossWeekly[i] = +(wg[i] ?? 0).toFixed(2);
 }
 const salesGrossSource: CashflowSource = salesGrossWeekly.some((v) => v > 0) ? 'computed' : 'none';

 // --- Breakdowns: the underlying line items behind each row (for the click
 // modal so the user can see exactly what's included). Expense breakdowns use
 // weekly amounts (monthly ÷ 4.33) so they sum to the row's per-week value.
 const toExpBd = (items: { label: string; monthly: number }[]): CashflowBreakdownItem[] =>
 items
 .filter((it) => it.monthly > 0)
 .sort((a, b) => b.monthly - a.monthly)
 .map((it) => ({ label: it.label, amount: +(it.monthly / 4.33).toFixed(2), sub: `≈ $${Math.round(it.monthly).toLocaleString()}/mo` }));
 const invBreakdown = toExpBd(invItems);
 const payrollBreakdown = toExpBd(payrollItems);
 const subsBreakdown = toExpBd(subsItems);
 const otherBreakdown = toExpBd(otherItems);

 // Credit-card payments grouped by card (only those due within the 13 weeks).
 const ccByCard = new Map<string, { amount: number; count: number }>();
 for (const pmt of ccPayments) {
 const idx = weekIndexFor(new Date(pmt.dueDate + 'T00:00:00Z'), weeks);
 if (idx < 0) continue;
 const cur = ccByCard.get(pmt.cardLabel) ?? { amount: 0, count: 0 };
 cur.amount += pmt.amount; cur.count++;
 ccByCard.set(pmt.cardLabel, cur);
 }
 const ccBreakdown: CashflowBreakdownItem[] = [...ccByCard.entries()]
 .sort((a, b) => b[1].amount - a[1].amount)
 .map(([card, v]) => ({ label: card, amount: +v.amount.toFixed(2), sub: `${v.count} payment${v.count > 1 ? 's' : ''} due in window` }));

 // (gelatoBreakdown is built above, where the gelato result is in scope.)

 // Projected new sales - Little Tree (wholesale) only.
 const projBreakdown: CashflowBreakdownItem[] = salesForecast ? [
 { label: 'Little Tree (new invoices)', amount: +salesForecast.buckets.wholesale.scenarioTotals.base.cash.toFixed(2), sub: '13-wk cash · base case' },
 ] : [];

 // Little Tree AR - top customers by open balance behind the projection.
 const ltByCust = new Map<string, number>();
 if (arProjection) {
 for (const pl of arProjection.placements) {
 ltByCust.set(pl.customer, (ltByCust.get(pl.customer) ?? 0) + (pl.openBalance ?? 0));
 }
 }
 const ltBreakdown: CashflowBreakdownItem[] = [...ltByCust.entries()]
 .sort((a, b) => b[1] - a[1])
 .slice(0, 30)
 .map(([cust, amt]) => ({ label: cust, amount: +amt.toFixed(2), sub: 'open balance' }));

 // 5. Assemble lines.
 const inflows: CashflowLine[] = [
 {
 label: 'Gelato AR Collections (Net 97)',
 source: gelatoArSource,
 note: 'Pending Gelato batches placed at issue + 97 days (Net 90 + 7-day buffer)',
 values: gelatoArCollections,
 breakdown: gelatoBreakdown,
 },
 {
 label: 'Past AR Collections (lag-curve)',
 source: nonGelatoArSource,
 note: (arProjection
 ? `Open invoices placed at each customer's typical pay-day (median±σ from paid history) · collectibility haircut applied - ${(arProjection.projectedCollectibilityRate * 100).toFixed(0)}% of open AR booked as cash`
 : 'Per-channel collection curve from Invoice Tracker')
 + ` · PLUS the lagged ${100 - +sameWeekPct}% of new sales that don't collect the same week (they age into AR and collect later)`,
 values: nonGelatoArCollections,
 breakdown: ltBreakdown,
 },
 {
 label: 'Sales (this week, forecast)',
 source: salesGrossSource,
 note: `Gross Little Tree (wholesale) sales forecast for the week (reference only - NOT added to cash). The cash from these sales shows up as "Collected from sales" (same week) + "Past AR Collections" (the rest, later).`,
 values: salesGrossWeekly,
 displayOnly: true,
 breakdown: projBreakdown,
 },
 {
 label: 'Collected from sales (this week)',
 source: projectedSalesSource,
 note: `Same-week cash only: ${sameWeekPct}% of new sales collect the week they're invoiced (from paid history). The other ${100 - +sameWeekPct}% collects later and is shown in Past AR Collections above.`,
 values: projectedSalesWeekly,
 breakdown: projBreakdown,
 },
 ];

 const outflows: CashflowLine[] = [
 {
 label: 'Inventory & Raw Materials',
 source: opexSource,
 note: invMonthlyAvg > 0
 ? `Recent 3-mo run-rate $${Math.round(invMonthlyAvg).toLocaleString()}/mo · back-loaded within the month (real purchase timing 18/26/26/30% by week)`
 : 'No inventory data',
 values: invByWeek,
 breakdown: invBreakdown,
 },
 {
 label: 'Payroll',
 source: payrollSource,
 note: payrollMonthlyAvg > 0
 ? `Recent 3-mo run-rate $${Math.round(payrollMonthlyAvg).toLocaleString()}/mo · bi-weekly cadence (assumed - confirm via QB pay dates)`
 : 'No payroll data',
 values: payrollByWeek,
 breakdown: payrollBreakdown,
 },
 {
 label: 'Software & Subscriptions',
 source: opexSource,
 note: subsMonthlyAvg > 0
 ? `Recent 3-mo run-rate $${Math.round(subsMonthlyAvg).toLocaleString()}/mo · spread evenly`
 : 'No subscriptions data',
 values: subsByWeek,
 breakdown: subsBreakdown,
 },
 {
 label: 'Other Expenses',
 source: opexSource,
 note: otherMonthlyAvg > 0 || rentMonthly > 0
 ? `Recent 3-mo run-rate · Rent $${Math.round(rentMonthly).toLocaleString()}/mo lumped on the 1st, other categories ($${Math.round(otherMonthlyAvg).toLocaleString()}/mo) spread evenly`
 : 'No other-expense data',
 values: otherByWeek,
 breakdown: otherBreakdown,
 },
 {
 label: `Credit Card Payments`,
 source: ccScheduleSource,
 note: ccPayments.length > 0
 ? `Per-card schedule · ${ccPayments.length} payments across ${ccByWeek.filter((v) => v > 0).length} weeks · total $${Math.round(ccByWeek.reduce((s, v) => s + v, 0)).toLocaleString()}`
 : `No CC schedule (Tiller CC total: $${Math.round(ccPayoff).toLocaleString()})`,
 values: ccByWeek,
 breakdown: ccBreakdown,
 },
 ];

 // 6. Totals + closing.
 const sum = (cols: number[][], wIdx: number) => cols.reduce((s, c) => s + (c[wIdx] ?? 0), 0);

 // (Auto CC-utilisation shortfall engine removed - no CC draws/repayments are
 // synthesised; closing cash below reflects the real position.)

 // Exclude display-only rows (e.g. gross "Sales (this week)") from the cash
 // total - their cash is already counted via the collection rows.
 const totalInflows = weeks.map((_, i) => sum(inflows.filter((l) => !l.displayOnly).map((l) => l.values), i));
 const totalOutflows = weeks.map((_, i) => sum(outflows.map((l) => l.values), i));
 const netChange = weeks.map((_, i) => totalInflows[i] - totalOutflows[i]);

 const openingCash: number[] = [];
 const closingCash: number[] = [];
 let prevClosing = openingCashWk1;
 for (let i = 0; i < WEEKS; i++) {
 openingCash.push(prevClosing);
 const closing = prevClosing + netChange[i];
 closingCash.push(closing);
 prevClosing = closing;
 }
 const status = closingCash.map(classifyStatus);

 // Lazy snapshot capture (actual view, future direction only): record this
 // Monday's plan so the Past Weeks view can later compute variance vs
 // actuals. Idempotent per Monday - second call same day is a no-op.
 if (opts.direction !== 'past') {
 try {
 const snap: WeeklySnapshot = {
 monday: ymd(ANCHOR),
 capturedAt: new Date().toISOString(),
 openingCash: openingCashWk1,
 inflows: inflows.map((l) => ({
 label: l.label,
 wk1Value: l.values[0] ?? 0,
 total13w: l.values.reduce((s, v) => s + v, 0),
 })),
 outflows: outflows.map((l) => ({
 label: l.label,
 wk1Value: l.values[0] ?? 0,
 total13w: l.values.reduce((s, v) => s + v, 0),
 })),
 totalInflowWk1: totalInflows[0] ?? 0,
 totalOutflowWk1: totalOutflows[0] ?? 0,
 netChangeWk1: netChange[0] ?? 0,
 closingCashWk1: closingCash[0] ?? 0,
 arProjection13wTotal: arProjection?.arByWeek.reduce((s, v) => s + v, 0) ?? 0,
 salesForecastWk1: salesForecast?.weeklyInflow[0] ?? 0,
 salesForecast13wTotal: salesForecast?.totalProjectedCash ?? 0,
 };
 await captureSnapshotIfNeeded(snap);
 } catch (e) {
 warnings.push(`Snapshot capture failed (${e instanceof Error ? e.message : '?'}).`);
 }
 }

 // For 'past' direction, reverse the WEEK ORDER so the most-recent closed
 // week appears as Wk 1 (left-most) rather than the 13-weeks-ago week. User
 // mental model for Past Weeks is "starting from now, look back" not
 // "starting 13 weeks ago, march forward". Internal computations (snapshots,
 // AR placement etc.) all ran chronologically above; only the output arrays
 // get reversed here at the API boundary so the UI shows most-recent-first.
 const reverseForPast = opts.direction === 'past';
 const rev = <T,>(arr: T[]): T[] => reverseForPast ? [...arr].reverse() : arr;
 const outWeeks = rev(weeks);
 const outInflows: CashflowLine[] = inflows.map((l) => ({ ...l, values: rev(l.values) }));
 const outOutflows: CashflowLine[] = outflows.map((l) => ({ ...l, values: rev(l.values) }));
 const outArProjection = arProjection && reverseForPast
   ? { ...arProjection, arByWeek: [...arProjection.arByWeek].reverse() }
   : arProjection;
 const outSalesForecast = salesForecast && reverseForPast
   ? {
       ...salesForecast,
       weeklyInflow:    [...salesForecast.weeklyInflow].reverse(),
       weeklyInflowV2:  [...salesForecast.weeklyInflowV2].reverse(),
       weeklyInflowBest:  [...salesForecast.weeklyInflowBest].reverse(),
       weeklyInflowWorst: [...salesForecast.weeklyInflowWorst].reverse(),
     }
   : salesForecast;

 return {
 asOf: new Date().toISOString(),
 anchor: ymd(ANCHOR),
 weeks: outWeeks,
 openingCashWk1,
 openingCashSource,
 bankCashWk1,
 openingCashNote,
 openingCashBreakdown: openingGelatoBreakdown,
 inflows: outInflows,
 outflows: outOutflows,
 ccPayments,
 arProjection: outArProjection,
 salesForecast: outSalesForecast,
 totals: {
 inflows: rev(totalInflows),
 outflows: rev(totalOutflows),
 netChange: rev(netChange),
 openingCash: rev(openingCash),
 closingCash: rev(closingCash),
 status: rev(status),
 },
 assumptions: {
 ccPayoffWk1: ccPayoff,
 payrollPerWeek: payrollWeekly,
 inventoryPerWeek: invWeekly,
 otherPerWeek: otherWeekly,
 },
 warnings,
 };
}
