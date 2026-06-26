/**
 * ACTUAL outflow for a calendar month, on the EXACT same basis as the 13-week
 * budget: QuickBooks Cash-basis P&L grouped by YOUR category mapping
 * (computePnlExpenses), bucketed into the SAME 7 outflow lines, plus the real
 * inventory-purchase trace for the Inventory line. No sheet anywhere - so budget
 * vs actual is ONE apples-to-apples QB basis, line for line.
 *
 *  - Settled month: each line = that month's P&L column (per your mapping);
 *    the per-account drill is the real QB accounts (Rishi, each COGS account...)
 *    that fed it. Settled QB cash P&L is a monthly aggregate, so account-level
 *    is the finest composition (no per-transaction dates) - EXCEPT the Inventory
 *    line, which drills to the real inventory bills (date · vendor · memo).
 *  - Current (in-progress) month: SAME source, but QB cash-basis lags (e.g. Moysh
 *    settles after month-end), so it reads partial month-to-date.
 */
import { getQbPlReport, getQbPlReportForMonth } from './qbPlReport.js';
import { loadOverrides } from './categoryOverrides.js';
import { computePnlExpenses } from './pnlExpenses.js';
import { getInventoryPurchases } from './inventoryPurchases.js';
import type { ExpenseEntryDetail } from './sheetExpenses.js';

// The SAME 7 outflow lines the 13-week budget uses (cashflow13.ts).
export const OUTFLOW_LINES = [
  'Inventory & Raw Materials',
  'COGS',
  'Payroll',
  'Software & Subscriptions',
  'Rent',
  'Other Expenses',
  'Credit Card Payments',
] as const;

// The SAME category -> line bucketing the budget's outflow uses (cashflow13.ts
// ~564-584). The 'Inventory & Raw Materials' LINE is fed by the inventory-
// purchase trace below, NOT a P&L category - so an "Inventory & Raw Materials"
// CATEGORY (P&L) rides the COGS line, exactly like the budget (no double-count).
function lineOfCategory(category: string): string {
  if (/^payroll$/i.test(category)) return 'Payroll';
  if (/^inventory\s*&\s*raw materials$|^cogs\b/i.test(category)) return 'COGS';
  if (/software\s*&\s*subscriptions/i.test(category)) return 'Software & Subscriptions';
  if (/rent|building lease/i.test(category)) return 'Rent';
  return 'Other Expenses';
}

export type CombinedActual = {
  month: string;
  isCurrentMonth: boolean;
  source: string;
  byLine: Record<string, number>;
  entries: ExpenseEntryDetail[];   // drill-down (per-account; Inventory = real bills)
};

export async function getCombinedActualForMonth(ym: string): Promise<CombinedActual> {
  const byLine: Record<string, number> = {};
  for (const l of OUTFLOW_LINES) byLine[l] = 0;
  const entries: ExpenseEntryDetail[] = [];

  const now = new Date();
  const currentYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const isCurrentMonth = ym === currentYm;

  // QB Cash-basis P&L, grouped by YOUR mapping - identical source to the budget.
  const [plReport, overrides] = await Promise.all([getQbPlReport('Cash'), loadOverrides()]);
  let pnl = computePnlExpenses(plReport, overrides);
  let idx = pnl.months.indexOf(ym);
  if (idx < 0) {
    // Not in the settled-months window = the current / in-progress month. Pull a
    // dedicated month-to-date QB P&L so the actual fills in from QB as it settles
    // (no sheet) - this is what makes "jo hua hai aur aage" keep appearing. A cold
    // QB hiccup here must NOT 500 the whole actual (the client retries/refetches),
    // so swallow it and return what we have - the next pull fills it in.
    try {
      const monthReport = await getQbPlReportForMonth(ym, 'Cash');
      pnl = computePnlExpenses(monthReport, overrides);
      idx = pnl.months.indexOf(ym);
    } catch { /* leave byLine at 0; client retry / next focus fills it in */ }
  }

  if (idx >= 0) {
    for (const cat of pnl.categories) {
      const v = cat.monthly[idx] ?? 0;
      if (Math.round(v) === 0) continue;
      const line = lineOfCategory(cat.category);
      byLine[line] = +(byLine[line] + v).toFixed(2);
      // Drill = the real QB accounts behind the line (per-account month value).
      for (const acc of cat.accounts) {
        const av = acc.monthly[idx] ?? 0;
        if (Math.round(av) !== 0) {
          entries.push({ date: '', description: acc.name, amount: +av.toFixed(2), category: cat.category, line });
        }
      }
    }
  }

  // Inventory & Raw Materials line = real inventory purchases that month (QB bills
  // hitting the inventory asset), the SAME source as the budget's line - and the
  // bills carry dates/vendors so this line drills to real transactions.
  try {
    const inv = await getInventoryPurchases();
    const invTxns = (inv.transactions ?? []).filter((t) => (t.date ?? '').slice(0, 7) === ym);
    let invSum = 0;
    for (const t of invTxns) {
      invSum += t.amount;
      const desc = [t.vendor, t.memo].filter(Boolean).join(' · ') || t.txnType;
      entries.push({ date: t.date, description: desc, amount: +t.amount.toFixed(2), category: t.paidBy, line: 'Inventory & Raw Materials' });
    }
    byLine['Inventory & Raw Materials'] = +invSum.toFixed(2);
  } catch { /* leave Inventory at 0 */ }

  const source = isCurrentMonth
    ? 'QuickBooks Cash-basis P&L (your mapping) · month-to-date, settles after month-end'
    : 'QuickBooks Cash-basis P&L (your mapping) · same basis as budget · per-account';
  return { month: ym, isCurrentMonth, source, byLine, entries };
}
