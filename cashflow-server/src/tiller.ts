/**
 * Tiller Money sheet reader - pulls LIVE bank balances directly from the user's
 * Tiller Google Sheet (which Tiller updates daily from the actual banks).
 *
 * No auth required - the sheet is public via "Anyone with link can view", and
 * Google's gviz endpoint exposes any tab as CSV:
 * https://docs.google.com/spreadsheets/d/{ID}/gviz/tq?gid={GID}&tqx=out:csv
 *
 * Strategy: fetch the Balance History CSV, group rows by AccountId, pick the
 * row with the most recent date per AccountId - that's the current balance.
 */

const TILLER_SHEET_ID = '1fKuOmTrZX_DWKzYsDhBfmfHZ0KZg-YxhFKao_j8Vj6E';
const TILLER_BALANCES_GID = '410077393'; // Balance History (historical daily)

// "Accounts" tab - canonical current snapshot with proper account names + masks.
const ACCOUNTS_CSV_URL = `https://docs.google.com/spreadsheets/d/${TILLER_SHEET_ID}/gviz/tq?sheet=Accounts&tqx=out:csv`;

export type TillerAccount = {
 accountId: string;
 name: string;
 type: 'depository' | 'credit' | 'loan' | 'investment' | string;
 balance: number;
 balanceAvailable: number | null;
 balanceLimit: number | null;
 usePct: number | null;
 currency: string;
 lastUpdated: string; // YYYY-MM-DD
};

export type TillerBalances = {
 fetchedAt: string;
 latestDate: string;
 sheetUrl: string;
 cashAccounts: TillerAccount[];
 creditCards: TillerAccount[];
 loans: TillerAccount[];
 investments: TillerAccount[];
 other: TillerAccount[];
 staleAccounts: TillerAccount[]; // not updated within STALE_DAYS - excluded from totals
 totals: {
 cash: number;
 creditCardDebt: number; // positive number (sum of |balance| of credit cards)
 loans: number;
 investments: number;
 };
};

// Accounts whose lastUpdated is more than this many days behind the sheet's
// max date are treated as stale (Tiller replaces account IDs over time when a
// bank re-authenticates; the old ID stops updating).
const STALE_DAYS = 30;

// --- CSV parsing (RFC 4180-ish, handles quoted fields, commas, escaped quotes) ---

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
 else { inQuotes = false; }
 } else {
 field += c;
 }
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

function parseMoney(s: string): number | null {
 if (!s) return null;
 const trimmed = s.trim();
 if (!trimmed || trimmed === '-' || trimmed === '$ -') return null;
 // Handle "$ (123.45)" as negative, "$ 123.45" as positive
 const negative = /\(.*\)/.test(trimmed);
 const cleaned = trimmed.replace(/[\$,()\s]/g, '');
 if (!cleaned) return null;
 const n = Number(cleaned);
 if (!Number.isFinite(n)) return null;
 return negative ? -n : n;
}

function parsePct(s: string): number | null {
 if (!s) return null;
 const n = Number(s.trim().replace(/%/g, ''));
 return Number.isFinite(n) ? n / 100 : null;
}

// --- Main fetch ---

/** Convert Tiller's "M/D/YYYY" or "YYYY-MM-DD" → "YYYY-MM-DD". */
function normalizeDate(s: string): string {
 const trimmed = s.trim();
 if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
 const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
 if (m) {
 const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
 return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
 }
 return trimmed;
}

/**
 * The Accounts tab in this Tiller workbook has stale balances (last sync ~Aug-Sep
 * 2025 - before the bank re-link). But its NAME + MASK + INSTITUTION columns
 * are stable. So we use it purely as a lookup table to enrich the fresh Balance
 * History rows with proper labels (mask, institution).
 *
 * Returned shape: rows from the Accounts tab in display order.
 */
type AccountsTabRow = {
 name: string; // e.g. "CRB Indirect" / "CREDIT CARD (-4158)"
 mask: string; // 4 digits without "x"
 institution: string;
 type: string; // CHECKING / SAVINGS / CREDIT / OTHER / etc.
 limit: number | null; // staleness-tolerant - used to disambiguate same-named cards
 staleBalance: number; // from the Accounts tab itself (old, but lets us disambiguate)
};

async function fetchAccountsTab(): Promise<AccountsTabRow[]> {
 const res = await fetch(ACCOUNTS_CSV_URL, { redirect: 'follow' });
 if (!res.ok) return [];
 const rows = parseCsv(await res.text());
 if (rows.length < 2) return [];
 const header = rows[0].map((h) => h.trim());
 const indices = header.map((h, i) => (h.toLowerCase() === 'account' ? i : -1)).filter((i) => i >= 0);
 const nameIdx = indices.length >= 2 ? indices[1] : (indices[0] ?? -1);
 const ix = {
 name: nameIdx,
 mask: header.findIndex((h) => h.toLowerCase() === 'account #'),
 institution: header.findIndex((h) => h.toLowerCase() === 'institution'),
 type: header.findIndex((h) => h.toLowerCase() === 'type'),
 lastBalance: header.findIndex((h) => h.toLowerCase() === 'last balance'),
 };
 const out: AccountsTabRow[] = [];
 for (let i = 1; i < rows.length; i++) {
 const r = rows[i];
 const name = r[ix.name]?.trim();
 if (!name) continue;
 const mask = (r[ix.mask] ?? '').trim().replace(/^x+/i, '');
 const inst = r[ix.institution]?.trim() ?? '';
 const type = r[ix.type]?.trim() ?? '';
 const staleBal = parseMoney(r[ix.lastBalance] ?? '') ?? 0;
 out.push({ name, mask, institution: inst, type, limit: null, staleBalance: staleBal });
 }
 return out;
}

/** Pick the best Accounts-tab row to enrich a Balance History row. */
function enrich(
 bhName: string,
 bhLimit: number | null,
 bhStaleBalance: number,
 accountsTab: AccountsTabRow[],
 usedNames: Set<string>,
): AccountsTabRow | null {
 const nameLower = bhName.toLowerCase();
 // 1. Exact name match (case-insensitive) - most common case.
 let candidates = accountsTab.filter((a) => a.name.toLowerCase() === nameLower);
 if (candidates.length === 0) {
 // 2. "CREDIT CARD (-4158)" matches "CREDIT CARD" - accounts tab is more verbose.
 candidates = accountsTab.filter((a) => a.name.toLowerCase().includes(nameLower) || nameLower.includes(a.name.toLowerCase()));
 }
 if (candidates.length === 0) return null;
 if (candidates.length === 1) return candidates[0];

 // 3. Disambiguate by historical balance magnitude (the Accounts-tab shows
 // liabilities as POSITIVE while Balance History shows them as NEGATIVE -
 // compare absolute values so the proximity ranking lines up).
 const bhMag = Math.abs(bhStaleBalance);
 const ranked = [...candidates].sort((a, b) =>
 Math.abs(Math.abs(a.staleBalance) - bhMag) - Math.abs(Math.abs(b.staleBalance) - bhMag),
 );
 // Prefer an unused row to avoid two BH rows mapping to the same Accounts-tab row.
 const fresh = ranked.find((c) => !usedNames.has(c.name + '|' + c.mask));
 return fresh ?? ranked[0];
}

export async function getTillerBalances(): Promise<TillerBalances> {
 // 1. Fetch Balance History (the FRESH source) and Accounts tab (lookup-only).
 const [bhRes, accountsTab] = await Promise.all([
 fetch(`https://docs.google.com/spreadsheets/d/${TILLER_SHEET_ID}/gviz/tq?gid=${TILLER_BALANCES_GID}&tqx=out:csv`, { redirect: 'follow' }),
 fetchAccountsTab().catch(() => []),
 ]);
 if (!bhRes.ok) throw new Error(`Tiller Balance History fetch failed: ${bhRes.status}`);
 const rows = parseCsv(await bhRes.text());
 if (rows.length < 2) throw new Error('Tiller Balance History returned no data');

 // 2. Parse Balance History columns.
 const header = rows[0].map((h) => h.trim().toLowerCase());
 const idx = {
 date: header.indexOf('date'),
 balance: header.indexOf('balance'),
 avail: header.indexOf('balanceavailable'),
 limit: header.indexOf('balancelimit'),
 use: header.indexOf('usepct'),
 currency: header.indexOf('currency'),
 name: header.indexOf('accountname'),
 id: header.indexOf('accountid'),
 type: header.indexOf('accounttype'),
 };
 if (idx.date < 0 || idx.id < 0 || idx.balance < 0 || idx.name < 0) {
 throw new Error('Balance History missing expected columns. Got: ' + header.join(' | '));
 }

 // 3. Group by AccountId, keep latest row.
 const latestByAccount = new Map<string, { date: string; row: string[] }>();
 for (let i = 1; i < rows.length; i++) {
 const r = rows[i];
 const id = r[idx.id]?.trim();
 const date = r[idx.date]?.trim();
 const balStr = r[idx.balance]?.trim();
 if (!id || !date || !balStr) continue;
 const cur = latestByAccount.get(id);
 if (!cur || date > cur.date) latestByAccount.set(id, { date, row: r });
 }

 // 4. Build accounts, enriching name with mask from Accounts tab where possible.
 function mapType(t: string): TillerAccount['type'] {
 const u = t.toLowerCase();
 if (u === 'depository' || u === 'checking' || u === 'savings' || u === 'cash on hand') return 'depository';
 if (u === 'credit') return 'credit';
 if (u === 'loan' || u === 'mortgage') return 'loan';
 if (u === 'investment' || u === 'brokerage') return 'investment';
 return u || 'other';
 }

 const usedAccounts = new Set<string>();
 const accounts: TillerAccount[] = [];
 for (const { date, row } of latestByAccount.values()) {
 const rawName = row[idx.name]?.trim() || '(unnamed)';
 const balance = parseMoney(row[idx.balance] ?? '') ?? 0;
 const balLimit = idx.limit >= 0 ? parseMoney(row[idx.limit] ?? '') : null;
 const balAvail = idx.avail >= 0 ? parseMoney(row[idx.avail] ?? '') : null;
 const usePct = idx.use >= 0 ? parsePct(row[idx.use] ?? '') : null;
 const typeRaw = idx.type >= 0 ? row[idx.type]?.trim() : '';

 const match = enrich(rawName, balLimit, balance, accountsTab, usedAccounts);
 let displayName = rawName;
 if (match) {
 usedAccounts.add(match.name + '|' + match.mask);
 // Use the Accounts-tab name (richer, e.g. "CREDIT CARD (-4158)") + mask.
 displayName = match.mask ? `${match.name} · ${match.mask}` : match.name;
 }

 accounts.push({
 accountId: row[idx.id].trim(),
 name: displayName,
 type: mapType(typeRaw),
 balance,
 balanceAvailable: balAvail,
 balanceLimit: balLimit,
 usePct,
 currency: idx.currency >= 0 ? row[idx.currency]?.trim() || 'USD' : 'USD',
 lastUpdated: date,
 });
 }

 // Latest date across all accounts (the most recent sync).
 const latestDate = accounts.reduce((max, a) => (a.lastUpdated > max ? a.lastUpdated : max), '');

 // Split stale (>STALE_DAYS behind latest) from active.
 const latestTs = latestDate ? Date.parse(latestDate + 'T00:00:00Z') : 0;
 const isStale = (a: TillerAccount): boolean => {
 if (!latestTs) return false;
 const ts = Date.parse(a.lastUpdated + 'T00:00:00Z');
 return Number.isFinite(ts) && (latestTs - ts) / (1000 * 60 * 60 * 24) > STALE_DAYS;
 };
 const stale = accounts.filter(isStale);
 const active = accounts.filter((a) => !isStale(a));

 // Sort by absolute balance descending within each group for display.
 const sortDesc = (a: TillerAccount, b: TillerAccount) => Math.abs(b.balance) - Math.abs(a.balance);
 const cashAccounts = active.filter((a) => a.type === 'depository').sort(sortDesc);
 const creditCards = active.filter((a) => a.type === 'credit').sort(sortDesc);
 const loans = active.filter((a) => a.type === 'loan').sort(sortDesc);
 const investments = active.filter((a) => a.type === 'investment' || a.type === 'brokerage').sort(sortDesc);
 const other = active.filter(
 (a) => !['depository', 'credit', 'loan', 'investment', 'brokerage'].includes(a.type),
 );

 return {
 fetchedAt: new Date().toISOString(),
 latestDate,
 sheetUrl: `https://docs.google.com/spreadsheets/d/${TILLER_SHEET_ID}/edit#gid=${TILLER_BALANCES_GID}`,
 cashAccounts,
 creditCards,
 loans,
 investments,
 other,
 staleAccounts: stale,
 totals: {
 cash: cashAccounts.reduce((s, a) => s + a.balance, 0),
 creditCardDebt: creditCards.reduce((s, a) => s + Math.abs(a.balance), 0),
 loans: loans.reduce((s, a) => s + Math.abs(a.balance), 0),
 investments: investments.reduce((s, a) => s + a.balance, 0),
 },
 };
}

/**
 * Business cash month-end balances + month-over-month deltas, derived from
 * Tiller's Balance History (daily snapshots). "Business cash" = CRB Indirect
 * 7561 + Business MM 0910 (same filter used by the dashboard cash-on-hand KPI).
 *
 * Returns an array of months in chronological order with:
 * - ym: "YYYY-MM"
 * - endOfMonth: balance on the last available day in that month
 * - delta: endOfMonth − previousMonthEnd (null for first month)
 *
 * Used by the dashboard's "Net cash last/this month" KPI so the number reflects
 * ACTUAL bank balance change, not QB P&L (income − expense).
 */
export type BusinessCashMonth = {
 ym: string;
 endOfMonth: number;
 delta: number | null;
};

const BUSINESS_CASH_RE = /crb indirect|7561|business mm|0910/i;

export async function getBusinessCashMonthly(monthsBack = 12): Promise<BusinessCashMonth[]> {
 const res = await fetch(
 `https://docs.google.com/spreadsheets/d/${TILLER_SHEET_ID}/gviz/tq?gid=${TILLER_BALANCES_GID}&tqx=out:csv`,
 { redirect: 'follow' },
 );
 if (!res.ok) throw new Error(`Tiller Balance History fetch failed: ${res.status}`);
 const rows = parseCsv(await res.text());
 if (rows.length < 2) return [];

 const header = rows[0].map((h) => h.trim().toLowerCase());
 const iDate = header.indexOf('date');
 const iName = header.indexOf('accountname');
 const iId = header.indexOf('accountid');
 const iBal = header.indexOf('balance');
 if (iDate < 0 || iName < 0 || iBal < 0) return [];

 // Group rows by (accountId, ym), keep latest day per (account, month).
 type Latest = { day: string; balance: number };
 const perAccountMonth = new Map<string, Map<string, Latest>>();
 for (let i = 1; i < rows.length; i++) {
 const r = rows[i];
 const name = (r[iName] ?? '').trim();
 if (!BUSINESS_CASH_RE.test(name)) continue;
 const id = (r[iId] ?? name).trim();
 const date = (r[iDate] ?? '').trim();
 const balStr = (r[iBal] ?? '').trim();
 if (!date || !balStr) continue;
 const ym = date.slice(0, 7);
 if (!/^\d{4}-\d{2}$/.test(ym)) continue;
 const bal = parseMoney(balStr) ?? 0;
 let monthMap = perAccountMonth.get(id);
 if (!monthMap) { monthMap = new Map(); perAccountMonth.set(id, monthMap); }
 const cur = monthMap.get(ym);
 if (!cur || cur.day < date) monthMap.set(ym, { day: date, balance: bal });
 }

 // Sum across accounts per month, then build the result in chronological order.
 const monthTotals = new Map<string, number>();
 for (const monthMap of perAccountMonth.values()) {
 for (const [ym, { balance }] of monthMap) {
 monthTotals.set(ym, (monthTotals.get(ym) ?? 0) + balance);
 }
 }
 const orderedYms = [...monthTotals.keys()].sort();
 // Trim to last `monthsBack + 1` so we can compute deltas for `monthsBack`.
 const keep = orderedYms.slice(-(monthsBack + 1));
 const result: BusinessCashMonth[] = [];
 for (let i = 0; i < keep.length; i++) {
 const ym = keep[i];
 const endOfMonth = monthTotals.get(ym)!;
 const prev = i > 0 ? monthTotals.get(keep[i - 1]) : undefined;
 result.push({
 ym,
 endOfMonth: +endOfMonth.toFixed(2),
 delta: prev !== undefined ? +(endOfMonth - prev).toFixed(2) : null,
 });
 }
 return result;
}
