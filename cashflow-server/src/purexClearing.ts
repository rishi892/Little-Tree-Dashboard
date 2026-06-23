/**
 * PureX intercompany clearing balance - computed live.
 *
 * Formula (replicates the user's spreadsheet formula `=SUM(I2-I1-Expenses!F2)`):
 * Clearing = (Sales I2 − Sales I1) − TotalExpenses
 *
 * I2 = AR sheet cell I2 (column I, row 2) - running collected total
 * I1 = AR sheet cell I1 (column I, row 1) - opening / open AR baseline
 * Expenses!F2 = Expenses tab cell F2 - TOTAL EXPENSES grand total
 *
 * Both come from the same workbook, different tabs.
 */

const SHEET_ID = '1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes';
const AR_GID = '0';
const EXP_GID = '597060736';
const AR_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${AR_GID}&tqx=out:csv`;
const EXP_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${EXP_GID}&tqx=out:csv`;

export type PurexClearingResult = {
 fetchedAt: string;
 sales: {
 i2: number; // cell I2 - running collected total
 i1: number; // cell I1 - open AR baseline
 net: number; // I2 - I1
 };
 expense: {
 total: number; // Expenses!F2
 };
 clearing: number; // (I2 - I1) - Expenses!F2
 sheetUrl: string;
 expenseSheetUrl: string;
 warnings: string[];
};

// --- CSV parser (compact) ---

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
 const negative = /\(.*\)/.test(t) || t.startsWith('-') || t.startsWith('−');
 const cleaned = t.replace(/[\$,()\s−-]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

// --- Main fetch ---

export async function getPurexClearing(): Promise<PurexClearingResult> {
 const warnings: string[] = [];

 // 1. Fetch both tabs in parallel.
 const [arRes, expRes] = await Promise.all([
 fetch(AR_CSV_URL, { redirect: 'follow' }),
 fetch(EXP_CSV_URL, { redirect: 'follow' }),
 ]);
 if (!arRes.ok) throw new Error(`AR sheet fetch failed: ${arRes.status}`);
 if (!expRes.ok) throw new Error(`Expenses tab fetch failed: ${expRes.status}`);

 const arRows = parseCsv(await arRes.text());
 const expRows = parseCsv(await expRes.text());

 // 2. Pull I1 and I2 from AR sheet. Spreadsheet 1-indexed → row 0/1, col 8.
 // Column I (1-indexed = 9th col) = 0-indexed col 8 (the "Open Balance" /
 // cumulative column on this sheet).
 const i1 = parseMoney(arRows[0]?.[8] ?? '');
 const i2 = parseMoney(arRows[1]?.[8] ?? '');
 if (i1 === 0 && i2 === 0) warnings.push('AR sheet I1/I2 cells came back empty - verify column layout.');

 // 3. Expenses!F2 - Expenses tab cell F2 = row 1 (0-indexed), col 5 (0-indexed).
 // Row 1 has "","","","","TOTAL EXPENSES","$X.XX",… so col 4 is the label,
 // col 5 is the value.
 let expTotal = parseMoney(expRows[1]?.[5] ?? '');
 if (expTotal === 0) {
 // Defensive: scan for "TOTAL EXPENSES" label and grab adjacent cell.
 for (let r = 0; r < expRows.length && expTotal === 0; r++) {
 for (let c = 0; c < expRows[r].length; c++) {
 if (/total expenses/i.test((expRows[r][c] ?? '').trim())) {
 expTotal = parseMoney(expRows[r][c + 1] ?? '');
 break;
 }
 }
 }
 }
 if (expTotal === 0) warnings.push('Expenses tab F2 / TOTAL EXPENSES cell came back empty.');

 const netSales = +(i2 - i1).toFixed(2);
 const clearing = +(netSales - expTotal).toFixed(2);

 return {
 fetchedAt: new Date().toISOString(),
 sales: { i2, i1, net: netSales },
 expense: { total: expTotal },
 clearing,
 sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${AR_GID}`,
 expenseSheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${EXP_GID}`,
 warnings,
 };
}
