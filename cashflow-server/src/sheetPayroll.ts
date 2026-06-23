/**
 * Payroll expenses parsed from the Expenses tab of the AR sheet.
 *
 * Source: same workbook + Expenses tab the rest of the model uses
 * (1FhKkWXxXl... gid=597060736). Rows whose description starts with "Payroll"
 * (or matches common payroll keywords) are aggregated by month.
 *
 * Output: monthly array anchored at Jan 2025 (same anchor as other expense
 * pages) + per-row detail for transparency.
 */

const SHEET_ID = '1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes';
const EXP_GID = '597060736';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${EXP_GID}&tqx=out:csv`;

const FIXED_START = { year: 2025, month: 0 };

/**
 * PureX Production Payroll match - catches every payroll-related entry in the
 * Expenses tab:
 * - "Payroll [date]" rows (the biweekly payroll runs)
 * - "Armandos Crew" / "Armandos Crew Check #…" / "Armandos Crew ACH" (production-crew contractor labor)
 * - "Gusto * Fee" (payroll service)
 * - "TEG Payroll" / payroll-tax / payroll-fee variants
 */
const PAYROLL_RE = /^payroll|payroll fees?|payroll taxes?|gusto.*fee|teg payroll|armandos\s*crew|wages?\b|salary|salaries/i;

export type SheetPayrollEntry = {
 date: string; // YYYY-MM-DD
 description: string;
 amount: number;
};

export type SheetPayrollResult = {
 fetchedAt: string;
 sheetUrl: string;
 months: string[]; // YYYY-MM keys (Jan 2025 onwards)
 monthLabels: string[]; // "Jan 2025" labels
 monthlyTotals: number[]; // length = months.length
 total: number;
 weeklyAvgL3M: number; // last 3 months avg ÷ 4.33 - used by 13-Week Plan
 entries: SheetPayrollEntry[]; // filtered raw entries (Jan 2025+)
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

function buildMonths(): { months: string[]; labels: string[] } {
 const now = new Date();
 const months: string[] = [];
 const labels: string[] = [];
 let y = FIXED_START.year;
 let m = FIXED_START.month;
 const endY = now.getUTCFullYear();
 const endM = now.getUTCMonth(); // exclude current incomplete month
 while (y < endY || (y === endY && m < endM)) {
 const d = new Date(Date.UTC(y, m, 1));
 months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
 labels.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
 m++;
 if (m > 11) { m = 0; y++; }
 }
 return { months, labels };
}

// --- Main ---

export async function getSheetPayroll(): Promise<SheetPayrollResult> {
 const warnings: string[] = [];

 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Expenses tab fetch failed: ${res.status}`);
 const rows = parseCsv(await res.text());

 const { months, labels } = buildMonths();
 const monthIndex = new Map(months.map((m, i) => [m, i]));
 const monthlyTotals = new Array(months.length).fill(0);
 const entries: SheetPayrollEntry[] = [];

 for (const r of rows) {
 const desc = (r[2] ?? '').trim();
 if (!PAYROLL_RE.test(desc)) continue;
 const date = parseDate(r[1] ?? '');
 const amt = parseMoney(r[3] ?? '');
 if (!date || amt <= 0) continue;
 const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
 const idx = monthIndex.get(key);
 if (idx === undefined) continue; // before Jan 2025 or current incomplete month
 monthlyTotals[idx] += amt;
 entries.push({ date: ymd(date), description: desc, amount: amt });
 }

 const total = +monthlyTotals.reduce((s, v) => s + v, 0).toFixed(2);

 // L3M average ÷ 4.33 for weekly run-rate.
 const l3mStart = Math.max(0, months.length - 3);
 let l3mSum = 0;
 let l3mCount = 0;
 for (let i = l3mStart; i < months.length; i++) {
 l3mSum += monthlyTotals[i];
 l3mCount++;
 }
 const weeklyAvgL3M = l3mCount > 0 ? +((l3mSum / l3mCount) / 4.33).toFixed(2) : 0;

 if (entries.length === 0) {
 warnings.push('No payroll entries matched in Expenses tab (Jan 2025+). Check description format.');
 }

 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${EXP_GID}`,
 months,
 monthLabels: labels,
 monthlyTotals: monthlyTotals.map((v) => +v.toFixed(2)),
 total,
 weeklyAvgL3M,
 entries,
 warnings,
 };
}
