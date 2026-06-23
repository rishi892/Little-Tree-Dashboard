/**
 * Sheet-structured expenses (PureX / Moysh / Combined) populated from QB.
 *
 * Goal: keep the EXACT 26-row category layout the lender sheet uses, but pull
 * the monthly values live from QB by matching each sheet row to one or more
 * QB account names via a regex pattern.
 *
 * Source: /api/expense-detail underlying data (perEntity breakdown).
 */

import { getExpenseDetail, invalidateExpenseDetailCache, type ExpenseDetailRow } from './expenseDetail.js';
import { loadOverrides } from './categoryOverrides.js';
import { getAccountTransactions, invalidateAccountTransactionsCache } from './accountTransactions.js';
import { computeMoyshPayroll } from './moyshPayrollByVendor.js';
import { getPurexPayrollFromSheet } from './purexPayrollSheet.js';

export type SheetGroup = 'Payroll' | 'Non-Payroll';
export type SheetEntity = 'PureX' | 'Moysh' | 'Combined';

type SheetCategory = {
 group: SheetGroup;
 label: string;
 match: RegExp; // matches QB account names (case-insensitive expected)
 forceGroup?: boolean; // if true, match regardless of QB's group classification
};

/**
 * Mapping: ordered sheet rows → QB account regex (FIRST MATCH WINS per QB
 * account). More specific patterns must come BEFORE more general ones.
 */

/**
 * Default category layout used for PureX and Combined views.
 */
const SHEET_CATEGORIES_DEFAULT: SheetCategory[] = [
 // ---- Payroll group ----
 // Single rolled-up Payroll Total row - all wages, exec salaries, contractors,
 // payroll fees/taxes/benefits, production crew. PureX/Moysh split comes from
 // the source-bank detection in expenseDetail.
 // Tightened: 'reimbursement' requires payroll/employee context (was catching
 // travel/vehicle/mileage reimbursement and inflating Moysh payroll).
 { group: 'Payroll', label: 'Payroll Total', match: /production payroll|armandos crew|^crew\b|cogs labor|cost of labor|direct production|rawad adam|payroll fees|teg payroll|gusto|employer payroll taxes|employee\s+reimburse|payroll\s+reimburse|cash payroll|^cmo\b|^cfo\b|^ceo\b|^coo\b|chief executive|chief financial|chief marketing|chief operating|joseph tuchman|phillip macko|rishi arora|carol tuchman|johan vanblerk|martin tuchman|nishara|natasa falsetti|executive assistant|angus ritchie|abdul basit|^precious\b|junelyn|hafiz|mark keranen|daria malovichko|hamza riaz|david dacew|syed\s*rehan|contract labor|recruitment|upwork|fiverr|^contractor\b|freelance|ar specialist|^ajita\b/i, forceGroup: true },

 // ---- Non-Payroll: COGS & inventory ----
 { group: 'Non-Payroll', label: 'Inventory & Raw Materials', match: /^inventory|raw material|supplies\s*&\s*materials|^materials\b/i },
 { group: 'Non-Payroll', label: 'COGS - Compliance Testing', match: /compliance testing/i },
 { group: 'Non-Payroll', label: 'COGS - Packaging & Labels', match: /packag.*label|label costs|packag/i },
 { group: 'Non-Payroll', label: 'COGS - Shipping', match: /(^|:)\s*shipping\s*($|:)/i },
 { group: 'Non-Payroll', label: 'Shipping & Postage', match: /shipping\s*(&|and)\s*postage/i },
 { group: 'Non-Payroll', label: 'COGS - Other', match: /^consumables$|royalty expense/i },

 // ---- Non-Payroll: operating ----
 { group: 'Non-Payroll', label: 'Vehicle & Transportation', match: /vehicle\s+(fines|gas|insurance|payments|registration|rental|repairs|wash)|parking\s*&\s*tolls/i },
 { group: 'Non-Payroll', label: 'Rent / Building Lease', match: /^rent$|building.*land.*rent|building\s*&\s*land/i },
 { group: 'Non-Payroll', label: 'Utilities', match: /\butilities\b|phone\s*&\s*internet|disposal\s*&\s*waste|personal utilities|city of auburn|r&d phone|electricity|water\s*bill/i },
 { group: 'Non-Payroll', label: 'HVAC & Maintenance', match: /hvac/i },
 { group: 'Non-Payroll', label: 'Business Insurance', match: /^insurance$|business insurance/i },
 { group: 'Non-Payroll', label: 'Software & Subscriptions', match: /software\s*&\s*apps|^software\b|r&d apps|membership|subscription/i },
 { group: 'Non-Payroll', label: 'Marketing & Advertising', match: /general marketing|listing fees?|sponsorship|\badvertis|\bmarketing\b|promotional|gift\s*(to|for)\s*(client|customer)/i },
 { group: 'Non-Payroll', label: 'Legal & Accounting', match: /accounting\s*fees?|\blegal\s*(&|and)?\s*(professional|accounting)|legal\s*fees?|other\s*legal|professional\s*services?|professional\s*fees?|\blegal\b|attorney|cpa|bookkeep/i },
 { group: 'Non-Payroll', label: 'Travel & Hotels', match: /(^|:)\s*travel\s*($|:)|airfare|(^|:)\s*hotels\s*($|:)|taxis or shared rides|\bairlines?\b|lodging/i },
 { group: 'Non-Payroll', label: 'Meals & Entertainment', match: /(^|:)\s*meals\s*($|:)|travel meals|meals with clients|personal meals|(^|:)\s*entertainment\s*($|:)|business\s*meals/i },
 { group: 'Non-Payroll', label: 'Office Supplies & Storage', match: /office\s*supplies?|office\s*expenses?|storage\s*&\s*organisation|storage\s*rentals?/i },
 { group: 'Non-Payroll', label: 'Operating Supplies & Tools', match: /operating supplies?|small tools\s*&\s*equipment/i },
 { group: 'Non-Payroll', label: 'R&D - Other', match: /research\s*and\s*development|^r&d|\br\s*&\s*d\b/i },
 { group: 'Non-Payroll', label: 'Bank & Merchant Fees', match: /^amex\s+\d+|^cc\s+\d+|^chase\s+\d+|^citi\s+\d+|^fnbo$|^purex$|merchant\s*account\s*fees|business\s*loan\s*interest|bank\s*service\s*charges|bank\s*fees|interest\s*expense|finance\s*charge|^long[-\s]*term\s*business\s*loans?|loan\s*interest|loan\s*payments?|credit\s*card\s*interest/i },
 { group: 'Non-Payroll', label: 'Capital Items (Furniture/Equipment)', match: /furniture\s*&\s*fixtures|long-term office equipment|tools,\s*machinery|computers/i },
 { group: 'Non-Payroll', label: 'Vendor Payments via A/P (uncategorized)', match: /vendor.*a\/p|accounts payable.*uncateg/i },
 { group: 'Non-Payroll', label: 'Cannabis Excise Tax', match: /excise tax|cannabis tax|24%\s*tax/i },
 { group: 'Non-Payroll', label: 'Taxes & Licenses', match: /tax paid|business licenses?|personal property tax|24%\s*wholesale tax/i },
 { group: 'Non-Payroll', label: 'Other Operating Expenses', match: /cleaning supplies?|continuing education|convinience(\s*store)?|designing fee|^plumber\b|printing\s*(&|and)\s*photocopy|tooling\s*(&|and)\s*plating|^uniforms?$|repairs?\s*(&|and)\s*maintenance/i },
 { group: 'Non-Payroll', label: 'Other (Penalties/Donations/Refunds)', match: /^donation|penalt.*settlement|settlements?\s*(&|and)\s*penalt|refunds?/i },
 { group: 'Non-Payroll', label: 'Other / Uncategorized', match: /uncategorized|cone factory|collection fee|other.*operating/i },
];

/**
 * Moysh-specific category layout - split executives from generic team payroll,
 * isolate contractors, and reorder per the lender sheet's Moysh column.
 * Order matters: first-match-wins per QB account.
 */
const SHEET_CATEGORIES_MOYSH: SheetCategory[] = [
 // ---- Payroll group ----
 // Single rolled-up Payroll Total row - wages, exec salaries, contractors,
 // payroll fees/taxes/benefits, production crew. PureX/Moysh split comes from
 // the source-bank detection in expenseDetail.
 // Tightened: 'reimbursement' requires payroll/employee context (was catching
 // travel/vehicle/mileage reimbursement and inflating Moysh payroll).
 { group: 'Payroll', label: 'Payroll Total', match: /production payroll|armandos crew|^crew\b|cogs labor|cost of labor|direct production|rawad adam|payroll fees|teg payroll|gusto|employer payroll taxes|employee\s+reimburse|payroll\s+reimburse|cash payroll|^cmo\b|^cfo\b|^ceo\b|^coo\b|chief executive|chief financial|chief marketing|chief operating|joseph tuchman|phillip macko|rishi arora|carol tuchman|johan vanblerk|martin tuchman|nishara|natasa falsetti|executive assistant|angus ritchie|abdul basit|^precious\b|junelyn|hafiz|mark keranen|daria malovichko|hamza riaz|david dacew|syed\s*rehan|contract labor|recruitment|upwork|fiverr|^contractor\b|freelance|ar specialist|^ajita\b/i, forceGroup: true },

 // ---- Non-Payroll: COGS & inventory ----
 { group: 'Non-Payroll', label: 'Inventory & Raw Materials', match: /^inventory|raw material|supplies\s*&\s*materials|^materials\b/i },
 { group: 'Non-Payroll', label: 'COGS - Compliance Testing', match: /compliance testing/i },
 { group: 'Non-Payroll', label: 'COGS - Packaging & Labels', match: /packag.*label|label costs|packag/i },
 { group: 'Non-Payroll', label: 'COGS - Other', match: /^consumables$|royalty expense/i },

 // ---- Non-Payroll: operating (lender Moysh-column order) ----
 { group: 'Non-Payroll', label: 'Rent / Building Lease', match: /^rent$|building.*land.*rent|building\s*&\s*land/i },
 { group: 'Non-Payroll', label: 'Utilities', match: /\butilities\b|phone\s*&\s*internet|disposal\s*&\s*waste|personal utilities|city of auburn|r&d phone|electricity|water\s*bill/i },
 { group: 'Non-Payroll', label: 'HVAC & Maintenance', match: /hvac/i },
 { group: 'Non-Payroll', label: 'Software & Subscriptions', match: /software\s*&\s*apps|^software\b|r&d apps|membership|subscription/i },
 { group: 'Non-Payroll', label: 'Marketing & Advertising', match: /general marketing|listing fees?|sponsorship/i },
 { group: 'Non-Payroll', label: 'Legal & Accounting', match: /accounting\s*fees?|\blegal\s*(&|and)?\s*(professional|accounting)|legal\s*fees?|other\s*legal|professional\s*services?|professional\s*fees?|\blegal\b|attorney|cpa|bookkeep/i },
 { group: 'Non-Payroll', label: 'Business Insurance', match: /^insurance$|business insurance/i },
 // Vehicle BEFORE Travel so "Vehicle insurance", "Vehicle gas & fuel", "Vehicle registration" don't drift.
 { group: 'Non-Payroll', label: 'Vehicle & Transportation', match: /vehicle\s+(fines|gas|insurance|payments|registration|rental|repairs|wash)|parking\s*&\s*tolls/i },
 { group: 'Non-Payroll', label: 'Travel & Hotels', match: /(^|:)\s*travel\s*($|:)|airfare|(^|:)\s*hotels\s*($|:)|taxis or shared rides/i },
 { group: 'Non-Payroll', label: 'Meals & Entertainment', match: /(^|:)\s*meals\s*($|:)|travel meals|meals with clients|personal meals|(^|:)\s*entertainment\s*($|:)/i },
 { group: 'Non-Payroll', label: 'Office Supplies & Storage', match: /office supplies?|office expenses?|storage\s*&\s*organisation|storage rentals?/i },
 { group: 'Non-Payroll', label: 'Operating Supplies & Tools', match: /operating supplies?|small tools\s*&\s*equipment/i },
 { group: 'Non-Payroll', label: 'R&D - Other', match: /research and development|^r&d/i },
 { group: 'Non-Payroll', label: 'Taxes & Licenses', match: /tax paid|business licenses?|personal property tax|24%\s*wholesale tax/i },
 { group: 'Non-Payroll', label: 'Shipping & Postage', match: /shipping\s*(&|and)\s*postage/i },
 { group: 'Non-Payroll', label: 'Capital Items (Furniture/Equipment)', match: /furniture\s*&\s*fixtures|long-term office equipment|tools,\s*machinery|computers/i },
 // Other Operating Expenses - bank/merchant/CC items + miscellaneous operating
 // accounts (cleaning, education, plumber, uniforms, repairs etc.) that don't
 // map cleanly to a lender-named row.
 { group: 'Non-Payroll', label: 'Other Operating Expenses', match: /merchant account fees|bank\s*&\s*other charges|interest and bank|credit card payments|^cc\s+\d+|^chase\s+\d+|^amex\s+\d+|^citi\s+\d+|^mc\s+\d+|vendor.*a\/p|accounts payable.*uncateg|cleaning supplies?|continuing education|convinience(\s*store)?|designing fee|^plumber\b|printing\s*(&|and)\s*photocopy|tooling\s*(&|and)\s*plating|^uniforms?$|repairs?\s*(&|and)\s*maintenance/i },
 { group: 'Non-Payroll', label: 'Other (Penalties/Donations/Refunds)', match: /^donation|penalt.*settlement|settlements?\s*(&|and)\s*penalt|refunds?/i },
 { group: 'Non-Payroll', label: 'Other / Uncategorized', match: /uncategorized|cone factory|collection fee/i },
];

function categoriesFor(entity: SheetEntity): SheetCategory[] {
 return entity === 'Moysh' ? SHEET_CATEGORIES_MOYSH : SHEET_CATEGORIES_DEFAULT;
}

/**
 * Extra QB account names that should feed a given sheet category, even if
 * they don't show in the QB P&L Report (e.g. equity accounts like shareholder
 * distributions, asset accounts like R&D). These get fetched separately via
 * the per-account transaction report and merged into the row.
 */
const CATEGORY_EXTRA_SOURCES: Record<string, string[]> = {
 'Utilities': [
 'Disposal & waste fees',
 'Personal Utilities',
 'City of Auburn Hills',
 'R&D Phone & Internet',
 ],
 'Software & Subscriptions': [
 'R&D Apps & softwares',
 'R&D Memberships & Subscription',
 ],
 'Vehicle & Transportation': [
 'Vehicles',
 ],
 'Office Supplies & Storage': [
 'R&D Office expenses & supplies',
 'R&D Storage & organisation',
 'Storage Rentals',
 ],
 'Operating Supplies & Tools': [
 'R&D Operating supplies',
 'R&D Tools & equip',
 ],
 'Bank & Merchant Fees': [
 'FNBO',
 'Bank Service Charges',
 ],
 'Capital Items (Furniture/Equipment)': [
 'Furniture & fixtures',
 'Long-term office equipment',
 'Tools, machinery, and equipment',
 'Computers',
 ],
 'R&D - Other': [
 'R&D others',
 'Electrical- Research & Development Room',
 'Research and Development products',
 ],
 'Other Operating Expenses': [
 'Cleaning supplies',
 'Continuing education',
 'Convinience Store',
 'Designing Fee',
 'Plumber',
 'Printing & photocopying',
 'Tooling & Plating Fee',
 'Uniforms',
 'Repairs & maintenance',
 ],
 'Other (Penalties/Donations/Refunds)': [
 'Donation',
 'Penalties & settlements',
 ],
 'Other / Uncategorized': [
 'Uncategorized Expense',
 'Collection Fee',
 'Cone Factory Expense',
 ],
};

export type MappedRow = {
 group: SheetGroup;
 category: string;
 values: number[];
 /** PureX-paid portion per month (always populated regardless of entity). */
 purexValues?: number[];
 /** Moysh-paid portion per month (always populated regardless of entity). */
 moyshValues?: number[];
 qbSources: Array<{ name: string; total: number }>; // accounts that fed this row
};

export type MappedExpensesResult = {
 asOf: string;
 entity: SheetEntity;
 months: string[];
 monthLabels: string[];
 rows: MappedRow[];
 unmatched: Array<{ category: string; group: string; total: number }>; // QB rows no sheet category caught
};

/** Compute a single sheet row's monthly values for the given entity.
 * First-match-wins: skips QB accounts already claimed by an earlier category.
 * `forcedAccounts` are accounts that the user manually routed to THIS category
 * via overrides - added unconditionally regardless of regex. */
function aggregateRow(
 cat: SheetCategory,
 detail: ExpenseDetailRow[],
 entity: SheetEntity,
 monthCount: number,
 alreadyClaimed: Set<string>,
 forcedAccounts: Set<string>,
): {
 values: number[];
 purexValues: number[];
 moyshValues: number[];
 qbSources: Array<{ name: string; total: number }>;
 matchedIds: Set<string>;
} {
 const values = new Array(monthCount).fill(0);
 const purexValues = new Array(monthCount).fill(0);
 const moyshValues = new Array(monthCount).fill(0);
 const qbSources: Array<{ name: string; total: number }> = [];
 const matchedIds = new Set<string>();
 for (const r of detail) {
 // Dedupe by FullyQualifiedName so two accounts sharing a short Name
 // (e.g. "Rent" top-level vs "Gelato Expenses:Rent") aren't both claimed.
 const fqn = r.fullyQualifiedName ?? r.category;
 if (alreadyClaimed.has(fqn)) continue;
 const isForced = forcedAccounts.has(r.category);
 if (!isForced) {
 const matchesSelf = cat.match.test(r.category);
 const matchesParent = r.parentAccountName ? cat.match.test(r.parentAccountName) : false;
 if (!matchesSelf && !matchesParent) continue;
 if (!cat.forceGroup && r.group !== cat.group) continue;
 // If this is a sub-account, decide whether it belongs here based on its
 // parent. Reject when the parent is a SPECIFIC business section (like
 // "Gelato Expenses") - its children should go with that section, not
 // here. Allow when the parent is one of QB's structural groupings (like
 // "Cost of goods sold" → "Shipping") since those are just chart-of-
 // accounts scaffolding.
 const isSubAccount = !!r.fullyQualifiedName && r.fullyQualifiedName.includes(':');
 if (isSubAccount) {
 const parentName = (r.parentAccountName ?? '').toLowerCase();
 const STRUCTURAL_PARENTS = new Set([
 'cost of goods sold',
 'expenses',
 'income',
 'other income',
 'other expense',
 'general & administrative expenses',
 'interest and bank charges',
 'bank & other charges',
 ]);
 const isStructural = STRUCTURAL_PARENTS.has(parentName);
 // Non-structural parent (e.g. "Gelato Expenses") and the full path
 // doesn't itself match this category → it belongs elsewhere.
 if (!isStructural && !cat.match.test(r.fullyQualifiedName!)) continue;
 }
 }
 matchedIds.add(fqn);
 // 'values' is the entity-scoped main number, 'purexValues' / 'moyshValues'
 // are always populated so the UI can show the split on any tab.
 const series =
 entity === 'PureX' ? r.perEntity.PureX
 : entity === 'Moysh' ? r.perEntity.Moysh
 : r.monthly;
 for (let i = 0; i < monthCount; i++) {
 values[i] += series[i] ?? 0;
 purexValues[i] += r.perEntity.PureX[i] ?? 0;
 moyshValues[i] += (r.perEntity.Moysh[i] ?? 0) + (r.perEntity.Other[i] ?? 0);
 }
 qbSources.push({ name: r.category, total: series.reduce((s, v) => s + v, 0) });
 }
 qbSources.sort((a, b) => b.total - a.total);
 return { values, purexValues, moyshValues, qbSources, matchedIds };
}

// In-function cache so direct callers (cashflow13, monthlyOpex) share the same
// 60-min cached result as the /api/expenses-mapped route. Without this, every
// short-interval cashflow refresh would re-trigger heavy QB calls.
const MAPPED_CACHE_TTL_MS = 60 * 60 * 1000;
const _mappedCache = new Map<string, { at: number; data: MappedExpensesResult }>();
let _mappedInFlight = new Map<string, Promise<MappedExpensesResult>>();

export async function getMappedExpenses(entity: SheetEntity, months = 14): Promise<MappedExpensesResult> {
 // Combined is a PURE DERIVED VIEW - no own cache, no own QB calls. Always
 // re-composed from the current PureX + Moysh cache state. To "refresh
 // Combined", refresh PureX and Moysh (which Combined inherits automatically).
 if (entity === 'Combined') return _composeCombined(months);

 const key = `${entity}|${months}`;
 const cached = _mappedCache.get(key);
 if (cached && Date.now() - cached.at < MAPPED_CACHE_TTL_MS) return cached.data;
 const inFlight = _mappedInFlight.get(key);
 if (inFlight) return inFlight;
 const promise = (async () => {
 try { return await _getMappedExpensesUncached(entity, months); }
 finally { _mappedInFlight.delete(key); }
 })();
 _mappedInFlight.set(key, promise);
 const data = await promise;
 _mappedCache.set(key, { at: Date.now(), data });
 return data;
}

async function _composeCombined(months: number): Promise<MappedExpensesResult> {
 const [px, mo] = await Promise.all([
 getMappedExpenses('PureX', months),
 getMappedExpenses('Moysh', months),
 ]);
 const monthCount = px.months.length;

 // Union of category labels - preserve Moysh order first (since Moysh layout
 // is the canonical user-facing one), then append any DEFAULT-only labels.
 const seen = new Set<string>();
 const order: Array<{ label: string; group: SheetGroup }> = [];
 for (const r of mo.rows) {
 if (seen.has(r.category)) continue;
 seen.add(r.category);
 order.push({ label: r.category, group: r.group });
 }
 for (const r of px.rows) {
 if (seen.has(r.category)) continue;
 seen.add(r.category);
 order.push({ label: r.category, group: r.group });
 }

 const rows: MappedRow[] = order.map(({ label, group }) => {
 const pxRow = px.rows.find((r) => r.category === label);
 const moRow = mo.rows.find((r) => r.category === label);
 const values = new Array(monthCount).fill(0);
 const purexValues = new Array(monthCount).fill(0);
 const moyshValues = new Array(monthCount).fill(0);
 for (let i = 0; i < monthCount; i++) {
 const pxVal = pxRow?.values[i] ?? 0;
 const moVal = moRow?.values[i] ?? 0;
 values[i] = pxVal + moVal;
 purexValues[i] = pxVal;
 moyshValues[i] = moVal;
 }
 // Merge qbSources by name, summing totals so the drill-down stays accurate.
 const sourceTotals = new Map<string, number>();
 for (const s of pxRow?.qbSources ?? []) sourceTotals.set(s.name, (sourceTotals.get(s.name) ?? 0) + s.total);
 for (const s of moRow?.qbSources ?? []) sourceTotals.set(s.name, (sourceTotals.get(s.name) ?? 0) + s.total);
 const qbSources = [...sourceTotals.entries()]
 .map(([name, total]) => ({ name, total }))
 .sort((a, b) => b.total - a.total);
 return { group, category: label, values, purexValues, moyshValues, qbSources };
 });

 return {
 asOf: new Date().toISOString(),
 entity: 'Combined',
 months: px.months,
 monthLabels: px.monthLabels,
 rows,
 // Combined unmatched = intersection: only show entries unmatched in BOTH.
 unmatched: [],
 };
}

export function invalidateMappedExpensesCache(): void {
 _mappedCache.clear();
 invalidateExpenseDetailCache();
 invalidateAccountTransactionsCache();
}

async function _getMappedExpensesUncached(entity: SheetEntity, months = 14): Promise<MappedExpensesResult> {
 const detail = await getExpenseDetail(months);
 const monthCount = detail.months.length;
 const overrides = await loadOverrides();

 // Build reverse lookup: category label → set of account names manually routed here.
 // Also a set of all overridden account names so the regex layer can skip them.
 const overriddenAccounts = new Set<string>();
 const forcedByCategory = new Map<string, Set<string>>();
 for (const [accName, ov] of Object.entries(overrides)) {
 if (ov.lineItem) {
 overriddenAccounts.add(accName);
 let s = forcedByCategory.get(ov.lineItem);
 if (!s) { s = new Set<string>(); forcedByCategory.set(ov.lineItem, s); }
 s.add(accName);
 }
 }

 const categories = categoriesFor(entity);
 // Pre-claim all overridden accounts so the regex pass below ignores them.
 const allMatched = new Set<string>(overriddenAccounts);
 const rows: MappedRow[] = categories.map((cat) => {
 const forced = forcedByCategory.get(cat.label) ?? new Set<string>();
 // Temporarily remove forced accounts from allMatched so this category can claim them.
 const claimedExceptForced = new Set<string>();
 for (const id of allMatched) if (!forced.has(id)) claimedExceptForced.add(id);
 const { values, purexValues, moyshValues, qbSources, matchedIds } = aggregateRow(cat, detail.rows, entity, monthCount, claimedExceptForced, forced);
 for (const id of matchedIds) allMatched.add(id);
 return { group: cat.group, category: cat.label, values, purexValues, moyshValues, qbSources };
 });

 // ---- Merge in extra sources for categories that include accounts outside
 // of expense-detail (equity, asset, or rolled-up-in-P&L accounts).
 await Promise.all(
 Object.entries(CATEGORY_EXTRA_SOURCES).map(async ([catLabel, extraNames]) => {
 const row = rows.find((r) => r.category === catLabel);
 if (!row) return;
 const existing = new Set(row.qbSources.map((s) => s.name));
 const monthIndex = new Map(detail.months.map((m, i) => [m, i]));
 for (const accName of extraNames) {
 if (existing.has(accName)) continue;
 const extra = await getAccountTransactions(accName).catch(() => null);
 if (!extra || extra.total === 0) {
 // Still surface in qbSources so user sees it on drill (with $0).
 row.qbSources.push({ name: accName, total: 0 });
 continue;
 }
 let accTotal = 0;
 for (const t of extra.transactions) {
 const idx = monthIndex.get(t.date.slice(0, 7));
 if (idx === undefined) continue;
 accTotal += t.amount;
 // Row main values reflect the entity. For PureX entity, only count PureX-paid txns; vice versa.
 if (entity === 'PureX' && t.paidBy !== 'PureX') continue;
 if (entity === 'Moysh' && t.paidBy === 'PureX') continue;
 row.values[idx] += t.amount;
 if (t.paidBy === 'PureX') (row.purexValues ?? [])[idx] += t.amount;
 else (row.moyshValues ?? [])[idx] += t.amount;
 }
 row.qbSources.push({ name: accName, total: accTotal });
 }
 row.qbSources.sort((a, b) => b.total - a.total);
 }),
 );

 // ---- PureX-tab override: REPLACE the QB-derived Payroll Total with the
 // LT Financials sheet (Expenses tab) payroll-only rows. PureX payroll is
 // tracked entirely in the sheet - QB-side payroll entries (Armandos Crew,
 // exec accounts, TEG Payroll, etc.) are ignored for PureX Payroll Total.
 if (entity === 'PureX') {
 try {
 const sheet = await getPurexPayrollFromSheet();
 const payRow = rows.find((r) => r.category === 'Payroll Total');
 if (payRow) {
 let sheetTotalInWindow = 0;
 for (let i = 0; i < detail.months.length; i++) {
 const ym = detail.months[i];
 const sheetVal = sheet.monthlyByYM[ym] ?? 0;
 payRow.values[i] = sheetVal;
 if (payRow.purexValues) payRow.purexValues[i] = sheetVal;
 if (payRow.moyshValues) payRow.moyshValues[i] = 0;
 sheetTotalInWindow += sheetVal;
 }
 payRow.qbSources = [
 { name: `LT Financials sheet (Expenses tab) · ${sheet.rows.length} payroll rows`, total: +sheetTotalInWindow.toFixed(2) },
 ];
 }
 } catch (e) {
 console.error('[mapped-expenses] PureX payroll sheet failed:', e instanceof Error ? e.message : e);
 }
 }

 // ---- Moysh-tab override: replace the regex-derived Payroll Total numbers
 // with the strict 21-person allow-list. Matches QB account names against the
 // master list (CEO/CMO/CFO accounts + Upwork contractors + Wise transfers),
 // then sums only the Moysh-paid portion (perEntity.Moysh).
 if (entity === 'Moysh') {
 const mp = computeMoyshPayroll(detail.rows, detail.months);
 const payRow = rows.find((r) => r.category === 'Payroll Total');
 if (payRow) {
 for (let i = 0; i < detail.months.length; i++) {
 payRow.values[i] = mp.monthly[i] ?? 0;
 if (payRow.moyshValues) payRow.moyshValues[i] = mp.monthly[i] ?? 0;
 }
 payRow.qbSources = mp.byPerson
 .filter((p) => p.total > 0)
 .map((p) => ({ name: `${p.label} (${p.channel})`, total: p.total }));
 }
 }

 // Anything in QB not caught by any sheet category - for transparency / mapping iteration.
 const unmatched: Array<{ category: string; group: string; total: number }> = [];
 for (const r of detail.rows) {
 if (allMatched.has(r.category)) continue;
 const series =
 entity === 'PureX' ? r.perEntity.PureX
 : entity === 'Moysh' ? r.perEntity.Moysh
 : r.monthly;
 const total = series.reduce((s, v) => s + v, 0);
 if (total === 0) continue;
 unmatched.push({ category: r.category, group: r.group, total });
 }
 unmatched.sort((a, b) => b.total - a.total);

 return {
 asOf: detail.asOf,
 entity,
 months: detail.months,
 monthLabels: detail.monthLabels,
 rows,
 unmatched,
 };
}
