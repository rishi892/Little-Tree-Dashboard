/**
 * Inventory purchases - actual cash spent on inventory, per the same logic as
 * the user's n8n workflow:
 *
 * 1. For every inventory ASSET account, pull
 * `Reports/TransactionDetailByAccount` with `accounting_method=Cash` so
 * we only get rows representing actual cash movement.
 * 2. Each row has a `splitAccount` (the offsetting side). Classify directly
 * when it's a known bank/CC/PureX account.
 * 3. When `splitAccount = Accounts Payable (A/P)` and the txn is a Bill, do
 * the 3-step trace:
 * a. GET /bill/{id} → read its LinkedTxn array
 * b. For each linked BillPayment, GET /billpayment/{id}
 * c. Classify by CheckPayment.BankAccountRef or CreditCardPayment.CCAccountRef
 * d. If those refs are missing AND PayType=Check/blank, fall back to a
 * GeneralLedger query on the payment date to find which
 * bank/CC/PureX account the BillPayment landed in.
 * 4. Bucket every transaction into PureX vs Moysh (Bank+CC). No Unpaid bucket
 * - Cash basis already filters out un-cleared bills.
 */

import { QBO_API_BASE } from './config.js';
import { qboFetch } from './qbHttp.js';
import { getValidAccessToken } from './oauth.js';

const FIXED_START = { year: 2025, month: 0 };

type Ref = { value: string; name?: string };

type Account = {
 Id: string;
 Name: string;
 AccountType: string;
 AccountSubType?: string;
 ParentRef?: Ref;
 FullyQualifiedName?: string;
};

type Item = {
 Id: string;
 Name: string;
 Type?: string;
 AssetAccountRef?: Ref;
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

type Bill = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 VendorRef?: Ref;
 LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
};

export type InventoryTxn = {
 txnId: string;
 txnType: 'Purchase' | 'Bill' | 'JournalEntry' | 'Expense' | 'Check' | 'CreditCardExpense' | 'Other';
 date: string;
 vendor?: string;
 memo?: string;
 amount: number;
 inventoryAccount: string;
 /** What QB's report said the offsetting account was. */
 splitAccount: string;
 /** Bank/CC/PureX account that cleared this transaction. */
 sourceBank: string;
 /** 'PureX' or 'Moysh' (Moysh covers bank + credit card). */
 paidBy: 'PureX' | 'Moysh';
};

export type InventoryPurchasesResult = {
 asOf: string;
 months: string[];
 monthLabels: string[];
 total: number;
 purexTotal: number;
 moyshTotal: number;
 monthlyByPaidBy: Record<string, { purex: number; moysh: number }>;
 monthlyTotal: number[];
 monthlyPurex: number[];
 monthlyMoysh: number[];
 byAccount: Array<{ name: string; total: number; purex: number; moysh: number }>;
 byVendor: Array<{ vendor: string; total: number; purex: number; moysh: number; count: number }>;
 transactions: InventoryTxn[];
};

// ---------- helpers ----------

function buildMonths(): { startDate: string; endDate: string; months: string[]; monthLabels: string[] } {
 const months: string[] = [];
 const monthLabels: string[] = [];
 const now = new Date();
 const endYear = now.getUTCFullYear();
 const endMonth = now.getUTCMonth();
 let y = FIXED_START.year;
 let m = FIXED_START.month;
 while (y < endYear || (y === endYear && m < endMonth)) {
 const d = new Date(Date.UTC(y, m, 1));
 months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
 monthLabels.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
 m++;
 if (m > 11) { m = 0; y++; }
 }
 const startDate = `${months[0]}-01`;
 const lastYm = months[months.length - 1];
 const [ly, lm] = lastYm.split('-').map((n) => parseInt(n, 10));
 const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
 const endDate = `${lastYm}-${String(lastDay).padStart(2, '0')}`;
 return { startDate, endDate, months, monthLabels };
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

async function qboGet<T>(path: string, accessToken: string, realmId: string): Promise<T | null> {
 const url = `${QBO_API_BASE}/v3/company/${realmId}/${path}?minorversion=70`;
 const res = await qboFetch(url, accessToken);
 if (!res.ok) return null;
 return (await res.json()) as T;
}

function classifyBank(name: string | undefined, id?: string | undefined): 'PureX' | 'Moysh' {
 const n = (name ?? '').toLowerCase();
 if (n === 'purex' || n.includes('pure x') || n.includes('pure-x')) return 'PureX';
 if (n.includes('intercompany') || n.includes('clearing')) return 'PureX';
 if (id === '1150040153' || id === '1150040018') return 'PureX';
 return 'Moysh';
}

// ---------- TransactionDetailByAccount per-account fetch ----------

type TxnRow = {
 txnDate: string;
 txnType: string;
 txnId: string;
 docNum: string;
 vendor: string;
 vendorId: string;
 memo: string;
 splitAccount: string;
 splitAccountId: string;
 amount: number;
};

async function fetchAccountTxnDetail(
 accessToken: string,
 realmId: string,
 startDate: string,
 endDate: string,
 accountId: string,
): Promise<TxnRow[]> {
 const url = `${QBO_API_BASE}/v3/company/${realmId}/reports/TransactionDetailByAccount`
 + `?start_date=${startDate}&end_date=${endDate}`
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
 // Column order from the workflow:
 // 0:tx_date 1:txn_type 2:doc_num 3:name 4:store 5:class 6:memo 7:split_acc 8:amount 9:balance
 const txnDate = c[0]?.value ?? '';
 const txnType = c[1]?.value ?? '';
 if (!txnDate || !txnType) {
 if (r.Rows?.Row) walk(r.Rows.Row);
 continue;
 }
 const amtStr = String(c[8]?.value ?? '0').replace(/,/g, '');
 const amount = parseFloat(amtStr);
 if (!Number.isFinite(amount)) {
 if (r.Rows?.Row) walk(r.Rows.Row);
 continue;
 }
 rows.push({
 txnDate,
 txnType,
 txnId: c[1]?.id ?? '',
 docNum: c[2]?.value ?? '',
 vendor: c[3]?.value ?? '',
 vendorId: c[3]?.id ?? '',
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

// PureX bank account id (no GL lookups - strictly Bill → BillPayment trace).
const purexPaymentSourceId = '1150040153';

// ---------- Main ----------

// Module-level cache so direct callers (cashflow13, mappedExpenses overrides)
// share the same 60-min cached result as the /api/inventory-purchases route.
const _INV_CACHE_TTL_MS = 60 * 60 * 1000;
let _invCache: { at: number; data: InventoryPurchasesResult } | null = null;
let _invInFlight: Promise<InventoryPurchasesResult> | null = null;

export async function getInventoryPurchases(): Promise<InventoryPurchasesResult> {
 if (_invCache && Date.now() - _invCache.at < _INV_CACHE_TTL_MS) return _invCache.data;
 if (_invInFlight) return _invInFlight;
 _invInFlight = (async () => {
 try { return await _getInventoryPurchasesUncached(); }
 finally { _invInFlight = null; }
 })();
 const data = await _invInFlight;
 // Don't poison the 60-min cache with an empty result (e.g. QB throttle 429
 // returned no rows). Only cache if we got real data; otherwise the next
 // caller will retry.
 if (data.total > 0 && data.transactions.length > 0) {
 _invCache = { at: Date.now(), data };
 }
 return data;
}

export function invalidateInventoryCache(): void {
 _invCache = null;
}

async function _getInventoryPurchasesUncached(): Promise<InventoryPurchasesResult> {
 const tok = await getValidAccessToken();
 const { startDate, endDate, months, monthLabels } = buildMonths();

 const [accounts, items, billPayments] = await Promise.all([
 qboQuery<Account>('select * from Account', tok.accessToken, tok.realmId, 'Account'),
 qboQuery<Item>('select * from Item', tok.accessToken, tok.realmId, 'Item').catch(() => []),
 qboQuery<BillPayment>(`select * from BillPayment where TxnDate >= '${startDate}'`, tok.accessToken, tok.realmId, 'BillPayment').catch(() => [] as BillPayment[]),
 ]);

 const accountsById = new Map(accounts.map((a) => [a.Id, a]));
 const billPaymentsById = new Map(billPayments.map((bp) => [bp.Id, bp]));

 // Identify inventory ASSET accounts. EXCLUDE R&D / research accounts by
 // default - those belong to "Research and Development products" on the BS.
 // EXCEPTION: EXPLICIT_INVENTORY_NAMES are always included regardless of
 // the R&D exclusion or AccountSubType - user-specified accounts that should
 // count as inventory cash spend (e.g. R&D raw materials genuinely used in
 // production, named chocolate stocks not auto-detected by name).
 // EXPLICIT_INVENTORY_NAMES - only non-R&D production stock that the
 // auto-detection misses by name. R&D Raw materials & Inventory removed
 // per user (its transactions weren't real cash purchases for production).
 const EXPLICIT_INVENTORY_NAMES = new Set([
 'chocolate (lt hr bars)',
 'veliche chocolate',
 ]);
 const inventoryAccountIds = new Set<string>();
 function isRandD(a: Account): boolean {
 const n = a.Name.toLowerCase();
 if (/^r&d\b|research|development/.test(n)) return true;
 // Walk parent chain to catch sub-accounts under an R&D parent.
 let cur = a.ParentRef?.value ? accountsById.get(a.ParentRef.value) : undefined;
 while (cur) {
 const pn = cur.Name.toLowerCase();
 if (/^r&d\b|research|development/.test(pn)) return true;
 cur = cur.ParentRef?.value ? accountsById.get(cur.ParentRef.value) : undefined;
 }
 return false;
 }
 for (const a of accounts) {
 const name = a.Name.toLowerCase();
 if (EXPLICIT_INVENTORY_NAMES.has(name)) {
 inventoryAccountIds.add(a.Id);
 continue;
 }
 if (isRandD(a)) continue;
 const subType = (a.AccountSubType ?? '').toLowerCase();
 if (subType === 'inventory') inventoryAccountIds.add(a.Id);
 else if (a.AccountType === 'Other Current Asset' && /inventory|raw material/.test(name)) {
 inventoryAccountIds.add(a.Id);
 }
 }
 for (const it of items) {
 if (it.Type === 'Inventory' && it.AssetAccountRef?.value) {
 const acc = accountsById.get(it.AssetAccountRef.value);
 if (!acc) continue;
 if (EXPLICIT_INVENTORY_NAMES.has(acc.Name.toLowerCase()) || !isRandD(acc)) {
 inventoryAccountIds.add(it.AssetAccountRef.value);
 }
 }
 }

 // QB rolls transactions up to parent accounts in TransactionDetailByAccount
 // reports - querying the PARENT covers all of its children. Match the n8n
 // workflow's approach: query ONLY the top-most inventory accounts (those
 // whose ParentRef is not itself an inventory account). Avoids both
 // double-counting (querying parent + child) and missing-data (querying
 // only some children).
 const topLevelInventoryIds = new Set<string>();
 for (const id of inventoryAccountIds) {
 const acc = accountsById.get(id);
 if (!acc) continue;
 if (acc.ParentRef?.value && inventoryAccountIds.has(acc.ParentRef.value)) continue;
 topLevelInventoryIds.add(id);
 }
 inventoryAccountIds.clear();
 for (const id of topLevelInventoryIds) inventoryAccountIds.add(id);

 // Build a quick map for Bill→BillPayments (reverse direction from BillPayment.Line[].LinkedTxn[]).
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

 /** Resolve the paying source for a Bill via the bulk BillPayment data.
 * No individual GETs - keeps QB rate-limits sane. */
 function resolveBillPaymentSource(billId: string): { name: string; id: string } | null {
 const paysForBill = paymentsByBill.get(billId);
 if (!paysForBill || paysForBill.length === 0) return null;
 const sorted = [...paysForBill].sort((a, b) => b.TxnDate.localeCompare(a.TxnDate));
 const bp = sorted[0];
 const ccRef = bp.CreditCardPayment?.CCAccountRef;
 const bankRef = bp.CheckPayment?.BankAccountRef;
 if (ccRef?.value) return { name: ccRef.name ?? '', id: ccRef.value };
 if (bankRef?.value) return { name: bankRef.name ?? '', id: bankRef.value };
 if ((bp.PayType ?? '').toLowerCase() === 'creditcard') return { name: 'Credit Card (generic)', id: '' };
 return null;
 }

 // ---- Run report per inventory account ----
 const monthIndex = new Map(months.map((m, i) => [m, i]));
 const monthlyByPaidBy: Record<string, { purex: number; moysh: number }> = {};
 for (const ym of months) monthlyByPaidBy[ym] = { purex: 0, moysh: 0 };
 const monthlyTotal = new Array(months.length).fill(0);
 const monthlyPurex = new Array(months.length).fill(0);
 const monthlyMoysh = new Array(months.length).fill(0);
 const txns: InventoryTxn[] = [];
 const accountTotals = new Map<string, { name: string; total: number; purex: number; moysh: number }>();
 const vendorTotals = new Map<string, { vendor: string; total: number; purex: number; moysh: number; count: number }>();
 let purexTotal = 0, moyshTotal = 0;

 // Fetch all inventory account reports in parallel (with reasonable concurrency).
 const accountIds = [...inventoryAccountIds];
 const reportResults = await Promise.all(
 accountIds.map((accId) =>
 fetchAccountTxnDetail(tok.accessToken, tok.realmId, startDate, endDate, accId)
 .then((rows) => ({ accId, rows }))
 .catch((e) => { console.error(`[inventory] ${accId} failed:`, e); return { accId, rows: [] as TxnRow[] }; }),
 ),
 );

 for (const { accId, rows } of reportResults) {
 const inventoryAccName = accountsById.get(accId)?.Name ?? accId;

 for (const r of rows) {
 if (r.amount <= 0) continue; // Cash basis: purchases come in as positive debits.
 // Exclude journal entries / inventory adjustments / transfers - they're
 // accounting reclasses, not real cash outflows. Catches both "Journal Entry"
 // (display form) and "JournalEntry" (QB API one-word form).
 if (/journal\s*entry|inventory (qty )?adjust|transfer/i.test(r.txnType)) continue;
 const idx = monthIndex.get(r.txnDate.slice(0, 7));
 if (idx === undefined) continue;

 // Classify by splitAccount.
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
 const resolved = resolveBillPaymentSource(r.txnId);
 if (resolved) {
 paidBy = classifyBank(resolved.name, resolved.id);
 sourceBankName = resolved.name || resolved.id || 'A/P (resolved)';
 } else {
 paidBy = 'Moysh';
 sourceBankName = 'A/P (unresolved)';
 }
 } else {
 // -Split- or other ambiguous: default by name pattern.
 paidBy = classifyBank(split, splitId);
 sourceBankName = split || '(unknown)';
 }

 txns.push({
 txnId: r.txnId,
 txnType: r.txnType as InventoryTxn['txnType'],
 date: r.txnDate,
 vendor: r.vendor || undefined,
 memo: r.memo || undefined,
 amount: r.amount,
 inventoryAccount: inventoryAccName,
 splitAccount: r.splitAccount,
 sourceBank: sourceBankName,
 paidBy,
 });

 if (paidBy === 'PureX') { purexTotal += r.amount; monthlyPurex[idx] += r.amount; monthlyByPaidBy[r.txnDate.slice(0, 7)].purex += r.amount; }
 else { moyshTotal += r.amount; monthlyMoysh[idx] += r.amount; monthlyByPaidBy[r.txnDate.slice(0, 7)].moysh += r.amount; }
 monthlyTotal[idx] += r.amount;

 let at = accountTotals.get(accId);
 if (!at) { at = { name: inventoryAccName, total: 0, purex: 0, moysh: 0 }; accountTotals.set(accId, at); }
 at.total += r.amount;
 if (paidBy === 'PureX') at.purex += r.amount;
 else at.moysh += r.amount;

 if (r.vendor) {
 let vt = vendorTotals.get(r.vendor);
 if (!vt) { vt = { vendor: r.vendor, total: 0, purex: 0, moysh: 0, count: 0 }; vendorTotals.set(r.vendor, vt); }
 vt.total += r.amount;
 vt.count++;
 if (paidBy === 'PureX') vt.purex += r.amount;
 else vt.moysh += r.amount;
 }
 }
 }

 txns.sort((a, b) => b.date.localeCompare(a.date));
 const byAccount = [...accountTotals.values()].sort((a, b) => b.total - a.total);
 const byVendor = [...vendorTotals.values()].sort((a, b) => b.total - a.total);

 return {
 asOf: new Date().toISOString(),
 months,
 monthLabels,
 total: +(purexTotal + moyshTotal).toFixed(2),
 purexTotal: +purexTotal.toFixed(2),
 moyshTotal: +moyshTotal.toFixed(2),
 monthlyByPaidBy,
 monthlyTotal: monthlyTotal.map((v) => +v.toFixed(2)),
 monthlyPurex: monthlyPurex.map((v) => +v.toFixed(2)),
 monthlyMoysh: monthlyMoysh.map((v) => +v.toFixed(2)),
 byAccount,
 byVendor,
 transactions: txns,
 };
}
