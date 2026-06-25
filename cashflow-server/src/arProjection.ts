/**
 * Non-Gelato AR Projection - month-lag collection curve, weekly-spread.
 *
 * MODEL
 * -----
 * For every PAID invoice we compute its monthly lag from invoice → payment
 * (lag 0 = same calendar month, lag 1 = next month, etc.). Aggregating across
 * a channel's history gives a curve like:
 * M0=44%, M1=44%, M2=8%, M3=1%, M4=0.1%, M5=1.4%, ...
 * meaning of every $1 invoiced by that channel, $0.44 was collected in the
 * issue month, $0.44 in the next month, and so on.
 *
 * For each OPEN invoice we:
 * 1. Look up the channel's lag curve (falls back to global if < 5 samples).
 * 2. Compute current-lag = today.month − invoice.month.
 * 3. Normalize the curve buckets from current-lag onward so they sum to
 * 100% - this redistributes the OPEN balance across the remaining
 * expected months (skips months that have already passed).
 * 4. Spread each target month's projected amount EVENLY across the weeks
 * in the 13-week window that overlap that calendar month.
 * 5. Months whose end is already before Wk 1 → overdue dump in Wk 1.
 * 6. Months past Wk 13 → recorded but not placed in any week.
 *
 * Every percentage is recomputed live from the Invoice Tracker - no hardcoded
 * percentages. Gelato is excluded (handled by gelatoAr.ts at Net 97).
 */

import { getInvoiceTracker, type InvoiceRow } from './invoiceTracker.js';
import { channelOf } from './salesByChannel.js';

type Week = { start: string; end: string };

const MAX_LAG_MONTHS = 12; // capture up to ~1-year tail
const MIN_CHANNEL_SAMPLES = 5; // fall back to global curve below this
const STALE_AGE_MONTHS = 12; // open invoices older than this → skip

function staleCutoffDate(): Date {
 const now = new Date();
 return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - STALE_AGE_MONTHS, 1));
}

/**
 * Allowance-for-doubtful-accounts style collectibility haircut. Open AR is not
 * 100% guaranteed cash: the older an invoice is and the riskier its status, the
 * less of it a prudent forecast should book as a future inflow. Returns a
 * multiplier (1 = full, <1 = discounted). Tiered, conservative, and surfaced on
 * the row (blended rate shown in the 13-week note) so it's transparent - not a
 * hidden fudge. `ageDays` = days since the invoice was issued.
 */
function collectibilityFactor(status: string, ageDays: number): number {
 const s = (status || '').toLowerCase();
 if (/collection|bad ?debt|dispute|uncollect|charge\s*off/.test(s)) return 0.5; // flagged at-risk
 if (ageDays <= 90) return 1.0;   // within normal terms + grace
 if (ageDays <= 180) return 0.92; // 3-6 months out
 if (ageDays <= 270) return 0.82; // 6-9 months out
 return 0.70;                     // 9-12 months out (12mo+ already filtered as stale)
}

export type ArProjectionRow = {
 customer: string;
 channel: string;
 invoiceNumber: string;
 invoiceDate: string;
 amount: number;
 paidAmount: number;
 openBalance: number;
 status: string;
 currentLag: number;
 collectibility: number;        // haircut factor applied (1 = full, <1 = doubtful)
 projectedCollectible: number;  // openBalance × collectibility (what we book as cash)
 placements: Array<{ targetMonth: string; amount: number; weekIndices: number[] }>;
};

export type LagCurvePoint = {
 lag: number; // 0 = same month, 1 = next month, ...
 pctOfInvoiced: number; // share of total invoiced that gets collected at this lag
};

export type ChannelStat = {
 channel: string;
 sampleInvoiceCount: number;
 totalInvoiced: number;
 totalCollected: number;
 collectionRate: number; // collected ÷ invoiced (cumulative)
 curve: LagCurvePoint[];
 source: 'channel' | 'global';
};

export type ArProjectionResult = {
 arByWeek: number[];
 buckets: {
 overdueWk1: number;
 openInWindow: number;
 openAfterWindow: number;
 futureProjected: number;
 };
 channelStats: ChannelStat[];
 globalCurve: LagCurvePoint[];
 globalCollectionRate: number;
 placements: ArProjectionRow[];
 globalAvgCollectionDays: number; // legacy field kept for UI compatibility
 dailyRunRate: number;
 projectedCollectibilityRate: number; // blended haircut: $ booked as cash ÷ gross open AR projected
 warnings: string[];
};

// --- Date helpers ---

function ymd(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function parseMDY(s: string): Date | null {
 const t = (s ?? '').trim();
 // ISO YYYY-MM-DD (what invoiceTracker now normalises XLSX serial dates to)
 const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
 // Legacy M/D/YYYY string form
 const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
 if (m) {
 const yr = m[3].length === 2 ? Number('20' + m[3]) : Number(m[3]);
 return new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2])));
 }
 return null;
}
function monthLag(from: Date, to: Date): number {
 return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}
/** First day of (invoice month + lag months) - used as the "target month" key. */
function monthAdd(d: Date, lag: number): { year: number; month: number; ym: string } {
 const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + lag, 1));
 const year = dt.getUTCFullYear();
 const month = dt.getUTCMonth();
 return { year, month, ym: `${year}-${String(month + 1).padStart(2, '0')}` };
}
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- Curve building ---

type RawCurve = { totalInvoiced: number; totalCollected: number; lagPaid: number[]; sampleCount: number };

function emptyCurve(): RawCurve {
 return { totalInvoiced: 0, totalCollected: 0, lagPaid: new Array(MAX_LAG_MONTHS + 1).fill(0), sampleCount: 0 };
}

function accumulateInvoice(curve: RawCurve, inv: InvoiceRow): void {
 if (inv.amount <= 0) return;
 if (/write\s*off/i.test(inv.status)) return;
 curve.totalInvoiced += inv.amount;
 curve.sampleCount += 1;
 if (inv.paid <= 0) return;
 const paid = parseMDY(inv.paidDate);
 if (!paid) return;
 const lag = monthLag(inv.invoiceDate, paid);
 if (lag < 0) return;
 curve.totalCollected += inv.paid;
 const bucket = Math.min(lag, MAX_LAG_MONTHS);
 curve.lagPaid[bucket] += inv.paid;
}

function curveToPoints(raw: RawCurve): LagCurvePoint[] {
 if (raw.totalInvoiced === 0) return [];
 return raw.lagPaid.map((paid, lag) => ({ lag, pctOfInvoiced: paid / raw.totalInvoiced }));
}

// --- Main ---

export async function getArProjection(weeks: Week[], asOf?: Date): Promise<ArProjectionResult> {
 const warnings: string[] = [];
 const arByWeek = new Array(weeks.length).fill(0);
 const buckets = { overdueWk1: 0, openInWindow: 0, openAfterWindow: 0, futureProjected: 0 };

 if (weeks.length === 0) {
 return {
 arByWeek, buckets, channelStats: [], globalCurve: [], globalCollectionRate: 0,
 placements: [], globalAvgCollectionDays: 30, dailyRunRate: 0,
 projectedCollectibilityRate: 1, warnings,
 };
 }

 const windowStart = new Date(weeks[0].start + 'T00:00:00Z');
 const windowEnd = new Date(weeks[weeks.length - 1].end + 'T23:59:59Z');

 let tracker;
 try {
 tracker = await getInvoiceTracker();
 } catch (e) {
 warnings.push(`Invoice Tracker fetch failed (${e instanceof Error ? e.message : '?'}) - AR projection = 0.`);
 return {
 arByWeek, buckets, channelStats: [], globalCurve: [], globalCollectionRate: 0,
 placements: [], globalAvgCollectionDays: 30, dailyRunRate: 0,
 projectedCollectibilityRate: 1, warnings,
 };
 }

 if (asOf) {
 // As-of back-test: keep only invoices issued by the anchor, and undo any
 // payment that happened AFTER it (so each invoice's open balance + the lag
 // curve reflect only what was known on that date).
 const cut = asOf.getTime();
 tracker = {
 ...tracker,
 invoices: tracker.invoices
 .filter((inv) => inv.invoiceDate.getTime() <= cut)
 .map((inv) => {
 const pd = inv.paidDate ? parseMDY(inv.paidDate) : null;
 return pd && pd.getTime() > cut ? { ...inv, paid: 0, paidDate: '' } : inv;
 }),
 };
 }

 // 1. Build per-channel + global lag curves AND collect a FULL list of
 //    days-to-pay per customer (not just sum/count). This lets us compute
 //    median + std-dev per customer, so the projection can model each
 //    customer's full pay-day DISTRIBUTION rather than collapsing it to a
 //    single average. Background: dataset's overall distribution is heavily
 //    right-skewed (median 23d, mean 40d, 20% pay within a week, 8% take
 //    >90d) - using just the mean would systematically over-project the
 //    "typical" payment date.
 const globalRaw = emptyCurve();
 const channelRaw = new Map<string, RawCurve>();
 const globalDaysList: number[] = [];
 const channelDaysList = new Map<string, number[]>();
 const customerDaysList = new Map<string, number[]>();
 for (const inv of tracker.invoices) {
   const ch = channelOf(inv.customer);
   if (ch === 'Gelato') continue;                     // Gelato Net 97 handled elsewhere
   accumulateInvoice(globalRaw, inv);
   if (!channelRaw.has(ch)) channelRaw.set(ch, emptyCurve());
   accumulateInvoice(channelRaw.get(ch)!, inv);
   const paid = parseMDY(inv.paidDate);
   if (inv.paid > 0 && paid) {
     const days = (paid.getTime() - inv.invoiceDate.getTime()) / MS_PER_DAY;
     if (days >= 0 && days <= 365) {
       globalDaysList.push(days);
       if (!channelDaysList.has(ch)) channelDaysList.set(ch, []);
       channelDaysList.get(ch)!.push(days);
       const custKey = inv.customer.trim();
       if (!customerDaysList.has(custKey)) customerDaysList.set(custKey, []);
       customerDaysList.get(custKey)!.push(days);
     }
   }
 }

 const globalCurve = curveToPoints(globalRaw);

 function statsOf(arr: number[]): { median: number; std: number; n: number } {
   const n = arr.length;
   if (n === 0) return { median: 30, std: 20, n: 0 };
   const sorted = [...arr].sort((a, b) => a - b);
   const median = sorted[Math.floor(n / 2)];
   const mean = sorted.reduce((s, v) => s + v, 0) / n;
   const std = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
   return { median, std: Math.max(2, std), n };       // floor std at 2d so single-day customers still spread a bit
 }
 const globalStats = statsOf(globalDaysList);
 const globalAvgDays = globalStats.median;            // legacy display field uses median (more representative than mean for skewed dist)

 /** Best-available pay-day distribution stats for a customer (median+std).
  *  Customer-level if ≥5 paid samples, else channel (≥10), else global. */
 function payDayStats(customer: string, channel: string): { median: number; std: number; source: 'customer' | 'channel' | 'global' } {
   const cu = customerDaysList.get(customer.trim());
   if (cu && cu.length >= 5) {
     const s = statsOf(cu);
     return { median: s.median, std: s.std, source: 'customer' };
   }
   const ch = channelDaysList.get(channel);
   if (ch && ch.length >= 10) {
     const s = statsOf(ch);
     return { median: s.median, std: s.std, source: 'channel' };
   }
   return { median: globalStats.median, std: globalStats.std, source: 'global' };
 }

 /**
  * Build a probability density over days-to-pay for a customer using a
  * normal kernel centered at their median. Returns array of (dayOffset, prob)
  * pairs summing to ~1. Used to spread one invoice's payment over a window
  * of likely pay dates rather than dumping the whole amount in one week.
  */
 function payDayDensity(median: number, std: number, todayOffset: number): Array<{ day: number; prob: number }> {
   // Span: median ± 2.5σ covers ~98% of the distribution.
   const startRaw = Math.max(0, median - 2.5 * std);
   const endRaw = median + 2.5 * std;
   // Clip below today's offset (can't pay before today for an open invoice,
   // since if they had they wouldn't be open). For NOT-YET-OVERDUE invoices,
   // todayOffset < median, so this just trims pre-today tail.
   const start = Math.max(startRaw, todayOffset);
   const end = Math.max(start + 1, endRaw);
   const weights: Array<{ day: number; w: number }> = [];
   for (let d = Math.floor(start); d <= Math.ceil(end); d++) {
     const z = (d - median) / std;
     weights.push({ day: d, w: Math.exp(-(z * z) / 2) });
   }
   // If the entire historical distribution is in the past (very overdue
   // invoice - e.g., customer normally pays day 23 and this is day 120),
   // we still need a projection: place a flat tail across next 2σ worth of days.
   let totalW = weights.reduce((s, x) => s + x.w, 0);
   if (totalW < 1e-9) {
     const tailEnd = todayOffset + Math.max(7, Math.round(std));
     for (let d = todayOffset; d <= tailEnd; d++) weights.push({ day: d, w: 1 });
     totalW = weights.length;
   }
   return weights.map((x) => ({ day: x.day, prob: x.w / totalW }));
 }

 function curveFor(channel: string): { curve: number[]; source: 'channel' | 'global' } {
 const ch = channelRaw.get(channel);
 if (ch && ch.sampleCount >= MIN_CHANNEL_SAMPLES && ch.totalInvoiced > 0) {
 return { curve: ch.lagPaid.map((p) => p / ch.totalInvoiced), source: 'channel' };
 }
 if (globalRaw.totalInvoiced > 0) {
 return { curve: globalRaw.lagPaid.map((p) => p / globalRaw.totalInvoiced), source: 'global' };
 }
 return { curve: new Array(MAX_LAG_MONTHS + 1).fill(0), source: 'global' };
 }

 // 2. Project each open invoice across its channel's curve, distributed weekly.
 const today = asOf ?? new Date();
 const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
 const stale = staleCutoffDate();
 const placements: ArProjectionRow[] = [];
 let grossOpenProjected = 0; // sum of open balances we attempted to project
 let netOpenProjected = 0;   // sum after collectibility haircut

 /** Spread `amount` across all 13-week buckets that overlap calendar (year, month). */
 function spreadAcrossMonth(year: number, month: number, amount: number): number[] {
 const overlapping: number[] = [];
 const monthStart = new Date(Date.UTC(year, month, 1));
 const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59));
 for (let i = 0; i < weeks.length; i++) {
 const ws = new Date(weeks[i].start + 'T00:00:00Z');
 const we = new Date(weeks[i].end + 'T23:59:59Z');
 if (we >= monthStart && ws <= monthEnd) overlapping.push(i);
 }
 if (overlapping.length === 0) {
 if (monthEnd < windowStart) {
 // Past month, not even partly in window → overdue dump
 arByWeek[0] += amount;
 buckets.overdueWk1 += amount;
 return [0];
 }
 // Future month past Wk 13 → record but don't place
 buckets.openAfterWindow += amount;
 return [];
 }
 const portion = amount / overlapping.length;
 for (const idx of overlapping) {
 arByWeek[idx] += portion;
 buckets.openInWindow += portion;
 }
 return overlapping;
 }

 /** Find the week-index this date lands in. Returns -1 if before/after window. */
 function weekIndexFor(d: Date): number {
   const t = d.getTime();
   for (let i = 0; i < weeks.length; i++) {
     const ws = new Date(weeks[i].start + 'T00:00:00Z').getTime();
     const we = new Date(weeks[i].end + 'T23:59:59Z').getTime();
     if (t >= ws && t <= we) return i;
   }
   return -1;
 }

 for (const inv of tracker.invoices) {
 const open = inv.openBalance;   // = "Money Owed" (AR dashboard source of truth)
 if (open <= 0.01) continue;
 if (/write\s*off/i.test(inv.status)) continue;
 const channel = channelOf(inv.customer);
 if (channel === 'Gelato') continue; // Gelato handled separately (Net 97)
 if (open < 200) continue; // sub-$200 noise filter - NON-GELATO only
 if (inv.invoiceDate < stale) continue;

 const currentLag = monthLag(inv.invoiceDate, todayUtc);

 // Collectibility haircut: book only the prudent-collectible portion of the
 // open balance as projected cash. ageDays = how long since the invoice issued.
 const ageDays = Math.max(0, Math.floor((todayUtc.getTime() - inv.invoiceDate.getTime()) / MS_PER_DAY));
 const factor = collectibilityFactor(inv.status, ageDays);
 const effOpen = +(open * factor).toFixed(2);
 grossOpenProjected += open;
 netOpenProjected += effOpen;

 const row: ArProjectionRow = {
 customer: inv.customer,
 channel,
 invoiceNumber: inv.invoiceNumber,
 invoiceDate: ymd(inv.invoiceDate),
 amount: inv.amount,
 paidAmount: inv.paid,
 openBalance: open,
 status: inv.status,
 currentLag,
 collectibility: factor,
 projectedCollectible: effOpen,
 placements: [],
 };

 // === Per-customer distribution-based projection ===
 //   1. Look up customer's historical pay-day distribution (median + std).
 //   2. Generate a Gaussian density centered at median, clipped at "today"
 //      (since we can't receive cash for an open invoice in the past).
 //   3. Distribute the FULL open balance across the future days according
 //      to that density, then group by week.
 //
 // The amount distributed is the collectibility-adjusted balance (`effOpen`),
 // not the full open balance: a prudent forecast discounts older / at-risk
 // invoices (see collectibilityFactor) rather than booking 100% as certain cash.
 const todayOffset = Math.max(0, Math.floor((todayUtc.getTime() - inv.invoiceDate.getTime()) / MS_PER_DAY));
 const stats = payDayStats(inv.customer, channel);
 const density = payDayDensity(stats.median, stats.std, todayOffset);

 // Convert (dayOffset, prob) to per-week placement.
 const weekShare = new Array(weeks.length).fill(0);
 let afterWindowAmount = 0;
 const weekIdxSet = new Set<number>();
 for (const { day, prob } of density) {
   const payMs = inv.invoiceDate.getTime() + day * MS_PER_DAY;
   const share = effOpen * prob;
   if (payMs > windowEnd.getTime()) {
     afterWindowAmount += share;
     continue;
   }
   if (payMs < windowStart.getTime()) {
     // Shouldn't happen (todayOffset clip), but defensively: Wk1.
     weekShare[0] += share;
     weekIdxSet.add(0);
     continue;
   }
   const wIdx = weekIndexFor(new Date(payMs));
   if (wIdx >= 0) {
     weekShare[wIdx] += share;
     weekIdxSet.add(wIdx);
   } else {
     afterWindowAmount += share;
   }
 }

 // Apply to arByWeek + buckets.
 const isOverdue = todayOffset > stats.median + stats.std;        // significantly past expected pay
 for (let i = 0; i < weeks.length; i++) {
   if (weekShare[i] > 0) {
     arByWeek[i] += weekShare[i];
     if (isOverdue && i === 0) buckets.overdueWk1 += weekShare[i];
     else buckets.openInWindow += weekShare[i];
   }
 }
 if (afterWindowAmount > 0) buckets.openAfterWindow += afterWindowAmount;
 row.placements.push({
   targetMonth: isOverdue ? `overdue (cust median ${stats.median.toFixed(0)}d, age ${todayOffset}d, src=${stats.source})` : `cust median ${stats.median.toFixed(0)}d±${stats.std.toFixed(0)} (src=${stats.source})`,
   amount: effOpen,
   weekIndices: [...weekIdxSet].sort((a, b) => a - b),
 });
 placements.push(row);
 }

 // 3. Build channelStats for the API/UI.
 const channelStats: ChannelStat[] = [];
 for (const [ch, raw] of channelRaw) {
 const source: 'channel' | 'global' = raw.sampleCount >= MIN_CHANNEL_SAMPLES ? 'channel' : 'global';
 channelStats.push({
 channel: ch,
 sampleInvoiceCount: raw.sampleCount,
 totalInvoiced: +raw.totalInvoiced.toFixed(2),
 totalCollected: +raw.totalCollected.toFixed(2),
 collectionRate: raw.totalInvoiced > 0 ? +(raw.totalCollected / raw.totalInvoiced).toFixed(4) : 0,
 curve: curveToPoints(raw),
 source,
 });
 }
 channelStats.sort((a, b) => b.totalInvoiced - a.totalInvoiced);

 for (let i = 0; i < arByWeek.length; i++) arByWeek[i] = +arByWeek[i].toFixed(2);
 buckets.overdueWk1 = +buckets.overdueWk1.toFixed(2);
 buckets.openInWindow = +buckets.openInWindow.toFixed(2);
 buckets.openAfterWindow = +buckets.openAfterWindow.toFixed(2);

 return {
 arByWeek,
 buckets,
 channelStats,
 globalCurve,
 globalCollectionRate: globalRaw.totalInvoiced > 0 ? +(globalRaw.totalCollected / globalRaw.totalInvoiced).toFixed(4) : 0,
 placements,
 globalAvgCollectionDays: +globalAvgDays.toFixed(1),
 dailyRunRate: 0,
 projectedCollectibilityRate: grossOpenProjected > 0 ? +(netOpenProjected / grossOpenProjected).toFixed(4) : 1,
 warnings,
 };
}
