/**
 * Per-account transaction drill-down - same n8n-style deep pipeline as
 * inventoryPurchases.ts but parameterised by account name:
 *
 * 1. Find the QB account by name. If parents are queried, sub-account
 * activity rolls up - so we always query the named account directly.
 * 2. Pull `Reports/TransactionDetailByAccount` with `accounting_method=Cash`
 * → returns every cash-basis row touching that account.
 * 3. For each row, classify the paying source from `splitAccount`. If split
 * is `Accounts Payable (A/P)` and the txn type is `Bill`, trace via
 * the bulk BillPayment data to find the bank that cleared it.
 * 4. Skip Journal Entries (accounting reclasses, not cash flow).
 * 5. Return `{ PureX | Moysh }` classification per transaction. No GL.
 */

import { QBO_API_BASE } from './config.js';
import { getValidAccessToken } from './oauth.js';
import { qboFetch } from './qbHttp.js';

const FIXED_START = '2025-01-01';

type Ref = { value: string; name?: string };

type Account = {
 Id: string;
 Name: string;
 AccountType: string;
 AccountSubType?: string;
 ParentRef?: Ref;
};

type BillPayment = {
 Id: string;
 TxnDate: string;
 PayType?: 'Check' | 'CreditCard';
 VendorRef?: Ref;
 CheckPayment?: { BankAccountRef?: Ref };
 CreditCardPayment?: { CCAccountRef?: Ref };
 Line?: Array<{
 Amount?: number;
 LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
 }>;
};

export type AccountTxn = {
 txnId: string;
 txnType: 'Purchase' | 'Bill' | 'JournalEntry' | 'Expense' | 'Check' | 'CreditCardExpense' | 'Other';
 date: string;
 vendor?: string;
 memo?: string;
 amount: number;
 sourceBank: string;
 paidBy: 'PureX' | 'Moysh' | 'Unpaid';
};

export type AccountTransactionsResult = {
 account: string;
 asOf: string;
 total: number;
 purexTotal: number;
 moyshTotal: number;
 /** Kept for API compatibility - always 0 with Cash basis. */
 unpaidTotal: number;
 transactions: AccountTxn[];
};

const purexPaymentSourceId = '1150040153';

function classifyBank(name: string | undefined, id?: string | undefined): 'PureX' | 'Moysh' {
 const n = (name ?? '').toLowerCase();
 if (n === 'purex' || n.includes('pure x') || n.includes('pure-x')) return 'PureX';
 if (n.includes('intercompany') || n.includes('clearing')) return 'PureX';
 if (id === purexPaymentSourceId || id === '1150040018') return 'PureX';
 return 'Moysh';
}

async function qboQuery<T>(query: string, accessToken: string, realmId: string, key: string): Promise<T[]> {
 const all: T[] = [];
 const pageSize = 1000;
 let start = 1;
 while (true) {
 const q = `${query} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
 const url = `${QBO_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=70`;
 const res = await qboFetch(url, accessToken);
 if (!res.ok) throw new Error(`QBO query ${res.status}: ${await res.text()}`);
 const data = (await res.json()) as { QueryResponse: Record<string, T[]> };
 const batch = data.QueryResponse[key] ?? [];
 all.push(...batch);
 if (batch.length < pageSize) break;
 start += pageSize;
 }
 return all;
}

type TxnRow = {
 txnDate: string;
 txnType: string;
 txnId: string;
 docNum: string;
 vendor: string;
 memo: string;
 splitAccount: string;
 splitAccountId: string;
 amount: number;
};

async function fetchAccountTxnDetail(
 accessToken: string,
 realmId: string,
 accountId: string,
): Promise<TxnRow[]> {
 // End date = last day of last completed month.
 const now = new Date();
 const endY = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
 const endM = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
 const lastDay = new Date(Date.UTC(endY, endM, 0)).getUTCDate();
 const endDate = `${endY}-${String(endM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

 const url = `${QBO_API_BASE}/v3/company/${realmId}/reports/TransactionDetailByAccount`
 + `?start_date=${FIXED_START}&end_date=${endDate}`
 + `&account=${accountId}`
 + `&accounting_method=Cash`
 + `&minorversion=70`;
 const res = await qboFetch(url, accessToken);
 if (!res.ok) throw new Error(`QBO TransactionDetailByAccount ${res.status}: ${await res.text()}`);
 const json = await res.json() as { Rows?: { Row: any[] } };

 const rows: TxnRow[] = [];
 function walk(rs: any[]) {
 for (const r of rs ?? []) {
 if (r.ColData) {
 const c = r.ColData;
 const txnDate = c[0]?.value ?? '';
 const txnType = c[1]?.value ?? '';
 if (!txnDate || !txnType) { if (r.Rows?.Row) walk(r.Rows.Row); continue; }
 const amtStr = String(c[8]?.value ?? '0').replace(/,/g, '');
 const amount = parseFloat(amtStr);
 if (!Number.isFinite(amount)) { if (r.Rows?.Row) walk(r.Rows.Row); continue; }
 rows.push({
 txnDate,
 txnType,
 txnId: c[1]?.id ?? '',
 docNum: c[2]?.value ?? '',
 vendor: c[3]?.value ?? '',
 memo: c[6]?.value ?? '',
 splitAccount: c[7]?.value ?? '',
 splitAccountId: c[7]?.id ?? '',
 amount,
 });
 }
 if (r.Rows?.Row) walk(r.Rows.Row);
 }
 }
 walk(json.Rows?.Row ?? []);
 return rows;
}

// Module cache so concurrent PureX + Moysh + Combined entity calls see the
// SAME transactions for each extra-source account. Without this, two parallel
// requests for "Tools, machinery, and equipment" can return slightly different
// data (QB throttle/retry), breaking Combined === PureX + Moysh.
const _acctCache = new Map<string, { at: number; data: AccountTransactionsResult }>();
const _acctInFlight = new Map<string, Promise<AccountTransactionsResult>>();
const _ACCT_CACHE_TTL_MS = 60 * 60 * 1000;

export function invalidateAccountTransactionsCache(): void { _acctCache.clear(); }

export async function getAccountTransactions(accountName: string, includeJournalEntries = false): Promise<AccountTransactionsResult> {
 const cacheKey = `${accountName}|${includeJournalEntries ? 'je' : 'nje'}`;
 const cached = _acctCache.get(cacheKey);
 if (cached && Date.now() - cached.at < _ACCT_CACHE_TTL_MS) return cached.data;
 const inFlight = _acctInFlight.get(cacheKey);
 if (inFlight) return inFlight;
 const promise = (async () => {
 try { return await _getAccountTransactionsUncached(accountName, includeJournalEntries); }
 finally { _acctInFlight.delete(cacheKey); }
 })();
 _acctInFlight.set(cacheKey, promise);
 const data = await promise;
 if (data.total > 0 || data.transactions.length > 0) _acctCache.set(cacheKey, { at: Date.now(), data });
 return data;
}

async function _getAccountTransactionsUncached(accountName: string, includeJournalEntries = false): Promise<AccountTransactionsResult> {
 const tok = await getValidAccessToken();
 const [accounts, billPayments] = await Promise.all([
 qboQuery<Account>('select * from Account', tok.accessToken, tok.realmId, 'Account'),
 qboQuery<BillPayment>(`select * from BillPayment where TxnDate >= '${FIXED_START}'`, tok.accessToken, tok.realmId, 'BillPayment').catch(() => [] as BillPayment[]),
 ]);

 const targetAccount = accounts.find((a) => a.Name === accountName);
 if (!targetAccount) {
 return {
 account: accountName,
 asOf: new Date().toISOString(),
 total: 0, purexTotal: 0, moyshTotal: 0, unpaidTotal: 0,
 transactions: [],
 };
 }

 // Bill.Id → most-recent BillPayment that paid it.
 const paymentsByBill = new Map<string, BillPayment[]>();
 for (const bp of billPayments) {
 for (const ln of bp.Line ?? []) {
 for (const lt of ln.LinkedTxn ?? []) {
 if (lt.TxnType !== 'Bill') continue;
 let arr = paymentsByBill.get(lt.TxnId);
 if (!arr) { arr = []; paymentsByBill.set(lt.TxnId, arr); }
 arr.push(bp);
 }
 }
 }
 function resolveBillSource(billId: string): { name: string; id: string } | null {
 const ps = paymentsByBill.get(billId);
 if (!ps || ps.length === 0) return null;
 const bp = [...ps].sort((a, b) => b.TxnDate.localeCompare(a.TxnDate))[0];
 const ccRef = bp.CreditCardPayment?.CCAccountRef;
 const bankRef = bp.CheckPayment?.BankAccountRef;
 if (ccRef?.value) return { name: ccRef.name ?? '', id: ccRef.value };
 if (bankRef?.value) return { name: bankRef.name ?? '', id: bankRef.value };
 if ((bp.PayType ?? '').toLowerCase() === 'creditcard') return { name: 'Credit Card (generic)', id: '' };
 return null;
 }

 const rows = await fetchAccountTxnDetail(tok.accessToken, tok.realmId, targetAccount.Id);
 const txns: AccountTxn[] = [];
 let purexTotal = 0, moyshTotal = 0;

 for (const r of rows) {
 if (r.amount <= 0) continue;
 // Always skip pure bank-to-bank transfers + non-dollar inventory qty adjusts.
 if (/inventory (qty )?adjust|^transfer$/i.test(r.txnType)) continue;
 // Journal entries: hidden from the mapped-expense rollup (cash flow only) but
 // SHOWN in the per-account drill-down so it ties out to the P&L (e.g. the $4k
 // Professional Services JE the user couldn't find).
 if (!includeJournalEntries && /journal entry/i.test(r.txnType)) continue;

 let paidBy: 'PureX' | 'Moysh' = 'Moysh';
 let sourceBankName = r.splitAccount;
 const split = r.splitAccount;
 const splitId = r.splitAccountId;

 const isAP = /accounts payable|^a\/p$/i.test(split) || splitId === '7';
 const isPurex = /^purex$|pure x|pure-x/i.test(split) || splitId === purexPaymentSourceId;
 const isCC = /credit card|amex|fnbo|citi|^cc\s|card/i.test(split);
 const isBank = /checking|money market|^cash$|^cash on hand$/i.test(split);

 if (isPurex) {
 paidBy = 'PureX';
 sourceBankName = split || 'PureX';
 } else if (isCC || isBank) {
 paidBy = 'Moysh';
 sourceBankName = split;
 } else if (isAP && /bill/i.test(r.txnType)) {
 const resolved = resolveBillSource(r.txnId);
 if (resolved) {
 paidBy = classifyBank(resolved.name, resolved.id);
 sourceBankName = resolved.name || resolved.id || 'A/P (resolved)';
 } else {
 paidBy = 'Moysh';
 sourceBankName = 'A/P (unresolved)';
 }
 } else {
 paidBy = classifyBank(split, splitId);
 sourceBankName = split || '(unknown)';
 }

 txns.push({
 txnId: r.txnId,
 txnType: r.txnType as AccountTxn['txnType'],
 date: r.txnDate,
 vendor: r.vendor || undefined,
 memo: r.memo || undefined,
 amount: r.amount,
 sourceBank: sourceBankName,
 paidBy,
 });

 if (paidBy === 'PureX') purexTotal += r.amount;
 else moyshTotal += r.amount;
 }

 txns.sort((a, b) => b.date.localeCompare(a.date));

 return {
 account: accountName,
 asOf: new Date().toISOString(),
 total: +(purexTotal + moyshTotal).toFixed(2),
 purexTotal: +purexTotal.toFixed(2),
 moyshTotal: +moyshTotal.toFixed(2),
 unpaidTotal: 0,
 transactions: txns,
 };
}
