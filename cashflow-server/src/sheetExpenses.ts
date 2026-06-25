/**
 * PureX expenses parsed from the Expenses tab of the Little Tree-Financials
 * workbook (gid=597060736). Every PureX-paid expense is in this tab; we
 * categorise each row so the 13-Week Plan can pull payroll / inventory /
 * other run-rates without going to QB.
 *
 * Categories:
 * - 'payroll' → payroll runs, Armandos Crew, Gusto/TEG fees
 * - 'inventory' → COGS / raw-material spend (compliance testing,
 * packaging, shipping, transport, lab fees)
 * - 'settlement' → "Little Tree INV ###" - PureX paying LT (NOT OpEx)
 * - 'other' → rent, utilities, software, marketing, vendors, etc.
 *
 * Anchored at Jan 2025 (same as other expense pages).
 */

const SHEET_ID = '1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes';
const EXP_GID = '597060736';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${EXP_GID}&tqx=out:csv`;

const FIXED_START = { year: 2025, month: 0 };

/**
 * 26 granular categories matching the lender sheet's "PureX expense detail"
 * row layout (Sheet 3e). Plus `settlement` for "Little Tree Inv" payments
 * which are NOT OpEx (they're PureX→LT cash transfers).
 */
export type SheetExpenseCategory =
 // Payroll group
 | 'PureX Production Payroll'
 | 'COGS Labor (Direct Production)'
 | 'Other Payroll & Team'
 | 'Payroll Fees, Taxes & Benefits'
 // Non-Payroll: COGS / Inventory
 | 'Inventory & Raw Materials'
 | 'COGS - Compliance Testing'
 | 'COGS - Packaging & Labels'
 | 'COGS - Shipping'
 | 'COGS - Other'
 // Non-Payroll: Operating
 | 'Rent / Building Lease'
 | 'Utilities'
 | 'HVAC & Maintenance'
 | 'Insurance'
 | 'Software & Subscriptions'
 | 'Marketing & Advertising'
 | 'Legal & Accounting'
 | 'Travel & Hotels'
 | 'Meals & Entertainment'
 | 'Office Supplies & Storage'
 | 'Operating Supplies & Tools'
 | 'R&D - Other'
 | 'Bank & Merchant Fees'
 | 'Capital Items (Furniture/Equipment)'
 | 'Cannabis Excise Tax'
 | 'Vendor Payments via A/P (uncategorized)'
 | 'Other Operating Expenses'
 | 'Other (Penalties/Donations/Refunds)'
 | 'Other / Uncategorized'
 // Special
 | 'Settlement (PureX→LT)';

export type SheetExpenseGroup = 'Payroll' | 'Non-Payroll' | 'Settlement';

export type SheetExpenseEntry = {
 date: string;
 description: string;
 amount: number;
 category: SheetExpenseCategory;
 group: SheetExpenseGroup;
};

export type CategoryMonthly = {
 months: string[];
 monthLabels: string[];
 monthlyTotals: number[];
 total: number;
 weeklyAvgL3M: number; // L3M avg ÷ 4.33 - feeds 13-Week Plan
 entryCount: number;
};

export type SheetExpensesResult = {
 fetchedAt: string;
 sheetUrl: string;
 months: string[];
 monthLabels: string[];
 /** Per-category monthly totals, keyed by category name. */
 byCategory: Record<string, CategoryMonthly>;
 /** Convenience aggregates. */
 payroll: CategoryMonthly; // sum of all Payroll-group categories
 inventory: CategoryMonthly; // sum of COGS / Inventory categories
 other: CategoryMonthly; // sum of operating non-payroll non-inventory
 settlement: CategoryMonthly; // PureX→LT (NOT OpEx)
 totalOpex: CategoryMonthly; // payroll + inventory + other
 /** All entries (Jan 2025+) for transparency / drill-down. */
 entries: SheetExpenseEntry[];
 /** Ordered list of categories (matches lender sheet layout). */
 categoryOrder: SheetExpenseCategory[];
 /** Group lookup. */
 groupOf: Record<string, SheetExpenseGroup>;
 warnings: string[];
};

// --- Classification: ordered rules (first match wins) ---

type Rule = { category: SheetExpenseCategory; group: SheetExpenseGroup; match: RegExp };

const RULES: Rule[] = [
 // Settlements first - highest priority.
 { category: 'Settlement (PureX→LT)', group: 'Settlement', match: /little tree.*inv|^little\s*tree\b/i },

 // Cannabis excise tax (state tax on adult-use cannabis) - pull out before "tax preparation" catch.
 { category: 'Cannabis Excise Tax', group: 'Non-Payroll', match: /^\d+%?\s*tax\b|excise tax|cannabis tax/i },

 // Payroll group
 { category: 'COGS Labor (Direct Production)', group: 'Payroll', match: /armandos\s*crew|cogs\s*labor|rawad|direct production/i },
 { category: 'Payroll Fees, Taxes & Benefits', group: 'Payroll', match: /gusto.*fee|teg payroll|payroll fees?|payroll taxes?|payroll service|^adp\b/i },
 { category: 'Other Payroll & Team', group: 'Payroll', match: /reimbursement|expenses by others|consultant|^contractor\b|traba inc|pure ?x employees|infineeds solu[tt]+ions|infineeds soluttions/i },
 { category: 'PureX Production Payroll', group: 'Payroll', match: /^payroll|wages?\b|salary|salaries|biweekly/i },

 // COGS - Compliance Testing (specific labs PureX uses).
 { category: 'COGS - Compliance Testing', group: 'Non-Payroll', match: /^testing\b|compliance\s*test|sc labs|act labs|sf labs|encore labs|reassure|puer labs|exact science/i },

 // COGS - Packaging & Labels (boxes/printing/Chinese packaging suppliers).
 { category: 'COGS - Packaging & Labels', group: 'Non-Payroll', match: /packag|^label|us printing|sticker|carton|pouch|grainger\s*boxes|aro\s*connection|chengdu|metro detroit screen|screen printing|glo[a]?bal resources|ifc solutions|4d candles|5d creative|brand my bags/i },

 // COGS - Shipping & Logistics (allow typos: Logisitcs / Logisitics).
 { category: 'COGS - Shipping', group: 'Non-Payroll', match: /^shipping$|shipping.*postage|j&k transport|^transport|deliveries|courier|freight|trucking|lake effect log|accurate expediting|expediting shipping/i },

 // Inventory & Raw Materials - cannabis distillate/oil/flower vendors + food ingredients.
 {
 category: 'Inventory & Raw Materials',
 group: 'Non-Payroll',
 match: /raw material|^inventory|distillate|cone|chocolate|gummies?|live resin|hash rosin|veliche|coc?oa|sugar|flavou?r|honey|isolate|bag\b|pur\s*oils?|puroils?|pure\s*x\s*inv|albanese|fat\s*&?\s*weird|rkive reserve|gamut cannabis|blackstone harvest|northwoods harvest|heritage farm|peppertux|wyatt purp|old 27 extracts|holy smokz|daves?\s*s(w?)eet tooth|dragonfly kitchen|m\.?\s*t\.?\s*of michigan|mt of michigan|makd llc|om processing|libby holdings|blaze process(ing|ng)|^processing dept|michaela holdings|cannasol|trucenta|palmer\s*(&\s*)?holland|valrhona|cargill|lipar[i]?\s*foods|ssdlg|papa s(i|w)ft|ar samona|mar dist|mar distribution|amass global|sysco corp|gelato-\s*little tree/i,
 },

 // COGS - Other (royalties, METRC tracking, misc COGS).
 { category: 'COGS - Other', group: 'Non-Payroll', match: /motas|kola farms|royalty|metrc|seed.*sale|consum|cbc financial/i },

 // Operating expenses.
 { category: 'Rent / Building Lease', group: 'Non-Payroll', match: /rent|lease|building/i },
 { category: 'Utilities', group: 'Non-Payroll', match: /electric|utility|utilities|consumers energy|dte energy|gas company|water|phone|internet/i },
 { category: 'HVAC & Maintenance', group: 'Non-Payroll', match: /hvac|heating|cooling|maintenance|repair|plumb|electrician|roofing|ventilation|ambient temp|aaa plumbing|acs roofing|adm ventilation/i },
 { category: 'Insurance', group: 'Non-Payroll', match: /^insurance\b|rsc insurance|esc ins\.|liability ins|workers comp/i },
 { category: 'Software & Subscriptions', group: 'Non-Payroll', match: /software|subscription|membership|saas|adobe|aws|microsoft|google\s*workspace|slack|notion|stripe.*sub/i },
 { category: 'Marketing & Advertising', group: 'Non-Payroll', match: /marketing|advertising|^ads\b|sponsorship|^design|graphic|listing fee|promotion|lucyd media/i },
 { category: 'Legal & Accounting', group: 'Non-Payroll', match: /legal|attorney|lawyer|accounting|accountant|audit|tax preparation|cpa|amburm law|m\s*&?\s*a executive search|dc startup/i },
 { category: 'Travel & Hotels', group: 'Non-Payroll', match: /travel|airfare|hotel|uber|lyft|^delta\b|southwest|airline|airbnb/i },
 { category: 'Meals & Entertainment', group: 'Non-Payroll', match: /meals|entertainment|restaurant|catering|coffee|dunkin|starbucks|olive garden|christmas (lunch|party)|the hub christmas/i },
 { category: 'Office Supplies & Storage', group: 'Non-Payroll', match: /office supplies?|office expense|^storage|stationery|^paper\b|toner/i },
 { category: 'Operating Supplies & Tools', group: 'Non-Payroll', match: /operating supplies?|^tools|^equipment|uniform|cleaning suppl|hardware|lucid\b|mold|got[- ]?junk|equipment removal/i },
 { category: 'R&D - Other', group: 'Non-Payroll', match: /^r&d\b|research|development|prototype|samples?/i },
 { category: 'Bank & Merchant Fees', group: 'Non-Payroll', match: /bank fee|merchant fee|wire fee|ach fee|service charge|stripe fee|interest charge|cash deposit fee|cash deposit 1%/i },
 { category: 'Capital Items (Furniture/Equipment)', group: 'Non-Payroll', match: /furniture|fixture|^capital\b|computer|laptop|machinery|qsonica|forte order|sonicator/i },
 { category: 'Vendor Payments via A/P (uncategorized)', group: 'Non-Payroll', match: /viritas|maxwell strategy|vendor payment|a\/p/i },

 // Penalties / debt-recovery / refunds.
 { category: 'Other (Penalties/Donations/Refunds)', group: 'Non-Payroll', match: /penalt|donation|refund|^fine\b|chargeback|portfolio recovery|autovest|le grasso|david decrew|venmo/i },
];

function categorize(desc: string): { category: SheetExpenseCategory; group: SheetExpenseGroup } {
 for (const r of RULES) {
 if (r.match.test(desc)) return { category: r.category, group: r.group };
 }
 return { category: 'Other / Uncategorized', group: 'Non-Payroll' };
}

const CATEGORY_ORDER: SheetExpenseCategory[] = [
 // Payroll
 'PureX Production Payroll',
 'COGS Labor (Direct Production)',
 'Other Payroll & Team',
 'Payroll Fees, Taxes & Benefits',
 // COGS
 'Inventory & Raw Materials',
 'COGS - Compliance Testing',
 'COGS - Packaging & Labels',
 'COGS - Shipping',
 'COGS - Other',
 // Operating
 'Rent / Building Lease',
 'Utilities',
 'HVAC & Maintenance',
 'Insurance',
 'Software & Subscriptions',
 'Marketing & Advertising',
 'Legal & Accounting',
 'Travel & Hotels',
 'Meals & Entertainment',
 'Office Supplies & Storage',
 'Operating Supplies & Tools',
 'R&D - Other',
 'Bank & Merchant Fees',
 'Capital Items (Furniture/Equipment)',
 'Cannabis Excise Tax',
 'Vendor Payments via A/P (uncategorized)',
 'Other Operating Expenses',
 'Other (Penalties/Donations/Refunds)',
 'Other / Uncategorized',
];

const PAYROLL_GROUP_CATS = new Set<SheetExpenseCategory>([
 'PureX Production Payroll',
 'COGS Labor (Direct Production)',
 'Other Payroll & Team',
 'Payroll Fees, Taxes & Benefits',
]);
const INVENTORY_GROUP_CATS = new Set<SheetExpenseCategory>([
 'Inventory & Raw Materials',
 'COGS - Compliance Testing',
 'COGS - Packaging & Labels',
 'COGS - Shipping',
 'COGS - Other',
]);

// --- CSV / helpers ---

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
 else if (c === '\r') { /* skip */ }
 else field += c;
 }
 }
 if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
 return rows;
}

function parseMoney(s: string): number {
 const t = (s ?? '').trim();
 if (!t) return 0;
 const negative = /\(.*\)/.test(t) || t.startsWith('-');
 const cleaned = t.replace(/[\$,()\s−-]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

function parseDate(s: string): Date | null {
 const t = (s ?? '').trim();
 if (!t) return null;
 if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(t + 'T00:00:00Z');
 const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
 if (m) {
 const yr = m[3].length === 2 ? Number('20' + m[3]) : Number(m[3]);
 return new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2])));
 }
 return null;
}

function ymd(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function buildMonths(): { months: string[]; labels: string[] } {
 const now = new Date();
 const months: string[] = [];
 const labels: string[] = [];
 let y = FIXED_START.year;
 let m = FIXED_START.month;
 const endY = now.getUTCFullYear();
 const endM = now.getUTCMonth();
 while (y < endY || (y === endY && m < endM)) {
 const d = new Date(Date.UTC(y, m, 1));
 months.push(`${y}-${String(m + 1).padStart(2, '0')}`);
 labels.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
 m++;
 if (m > 11) { m = 0; y++; }
 }
 return { months, labels };
}

function makeCategoryMonthly(
 totals: number[],
 months: string[],
 labels: string[],
 entryCount: number,
): CategoryMonthly {
 const total = +totals.reduce((s, v) => s + v, 0).toFixed(2);
 const l3mStart = Math.max(0, months.length - 3);
 let l3mSum = 0;
 let l3mCount = 0;
 for (let i = l3mStart; i < months.length; i++) {
 l3mSum += totals[i];
 l3mCount++;
 }
 const weeklyAvgL3M = l3mCount > 0 ? +((l3mSum / l3mCount) / 4.33).toFixed(2) : 0;
 return {
 months,
 monthLabels: labels,
 monthlyTotals: totals.map((v) => +v.toFixed(2)),
 total,
 weeklyAvgL3M,
 entryCount,
 };
}

// --- Main ---

export async function getSheetExpenses(): Promise<SheetExpensesResult> {
 const warnings: string[] = [];
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Expenses tab fetch failed: ${res.status}`);
 const rows = parseCsv(await res.text());

 const { months, labels } = buildMonths();
 const monthIndex = new Map(months.map((m, i) => [m, i]));

 // Per-category monthly totals + counts.
 const totalsByCategory = new Map<SheetExpenseCategory, number[]>();
 const countsByCategory = new Map<SheetExpenseCategory, number>();
 const groupOf: Record<string, SheetExpenseGroup> = {};
 const entries: SheetExpenseEntry[] = [];

 for (const r of rows) {
 const desc = (r[2] ?? '').trim();
 if (!desc) continue;
 const date = parseDate(r[1] ?? '');
 const amt = parseMoney(r[3] ?? '');
 if (!date) continue;
 if (amt === 0) continue;

 const { category, group } = categorize(desc);
 groupOf[category] = group;
 // EVERY parsed entry is kept (for the drill-down + date-range actuals),
 // including the current/in-progress month.
 entries.push({ date: ymd(date), description: desc, amount: amt, category, group });

 // The monthly category run-rate (which feeds the BUDGET) only includes
 // COMPLETE months - buildMonths() excludes the current partial month, so its
 // entries fall here with idx === undefined and are skipped from the run-rate
 // (but they ARE in `entries` above).
 const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
 const idx = monthIndex.get(key);
 if (idx === undefined) continue;
 let arr = totalsByCategory.get(category);
 if (!arr) { arr = new Array(months.length).fill(0); totalsByCategory.set(category, arr); }
 arr[idx] += amt;
 countsByCategory.set(category, (countsByCategory.get(category) ?? 0) + 1);
 }

 const byCategory: Record<string, CategoryMonthly> = {};
 for (const cat of CATEGORY_ORDER) {
 const arr = totalsByCategory.get(cat) ?? new Array(months.length).fill(0);
 byCategory[cat] = makeCategoryMonthly(arr, months, labels, countsByCategory.get(cat) ?? 0);
 }
 // Include settlement (not in CATEGORY_ORDER).
 byCategory['Settlement (PureX→LT)'] = makeCategoryMonthly(
 totalsByCategory.get('Settlement (PureX→LT)') ?? new Array(months.length).fill(0),
 months, labels,
 countsByCategory.get('Settlement (PureX→LT)') ?? 0,
 );

 // Aggregate convenience groups.
 function sumGroup(cats: Set<SheetExpenseCategory>): number[] {
 const out = new Array(months.length).fill(0);
 for (const cat of cats) {
 const arr = totalsByCategory.get(cat);
 if (!arr) continue;
 for (let i = 0; i < months.length; i++) out[i] += arr[i];
 }
 return out;
 }
 const payrollTotals = sumGroup(PAYROLL_GROUP_CATS);
 const inventoryTotals = sumGroup(INVENTORY_GROUP_CATS);
 const otherTotals = months.map((_, i) => {
 let s = 0;
 for (const [cat, arr] of totalsByCategory.entries()) {
 if (cat === 'Settlement (PureX→LT)') continue;
 if (PAYROLL_GROUP_CATS.has(cat) || INVENTORY_GROUP_CATS.has(cat)) continue;
 s += arr[i] ?? 0;
 }
 return s;
 });
 const settlementTotals = totalsByCategory.get('Settlement (PureX→LT)') ?? new Array(months.length).fill(0);
 const totalOpexMonthly = months.map((_, i) => payrollTotals[i] + inventoryTotals[i] + otherTotals[i]);

 let pCount = 0, iCount = 0;
 for (const cat of PAYROLL_GROUP_CATS) pCount += countsByCategory.get(cat) ?? 0;
 for (const cat of INVENTORY_GROUP_CATS) iCount += countsByCategory.get(cat) ?? 0;
 const oCount = entries.length - pCount - iCount - (countsByCategory.get('Settlement (PureX→LT)') ?? 0);

 if (entries.length === 0) warnings.push('No entries matched Jan 2025+ in Expenses tab.');

 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${EXP_GID}`,
 months,
 monthLabels: labels,
 byCategory,
 payroll: makeCategoryMonthly(payrollTotals, months, labels, pCount),
 inventory: makeCategoryMonthly(inventoryTotals, months, labels, iCount),
 other: makeCategoryMonthly(otherTotals, months, labels, oCount),
 settlement: makeCategoryMonthly(settlementTotals, months, labels, countsByCategory.get('Settlement (PureX→LT)') ?? 0),
 totalOpex: makeCategoryMonthly(totalOpexMonthly, months, labels, pCount + iCount + oCount),
 entries,
 categoryOrder: CATEGORY_ORDER,
 groupOf,
 warnings,
 };
}

// --- Outflow drill-down: PureX-paid expense entries for a date range, mapped to
// the 13-week budget outflow lines (Payroll / Inventory / Software / Other). All
// from the live Expenses sheet - no QuickBooks needed. Powers the variance
// outflow drill-down + a live actual that survives a QB disconnect.
export type ExpenseEntryDetail = { date: string; description: string; amount: number; category: string; line: string };
function budgetLineOf(cat: SheetExpenseCategory): string | null {
 if (cat === 'Settlement (PureX→LT)') return null;            // PureX→LT settlement is NOT OpEx
 if (PAYROLL_GROUP_CATS.has(cat)) return 'Payroll';
 if (INVENTORY_GROUP_CATS.has(cat)) return 'Inventory & Raw Materials';
 if (cat === 'Software & Subscriptions') return 'Software & Subscriptions';
 return 'Other Expenses';
}
export async function getExpenseEntriesForRange(start: string, end: string): Promise<{
 start: string; end: string;
 byLine: Record<string, { total: number; entries: ExpenseEntryDetail[] }>;
 total: number;
}> {
 const sx = await getSheetExpenses();
 const byLine: Record<string, { total: number; entries: ExpenseEntryDetail[] }> = {};
 let total = 0;
 for (const e of sx.entries) {
  const ds = (e.date || '').slice(0, 10);                     // already YYYY-MM-DD
  if (ds < start || ds > end) continue;
  const line = budgetLineOf(e.category as SheetExpenseCategory);
  if (!line) continue;
  const slot = (byLine[line] ??= { total: 0, entries: [] });
  slot.entries.push({ date: ds, description: e.description, amount: e.amount, category: e.category, line });
  slot.total += e.amount;
  total += e.amount;
 }
 for (const k of Object.keys(byLine)) {
  byLine[k].total = +byLine[k].total.toFixed(2);
  byLine[k].entries.sort((a, b) => b.amount - a.amount);
 }
 return { start, end, byLine, total: +total.toFixed(2) };
}
