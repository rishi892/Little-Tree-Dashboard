/**
 * Combined (PureX + Moysh) ACTUAL expense for a calendar month, on the SAME
 * basis as the 13-week outflow budget. Resolves the PureX/Moysh dedup correctly:
 *
 *  - COMPLETE months: read getMappedExpenses('Combined') - which is already
 *    deduped (QB Cash P&L per-bank perEntity split, with PureX payroll REPLACED
 *    by the sheet). This is exactly the budget's source, so budget vs actual are
 *    one basis. Never QB-range + full-sheet (that double-counts ~90%).
 *  - CURRENT (in-progress) month: the settled window excludes it. QB cash-basis
 *    lags for the current month and the PureX sheet leads (hand-entered as it
 *    happens), so show PureX live from the sheet; Moysh settles in QB later.
 */
import { getMappedExpenses } from './mappedExpenses.js';
import { getExpenseEntriesForRange, type ExpenseEntryDetail } from './sheetExpenses.js';

export const OUTFLOW_LINES = ['Payroll', 'Inventory & Raw Materials', 'Software & Subscriptions', 'Other Expenses'] as const;

// Same category → budget-line mapping the budget uses (cashflow13.ts ~514-533).
function lineOfRow(group: string, category: string): string {
  if (group === 'Payroll') return 'Payroll';
  if (/^inventory\s*&\s*raw materials$/i.test(category)) return 'Inventory & Raw Materials';
  if (/software\s*&\s*subscriptions/i.test(category)) return 'Software & Subscriptions';
  return 'Other Expenses';
}

export type CombinedActual = {
  month: string;
  isCurrentMonth: boolean;
  source: string;
  byLine: Record<string, number>;
  entries: ExpenseEntryDetail[];   // drill-down (current month = sheet entries)
};

export async function getCombinedActualForMonth(ym: string): Promise<CombinedActual> {
  const byLine: Record<string, number> = {};
  for (const l of OUTFLOW_LINES) byLine[l] = 0;

  const mapped = await getMappedExpenses('Combined');
  const idx = mapped.months.indexOf(ym);

  if (idx >= 0) {
    // Settled month — line totals AND drill both from the deduped Combined, so
    // the drill sums EXACTLY to the line. Drill = each QB category split by
    // entity (PureX / Moysh). QB's settled Combined is a monthly P&L aggregate,
    // so there is no per-transaction list here (dates live only on the current
    // month's live sheet) - the finest composition is category × entity.
    const entries: ExpenseEntryDetail[] = [];
    for (const row of mapped.rows) {
      const l = lineOfRow(row.group, row.category);
      byLine[l] = +(byLine[l] + (row.values?.[idx] ?? 0)).toFixed(2);
      const px = row.purexValues?.[idx] ?? 0;
      const mo = row.moyshValues?.[idx] ?? 0;
      if (Math.round(px) !== 0) entries.push({ date: '', description: row.category, amount: +px.toFixed(2), category: 'PureX', line: l });
      if (Math.round(mo) !== 0) entries.push({ date: '', description: row.category, amount: +mo.toFixed(2), category: 'Moysh', line: l });
    }
    return { month: ym, isCurrentMonth: false, source: 'Combined (PureX + Moysh) · category × entity from QB settled P&L (no per-transaction list for settled months)', byLine, entries };
  }

  // In-progress month — live PureX from the sheet; Moysh settles in QB later.
  const [y, m] = ym.split('-').map(Number);
  const now = new Date();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${ym}-${String(lastDay).padStart(2, '0')}`;
  const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  const end = today < monthEnd ? today : monthEnd;
  const px = await getExpenseEntriesForRange(`${ym}-01`, end);
  for (const l of OUTFLOW_LINES) byLine[l] = px.byLine[l]?.total ?? 0;
  const entries = Object.values(px.byLine).flatMap((v) => v.entries);
  return { month: ym, isCurrentMonth: true, source: 'PureX sheet (live) — Moysh settles in QB after month-end', byLine, entries };
}
