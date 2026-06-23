/**
 * Tiller Transactions - pulls per-transaction history from the user's Tiller
 * Money sheet (Transactions tab, gid=1847788845) and bifurcates by source
 * account / entity.
 *
 * Sheet columns:
 * Date | Amount | Business (payee) | Category | TransactionID | Account | Status
 *
 * Used to attribute spend back to a specific bank/CC source so cashflow,
 * dashboard, and reconciliation views can answer "kon kis se hua hai".
 */

const TILLER_SHEET_ID = '1fKuOmTrZX_DWKzYsDhBfmfHZ0KZg-YxhFKao_j8Vj6E';
const TXNS_GID = '1847788845';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${TILLER_SHEET_ID}/export?format=csv&gid=${TXNS_GID}`;

/** Hard cutoff - only include transactions from this date onwards. Pre-2025
 * Tiller data is from before the business reorg / QB setup, not relevant. */
const FIXED_START_DATE = '2025-01-01';

export type Entity = 'Moysh-Business' | 'Moysh-CC' | 'Personal' | 'Other';

export type TillerTxn = {
 date: string; // YYYY-MM-DD
 amount: number; // signed; outflow negative, inflow positive
 payee: string;
 category: string;
 txnId: string;
 account: string; // raw account name from sheet
 status: string;
 entity: Entity; // derived bifurcation
};

export type TxnsByAccountMonth = {
 account: string;
 entity: Entity;
 inQb: boolean; // true ⇔ this account exists in QB's chart of accounts
 monthlyOutflow: Record<string, number>; // YYYY-MM → sum of negatives (abs)
 monthlyInflow: Record<string, number>; // YYYY-MM → sum of positives
 txnCount: number;
};

export type TillerTransactionsResult = {
 fetchedAt: string;
 rowCount: number;
 /** Distinct accounts seen, sorted by total outflow magnitude. */
 accounts: TxnsByAccountMonth[];
 months: string[]; // YYYY-MM keys present in data
 /** All transactions (filterable client-side). */
 transactions: TillerTxn[];
};

// --- CSV parsing (RFC 4180-ish - handles quoted fields with commas/newlines) ---

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

/** "$ (123.45)" → -123.45, "$ 67.89" → 67.89, "" → 0 */
function parseTillerAmount(s: string): number {
 const t = (s ?? '').trim();
 if (!t) return 0;
 const neg = /\(.*\)/.test(t);
 const cleaned = t.replace(/[\$,()\s]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 if (!Number.isFinite(n)) return 0;
 return neg ? -n : n;
}

/**
 * Classify each Tiller account into a high-level entity bucket:
 * - Moysh-Business → business bank accounts (CRB, Business MM, Regular Chk, etc.)
 * - Moysh-CC → corporate credit cards (Chase, Signature, Blue Business, Delta, Amex, Citi)
 * - Personal → personal accounts (Personal MM, New Personal MM)
 * - Other → anything else (Transfers In/Out, Income, etc. - sheet artifacts)
 */
function classifyAccount(account: string): Entity {
 const n = (account ?? '').toLowerCase();
 if (!n) return 'Other';
 // CCs
 if (/credit card|signature|blue business|delta gold|amex|everyday|citi|chase|mc consumer|fnbo/.test(n)) return 'Moysh-CC';
 // Personal
 if (/personal/.test(n)) return 'Personal';
 // Business banks
 if (/crb indirect|business mm|regular chk|total checking|7561|0910|moysh|checking/.test(n)) return 'Moysh-Business';
 return 'Other';
}

/**
 * Tiller account names that exist in QB's chart of accounts (Bank + Credit Card).
 * Accounts NOT in this whitelist (e.g. Regular Chk, New Regular Chk, TOTAL CHECKING,
 * Personal MM, New Personal MM) are stale/personal and shouldn't appear in the
 * Reports tabs that show QB-linked cash + cards.
 */
const QB_KNOWN_TILLER_ACCOUNTS: RegExp[] = [
 // Business banks
 /^crb indirect/i,
 /^business mm/i,
 // Credit cards
 /^credit card$/i, // Chase 4158/0715 (Tiller groups both as "CREDIT CARD")
 /signature\s*[·・]?\s*6037/i,
 /blue business plus/i,
 /delta gold business/i,
 /amex\s*everyday/i,
 /citi double cash/i,
 /citi strata/i,
 /mc consumer/i,
];

function isInQb(account: string): boolean {
 return QB_KNOWN_TILLER_ACCOUNTS.some((re) => re.test(account));
}

/**
 * Identify intercompany / internal-transfer rows that aren't real bank
 * spend or income - they're just money moving between Moysh ↔ PureX or
 * between two of our own accounts. Excluded from Bank/CC report tabs so
 * "kahaan kharcha hua" totals reflect only true external spend.
 */
function isIntercompanyOrTransfer(category: string, payee: string): boolean {
 const c = (category ?? '').toLowerCase();
 if (c === 'transfers in' || c === 'transfers out' || c === 'transfer') return true;
 const p = (payee ?? '').toLowerCase();
 if (/purex|intercompany|due (to|from)/.test(p)) return true;
 return false;
}

// --- Module cache (60s TTL) - Tiller Money sheet syncs frequently and the
// client polls the Reports page every minute, so a short TTL keeps Bank /
// CC / Reconciliation views live without re-fetching the CSV on every hit.

let _cache: { at: number; data: TillerTransactionsResult } | null = null;
let _inFlight: Promise<TillerTransactionsResult> | null = null;
const _CACHE_TTL_MS = 60 * 1000;

export function invalidateTillerTransactionsCache(): void { _cache = null; }

export async function getTillerTransactions(): Promise<TillerTransactionsResult> {
 if (_cache && Date.now() - _cache.at < _CACHE_TTL_MS) return _cache.data;
 if (_inFlight) return _inFlight;
 _inFlight = (async () => {
 try { return await _fetchAndParse(); }
 finally { _inFlight = null; }
 })();
 const data = await _inFlight;
 if (data.rowCount > 0) _cache = { at: Date.now(), data };
 return data;
}

async function _fetchAndParse(): Promise<TillerTransactionsResult> {
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Tiller transactions fetch failed: ${res.status}`);
 const text = await res.text();
 const rows = parseCsv(text);
 if (rows.length < 2) {
 return { fetchedAt: new Date().toISOString(), rowCount: 0, accounts: [], months: [], transactions: [] };
 }

 // Header row defines column order - be defensive about spacing/case.
 const header = rows[0].map((h) => h.trim().toLowerCase());
 const iDate = header.findIndex((h) => h === 'date');
 const iAmt = header.findIndex((h) => h === 'amount');
 const iPayee = header.findIndex((h) => h === 'business' || h === 'description');
 const iCat = header.findIndex((h) => h === 'category');
 const iId = header.findIndex((h) => h === 'transactionid');
 const iAcct = header.findIndex((h) => h === 'account');
 const iStatus = header.findIndex((h) => h === 'status');
 if (iDate < 0 || iAmt < 0 || iAcct < 0) {
 throw new Error(`Tiller transactions missing required columns. Got header: ${header.join(' | ')}`);
 }

 const transactions: TillerTxn[] = [];
 const monthsSet = new Set<string>();
 // Per-(account, month) accumulators
 const perAcct = new Map<string, TxnsByAccountMonth>();
 // Dedupe set: Tiller's CSV occasionally surfaces the same posting twice
 // (auto-import overlap, re-categorisation). Prefer Tiller's transactionId
 // when present; fall back to a content hash for rows missing one.
 const seenKeys = new Set<string>();
 let duplicatesDropped = 0;

 for (let r = 1; r < rows.length; r++) {
 const row = rows[r];
 const date = (row[iDate] ?? '').trim();
 if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skip malformed
 if (date < FIXED_START_DATE) continue; // skip pre-2025
 const amount = parseTillerAmount(row[iAmt] ?? '');
 if (amount === 0) continue;
 const payee = (row[iPayee] ?? '').trim();
 const category = iCat >= 0 ? (row[iCat] ?? '').trim() : '';
 const txnId = iId >= 0 ? (row[iId] ?? '').trim() : '';
 const account = (row[iAcct] ?? '').trim();
 if (!account) continue;
 const status = iStatus >= 0 ? (row[iStatus] ?? '').trim() : '';
 // Skip intercompany / PureX clearing rows - they aren't real spend or
 // income (just money moving between our own accounts).
 if (isIntercompanyOrTransfer(category, payee)) continue;
 // Dedupe: use Tiller's txnId when present; else fall back to a content
 // hash that's stable across re-imports of the same posting.
 const dedupeKey = txnId
 ? `id:${txnId}`
 : `c:${date}|${amount.toFixed(2)}|${account.toLowerCase()}|${payee.toLowerCase()}`;
 if (seenKeys.has(dedupeKey)) { duplicatesDropped++; continue; }
 seenKeys.add(dedupeKey);

 const entity = classifyAccount(account);
 const ym = date.slice(0, 7);
 monthsSet.add(ym);

 transactions.push({ date, amount, payee, category, txnId, account, status, entity });

 let acc = perAcct.get(account);
 if (!acc) {
 acc = { account, entity, inQb: isInQb(account), monthlyOutflow: {}, monthlyInflow: {}, txnCount: 0 };
 perAcct.set(account, acc);
 }
 acc.txnCount += 1;
 if (amount < 0) acc.monthlyOutflow[ym] = (acc.monthlyOutflow[ym] ?? 0) + Math.abs(amount);
 else acc.monthlyInflow[ym] = (acc.monthlyInflow[ym] ?? 0) + amount;
 }

 if (duplicatesDropped > 0) {
 console.log(`[tiller] Dropped ${duplicatesDropped} duplicate transaction row(s).`);
 }

 const months = [...monthsSet].sort();
 const accounts = [...perAcct.values()].sort((a, b) => {
 const aTot = Object.values(a.monthlyOutflow).reduce((s, v) => s + v, 0);
 const bTot = Object.values(b.monthlyOutflow).reduce((s, v) => s + v, 0);
 return bTot - aTot;
 });

 // Round currency values for cleaner JSON.
 for (const a of accounts) {
 for (const k of Object.keys(a.monthlyOutflow)) a.monthlyOutflow[k] = +a.monthlyOutflow[k].toFixed(2);
 for (const k of Object.keys(a.monthlyInflow)) a.monthlyInflow[k] = +a.monthlyInflow[k].toFixed(2);
 }

 return {
 fetchedAt: new Date().toISOString(),
 rowCount: transactions.length,
 accounts,
 months,
 transactions,
 };
}
