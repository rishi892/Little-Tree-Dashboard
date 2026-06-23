/**
 * Live expense detail: pull Purchase + Bill line items from QBO, aggregate by
 * (expense account, month, paying entity), and return a spreadsheet-ready grid.
 *
 * "Paid By" detection - best effort, in priority order:
 * 1. Line-item ClassRef name contains "purex" / "moysh"
 * 2. Transaction-level ClassRef name contains "purex" / "moysh"
 * 3. Purchase AccountRef (source bank/cc) name contains "purex" / "moysh"
 * 4. Vendor name contains "purex" / "moysh" (rare but possible)
 * 5. Fallback: 'Other'
 */

import { QBO_API_BASE } from './config.js';
import { qboFetch } from './qbHttp.js';
import { getValidAccessToken } from './oauth.js';
import { loadOverrides } from './categoryOverrides.js';

type PaidBy = 'PureX' | 'Moysh' | 'Other';
type Group = 'Payroll' | 'Non-Payroll';

type Account = {
 Id: string;
 Name: string;
 AccountType: string;
 AccountSubType?: string;
 Active?: boolean;
 ParentRef?: { value: string; name?: string };
 SubAccount?: boolean;
 FullyQualifiedName?: string;
};

type Ref = { value: string; name?: string };

type LineDetail = {
 AccountRef?: Ref;
 ClassRef?: Ref;
};

type Line = {
 Amount?: number;
 Description?: string;
 DetailType?: string;
 AccountBasedExpenseLineDetail?: LineDetail;
 ItemBasedExpenseLineDetail?: LineDetail & { ItemRef?: Ref };
};

type Purchase = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 AccountRef?: Ref; // source account (bank/cc)
 EntityRef?: Ref & { type?: string };
 ClassRef?: Ref;
 Line?: Line[];
};

type Bill = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 VendorRef?: Ref;
 ClassRef?: Ref;
 APAccountRef?: Ref;
 Line?: Line[];
};

type BillPayment = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 PayType?: 'Check' | 'CreditCard';
 CheckPayment?: { BankAccountRef?: Ref };
 CreditCardPayment?: { CCAccountRef?: Ref };
 Line?: Array<{
 Amount?: number;
 LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
 }>;
};

const PAYROLL_KEYWORDS = [
 'payroll', 'salary', 'salaries', 'wage', 'wages', 'compensation',
 'gusto', 'contractor', 'contractors', 'fiverr', 'upwork',
 // Specific to the user's sheet headings:
 'cogs labor', 'production payroll', 'executive', 'team',
];

function classifyGroup(name: string, accountType: string, subType?: string): Group {
 const n = name.toLowerCase();
 const t = accountType.toLowerCase();
 const s = (subType ?? '').toLowerCase();
 if (PAYROLL_KEYWORDS.some((kw) => n.includes(kw))) return 'Payroll';
 if (t === 'payroll liabilities' || t === 'long term liabilities') return 'Payroll';
 if (s.includes('payroll')) return 'Payroll';
 return 'Non-Payroll';
}

/**
 * Source-bank → entity. Confirmed by user: only the bank account literally
 * named "PureX" (intercompany clearing) corresponds to PureX. Every other
 * Bank / Credit Card / Cash account in QB belongs to Moysh.
 */
function classifyByAccount(account: Account | undefined): PaidBy {
 if (!account) return 'Other';
 const name = account.Name.toLowerCase();
 if (name === 'purex' || name.includes('pure x') || name.includes('pure-x')) return 'PureX';
 if (name.includes('intercompany') || name.includes('clearing')) return 'PureX';
 // Any other Bank / Credit Card / Cash → Moysh (corporate wallets).
 return 'Moysh';
}

/**
 * Walks QB's Reports/ProfitAndLoss output (a tree of header/summary/detail
 * rows) and yields every LEAF account row with its monthly + total values.
 * Leaf rows are detected by having ColData but no nested Rows.
 */
type PlLeaf = { accountName: string; monthly: number[]; total: number };
function parsePlReport(report: { Columns?: { Column: Array<{ ColTitle: string }> }; Rows?: { Row: any[] } }): PlLeaf[] {
 const leaves: PlLeaf[] = [];
 const monthCount = (report.Columns?.Column?.length ?? 1) - 2; // strip "" leading + "Total" trailing
 function walk(rows: any[]) {
 for (const row of rows) {
 // Header rows have ColData[0] = account name and may have nested children.
 const hasChildren = row.Rows?.Row?.length > 0;
 const isDetail = !!row.ColData && !hasChildren;
 if (isDetail) {
 const name: string = row.ColData[0]?.value ?? '';
 // ColData = [name, m1, m2, ..., mN, total]
 const monthly: number[] = [];
 for (let i = 1; i <= monthCount; i++) {
 const v = parseFloat(row.ColData[i]?.value ?? '0');
 monthly.push(Number.isFinite(v) ? v : 0);
 }
 const total = parseFloat(row.ColData[monthCount + 1]?.value ?? '0');
 if (name) leaves.push({ accountName: name, monthly, total: Number.isFinite(total) ? total : 0 });
 }
 if (hasChildren) walk(row.Rows.Row);
 }
 }
 walk(report.Rows?.Row ?? []);
 return leaves;
}

async function fetchPlReport(accessToken: string, realmId: string, startDate: string, endDate: string): Promise<PlLeaf[]> {
 const url = `${QBO_API_BASE}/v3/company/${realmId}/reports/ProfitAndLoss`
 + `?start_date=${startDate}&end_date=${endDate}`
 + `&summarize_column_by=Month&accounting_method=Cash&minorversion=70`;
 const res = await qboFetch(url, accessToken);
 if (!res.ok) throw new Error(`QBO P&L ${res.status}: ${await res.text()}`);
 const json = await res.json();
 return parsePlReport(json);
}

async function qboQuery<T>(query: string, accessToken: string, realmId: string, key: string): Promise<T[]> {
 const all: T[] = [];
 const pageSize = 1000;
 let start = 1;
 while (true) {
 const q = `${query} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
 const url = `${QBO_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=70`;
 const res = await qboFetch(url, accessToken);
 if (!res.ok) throw new Error(`QBO ${res.status}: ${await res.text()}`);
 const data = (await res.json()) as { QueryResponse: Record<string, T[]> };
 const batch = data.QueryResponse[key] ?? [];
 all.push(...batch);
 if (batch.length < pageSize) break;
 start += pageSize;
 }
 return all;
}

export type ExpenseDetailRow = {
 category: string; // expense account name (leaf, what QB shows)
 /** Parent account name in QB chart of accounts, if this is a sub-account.
 * Used by the mapped-categories regex so children of "Cost of labor - COGS"
 * (individual payroll names) get routed correctly. */
 parentAccountName?: string;
 /** QB's FullyQualifiedName (e.g. "Gelato Expenses:Rent"). Used to
 * disambiguate accounts that share a short Name. */
 fullyQualifiedName?: string;
 group: Group;
 accountType: string;
 /** 'PureX' | 'Moysh' | 'Combined' | 'Other' - derived from per-entity totals */
 paidBy: 'PureX' | 'Moysh' | 'Combined' | 'Other';
 /** Sum across all entities, length = months.length */
 monthly: number[];
 /** Per-entity breakdown, useful for filter UI */
 perEntity: { PureX: number[]; Moysh: number[]; Other: number[] };
 total: number;
};

export type ExpenseDetailResult = {
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 /** YYYY-MM keys for column headers (completed months only). */
 months: string[];
 monthLabels: string[];
 rows: ExpenseDetailRow[];
 totals: {
 txnsScanned: number;
 accountsScanned: number;
 paidByDetected: { PureX: number; Moysh: number; Other: number };
 };
 /** All Bank/Credit Card account names - useful for the user to verify Paid-By detection. */
 paymentSources: Array<{ name: string; accountType: string }>;
 classes: string[];
};

const RELEVANT_ACCOUNT_TYPES = new Set([
 'Expense',
 'Cost of Goods Sold',
 'Other Expense',
]);

/**
 * Hard anchor - the lender report always starts at January 2025, regardless of
 * the `lookbackMonths` param. The param is ignored; we build months from this
 * anchor up to (but not including) the current month.
 */
const FIXED_START = { year: 2025, month: 0 }; // Jan 2025 (month is 0-indexed)

// Module cache so PureX / Moysh / Combined entity fetches all share the SAME
// underlying QB snapshot. Without this, each entity makes its own fresh
// getExpenseDetail() call and QB throttling/timing makes the data drift -
// breaking Combined === PureX + Moysh.
let _expCache: { at: number; data: ExpenseDetailResult } | null = null;
let _expInFlight: Promise<ExpenseDetailResult> | null = null;
const _EXP_CACHE_TTL_MS = 60 * 60 * 1000;

export function invalidateExpenseDetailCache(): void { _expCache = null; }

export async function getExpenseDetail(_lookbackMonths = 14): Promise<ExpenseDetailResult> {
 if (_expCache && Date.now() - _expCache.at < _EXP_CACHE_TTL_MS) return _expCache.data;
 if (_expInFlight) return _expInFlight;
 _expInFlight = (async () => {
 try { return await _getExpenseDetailUncached(); }
 finally { _expInFlight = null; }
 })();
 const data = await _expInFlight;
 // Don't poison the cache with an empty result (e.g. QB 429 wiped everything).
 if (data.rows.length > 0) _expCache = { at: Date.now(), data };
 return data;
}

async function _getExpenseDetailUncached(): Promise<ExpenseDetailResult> {
 const tok = await getValidAccessToken();
 const overrides = await loadOverrides();

 // Build the month list from Jan 2025 to last completed month.
 const months: string[] = [];
 const monthLabels: string[] = [];
 const now = new Date();
 const endYear = now.getUTCFullYear();
 const endMonth = now.getUTCMonth(); // current (incomplete) month - exclude
 let y = FIXED_START.year;
 let m = FIXED_START.month;
 while (y < endYear || (y === endYear && m < endMonth)) {
 const d = new Date(Date.UTC(y, m, 1));
 const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
 months.push(ym);
 monthLabels.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
 m++;
 if (m > 11) { m = 0; y++; }
 }
 const monthIndex = new Map(months.map((m, i) => [m, i]));
 const since = `${months[0]}-01`;

 // Compute end date (last day of last completed month) for the P&L Reports call.
 const endMonth0 = endMonth === 0 ? 12 : endMonth;
 const endYear0 = endMonth === 0 ? endYear - 1 : endYear;
 const lastDay = new Date(Date.UTC(endYear0, endMonth0, 0)).getUTCDate();
 const endDate = `${endYear0}-${String(endMonth0).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

 const [accounts, purchases, bills, billPayments, classes, plLeaves] = await Promise.all([
 qboQuery<Account>('select * from Account', tok.accessToken, tok.realmId, 'Account'),
 qboQuery<Purchase>(`select * from Purchase where TxnDate >= '${since}'`, tok.accessToken, tok.realmId, 'Purchase'),
 qboQuery<Bill>(`select * from Bill where TxnDate >= '${since}'`, tok.accessToken, tok.realmId, 'Bill'),
 qboQuery<BillPayment>(`select * from BillPayment where TxnDate >= '${since}'`, tok.accessToken, tok.realmId, 'BillPayment').catch(() => []),
 qboQuery<{ Name: string }>('select * from Class', tok.accessToken, tok.realmId, 'Class').catch(() => []),
 // Pull QB's official P&L Report (monthly breakdown) as the SOURCE OF TRUTH
 // for per-account totals. This catches inventory-sales COGS, JEs, and other
 // postings that don't surface in the Purchase/Bill queries.
 fetchPlReport(tok.accessToken, tok.realmId, since, endDate).catch((e) => {
 console.error('[expense-detail] P&L Report fetch failed:', e instanceof Error ? e.message : e);
 return [];
 }),
 ]);

 const accountsById = new Map(accounts.map((a) => [a.Id, a]));
 const paymentSources = accounts
 .filter((a) => a.AccountType === 'Bank' || a.AccountType === 'Credit Card')
 .map((a) => ({ name: a.Name, accountType: a.AccountType }));

 // Trace each Bill to its paying bank/CC via BillPayment.Line[].LinkedTxn[].
 // If a Bill has multiple payments (partial pays), use the LATEST payment's
 // source bank. Bills that haven't been paid yet are absent from this map
 // and will fall back to Moysh default.
 const billPaymentSource = new Map<string, { accountId: string; payDate: string }>();
 for (const bp of billPayments) {
 const accountId =
 bp.CheckPayment?.BankAccountRef?.value
 ?? bp.CreditCardPayment?.CCAccountRef?.value;
 if (!accountId) continue;
 for (const ln of bp.Line ?? []) {
 for (const lt of ln.LinkedTxn ?? []) {
 if (lt.TxnType !== 'Bill') continue;
 const prev = billPaymentSource.get(lt.TxnId);
 if (!prev || prev.payDate < bp.TxnDate) {
 billPaymentSource.set(lt.TxnId, { accountId, payDate: bp.TxnDate });
 }
 }
 }
 }

 type RowAccum = {
 accountId: string;
 accountName: string;
 parentAccountName?: string;
 fullyQualifiedName?: string;
 accountType: string;
 group: Group;
 perEntity: { PureX: number[]; Moysh: number[]; Other: number[] };
 };
 const rows = new Map<string, RowAccum>();

 function ensureRow(accountId: string): RowAccum | null {
 const a = accountsById.get(accountId);
 if (!a) return null;
 if (!RELEVANT_ACCOUNT_TYPES.has(a.AccountType)) return null;
 let row = rows.get(accountId);
 if (!row) {
 const parent = a.ParentRef?.value ? accountsById.get(a.ParentRef.value) : undefined;
 row = {
 accountId,
 accountName: a.Name,
 parentAccountName: parent?.Name ?? a.ParentRef?.name,
 fullyQualifiedName: a.FullyQualifiedName,
 accountType: a.AccountType,
 group: classifyGroup(a.Name, a.AccountType, a.AccountSubType),
 perEntity: {
 PureX: new Array(months.length).fill(0),
 Moysh: new Array(months.length).fill(0),
 Other: new Array(months.length).fill(0),
 },
 };
 rows.set(accountId, row);
 }
 return row;
 }

 const paidByCount = { PureX: 0, Moysh: 0, Other: 0 };

 /**
 * Per-line Paid-By: derived from the SOURCE BANK that paid the line.
 * For Purchases the source is on the txn itself; for Bills we trace
 * to the BillPayment to find the bank that cleared it.
 */
 function bump(line: Line, txn: Purchase | Bill, date: string, txnKind: 'Purchase' | 'Bill') {
 const detail = line.AccountBasedExpenseLineDetail ?? line.ItemBasedExpenseLineDetail;
 const accId = detail?.AccountRef?.value;
 const amount = line.Amount;
 if (!accId || !amount) return;
 const ym = date.slice(0, 7);
 const idx = monthIndex.get(ym);
 if (idx === undefined) return;
 const row = ensureRow(accId);
 if (!row) return;

 // 1. Manual override always wins (account-level).
 const override = overrides[row.accountName]?.paidBy;
 let paidBy: PaidBy;
 if (override === 'PureX' || override === 'Moysh' || override === 'Other') {
 paidBy = override;
 } else if (override === 'Combined') {
 paidBy = 'Moysh';
 } else {
 // 2. Source-bank detection:
 // - Purchase: txn.AccountRef IS the bank/CC the spend came from.
 // - Bill: look up its BillPayment → source bank/CC.
 // Only the bank account literally named "PureX" → PureX. Everything
 // else → Moysh (per user's confirmed bank mapping).
 let sourceAcc: Account | undefined;
 if (txnKind === 'Purchase') {
 const srcId = (txn as Purchase).AccountRef?.value;
 if (srcId) sourceAcc = accountsById.get(srcId);
 } else {
 const pay = billPaymentSource.get(txn.Id);
 if (pay) sourceAcc = accountsById.get(pay.accountId);
 }
 paidBy = sourceAcc ? classifyByAccount(sourceAcc) : 'Moysh';
 }
 row.perEntity[paidBy][idx] += amount;
 paidByCount[paidBy]++;
 }

 for (const p of purchases) {
 for (const ln of p.Line ?? []) bump(ln, p, p.TxnDate, 'Purchase');
 }
 for (const b of bills) {
 for (const ln of b.Line ?? []) bump(ln, b, b.TxnDate, 'Bill');
 }

 // ---- P&L Reconciliation ----
 // Now that transactions have populated perEntity buckets, override the row
 // totals to match QB's official P&L (which includes inventory-sales COGS,
 // Journal Entries, and other postings we don't see in Purchase/Bill).
 //
 // Strategy per (account, month):
 // - P&L total = authoritative value from QB Reports API
 // - PureX portion = perEntity.PureX from transactions (proven PureX cash)
 // - Moysh portion = max(P&L total − PureX, 0)
 // - Other = max(P&L total − PureX − Moysh, 0) (residual; should be 0)
 //
 // Accounts that exist in P&L but had no Purchase/Bill activity get added
 // here so they show up too (inventory-only accounts like "Supplies &
 // materials - COGS").
 const accountsByName = new Map<string, Account>();
 for (const a of accounts) accountsByName.set(a.Name, a);

 for (const leaf of plLeaves) {
 const acc = accountsByName.get(leaf.accountName);
 if (!acc) continue; // child rows / non-account labels
 if (!RELEVANT_ACCOUNT_TYPES.has(acc.AccountType)) continue;
 // Ensure the row exists (some accounts only appear in P&L not in Bills/Purchases)
 let row = rows.get(acc.Id);
 if (!row) {
 const parent = acc.ParentRef?.value ? accountsById.get(acc.ParentRef.value) : undefined;
 row = {
 accountId: acc.Id,
 accountName: acc.Name,
 parentAccountName: parent?.Name ?? acc.ParentRef?.name,
 accountType: acc.AccountType,
 group: classifyGroup(acc.Name, acc.AccountType, acc.AccountSubType),
 perEntity: {
 PureX: new Array(months.length).fill(0),
 Moysh: new Array(months.length).fill(0),
 Other: new Array(months.length).fill(0),
 },
 };
 rows.set(acc.Id, row);
 }
 // Manual override at account level affects which bucket the P&L residual flows into.
 const accOverride = overrides[acc.Name]?.paidBy;
 for (let i = 0; i < months.length && i < leaf.monthly.length; i++) {
 const plVal = leaf.monthly[i];
 if (plVal === 0) { /* zero is fine; leave perEntity as-is */ continue; }
 const px = row.perEntity.PureX[i];
 // If user has explicitly overridden, push the whole P&L total to that bucket.
 if (accOverride === 'PureX') {
 row.perEntity.PureX[i] = plVal;
 row.perEntity.Moysh[i] = 0;
 row.perEntity.Other[i] = 0;
 } else if (accOverride === 'Moysh' || accOverride === 'Combined') {
 row.perEntity.PureX[i] = 0;
 row.perEntity.Moysh[i] = plVal;
 row.perEntity.Other[i] = 0;
 } else if (accOverride === 'Other') {
 row.perEntity.PureX[i] = 0;
 row.perEntity.Moysh[i] = 0;
 row.perEntity.Other[i] = plVal;
 } else {
 // Auto split: PureX = proven, Moysh = residual.
 const pxCapped = Math.min(Math.max(px, 0), plVal);
 row.perEntity.PureX[i] = pxCapped;
 row.perEntity.Moysh[i] = Math.max(plVal - pxCapped, 0);
 row.perEntity.Other[i] = 0;
 }
 }
 }

 const resultRows: ExpenseDetailRow[] = [];
 for (const [, row] of rows) {
 const monthly = months.map(
 (_, i) => row.perEntity.PureX[i] + row.perEntity.Moysh[i] + row.perEntity.Other[i],
 );
 const total = monthly.reduce((s, v) => s + v, 0);
 if (total === 0) continue;

 const sums = {
 PureX: row.perEntity.PureX.reduce((s, v) => s + v, 0),
 Moysh: row.perEntity.Moysh.reduce((s, v) => s + v, 0),
 Other: row.perEntity.Other.reduce((s, v) => s + v, 0),
 };
 const active = (Object.keys(sums) as (keyof typeof sums)[]).filter((k) => sums[k] > 0);
 let paidBy: ExpenseDetailRow['paidBy'];
 if (active.length === 0) paidBy = 'Other';
 else if (active.length === 1) paidBy = active[0];
 else if (active.includes('PureX') && active.includes('Moysh')) paidBy = 'Combined';
 else paidBy = active[0];

 // Promote child accounts of "Cost of labor - COGS" to Payroll group so
 // they get bucketed with payroll line items downstream.
 const isLaborChild = /cost of labor|cogs labor/i.test(row.parentAccountName ?? '');
 const finalGroup: Group = isLaborChild ? 'Payroll' : row.group;
 resultRows.push({
 category: row.accountName,
 parentAccountName: row.parentAccountName,
 fullyQualifiedName: row.fullyQualifiedName,
 group: finalGroup,
 accountType: row.accountType,
 paidBy,
 monthly,
 perEntity: row.perEntity,
 total,
 });
 }

 // Sort: Payroll first then Non-Payroll, by total desc within each group.
 resultRows.sort((a, b) => {
 if (a.group !== b.group) return a.group === 'Payroll' ? -1 : 1;
 return b.total - a.total;
 });

 return {
 asOf: new Date().toISOString(),
 realmId: tok.realmId,
 lookbackMonths: months.length,
 months,
 monthLabels,
 rows: resultRows,
 totals: {
 txnsScanned: purchases.length + bills.length,
 accountsScanned: rows.size,
 paidByDetected: paidByCount,
 },
 paymentSources,
 classes: classes.map((c) => c.Name),
 };
}
