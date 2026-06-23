/**
 * Weekly Inflow Schedule - maps each receivable + PureX remittance to the
 * week we expect it to land. Feeds the "Customer AR Collections" row on the
 * 13-Week Cash Flow page and gives the lender a clear receivables forecast.
 *
 * Rolling: Week 1 = current ISO week's Monday.
 *
 * Live sources:
 * - Gelato AR sheet (one row per Pending invoice, placed at issue + 90 days)
 * - Broader AR sheet (other customers' open invoices, placed similarly)
 * - Settlement History (avg monthly settlement → Wk 1 PureX lump forecast)
 */

import { getGelatoAr, type GelatoInvoice } from './gelatoAr.js';
import { getArOpen } from './ar.js';
import { getSettlementHistory } from './settlementHistory.js';

const WEEKS = 13;
const NET_TERMS_DAYS = 97; // Gelato Net 90 + 7-day payment processing buffer

export type InflowWeek = { label: string; start: string; end: string };
export type InflowSource = 'gelato' | 'other-ar' | 'purex';

export type InflowRow = {
 source: string; // display label
 category: InflowSource;
 gross: number; // sum of values OR underlying invoice amount
 values: number[]; // length = WEEKS
 note?: string;
};

export type InflowScheduleResult = {
 fetchedAt: string;
 anchor: string; // YYYY-MM-DD of Wk 1 Monday
 weeks: InflowWeek[];
 rows: InflowRow[];
 weeklyTotals: number[];
 grandTotal: number;
 warnings: string[];
};

// --- Date helpers ---

function thisWeekMonday(): Date {
 const now = new Date();
 const day = now.getUTCDay();
 const sinceMonday = (day + 6) % 7;
 return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday));
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
function buildWeeks(start: Date, count: number): InflowWeek[] {
 const w: InflowWeek[] = [];
 for (let i = 0; i < count; i++) {
 const ws = addDays(start, i * 7);
 const we = addDays(ws, 6);
 w.push({ label: fmtMMDD(ws), start: ymd(ws), end: ymd(we) });
 }
 return w;
}
function weekIndexFor(date: Date, weeks: InflowWeek[]): number {
 for (let i = 0; i < weeks.length; i++) {
 const ws = new Date(weeks[i].start + 'T00:00:00Z');
 const we = new Date(weeks[i].end + 'T23:59:59Z');
 if (date >= ws && date <= we) return i;
 }
 return -1;
}

function parseDateAny(s: string): Date | null {
 const t = (s ?? '').trim();
 if (!t) return null;
 if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(t + 'T00:00:00Z');
 const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
 if (m) {
 const yr = m[3].length === 2 ? Number('20' + m[3]) : Number(m[3]);
 return new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2])));
 }
 return null;
}

/** Gelato period "January 2026" → issue date Feb 1, 2026 (batch + 1mo). */
function parseGelatoIssueDate(inv: GelatoInvoice): Date | null {
 const t = (inv.period ?? '').trim();
 if (!t) return null;
 const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
 const m = t.toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
 if (m) {
 const monthIdx = months.indexOf(m[1]);
 if (monthIdx >= 0) {
 const issueMonth = monthIdx + 1;
 const year = Number(m[2]);
 if (issueMonth > 11) return new Date(Date.UTC(year + 1, 0, 1));
 return new Date(Date.UTC(year, issueMonth, 1));
 }
 }
 return null;
}

function deriveGelatoLabel(inv: GelatoInvoice): string {
 const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
 const m = (inv.period ?? '').toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
 if (m) {
 const monthIdx = months.indexOf(m[1]);
 if (monthIdx >= 0) {
 const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][monthIdx];
 return `Gelato ${monthShort} invoice`;
 }
 }
 return `Gelato ${inv.period} invoice`;
}

// --- Main ---

export async function getInflowSchedule(): Promise<InflowScheduleResult> {
 const ANCHOR = thisWeekMonday();
 const weeks = buildWeeks(ANCHOR, WEEKS);
 const warnings: string[] = [];
 const rows: InflowRow[] = [];

 // 1. Each Gelato Pending invoice → one row, placed at issue + 90 days.
 try {
 const gelato = await getGelatoAr();
 for (const inv of gelato.pendingInvoices) {
 const issue = parseGelatoIssueDate(inv);
 const expected = issue ? addDays(issue, NET_TERMS_DAYS) : ANCHOR;
 let weekIdx = weekIndexFor(expected, weeks);
 if (weekIdx < 0 && expected < ANCHOR) weekIdx = 0; // already overdue → Wk 1
 const values = new Array(WEEKS).fill(0);
 if (weekIdx >= 0) values[weekIdx] = inv.amount;
 rows.push({
 source: deriveGelatoLabel(inv),
 category: 'gelato',
 gross: inv.amount,
 values,
 note: issue ? `Issue ${ymd(issue)} + Net ${NET_TERMS_DAYS} → ${ymd(expected)}` : 'Issue date unknown',
 });
 }
 } catch (e) {
 warnings.push(`Gelato fetch failed: ${e instanceof Error ? e.message : '?'}`);
 }

 // 2. Other AR - each open invoice placed at issue + 90 days, then summed.
 let otherTotal = 0;
 const otherValues = new Array(WEEKS).fill(0);
 let otherCount = 0;
 try {
 const arOpen = await getArOpen();
 for (const inv of arOpen.invoices) {
 // Skip Gelato (already counted above) and PureX intercompany invoices.
 if (/gelato/i.test(inv.customer) || /purex|intercompany/i.test(inv.customer)) continue;
 const issue = parseDateAny(inv.date);
 const expected = issue ? addDays(issue, NET_TERMS_DAYS) : ANCHOR;
 let weekIdx = weekIndexFor(expected, weeks);
 if (weekIdx < 0 && expected < ANCHOR) weekIdx = 0; // overdue → Wk 1
 if (weekIdx >= 0) {
 otherValues[weekIdx] += inv.openBalance;
 otherTotal += inv.openBalance;
 otherCount++;
 }
 }
 } catch (e) {
 warnings.push(`AR open fetch failed: ${e instanceof Error ? e.message : '?'}`);
 }
 if (otherTotal > 0) {
 rows.push({
 source: 'LT other AR (Little Tree customers)',
 category: 'other-ar',
 gross: +otherTotal.toFixed(2),
 values: otherValues.map((v) => +v.toFixed(2)),
 note: `${otherCount} open invoices placed at issue + Net ${NET_TERMS_DAYS}`,
 });
 }

 // 3. PureX Wk 1 lump - use avg monthly settlement (live) as forecast.
 let purexWk1 = 0;
 try {
 const sh = await getSettlementHistory();
 purexWk1 = sh.derived.avgMonthlySettlement;
 } catch (e) {
 warnings.push(`Settlement history fetch failed: ${e instanceof Error ? e.message : '?'} - PureX Wk 1 = 0`);
 }
 if (purexWk1 > 0) {
 const purexValues = new Array(WEEKS).fill(0);
 purexValues[0] = purexWk1;
 rows.push({
 source: 'PureX remittance (lump sum, this week)',
 category: 'purex',
 gross: +purexWk1.toFixed(2),
 values: purexValues,
 note: 'Avg monthly settlement from Settlement History',
 });
 }

 // 4. Totals.
 const weeklyTotals = weeks.map((_, i) => rows.reduce((s, r) => s + (r.values[i] ?? 0), 0));
 const grandTotal = +weeklyTotals.reduce((s, v) => s + v, 0).toFixed(2);

 return {
 fetchedAt: new Date().toISOString(),
 anchor: ymd(ANCHOR),
 weeks,
 rows,
 weeklyTotals: weeklyTotals.map((v) => +v.toFixed(2)),
 grandTotal,
 warnings,
 };
}
