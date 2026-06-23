/**
 * Customer-cohort sales projection.
 *
 * Wholesale B2B reorders are lumpy by nature: each retailer has its own
 * reorder cycle (anywhere from weekly to once every 4-6 months) and its own
 * typical order size. Aggregating up to month-level and applying YoY growth
 * (the statistical anchor) is stable but blind to *who* is actually due to
 * order in the forecast window. This module models each customer as its own
 * cohort and stacks expected reorders.
 *
 * Data source: Little Tree Financials sheet (the company's source-of-truth
 * invoice ledger). Excluded customers (Gelato + 3 brand-side partners) are
 * filtered out upstream before invoices reach this module.
 *
 * For each customer:
 *   - Compute reorder cycle from the median gap between consecutive invoices.
 *   - Compute typical order size from the trimmed mean of recent amounts.
 *   - Pick a recency tier (active / cooling / dormant / churned) → weight.
 *   - Walk forward from the last invoice date, projecting each next-cycle
 *     order at (typical size × tier weight) until we leave the horizon.
 *
 * Output: per-customer projection rows + aggregated weekly + monthly totals.
 * The aggregated monthly total is what the API surfaces alongside the
 * statistical-anchor forecast; the per-customer rows are for audit/UI.
 */

import type { LtFinancialsInvoice } from './ltFinancialsSales.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const COHORT_YEAR_FLOOR = 2024;

/** Recency tiers govern how confident we are that a customer will reorder.
 *
 * Weights are calibrated against historical monthly Non-Gelato totals
 * ($300-400k typical). Earlier values (1.0 / 0.6 / 0.25) over-projected by
 * ~2× because even "active" customers miss ~15% of expected reorders in
 * practice - supply gaps, customer cash-flow, distributor swaps, etc.
 *
 * If the bottom-up cohort total drifts off-anchor again, calibrate against
 * the statistical anchor by backtesting Jan-Apr (known actuals).
 */
const ACTIVITY_TIERS = [
  { name: 'active',  maxDays: 60,        weight: 0.85 },
  { name: 'cooling', maxDays: 180,       weight: 0.40 },
  { name: 'dormant', maxDays: 365,       weight: 0.10 },
  { name: 'churned', maxDays: Infinity,  weight: 0    },
] as const;
type ActivityTier = typeof ACTIVITY_TIERS[number]['name'];

/**
 * Normalise customer name for grouping cohort duplicates while preserving
 * different store locations. Examples that should collapse:
 *   - "Cloud Cannabis Company Fulton" vs "Coud Cannabis Company Fulton" (typo)
 *   - "Allstar Processing LLC" vs "Allstar Processing"                  (suffix)
 *   - "AIM High Meds" vs "Aim High Meds"                                (case)
 *   - "Timber Cannabis Co." vs "Timber Cannabis Co"                     (punct)
 *
 * What should NOT collapse:
 *   - "Cloud Cannabis Kalamazoo" vs "Cloud Cannabis Detroit"            (different stores)
 *   - "Allstar" vs "Allstar Processing"                                 (different entities)
 *
 * Strategy:
 *   1. Strip "Little Tree- " prefix.
 *   2. Lowercase, collapse whitespace + punctuation.
 *   3. Drop generic suffixes only (llc, inc, co, co., corp).
 *   4. Apply targeted typo fixes (coud→cloud).
 *   5. Use the full remaining token sequence as the key - preserves
 *      location words so different stores stay separate.
 */
function normalizeCustomerKey(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(/^little\s*tree[-\s]+/, '');
  s = s.replace(/[,.()]/g, ' ');
  s = s.replace(/\bcoud\b/g, 'cloud');           // typo fix
  s = s.replace(/\s+/g, ' ').trim();
  const dropTokens = new Set(['llc', 'inc', 'co', 'corp', 'company']);
  // We keep "company" if the customer is literally just "X Company" - but
  // drop it for the dedup key so "Co" / "Co." / "Company" all match.
  const tokens = s.split(' ').filter((t) => t && !dropTokens.has(t));
  return tokens.join(' ');
}

function tierForDaysSince(daysSince: number): { name: ActivityTier; weight: number } {
  for (const t of ACTIVITY_TIERS) {
    if (daysSince <= t.maxDays) return { name: t.name, weight: t.weight };
  }
  return ACTIVITY_TIERS[ACTIVITY_TIERS.length - 1];
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trimmedMean(nums: number[], trimPct = 0.1): number {
  if (nums.length === 0) return 0;
  if (nums.length <= 2) return nums.reduce((a, b) => a + b, 0) / nums.length;
  const sorted = [...nums].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * trimPct);
  const kept = sorted.slice(trim, sorted.length - trim);
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

function mondayOf(d: Date): Date {
  const day = d.getUTCDay();             // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  const m = new Date(d);
  m.setUTCDate(m.getUTCDate() + diff);
  m.setUTCHours(0, 0, 0, 0);
  return m;
}

function ymKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type CohortProjectedOrder = {
  date: string;       // ISO YYYY-MM-DD
  amount: number;     // typical order size × tier weight
  ym: string;         // YYYY-MM bucket the order lands in
  weekStart: string;  // Monday of that order's calendar week
};

export type CohortCustomerProfile = {
  customer: string;
  channel: string;
  invoiceCount: number;
  /** Total $ invoiced over the lookback window. */
  lifetime: number;
  /** Trimmed-mean amount per invoice (the projection's per-order anchor). */
  typicalOrderSize: number;
  /** Median amount per invoice (informational). */
  medianOrderSize: number;
  /** Median days between consecutive invoices. */
  reorderCycleDays: number;
  /** Last invoice date (ISO). */
  lastInvoiceDate: string;
  daysSinceLastInvoice: number;
  activityTier: ActivityTier;
  recencyWeight: number;
  /** Total $ this customer contributes to the cohort horizon. */
  projectedTotal: number;
  /** Individual projected orders (cadence-walked from last invoice). */
  projectedOrders: CohortProjectedOrder[];
};

export type CohortMonthlyPoint = {
  ym: string;
  projected: number;
  ordersExpected: number;
  customersContributing: number;
};

export type CohortWeeklyPoint = {
  weekStart: string;
  projected: number;
  ordersExpected: number;
};

export type CohortForecastResult = {
  asOf: string;
  basisInvoices: number;
  basisCustomers: number;
  activeCustomers: number;
  coolingCustomers: number;
  dormantCustomers: number;
  churnedCustomers: number;
  horizonMonths: string[];
  monthly: CohortMonthlyPoint[];
  weekly: CohortWeeklyPoint[];
  customers: CohortCustomerProfile[];
  totalProjected: number;
};

export type CohortForecastOptions = {
  asOf: Date;
  horizonWeeks: number;        // weekly granularity output length
  horizonMonths: number;       // how many months to project ahead
  excludeCustomer: (name: string) => boolean;
  /** Limit history to this many days back when computing cycle / typical size. */
  cycleLookbackDays?: number;  // default 365
};

/**
 * Build a customer-cohort projection from raw LT Financials invoices.
 *
 * Caller is expected to pass the already-filtered raw invoice list (excluding
 * Gelato + brand-side rows is the caller's responsibility - we accept an
 * `excludeCustomer` predicate so the same regex used elsewhere is reused).
 */
export function computeCustomerCohortForecast(
  invoices: LtFinancialsInvoice[],
  opts: CohortForecastOptions,
): CohortForecastResult {
  const cycleLookbackDays = opts.cycleLookbackDays ?? 365;
  const asOfMs = opts.asOf.getTime();
  const cycleFloorMs = asOfMs - cycleLookbackDays * MS_PER_DAY;

  // --- 1. Group by customer (after exclusion + year floor) ---
  // Group key is the *normalized* name so typo/suffix variants of the same
  // store collapse. We still keep a representative display name (the most
  // recent variant seen) so the UI can show something readable.
  const byCustomer = new Map<string, LtFinancialsInvoice[]>();
  const displayName = new Map<string, string>();
  const displayLastSeen = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.amount <= 0) continue;
    if (inv.invoiceDate.getUTCFullYear() < COHORT_YEAR_FLOOR) continue;
    if (opts.excludeCustomer(inv.customer)) continue;
    const raw = inv.customer.trim();
    const key = normalizeCustomerKey(raw);
    if (!key) continue;
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key)!.push(inv);
    const t = inv.invoiceDate.getTime();
    if (!displayLastSeen.has(key) || t > displayLastSeen.get(key)!) {
      displayLastSeen.set(key, t);
      displayName.set(key, raw);
    }
  }

  // --- 2. Build horizon (monthly buckets + weekly Monday list) ---
  const horizonMonths: string[] = [];
  const startMonth = new Date(Date.UTC(opts.asOf.getUTCFullYear(), opts.asOf.getUTCMonth(), 1));
  for (let i = 0; i < opts.horizonMonths; i++) {
    horizonMonths.push(ymKey(new Date(Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + i, 1))));
  }
  const horizonEndMs = Date.UTC(
    startMonth.getUTCFullYear(),
    startMonth.getUTCMonth() + opts.horizonMonths,
    1,
  );

  const weekStarts: string[] = [];
  const firstMonday = mondayOf(opts.asOf);
  for (let i = 0; i < opts.horizonWeeks; i++) {
    const wk = new Date(firstMonday);
    wk.setUTCDate(wk.getUTCDate() + 7 * i);
    weekStarts.push(isoDate(wk));
  }
  const weekStartSet = new Set(weekStarts);

  // --- 3. Per-customer profile + projection ---
  const customers: CohortCustomerProfile[] = [];
  let activeCustomers = 0, coolingCustomers = 0, dormantCustomers = 0, churnedCustomers = 0;

  for (const [normKey, hist] of byCustomer) {
    const customer = displayName.get(normKey) ?? normKey;
    hist.sort((a, b) => a.invoiceDate.getTime() - b.invoiceDate.getTime());

    // Cycle + typical size from the last `cycleLookbackDays` of history.
    const recent = hist.filter((h) => h.invoiceDate.getTime() >= cycleFloorMs);
    const cycleBasis = recent.length >= 2 ? recent : hist;

    const gaps: number[] = [];
    for (let i = 1; i < cycleBasis.length; i++) {
      const d = (cycleBasis[i].invoiceDate.getTime() - cycleBasis[i - 1].invoiceDate.getTime()) / MS_PER_DAY;
      if (d > 0) gaps.push(d);
    }
    // No observed gap: customer has only ONE invoice ever. We mark this so
    // the projection logic below treats them as one-off / unproven (single
    // future order at reduced weight, not a full cycle walk).
    const hasObservedCycle = gaps.length > 0;
    const reorderCycleDays = hasObservedCycle ? median(gaps) : 45;

    const amounts = cycleBasis.map((h) => h.amount);
    const typicalOrderSize = trimmedMean(amounts, 0.1);
    const medianOrderSize = median(amounts);

    const lastInvoice = hist[hist.length - 1];
    const daysSinceLastInvoice = Math.max(
      0,
      Math.floor((asOfMs - lastInvoice.invoiceDate.getTime()) / MS_PER_DAY),
    );
    const tier = tierForDaysSince(daysSinceLastInvoice);
    if (tier.name === 'active') activeCustomers++;
    else if (tier.name === 'cooling') coolingCustomers++;
    else if (tier.name === 'dormant') dormantCustomers++;
    else churnedCustomers++;

    // Walk projected orders forward from last invoice + cycle. Single-invoice
    // customers get ONE projected order at half the normal tier weight -
    // they haven't proven they reorder, so projecting 4 future cycles
    // (e.g. $54k × 4 = $216k for a one-off) over-inflates the cohort total.
    // Multi-invoice customers walk normally up to the horizon end.
    const projectedOrders: CohortProjectedOrder[] = [];
    if (tier.weight > 0 && typicalOrderSize > 0 && reorderCycleDays > 0) {
      let cursor = new Date(lastInvoice.invoiceDate);
      cursor.setUTCDate(cursor.getUTCDate() + Math.round(reorderCycleDays));
      if (cursor.getTime() < asOfMs) {
        cursor = new Date(asOfMs + (reorderCycleDays * MS_PER_DAY) / 2);
      }
      const maxWalks = hasObservedCycle ? 20 : 1;
      const weightForWalk = hasObservedCycle ? tier.weight : tier.weight * 0.5;
      let walks = 0;
      while (cursor.getTime() < horizonEndMs && walks < maxWalks) {
        const orderAmount = typicalOrderSize * weightForWalk;
        const wkStart = isoDate(mondayOf(cursor));
        projectedOrders.push({
          date: isoDate(cursor),
          amount: +orderAmount.toFixed(2),
          ym: ymKey(cursor),
          weekStart: wkStart,
        });
        cursor = new Date(cursor);
        cursor.setUTCDate(cursor.getUTCDate() + Math.round(reorderCycleDays));
        walks++;
      }
    }

    const lifetime = hist.reduce((s, h) => s + h.amount, 0);
    const projectedTotal = projectedOrders.reduce((s, o) => s + o.amount, 0);

    customers.push({
      customer,
      channel: lastInvoice.channel,
      invoiceCount: hist.length,
      lifetime: +lifetime.toFixed(2),
      typicalOrderSize: +typicalOrderSize.toFixed(2),
      medianOrderSize: +medianOrderSize.toFixed(2),
      reorderCycleDays: +reorderCycleDays.toFixed(1),
      lastInvoiceDate: isoDate(lastInvoice.invoiceDate),
      daysSinceLastInvoice,
      activityTier: tier.name,
      recencyWeight: tier.weight,
      projectedTotal: +projectedTotal.toFixed(2),
      projectedOrders,
    });
  }

  // Sort biggest contributors first - they're the ones the user will scrutinise.
  customers.sort((a, b) => b.projectedTotal - a.projectedTotal);

  // --- 4. Aggregate monthly + weekly ---
  const monthlyMap = new Map<string, CohortMonthlyPoint>();
  const monthlyCustomerSet = new Map<string, Set<string>>();
  for (const ym of horizonMonths) {
    monthlyMap.set(ym, { ym, projected: 0, ordersExpected: 0, customersContributing: 0 });
    monthlyCustomerSet.set(ym, new Set());
  }
  const weeklyMap = new Map<string, CohortWeeklyPoint>();
  for (const ws of weekStarts) {
    weeklyMap.set(ws, { weekStart: ws, projected: 0, ordersExpected: 0 });
  }

  for (const c of customers) {
    for (const o of c.projectedOrders) {
      const m = monthlyMap.get(o.ym);
      if (m) {
        m.projected += o.amount;
        m.ordersExpected += 1;
        monthlyCustomerSet.get(o.ym)!.add(c.customer);
      }
      if (weekStartSet.has(o.weekStart)) {
        const w = weeklyMap.get(o.weekStart)!;
        w.projected += o.amount;
        w.ordersExpected += 1;
      }
    }
  }

  const monthly: CohortMonthlyPoint[] = horizonMonths.map((ym) => {
    const p = monthlyMap.get(ym)!;
    return {
      ym,
      projected: +p.projected.toFixed(2),
      ordersExpected: p.ordersExpected,
      customersContributing: monthlyCustomerSet.get(ym)!.size,
    };
  });
  const weekly: CohortWeeklyPoint[] = weekStarts.map((ws) => {
    const p = weeklyMap.get(ws)!;
    return {
      weekStart: ws,
      projected: +p.projected.toFixed(2),
      ordersExpected: p.ordersExpected,
    };
  });

  const totalProjected = customers.reduce((s, c) => s + c.projectedTotal, 0);

  return {
    asOf: opts.asOf.toISOString(),
    basisInvoices: invoices.filter((i) => !opts.excludeCustomer(i.customer)).length,
    basisCustomers: byCustomer.size,
    activeCustomers,
    coolingCustomers,
    dormantCustomers,
    churnedCustomers,
    horizonMonths,
    monthly,
    weekly,
    customers,
    totalProjected: +totalProjected.toFixed(2),
  };
}
