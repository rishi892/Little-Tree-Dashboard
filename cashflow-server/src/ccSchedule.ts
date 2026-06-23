/**
 * Credit Card Payment Schedule - per-card due dates for the 13-week cashflow.
 *
 * Each card's next-payment date comes from the live Tiller "CC Schedule" tab
 * (real statement payment dates). If the sheet is blank or unavailable, we
 * fall back to the hardcoded per-card cycle (paymentDay + closingDay) in
 * ccTillerSchedule.ts which computes the next occurrence relative to today.
 *
 * Card amounts come from live Tiller balances (creditCards + loans buckets).
 * The current balance is paid ONCE at the card's next-payment date inside the
 * 13-week window. If that date falls before Wk 1 starts, the balance lands in
 * Wk 1 as "overdue". Citi cards have no real statement schedule and are
 * excluded.
 *
 * Months 2+ payments are not generated here - projected new charges land via
 * the "CC Utilisation" inflow (smart-CC auto algorithm), which then schedules
 * its own next-cycle payback at the card's following payment date.
 */

import { getTillerBalances, type TillerAccount } from './tiller.js';
import {
 getCcTillerSchedule,
 findScheduleRow,
 getHardcodedScheduleFor,
 type CcStatementRow,
} from './ccTillerSchedule.js';

export type CcScheduledPayment = {
 cardLabel: string;
 amount: number;
 dueDate: string; // YYYY-MM-DD
 matchedTillerName?: string;
};

const CITI_RE = /citi/i;

function parseMDY(s: string | null | undefined): Date | null {
 if (!s) return null;
 const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
 if (!m) return null;
 const [, mo, da, yr] = m;
 return new Date(Date.UTC(parseInt(yr, 10), parseInt(mo, 10) - 1, parseInt(da, 10)));
}

function ymd(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Resolve the next-payment Date for a Tiller cardish account. Order:
 * 1. Live "CC Schedule" sheet "Next Payment" column.
 * 2. Hardcoded per-card cycle (rolling next occurrence relative to today).
 * 3. null if neither matches (caller decides what to do).
 */
function resolveNextPaymentDate(
 account: TillerAccount,
 schedule: CcStatementRow[],
): { date: Date | null; source: 'sheet' | 'hardcoded' | 'none' } {
 if (schedule.length > 0) {
 const cleanName = account.name.split(/[\(·・]/)[0].trim();
 if (cleanName) {
 const pat = new RegExp(cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
 const row = findScheduleRow(schedule, pat);
 const d = parseMDY(row?.nextPayment ?? null);
 if (d) return { date: d, source: 'sheet' };
 }
 }
 const hard = getHardcodedScheduleFor(account.name);
 const d = parseMDY(hard?.nextPayment ?? null);
 if (d) return { date: d, source: 'hardcoded' };
 return { date: null, source: 'none' };
}

export async function getCcPaymentSchedule(
 weeks: Array<{ start: string; end: string }>,
): Promise<{ byWeek: number[]; payments: CcScheduledPayment[]; warnings: string[] }> {
 const byWeek = new Array(weeks.length).fill(0);
 const payments: CcScheduledPayment[] = [];
 const warnings: string[] = [];

 if (weeks.length === 0) return { byWeek, payments, warnings };

 const windowStart = new Date(weeks[0].start + 'T00:00:00Z');
 const windowEnd = new Date(weeks[weeks.length - 1].end + 'T23:59:59Z');

 function weekIndexFor(date: Date): number {
 for (let i = 0; i < weeks.length; i++) {
 const ws = new Date(weeks[i].start + 'T00:00:00Z');
 const we = new Date(weeks[i].end + 'T23:59:59Z');
 if (date >= ws && date <= we) return i;
 }
 return -1;
 }

 let tiller;
 try {
 tiller = await getTillerBalances();
 } catch (e) {
 warnings.push(`Tiller fetch failed (${e instanceof Error ? e.message : '?'}) - CC schedule = 0.`);
 return { byWeek, payments, warnings };
 }

 const schedule = await getCcTillerSchedule().catch(() => [] as CcStatementRow[]);

 // creditCards + loans - MC Consumer 4362 is bucketed as a loan but pays like a CC.
 const allCardish = [...tiller.creditCards, ...tiller.loans];

 for (const account of allCardish) {
 if (CITI_RE.test(account.name)) continue; // Citi has no real schedule.
 const balance = Math.abs(account.balance);
 if (balance === 0) continue;

 const { date: nextPay, source } = resolveNextPaymentDate(account, schedule);
 if (!nextPay) {
 warnings.push(`No payment date for "${account.name}" - skipped.`);
 continue;
 }

 if (nextPay > windowEnd) continue; // payment due beyond 13-week window - ignore.

 if (nextPay < windowStart) {
 // Overdue → bucket to Wk 1.
 byWeek[0] += balance;
 payments.push({ cardLabel: account.name, amount: balance, dueDate: ymd(nextPay), matchedTillerName: account.name });
 continue;
 }

 const idx = weekIndexFor(nextPay);
 if (idx < 0) {
 warnings.push(`Payment date ${ymd(nextPay)} for "${account.name}" not in any week (skipped).`);
 continue;
 }
 byWeek[idx] += balance;
 payments.push({ cardLabel: account.name, amount: balance, dueDate: ymd(nextPay), matchedTillerName: account.name });
 if (source === 'hardcoded') {
 // Optional debug breadcrumb (silent - no warning) when we fall back.
 }
 }

 return { byWeek, payments, warnings };
}
