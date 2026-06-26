/**
 * Live P&L Report - pulled directly from QuickBooks Online's
 * Reports/ProfitAndLoss endpoint with monthly columns. Returns the report
 * structure as a flat list of rows with depth indicators so the client can
 * render it exactly as QB shows it.
 *
 * No classification, no PureX/Moysh split, no overrides - just the raw P&L
 * from QB so the user can verify numbers match QB directly.
 */

import { QBO_API_BASE } from './config.js';
import { qboFetch } from './qbHttp.js';
import { getValidAccessToken } from './oauth.js';

const FIXED_START = { year: 2025, month: 0 }; // Jan 2025

export type QbPlRow = {
 /** Indent depth - 0 for top-level sections, 1+ for nested. */
 depth: number;
 /** Account/section name. */
 name: string;
 /** Monthly values, length = months.length. */
 monthly: number[];
 /** Total across the period. */
 total: number;
 /** Visual style hint: 'section' (section header w/ total), 'summary' (subtotal
 * row like "Total Expenses"), 'detail' (leaf account), 'header' (pure header
 * with no values). */
 kind: 'section' | 'summary' | 'detail' | 'header';
 /** Whether this row has nested children (sections / sub-accounts). */
 hasChildren: boolean;
};

export type QbPlReport = {
 asOf: string;
 realmId: string;
 startDate: string;
 endDate: string;
 months: string[]; // YYYY-MM
 monthLabels: string[]; // "Jan 2025"
 rows: QbPlRow[];
};

function buildMonths(): { startDate: string; endDate: string; months: string[]; monthLabels: string[] } {
 const months: string[] = [];
 const monthLabels: string[] = [];
 const now = new Date();
 const endYear = now.getUTCFullYear();
 const endMonth = now.getUTCMonth(); // exclude current incomplete month
 let y = FIXED_START.year;
 let m = FIXED_START.month;
 while (y < endYear || (y === endYear && m < endMonth)) {
 const d = new Date(Date.UTC(y, m, 1));
 months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
 monthLabels.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
 m++;
 if (m > 11) { m = 0; y++; }
 }
 const startDate = `${months[0]}-01`;
 const endY = endMonth === 0 ? endYear - 1 : endYear;
 const endM = endMonth === 0 ? 12 : endMonth;
 const lastDay = new Date(Date.UTC(endY, endM, 0)).getUTCDate();
 const endDate = `${endY}-${String(endM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
 return { startDate, endDate, months, monthLabels };
}

function num(s: unknown): number {
 if (typeof s !== 'string') return 0;
 const n = parseFloat(s);
 return Number.isFinite(n) ? n : 0;
}

/** Walks the QB report Rows tree producing a flat ordered list with depth. */
function flatten(reportRows: any[], monthCount: number): QbPlRow[] {
 const out: QbPlRow[] = [];
 function walk(rows: any[], depth: number) {
 for (const row of rows) {
 const hasChildren = !!row.Rows?.Row?.length;
 const hasSummary = !!row.Summary?.ColData;
 const headerName = row.Header?.ColData?.[0]?.value as string | undefined;

 if (headerName !== undefined) {
 // Section header (always rendered, even without its own totals).
 const summary = row.Summary?.ColData ?? [];
 const monthly: number[] = [];
 for (let i = 1; i <= monthCount; i++) monthly.push(num(summary[i]?.value));
 const total = num(summary[monthCount + 1]?.value);
 out.push({
 depth,
 name: headerName,
 monthly,
 total,
 kind: hasSummary ? 'section' : 'header',
 hasChildren,
 });
 if (hasChildren) walk(row.Rows.Row, depth + 1);
 // Some reports also emit a 'Summary' row for the section (e.g. "Total Income")
 if (hasSummary && headerName) {
 const sumName = row.Summary.ColData[0]?.value as string;
 if (sumName && sumName !== headerName) {
 const sumMonthly: number[] = [];
 for (let i = 1; i <= monthCount; i++) sumMonthly.push(num(row.Summary.ColData[i]?.value));
 const sumTotal = num(row.Summary.ColData[monthCount + 1]?.value);
 out.push({
 depth,
 name: sumName,
 monthly: sumMonthly,
 total: sumTotal,
 kind: 'summary',
 hasChildren: false,
 });
 }
 }
 continue;
 }

 // Detail (leaf) row.
 const data = row.ColData ?? [];
 const name = (data[0]?.value as string) ?? '';
 if (!name) continue;
 const monthly: number[] = [];
 for (let i = 1; i <= monthCount; i++) monthly.push(num(data[i]?.value));
 const total = num(data[monthCount + 1]?.value);
 out.push({
 depth,
 name,
 monthly,
 total,
 kind: hasChildren ? 'section' : 'detail',
 hasChildren,
 });
 if (hasChildren) walk(row.Rows.Row, depth + 1);
 }
 }
 walk(reportRows, 0);
 return out;
}

export type AccountingMethod = 'Accrual' | 'Cash';

// In-process cache per method. The P&L report is heavy (a full QB API call) and
// is read by the 13-week, pnl-expenses, and the route - all within seconds of
// each other and after every mapping edit. An 8-min TTL means one QB call serves
// them all (also fewer token refreshes = steadier QB connection). force=true
// rebuilds (used by ?refresh=1).
type CachedPl = QbPlReport & { accountingMethod: AccountingMethod };
const _plCache = new Map<AccountingMethod, { at: number; data: CachedPl }>();
const PL_TTL_MS = 8 * 60 * 1000;

export async function getQbPlReport(method: AccountingMethod = 'Accrual', force = false): Promise<CachedPl> {
 const hit = _plCache.get(method);
 if (!force && hit && Date.now() - hit.at < PL_TTL_MS) return hit.data;
 const tok = await getValidAccessToken();
 const { startDate, endDate, months, monthLabels } = buildMonths();
 const url = `${QBO_API_BASE}/v3/company/${tok.realmId}/reports/ProfitAndLoss`
 + `?start_date=${startDate}&end_date=${endDate}`
 + `&summarize_column_by=Month&accounting_method=${method}&minorversion=70`;
 const res = await qboFetch(url, tok.accessToken);
 const json = await res.json() as { Rows?: { Row: any[] }; Columns?: { Column: Array<{ ColTitle: string }> } };
 const rows = flatten(json.Rows?.Row ?? [], months.length);
 const result: CachedPl = {
 asOf: new Date().toISOString(),
 realmId: tok.realmId,
 startDate,
 endDate,
 months,
 monthLabels,
 rows,
 accountingMethod: method,
 };
 _plCache.set(method, { at: Date.now(), data: result });
 return result;
}

// Dedicated month-to-date P&L for ONE month. buildMonths() deliberately excludes
// the current (incomplete) month so the run-rate stays on settled months; this
// pulls just that month (start..min(month-end, today)) as a single column, same
// shape as getQbPlReport so computePnlExpenses reads index 0. It lets the
// variance ACTUAL show current-month QB spend AS IT SETTLES (no sheet), without
// disturbing the global window or the budget run-rate. Cached per month+method.
const _plMonthCache = new Map<string, { at: number; data: CachedPl }>();
export async function getQbPlReportForMonth(ym: string, method: AccountingMethod = 'Cash', force = false): Promise<CachedPl> {
 const key = `${ym}:${method}`;
 const hit = _plMonthCache.get(key);
 if (!force && hit && Date.now() - hit.at < PL_TTL_MS) return hit.data;
 const tok = await getValidAccessToken();
 const [y, m] = ym.split('-').map(Number);
 const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
 const monthEnd = `${ym}-${String(lastDay).padStart(2, '0')}`;
 const now = new Date();
 const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
 const startDate = `${ym}-01`;
 const endDate = monthEnd < today ? monthEnd : today;   // month-to-date for the current month
 const url = `${QBO_API_BASE}/v3/company/${tok.realmId}/reports/ProfitAndLoss`
 + `?start_date=${startDate}&end_date=${endDate}`
 + `&summarize_column_by=Month&accounting_method=${method}&minorversion=70`;
 const res = await qboFetch(url, tok.accessToken);
 const json = await res.json() as { Rows?: { Row: any[] } };
 const rows = flatten(json.Rows?.Row ?? [], 1);
 const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
 const result: CachedPl = {
 asOf: new Date().toISOString(),
 realmId: tok.realmId,
 startDate,
 endDate,
 months: [ym],
 monthLabels: [monthLabel],
 rows,
 accountingMethod: method,
 };
 _plMonthCache.set(key, { at: Date.now(), data: result });
 return result;
}
