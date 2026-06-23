/**
 * Weekly ACTUALS that the live cashflow recompute can't give for past weeks:
 *
 *  1. getWeekExpensesByLine - actual EXPENSES for a closed week, pulled from
 *     QuickBooks (P&L, Cash basis) and bucketed into the same outflow lines the
 *     13-week budget uses (Payroll / Inventory & Raw Materials / Software &
 *     Subscriptions / Other Expenses). Lets the Actual tab show real per-line
 *     spend instead of "entry yet to be done".
 *
 *  2. getExpectedInflowByWeek - the EXPECTED collection schedule for a set of
 *     weeks, computed live from invoice terms (Gelato issue + Net 97, other AR
 *     issue + Net 90). Lets the Past tab show an inflow plan even for weeks that
 *     have no captured snapshot.
 */

import { QBO_API_BASE } from './config.js';
import { qboFetch } from './qbHttp.js';
import { getValidAccessToken } from './oauth.js';
import { withDurableCache } from './qbCache.js';
import { getGelatoAr } from './gelatoAr.js';
import { getArOpen } from './ar.js';

// --- 1. Weekly QB expenses by budget line ---------------------------------

export type WeekExpenseLines = {
  weekStart: string;
  weekEnd: string;
  byLine: Record<BudgetOutLine, number>;
  total: number;
};

export type BudgetOutLine =
  | 'Payroll'
  | 'Inventory & Raw Materials'
  | 'Software & Subscriptions'
  | 'Other Expenses';

const PAYROLL_KW = [
  'payroll', 'salary', 'salaries', 'wage', 'wages', 'compensation', 'gusto',
  'contractor', 'contractors', 'fiverr', 'upwork', 'cost of labor', 'cost of labour',
  'production payroll', 'remuneration', 'team costs', 'employer payroll', 'employee welfare',
];

/** Map a P&L leaf (account name + its ancestor section names) to a budget line. */
function classifyBudgetLine(leafName: string, ancestors: string[]): BudgetOutLine {
  const leaf = leafName.toLowerCase();
  const hay = `${leaf} ${ancestors.join(' ').toLowerCase()}`;
  // Payroll catches employee-name leaves via their parent section
  // ("Cost of labor - COGS", "Payroll & Team costs", ...).
  if (PAYROLL_KW.some((k) => hay.includes(k))) return 'Payroll';
  if (/supplies\s*&\s*materials|raw material|^inventory|inventory asset/.test(leaf)) return 'Inventory & Raw Materials';
  if (/software|subscription|saas/.test(leaf)) return 'Software & Subscriptions';
  return 'Other Expenses';
}

type PlNode = {
  Header?: { ColData?: Array<{ value?: string }> };
  ColData?: Array<{ value?: string }>;
  Rows?: { Row?: PlNode[] };
  Summary?: unknown;
};

/** Walk a single-column (Total) P&L report, returning every leaf account with
 *  its amount and the chain of section names above it. */
function walkPlLeaves(report: { Columns?: { Column: unknown[] }; Rows?: { Row?: PlNode[] } }): Array<{ name: string; amount: number; ancestors: string[] }> {
  const totalIdx = Math.max((report.Columns?.Column?.length ?? 2) - 1, 1); // last column = Total
  const out: Array<{ name: string; amount: number; ancestors: string[] }> = [];
  const walk = (rows: PlNode[], ancestors: string[]) => {
    for (const row of rows) {
      const hasChildren = (row.Rows?.Row?.length ?? 0) > 0;
      const sectionName = row.Header?.ColData?.[0]?.value ?? '';
      if (hasChildren) {
        walk(row.Rows!.Row!, sectionName ? [...ancestors, sectionName] : ancestors);
      } else if (row.ColData) {
        const name = row.ColData[0]?.value ?? '';
        const amt = parseFloat(row.ColData[totalIdx]?.value ?? '0');
        if (name && Number.isFinite(amt) && amt !== 0) out.push({ name, amount: amt, ancestors });
      }
    }
  };
  walk(report.Rows?.Row ?? [], []);
  return out;
}

async function _weekExpensesUncached(weekStart: string, weekEnd: string): Promise<WeekExpenseLines> {
  const tok = await getValidAccessToken();
  const url = `${QBO_API_BASE}/v3/company/${tok.realmId}/reports/ProfitAndLoss`
    + `?start_date=${weekStart}&end_date=${weekEnd}&accounting_method=Cash&minorversion=70`;
  const res = await qboFetch(url, tok.accessToken);
  if (!res.ok) throw new Error(`QBO P&L ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const leaves = walkPlLeaves(json);
  const byLine: Record<BudgetOutLine, number> = {
    'Payroll': 0, 'Inventory & Raw Materials': 0, 'Software & Subscriptions': 0, 'Other Expenses': 0,
  };
  let total = 0;
  for (const lf of leaves) {
    // P&L expenses show as positive amounts under expense/COGS sections; income
    // sections also appear. Only count expense-side leaves (positive spend).
    // Income leaves live under sections whose name includes "income"/"revenue".
    const path = lf.ancestors.join(' ').toLowerCase();
    const isIncome = /income|revenue|sales of product/.test(path) && !/cost of/.test(path);
    if (isIncome) continue;
    const amt = Math.abs(lf.amount);
    if (amt === 0) continue;
    byLine[classifyBudgetLine(lf.name, lf.ancestors)] += amt;
    total += amt;
  }
  for (const k of Object.keys(byLine) as BudgetOutLine[]) byLine[k] = +byLine[k].toFixed(2);
  return { weekStart, weekEnd, byLine, total: +total.toFixed(2) };
}

/** Actual QB expenses for a (closed) week, bucketed into budget outflow lines.
 *  Durable-cached per week - closed weeks don't change. */
export async function getWeekExpensesByLine(weekStart: string, weekEnd: string): Promise<WeekExpenseLines> {
  const { data } = await withDurableCache(
    `week-expenses:${weekStart}`,
    24 * 60 * 60 * 1000, // 24h - a closed week's P&L is settled
    () => _weekExpensesUncached(weekStart, weekEnd),
    (d) => d.total >= 0, // any non-error result (even a $0 week) is cacheable
    false,
  );
  return data;
}

// --- 2. Expected inflow schedule for arbitrary weeks ----------------------

export type ExpectedInflowWeek = { gelato: number; other: number; total: number };

const GELATO_NET_DAYS = 97;  // Gelato Net 90 + 7-day buffer
const OTHER_NET_DAYS = 90;   // Other AR Net 90
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function addDays(d: Date, n: number): Date { const r = new Date(d); r.setUTCDate(d.getUTCDate() + n); return r; }
function parseGelatoIssue(period: string | undefined): Date | null {
  const m = (period ?? '').trim().toLowerCase().match(/([a-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const idx = MONTHS.indexOf(m[1]);
  if (idx < 0) return null;
  const issueMonth = idx + 1; // batch month + 1
  const year = Number(m[2]);
  return issueMonth > 11 ? new Date(Date.UTC(year + 1, 0, 1)) : new Date(Date.UTC(year, issueMonth, 1));
}
function parseAnyDate(s: string | undefined): Date | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(t + 'T00:00:00Z');
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) { const yr = m[3].length === 2 ? Number('20' + m[3]) : Number(m[3]); return new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2]))); }
  return null;
}

/** Expected AR collections per week, by invoice terms. weeks must be Mon-Sun
 *  ranges (start/end YYYY-MM-DD). Uses ALL Gelato invoices (pending + paid) so
 *  past weeks are covered, plus open non-Gelato AR. */
export async function getExpectedInflowByWeek(weeks: Array<{ start: string; end: string }>): Promise<ExpectedInflowWeek[]> {
  const out: ExpectedInflowWeek[] = weeks.map(() => ({ gelato: 0, other: 0, total: 0 }));
  const idxFor = (d: Date): number => {
    for (let i = 0; i < weeks.length; i++) {
      const ws = new Date(weeks[i].start + 'T00:00:00Z');
      const we = new Date(weeks[i].end + 'T23:59:59Z');
      if (d >= ws && d <= we) return i;
    }
    return -1;
  };
  try {
    const gelato = await getGelatoAr();
    for (const inv of [...gelato.pendingInvoices, ...gelato.paidInvoices]) {
      const issue = parseGelatoIssue(inv.period);
      if (!issue) continue;
      const i = idxFor(addDays(issue, GELATO_NET_DAYS));
      if (i >= 0) out[i].gelato += inv.amount;
    }
  } catch { /* gelato unavailable - skip */ }
  try {
    const ar = await getArOpen();
    for (const inv of ar.invoices) {
      if (/gelato/i.test(inv.customer) || /purex|intercompany/i.test(inv.customer)) continue;
      const issue = parseAnyDate(inv.date);
      if (!issue) continue;
      const i = idxFor(addDays(issue, OTHER_NET_DAYS));
      if (i >= 0) out[i].other += inv.openBalance;
    }
  } catch { /* AR unavailable - skip */ }
  return out.map((w) => ({ gelato: +w.gelato.toFixed(2), other: +w.other.toFixed(2), total: +(w.gelato + w.other).toFixed(2) }));
}
