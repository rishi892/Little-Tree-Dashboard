/**
 * PureX Payroll from the Little Tree Financials sheet.
 *
 * Source: same workbook as purexClearing.ts ("Expenses" tab, gid=597060736).
 * Schema (after a 4-row header section):
 * col 0: (empty)
 * col 1: DATE (M/D/YYYY or M/D/YY)
 * col 2: VENDOR (free text - we match /payroll|gusto|crew/i)
 * col 3: AMOUNT ($x,xxx.xx with possible negatives)
 *
 * Only PureX side - these payments cleared from the PureX intercompany account.
 * Monthly totals get ADDED to the existing PureX Payroll Total row.
 */

const SHEET_ID = '1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes';
const EXP_GID = '597060736';
// /export endpoint returns full sheet; gviz/tq silently truncates large tabs.
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${EXP_GID}`;

export type PurexPayrollRow = {
 date: string; // raw date string from sheet
 ym: string; // YYYY-MM
 vendor: string;
 amount: number;
};

export type PurexPayrollResult = {
 fetchedAt: string;
 sheetUrl: string;
 rows: PurexPayrollRow[];
 monthlyByYM: Record<string, number>;
 total: number;
};

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
 else if (c !== '\r') field += c;
 }
 }
 if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
 return rows;
}

function parseMoney(s: string): number {
 const t = (s ?? '').trim();
 if (!t) return 0;
 const neg = /\(.*\)/.test(t) || /^-/.test(t);
 const cleaned = t.replace(/[$,()\s-]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (neg ? -n : n) : 0;
}

/** "M/D/YYYY" or "M/D/YY" → YYYY-MM. Returns null on parse fail. */
function parseYM(s: string): string | null {
 const m = (s ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
 if (!m) return null;
 const yr = m[3].length === 2 ? '20' + m[3] : m[3];
 const mo = m[1].padStart(2, '0');
 return `${yr}-${mo}`;
}

const PAYROLL_RE = /payroll|gusto|crew/i;

let _cache: { at: number; data: PurexPayrollResult } | null = null;
let _inFlight: Promise<PurexPayrollResult> | null = null;
const _CACHE_TTL_MS = 30 * 1000; // sheet is editable live → short TTL

export function invalidatePurexPayrollCache(): void { _cache = null; }

export async function getPurexPayrollFromSheet(): Promise<PurexPayrollResult> {
 if (_cache && Date.now() - _cache.at < _CACHE_TTL_MS) return _cache.data;
 if (_inFlight) return _inFlight;
 _inFlight = (async () => {
 try { return await _fetch(); }
 finally { _inFlight = null; }
 })();
 const data = await _inFlight;
 if (data.rows.length > 0) _cache = { at: Date.now(), data };
 return data;
}

async function _fetch(): Promise<PurexPayrollResult> {
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`PureX payroll sheet fetch failed: ${res.status} ${res.statusText}`);
 const rows = parseCsv(await res.text());
 const out: PurexPayrollRow[] = [];
 const monthlyByYM: Record<string, number> = {};
 let total = 0;
 for (const r of rows) {
 const date = (r[1] ?? '').trim();
 const vendor = (r[2] ?? '').trim();
 if (!date || !vendor) continue;
 if (!PAYROLL_RE.test(vendor)) continue;
 const ym = parseYM(date);
 if (!ym) continue;
 const amount = parseMoney(r[3] ?? '');
 if (amount === 0) continue;
 out.push({ date, ym, vendor, amount });
 monthlyByYM[ym] = (monthlyByYM[ym] ?? 0) + amount;
 total += amount;
 }
 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${EXP_GID}`,
 rows: out,
 monthlyByYM,
 total: +total.toFixed(2),
 };
}
