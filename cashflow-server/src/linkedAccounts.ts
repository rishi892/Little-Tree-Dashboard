/**
 * Linked accounts - joins QB chart of accounts (the canonical "what to show"
 * list) with Tiller balances (the canonical "what's the current $" source).
 *
 * Rule: only accounts that exist in QB are shown. Balances come from Tiller,
 * matched by any 4-digit mask present in the account names. Intercompany
 * accounts (PureX / Due to/from / clearing) are excluded from cash.
 */

import { QBO_API_BASE } from './config.js';
import { getValidAccessToken } from './oauth.js';
import { getTillerBalances, type TillerAccount } from './tiller.js';
import {
 getCcTillerSchedule, findScheduleRow, getHardcodedScheduleFor,
 type CcStatementRow,
} from './ccTillerSchedule.js';

type QbAccount = {
 Id: string;
 Name: string;
 AccountType: string;
 AccountSubType?: string;
 CurrentBalance?: number;
 Active?: boolean;
};
type AccountQueryResponse = { QueryResponse: { Account?: QbAccount[] } };

async function qboGetAccounts(types: string[]): Promise<QbAccount[]> {
 const tok = await getValidAccessToken();
 const typeClause = types.map((t) => `'${t}'`).join(',');
 const q = encodeURIComponent(`select * from Account where AccountType in (${typeClause})`);
 const url = `${QBO_API_BASE}/v3/company/${tok.realmId}/query?query=${q}&minorversion=70`;
 const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: 'application/json' } });
 if (!r.ok) throw new Error(`QB query failed: ${r.status} ${await r.text()}`);
 const d = (await r.json()) as AccountQueryResponse;
 return (d.QueryResponse.Account ?? []).filter((a) => a.Active !== false);
}

/**
 * Pull every 4-digit window out of any digit run in the name. Examples:
 * "Basic Business Checking (7561) - 2" → ["7561"]
 * "AMEX 11007" → ["1100", "1007"]
 * "AMEX 81009" → ["8100", "1009"]
 * "CREDIT CARD (Chase -4158)" → ["4158"]
 * Rolling window ensures we don't miss a mask buried inside a longer digit
 * sequence (e.g. QB sometimes prefixes an internal ID).
 */
function extractMasks(name: string): string[] {
 const seen = new Set<string>();
 for (const run of name.match(/\d+/g) ?? []) {
 if (run.length < 4) continue;
 for (let i = 0; i <= run.length - 4; i++) seen.add(run.slice(i, i + 4));
 }
 return Array.from(seen);
}

export type QbLine = {
 name: string;
 accountType: string; // 'Bank' | 'Credit Card'
 subType: string | null;
 masks: string[]; // 4-digit masks extracted from name
 balance: number; // QB book balance
};

export type TillerLine = {
 name: string;
 type: string; // depository | credit | loan | investment | …
 masks: string[];
 balance: number;
 lastUpdated: string;
 balanceAvailable: number | null; // credit cards: how much you can still spend
 balanceLimit: number | null; // credit cards: total credit line
 usePct: number | null; // utilization 0..1
 // Statement schedule (credit cards only - null when not available)
 lastStatementClose: string | null;
 lastStatementPayment: string | null;
 lastStatementStatus: string | null;
 nextPayment: string | null;
 nextClosing: string | null;
 freezeWindow: string | null;
 scheduleNotes: string | null;
};

export type LinkedBalances = {
 fetchedAt: string;
 tillerLatestDate: string;
 sheetUrl: string;
 realmId: string | null;
 qb: {
 cashAccounts: QbLine[];
 creditCards: QbLine[];
 cashTotal: number;
 creditTotal: number;
 intercompanyExcluded: QbLine[]; // PureX/Due to-from etc., shown separately
 };
 tiller: {
 cashAccounts: TillerLine[];
 creditCards: TillerLine[];
 loans: TillerLine[];
 investments: TillerLine[];
 cashTotal: number;
 creditTotal: number;
 };
 warnings: string[];
};

const INTERCOMPANY_RE = /purex|intercompany|clearing|due (to|from)/i;

function toQbLine(a: QbAccount): QbLine {
 return {
 name: a.Name,
 accountType: a.AccountType,
 subType: a.AccountSubType ?? null,
 masks: extractMasks(a.Name),
 balance: a.CurrentBalance ?? 0,
 };
}

function toTillerLine(a: TillerAccount, schedule: CcStatementRow[] = []): TillerLine {
 // Treat both credit cards and credit-line loans (e.g. MC Consumer which
 // Tiller buckets as `loan`) as schedule-eligible.
 const isCardish = a.type === 'credit' || a.type === 'loan';
 let tillerRow: CcStatementRow | null = null;
 if (isCardish && schedule.length > 0) {
 const cleanName = a.name.split(/[\(·・]/)[0].trim();
 if (cleanName) {
 const pat = new RegExp(cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
 tillerRow = findScheduleRow(schedule, pat);
 }
 }
 const hard = isCardish ? getHardcodedScheduleFor(a.name) : null;
 return {
 name: a.name,
 type: a.type,
 masks: extractMasks(a.name),
 balance: a.balance,
 lastUpdated: a.lastUpdated,
 balanceAvailable: a.balanceAvailable,
 balanceLimit: a.balanceLimit,
 usePct: a.usePct,
 lastStatementClose: tillerRow?.lastClose ?? hard?.lastClose ?? null,
 lastStatementPayment: tillerRow?.lastPayment ?? hard?.lastPayment ?? null,
 lastStatementStatus: tillerRow?.lastStatus ?? null,
 nextPayment: tillerRow?.nextPayment ?? hard?.nextPayment ?? null,
 nextClosing: tillerRow?.nextClosing ?? hard?.nextClosing ?? null,
 freezeWindow: tillerRow?.freezeWindow ?? null,
 scheduleNotes: tillerRow?.notes ?? null,
 };
}

// Last successful QB account pull. On a transient (non-auth) failure we reuse
// this so the QB column doesn't blink empty between good polls.
let lastGoodQb: { bank: QbAccount[]; cc: QbAccount[]; realmId: string } | null = null;

export async function getLinkedBalances(): Promise<LinkedBalances> {
 const warnings: string[] = [];
 let realmId: string | null = null;
 let qbBank: QbAccount[] = [];
 let qbCC: QbAccount[] = [];
 try {
 const tok = await getValidAccessToken();
 realmId = tok.realmId;
 const [bank, cc] = await Promise.all([
 qboGetAccounts(['Bank']),
 qboGetAccounts(['Credit Card']),
 ]);
 qbBank = bank;
 qbCC = cc;
 lastGoodQb = { bank, cc, realmId };
 } catch (e) {
 const msg = e instanceof Error ? e.message : String(e);
 // Only call it "not connected" for a GENUINE auth failure (missing token /
 // 401 / invalid_grant). A transient timeout or 5xx must NOT say "not
 // connected" - the frontend would flip to the "Connect QuickBooks" screen and
 // flicker on the next good poll. The token is fine; this just retries.
 const isAuth = /not connected|auth\/connect|unauthor|\b401\b|invalid[_ ]?grant|refresh token|authenticationfailed|\b3200\b/i.test(msg);
 if (isAuth) {
 warnings.push(`QB not connected (${msg}). QB column will be empty.`);
 } else if (lastGoodQb) {
 // Transient: serve the last good QB data so nothing blinks.
 qbBank = lastGoodQb.bank;
 qbCC = lastGoodQb.cc;
 realmId = lastGoodQb.realmId;
 warnings.push(`QB data temporarily unavailable; showing last values, retrying.`);
 } else {
 warnings.push(`QB data temporarily unavailable; retrying.`);
 }
 }

 const [tiller, ccSchedule] = await Promise.all([
 getTillerBalances(),
 getCcTillerSchedule().catch((e) => {
 warnings.push(`CC schedule fetch failed (${e instanceof Error ? e.message : '?'}) - statement dates unavailable.`);
 return [] as CcStatementRow[];
 }),
 ]);

 // Split bank accounts: real cash vs intercompany (PureX etc.)
 const qbCashLines = qbBank.filter((a) => !INTERCOMPANY_RE.test(a.Name)).map(toQbLine);
 const qbInterLines = qbBank.filter((a) => INTERCOMPANY_RE.test(a.Name)).map(toQbLine);
 const qbCcLines = qbCC.map(toQbLine);

 // Sort by balance magnitude descending so the eye lands on big rows first.
 const sortByMag = <T extends { balance: number }>(a: T, b: T) => Math.abs(b.balance) - Math.abs(a.balance);
 qbCashLines.sort(sortByMag);
 qbCcLines.sort(sortByMag);

 const tillerCash = tiller.cashAccounts.map((a) => toTillerLine(a, ccSchedule)).sort(sortByMag);
 const tillerCC = tiller.creditCards.map((a) => toTillerLine(a, ccSchedule)).sort(sortByMag);
 const tillerLoans = tiller.loans.map((a) => toTillerLine(a, ccSchedule)).sort(sortByMag);
 const tillerInv = tiller.investments.map((a) => toTillerLine(a, ccSchedule)).sort(sortByMag);

 return {
 fetchedAt: new Date().toISOString(),
 tillerLatestDate: tiller.latestDate,
 sheetUrl: tiller.sheetUrl,
 realmId,
 qb: {
 cashAccounts: qbCashLines,
 creditCards: qbCcLines,
 cashTotal: qbCashLines.reduce((s, a) => s + a.balance, 0),
 creditTotal: qbCcLines.reduce((s, a) => s + Math.abs(a.balance), 0),
 intercompanyExcluded: qbInterLines,
 },
 tiller: {
 cashAccounts: tillerCash,
 creditCards: tillerCC,
 loans: tillerLoans,
 investments: tillerInv,
 cashTotal: tillerCash.reduce((s, a) => s + a.balance, 0),
 creditTotal: tillerCC.reduce((s, a) => s + Math.abs(a.balance), 0),
 },
 warnings,
 };
}
