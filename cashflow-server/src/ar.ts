/**
 * Accounts Receivable - live from the AR Google Sheet.
 *
 * Sheet structure (no formal header; first 3 rows are summary/header):
 * col 0: Inv #
 * col 1: Invoice date
 * col 2: Vendor / Customer
 * col 3: Quantity
 * col 4: Invoice Amount ($)
 * col 5: Amount Paid ($)
 * col 6: Paid Date
 * col 7: Commission Rate
 * col 8: Commission Amount ($)
 *
 * Open balance is derived (amount − paid). Public CSV via gviz - no auth.
 */

const AR_SHEET_ID = '1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes';
const AR_GID = '0';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${AR_SHEET_ID}/gviz/tq?gid=${AR_GID}&tqx=out:csv`;

export type ArInvoice = {
 invoiceNumber: string;
 date: string;
 customer: string;
 amount: number;
 paid: number;
 openBalance: number;
 paidDate: string;
};

export type ArCustomer = {
 customer: string;
 openBalance: number;
 openInvoices: number;
 oldestDate: string;
};

export type ArResult = {
 fetchedAt: string;
 sheetUrl: string;
 totals: {
 invoiced: number;
 collected: number;
 open: number;
 openInvoiceCount: number;
 uniqueCustomers: number;
 };
 byCustomer: ArCustomer[];
 invoices: ArInvoice[];
};

// --- CSV parsing ---

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
 const negative = /\(.*\)/.test(t);
 const cleaned = t.replace(/[\$,()\s]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

function normCustomer(s: string): string {
 return (s ?? '').trim().replace(/^[:\s]+/, '').replace(/\s+/g, ' ');
}

function dateKey(s: string): string {
 const t = (s ?? '').trim();
 if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
 const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
 if (m) {
 const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
 return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
 }
 return t;
}

// --- Main fetch ---

export async function getArOpen(): Promise<ArResult> {
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`AR sheet fetch failed: ${res.status} ${res.statusText}`);
 const text = await res.text();
 const rows = parseCsv(text);

 // Row 0 is the grand-total summary; row 1 has the sheet's stated totals.
 const totalInvoiced = rows[1] ? parseMoney(rows[1][4] ?? '') : 0;
 const totalCollected = rows[1] ? parseMoney(rows[1][5] ?? '') : 0;

 const invoices: ArInvoice[] = [];
 for (let i = 0; i < rows.length; i++) {
 const r = rows[i];
 const inv = (r[0] ?? '').trim();
 if (!inv || /^inv #$/i.test(inv)) continue; // skip summary/header rows
 const customer = normCustomer(r[2] ?? '');
 if (!customer) continue;

 const amount = parseMoney(r[4] ?? '');
 const paid = parseMoney(r[5] ?? '');
 const open = +(amount - paid).toFixed(2);
 if (open <= 0) continue;
 if (amount <= 0) continue;

 invoices.push({
 invoiceNumber: inv,
 date: (r[1] ?? '').trim(),
 customer,
 amount,
 paid,
 openBalance: open,
 paidDate: (r[6] ?? '').trim(),
 });
 }
 invoices.sort((a, b) => b.openBalance - a.openBalance);

 // Per-customer aggregate.
 const byCust = new Map<string, ArCustomer>();
 for (const inv of invoices) {
 const cur = byCust.get(inv.customer);
 const k = dateKey(inv.date);
 if (cur) {
 cur.openBalance += inv.openBalance;
 cur.openInvoices += 1;
 if (k && (!cur.oldestDate || k < cur.oldestDate)) cur.oldestDate = k;
 } else {
 byCust.set(inv.customer, { customer: inv.customer, openBalance: inv.openBalance, openInvoices: 1, oldestDate: k });
 }
 }
 const byCustomer = Array.from(byCust.values()).sort((a, b) => b.openBalance - a.openBalance);
 for (const c of byCustomer) c.openBalance = +c.openBalance.toFixed(2);

 const totalOpen = +invoices.reduce((s, i) => s + i.openBalance, 0).toFixed(2);

 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl: `https://docs.google.com/spreadsheets/d/${AR_SHEET_ID}/edit#gid=${AR_GID}`,
 totals: {
 invoiced: totalInvoiced,
 collected: totalCollected,
 open: totalOpen,
 openInvoiceCount: invoices.length,
 uniqueCustomers: byCustomer.length,
 },
 byCustomer,
 invoices,
 };
}
