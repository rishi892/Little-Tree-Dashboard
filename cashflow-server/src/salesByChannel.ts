/**
 * Historical Sales by Channel - 5 buckets only:
 *   1. Gelato (from the dedicated Gelato Sales sheet, Net 90)
 *   2. Alien Brainz   (brand customer)
 *   3. Yacht Fuel     (brand customer)
 *   4. Funkd Up       (brand customer)
 *   5. Little Tree    (catch-all - every other retail customer the company invoices)
 *
 * Data source for buckets 2-5: Little Tree Financials sheet (source-of-truth
 * invoice ledger used by sales forecast too). Per-customer Top-5 KPI also
 * computed from the same source so the numbers reconcile.
 *
 * Months: Jan 2024 → current month, fully dynamic (no hardcoded window).
 */

import { getGelatoMonthlySales } from './gelatoAr.js';
import { getLtFinancialsSales } from './ltFinancialsSales.js';

// Build dynamic month list: Jan 2025 → current month (or up to whatever the
// data actually covers, whichever is later). Per user spec - pre-2025 data
// not surfaced in this view.
function buildMonths(latestYm: string): Array<{ key: string; label: string; taxAffected: boolean }> {
 const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
 const taxMonths = new Set(['2025-12', '2026-01', '2026-02']);
 const start = new Date(Date.UTC(2025, 0, 1));
 const [ly, lm] = latestYm.split('-').map(Number);
 const today = new Date();
 const endY = Math.max(ly, today.getUTCFullYear());
 let endM = ly === endY ? lm : today.getUTCMonth() + 1;
 if (endY === today.getUTCFullYear()) endM = Math.max(endM, today.getUTCMonth() + 1);
 const out: Array<{ key: string; label: string; taxAffected: boolean }> = [];
 const cursor = new Date(start);
 while (cursor.getUTCFullYear() < endY || (cursor.getUTCFullYear() === endY && cursor.getUTCMonth() + 1 <= endM)) {
   const y = cursor.getUTCFullYear();
   const m = cursor.getUTCMonth();
   const key = `${y}-${String(m + 1).padStart(2, '0')}`;
   out.push({
     key,
     label: `${monthLabels[m]} ${String(y).slice(2)}${taxMonths.has(key) ? '*' : ''}`,
     taxAffected: taxMonths.has(key),
   });
   cursor.setUTCMonth(cursor.getUTCMonth() + 1);
 }
 return out;
}

// Channel mapping. Per user spec: ONLY 4 brand channels + a single
// "Little Tree" catch-all for every other retail customer. No Jars / Skymint /
// Apothecare / etc. sub-rows - the lender wants a clean 5-row picture.
// Gelato exact-match first so its catch-all fallback doesn't claim it.
export type ChannelSpec = { name: string; group: 'Gelato' | 'Other'; match: RegExp };
export const CHANNEL_SPECS: ChannelSpec[] = [
 { name: 'Gelato',       group: 'Gelato', match: /^little tree-\s*gelato$/i },
 { name: 'Alien Brainz', group: 'Other',  match: /little tree-\s*alien\s*(brainz|brains|arainz)/i },
 { name: 'Yacht Fuel',   group: 'Other',  match: /little tree-\s*(yacht|tacht)\s*fuel/i },
 { name: 'Funkd Up',     group: 'Other',  match: /little tree-\s*funk'?\s*d?\s*up/i },
];
export const CATCH_ALL_NAME = 'Little Tree';

/** Resolve a customer name to its channel name (Gelato, Jars, ..., or catch-all). */
export function channelOf(customer: string): string {
 for (const ch of CHANNEL_SPECS) if (ch.match.test(customer)) return ch.name;
 return CATCH_ALL_NAME;
}

export type SalesByChannelRow = {
 channel: string;
 group: 'Gelato' | 'Other';
 monthly: number[]; // raw per-month values (length = MONTHS.length)
 normalized: number[]; // post-normalization values
 total: number; // raw total
 totalNormalized: number; // normalized total
 avgPerMonth: number; // raw avg
 invoiceCount: number;
};

export type TopCustomer = {
 customer: string;             // raw customer name from Invoice Tracker
 channel: string;              // resolved channel (Jars, Alien Brainz, Little Tree etc.)
 total: number;                // gross $ across the window
 invoiceCount: number;
 monthsActive: number;         // distinct months with at least one invoice
 lastInvoiceMonth: string | null;  // most recent YYYY-MM
};

/** Cooling / lost customer: had real sales in months 4-6 ago but zero in the
 *  last 3 months. Surfaces accounts the team should chase before they churn
 *  for good. Sorted by prior3 $ so biggest historical revenue at risk first. */
export type CoolingCustomer = {
 customer: string;
 channel: string;
 prior3Total: number;         // $ in months 4-6 ago (when they WERE active)
 prior3MonthsActive: number;  // how many of those 3 months had any order
 last3Total: number;          // should be 0 to qualify (kept for transparency)
 lastInvoiceMonth: string | null;
};

export type SalesByChannelResult = {
 fetchedAt: string;
 sheetUrl: string;
 months: Array<{ key: string; label: string; taxAffected: boolean }>;
 rows: SalesByChannelRow[];
 subtotals: {
 gelatoRaw: number[];
 gelatoNormalized: number[];
 othersRaw: number[];
 othersNormalized: number[];
 grandTotalNormalized: number[];
 };
 /** Top 5 customers by gross sales over the visible window (excludes the
  *  Gelato channel since it's already its own row + KPI elsewhere). */
 topCustomers: TopCustomer[];
 /** Customers who were active 4-6 months ago but went silent in the last 3
  *  months. Top 10 by lost revenue. */
 coolingCustomers: CoolingCustomer[];
};

// --- CSV parsing ---

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
 else if (c !== '\r') field += c;
 }
 }
 if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
 return rows;
}

function parseMoney(s: string): number {
 const t = (s ?? '').trim();
 if (!t || t === '-' || t === '$ -') return 0;
 const negative = /\(.*\)/.test(t);
 const cleaned = t.replace(/[\$,()\s]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

/** Parse "MM/DD/YY" or "MM/DD/YYYY" → "YYYY-MM" or null. */
function monthKey(s: string): string | null {
 const t = (s ?? '').trim();
 const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
 if (!m) return null;
 const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
 return `${yr}-${m[1].padStart(2, '0')}`;
}

function classifyChannel(customer: string): { name: string; group: 'Gelato' | 'Other' } {
 for (const spec of CHANNEL_SPECS) {
 if (spec.match.test(customer)) return { name: spec.name, group: spec.group };
 }
 // Default: anything else starting with "Little Tree" falls into the
 // catch-all "Little Tree (Gelato channel)" bucket.
 return { name: CATCH_ALL_NAME, group: 'Other' };
}

/**
 * Tax-affected months are Dec 25, Jan 26, Feb 26 - they were impacted by
 * Michigan's 24% wholesale tax announcement (Nov 25, 2025) effective Jan 1
 * 2026. To get a clean forecast baseline we replace those months with the
 * 11-month average (Jan 25 → Nov 25), keeping all other months as-is.
 */
// Normalization removed per user request - Sales by Channel now shows raw
// numbers only. The `normalized` field on each row mirrors `monthly` for
// backwards compatibility with the type but isn't used by the UI.

// --- Main fetch ---

export async function getSalesByChannel(): Promise<SalesByChannelResult> {
 // Fetch LT Financials invoices + Gelato monthly sales in parallel.
 const [ltFin, gelatoMonthly] = await Promise.all([
 getLtFinancialsSales(),
 getGelatoMonthlySales().catch((e) => {
 console.error('[salesByChannel] gelato sheet fetch failed:', e);
 return new Map<string, number>();
 }),
 ]);

 // Determine the latest month present in the data so the table window covers
 // up-to-now (or longer if data extends beyond today).
 let latestYm = '2025-01';
 for (const inv of ltFin.invoices) {
   const ym = `${inv.invoiceDate.getUTCFullYear()}-${String(inv.invoiceDate.getUTCMonth() + 1).padStart(2, '0')}`;
   if (ym > latestYm) latestYm = ym;
 }
 for (const mk of gelatoMonthly.keys()) {
   if (mk > latestYm) latestYm = mk;
 }
 const MONTHS = buildMonths(latestYm);
 const monthIndex = new Map<string, number>();
 MONTHS.forEach((m, i) => monthIndex.set(m.key, i));

 // Accumulator per channel.
 type Accum = { name: string; group: 'Gelato' | 'Other'; monthly: number[]; total: number; invoiceCount: number };
 const accum = new Map<string, Accum>();
 function ensure(name: string, group: 'Gelato' | 'Other'): Accum {
 let a = accum.get(name);
 if (!a) {
 a = { name, group, monthly: new Array(MONTHS.length).fill(0), total: 0, invoiceCount: 0 };
 accum.set(name, a);
 }
 return a;
 }

 // Pre-seed all 5 channel rows so they show even with $0.
 ensure('Gelato', 'Gelato');
 ensure(CATCH_ALL_NAME, 'Other');                       // Little Tree (catch-all)
 ensure('Alien Brainz', 'Other');
 ensure('Yacht Fuel', 'Other');
 ensure('Funkd Up', 'Other');

 // 1) Seed Gelato row from the dedicated Gelato sales sheet.
 if (gelatoMonthly.size > 0) {
 const g = ensure('Gelato', 'Gelato');
 for (const [mk, amount] of gelatoMonthly) {
 const idx = monthIndex.get(mk);
 if (idx === undefined) continue;
 g.monthly[idx] = amount; // overwrite, sheet is authoritative
 g.total += amount;
 g.invoiceCount += 1; // ~1 invoice/batch per month
 }
 }

 // Customer-level accumulator for Top-5 KPI cards + cooling-customer detection.
 // monthly[] mirrors MONTHS index so we can window the last-3 vs prior-3 buckets.
 const custAccum = new Map<string, { customer: string; channel: string; total: number; invoiceCount: number; months: Set<string>; lastMonth: string; monthly: number[] }>();

 // 2) Process LT Financials invoices - bucket each into one of the 5 channels.
 //    Gelato rows skipped (already captured from Gelato sheet to avoid double-count).
 //    The 3 brand channels (Alien Brainz / Yacht Fuel / Funkd Up) are also
 //    PARKED for now - user is still confirming which sheet carries their
 //    real sales numbers (LT Financials shows only vendor-side invoicing).
 //    Their rows stay in the table but show dashes until a source lands.
 const PARKED_CHANNELS = new Set(['Alien Brainz', 'Yacht Fuel', 'Funkd Up']);
 for (const inv of ltFin.invoices) {
 if (inv.amount <= 0) continue;
 const customer = (inv.customer ?? '').trim();
 if (!customer) continue;
 const ym = `${inv.invoiceDate.getUTCFullYear()}-${String(inv.invoiceDate.getUTCMonth() + 1).padStart(2, '0')}`;
 const idx = monthIndex.get(ym);
 if (idx === undefined) continue;

 const { name, group } = classifyChannel(customer);
 if (name === 'Gelato') continue;          // already from Gelato sheet
 if (PARKED_CHANNELS.has(name)) continue;  // parked - user confirming source
 const a = ensure(name, group);
 a.monthly[idx] += inv.amount;
 a.total += inv.amount;
 a.invoiceCount += 1;
 // Track individual customer for Top-5 KPI.
 let c = custAccum.get(customer);
 if (!c) {
   c = { customer, channel: name, total: 0, invoiceCount: 0, months: new Set(), lastMonth: '', monthly: new Array(MONTHS.length).fill(0) };
   custAccum.set(customer, c);
 }
 c.total += inv.amount;
 c.invoiceCount += 1;
 c.months.add(ym);
 c.monthly[idx] += inv.amount;
 if (ym > c.lastMonth) c.lastMonth = ym;
 }

 // Display order: Gelato → Little Tree (catch-all) → named brands.
 const LENDER_ORDER = [CATCH_ALL_NAME, 'Alien Brainz', 'Yacht Fuel', 'Funkd Up'];
 const allAccums = [...accum.values()];
 const ordered: Accum[] = [];
 const gelatoRow = allAccums.find((a) => a.name === 'Gelato');
 if (gelatoRow) ordered.push(gelatoRow);
 for (const name of LENDER_ORDER) {
 const row = allAccums.find((a) => a.name === name);
 if (row) ordered.push(row);
 }
 // Catch any remaining "Other"-group rows not in LENDER_ORDER (defensive).
 for (const a of allAccums) {
 if (a.group === 'Gelato') continue;
 if (LENDER_ORDER.includes(a.name)) continue;
 ordered.push(a);
 }

 const rowsOut: SalesByChannelRow[] = ordered.map((a) => {
 const monthly = a.monthly.map((v) => +v.toFixed(2));
 return {
 channel: a.name,
 group: a.group,
 monthly,
 normalized: monthly,                                   // mirror raw (no normalisation)
 total: +a.total.toFixed(2),
 totalNormalized: +a.total.toFixed(2),                  // mirror raw
 avgPerMonth: +(a.total / MONTHS.length).toFixed(2),
 invoiceCount: a.invoiceCount,
 };
 });

  // Subtotals per group (raw only).
 const zeros = () => new Array(MONTHS.length).fill(0);
 const gelatoRaw = zeros();
 const othersRaw = zeros();
 for (const r of rowsOut) {
 for (let i = 0; i < MONTHS.length; i++) {
 if (r.group === 'Gelato') gelatoRaw[i] += r.monthly[i];
 else othersRaw[i] += r.monthly[i];
 }
 }

 // Top 5 individual customers by gross sales across the window.
 const topCustomers: TopCustomer[] = [...custAccum.values()]
   .sort((a, b) => b.total - a.total)
   .slice(0, 5)
   .map((c) => ({
     customer: c.customer,
     channel: c.channel,
     total: +c.total.toFixed(2),
     invoiceCount: c.invoiceCount,
     monthsActive: c.months.size,
     lastInvoiceMonth: c.lastMonth || null,
   }));

 // Cooling / lost customers: had real sales in months 4-6 ago, zero in the
 // last 3 months. Only meaningful if the window is at least 6 months long.
 const coolingCustomers: CoolingCustomer[] = [];
 if (MONTHS.length >= 6) {
   const len = MONTHS.length;
   // Window: indices [len-3, len-1] = last 3 incl current; [len-6, len-4] = prior 3.
   const last3Start = len - 3;
   const priorStart = len - 6;
   const priorEnd = len - 4; // inclusive
   for (const c of custAccum.values()) {
     let last3Sum = 0;
     let prior3Sum = 0;
     let priorMonthsActive = 0;
     for (let i = last3Start; i < len; i++) last3Sum += c.monthly[i];
     for (let i = priorStart; i <= priorEnd; i++) {
       prior3Sum += c.monthly[i];
       if (c.monthly[i] > 0) priorMonthsActive++;
     }
     // Qualifies only if they had real activity earlier and went fully silent.
     // priorMonthsActive >= 2 filters out one-off invoices (e.g. someone who
     // ordered once 5 months ago - not really "cooling", just a one-time buyer).
     if (last3Sum === 0 && prior3Sum > 0 && priorMonthsActive >= 2) {
       coolingCustomers.push({
         customer: c.customer,
         channel: c.channel,
         prior3Total: +prior3Sum.toFixed(2),
         prior3MonthsActive: priorMonthsActive,
         last3Total: 0,
         lastInvoiceMonth: c.lastMonth || null,
       });
     }
   }
   coolingCustomers.sort((a, b) => b.prior3Total - a.prior3Total);
   coolingCustomers.splice(10); // top 10 by lost revenue
 }

 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl: ltFin.sheetUrl,
 months: MONTHS,
 rows: rowsOut,
 subtotals: {
 gelatoRaw: gelatoRaw.map((v) => +v.toFixed(2)),
 gelatoNormalized: gelatoRaw.map((v) => +v.toFixed(2)),     // mirror raw
 othersRaw: othersRaw.map((v) => +v.toFixed(2)),
 othersNormalized: othersRaw.map((v) => +v.toFixed(2)),     // mirror raw
 grandTotalNormalized: MONTHS.map((_, i) => gelatoRaw[i] + othersRaw[i]).map((v) => +v.toFixed(2)),
 },
 topCustomers,
 coolingCustomers,
 };
}
