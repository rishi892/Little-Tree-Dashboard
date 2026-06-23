/**
 * Month-by-month expense projection - replaces flat L3M ÷ 4.33 averaging
 * with a smarter per-category breakdown that distinguishes recurring spend
 * from one-time charges.
 *
 * Algorithm:
 * 1. Pull last 12 months expense detail from QB (via getExpenseDetail).
 * 2. For each P&L account, count how many of the last 12 months had spend.
 * - Recurring threshold: present in >= 6 of last 12 months (50%+)
 * - Otherwise classified as one-time / sporadic.
 * 3. Roll up per category group (Payroll / Inventory / Subscriptions /
 * Other) using only the RECURRING portion of accounts for the forward
 * projection. One-time amounts are excluded from the forward run-rate
 * (they happened in the past but won't necessarily repeat).
 * 4. Compute per-month projected spend (last 3-month avg of recurring
 * portion) and distribute as `monthly_amount / weeks_in_month` to each
 * week within the projection window.
 *
 * Returns weekly arrays for Payroll, Inventory, Other (Subscriptions is
 * already handled separately via the subscription audit).
 */

import { getExpenseDetail, type ExpenseDetailRow } from './expenseDetail.js';

type Week = { start: string; end: string };

const RECURRING_MONTH_THRESHOLD = 6; // ≥ 6 of 12 months → recurring
const FORWARD_AVG_MONTHS = 3; // forward run-rate = last 3 months avg

export type ExpenseAccountClassification = {
 account: string;
 group: 'Payroll' | 'Non-Payroll';
 total: number;
 monthsWithSpend: number;
 classification: 'recurring' | 'one-time';
 /** Last 3-month avg amount (USD/month) - what gets carried forward. */
 forwardMonthly: number;
};

export type ExpenseProjectionResult = {
 payrollByWeek: number[];
 inventoryByWeek: number[];
 otherByWeek: number[];
 /** Total monthly run-rate (recurring only) for each group. */
 monthlyRunRate: { payroll: number; inventory: number; other: number };
 /** Classification per account for transparency. */
 classifications: ExpenseAccountClassification[];
 warnings: string[];
};

// --- Date helpers ---

function daysInMonth(year: number, month: number): number {
 return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function isInventoryAccount(name: string): boolean {
 return /^inventory|raw material|supplies\s*&\s*materials|^materials\b|cogs/i.test(name);
}

function isSubscriptionAccount(name: string): boolean {
 return /software\s*&\s*apps|^software\b|membership|subscription|r&d apps/i.test(name);
}

/**
 * Distribute a monthly amount across the weeks of that month proportionally
 * to how many days of each week fall within the month. Returns a number[]
 * sized to `weeks` (zero outside the month).
 */
function spreadMonthlyToWeeks(monthlyAmount: number, year: number, month: number, weeks: Week[]): number[] {
 const out = new Array(weeks.length).fill(0);
 if (monthlyAmount === 0) return out;
 const monthStart = new Date(Date.UTC(year, month, 1));
 const monthEnd = new Date(Date.UTC(year, month, daysInMonth(year, month), 23, 59, 59));
 // Calc days-of-month-in-week for each week, then distribute proportionally.
 const daysPerWeek: number[] = [];
 let totalDaysInMonth = 0;
 for (const w of weeks) {
 const ws = new Date(w.start + 'T00:00:00Z');
 const we = new Date(w.end + 'T23:59:59Z');
 const overlapStart = ws > monthStart ? ws : monthStart;
 const overlapEnd = we < monthEnd ? we : monthEnd;
 const overlapMs = overlapEnd.getTime() - overlapStart.getTime();
 const days = overlapMs > 0 ? Math.round(overlapMs / 86400000) + 1 : 0;
 daysPerWeek.push(Math.max(0, days));
 totalDaysInMonth += Math.max(0, days);
 }
 if (totalDaysInMonth === 0) return out;
 for (let i = 0; i < weeks.length; i++) {
 out[i] = (monthlyAmount * daysPerWeek[i]) / totalDaysInMonth;
 }
 return out;
}

// --- Main ---

export async function getExpenseProjection(weeks: Week[]): Promise<ExpenseProjectionResult> {
 const warnings: string[] = [];
 const result: ExpenseProjectionResult = {
 payrollByWeek: new Array(weeks.length).fill(0),
 inventoryByWeek: new Array(weeks.length).fill(0),
 otherByWeek: new Array(weeks.length).fill(0),
 monthlyRunRate: { payroll: 0, inventory: 0, other: 0 },
 classifications: [],
 warnings,
 };

 if (weeks.length === 0) return result;

 let detail;
 try {
 detail = await getExpenseDetail();
 } catch (e) {
 warnings.push(`Expense detail fetch failed (${e instanceof Error ? e.message : '?'}) - expense projection = 0.`);
 return result;
 }

 // 1. Classify each account: recurring (>= 6 months with spend) vs one-time.
 const rows = detail.rows ?? [];
 for (const r of rows) {
 const monthly = r.monthly ?? [];
 const monthsWithSpend = monthly.filter((v) => v > 0).length;
 const total = monthly.reduce((s, v) => s + v, 0);
 if (total === 0) continue;

 const classification: 'recurring' | 'one-time' =
 monthsWithSpend >= RECURRING_MONTH_THRESHOLD ? 'recurring' : 'one-time';

 // Forward monthly = avg of last FORWARD_AVG_MONTHS months that had spend
 // (only for recurring accounts; one-time → 0 forward projection).
 let forwardMonthly = 0;
 if (classification === 'recurring' && monthly.length > 0) {
 const lastN = monthly.slice(-FORWARD_AVG_MONTHS);
 forwardMonthly = lastN.reduce((s, v) => s + v, 0) / lastN.length;
 }

 result.classifications.push({
 account: r.category,
 group: r.group,
 total,
 monthsWithSpend,
 classification,
 forwardMonthly,
 });
 }

 // 2. Roll up monthly run-rate per group, excluding subscriptions (those are
 // projected separately) and excluding inventory which goes to its own row.
 let payrollMonthly = 0;
 let inventoryMonthly = 0;
 let otherMonthly = 0;
 for (const c of result.classifications) {
 if (c.forwardMonthly <= 0) continue;
 if (c.group === 'Payroll') {
 payrollMonthly += c.forwardMonthly;
 } else if (isInventoryAccount(c.account)) {
 inventoryMonthly += c.forwardMonthly;
 } else if (isSubscriptionAccount(c.account)) {
 // Skip - handled by subscription audit elsewhere in cashflow13.
 continue;
 } else {
 otherMonthly += c.forwardMonthly;
 }
 }
 result.monthlyRunRate = {
 payroll: payrollMonthly,
 inventory: inventoryMonthly,
 other: otherMonthly,
 };

 // 3. Distribute each month's amount across weeks proportionally.
 // Find every (year, month) touched by the projection window.
 const monthsTouched = new Set<string>();
 for (const w of weeks) {
 const ws = new Date(w.start + 'T00:00:00Z');
 const we = new Date(w.end + 'T23:59:59Z');
 let cur = new Date(Date.UTC(ws.getUTCFullYear(), ws.getUTCMonth(), 1));
 while (cur <= we) {
 monthsTouched.add(`${cur.getUTCFullYear()}-${cur.getUTCMonth()}`);
 cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
 }
 }
 for (const key of monthsTouched) {
 const [yStr, mStr] = key.split('-');
 const y = Number(yStr), m = Number(mStr);
 const p = spreadMonthlyToWeeks(payrollMonthly, y, m, weeks);
 const inv = spreadMonthlyToWeeks(inventoryMonthly, y, m, weeks);
 const oth = spreadMonthlyToWeeks(otherMonthly, y, m, weeks);
 for (let i = 0; i < weeks.length; i++) {
 result.payrollByWeek[i] += p[i];
 result.inventoryByWeek[i] += inv[i];
 result.otherByWeek[i] += oth[i];
 }
 }

 // Round.
 for (let i = 0; i < weeks.length; i++) {
 result.payrollByWeek[i] = +result.payrollByWeek[i].toFixed(2);
 result.inventoryByWeek[i] = +result.inventoryByWeek[i].toFixed(2);
 result.otherByWeek[i] = +result.otherByWeek[i].toFixed(2);
 }

 return result;
}
