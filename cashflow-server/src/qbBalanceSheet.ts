/**
 * Live Balance Sheet - pulled directly from QB's Reports/BalanceSheet endpoint.
 * Returns the report as a flat ordered list of rows with depth indicators,
 * mirroring the qbPlReport structure.
 *
 * Used for: getting authoritative numbers for Inventory asset, Bank balances,
 * A/R, A/P, etc. Numbers match QB exactly.
 */

import { QBO_API_BASE } from './config.js';
import { getValidAccessToken } from './oauth.js';

export type QbBsRow = {
 depth: number;
 name: string;
 /** Per-month end-of-month balance, length = months.length. */
 monthly: number[];
 /** Latest value (= monthly[monthly.length - 1]). Convenience. */
 amount: number;
 /** Section header / summary subtotal / leaf detail / pure header. */
 kind: 'section' | 'summary' | 'detail' | 'header';
 hasChildren: boolean;
 /** Account name without parent prefix (same as `name`, kept for symmetry). */
 accountName: string;
};

export type QbBalanceSheetReport = {
 asOf: string; // server fetch time
 reportAsOf: string; // QB's "as of" date (last day of last column)
 realmId: string;
 /** YYYY-MM keys, one per column. End-of-month snapshots Jan 2025 → last completed month. */
 months: string[];
 monthLabels: string[]; // e.g. "Jan 2025"
 rows: QbBsRow[];
 /** Convenience lookups for the LATEST snapshot. */
 totals: {
 totalAssets: number;
 totalLiabilities: number;
 totalEquity: number;
 inventory: number;
 accountsReceivable: number;
 accountsPayable: number;
 cashAndBank: number;
 };
};

function num(s: unknown): number {
 if (typeof s !== 'string') return 0;
 const n = parseFloat(s);
 return Number.isFinite(n) ? n : 0;
}

function flatten(reportRows: any[], monthCount: number): QbBsRow[] {
 const out: QbBsRow[] = [];

 function readMonthly(colData: any[] | undefined): { monthly: number[]; latest: number } {
 const arr = colData ?? [];
 const monthly: number[] = [];
 // ColData = [name, m1, m2, ..., mN]. No trailing total column for monthly BS.
 for (let i = 1; i <= monthCount; i++) monthly.push(num(arr[i]?.value));
 const latest = monthly.length > 0 ? monthly[monthly.length - 1] : 0;
 return { monthly, latest };
 }

 function walk(rows: any[], depth: number) {
 for (const row of rows) {
 const hasChildren = !!row.Rows?.Row?.length;
 const hasSummary = !!row.Summary?.ColData;
 const headerName = row.Header?.ColData?.[0]?.value as string | undefined;

 if (headerName !== undefined) {
 const { monthly, latest } = readMonthly(row.Summary?.ColData);
 out.push({
 depth, name: headerName, accountName: headerName,
 monthly, amount: latest,
 kind: hasSummary ? 'section' : 'header',
 hasChildren,
 });
 if (hasChildren) walk(row.Rows.Row, depth + 1);
 if (hasSummary) {
 const sumName = row.Summary.ColData[0]?.value as string;
 if (sumName && sumName !== headerName) {
 const { monthly: sm, latest: sl } = readMonthly(row.Summary.ColData);
 out.push({
 depth, name: sumName, accountName: sumName,
 monthly: sm, amount: sl,
 kind: 'summary',
 hasChildren: false,
 });
 }
 }
 continue;
 }

 const data = row.ColData ?? [];
 const name = (data[0]?.value as string) ?? '';
 if (!name) continue;
 const { monthly, latest } = readMonthly(data);
 out.push({
 depth, name, accountName: name,
 monthly, amount: latest,
 kind: hasChildren ? 'section' : 'detail',
 hasChildren,
 });
 if (hasChildren) walk(row.Rows.Row, depth + 1);
 }
 }
 walk(reportRows, 0);
 return out;
}

function findRowAmount(rows: QbBsRow[], pattern: RegExp): number {
 for (const r of rows) {
 if (pattern.test(r.name)) return r.amount;
 }
 return 0;
}

function sumLeavesIn(rows: QbBsRow[], pattern: RegExp): number {
 // Sum all leaf (detail) rows whose name matches the pattern.
 let s = 0;
 for (const r of rows) {
 if (r.kind === 'detail' && pattern.test(r.name)) s += r.amount;
 }
 return s;
}

const FIXED_START = { year: 2025, month: 0 }; // Jan 2025

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

export type BsAccountingMethod = 'Accrual' | 'Cash';

export async function getQbBalanceSheet(method: BsAccountingMethod = 'Accrual'): Promise<QbBalanceSheetReport & { accountingMethod: BsAccountingMethod }> {
 const tok = await getValidAccessToken();
 const { startDate, endDate, months, monthLabels } = buildMonths();
 // Request monthly columns: QB returns end-of-month balances for each.
 // accounting_method matches the P&L toggle - Accrual (default QB BS) vs Cash
 // (excludes AR/AP/accrual entries so the BS reflects pure cash movements).
 const url = `${QBO_API_BASE}/v3/company/${tok.realmId}/reports/BalanceSheet`
 + `?start_date=${startDate}&end_date=${endDate}`
 + `&summarize_column_by=Month&accounting_method=${method}&minorversion=70`;
 const res = await fetch(url, {
 headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: 'application/json' },
 });
 if (!res.ok) throw new Error(`QBO Balance Sheet ${res.status}: ${await res.text()}`);
 const json = await res.json() as { Header?: { EndPeriod?: string }; Rows?: { Row: any[] } };
 const rows = flatten(json.Rows?.Row ?? [], months.length);

 return {
 asOf: new Date().toISOString(),
 accountingMethod: method,
 reportAsOf: json.Header?.EndPeriod ?? endDate,
 realmId: tok.realmId,
 months,
 monthLabels,
 rows,
 totals: {
 totalAssets: findRowAmount(rows, /^total assets$/i),
 totalLiabilities: findRowAmount(rows, /^total liabilities$/i),
 totalEquity: findRowAmount(rows, /^total equity$/i),
 inventory: findRowAmount(rows, /^inventory$|^inventory asset$|^total inventory$/i)
 || sumLeavesIn(rows, /inventory/i),
 accountsReceivable: findRowAmount(rows, /^accounts receivable$|^total accounts receivable/i)
 || sumLeavesIn(rows, /^accounts receivable|^a\/?r\b/i),
 accountsPayable: findRowAmount(rows, /^accounts payable$|^total accounts payable/i)
 || sumLeavesIn(rows, /^accounts payable|^a\/?p\b/i),
 cashAndBank: sumLeavesIn(rows, /^(.*\s)?(cash|checking|savings|money market)\b/i),
 },
 };
}
