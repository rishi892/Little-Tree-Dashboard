/**
 * Gelato AR - live from the user's "Gelato Sales / Batches" Google Sheet.
 *
 * The sheet has two stacked sections:
 * 1. "Invoiced off of Sales (Old Method)" - monthly summary, mostly historical
 * 2. "Invoiced off of Batches (New Method)" - per-batch invoices (the source of
 * truth for current AR - these are the Gelato invoices the lender cares about)
 *
 * We pull only PENDING batch invoices from section 2 as the open Gelato AR. Each
 * Pending batch is one of the three invoices the lender sheet lists (Jan/Feb/Mar
 * 2026 batches @ $249K / $137K / $169K).
 */

import { getInvoiceTracker } from './invoiceTracker.js';

const SHEET_ID = '1y2ll_6TfiW9rWGbSH5sTENZpKi1A47vxLUuIVPvk5iE';
const GID = '752657758';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${GID}&tqx=out:csv`;

export type GelatoPaymentStatus = 'paid' | 'underpaid' | 'pending';

export type GelatoInvoice = {
 period: string; // e.g. "January"
 description: string; // batch description / sheet name
 invoiceNumber: string; // e.g. "11961a"
 amount: number; // billed amount (per Gelato Batches sheet)
 status: string; // Gelato sheet status: Pending / Approved / Paid
 comment: string;
 // --- Cross-referenced from the Invoice Tracker (actual cash collected) ---
 // The Gelato sheet status lags (often stays "Pending" after payment), so we
 // match each batch invoice to the tracker by invoice # to show what really
 // came in and whether it fully covered the billed amount.
 receivedAmount?: number; // amount actually received (tracker "paid")
 paymentStatus?: GelatoPaymentStatus; // paid | underpaid | pending
 shortfall?: number; // billed − received, when underpaid
};

export type GelatoArResult = {
 fetchedAt: string;
 sheetUrl: string;
 totals: {
 openCount: number;
 open: number; // sum of pending invoices
 paidCount: number;
 paidAmount: number; // sum of paid invoices (info only)
 receivedOnOpen: number; // tracker cash received against open batches
 underpaidCount: number; // open batches that came in short
 };
 pendingInvoices: GelatoInvoice[]; // the lender-relevant Gelato AR
 paidInvoices: GelatoInvoice[]; // historical, for reference
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
 const negative = /\(.*\)/.test(t);
 const cleaned = t.replace(/[\$,()\s]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

// --- Main fetch ---

export async function getGelatoAr(): Promise<GelatoArResult> {
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Gelato AR sheet fetch failed: ${res.status} ${res.statusText}`);
 const rows = parseCsv(await res.text());

 // Find the "Invoiced off of Batches (New Method)" section.
 let batchHeaderIdx = -1;
 for (let i = 0; i < rows.length; i++) {
 const first = (rows[i][0] ?? '').toLowerCase();
 if (first.includes('invoiced off of batches')) { batchHeaderIdx = i; break; }
 }
 if (batchHeaderIdx < 0) {
 // Fall back to scanning from row 0 (try old method too).
 batchHeaderIdx = 0;
 }
 // Skip past the header row + the column-name row.
 const startIdx = batchHeaderIdx + 2;

 // Batch-section columns:
 // col 0: Date (Month label, e.g. "January" / "2026")
 // col 1: Invoice Link / description
 // col 2: Total ($)
 // col 5: Status (Pending / Approved / Paid)
 // col 6: Invoice #
 // col 9: Comment
 const pending: GelatoInvoice[] = [];
 const paid: GelatoInvoice[] = [];
 let currentPeriodLabel = '';

 for (let i = startIdx; i < rows.length; i++) {
 const r = rows[i];
 const dateCell = (r[0] ?? '').trim();
 const desc = (r[1] ?? '').trim();
 const amount = parseMoney(r[2] ?? '');
 const status = (r[5] ?? '').trim();
 const invNum = (r[6] ?? '').trim();
 const comment = (r[9] ?? '').trim();

 // Year header rows like "2026" with everything else blank - skip but remember.
 if (/^\d{4}$/.test(dateCell) && !desc && !amount) {
 currentPeriodLabel = dateCell;
 continue;
 }
 // Skip total / summary rows: no date and no description, just numbers.
 if (!dateCell && !desc) continue;
 // Skip blank rows (no amount, no status, no inv#) - but keep period rows.
 if (amount === 0 && !status && !invNum) continue;

 const inv: GelatoInvoice = {
 period: currentPeriodLabel ? `${dateCell} ${currentPeriodLabel}`.trim() : dateCell,
 description: desc,
 invoiceNumber: invNum,
 amount,
 status,
 comment,
 };
 if (/pending/i.test(status)) pending.push(inv);
 else if (/paid|approved/i.test(status)) paid.push(inv);
 }

 const openSum = pending.reduce((s, p) => s + p.amount, 0);
 const paidSum = paid.reduce((s, p) => s + p.amount, 0);

 // Cross-reference the Invoice Tracker for ACTUAL collections against each open
 // Gelato batch invoice (matched by invoice #). Flag paid / underpaid / pending
 // and surface the received $ - the Gelato sheet itself doesn't track receipts.
 const normInv = (s: string) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
 const trackerPaidByInv = new Map<string, number>();
 try {
 const tracker = await getInvoiceTracker();
 for (const ti of tracker.invoices) {
 const k = normInv(ti.invoiceNumber);
 if (k) trackerPaidByInv.set(k, (trackerPaidByInv.get(k) ?? 0) + (ti.paid || 0));
 }
 } catch {
 /* tracker unavailable - leave everything as pending (no received $) */
 }
 const withPayment = (inv: GelatoInvoice): GelatoInvoice => {
 const received = +(trackerPaidByInv.get(normInv(inv.invoiceNumber)) ?? 0).toFixed(2);
 let paymentStatus: GelatoPaymentStatus;
 if (received <= 0.5) paymentStatus = 'pending';
 else if (received + 0.5 >= inv.amount) paymentStatus = 'paid';
 else paymentStatus = 'underpaid';
 const shortfall = paymentStatus === 'underpaid' ? +(inv.amount - received).toFixed(2) : 0;
 return { ...inv, receivedAmount: received, paymentStatus, shortfall };
 };
 const pendingEnriched = pending.map(withPayment);
 const receivedOnOpen = +pendingEnriched.reduce((s, p) => s + (p.receivedAmount ?? 0), 0).toFixed(2);
 const underpaidCount = pendingEnriched.filter((p) => p.paymentStatus === 'underpaid').length;

 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${GID}`,
 totals: {
 openCount: pending.length,
 open: +openSum.toFixed(2),
 paidCount: paid.length,
 paidAmount: +paidSum.toFixed(2),
 receivedOnOpen, // total actually collected against the open batches
 underpaidCount, // how many open batches came in short
 },
 pendingInvoices: pendingEnriched,
 paidInvoices: paid,
 };
}

// Month-name → month index (0=Jan).
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june',
 'july', 'august', 'september', 'october', 'november', 'december'];

/** Match month by first 3 chars - tolerates sheet typos like "Janurary",
 * "Feburary". Returns -1 if no match. */
function findMonthIndex(s: string): number {
 const t = (s ?? '').trim().toLowerCase();
 if (!t || t.length < 3) return -1;
 const prefix = t.substring(0, 3);
 return MONTH_NAMES.findIndex((m) => m.startsWith(prefix));
}

/**
 * Returns Gelato monthly sales totals for the Historical Sales by Channel view.
 *
 * Strategy:
 * - "Invoiced off of Batches (New Method)" section is the source of truth
 * when present (July 2025 onwards - first New Method entry is the July
 * Offcycle Batch ADJ at $500K). Use col 2 amounts there.
 * - "Invoiced off of Sales (Old Method)" fills in months without New Method
 * coverage (Jan-Jun 2025) - use col 7 "New Total" which already
 * subtracts credits.
 * - 2026 entries in New Method section appear after a year-header row "2026".
 *
 * Returns map of "YYYY-MM" → amount (USD).
 */
export async function getGelatoMonthlySales(): Promise<Map<string, number>> {
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Gelato sales fetch failed: ${res.status} ${res.statusText}`);
 const rows = parseCsv(await res.text());

 // Find both section header indices.
 let oldHeaderIdx = -1;
 let newHeaderIdx = -1;
 for (let i = 0; i < rows.length; i++) {
 const first = (rows[i][0] ?? '').toLowerCase();
 if (first.includes('invoiced off of sales')) oldHeaderIdx = i;
 if (first.includes('invoiced off of batches')) newHeaderIdx = i;
 }

 // Parse Old Method section (Jan-Nov 2025 typically).
 // Columns: 0=Month, 1=Sheet Link, 2=Total, 3=Credit, 7=New Total, 9=Status
 const oldMonthly = new Map<string, number>();
 if (oldHeaderIdx >= 0) {
 // Year for old method = 2025 (it covers Jan-Nov 2025 historically).
 const endIdx = newHeaderIdx > oldHeaderIdx ? newHeaderIdx : rows.length;
 for (let i = oldHeaderIdx + 1; i < endIdx; i++) {
 const r = rows[i];
 const monthIdx = findMonthIndex(r[0] ?? '');
 if (monthIdx < 0) continue;
 // Prefer "New Total" (col 7), fall back to "Total" (col 2).
 const amount = parseMoney(r[7] ?? '') || parseMoney(r[2] ?? '');
 if (amount === 0) continue;
 const key = `2025-${String(monthIdx + 1).padStart(2, '0')}`;
 oldMonthly.set(key, amount);
 }
 }

 // Parse New Method section.
 // Columns: 0=Month label, 2=Amount, 5=Status, 6=Invoice#
 const newMonthly = new Map<string, number>();
 let currentYear = 2025; // New Method starts in 2025; year-header rows like "2026" change this.
 if (newHeaderIdx >= 0) {
 for (let i = newHeaderIdx + 2; i < rows.length; i++) {
 const r = rows[i];
 const dateCell = (r[0] ?? '').trim();
 // Year header row like "2026".
 if (/^\d{4}$/.test(dateCell)) {
 const yr = parseInt(dateCell, 10);
 if (yr >= 2020 && yr <= 2100) currentYear = yr;
 continue;
 }
 const monthIdx = findMonthIndex(dateCell);
 if (monthIdx < 0) continue;
 const amount = parseMoney(r[2] ?? '');
 if (amount === 0) continue;
 const key = `${currentYear}-${String(monthIdx + 1).padStart(2, '0')}`;
 // If the same month appears twice in the New Method section (rare),
 // sum them (e.g. an adjustment in addition to the main batch).
 newMonthly.set(key, (newMonthly.get(key) ?? 0) + amount);
 }
 }

 // Merge: New Method wins where it exists.
 const out = new Map<string, number>();
 for (const [k, v] of oldMonthly) out.set(k, v);
 for (const [k, v] of newMonthly) out.set(k, v);
 return out;
}
