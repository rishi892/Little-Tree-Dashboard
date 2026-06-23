/**
 * Current Position Snapshot - replicates Sheet "1b. Current Position".
 *
 * Five sections, all live from QB where possible:
 * 1. Cash on hand - Bank accounts (whitelist Checking 7561 + Cash)
 * 2. Credit card debt - Credit Card accounts (per-card balance)
 * 3. Intercompany (PureX) - accounts whose name matches /purex|intercompany|clearing|due (to|from)/
 * 4. Accounts receivable - open Invoices (Balance > 0)
 * 5. Net liquidity position - computed from 1-4
 *
 * Sheet-only fallbacks (no clean QB source):
 * - CC minimum payments (QB doesn't expose this)
 * - Expected PureX Wk1 lump sum ($260K)
 * - AR non-collection buffer % (0%)
 */

import { QBO_API_BASE } from './config.js';
import { qboFetch } from './qbHttp.js';
import { getValidAccessToken } from './oauth.js';

// --- Sheet baselines / fallbacks ---

const PUREX_LUMP_SUM = 260_000;
const AR_BUFFER_PCT = 0;

/** Hard-coded min payments per card (QB doesn't return this). Keyed by name fragment. */
const CC_MIN_PAYMENTS: Array<{ match: RegExp; min: number; notes: string }> = [
 { match: /mc.*consumer|consumer.*mc/i, min: 706.0, notes: 'Business' },
 { match: /amex blue business|blue business/i, min: 7_993.31, notes: 'Business, high min payment' },
 { match: /delta business/i, min: 0, notes: 'Business' },
 { match: /amex everyday|everyday/i, min: 414.81, notes: 'Business' },
 { match: /fnbo/i, min: 2_225.37, notes: 'Business' },
 { match: /chase\s*4158/i, min: 776.0, notes: 'Business' },
 { match: /chase\s*0715/i, min: 102.0, notes: 'Business' },
 { match: /delta.*personal|personal.*delta/i, min: 227.25, notes: 'PERSONAL CARD, excluded from business cash flow' },
];

// --- Types ---

export type AccountLine = {
 name: string;
 balance: number;
 notes?: string;
 source: 'qb' | 'sheet';
};

export type CreditCardLine = AccountLine & {
 minPayment: number;
 isPersonal: boolean;
};

export type Invoice = {
 customer: string;
 description: string;
 invoiceNumber?: string;
 issueDate: string;
 amount: number;
 dueDate?: string;
 daysOpen: number;
 bucket: '0-14' | '15-30' | '31-60' | '61-90' | '90+';
};

export type CurrentPosition = {
 asOf: string;
 realmId: string | null;
 cash: {
 accounts: AccountLine[];
 total: number;
 totalSource: 'qb' | 'sheet';
 };
 creditCards: {
 business: CreditCardLine[];
 personal: CreditCardLine[];
 businessTotal: number;
 businessMinTotal: number;
 source: 'qb' | 'sheet';
 };
 intercompany: {
 clearingBalance: number; // net of operating clearing accounts (Due to/from PureX style)
 clearingSource: 'qb' | 'sheet';
 expectedRemittanceWk1: number;
 accounts: AccountLine[];
 notes: string;
 };
 receivables: {
 external: Invoice[]; // 3rd-party customers - collectible
 intercompany: Invoice[]; // PureX internal invoices - offset by clearing
 grossExternal: number;
 grossIntercompany: number;
 bufferPct: number;
 netCollectibleAr: number; // external × (1 - buffer)
 arSource: 'qb' | 'sheet';
 };
 netLiquidity: {
 totalCash: number;
 creditCardDebt: number;
 purexClearing: number;
 netCollectibleAr: number;
 netWorkingCapital: number;
 };
 warnings: string[];
};

// --- QB helpers ---

async function qboGet<T>(pathAndQuery: string): Promise<T> {
 const tokens = await getValidAccessToken();
 const url = `${QBO_API_BASE}/v3/company/${tokens.realmId}/${pathAndQuery}`;
 const res = await qboFetch(url, tokens.accessToken);
 return (await res.json()) as T;
}

type QbAccount = {
 Id: string;
 Name: string;
 AccountType: string;
 AccountSubType?: string;
 CurrentBalance?: number;
 Active?: boolean;
};
type AccountQueryResponse = { QueryResponse: { Account?: QbAccount[] } };

type QbInvoice = {
 Id: string;
 DocNumber?: string;
 TxnDate: string;
 DueDate?: string;
 TotalAmt?: number;
 Balance?: number;
 CustomerRef?: { value: string; name?: string };
 CustomerMemo?: { value?: string };
 PrivateNote?: string;
};
type InvoiceQueryResponse = { QueryResponse: { Invoice?: QbInvoice[] } };

async function queryAccounts(type: string): Promise<QbAccount[]> {
 const q = encodeURIComponent(`select * from Account where AccountType = '${type}'`);
 const data = await qboGet<AccountQueryResponse>(`query?query=${q}&minorversion=70`);
 return (data.QueryResponse.Account ?? []).filter((a) => a.Active !== false);
}

async function queryAllAccounts(): Promise<QbAccount[]> {
 const q = encodeURIComponent(`select * from Account maxresults 1000`);
 const data = await qboGet<AccountQueryResponse>(`query?query=${q}&minorversion=70`);
 return (data.QueryResponse.Account ?? []).filter((a) => a.Active !== false);
}

async function queryOpenInvoices(): Promise<QbInvoice[]> {
 // Pull recent invoices with non-zero balance.
 const q = encodeURIComponent(`select * from Invoice where Balance > '0' maxresults 200`);
 const data = await qboGet<InvoiceQueryResponse>(`query?query=${q}&minorversion=70`);
 return data.QueryResponse.Invoice ?? [];
}

// --- Per-section builders ---

function bucketDaysOpen(days: number): Invoice['bucket'] {
 if (days <= 14) return '0-14';
 if (days <= 30) return '15-30';
 if (days <= 60) return '31-60';
 if (days <= 90) return '61-90';
 return '90+';
}

function classifyCreditCard(account: QbAccount): CreditCardLine {
 const balance = Math.abs(account.CurrentBalance ?? 0);
 const matched = CC_MIN_PAYMENTS.find((m) => m.match.test(account.Name));
 const isPersonal = /personal/i.test(account.Name) || matched?.notes.toLowerCase().includes('personal') || false;
 return {
 name: account.Name,
 balance,
 minPayment: matched?.min ?? 0,
 notes: matched?.notes ?? (isPersonal ? 'PERSONAL CARD' : 'Business'),
 isPersonal,
 source: 'qb',
 };
}

// --- Main entry ---

export async function getCurrentPosition(): Promise<CurrentPosition> {
 const warnings: string[] = [];
 let realmId: string | null = null;

 let allAccounts: QbAccount[] = [];
 try {
 const tok = await getValidAccessToken();
 realmId = tok.realmId;
 allAccounts = await queryAllAccounts();
 } catch (e) {
 const msg = e instanceof Error ? e.message : String(e);
 // Distinguish a genuine auth failure (show "reconnect") from a transient
 // timeout/5xx (don't - it would flicker the connect screen on the next good poll).
 const isAuth = /not connected|auth\/connect|unauthor|\b401\b|invalid[_ ]?grant|refresh token|authenticationfailed|\b3200\b/i.test(msg);
 throw new Error(isAuth
 ? `Not connected to QuickBooks (${msg}). Visit /auth/connect to authorize.`
 : `QuickBooks data temporarily unavailable (${msg}). Please retry.`);
 }

 // 1. CASH ON HAND - all Bank-type accounts EXCEPT intercompany/PureX (those
 // are NOT cash even if mis-typed as Bank in QB Chart of Accounts).
 const bankAccounts = allAccounts.filter((a) => a.AccountType === 'Bank');
 const isIntercompanyBank = (name: string) => /purex|intercompany|clearing|due (to|from)/i.test(name);
 const realCash = bankAccounts.filter((a) => !isIntercompanyBank(a.Name));
 let cashAccounts: AccountLine[];
 let cashTotal = 0;
 let cashSource: 'qb' | 'sheet' = 'qb';

 if (realCash.length > 0) {
 cashAccounts = realCash.map((a) => {
 const isPrimary = /7561/i.test(a.Name);
 const isMM = /money market|0910|\bbmm\b/i.test(a.Name);
 const note = isPrimary ? 'Primary operating account'
 : isMM ? 'Money market / savings (sheet "BMM Account")'
 : /^cash$/i.test(a.Name) ? 'Cash on hand'
 : (a.AccountSubType ?? 'Bank');
 return { name: a.Name, balance: a.CurrentBalance ?? 0, notes: note, source: 'qb' as const };
 });
 cashTotal = cashAccounts.reduce((s, a) => s + a.balance, 0);
 const excluded = bankAccounts.filter((a) => isIntercompanyBank(a.Name));
 if (excluded.length > 0) {
 warnings.push(
 `Excluded ${excluded.length} Bank-type account(s) from cash because they look like intercompany: ` +
 excluded.map((a) => `${a.Name} ${(a.CurrentBalance ?? 0).toFixed(0)}`).join(', ') +
 '. These are surfaced under Intercompany section instead.',
 );
 }
 } else {
 warnings.push(`No non-intercompany Bank accounts found in QB. Falling back to sheet.`);
 cashAccounts = [
 { name: 'Checking 7561', balance: 7_755.34, notes: 'Primary operating account', source: 'sheet' },
 { name: 'BMM Account', balance: 55.37, notes: 'Secondary', source: 'sheet' },
 ];
 cashTotal = 7_810.71;
 cashSource = 'sheet';
 }

 // 2. CREDIT CARD DEBT
 const ccAccounts = allAccounts.filter((a) => a.AccountType === 'Credit Card');
 const ccLines = ccAccounts.map(classifyCreditCard);
 // Sort: business first (by balance desc), then personal.
 ccLines.sort((a, b) => Number(a.isPersonal) - Number(b.isPersonal) || b.balance - a.balance);
 const businessCc = ccLines.filter((c) => !c.isPersonal);
 const personalCc = ccLines.filter((c) => c.isPersonal);
 const businessTotal = businessCc.reduce((s, c) => s + c.balance, 0);
 const businessMinTotal = businessCc.reduce((s, c) => s + c.minPayment, 0);

 // 3. INTERCOMPANY (PureX)
 const intercompanyAccounts = allAccounts.filter((a) =>
 /purex|intercompany|clearing|due (to|from)/i.test(a.Name),
 );
 // Net = balance of these accounts (negative means PureX owes us, positive means we owe PureX
 // - varies by QB convention; sheet treats PureX clearing as negative meaning cushion).
 let clearingBalance = 0;
 let clearingSource: 'qb' | 'sheet' = 'qb';
 if (intercompanyAccounts.length > 0) {
 // Sheet shows -$358,545.62 as PureX clearing. Whatever the QB sign is, surface it raw.
 clearingBalance = intercompanyAccounts.reduce((s, a) => s + (a.CurrentBalance ?? 0), 0);
 if (clearingBalance === 0) {
 warnings.push(`Found intercompany accounts but balance is $0. Sheet shows $-358,546 - verify the account is being posted.`);
 clearingBalance = -358_545.62;
 clearingSource = 'sheet';
 }
 } else {
 warnings.push(`No intercompany / PureX clearing account found in QB. Using sheet baseline $-358,546.`);
 clearingBalance = -358_545.62;
 clearingSource = 'sheet';
 }
 const intercompanyLines: AccountLine[] = intercompanyAccounts.map((a) => ({
 name: a.Name,
 balance: a.CurrentBalance ?? 0,
 notes: a.AccountType,
 source: 'qb' as const,
 }));

 // 4. ACCOUNTS RECEIVABLE - open invoices, split into external (collectible) vs intercompany (offset).
 let externalInvoices: Invoice[] = [];
 let intercompanyInvoices: Invoice[] = [];
 let arSource: 'qb' | 'sheet' = 'qb';
 try {
 const qbInvoices = await queryOpenInvoices();
 const today = new Date();
 const allInvoices: Invoice[] = qbInvoices.map((inv) => {
 const issued = new Date(inv.TxnDate);
 const days = Math.max(0, Math.floor((today.getTime() - issued.getTime()) / (1000 * 60 * 60 * 24)));
 return {
 customer: inv.CustomerRef?.name ?? 'Unknown',
 description: inv.PrivateNote ?? inv.CustomerMemo?.value ?? `Invoice #${inv.DocNumber ?? inv.Id}`,
 invoiceNumber: inv.DocNumber,
 issueDate: inv.TxnDate,
 dueDate: inv.DueDate,
 amount: inv.Balance ?? 0,
 daysOpen: days,
 bucket: bucketDaysOpen(days),
 };
 });
 const isIntercompany = (i: Invoice) => /purex|intercompany/i.test(i.customer);
 externalInvoices = allInvoices.filter((i) => !isIntercompany(i)).sort((a, b) => b.daysOpen - a.daysOpen);
 intercompanyInvoices = allInvoices.filter(isIntercompany).sort((a, b) => b.daysOpen - a.daysOpen);
 } catch (e) {
 warnings.push(`AR query failed: ${e instanceof Error ? e.message : '?'} - using sheet AR (3 Gelato invoices).`);
 arSource = 'sheet';
 externalInvoices = [
 { customer: 'Gelato Innovations', description: 'Gelato Batch INV #06, Jan 2026 (Net 90, due ~Apr 2026)', invoiceNumber: 'GEL-INV-06', issueDate: '2026-02-01', amount: 249_091.65, daysOpen: 100, bucket: '90+' },
 { customer: 'Gelato Innovations', description: 'Gelato Batch INV #07, Feb 2026 (Net 90, due ~May 2026)', invoiceNumber: 'GEL-INV-07', issueDate: '2026-03-01', amount: 136_583.13, daysOpen: 70, bucket: '61-90' },
 { customer: 'Gelato Innovations', description: 'Gelato Batch INV #08, Mar 2026 (Net 90, due ~Jun 2026)', invoiceNumber: 'GEL-INV-08', issueDate: '2026-04-01', amount: 168_614.00, daysOpen: 40, bucket: '31-60' },
 ];
 }
 const grossExternal = externalInvoices.reduce((s, i) => s + i.amount, 0);
 const grossIntercompany = intercompanyInvoices.reduce((s, i) => s + i.amount, 0);
 const netCollectibleAr = grossExternal * (1 - AR_BUFFER_PCT);

 if (externalInvoices.length === 0 && arSource === 'qb') {
 warnings.push(`No external (3rd-party) open invoices found in QB. Only intercompany invoices exist (${intercompanyInvoices.length} totaling ${grossIntercompany.toLocaleString()}). Sheet shows 3 Gelato invoices - verify whether they are still open or have been paid.`);
 }

 // 5. NET LIQUIDITY POSITION
 const netLiquidity = {
 totalCash: cashTotal,
 creditCardDebt: businessTotal,
 purexClearing: clearingBalance,
 netCollectibleAr,
 netWorkingCapital: cashTotal - businessTotal + clearingBalance + netCollectibleAr,
 };

 return {
 asOf: new Date().toISOString(),
 realmId,
 cash: { accounts: cashAccounts, total: cashTotal, totalSource: cashSource },
 creditCards: {
 business: businessCc,
 personal: personalCc,
 businessTotal,
 businessMinTotal,
 source: 'qb',
 },
 intercompany: {
 clearingBalance,
 clearingSource,
 expectedRemittanceWk1: PUREX_LUMP_SUM,
 accounts: intercompanyLines,
 notes: 'Working capital cushion. Negative balance = PureX paid more on our behalf than collected so far.',
 },
 receivables: {
 external: externalInvoices,
 intercompany: intercompanyInvoices,
 grossExternal,
 grossIntercompany,
 bufferPct: AR_BUFFER_PCT,
 netCollectibleAr,
 arSource,
 },
 netLiquidity,
 warnings,
 };
}
