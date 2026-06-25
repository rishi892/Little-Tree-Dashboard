/**
 * Weekly ACTUALS the live cashflow recompute can't give for past weeks:
 *
 *  1. getWeeklyExpensesForWeeks - actual EXPENSES per closed week, pulled from
 *     QuickBooks in ONE P&L report (Cash basis, summarize_column_by=Week) and
 *     bucketed into the same outflow lines the 13-week budget uses (Payroll /
 *     Inventory & Raw Materials / Software & Subscriptions / Other Expenses).
 *     One report for the whole window = fast + one token (per-week reports
 *     timed the serverless function out).
 *
 *  2. getExpectedInflowByWeek - the EXPECTED collection schedule for a set of
 *     weeks, computed live from invoice terms (Gelato issue + Net 97, other AR
 *     issue + Net 90). Lets the Past tab show an inflow plan even for weeks with
 *     no captured snapshot.
 */

import { QBO_API_BASE } from './config.js';
import { qboFetch } from './qbHttp.js';
import { getValidAccessToken } from './oauth.js';
import { withDurableCache } from './qbCache.js';
import { getGelatoAr } from './gelatoAr.js';
import { getArOpen } from './ar.js';

// --- 1. Weekly QB expenses by budget line ---------------------------------

export type BudgetOutLine =
  | 'Payroll'
  | 'Inventory & Raw Materials'
  | 'Software & Subscriptions'
  | 'Other Expenses';

export type WeekExpenseLines = {
  weekStart: string;
  weekEnd: string;
  byLine: Record<BudgetOutLine, number>;
  total: number;
};

const PAYROLL_KW = [
  'payroll', 'salary', 'salaries', 'wage', 'wages', 'compensation', 'gusto',
  'contractor', 'contractors', 'fiverr', 'upwork', 'cost of labor', 'cost of labour',
  'production payroll', 'remuneration', 'team costs', 'employer payroll', 'employee welfare',
];

function classifyBudgetLine(leafName: string, ancestors: string[]): BudgetOutLine {
  const leaf = leafName.toLowerCase();
  const hay = `${leaf} ${ancestors.join(' ').toLowerCase()}`;
  if (PAYROLL_KW.some((k) => hay.includes(k))) return 'Payroll';
  if (/supplies\s*&\s*materials|raw material|^inventory|inventory asset/.test(leaf)) return 'Inventory & Raw Materials';
  if (/software|subscription|saas/.test(leaf)) return 'Software & Subscriptions';
  return 'Other Expenses';
}

type PlCol = { ColTitle?: string; MetaData?: Array<{ Name?: string; Value?: string }> };
type PlNode = { Header?: { ColData?: Array<{ value?: string }> }; ColData?: Array<{ value?: string }>; Rows?: { Row?: PlNode[] } };

const emptyLines = (): Record<BudgetOutLine, number> => ({
  'Payroll': 0, 'Inventory & Raw Materials': 0, 'Software & Subscriptions': 0, 'Other Expenses': 0,
});

/** Parse a multi-column (summarize_column_by=Week) P&L into per-week lines,
 *  aligned to the caller's Mon-Sun weeks by each column's StartDate. */
function parseWeeklyPl(report: { Columns?: { Column?: PlCol[] }; Rows?: { Row?: PlNode[] } }, weeks: Array<{ start: string; end: string }>): WeekExpenseLines[] {
  const result: WeekExpenseLines[] = weeks.map((w) => ({ weekStart: w.start, weekEnd: w.end, byLine: emptyLines(), total: 0 }));
  const cols = report.Columns?.Column ?? [];
  // Period columns carry a StartDate in MetaData; the leading "" and trailing
  // "Total" columns don't. Map each period column to one of our weeks.
  const periods: Array<{ idx: number; week: number }> = [];
  cols.forEach((c, idx) => {
    const sd = (c.MetaData ?? []).find((m) => m.Name === 'StartDate')?.Value;
    if (!sd) return;
    const pd = new Date(sd + 'T00:00:00Z');
    const w = weeks.findIndex((wk) => {
      const ws = new Date(wk.start + 'T00:00:00Z');
      const we = new Date(wk.end + 'T23:59:59Z');
      return pd >= ws && pd <= we;
    });
    periods.push({ idx, week: w });
  });
  const walk = (rows: PlNode[], ancestors: string[]) => {
    for (const row of rows) {
      const hasChildren = (row.Rows?.Row?.length ?? 0) > 0;
      const section = row.Header?.ColData?.[0]?.value ?? '';
      if (hasChildren) {
        walk(row.Rows!.Row!, section ? [...ancestors, section] : ancestors);
      } else if (row.ColData) {
        const name = row.ColData[0]?.value ?? '';
        if (!name) continue;
        const path = ancestors.join(' ').toLowerCase();
        if (/income|revenue|sales of product/.test(path) && !/cost of/.test(path)) continue; // skip income side
        const line = classifyBudgetLine(name, ancestors);
        for (const p of periods) {
          if (p.week < 0) continue;
          const v = Math.abs(parseFloat(row.ColData[p.idx]?.value ?? '0'));
          if (Number.isFinite(v) && v !== 0) { result[p.week].byLine[line] += v; result[p.week].total += v; }
        }
      }
    }
  };
  walk(report.Rows?.Row ?? [], []);
  for (const r of result) {
    for (const k of Object.keys(r.byLine) as BudgetOutLine[]) r.byLine[k] = +r.byLine[k].toFixed(2);
    r.total = +r.total.toFixed(2);
  }
  return result;
}

async function _weeklyExpensesUncached(weeks: Array<{ start: string; end: string }>): Promise<WeekExpenseLines[]> {
  if (weeks.length === 0) return [];
  const sorted = [...weeks].sort((a, b) => a.start.localeCompare(b.start));
  const start = sorted[0].start;
  const end = sorted[sorted.length - 1].end;
  const tok = await getValidAccessToken();
  const url = `${QBO_API_BASE}/v3/company/${tok.realmId}/reports/ProfitAndLoss`
    + `?start_date=${start}&end_date=${end}&summarize_column_by=Week&accounting_method=Cash&minorversion=70`;
  const res = await qboFetch(url, tok.accessToken);
  if (!res.ok) throw new Error(`QBO weekly P&L ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return parseWeeklyPl(json, weeks);
}

/** Actual QB expenses per week for the given Mon-Sun weeks, bucketed into the
 *  budget outflow lines. ONE P&L report. Durable-cached by range (6h). */
export async function getWeeklyExpensesForWeeks(weeks: Array<{ start: string; end: string }>): Promise<WeekExpenseLines[]> {
  if (weeks.length === 0) return [];
  const key = `weekly-expenses:${weeks[weeks.length - 1].start}:${weeks[0].end}`;
  const { data } = await withDurableCache(
    key,
    6 * 60 * 60 * 1000,
    () => _weeklyExpensesUncached(weeks),
    (d) => Array.isArray(d) && d.length > 0,
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

/** Expected AR collections per week, by invoice terms. weeks = Mon-Sun ranges.
 *  Uses ALL Gelato invoices (pending + paid) so past weeks are covered, plus
 *  open non-Gelato AR. */
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
