/**
 * Per-rep commission workbooks loader.
 *
 * Each rep has their OWN Google Sheet workbook with full 22-column commission
 * calculations (the team maintains these manually). Schema per row:
 *   Inv #, INVOICE DATE, Account, Invoice Amount, Status, Paid Date,
 *   Paid amount, Paid month, Difference, Tax Amount (24%), Pure X Fee,
 *   Shipping Cost, Net Amount, Order Type ("White label" or blank),
 *   Business Type ("Old Business" / "New business"), Owner (rep name),
 *   Calc at 5%, Calc at 2%, Calc at 1%, Commission amount,
 *   Differential commission.
 *
 * Each workbook also has:
 *   - "Calculation" tab: paid invoices with commission breakdown
 *   - "open invoices" tab: unpaid invoices (same schema)
 *   - "List of customers" tab: rep's customer roster
 *
 * We pull Calculation + open invoices and merge into one per-invoice map
 * keyed by invoice number (lowercased). This becomes the SOURCE OF TRUTH
 * for commission inputs: rep, order type, business type, tax, shipping,
 * PureX fee, and net amount.
 */

const WORKBOOKS = [
 // Single consolidated commission workbook. Its "Calculation" tab merges all
 // reps (Joe, Dave, Johan, Ken, Manny); the per-row Owner column carries the
 // actual rep, so workbookLabel is only a fallback.
 { id: '18vKzOOOrSIArbr1Enz66RDnjaj6n1ULA', label: 'Consolidated' },
];

export type PerRepCommissionRow = {
 invoiceNumber: string;
 invoiceDate: string;         // YYYY-MM-DD (normalised)
 account: string;
 invoiceAmount: number;
 status: string;              // Paid / Open / UnderPaid / Write off / cancelled
 paidDate: string;
 paidAmount: number;
 paidMonthLabel: string;
 difference: number;
 tax: number;
 pureXFee: number;
 shipping: number;
 netAmount: number;           // sheet's calculated net (Invoice - Tax - PureX - Shipping)
 orderType: string;           // "White label" or blank
 businessType: string;        // "Old Business" / "New business" / blank
 owner: string;               // rep name from sheet (normalized below)
 ownerCanonical: string;      // canonical rep (Manny / Dave / Johan / Joe P / Ken)
 sheetCommission: number;     // sheet's calculated commission amount (whichever Calc rate applied)
 differentialCommission: number;
 sourceWorkbook: string;      // which rep workbook this came from
 isOpen: boolean;             // came from "open invoices" tab vs Calculation tab
};

export type PerRepCommissionResult = {
 fetchedAt: string;
 byInvoice: Record<string, PerRepCommissionRow>;
 /** Customer key (lowercased, stripped) -> set of reps that flagged this
  *  customer as Whitelabel. Helps cross-pollinate WL across reps. */
 whitelabelCustomers: Array<{ key: string; sampleName: string; flaggedByReps: string[] }>;
 stats: {
   workbooks: number;
   rowsParsed: number;
   whitelabelRowsFound: number;
 };
};

function parseCsv(text: string): string[][] {
 const rows: string[][] = [];
 let cur: string[] = [];
 let field = '';
 let inQ = false;
 for (let i = 0; i < text.length; i++) {
   const c = text[i];
   if (inQ) {
     if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
     else field += c;
   } else {
     if (c === '"') inQ = true;
     else if (c === ',') { cur.push(field); field = ''; }
     else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
     else if (c !== '\r') field += c;
   }
 }
 if (field || cur.length) { cur.push(field); rows.push(cur); }
 return rows;
}

function money(s: string): number {
 const t = (s || '').replace(/[$,\s()]/g, '');
 if (!t || t === '-') return 0;
 const n = Number(t);
 return Number.isFinite(n) ? n : 0;
}

/** "01-21-2025" / "1/21/2025" / "2025-01-21" → "2025-01-21" */
function normaliseDate(s: string): string {
 const t = (s || '').trim();
 if (!t) return '';
 const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
 if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
 // MM-DD-YYYY or MM/DD/YYYY
 const m = t.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);
 if (!m) return '';
 const mo = Number(m[1]);
 const d = Number(m[2]);
 let yr = Number(m[3]);
 if (m[3].length === 2) yr = 2000 + yr;
 if (mo < 1 || mo > 12 || d < 1 || d > 31 || yr < 1900) return '';
 return `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function canonicaliseRep(raw: string): string {
 const u = (raw || '').toUpperCase().trim().split(/[\/,]/)[0].trim();
 if (/^MANNY/.test(u)) return 'Manny';
 if (/^DAV/.test(u)) return 'Dave';
 if (/^JOE/.test(u)) return 'Joe';
 if (/^JOHAN/.test(u)) return 'Johan';
 if (/^KEN\b/.test(u)) return 'Ken';
 return raw.trim();
}

// ---- Summary tab: section "B. Monthly Commission by Rep" ----
// This pre-built matrix (Paid Month rows × rep columns) is the team's source of
// truth for the rep-wise monthly commission - it folds in carryover, bonuses and
// manual adjustments that the per-invoice Calculation tab can't reproduce. We
// read it verbatim so the dashboard matches the team's numbers exactly.
const MONTH_NUM: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function summaryLabelToYm(label: string): { ym: string; label: string } | null {
 const t = (label || '').trim();
 if (!t) return null;
 if (/carry/i.test(t)) return { ym: 'CARRYOVER', label: t };
 const m = t.match(/([A-Za-z]{3})[A-Za-z]*['’]?\s*(\d{2,4})/);
 if (!m) return null;
 const mm = MONTH_NUM[m[1].toLowerCase()];
 if (!mm) return null;
 let y = m[2];
 if (y.length === 2) y = '20' + y;
 return { ym: `${y}-${mm}`, label: `${m[1].charAt(0).toUpperCase()}${m[1].slice(1).toLowerCase()} ${y.slice(2)}` };
}

export type CommissionSummary = {
 reps: string[];
 months: Array<{ ym: string; label: string }>;
 byRep: Record<string, Record<string, number>>;   // rep -> ym -> commission
 totalsByRep: Record<string, number>;
 grandTotal: number;
};

let _summaryCache: { at: number; data: CommissionSummary } | null = null;
export function invalidateCommissionSummaryCache(): void { _summaryCache = null; }

export async function getCommissionSummary(opts: { force?: boolean } = {}): Promise<CommissionSummary> {
 if (!opts.force && _summaryCache && Date.now() - _summaryCache.at < CACHE_TTL_MS) return _summaryCache.data;
 const id = WORKBOOKS[0].id;
 const empty: CommissionSummary = { reps: [], months: [], byRep: {}, totalsByRep: {}, grandTotal: 0 };
 try {
   const tabs = await fetchTabs(id);
   const summaryTab = tabs.find((t) => /^summary/i.test(t.name));
   if (!summaryTab) return empty;
   const rows = await fetchCsv(id, summaryTab.gid);
   const hdrIdx = rows.findIndex((r) => /^paid\s*month$/i.test((r[0] || '').trim()));
   if (hdrIdx < 0) return empty;
   const hdr = rows[hdrIdx];
   // Rep columns sit between "Paid Month" (col 0) and the trailing "Total" col.
   const reps: string[] = [];
   const repCol: Record<string, number> = {};
   for (let c = 1; c < hdr.length; c++) {
     const name = (hdr[c] || '').trim();
     if (!name || /^total$/i.test(name)) break;
     reps.push(name);
     repCol[name] = c;
   }
   const months: Array<{ ym: string; label: string }> = [];
   const byRep: Record<string, Record<string, number>> = {};
   const totalsByRep: Record<string, number> = {};
   reps.forEach((r) => { byRep[r] = {}; totalsByRep[r] = 0; });
   let grandTotal = 0;
   for (let i = hdrIdx + 1; i < rows.length; i++) {
     const r = rows[i];
     const label = (r[0] || '').trim();
     if (!label) continue;
     if (/^total commission/i.test(label) || /^total\b/i.test(label)) {
       for (const rep of reps) totalsByRep[rep] = money(r[repCol[rep]] || '');
       const totalCol = hdr.findIndex((h) => /^total$/i.test((h || '').trim()));
       grandTotal = totalCol >= 0 ? money(r[totalCol] || '') : reps.reduce((s, rp) => s + totalsByRep[rp], 0);
       break;
     }
     const mapped = summaryLabelToYm(label);
     if (!mapped) continue;
     months.push(mapped);
     for (const rep of reps) byRep[rep][mapped.ym] = money(r[repCol[rep]] || '');
   }
   if (!grandTotal) grandTotal = reps.reduce((s, rp) => s + totalsByRep[rp], 0);
   const data: CommissionSummary = { reps, months, byRep, totalsByRep, grandTotal };
   _summaryCache = { at: Date.now(), data };
   return data;
 } catch (e) {
   console.error('[commissionSummary] failed:', e instanceof Error ? e.message : '?');
   return empty;
 }
}

function customerKey(account: string): string {
 return (account || '')
   .toLowerCase()
   .replace(/^little tree[-\s]+/i, '')
   .replace(/\b(inc|llc|l\.l\.c\.?|inc\.|ltd|co\.?|corp|corporation)\b\.?/g, '')
   .replace(/[.,]/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();
}

async function fetchTabs(id: string): Promise<Array<{ name: string; gid: string }>> {
 const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/htmlview`, { redirect: 'follow' });
 if (!res.ok) throw new Error(`htmlview HTTP ${res.status}`);
 const html = await res.text();
 return [...html.matchAll(/items\.push\(\{name:\s*"([^"]+)"[^,]*,\s*pageUrl:[^,]+,\s*gid:\s*"(\d+)"/g)]
   .map((m) => ({ name: m[1], gid: m[2] }));
}

async function fetchCsv(id: string, gid: string): Promise<string[][]> {
 const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`, { redirect: 'follow' });
 if (!res.ok) throw new Error(`csv HTTP ${res.status}`);
 return parseCsv(await res.text());
}

function parseCalcTab(rows: string[][], workbookLabel: string, isOpen: boolean): PerRepCommissionRow[] {
 const out: PerRepCommissionRow[] = [];
 if (rows.length < 2) return out;
 // Header isn't always row 0 - the consolidated workbook has 2 title rows
 // above it. Scan the first 10 rows for the one containing the "Inv #" cell.
 const hdrIdx = rows.slice(0, 10).findIndex((r) => r.some((c) => /^inv\s*#$/i.test((c || '').trim())));
 if (hdrIdx < 0) return out;
 const hdr = rows[hdrIdx].map((h) => (h || '').trim().toLowerCase());
 const idx = {
   inv:       hdr.findIndex((h) => /^inv\s*#$/i.test(h)),
   date:      hdr.findIndex((h) => /^invoice\s*date$/i.test(h)),
   account:   hdr.findIndex((h) => /^account$/i.test(h)),
   amount:    hdr.findIndex((h) => /^invoice\s*amount$/i.test(h)),
   status:    hdr.findIndex((h) => /^status$/i.test(h)),
   paidDate:  hdr.findIndex((h) => /^paid\s*date$/i.test(h)),
   paidAmt:   hdr.findIndex((h) => /^paid\s*amount$/i.test(h)),
   paidMo:    hdr.findIndex((h) => /^paid\s*month$/i.test(h)),
   diff:      hdr.findIndex((h) => /^diff(erence)?\b/i.test(h)),
   tax:       hdr.findIndex((h) => /^tax/i.test(h)),
   pureX:     hdr.findIndex((h) => /pure\s*x\s*fee/i.test(h)),
   shipping:  hdr.findIndex((h) => /shipping/i.test(h)),
   net:       hdr.findIndex((h) => /net\s*amount/i.test(h)),
   orderType: hdr.findIndex((h) => /order\s*type/i.test(h)),
   bizType:   hdr.findIndex((h) => /business\s*type/i.test(h)),
   owner:     hdr.findIndex((h) => /^owner$/i.test(h)),
   commAmt:   hdr.findIndex((h) => /^commission\s*amount/i.test(h)),
   diffComm:  hdr.findIndex((h) => /differential/i.test(h)),
 };
 if (idx.inv < 0) return out;
 for (let i = hdrIdx + 1; i < rows.length; i++) {
   const r = rows[i];
   const invNum = (r[idx.inv] || '').trim();
   if (!invNum) continue;
   out.push({
     invoiceNumber: invNum,
     invoiceDate: normaliseDate(r[idx.date] || ''),
     account: (r[idx.account] || '').trim(),
     invoiceAmount: money(r[idx.amount] || ''),
     status: (r[idx.status] || '').trim(),
     paidDate: normaliseDate(r[idx.paidDate] || ''),
     paidAmount: money(r[idx.paidAmt] || ''),
     paidMonthLabel: (r[idx.paidMo] || '').trim(),
     difference: money(r[idx.diff] || ''),
     tax: money(r[idx.tax] || ''),
     pureXFee: money(r[idx.pureX] || ''),
     shipping: money(r[idx.shipping] || ''),
     netAmount: money(r[idx.net] || ''),
     orderType: (r[idx.orderType] || '').trim(),
     businessType: (r[idx.bizType] || '').trim(),
     owner: (r[idx.owner] || '').trim() || workbookLabel,
     ownerCanonical: canonicaliseRep((r[idx.owner] || '').trim() || workbookLabel),
     sheetCommission: money(r[idx.commAmt] || ''),
     differentialCommission: money(r[idx.diffComm] || ''),
     sourceWorkbook: workbookLabel,
     isOpen,
   });
 }
 return out;
}

// --- Cache (60s TTL) ---
let _cache: { at: number; data: PerRepCommissionResult } | null = null;
const CACHE_TTL_MS = 60 * 1000;
export function invalidatePerRepCommissionCache(): void { _cache = null; }

export async function getPerRepCommissionWorkbooks(opts: { force?: boolean } = {}): Promise<PerRepCommissionResult> {
 if (!opts.force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;

 const byInvoice: Record<string, PerRepCommissionRow> = {};
 const wlMap = new Map<string, { sampleName: string; reps: Set<string> }>();
 let rowsParsed = 0, wlRows = 0;

 for (const wb of WORKBOOKS) {
   try {
     const tabs = await fetchTabs(wb.id);
     const calcTab = tabs.find((t) => /^calculation/i.test(t.name));
     const openTab = tabs.find((t) => /^open\s*invoices/i.test(t.name));

     const toMerge: PerRepCommissionRow[] = [];
     if (calcTab) {
       const rows = await fetchCsv(wb.id, calcTab.gid);
       toMerge.push(...parseCalcTab(rows, wb.label, false));
     }
     if (openTab) {
       const rows = await fetchCsv(wb.id, openTab.gid);
       toMerge.push(...parseCalcTab(rows, wb.label, true));
     }

     for (const row of toMerge) {
       const key = row.invoiceNumber.toLowerCase();
       // Last-write wins (newer sheets overwrite older), but in practice each
       // invoice appears in only one rep's workbook.
       byInvoice[key] = row;
       rowsParsed += 1;
       const isWl = /white\s*label/i.test(row.orderType);
       if (isWl) {
         wlRows += 1;
         const ck = customerKey(row.account);
         if (ck) {
           const slot = wlMap.get(ck) ?? { sampleName: row.account, reps: new Set<string>() };
           slot.reps.add(row.ownerCanonical || wb.label);
           wlMap.set(ck, slot);
         }
       }
     }
   } catch (e) {
     // Skip a workbook on error - log so devs can debug.
     console.error(`[perRepCommissionWorkbooks] ${wb.label} failed:`, e instanceof Error ? e.message : '?');
   }
 }

 const whitelabelCustomers = [...wlMap.entries()]
   .map(([key, v]) => ({ key, sampleName: v.sampleName, flaggedByReps: [...v.reps].sort() }))
   .sort((a, b) => a.sampleName.localeCompare(b.sampleName));

 const result: PerRepCommissionResult = {
   fetchedAt: new Date().toISOString(),
   byInvoice,
   whitelabelCustomers,
   stats: {
     workbooks: WORKBOOKS.length,
     rowsParsed,
     whitelabelRowsFound: wlRows,
   },
 };
 _cache = { at: Date.now(), data: result };
 return result;
}

/** Returns the customer-key matcher used internally so callers can apply
 *  the same normalisation when looking up whitelabel customers. */
export function customerKeyForWhitelabel(name: string): string {
 return customerKey(name);
}
