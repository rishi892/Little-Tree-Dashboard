/**
 * Expenses straight from the QuickBooks P&L, grouped by YOUR category mapping.
 *
 * No sheet, no regex layout: every P&L expense account (detail rows under the
 * COGS + Expenses sections, skipping Income) is routed to the category you
 * picked in P&L Mapping (category_overrides). Unmapped accounts land in
 * "Uncategorized" so nothing is silently dropped. Pure function so it can run
 * off the already-cached P&L report + fresh overrides.
 */
import type { QbPlReport } from './qbPlReport.js';
import type { AllOverrides } from './categoryOverrides.js';

export type PnlExpenseAccount = { name: string; monthly: number[]; total: number };
export type PnlExpenseCategory = { category: string; monthly: number[]; total: number; accounts: PnlExpenseAccount[] };
export type PnlExpensesResult = {
  asOf: string;
  months: string[];
  monthLabels: string[];
  categories: PnlExpenseCategory[];
  mappedTotal: number;     // sum of all categories EXCEPT Uncategorized
  unmappedTotal: number;   // the Uncategorized bucket
  grandTotal: number;
};

export function computePnlExpenses(report: QbPlReport, overrides: AllOverrides): PnlExpensesResult {
  const n = report.months.length;
  const cats = new Map<string, PnlExpenseCategory>();

  let section = '';
  for (const r of report.rows) {
    if (r.kind === 'section' && r.depth === 0) section = r.name;
    if (r.kind !== 'detail' || !section || /income/i.test(section)) continue;

    const category = overrides[r.name]?.lineItem || 'Uncategorized';
    let c = cats.get(category);
    if (!c) { c = { category, monthly: new Array(n).fill(0), total: 0, accounts: [] }; cats.set(category, c); }

    const monthly = r.monthly ?? [];
    for (let i = 0; i < n; i++) c.monthly[i] += monthly[i] ?? 0;
    c.total += r.total;
    c.accounts.push({ name: r.name, monthly, total: r.total });
  }

  const categories = [...cats.values()];
  for (const c of categories) c.accounts.sort((a, b) => b.total - a.total);
  categories.sort((a, b) => b.total - a.total);

  const unmappedTotal = categories.find((c) => c.category === 'Uncategorized')?.total ?? 0;
  const grandTotal = categories.reduce((s, c) => s + c.total, 0);

  return {
    asOf: report.asOf,
    months: report.months,
    monthLabels: report.monthLabels,
    categories,
    mappedTotal: grandTotal - unmappedTotal,
    unmappedTotal,
    grandTotal,
  };
}
