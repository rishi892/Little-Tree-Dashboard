/**
 * Subscription audit: cross-check a list of expected recurring vendors against
 * QBO vendors + purchases + bills, and return structured results.
 *
 * Used by both:
 * - server/scripts/audit-subscriptions.ts (CLI, writes markdown)
 * - server/src/index.ts /api/subscription-audit (dashboard JSON)
 */

import { QBO_API_BASE } from './config.js';
import { qboFetch } from './qbHttp.js';
import { getValidAccessToken } from './oauth.js';

export type SubPattern = 'FIXED' | 'PERIODIC' | 'VARIABLE';

export type ExpectedSub = {
 name: string;
 monthly: number;
 /** Expected billing day-of-month (1–31) - used as fallback if QB has no match. */
 billDay: number;
 /** Expected pattern - fallback when QB has too few txns to infer. */
 pattern: SubPattern;
 notes?: string;
 /** Extra keywords to scan in line-item descriptions, vendor names, memos. */
 aliases?: string[];
};

export const DEFAULT_EXPECTED: ExpectedSub[] = [
 { name: 'DATACREW SOFTWARE', monthly: 3500, billDay: 17, pattern: 'PERIODIC', notes: 'Annual sub - data tools', aliases: ['datacrew', 'data crew'] },
 { name: 'CCA SOLUTIONS', monthly: 1500, billDay: 8, pattern: 'FIXED', notes: 'Compliance services', aliases: ['cca solutions'] },
 { name: 'HEADSET INC', monthly: 1295, billDay: 13, pattern: 'PERIODIC', notes: 'Bi-monthly data analytics', aliases: ['headset'] },
 { name: 'GUSTO', monthly: 820, billDay: 1, pattern: 'FIXED', notes: 'Payroll fee only', aliases: ['gusto'] },
 { name: 'HOLY SMOKZ', monthly: 625, billDay: 1, pattern: 'FIXED', notes: 'Sparkplug reimbursement', aliases: ['sparkplug', 'holy smokz'] },
 { name: 'LINDY', monthly: 494, billDay: 15, pattern: 'FIXED', aliases: ['lindy'] },
 { name: 'FRONT GROWTH', monthly: 395, billDay: 16, pattern: 'FIXED', aliases: ['front growth'] },
 { name: 'HUBSPOT', monthly: 300, billDay: 21, pattern: 'FIXED', aliases: ['hubspot'] },
 { name: 'REPLIT', monthly: 300, billDay: 28, pattern: 'FIXED', aliases: ['replit'] },
 { name: 'OPENAI/CHATGPT', monthly: 230, billDay: 5, pattern: 'VARIABLE', notes: 'Multiple seats variable', aliases: ['openai', 'chatgpt', 'open ai'] },
 { name: 'LIMITLESS', monthly: 228, billDay: 19, pattern: 'PERIODIC', notes: 'Annual/quarterly', aliases: ['limitless', 'limitless ai'] },
 { name: 'NOTION', monthly: 226, billDay: 21, pattern: 'FIXED', aliases: ['notion', 'notion labs'] },
 { name: 'SLACK', monthly: 197, billDay: 1, pattern: 'FIXED', aliases: ['slack'] },
 { name: 'CLICKUP', monthly: 150, billDay: 10, pattern: 'VARIABLE', aliases: ['clickup', 'click up'] },
 { name: '3030 LABS', monthly: 145, billDay: 25, pattern: 'FIXED', aliases: ['3030 labs', '3030'] },
 { name: 'APPLE.COM', monthly: 143, billDay: 7, pattern: 'VARIABLE', notes: 'iCloud + apps', aliases: ['apple', 'icloud'] },
 { name: 'B2B PRIME / AMAZON BUSINESS', monthly: 137, billDay: 5, pattern: 'PERIODIC', notes: 'Annual prorated', aliases: ['amazon business', 'amazon prime', 'b2b prime', 'amzn'] },
 { name: 'QUICKBOOKS', monthly: 107, billDay: 1, pattern: 'FIXED', aliases: ['quickbooks', 'intuit'] },
 { name: 'PADDLE', monthly: 99, billDay: 14, pattern: 'FIXED', aliases: ['paddle.net', 'paddle'] },
 { name: 'WEEDMAPS (GHOST MGMT)', monthly: 99, billDay: 3, pattern: 'FIXED', notes: 'Cannabis directory', aliases: ['weedmaps', 'weed maps', 'ghost mgmt', 'ghost management'] },
 { name: 'INTRO (XAVIER H)', monthly: 99, billDay: 22, pattern: 'FIXED', notes: 'Coaching', aliases: ['intro.co', 'intro coaching', 'xavier'] },
 { name: 'NOTTA', monthly: 98, billDay: 28, pattern: 'FIXED', aliases: ['notta'] },
 { name: 'WEBSTAURANT MEMBERSHIP', monthly: 89, billDay: 14, pattern: 'FIXED', notes: 'Membership only', aliases: ['webstaurant', 'webstaurantstore'] },
 { name: 'HOMEBASE', monthly: 70, billDay: 15, pattern: 'FIXED', aliases: ['homebase', 'home base', 'joinhomebase'] },
 { name: 'AAA MEMBERSHIP', monthly: 65, billDay: 29, pattern: 'PERIODIC', aliases: ['aaa membership', 'aaa acg'] },
 { name: 'AMBIENT', monthly: 50, billDay: 27, pattern: 'FIXED', aliases: ['ambient'] },
 { name: 'PROACTOR AI', monthly: 50, billDay: 17, pattern: 'FIXED', aliases: ['proactor', 'proactor ai'] },
 { name: 'CARRY.COM', monthly: 49, billDay: 2, pattern: 'FIXED', aliases: ['carry.com', 'carry'] },
 { name: 'TIMEERO', monthly: 40, billDay: 12, pattern: 'FIXED', aliases: ['timeero'] },
 { name: 'PERPLEXITY', monthly: 40, billDay: 25, pattern: 'FIXED', aliases: ['perplexity'] },
 { name: 'ADOBE', monthly: 39, billDay: 20, pattern: 'FIXED', aliases: ['adobe'] },
 { name: 'EXPERIAN', monthly: 35, billDay: 9, pattern: 'FIXED', aliases: ['experian'] },
 { name: 'PLAUD', monthly: 30, billDay: 4, pattern: 'FIXED', aliases: ['plaud'] },
 { name: 'CLIPTO', monthly: 25, billDay: 4, pattern: 'FIXED', aliases: ['clipto', 'clip to'] },
 { name: 'PADDLE - N8N CLOUD', monthly: 24, billDay: 18, pattern: 'FIXED', notes: 'via Paddle', aliases: ['n8n', 'n8n cloud'] },
 { name: 'LOOM', monthly: 24, billDay: 22, pattern: 'FIXED', aliases: ['loom', 'loom inc', 'loom video'] },
 { name: 'GOOGLE WORKSPACE', monthly: 23, billDay: 30, pattern: 'FIXED', aliases: ['google workspace', 'gsuite', 'g suite'] },
 { name: 'CLAY SOFTWARE', monthly: 20, billDay: 15, pattern: 'FIXED', notes: 'Sales software', aliases: ['clay software', 'clay'] },
 { name: "LENNY'S NEWSLETTER", monthly: 20, billDay: 4, pattern: 'FIXED', aliases: ['lenny', 'lennys', 'substack'] },
 { name: 'SHOPIFY', monthly: 17, billDay: 25, pattern: 'FIXED', aliases: ['shopify'] },
 { name: 'SMALLPDF', monthly: 15, billDay: 15, pattern: 'FIXED', aliases: ['smallpdf', 'small pdf'] },
 { name: 'AUDIBLE', monthly: 15, billDay: 29, pattern: 'FIXED', aliases: ['audible'] },
 { name: 'CANVA', monthly: 15, billDay: 24, pattern: 'FIXED', aliases: ['canva'] },
 { name: 'SIMPLEMDM', monthly: 13, billDay: 18, pattern: 'FIXED', aliases: ['simplemdm', 'simple mdm'] },
 { name: 'DOORDASH (DASHPASS)', monthly: 10, billDay: 7, pattern: 'FIXED', notes: 'DashPass only', aliases: ['doordash', 'dashpass'] },
 { name: 'GETTOBY.COM', monthly: 6, billDay: 22, pattern: 'FIXED', aliases: ['gettoby', 'get toby', 'toby'] },
];

const STOPWORDS = new Set([
 'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company',
 'the', 'and', 'a', 'an', 'of', 'for', 'to',
 'software', 'service', 'services', 'tech', 'technologies',
 'com', 'membership', 'subscription', 'sub', 'app', 'apps',
]);

function normalize(s: string): string {
 return s
 .toLowerCase()
 .replace(/[^a-z0-9\s]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
}

function tokens(s: string): string[] {
 return normalize(s).split(' ').filter((t) => t && !STOPWORDS.has(t));
}

function score(userName: string, qboName: string): number {
 const u = normalize(userName);
 const q = normalize(qboName);
 if (!u || !q) return 0;
 if (u === q) return 1.0;
 if (q.includes(u)) return 0.92;
 if (u.includes(q)) return 0.88;
 const ut = new Set(tokens(userName));
 const qt = new Set(tokens(qboName));
 if (ut.size === 0 || qt.size === 0) return 0;
 let overlap = 0;
 for (const t of ut) if (qt.has(t)) overlap++;
 if (overlap === 0) return 0;
 const jaccard = overlap / new Set([...ut, ...qt]).size;
 return Math.min(0.85, 0.5 + jaccard * 0.5);
}

type Vendor = {
 Id: string;
 DisplayName: string;
 CompanyName?: string;
};
type Purchase = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 EntityRef?: { value: string; name?: string; type?: string };
 AccountRef?: { value: string; name?: string };
 PrivateNote?: string;
 DocNumber?: string;
 Line?: Array<{ Description?: string; Amount?: number }>;
};
type Bill = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 VendorRef?: { value: string; name?: string };
 PrivateNote?: string;
 DocNumber?: string;
 Line?: Array<{ Description?: string; Amount?: number }>;
};

async function qboQuery<T>(query: string, accessToken: string, realmId: string, key: string): Promise<T[]> {
 const all: T[] = [];
 const pageSize = 1000;
 let start = 1;
 while (true) {
 const q = `${query} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
 const url = `${QBO_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=70`;
 const res = await qboFetch(url, accessToken);
 if (!res.ok) {
 const body = await res.text();
 throw new Error(`QBO query failed (${res.status}): ${body}`);
 }
 const data = (await res.json()) as { QueryResponse: Record<string, T[]> };
 const batch = data.QueryResponse[key] ?? [];
 all.push(...batch);
 if (batch.length < pageSize) break;
 start += pageSize;
 }
 return all;
}

function ymd(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function median(arr: number[]): number {
 if (arr.length === 0) return 0;
 const s = arr.slice().sort((a, b) => a - b);
 const mid = Math.floor(s.length / 2);
 return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Given the txns matched to a subscription, derive the live monthly / billDay /
 * pattern from QB.
 *
 * derivedMonthly is the **median of non-zero monthly totals**. We group txns
 * by YYYY-MM, sum each month, then take the median of months that actually had
 * a charge. This handles three cases correctly:
 * - Single-charge monthly subs (most common) → median month = the charge.
 * - Multi-charge per month (OpenAI seats, Apple iCloud) → median month = the
 * realistic monthly spend, not a single tiny line item.
 * - PERIODIC subs (quarterly / annual) → median of the months they actually
 * fired, not 0.
 *
 * derivedBillDay is the median day-of-month of all matching txns.
 *
 * derivedPattern uses the coefficient-of-variation of monthly totals and the
 * average gap between charges:
 * - avg gap > 45 days → PERIODIC
 * - monthly totals stable (CV < 5%) → FIXED
 * - otherwise → VARIABLE
 *
 * With <2 txns we fall back to the values from ExpectedSub.
 */
function deriveSubMetrics(
 txns: Array<{ date: string; amount: number }>,
 expected: ExpectedSub,
): { derivedMonthly: number; derivedBillDay: number; derivedPattern: SubPattern; hasQbData: boolean } {
 if (txns.length < 2) {
 return {
 derivedMonthly: expected.monthly,
 derivedBillDay: expected.billDay,
 derivedPattern: expected.pattern,
 hasQbData: false,
 };
 }

 // Group by month-of-charge and sum
 const monthlyTotals = new Map<string, number>();
 for (const t of txns) {
 const ym = t.date.slice(0, 7);
 monthlyTotals.set(ym, (monthlyTotals.get(ym) ?? 0) + t.amount);
 }
 const nonZeroMonthly = Array.from(monthlyTotals.values()).filter((v) => v > 0);
 const medMonthly = median(nonZeroMonthly);

 // Bill day = median day-of-month across individual txns
 const days = txns.map((t) => Number(t.date.slice(8, 10)));
 const medDay = Math.max(1, Math.min(31, Math.round(median(days))));

 // Pattern detection - uses monthly-total variation + avg gap between charges
 const mean = nonZeroMonthly.reduce((s, v) => s + v, 0) / Math.max(1, nonZeroMonthly.length);
 const variance =
 nonZeroMonthly.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, nonZeroMonthly.length);
 const stdev = Math.sqrt(variance);
 const cv = mean > 0 ? stdev / mean : 0;

 const sorted = txns.slice().sort((a, b) => a.date.localeCompare(b.date));
 let gapSum = 0;
 for (let i = 1; i < sorted.length; i++) {
 const a = sorted[i - 1].date;
 const b = sorted[i].date;
 gapSum +=
 (Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10))) -
 Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)))) /
 (1000 * 60 * 60 * 24);
 }
 const avgGap = sorted.length > 1 ? gapSum / (sorted.length - 1) : 0;

 let pattern: SubPattern;
 if (avgGap > 45) pattern = 'PERIODIC';
 else if (cv < 0.05) pattern = 'FIXED';
 else pattern = 'VARIABLE';

 return {
 derivedMonthly: Math.round(medMonthly * 100) / 100,
 derivedBillDay: medDay,
 derivedPattern: pattern,
 hasQbData: true,
 };
}

export type MatchType = 'strong' | 'fuzzy' | 'line' | 'none';

export type AuditRow = {
 expected: ExpectedSub;
 matchType: MatchType;
 bestMatchName: string | null;
 bestMatchScore: number;
 alternates: Array<{ name: string; score: number }>;
 activity: {
 txnCount: number;
 totalAmount: number;
 avgAmount: number;
 lastDate: string;
 } | null;
 lineHits: Array<{ date: string; amount: number; description: string }>;
 monthlyAmounts: number[]; // length matches result.months
 /**
 * Raw QB-derived stats from the matching transactions (vendor + line hits).
 * derivedMonthly = median of non-zero monthly totals.
 * When too few txns are found, these mirror the expected values.
 */
 derivedMonthly: number;
 derivedBillDay: number;
 derivedPattern: SubPattern;
 /** True when derived* came from ≥2 matching QB txns. */
 hasQbData: boolean;
 /**
 * Values the client should actually plug into the projection. These respect
 * a sanity check: if the QB-derived monthly is wildly off from expected
 * (>3x or <1/3x) we fall back to expected and surface a reason. This
 * handles cases like the Gusto vendor capturing wage flows on top of the
 * subscription fee, or a "line" match catching only one of several seats.
 */
 usedMonthly: number;
 usedBillDay: number;
 usedPattern: SubPattern;
 usedSource: 'qb' | 'expected' | 'expected_outlier';
 /** Set when usedSource === 'expected_outlier'. */
 outlierReason?: string;
 /** Sample dates used for derivation, useful for spot-checking. */
 sampleDates: string[];
};

export type UnexpectedVendor = {
 displayName: string;
 txnCount: number;
 totalAmount: number;
 avgAmount: number;
 lastDate: string;
};

export type SubscriptionAuditResult = {
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 since: string;
 totals: { vendors: number; purchases: number; bills: number };
 counts: { strong: number; fuzzy: number; line: number; missing: number };
 /** YYYY-MM keys for the columns shown in monthlyAmounts arrays (completed months only). */
 months: string[];
 /** Human-readable labels matching `months`, e.g. "Jan 2026". */
 monthLabels: string[];
 rows: AuditRow[];
 unexpectedVendors: UnexpectedVendor[];
};

// Module-level cache so cashflow13 + the route handler share a single fetch.
let _auditCache: { at: number; months: number; data: SubscriptionAuditResult } | null = null;
let _auditInFlight: Promise<SubscriptionAuditResult> | null = null;
const _AUDIT_CACHE_TTL_MS = 60 * 60 * 1000;

export function invalidateSubscriptionAuditCache(): void { _auditCache = null; }

export async function getCachedSubscriptionAudit(lookbackMonths = 16): Promise<SubscriptionAuditResult> {
 if (_auditCache && _auditCache.months === lookbackMonths && Date.now() - _auditCache.at < _AUDIT_CACHE_TTL_MS) {
 return _auditCache.data;
 }
 if (_auditInFlight) return _auditInFlight;
 _auditInFlight = (async () => {
 try { return await runSubscriptionAudit(undefined, lookbackMonths); }
 finally { _auditInFlight = null; }
 })();
 const data = await _auditInFlight;
 if (data.rows.length > 0) _auditCache = { at: Date.now(), months: lookbackMonths, data };
 return data;
}

/**
 * "Active" subscription = has at least one QB transaction in the last
 * `recentMonths` months (default 4). Dormant subs are likely cancelled and
 * excluded from the projected monthly run-rate.
 */
export function computeActiveSubscriptionsMonthly(
 audit: SubscriptionAuditResult,
 recentMonths = 4,
): { activeMonthlySum: number; activeCount: number; dormantCount: number; activeRows: AuditRow[] } {
 const cutoff = new Date();
 cutoff.setUTCMonth(cutoff.getUTCMonth() - recentMonths);
 const cutoffStr = cutoff.toISOString().slice(0, 10);
 let activeMonthlySum = 0;
 let activeCount = 0;
 let dormantCount = 0;
 const activeRows: AuditRow[] = [];
 for (const r of audit.rows) {
 const last = r.activity?.lastDate;
 if (last && last >= cutoffStr) {
 activeMonthlySum += r.usedMonthly;
 activeCount++;
 activeRows.push(r);
 } else {
 dormantCount++;
 }
 }
 return { activeMonthlySum: +activeMonthlySum.toFixed(2), activeCount, dormantCount, activeRows };
}

export async function runSubscriptionAudit(
 expected: ExpectedSub[] = DEFAULT_EXPECTED,
 lookbackMonths = 6,
): Promise<SubscriptionAuditResult> {
 const tok = await getValidAccessToken();
 const since = new Date();
 since.setUTCMonth(since.getUTCMonth() - lookbackMonths);
 const sinceStr = ymd(since);

 // Build the list of completed months that will become column headers.
 // Excludes the current (possibly in-progress) calendar month.
 const months: string[] = [];
 const monthLabels: string[] = [];
 const now = new Date();
 for (let i = lookbackMonths; i >= 1; i--) {
 const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
 const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
 months.push(ym);
 monthLabels.push(d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
 }
 const monthIndex = new Map(months.map((m, i) => [m, i]));

 const [vendors, purchases, bills] = await Promise.all([
 qboQuery<Vendor>('select * from Vendor', tok.accessToken, tok.realmId, 'Vendor'),
 qboQuery<Purchase>(`select * from Purchase where TxnDate >= '${sinceStr}'`, tok.accessToken, tok.realmId, 'Purchase'),
 qboQuery<Bill>(`select * from Bill where TxnDate >= '${sinceStr}'`, tok.accessToken, tok.realmId, 'Bill'),
 ]);

 type Activity = {
 txnCount: number;
 totalAmount: number;
 lastDate: string;
 monthly: number[];
 /** All matching transactions, used to derive billDay / monthly / pattern. */
 txns: Array<{ date: string; amount: number }>;
 };
 const activityByVendorId = new Map<string, Activity>();
 const activityByVendorName = new Map<string, Activity>();

 function newActivity(): Activity {
 return { txnCount: 0, totalAmount: 0, lastDate: '', monthly: new Array(months.length).fill(0), txns: [] };
 }
 function bumpById(id: string, date: string, amount: number) {
 const a = activityByVendorId.get(id) ?? newActivity();
 a.txnCount++;
 a.totalAmount += amount;
 if (date > a.lastDate) a.lastDate = date;
 a.txns.push({ date, amount });
 const idx = monthIndex.get(date.slice(0, 7));
 if (idx !== undefined) a.monthly[idx] += amount;
 activityByVendorId.set(id, a);
 }
 function bumpByName(name: string, date: string, amount: number) {
 const key = normalize(name);
 const a = activityByVendorName.get(key) ?? newActivity();
 a.txnCount++;
 a.totalAmount += amount;
 if (date > a.lastDate) a.lastDate = date;
 a.txns.push({ date, amount });
 const idx = monthIndex.get(date.slice(0, 7));
 if (idx !== undefined) a.monthly[idx] += amount;
 activityByVendorName.set(key, a);
 }

 for (const p of purchases) {
 if (p.EntityRef?.value && p.EntityRef.type === 'Vendor') {
 bumpById(p.EntityRef.value, p.TxnDate, p.TotalAmt);
 } else if (p.EntityRef?.name) {
 bumpByName(p.EntityRef.name, p.TxnDate, p.TotalAmt);
 }
 }
 for (const b of bills) {
 if (b.VendorRef?.value) bumpById(b.VendorRef.value, b.TxnDate, b.TotalAmt);
 }

 const rows: AuditRow[] = expected.map((exp) => {
 const scored = vendors
 .map((v) => {
 const s = Math.max(
 score(exp.name, v.DisplayName),
 v.CompanyName ? score(exp.name, v.CompanyName) : 0,
 );
 return { vendor: v, score: s };
 })
 .filter((s) => s.score > 0.4)
 .sort((a, b) => b.score - a.score);
 const best = scored[0] ?? null;
 let activity: Activity | null = null;
 if (best) {
 activity = activityByVendorId.get(best.vendor.Id)
 ?? activityByVendorName.get(normalize(best.vendor.DisplayName))
 ?? null;
 }

 // Line-item description scan - covers credit-card subs that hit a generic
 // expense account instead of a proper Vendor record.
 //
 // IMPORTANT: We match the expected name and each alias as a **whole phrase**,
 // not as decomposed tokens. Decomposing into tokens caused massive over-
 // matching (e.g. "DATACREW SOFTWARE" matched any txn with the word "data";
 // "NOTION LABS" matched any txn with "labs"). Phrases keep matches tight.
 const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 // Split a label on punctuation that typically separates alternatives or
 // descriptors: parens, slashes, brackets, hyphens. Each chunk is then a
 // searchable phrase. E.g. "WEEDMAPS (GHOST MGMT)" → ["weedmaps", "ghost mgmt"].
 function makePhrases(input: string): string[] {
 const chunks = input.split(/[()\[\]{}/\\\-]+/);
 const out: string[] = [];
 for (const chunk of chunks) {
 const norm = chunk
 .toLowerCase()
 .replace(/'/g, '')
 .replace(/[^a-z0-9]+/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
 if (norm.length >= 3) out.push(norm);
 }
 return out;
 }

 const phraseSet = new Set<string>();
 for (const p of [exp.name, ...(exp.aliases ?? [])]) {
 for (const chunk of makePhrases(p)) phraseSet.add(chunk);
 }

 const lineHits: AuditRow['lineHits'] = [];
 if (phraseSet.size > 0) {
 const patterns = Array.from(phraseSet).map((p) => {
 if (!/\s/.test(p)) {
 // Single word → require word boundaries so e.g. "notion" doesn't
 // hit "promotion".
 return `\\b${escapeRe(p)}\\b`;
 }
 // Multi-word phrase → allow flexible whitespace between words.
 return p.split(/\s+/).map(escapeRe).join('\\s+');
 });
 const re = new RegExp(`(?:${patterns.join('|')})`, 'i');

 function scanTxn(txn: Purchase | Bill, txnTexts: string[]) {
 const haystacks: Array<{ desc: string; amount?: number }> = [];
 for (const ln of txn.Line ?? []) {
 if (ln.Description) haystacks.push({ desc: ln.Description, amount: ln.Amount });
 }
 // Header-level fields, applied to the first line (or whole txn) when matched.
 const headerText = txnTexts.filter(Boolean).join(' | ');
 if (headerText) {
 haystacks.push({ desc: headerText, amount: txn.TotalAmt });
 }
 for (const h of haystacks) {
 if (re.test(h.desc)) {
 lineHits.push({
 date: txn.TxnDate,
 amount: h.amount ?? txn.TotalAmt,
 description: h.desc,
 });
 return; // count one hit per txn
 }
 }
 }

 for (const p of purchases) {
 scanTxn(p, [p.EntityRef?.name ?? '', p.PrivateNote ?? '', p.DocNumber ?? '', p.AccountRef?.name ?? '']);
 }
 for (const b of bills) {
 scanTxn(b, [b.VendorRef?.name ?? '', b.PrivateNote ?? '', b.DocNumber ?? '']);
 }
 }

 let matchType: MatchType;
 if (best && best.score >= 0.85 && activity) matchType = 'strong';
 else if (best && best.score >= 0.85) matchType = 'strong';
 else if (best && best.score >= 0.5) matchType = 'fuzzy';
 else if (lineHits.length > 0) matchType = 'line';
 else matchType = 'none';

 let combinedActivity: AuditRow['activity'] = null;
 let monthlyAmounts: number[] = new Array(months.length).fill(0);
 if (activity) {
 combinedActivity = {
 txnCount: activity.txnCount,
 totalAmount: activity.totalAmount,
 avgAmount: activity.totalAmount / activity.txnCount,
 lastDate: activity.lastDate,
 };
 monthlyAmounts = activity.monthly.slice();
 } else if (lineHits.length > 0) {
 const total = lineHits.reduce((s, h) => s + h.amount, 0);
 const last = lineHits.reduce((d, h) => (h.date > d ? h.date : d), '');
 combinedActivity = {
 txnCount: lineHits.length,
 totalAmount: total,
 avgAmount: total / lineHits.length,
 lastDate: last,
 };
 for (const h of lineHits) {
 const idx = monthIndex.get(h.date.slice(0, 7));
 if (idx !== undefined) monthlyAmounts[idx] += h.amount;
 }
 }

 // Collect all matching transactions for derivation.
 const matchedTxns: Array<{ date: string; amount: number }> = [];
 if (activity) {
 for (const t of activity.txns) matchedTxns.push(t);
 }
 // If we used line hits to define activity, those amounts were already
 // counted; otherwise add them as separate evidence.
 if (!activity) {
 for (const h of lineHits) matchedTxns.push({ date: h.date, amount: h.amount });
 }

 const { derivedMonthly, derivedBillDay, derivedPattern, hasQbData } =
 deriveSubMetrics(matchedTxns, exp);

 // Sanity check: if QB-derived monthly is wildly off from expected,
 // surface a warning and use expected for the projection. Common causes:
 // - vendor match catches more than the subscription (e.g. Gusto wages
 // in addition to the $820 fee)
 // - line-item match catches only a slice of a multi-seat sub
 let usedMonthly = derivedMonthly;
 let usedBillDay = derivedBillDay;
 let usedPattern = derivedPattern;
 let usedSource: 'qb' | 'expected' | 'expected_outlier' = hasQbData ? 'qb' : 'expected';
 let outlierReason: string | undefined;
 if (hasQbData && exp.monthly > 0) {
 const ratio = derivedMonthly / exp.monthly;
 if (ratio > 3 || ratio < 0.33) {
 usedMonthly = exp.monthly;
 usedBillDay = exp.billDay;
 usedPattern = exp.pattern;
 usedSource = 'expected_outlier';
 outlierReason =
 ratio > 3
 ? `QB-derived $${Math.round(derivedMonthly).toLocaleString()} is ${ratio.toFixed(1)}× expected $${exp.monthly.toLocaleString()} - vendor likely catches non-subscription spend.`
 : `QB-derived $${Math.round(derivedMonthly).toLocaleString()} is only ${(ratio * 100).toFixed(0)}% of expected $${exp.monthly.toLocaleString()} - likely a partial match.`;
 }
 }

 return {
 expected: exp,
 matchType,
 bestMatchName: best?.vendor.DisplayName ?? null,
 bestMatchScore: best?.score ?? 0,
 alternates: scored.slice(1, 4).map((a) => ({ name: a.vendor.DisplayName, score: a.score })),
 activity: combinedActivity,
 lineHits: lineHits.slice(0, 5),
 monthlyAmounts,
 derivedMonthly,
 derivedBillDay,
 derivedPattern,
 hasQbData,
 usedMonthly,
 usedBillDay,
 usedPattern,
 usedSource,
 outlierReason,
 sampleDates: matchedTxns.map((t) => t.date).sort().slice(0, 8),
 };
 });

 const counts = {
 strong: rows.filter((r) => r.matchType === 'strong').length,
 fuzzy: rows.filter((r) => r.matchType === 'fuzzy').length,
 line: rows.filter((r) => r.matchType === 'line').length,
 missing: rows.filter((r) => r.matchType === 'none').length,
 };

 // Recurring QBO vendors not on the expected list.
 const matchedQboIds = new Set(
 rows
 .filter((r) => r.bestMatchName)
 .map((r) => vendors.find((v) => v.DisplayName === r.bestMatchName)?.Id)
 .filter((x): x is string => !!x),
 );
 const unexpectedVendors: UnexpectedVendor[] = [];
 for (const [vid, act] of activityByVendorId) {
 if (matchedQboIds.has(vid)) continue;
 if (act.txnCount < 2) continue;
 const v = vendors.find((x) => x.Id === vid);
 if (!v) continue;
 unexpectedVendors.push({
 displayName: v.DisplayName,
 txnCount: act.txnCount,
 totalAmount: act.totalAmount,
 avgAmount: act.totalAmount / act.txnCount,
 lastDate: act.lastDate,
 });
 }
 unexpectedVendors.sort((a, b) => b.totalAmount - a.totalAmount);

 return {
 asOf: new Date().toISOString(),
 realmId: tok.realmId,
 lookbackMonths,
 since: sinceStr,
 totals: { vendors: vendors.length, purchases: purchases.length, bills: bills.length },
 counts,
 months,
 monthLabels,
 rows,
 unexpectedVendors: unexpectedVendors.slice(0, 30),
 };
}
