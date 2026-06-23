/**
 * Settlement History - PureX → Little Tree intercompany settlements, live.
 *
 * Source: the Expenses tab in the AR sheet (PureX's bank ledger). Rows with a
 * description containing "Little Tree" + an invoice marker ("Inv NN" or
 * "Inv ???") are the cash payments PureX has sent to LT.
 *
 * Lender-relevant stats are computed: count, total, avg, median, min/max,
 * average days between settlements, max gap. Plus derived metrics that contrast
 * the settlement run-rate against the required monthly OpEx (from QB) to show
 * the cash gap that LT must fund elsewhere.
 */

import { getExpenseDetail } from './expenseDetail.js';

const SHEET_ID = '1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes';
const EXP_GID = '597060736';
const EXP_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${EXP_GID}&tqx=out:csv`;

/** Anchor - all dashboards start at Jan 2025. */
const FIXED_START = { year: 2025, month: 0 }; // Jan 2025

export type Settlement = {
 date: string; // YYYY-MM-DD
 description: string;
 amount: number;
 daysSincePrior: number;
 cumulative: number;
};

export type SettlementHistoryResult = {
 fetchedAt: string;
 sheetUrl: string;
 settlements: Settlement[];
 stats: {
 count: number;
 totalAmount: number;
 avg: number;
 median: number;
 smallest: number;
 largest: number;
 avgDaysBetween: number;
 maxGapDays: number;
 };
 derived: {
 avgMonthlySettlement: number; // total ÷ months elapsed
 monthsCounted: number; // months since Jan 2025 anchor
 requiredMonthlyOpex: number; // QB L3M avg
 cashGapPerMonth: number; // required − settled
 cashGapOver13Weeks: number; // gap × 3
 annualizedCashDrag: number; // gap × 12
 };
 warnings: string[];
};

// --- CSV parser ---

function parseCsv(text: string): string[][] {
 const rows: string[][] = [];
 let cur: string[] = [];
 let field = '';
 let inQuotes = false;
 for (let i = 0; i < text.length; i++) {
 const c = text[i];
 if (inQuotes) {
 if (c === '"') {
 if (text[i + 1] === '"') { field += '"'; i++; }
 else inQuotes = false;
 } else field += c;
 } else {
 if (c === '"') inQuotes = true;
 else if (c === ',') { cur.push(field); field = ''; }
 else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
 else if (c === '\r') { /* skip */ }
 else field += c;
 }
 }
 if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
 return rows;
}

function parseMoney(s: string): number {
 const t = (s ?? '').trim();
 if (!t || t === '-' || t === '$ -') return 0;
 const negative = /\(.*\)/.test(t) || t.startsWith('-');
 const cleaned = t.replace(/[\$,()\s−-]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

/** Parse "M/D/YYYY", "MM/DD/YYYY", "MM-DD-YYYY", "MM/DD/YY", or "YYYY-MM-DD". */
function parseDate(s: string): Date | null {
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
function ymd(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function median(arr: number[]): number {
 if (arr.length === 0) return 0;
 const s = [...arr].sort((a, b) => a - b);
 const mid = Math.floor(s.length / 2);
 return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// --- Main ---

export async function getSettlementHistory(): Promise<SettlementHistoryResult> {
 const warnings: string[] = [];

 // 1. Fetch Expenses tab.
 const res = await fetch(EXP_CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Expenses tab fetch failed: ${res.status}`);
 const rows = parseCsv(await res.text());

 // 2. Filter "Little Tree" settlement rows.
 // Columns: 0=blank, 1=date, 2=description, 3=amount.
 const raw: Array<{ date: Date; description: string; amount: number }> = [];
 for (const r of rows) {
 const desc = (r[2] ?? '').trim();
 if (!/little tree.*inv/i.test(desc)) continue;
 const date = parseDate(r[1] ?? '');
 const amt = parseMoney(r[3] ?? '');
 if (!date || amt <= 0) continue;
 raw.push({ date, description: desc, amount: amt });
 }
 raw.sort((a, b) => a.date.getTime() - b.date.getTime());

 // 3. Filter to settlements from Jan 2025 anchor onwards (always).
 const windowStart = new Date(Date.UTC(FIXED_START.year, FIXED_START.month, 1));
 const inWindow = raw.filter((s) => s.date >= windowStart);

 // 4. Build settlements with days-since-prior + cumulative.
 const settlements: Settlement[] = [];
 let prev: Date | null = null;
 let cum = 0;
 for (const s of inWindow) {
 const days = prev ? Math.round((s.date.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24)) : 0;
 cum += s.amount;
 settlements.push({
 date: ymd(s.date),
 description: s.description,
 amount: s.amount,
 daysSincePrior: days,
 cumulative: +cum.toFixed(2),
 });
 prev = s.date;
 }

 // 4. Stats.
 const amounts = settlements.map((s) => s.amount);
 const totalAmount = +amounts.reduce((s, v) => s + v, 0).toFixed(2);
 const gaps = settlements.slice(1).map((s) => s.daysSincePrior);
 const avgDaysBetween = gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0;
 const maxGapDays = gaps.length ? Math.max(...gaps) : 0;

 const stats = {
 count: settlements.length,
 totalAmount,
 avg: settlements.length ? +(totalAmount / settlements.length).toFixed(2) : 0,
 median: +median(amounts).toFixed(2),
 smallest: amounts.length ? Math.min(...amounts) : 0,
 largest: amounts.length ? Math.max(...amounts) : 0,
 avgDaysBetween: +avgDaysBetween.toFixed(2),
 maxGapDays,
 };

 // 6. Derived metrics - avg monthly settlement over the elapsed window.
 const nowD = new Date();
 const monthsCounted = Math.max(
 1,
 (nowD.getUTCFullYear() - FIXED_START.year) * 12 + (nowD.getUTCMonth() - FIXED_START.month) + 1,
 );
 const avgMonthlySettlement = +(totalAmount / monthsCounted).toFixed(2);

 // Required monthly OpEx - pull QB L3M average.
 let requiredMonthlyOpex = 0;
 try {
 const detail = await getExpenseDetail();
 const m = detail.months.length;
 const l3mStart = Math.max(0, m - 3);
 let total = 0;
 for (let i = l3mStart; i < m; i++) {
 for (const r of detail.rows) total += r.monthly[i] ?? 0;
 }
 const monthsCounted = m - l3mStart;
 requiredMonthlyOpex = monthsCounted > 0 ? +(total / monthsCounted).toFixed(2) : 0;
 } catch (e) {
 warnings.push(`QB expense detail unavailable (${e instanceof Error ? e.message : '?'}) - required monthly OpEx = 0.`);
 }

 const cashGapPerMonth = +(requiredMonthlyOpex - avgMonthlySettlement).toFixed(2);
 const derived = {
 avgMonthlySettlement,
 monthsCounted,
 requiredMonthlyOpex,
 cashGapPerMonth,
 cashGapOver13Weeks: +(cashGapPerMonth * 3).toFixed(2),
 annualizedCashDrag: +(cashGapPerMonth * 12).toFixed(2),
 };

 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${EXP_GID}`,
 settlements,
 stats,
 derived,
 warnings,
 };
}
