/**
 * Monthly Expense Summary: LT vs PureX (per-month split).
 *
 * Mirrors the lender sheet's "Sheet 3a - Monthly Summary 2025" - every month
 * since Jan 2025 with: LT-direct OpEx, PureX-paid OpEx, Total, % splits, and
 * the cash PureX has remitted to LT that month (from Settlement History).
 *
 * Data sources (all from QB now - sheet retired for this view):
 * - LT / Moysh OpEx per month ← QB expense detail (Moysh + Other buckets)
 * - PureX OpEx per month ← QB expense detail (PureX bucket, identified
 * by the "PureX" source bank account)
 * - PureX remitted per month ← Settlement History (sum by month)
 */

import { getExpenseDetail } from './expenseDetail.js';
import { getSettlementHistory } from './settlementHistory.js';

export type MonthlyOpexRow = {
 monthKey: string; // YYYY-MM
 monthLabel: string; // "Jan 2025"
 ltDirect: number;
 purex: number;
 total: number;
 ltPct: number; // 0..1
 purexPct: number; // 0..1
 remitted: number; // PureX cash sent to LT this month
};

export type MonthlyOpexResult = {
 fetchedAt: string;
 rows: MonthlyOpexRow[];
 totals: {
 ltDirect: number;
 purex: number;
 total: number;
 ltPct: number;
 purexPct: number;
 remitted: number;
 };
 averages: {
 ltDirect: number;
 purex: number;
 total: number;
 remitted: number;
 };
 findings: string[]; // bullet-point textual summary
 warnings: string[];
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthKeyOf(date: Date): string {
 return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function getMonthlyOpex(): Promise<MonthlyOpexResult> {
 const warnings: string[] = [];

 // 1. QB expense detail (already anchored at Jan 2025). perEntity already
 // splits PureX vs Moysh by SOURCE BANK (the "PureX" bank account in QB =
 // PureX, everything else = Moysh), so we just sum the buckets below.
 const detail = await getExpenseDetail();

 // 2. Settlement history - group remittances by month.
 const remittedByMonth = new Map<string, number>();
 try {
 const sh = await getSettlementHistory();
 for (const s of sh.settlements) {
 const d = new Date(s.date + 'T00:00:00Z');
 const k = monthKeyOf(d);
 remittedByMonth.set(k, (remittedByMonth.get(k) ?? 0) + s.amount);
 }
 } catch (e) {
 warnings.push(`Settlement history unavailable (${e instanceof Error ? e.message : '?'}) - remitted column = 0.`);
 }

 // 3. Build per-month rows - both sides from QB perEntity.
 // LT/Moysh = perEntity.Moysh + perEntity.Other
 // PureX = perEntity.PureX (paid from the "PureX" bank account in QB)
 const rows: MonthlyOpexRow[] = [];
 for (let i = 0; i < detail.months.length; i++) {
 const monthKey = detail.months[i];
 const monthLabel = detail.monthLabels[i];
 let lt = 0;
 let px = 0;
 for (const r of detail.rows) {
 lt += (r.perEntity.Moysh[i] ?? 0) + (r.perEntity.Other[i] ?? 0);
 px += (r.perEntity.PureX[i] ?? 0);
 }
 const total = lt + px;
 rows.push({
 monthKey,
 monthLabel,
 ltDirect: +lt.toFixed(2),
 purex: +px.toFixed(2),
 total: +total.toFixed(2),
 ltPct: total ? +(lt / total).toFixed(4) : 0,
 purexPct: total ? +(px / total).toFixed(4) : 0,
 remitted: +(remittedByMonth.get(monthKey) ?? 0).toFixed(2),
 });
 }

 // 4. Totals + averages.
 const sum = (k: keyof MonthlyOpexRow) =>
 rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
 const totalLt = sum('ltDirect');
 const totalPx = sum('purex');
 const totalAll = totalLt + totalPx;
 const totalRem = sum('remitted');

 const n = Math.max(1, rows.length);
 const averages = {
 ltDirect: +(totalLt / n).toFixed(2),
 purex: +(totalPx / n).toFixed(2),
 total: +(totalAll / n).toFixed(2),
 remitted: +(totalRem / n).toFixed(2),
 };

 const totals = {
 ltDirect: +totalLt.toFixed(2),
 purex: +totalPx.toFixed(2),
 total: +totalAll.toFixed(2),
 ltPct: totalAll ? +(totalLt / totalAll).toFixed(4) : 0,
 purexPct: totalAll ? +(totalPx / totalAll).toFixed(4) : 0,
 remitted: +totalRem.toFixed(2),
 };

 // 5. Key findings (computed bullet points).
 const findings: string[] = [];
 if (totalAll > 0) {
 findings.push(
 `PureX paid ${(totals.purexPct * 100).toFixed(1)}% of Moysh's total operating expenses since Jan 2025`,
 );
 findings.push(
 `Moysh's TRUE direct cash OpEx averaged $${Math.round(averages.ltDirect).toLocaleString()}/month`,
 );
 findings.push(
 `PureX paid an average of $${Math.round(averages.purex).toLocaleString()}/month on Moysh's behalf`,
 );
 findings.push(
 `Combined OpEx run rate: $${Math.round(averages.total).toLocaleString()}/month ($${Math.round(averages.total * 12).toLocaleString()}/year)`,
 );
 }
 if (totalRem > 0) {
 findings.push(
 `PureX remitted $${Math.round(totalRem).toLocaleString()} to Moysh (avg $${Math.round(averages.remitted).toLocaleString()}/month) - difference accumulates as intercompany`,
 );
 }

 return {
 fetchedAt: new Date().toISOString(),
 rows,
 totals,
 averages,
 findings,
 warnings,
 };
}

export { MONTH_NAMES };
