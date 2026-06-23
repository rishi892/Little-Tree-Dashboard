/**
 * Bank ↔ QB Reconciliation - matches actual Tiller bank movements against
 * QB-booked expenses to produce three buckets:
 *
 * ✅ matched - Tiller tx linked to a QB entry (shows the QB category)
 * 🟡 bankOnly - Money moved from bank, but no QB entry recorded
 * 🟡 qbOnly - QB entry exists, but no bank movement found
 *
 * Matching algorithm (deterministic, conservative):
 * 1. Outflows only - we care about spend categorization
 * 2. For each Tiller tx, look for QB rows with same amount within ±N days
 * 3. Prefer the candidate whose QB source-bank name maps to the Tiller account
 * 4. If exactly one candidate left → MATCH, mark QB row used
 * 5. Leftover Tiller rows → bankOnly; leftover QB rows → qbOnly
 *
 * QB-side data: Purchase (direct CC/bank spend), BillPayment (deferred bill
 * clearing), Check (manual check writing). Pure accrual Bills are NOT counted
 * on the QB side - only payment events, which is what should mirror a bank
 * movement.
 */

import { QBO_API_BASE } from './config.js';
import { getValidAccessToken } from './oauth.js';
import { getTillerTransactions } from './tillerTransactions.js';

type Ref = { value: string; name?: string };

type QbPurchase = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 AccountRef?: Ref;
 EntityRef?: Ref & { type?: string };
 PrivateNote?: string;
 Line?: Array<{
 Amount?: number;
 Description?: string;
 AccountBasedExpenseLineDetail?: { AccountRef?: Ref };
 }>;
};

type QbBillPayment = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 PayType?: 'Check' | 'CreditCard';
 CheckPayment?: { BankAccountRef?: Ref };
 CreditCardPayment?: { CCAccountRef?: Ref };
 VendorRef?: Ref;
 PrivateNote?: string;
};

type QbCheck = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 AccountRef?: Ref;
 EntityRef?: Ref & { type?: string };
 PrivateNote?: string;
 Line?: Array<{
 Amount?: number;
 Description?: string;
 AccountBasedExpenseLineDetail?: { AccountRef?: Ref };
 }>;
};

/** Unified per-row shape used by all three buckets. */
export type ReconciledRow = {
 date: string; // YYYY-MM-DD (Tiller's date for matched/bankOnly; QB date for qbOnly)
 amount: number; // positive - outflow magnitude
 sourceBank: string; // Tiller account name (matched/bankOnly) or QB source account name (qbOnly)
 sourceKind?: 'bank' | 'cc' | 'other'; // bank vs credit card classification
 payee: string;
 qbCategory?: string; // populated for matched and qbOnly
 qbTxnId?: string; // populated for matched and qbOnly
 tillerTxnId?: string; // populated for matched and bankOnly
 daysDiff?: number; // |Tiller date − QB date| in days (matched only)
 /** Grouping label for QB-only entries (journal/capex/bill-payment/real-expense) */
 qbCategoryGroup?: 'journal' | 'capex' | 'bill-payment' | 'real-expense';
};

export type CategoryAttribution = {
 category: string;             // raw QB category name (kept simple - same format as the row tables)
 bankPaid: number; // total across all months - outflow paid from bank accounts
 ccPaid: number; // total - outflow paid from credit cards
 total: number;
 txnCount: number;
 monthly: Record<string, { bank: number; cc: number; total: number }>; // YYYY-MM → split
};

export type ReconciliationResult = {
 asOf: string;
 windowStart: string;
 matchDays: number;
 counts: {
 matched: number;
 bankOnly: number;
 transfers: number;        // intercompany / CC payoff rows, split out of bank-only
 qbOnly: number;
 tillerTotal: number;
 tillerDuplicatesDropped: number;
 qbTotal: number;
 };
 totals: { matched: number; bankOnly: number; transfers: number; qbOnly: number };
 matched: ReconciledRow[];
 bankOnly: ReconciledRow[];
 transfers: ReconciledRow[];   // CC payments, bank→bank transfers - not real spend
 qbOnly: ReconciledRow[];
 /** Per-QB-category pivot showing Bank vs CC paid amounts (matched rows only).
 * Answers "Inventory: March me bank se $X, CC se $Y". */
 categoryAttribution: CategoryAttribution[];
 /** Months covered by `categoryAttribution.monthly`, oldest first. */
 attributionMonths: string[];
 warnings: string[];
};

// --- QB query helper ---

async function qboQuery<T>(query: string, accessToken: string, realmId: string, key: string): Promise<T[]> {
 const all: T[] = [];
 const pageSize = 1000;
 let start = 1;
 while (true) {
 const q = `${query} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
 const url = `${QBO_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=70`;
 const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
 if (!res.ok) throw new Error(`QBO ${res.status}: ${await res.text()}`);
 const data = (await res.json()) as { QueryResponse: Record<string, T[]> };
 const batch = data.QueryResponse[key] ?? [];
 all.push(...batch);
 if (batch.length < pageSize) break;
 start += pageSize;
 }
 return all;
}

/**
 * Tiller's transaction-tab account names are SIMPLIFIED (no 4-digit masks)
 * but the Tiller Accounts tab and QB both carry full names with masks. This
 * table is the source-of-truth alias the user confirmed: every Tiller short
 * name maps to one or more QB masks. Wherever a row mentions a mask we can
 * match through it; for rows without a mask we still reconcile because the
 * alias map fills the gap.
 *
 * Verified via Linked Balances (Current Status page):
 *   CRB Indirect              ·7561 → Basic Business Checking (7561)
 *   Business MM               ·0910 → Business Money Market (0910)
 *   CREDIT CARD (Chase)       ·4158/0715 → CREDIT CARD (4158) - 1 / (7566) - 1
 *   Blue Business Plus Card   ·1009 → AMEX 81009 (mask 1009)
 *   Delta Gold Business Card  ·1007 → AMEX 11007 (mask 1007)
 *   Amex EveryDay® Card       (no mask) → AMEX 71006 (the only AMEX left)
 *   Citi Double Cash® Card    → Citi 0744
 *   Citi Strata℠ Card         → Citi 4267
 *   Signature・6037            → MC Consumer 4362 (Signature = Mastercard brand)
 *   MC Consumer               ·4362 → MC Consumer 4362
 */
const TILLER_TO_QB_ALIASES: Array<{ tiller: RegExp; qbMatch: RegExp }> = [
 { tiller: /^crb\s*indirect/i,                       qbMatch: /basic\s*business\s*checking|7561/i },
 { tiller: /^business\s*mm/i,                        qbMatch: /business\s*money\s*market|0910/i },
 { tiller: /^credit\s*card$/i,                       qbMatch: /credit\s*card|4158|7566|0715/i },
 { tiller: /^blue\s*business\s*plus/i,               qbMatch: /amex\s*81009|1009/i },
 { tiller: /^delta\s*gold\s*business/i,              qbMatch: /amex\s*11007|1007/i },
 { tiller: /^amex\s*everyday/i,                      qbMatch: /amex\s*71006|everyday/i },
 { tiller: /^citi\s*double\s*cash/i,                 qbMatch: /citi\s*0744|double\s*cash/i },
 { tiller: /^citi\s*strata/i,                        qbMatch: /citi\s*4267|strata/i },
 { tiller: /^signature\s*[·・]?\s*6037/i,             qbMatch: /mc\s*consumer|4362|6037/i },
 { tiller: /^mc\s*consumer/i,                        qbMatch: /mc\s*consumer|4362/i },
];
function bankNamesEquivalent(tillerName: string, qbName: string): boolean {
 if (!tillerName || !qbName) return false;
 // First try mask-based matching (cheap + universal when both have digits).
 const tMasks: string[] = tillerName.match(/\d{4}/g) ?? [];
 const qMasks: string[] = qbName.match(/\d{4}/g) ?? [];
 for (const m of tMasks) if (qMasks.includes(m)) return true;
 // Then the user-confirmed aliases - these handle the case where the
 // simplified Tiller transaction name has no mask in it.
 for (const a of TILLER_TO_QB_ALIASES) {
   if (a.tiller.test(tillerName) && a.qbMatch.test(qbName)) return true;
 }
 return false;
}

/**
 * Classify a QB-only category into a meaningful group so the user can scan
 * the un-matched list quickly. Mirrors the PureX vs Moysh mental model the
 * user uses elsewhere - group things by their NATURE so accountants don't
 * have to read each row.
 *
 *   journal      → balance-sheet moves, not cash spend
 *                  (Shareholders equity, Long-term investments, equity contrib)
 *   capex        → capitalized cost / capital expenditure (R&D Raw mat etc.)
 *   bill-payment → generic QB BillPayment with no detailed category
 *   real-expense → genuine expense Tiller likely missed (Upwork, payroll, etc.)
 */
function classifyQbOnlyCategory(category: string): 'journal' | 'capex' | 'bill-payment' | 'real-expense' {
 const c = (category ?? '').toLowerCase();
 if (!c || c === '(uncategorized)') return 'real-expense';
 if (c === '(bill payment)') return 'bill-payment';
 if (/shareholder|equity|distribution|contribution|owner\s*draw|partner|capital/i.test(c)) return 'journal';
 if (/long[-\s]*term\s*invest|investment|property|fixed\s*asset|capex|capital\s*expen/i.test(c)) return 'capex';
 if (/research\s*and\s*development|r\s*&\s*d|raw\s*mat/i.test(c)) return 'capex';
 return 'real-expense';
}

function firstLineCategory(lines: QbPurchase['Line']): { category: string; memo: string } {
 const ln = (lines ?? [])[0];
 const acc = ln?.AccountBasedExpenseLineDetail?.AccountRef;
 return { category: acc?.name ?? '', memo: ln?.Description ?? '' };
}

/** Bank vs CC classification of a Tiller / QB source account name. */
function classifySource(name: string): 'bank' | 'cc' | 'other' {
 const n = (name ?? '').toLowerCase();
 if (!n) return 'other';
 if (/credit card|signature|blue business|delta gold|amex|everyday|citi|chase|mc consumer|fnbo|card/.test(n)) return 'cc';
 if (/crb|checking|business mm|money market|7561|0910|chk/.test(n)) return 'bank';
 return 'other';
}

/**
 * Detect bank rows that are intercompany cash MOVEMENTS rather than real spend:
 *   - ACH payments from a bank to pay a credit card balance (CC payoff)
 *   - Inter-account transfers (bank → bank)
 * These should NOT appear in "bank-only / needs to be booked" because they
 * have no expense category - they're cash moving from one of YOUR accounts
 * to another. The QB side books them as Transfer entries which we don't
 * query (and don't need to - the spend they ultimately cover IS already
 * booked as a Purchase on the credit-card account side).
 */
function isInterCompanyMovement(payee: string, sourceAccount: string, sourceKind: 'bank' | 'cc' | 'other'): boolean {
 const p = (payee ?? '').toLowerCase();
 // CC payment from a bank account ("ACH Payment CHASE CREDIT CRD EPAY", "AMEX EPAYMENT ACH PMT" etc).
 if (sourceKind === 'bank' && /\b(ach\s*payment|epayment|epay|crd\s*pmt|card\s*pmt|payment\s*to)\b/i.test(p) && /credit|chase|amex|capital|citi|discover|card/i.test(p)) {
   return true;
 }
 // Generic transfer language.
 if (/\b(transfer|tnsfr|book\s*transfer|wire\s*transfer|intra\s*company|intercompany)\b/i.test(p)) {
   return true;
 }
 // Account-side hint: CRB Indirect is the user's clearing account that almost
 // exclusively moves money to credit cards / other internal accounts.
 if (/crb\s*indirect/i.test(sourceAccount) && /ach\s*payment/i.test(p)) {
   return true;
 }
 return false;
}

/** De-duplicate Tiller transactions where the same (date, amount, account, payee)
 *  appears multiple times with different txnIds. Tiller sometimes emits both the
 *  posting and the pending row, or the same charge from two angles. Keep the
 *  first occurrence and drop the rest. */
function dedupeBankTxns<T extends { date: string; amount: number; account: string; payee: string; txnId: string }>(arr: T[]): T[] {
 const seen = new Set<string>();
 const out: T[] = [];
 for (const t of arr) {
   const key = `${t.date}|${Math.round(Math.abs(t.amount) * 100)}|${t.account.toLowerCase()}|${(t.payee || '').trim().toLowerCase()}`;
   if (seen.has(key)) continue;
   seen.add(key);
   out.push(t);
 }
 return out;
}

/** Tokenise a payee/vendor string for fuzzy comparison. */
function payeeTokens(s: string): Set<string> {
 return new Set(
 (s ?? '')
 .toLowerCase()
 .replace(/[^a-z0-9 ]/g, ' ')
 .split(/\s+/)
 .filter((t) => t.length >= 3 && !/^(the|llc|inc|ltd|corp|com|payment|ach|ccd|web|pos|debit)$/.test(t)),
 );
}
function payeeMatchScore(a: string, b: string): number {
 const A = payeeTokens(a);
 const B = payeeTokens(b);
 if (A.size === 0 || B.size === 0) return 0;
 let hits = 0;
 for (const t of A) if (B.has(t)) hits++;
 return hits / Math.min(A.size, B.size);
}

// --- Module cache (30-min) ---

let _cache: { at: number; data: ReconciliationResult } | null = null;
let _inFlight: Promise<ReconciliationResult> | null = null;
const _CACHE_TTL_MS = 30 * 60 * 1000;

export function invalidateReconciliationCache(): void { _cache = null; }

export async function getReconciliation(): Promise<ReconciliationResult> {
 if (_cache && Date.now() - _cache.at < _CACHE_TTL_MS) return _cache.data;
 if (_inFlight) return _inFlight;
 _inFlight = (async () => {
 try { return await _build(); }
 finally { _inFlight = null; }
 })();
 const data = await _inFlight;
 if (data.matched.length + data.bankOnly.length + data.qbOnly.length > 0) {
 _cache = { at: Date.now(), data };
 }
 return data;
}

const MATCH_DAYS = 10; // widened to ±10d to catch slow check / ACH clearings
const FIXED_START_DATE = '2025-01-01'; // hard floor - match nothing earlier
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function _build(): Promise<ReconciliationResult> {
 const warnings: string[] = [];

 // 1. Tiller side - outflows from QB-linked business accounts only.
 // Stale / personal Tiller accounts (TOTAL CHECKING, Regular Chk, Personal MM)
 // don't exist in QB's chart of accounts, so their txns would always show up
 // as "bank-only" noise in the reconciliation - hide them entirely.
 const tiller = await getTillerTransactions();
 const qbAccountNames = new Set(
 tiller.accounts.filter((a) => a.inQb).map((a) => a.account),
 );
 const bankTxnsRaw = tiller.transactions.filter(
 (t) =>
 t.amount < 0 &&
 t.entity !== 'Personal' &&
 t.date >= FIXED_START_DATE &&
 qbAccountNames.has(t.account),
 );
 // De-duplicate: Tiller occasionally surfaces the same charge twice (pending +
 // posted, or two views of the same ACH). Same date+amount+account+payee →
 // collapse. Different txnIds aren't enough to call them different transactions.
 const bankTxns = dedupeBankTxns(bankTxnsRaw);
 const tillerDuplicatesDropped = bankTxnsRaw.length - bankTxns.length;
 const windowStart = FIXED_START_DATE;

 // 2. QB side - Purchase + BillPayment + Check since the same start.
 let qbRows: Array<{
 txnType: 'Purchase' | 'BillPayment' | 'Check';
 txnId: string;
 date: string;
 amount: number;
 sourceAccount: string;
 payee: string;
 category: string;
 memo: string;
 }> = [];
 try {
 const tok = await getValidAccessToken();
 const since = windowStart;
 const onErr = (label: string) => (e: unknown) => {
 const msg = e instanceof Error ? e.message : String(e);
 warnings.push(`QB ${label} query failed: ${msg.slice(0, 200)}`);
 return [] as never[];
 };
 // Note: QB API doesn't accept `select * from Check` as a query - Check is
 // not exposed via the v3 query language directly. Purchase + BillPayment
 // cover ~all clearing events (cash/CC spend + bill clearings). Manual
 // checks (rare in this dataset) will fall into qbOnly until QB exposes
 // them via SQL or a separate entity endpoint.
 const checks: QbCheck[] = [];
 const [purchases, bps] = await Promise.all([
 qboQuery<QbPurchase>(`select * from Purchase where TxnDate >= '${since}'`, tok.accessToken, tok.realmId, 'Purchase').catch(onErr('Purchase')),
 qboQuery<QbBillPayment>(`select * from BillPayment where TxnDate >= '${since}'`, tok.accessToken, tok.realmId, 'BillPayment').catch(onErr('BillPayment')),
 ]);
 for (const p of purchases) {
 const src = p.AccountRef?.name ?? '';
 if (!src) continue;
 const ls = firstLineCategory(p.Line);
 qbRows.push({
 txnType: 'Purchase',
 txnId: p.Id,
 date: p.TxnDate,
 amount: Math.abs(p.TotalAmt),
 sourceAccount: src,
 payee: p.EntityRef?.name ?? '',
 category: ls.category,
 memo: ls.memo || (p.PrivateNote ?? ''),
 });
 }
 for (const bp of bps) {
 const src = bp.CheckPayment?.BankAccountRef?.name ?? bp.CreditCardPayment?.CCAccountRef?.name ?? '';
 if (!src) continue;
 qbRows.push({
 txnType: 'BillPayment',
 txnId: bp.Id,
 date: bp.TxnDate,
 amount: Math.abs(bp.TotalAmt),
 sourceAccount: src,
 payee: bp.VendorRef?.name ?? '',
 category: '(Bill payment)',
 memo: bp.PrivateNote ?? '',
 });
 }
 for (const c of checks) {
 const src = c.AccountRef?.name ?? '';
 if (!src) continue;
 const ls = firstLineCategory(c.Line);
 qbRows.push({
 txnType: 'Check',
 txnId: c.Id,
 date: c.TxnDate,
 amount: Math.abs(c.TotalAmt),
 sourceAccount: src,
 payee: c.EntityRef?.name ?? '',
 category: ls.category,
 memo: ls.memo || (c.PrivateNote ?? ''),
 });
 }
 } catch (e) {
 warnings.push(`QB fetch failed (${e instanceof Error ? e.message : '?'}) - qb-side empty.`);
 }

 // 3. Index QB by amount-in-cents for O(1) candidate lookup.
 const qbByAmount = new Map<number, typeof qbRows>();
 for (const q of qbRows) {
 const k = Math.round(q.amount * 100);
 const arr = qbByAmount.get(k) ?? [];
 arr.push(q);
 qbByAmount.set(k, arr);
 }
 const usedQb = new Set<string>();
 const matched: ReconciledRow[] = [];
 const bankOnly: ReconciledRow[] = [];

 // First pass - exact amount + date window
 const stillUnmatchedBank: typeof bankTxns = [];
 for (const b of bankTxns) {
 const abs = Math.abs(b.amount);
 const key = Math.round(abs * 100);
 const sameAmount = (qbByAmount.get(key) ?? []).filter((q) => !usedQb.has(q.txnId));
 if (sameAmount.length === 0) { stillUnmatchedBank.push(b); continue; }
 const bMs = new Date(b.date + 'T00:00:00Z').getTime();
 const withinDate = sameAmount.filter((q) => {
 const qMs = new Date(q.date + 'T00:00:00Z').getTime();
 return Math.abs(qMs - bMs) <= MATCH_DAYS * MS_PER_DAY;
 });
 if (withinDate.length === 0) { stillUnmatchedBank.push(b); continue; }
 const strong = withinDate.filter((q) => bankNamesEquivalent(b.account, q.sourceAccount));
 const pool = strong.length > 0 ? strong : withinDate;
 pool.sort((x, y) => {
 const xd = Math.abs(new Date(x.date + 'T00:00:00Z').getTime() - bMs);
 const yd = Math.abs(new Date(y.date + 'T00:00:00Z').getTime() - bMs);
 return xd - yd;
 });
 const q = pool[0];
 usedQb.add(q.txnId);
 const days = Math.abs(new Date(q.date + 'T00:00:00Z').getTime() - bMs) / MS_PER_DAY;
 matched.push({
 date: b.date,
 amount: abs,
 sourceBank: b.account,
 sourceKind: classifySource(b.account),
 payee: b.payee || q.payee,
 qbCategory: q.category,
 qbTxnId: q.txnId,
 tillerTxnId: b.txnId,
 daysDiff: +days.toFixed(1),
 });
 }

 // Second pass - DEEP CHECK on stragglers:
 // (a) ±$1 cent rounding tolerance (QB & Tiller occasionally differ by $0.01)
 // (b) payee fuzzy match within ±MATCH_DAYS even if no exact-amount hit
 // Both gated by source-bank equivalence to avoid wild cross-account matches.
 const qbByMonthBank = new Map<string, typeof qbRows>();
 for (const q of qbRows) {
 if (usedQb.has(q.txnId)) continue;
 const k = q.date.slice(0, 7) + '|' + classifySource(q.sourceAccount);
 const arr = qbByMonthBank.get(k) ?? [];
 arr.push(q);
 qbByMonthBank.set(k, arr);
 }
 for (const b of stillUnmatchedBank) {
 const abs = Math.abs(b.amount);
 const bMs = new Date(b.date + 'T00:00:00Z').getTime();
 const bKind = classifySource(b.account);
 const candidates = qbByMonthBank.get(b.date.slice(0, 7) + '|' + bKind) ?? [];
 let best: { q: typeof qbRows[0]; score: number; days: number } | null = null;
 for (const q of candidates) {
 if (usedQb.has(q.txnId)) continue;
 const qMs = new Date(q.date + 'T00:00:00Z').getTime();
 const days = Math.abs(qMs - bMs) / MS_PER_DAY;
 if (days > MATCH_DAYS) continue;
 // Rounding tolerance: within $1 OR within 0.5% of amount, whichever bigger
 const tol = Math.max(1.0, abs * 0.005);
 if (Math.abs(q.amount - abs) > tol) continue;
 const score = payeeMatchScore(b.payee, q.payee);
 if (score < 0.34) continue; // need at least 1/3 token overlap
 const effective = score - (days / (MATCH_DAYS * 4));
 if (!best || effective > best.score) best = { q, score: effective, days };
 }
 if (best) {
 usedQb.add(best.q.txnId);
 matched.push({
 date: b.date,
 amount: abs,
 sourceBank: b.account,
 sourceKind: bKind,
 payee: b.payee || best.q.payee,
 qbCategory: best.q.category,
 qbTxnId: best.q.txnId,
 tillerTxnId: b.txnId,
 daysDiff: +best.days.toFixed(1),
 });
 } else {
 bankOnly.push({
 date: b.date,
 amount: abs,
 sourceBank: b.account,
 sourceKind: bKind,
 payee: b.payee,
 tillerTxnId: b.txnId,
 });
 }
 }

 // 4. QB rows not claimed by anyone.
 // Skip PureX-routed entries - they're intercompany clearing, not real
 // bank movements (Tiller can't see them, and they aren't real spend
 // from a user-facing bank/CC perspective).
 const PUREX_RE = /purex|intercompany|due (to|from)|clearing/i;
 const qbOnly: ReconciledRow[] = qbRows
 .filter((q) => !usedQb.has(q.txnId))
 .filter((q) => !PUREX_RE.test(q.sourceAccount))
 .map((q) => ({
 date: q.date,
 amount: q.amount,
 sourceBank: q.sourceAccount,
 sourceKind: classifySource(q.sourceAccount),
 payee: q.payee,
 qbCategory: q.category,
 qbTxnId: q.txnId,
 qbCategoryGroup: classifyQbOnlyCategory(q.category),
 }));

 // 4b. Split bank-only into real "needs to be booked" rows vs intercompany
 // cash movements (CC payoff, bank→bank transfers). The latter don't need
 // a QB expense entry - they're balance-sheet moves between YOUR accounts.
 const transfers: ReconciledRow[] = [];
 const realBankOnly: ReconciledRow[] = [];
 for (const r of bankOnly) {
   const k = r.sourceKind ?? classifySource(r.sourceBank);
   if (isInterCompanyMovement(r.payee, r.sourceBank, k)) {
     transfers.push(r);
   } else {
     realBankOnly.push(r);
   }
 }

 // 4c. THIRD PASS - try to reconcile QB-only against transfers + leftover
 // bank-only with relaxed tolerance. QB books equity distributions / R&D /
 // owner draws to "Basic Business Checking (7561)" with a clean date, but
 // the matching Tiller bank movement may settle several days later and
 // land in the transfers bucket (Online Transfer / INTERNET XFR). For each
 // QB-only row, look for an unused Tiller row with same amount within ±30
 // days where the source kinds (bank vs cc) agree. Match against transfers
 // first (most likely), then realBankOnly.
 const RELAX_DAYS = 30;
 const usedTillerIds = new Set<string>();
 const additionalMatched: ReconciledRow[] = [];
 const qbOnlyRemaining: typeof qbOnly = [];
 const lookupPool: ReconciledRow[] = [...transfers, ...realBankOnly];
 for (const q of qbOnly) {
   const qKind = q.sourceKind ?? classifySource(q.sourceBank);
   const qMs = new Date(q.date + 'T00:00:00Z').getTime();
   let best: { row: ReconciledRow; days: number } | null = null;
   for (const t of lookupPool) {
     if (!t.tillerTxnId || usedTillerIds.has(t.tillerTxnId)) continue;
     if (Math.round(t.amount * 100) !== Math.round(q.amount * 100)) continue;
     const tKind = t.sourceKind ?? classifySource(t.sourceBank);
     if (qKind !== 'other' && tKind !== 'other' && qKind !== tKind) continue;
     const tMs = new Date(t.date + 'T00:00:00Z').getTime();
     const days = Math.abs(tMs - qMs) / MS_PER_DAY;
     if (days > RELAX_DAYS) continue;
     if (!best || days < best.days) best = { row: t, days };
   }
   if (best) {
     usedTillerIds.add(best.row.tillerTxnId!);
     additionalMatched.push({
       date: best.row.date,
       amount: q.amount,
       sourceBank: best.row.sourceBank,
       sourceKind: best.row.sourceKind,
       payee: best.row.payee || q.payee,
       qbCategory: q.qbCategory,
       qbTxnId: q.qbTxnId,
       tillerTxnId: best.row.tillerTxnId,
       daysDiff: +best.days.toFixed(1),
     });
   } else {
     qbOnlyRemaining.push(q);
   }
 }
 // Push the additional matches into the main matched list, then strip the
 // newly-claimed Tiller rows out of transfers + realBankOnly.
 matched.push(...additionalMatched);
 const transfersFinal = transfers.filter((t) => !t.tillerTxnId || !usedTillerIds.has(t.tillerTxnId));
 const realBankOnlyFinal = realBankOnly.filter((t) => !t.tillerTxnId || !usedTillerIds.has(t.tillerTxnId));

 // 5. Sort outputs newest first.
 matched.sort((a, b) => b.date.localeCompare(a.date));
 realBankOnlyFinal.sort((a, b) => b.date.localeCompare(a.date));
 transfersFinal.sort((a, b) => b.date.localeCompare(a.date));
 qbOnlyRemaining.sort((a, b) => b.date.localeCompare(a.date));

 // 6. Category × month × bank/CC attribution (matched rows only).
 // "Inventory March me bank se X, CC se Y" - pivot the matched rows.
 const attrMap = new Map<string, CategoryAttribution>();
 const monthsSet = new Set<string>();
 for (const r of matched) {
 const cat = r.qbCategory || '(uncategorized)';
 const ym = r.date.slice(0, 7);
 monthsSet.add(ym);
 let row = attrMap.get(cat);
 if (!row) {
 row = { category: cat, bankPaid: 0, ccPaid: 0, total: 0, txnCount: 0, monthly: {} };
 attrMap.set(cat, row);
 }
 const monthBucket = row.monthly[ym] ?? { bank: 0, cc: 0, total: 0 };
 if (r.sourceKind === 'bank') { row.bankPaid += r.amount; monthBucket.bank += r.amount; }
 else if (r.sourceKind === 'cc') { row.ccPaid += r.amount; monthBucket.cc += r.amount; }
 else { /* 'other' - ignore in bank/CC split */ }
 monthBucket.total = +(monthBucket.bank + monthBucket.cc).toFixed(2);
 row.monthly[ym] = monthBucket;
 row.total += r.amount;
 row.txnCount += 1;
 }
 const categoryAttribution = [...attrMap.values()]
 .map((c) => ({
 ...c,
 bankPaid: +c.bankPaid.toFixed(2),
 ccPaid: +c.ccPaid.toFixed(2),
 total: +c.total.toFixed(2),
 }))
 .sort((a, b) => b.total - a.total);
 const attributionMonths = [...monthsSet].sort();

 const sumAmount = (arr: ReconciledRow[]) => +arr.reduce((s, r) => s + r.amount, 0).toFixed(2);

 return {
 asOf: new Date().toISOString(),
 windowStart,
 matchDays: MATCH_DAYS,
 counts: {
 matched: matched.length,
 bankOnly: realBankOnlyFinal.length,
 transfers: transfersFinal.length,
 qbOnly: qbOnlyRemaining.length,
 tillerTotal: bankTxns.length,
 tillerDuplicatesDropped,
 qbTotal: qbRows.length,
 },
 totals: {
 matched: sumAmount(matched),
 bankOnly: sumAmount(realBankOnlyFinal),
 transfers: sumAmount(transfersFinal),
 qbOnly: sumAmount(qbOnlyRemaining),
 },
 matched,
 bankOnly: realBankOnlyFinal,
 transfers: transfersFinal,
 qbOnly: qbOnlyRemaining,
 categoryAttribution,
 attributionMonths,
 warnings,
 };
}
