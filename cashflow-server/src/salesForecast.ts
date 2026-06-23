/**
 * Forward-looking sales forecast for the 13-week cashflow (non-Gelato).
 *
 * === HOW THE PROJECTION IS COMPUTED (current approved methodology) ===
 *
 *   1. PULL live history from the Little Tree Financials sheet
 *      (invoice ledger, source-of-truth for sales).
 *
 *   2. FILTER: drop the 4 excluded brand-side / co-pack customers
 *      (Gelato, Alien Brainz, Funk'd Up, Yacht Fuel) - they don't behave
 *      like retail wholesale revenue.
 *
 *   3. AUTO-CALIBRATE the deseasonalized monthly base:
 *      - Take the last 6 completed months.
 *      - Divide each month's actual by its calendar-month seasonality index
 *        (seasonality computed from 2024+2025 actuals) → deseasonalized values.
 *      - Drop the single highest and lowest (trim outliers like Dec stock-up
 *        spikes or one-off slow months).
 *      - Average what remains → that's the base monthly run-rate.
 *      Today's calibration produces ~$362k/mo from Nov 25 - Apr 26.
 *
 *   4. FORECAST each upcoming month:
 *      - Current month: pace-based from MTD actuals
 *        (currentMtd / pctCompletedByDay-X-historically). Honours the live
 *        invoicing tempo instead of blindly applying seasonality.
 *      - Future months: base × seasonality_index(month).
 *
 *   5. SCENARIOS: best = base × 1.18, worst = base × 0.82.
 *      Width chosen from observed YoY std dev (~14%).
 *
 *   6. DISTRIBUTE each forecast month's $ to weeks:
 *      - Apply each lag bucket (months 0..6) using the global collection
 *        lag curve (built from Invoice Tracker paid history).
 *      - Within each target month, allocate cash across visible weeks
 *        using historical week-of-month weights (real businesses are
 *        lumpier than uniform 1/4 splits).
 *
 * The brand-level pipeline (linear trend per brand + recency tiers) is also
 * still computed - it powers the per-brand drill-down on the Sales Forecast
 * page but does NOT drive the lender-facing 13-week cashflow number. The
 * cashflow row reads `weeklyInflowV2` (and `weeklyInflowBest/Worst`) which
 * come from the approved methodology above.
 */

import { getInvoiceTracker, type InvoiceRow } from './invoiceTracker.js';
import { getLtFinancialsSales, type LtFinancialsInvoice } from './ltFinancialsSales.js';
import { channelOf } from './salesByChannel.js';
import {
  computeCustomerCohortForecast,
  type CohortForecastResult,
} from './salesCohortForecast.js';

const LOOKBACK_MONTHS = 12;        // full calendar year - captures seasonality
const FORECAST_HORIZON_MONTHS = 4;
const MAX_LAG_MONTHS = 6;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Recency tiers - instead of binary "active vs dormant", each brand gets a
 * confidence weight based on how stale its last invoice is. Retailers that
 * order every 4-6 months are real customers, not churned ones; cutting them
 * off at 60d zeroed too much forward-looking pipeline.
 *
 * Weight is applied as a flat multiplier on the trend forecast. Tweak these
 * numbers if backtesting shows the model is too generous / too tight.
 */
const ACTIVITY_TIERS = [
  { name: 'active',   maxDays: 60,  weight: 1.0  },  // ordered recently
  { name: 'cooling',  maxDays: 180, weight: 0.6  },  // 2-6 months silent, still plausible
  { name: 'dormant',  maxDays: 365, weight: 0.25 },  // 6-12 months silent, low confidence
  { name: 'churned',  maxDays: Infinity, weight: 0 }, // >1 year, treat as gone
] as const;
type ActivityTier = typeof ACTIVITY_TIERS[number]['name'];

function tierForDaysSince(daysSince: number): { name: ActivityTier; weight: number; maxDays: number } {
  for (const t of ACTIVITY_TIERS) {
    if (daysSince <= t.maxDays) return { name: t.name, weight: t.weight, maxDays: t.maxDays };
  }
  return ACTIVITY_TIERS[ACTIVITY_TIERS.length - 1];
}

type Week = { start: string; end: string; label?: string };

export type BrandForecast = {
  brand: string;
  /** Where the brand label came from - 'sheet' if all invoices for this
   *  brand had the Brand column populated in Invoice Tracker; 'derived'
   *  if any invoices fell back to first-word-of-customer-name; 'mixed'
   *  if a mix of both. UI surfaces this so the user can tell whether a
   *  row reflects the sheet or was auto-derived. */
  brandSource: 'sheet' | 'derived' | 'mixed';
  monthsObserved: number;
  /** Total non-zero invoice count over the lookback window (cadence signal). */
  invoiceCount: number;
  /** Average invoices per active month - how often this brand actually orders. */
  invoicesPerActiveMonth: number;
  /** Last 90 days $ vs prior 90 days $ - momentum indicator (% change). */
  momentum90d: { recent: number; prior: number; deltaPct: number | null };
  /** Total paid / total invoiced over the lookback (collection health, 0..1). */
  paidRatio: number;
  baselineMonthly: number;       // last 3-month mean (sanity anchor)
  trendSlope: number;            // $/month change in linear fit
  r2: number;                    // goodness-of-fit on the linear trend (0..1)
  bounds: { lower: number; upper: number };  // clamp window applied to forecast
  clamped: boolean;              // true if any forecast month hit a bound
  /** Days since this brand's last invoice (informational + drives tier). */
  daysSinceLastInvoice: number;
  /** Recency tier - determines the confidence weight applied to the forecast. */
  activityTier: ActivityTier;
  /** Weight multiplier from tier (1.0 = full forecast, 0 = churned). */
  recencyWeight: number;
  /** Per-month observed sales over the lookback window (length = lookbackMonths). */
  history: Array<{ ym: string; amount: number }>;
  /** Future months forecasted (length = forecastHorizonMonths), AFTER recency weight. */
  forecast: Array<{ ym: string; amount: number }>;
  /** Lag curve actually used for this brand (months 0..MAX_LAG_MONTHS). */
  lagCurve: number[];
  /** Source of the lag curve: 'brand' = brand-specific, 'global' = fallback. */
  lagSource: 'brand' | 'global';
  /** Brand's contribution to weeklyInflow (length = weeks.length). */
  weeklyInflow: number[];
  /** Sum of weeklyInflow - brand's in-window projected cash. */
  totalProjectedCash: number;
  /** Date of last invoice seen for this brand (informational - shows freshness). */
  lastInvoiceDate: string;
  // --- Depth-analysis fields (cadence-driven model) ---
  /** Typical days between consecutive invoices (median of observed gaps). */
  cadenceDays: number;
  /** Mean of last 6 invoice amounts, winsorized at 90th percentile. */
  avgInvoiceAmount: number;
  /** Next expected invoice date (last + cadence, never in the past). */
  nextExpectedDate: string;
  /** Recent 90d $ ÷ prior 90d $, clipped to [0.5, 1.8]. 1.0 = flat. */
  growthMultiplier: number;
  /** Month-of-year seasonal indices (0=Jan..11=Dec). All 1.0 if seasonality not computed. */
  seasonalIndices: number[];
  /** True iff brand has ≥ 9 distinct months of data (enough to fit seasonality). */
  hasSeasonality: boolean;
  /** Future invoices the model projects (cadence-walked from last observed). */
  projectedInvoices: Array<{ date: string; amount: number; ym: string; monthOfYear: number }>;
  /** Most recent invoices (up to 12) for the page drilldown. */
  recentInvoices: Array<{ date: string; amount: number }>;
  /** Gap days between consecutive observed invoices (informational). */
  gapDays: number[];
};

/** A single past or projected week in the weekly time series. */
export type WeeklySeriesPoint = {
  weekStart: string;          // YYYY-MM-DD (Monday)
  weekOfYear: number;         // 1..53 ISO week
  total: number;              // actual or forecasted sales $
  invoiceCount: number;       // 0 for forecast weeks
  isForecast: boolean;        // true for projected weeks (no actuals yet)
};

/** Output of the weekly analysis layer that drives the monthly forecast. */
export type WeeklyAnalysis = {
  history: WeeklySeriesPoint[];                  // past weeks (last 52+)
  /** Linear trend fit on last N weeks (default 13). */
  trend: { slope: number; intercept: number; r2: number; basisWeeks: number };
  /** Per ISO week-of-year, the seasonal index (actual / trend ratio averaged). */
  weekOfYearSeasonality: Array<{ weekOfYear: number; index: number; samples: number }>;
  /** Forecast for the next 13 weeks (or however many `weeks` were passed). */
  forecast: WeeklySeriesPoint[];
};

/** Total-level (non-Gelato) yearly aggregate. */
export type YearlyHistoryPoint = {
  year: string;
  total: number;
  invoiceCount: number;
  isPartial: boolean;       // true for the current year (YTD only)
  monthsObserved: number;
};

/** Total-level monthly point - what was actually invoiced that calendar month. */
export type MonthlyHistoryPoint = {
  ym: string;             // YYYY-MM
  total: number;
  invoiceCount: number;
};

/** Seasonality index: how much above/below the year's average each calendar
 *  month runs. Reference year defaults to the most-recent complete year. */
export type SeasonalityPoint = {
  monthOfYear: number;    // 1-12
  index: number;          // 1.0 = matches yearly average
  basisYear: string;      // year this index was computed from
};

/** One row in the total-level forecast - how we got the number for a future month. */
export type ForecastMonthRow = {
  ym: string;
  forecastedSales: number;
  method: 'prior-year-x-yoy' | 'baseline-x-seasonal' | 'recent-3m-mean';
  /** Prior-year-same-month value when the method used it (else null). */
  priorYearValue: number | null;
  /** YoY multiplier applied (1 + yoyGrowth) when method uses it. */
  yoyMultiplier: number | null;
  /** Seasonal index applied when method uses it (else null). */
  seasonalIndex: number | null;
  /** Sanity bound applied? Set if forecast got clamped. */
  clamped: 'low' | 'high' | null;
};

export type SalesForecastResult = {
  asOf: string;
  driver: {
    lookbackMonths: number;
    forecastHorizonMonths: number;
    maxLagMonths: number;
    /** Tier definitions used to weight stale brands (instead of binary exclusion). */
    tiers: Array<{ name: ActivityTier; maxDays: number; weight: number }>;
  };

  // --- Total-level (non-Gelato) multi-validation ---
  /** Year totals across all available history. */
  yearlyHistory: YearlyHistoryPoint[];
  /** Calendar-month series across all history (oldest → newest). */
  monthlyHistory: MonthlyHistoryPoint[];
  /** Seasonality indices per calendar month (1-12). */
  seasonality: SeasonalityPoint[];
  /** Year-over-year growth from same-period comparison (anchor used in forecast). */
  yoy: {
    /** (currYTD - prevYTD) / prevYTD, clamped to [-0.5, 1.0]. */
    rate: number;
    rawRate: number;       // unclamped, for transparency
    currYearLabel: string;
    prevYearLabel: string;
    monthsCompared: number;
    currYTD: number;
    prevYTD: number;
  };
  /** Full chain of consecutive-year YoY rates (2024→2025, 2025→2026YTD, ...).
   *  Lets the UI show how growth has evolved year-on-year. */
  yoyChain: Array<{
    fromYear: string;
    toYear: string;
    fromValue: number;
    toValue: number;
    monthsCompared: number;
    /** true when both years are full / both YTD aligned to same months. */
    aligned: boolean;
    rate: number;
  }>;
  /** Weekly time-series analysis (history + trend + seasonality + per-week forecast). */
  weeklyAnalysis: WeeklyAnalysis;
  /** Total-level forecast (BASE scenario), one row per upcoming month. */
  monthlyForecastV2: ForecastMonthRow[];
  /** Best-case monthly forecast (Base × 1.18). */
  monthlyForecastBest: ForecastMonthRow[];
  /** Worst-case monthly forecast (Base × 0.82, floored at current MTD). */
  monthlyForecastWorst: ForecastMonthRow[];
  /** Per-week cash arrival after lag (BASE scenario, length = weeks.length). */
  weeklyInflowV2: number[];
  /** Per-week cash arrival - best case. */
  weeklyInflowBest: number[];
  /** Per-week cash arrival - worst case. */
  weeklyInflowWorst: number[];
  /** Sum of invoiced (gross) across forecast horizon - base. */
  totalForecastedInvoiceV2: number;
  /** Sum of cash that lands inside the 13-week window - base. */
  totalProjectedCashV2: number;
  /** 13-week cash totals for each scenario. */
  scenarioTotals: {
    base: { invoiced: number; cash: number };
    best: { invoiced: number; cash: number };
    worst: { invoiced: number; cash: number };
  };
  /** Assumptions used by the approved projection (UI surfaces this). */
  approvedAssumptions: {
    deseasonalizedBase: number;
    bestMultiplier: number;
    worstMultiplier: number;
    growthTrend: number;
    excisetaxNote: string;
    /** How the deseasonalized base was auto-calibrated this run. */
    calibration: {
      windowMonths: number;
      contributors: Array<{ ym: string; actual: number; seasonality: number; deseasonalized: number; kept: boolean }>;
      deseasonalizedBase: number;
    };
  };
  /** Window the trend was fit on (ym labels, newest last). */
  lookbackWindow: string[];
  /** Forecast horizon months (ym labels, earliest first). */
  horizonMonths: string[];
  /** Weeks the cashflow is bucketed into (mirror of input). */
  weeks: Array<{ index: number; start: string; end: string; label: string }>;
  /** Global lag curve (fallback / aggregate, months 0..MAX_LAG_MONTHS). */
  globalLagCurve: number[];
  brands: BrandForecast[];
  /** Brands at recencyWeight 0 (truly churned, kept for transparency). */
  churnedBrands: Array<{ brand: string; lastInvoiceDate: string; daysSinceLastInvoice: number }>;
  /** Per-week projected inflow (length = weeks.length). */
  weeklyInflow: number[];
  /** Monthly forecast totals across all brands. */
  monthlyForecast: Array<{ ym: string; amount: number }>;
  /** Sum of all forecasted invoices that contribute (before lag distribution). */
  totalForecastedSales: number;
  /** Sum of weeklyInflow - what actually lands in the 13-week window as cash. */
  totalProjectedCash: number;
  /** Customer-cohort projection (sales from LT Financials, per-customer
   *  reorder-cycle walk). Null if LT Financials fetch failed. */
  cohortForecast: CohortForecastResult | null;
  /** Per-bucket projection (wholesale / private label / gelato). Each
   *  bucket runs the same auto-calibrated deseasonalized model independently
   *  on its own customer slice. UI surfaces all three as tabs. */
  buckets: {
    wholesale: BucketForecast;
    privateLabel: BucketForecast;
    gelato: BucketForecast;
  };
  warnings: string[];
};

/** Per-bucket slice of the projection - everything UI needs to render one
 *  bucket's view (history, seasonality, forecast, weekly cash) without the
 *  brand drill-down details that only the wholesale bucket carries. */
export type BucketForecast = {
  bucket: SalesBucket;
  label: string;                            // human-readable bucket name
  customerCount: number;                     // distinct customers contributing
  yearlyHistory: YearlyHistoryPoint[];
  monthlyHistory: MonthlyHistoryPoint[];
  seasonality: SeasonalityPoint[];
  yoy: SalesForecastResult['yoy'];
  yoyChain: SalesForecastResult['yoyChain'];
  weeklyAnalysis: WeeklyAnalysis;
  monthlyForecast: ForecastMonthRow[];
  monthlyForecastBest: ForecastMonthRow[];
  monthlyForecastWorst: ForecastMonthRow[];
  weeklyInflow: number[];                    // base scenario per week
  weeklyInflowBest: number[];
  weeklyInflowWorst: number[];
  scenarioTotals: {
    base: { invoiced: number; cash: number };
    best: { invoiced: number; cash: number };
    worst: { invoiced: number; cash: number };
  };
  deseasonalizedBase: number;
  baseCalibration: TotalForecastResult['baseCalibration'];
};

// --- Helpers ---

function parseMDYToDate(s: string | null | undefined): Date | null {
  const t = (s ?? '').trim();
  // ISO YYYY-MM-DD (what invoiceTracker now normalises XLSX serial dates to)
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  // Legacy M/D/YYYY string form
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const yr = m[3].length === 2 ? Number('20' + m[3]) : Number(m[3]);
  return new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2])));
}

function monthAdd(year: number, month: number, n: number): { year: number; month: number; ym: string } {
  let y = year, m = month + n;
  while (m > 11) { m -= 12; y += 1; }
  while (m < 0) { m += 12; y -= 1; }
  const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
  return { year: y, month: m, ym };
}

/** Fit y = a + b·t with ordinary least squares. Returns {a, b, r2}. */
function linearFit(values: number[]): { a: number; b: number; r2: number } {
  const n = values.length;
  if (n < 2) return { a: values[0] ?? 0, b: 0, r2: 0 };
  const ts = values.map((_, i) => i);
  const meanT = ts.reduce((s, t) => s + t, 0) / n;
  const meanY = values.reduce((s, y) => s + y, 0) / n;
  let num = 0, denT = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dt = ts[i] - meanT;
    const dy = values[i] - meanY;
    num += dt * dy;
    denT += dt * dt;
    denY += dy * dy;
  }
  const b = denT > 0 ? num / denT : 0;
  const a = meanY - b * meanT;
  const r2 = denY > 0 ? (num * num) / (denT * denY) : 0;
  return { a, b, r2 };
}

/** Build a brand's per-month sales series across the lookback window. */
function brandMonthlySeries(
  invoices: InvoiceRow[],
  brand: string,
  windowMonths: { year: number; month: number; ym: string }[],
): number[] {
  const lookup = new Map(windowMonths.map((w, i) => [w.ym, i]));
  const monthly = new Array(windowMonths.length).fill(0);
  for (const inv of invoices) {
    if (channelOf(inv.customer) === 'Gelato') continue;
    if ((inv.brand || channelOf(inv.customer)) !== brand) continue;
    const ym = `${inv.invoiceDate.getUTCFullYear()}-${String(inv.invoiceDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const idx = lookup.get(ym);
    if (idx === undefined) continue;
    monthly[idx] += inv.amount;
  }
  return monthly;
}

/**
 * Compute per-brand collection-lag curve from PAID history.
 * Returns lag (months) → fraction of invoice paid at that lag.
 * E.g. {0: 0.32, 1: 0.33, 2: 0.13, ...} means 32% paid same month, 33% next.
 */
function buildLagCurve(invoices: InvoiceRow[], brand: string): number[] {
  const lagPaid = new Array(MAX_LAG_MONTHS + 1).fill(0);
  let totalInvoiced = 0;
  for (const inv of invoices) {
    const b = inv.brand || channelOf(inv.customer);
    if (b !== brand) continue;
    if (channelOf(inv.customer) === 'Gelato') continue;
    if (inv.amount <= 0) continue;
    totalInvoiced += inv.amount;
    if (inv.paid <= 0) continue;
    const paidDate = parseMDYToDate(inv.paidDate);
    if (!paidDate) continue;
    const lag = (paidDate.getUTCFullYear() - inv.invoiceDate.getUTCFullYear()) * 12
      + (paidDate.getUTCMonth() - inv.invoiceDate.getUTCMonth());
    if (lag < 0 || lag > MAX_LAG_MONTHS) continue;
    lagPaid[lag] += inv.paid;
  }
  if (totalInvoiced === 0) return new Array(MAX_LAG_MONTHS + 1).fill(0);
  return lagPaid.map((p) => p / totalInvoiced);
}

/** Global fallback lag curve (across all non-Gelato brands). */
function buildGlobalLagCurve(invoices: InvoiceRow[]): number[] {
  const lagPaid = new Array(MAX_LAG_MONTHS + 1).fill(0);
  let totalInvoiced = 0;
  for (const inv of invoices) {
    if (channelOf(inv.customer) === 'Gelato') continue;
    if (inv.amount <= 0) continue;
    totalInvoiced += inv.amount;
    if (inv.paid <= 0) continue;
    const paidDate = parseMDYToDate(inv.paidDate);
    if (!paidDate) continue;
    const lag = (paidDate.getUTCFullYear() - inv.invoiceDate.getUTCFullYear()) * 12
      + (paidDate.getUTCMonth() - inv.invoiceDate.getUTCMonth());
    if (lag < 0 || lag > MAX_LAG_MONTHS) continue;
    lagPaid[lag] += inv.paid;
  }
  if (totalInvoiced === 0) return new Array(MAX_LAG_MONTHS + 1).fill(0);
  return lagPaid.map((p) => p / totalInvoiced);
}

function weekIndexFor(date: Date, weeks: Week[]): number {
  for (let i = 0; i < weeks.length; i++) {
    const ws = new Date(weeks[i].start + 'T00:00:00Z');
    const we = new Date(weeks[i].end + 'T23:59:59Z');
    if (date >= ws && date <= we) return i;
  }
  return -1;
}

/** Get the calendar weeks that overlap month (year, month) and lie in `weeks`. */
function weeksInMonth(year: number, month: number, weeks: Week[]): number[] {
  const monthStart = new Date(Date.UTC(year, month, 1));
  const monthEnd = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59));
  const out: number[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const ws = new Date(weeks[i].start + 'T00:00:00Z');
    const we = new Date(weeks[i].end + 'T23:59:59Z');
    if (we >= monthStart && ws <= monthEnd) out.push(i);
  }
  return out;
}

// --- Depth-analysis helpers ---

type BrandInvoice = { date: Date; amount: number; paid: number };

function gatherBrandInvoices(invs: InvoiceRow[], brand: string, fromMs: number): BrandInvoice[] {
  const out: BrandInvoice[] = [];
  for (const inv of invs) {
    if (channelOf(inv.customer) === 'Gelato') continue;
    if ((inv.brand || channelOf(inv.customer)) !== brand) continue;
    if (inv.invoiceDate.getTime() < fromMs) continue;
    if (inv.amount <= 0) continue;
    out.push({ date: inv.invoiceDate, amount: inv.amount, paid: inv.paid });
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Cap values above the given percentile to that percentile (winsorization). */
function winsorize(xs: number[], upperPct = 0.95): number[] {
  if (xs.length < 5) return xs.slice();
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(s.length * upperPct));
  const cap = s[idx];
  return xs.map((v) => Math.min(v, cap));
}

/**
 * Cadence stats - how often this brand invoices and for how much.
 * medianGapDays: typical days between consecutive invoices.
 * avgInvoiceAmount: winsorized mean of last 6 invoices.
 */
function computeCadence(sortedInvs: BrandInvoice[], todayMs: number): {
  medianGapDays: number;
  avgInvoiceAmount: number;
  lastInvoiceMs: number;
  nextExpectedMs: number;
  gapDays: number[];
} {
  if (sortedInvs.length === 0) {
    return { medianGapDays: 0, avgInvoiceAmount: 0, lastInvoiceMs: 0, nextExpectedMs: 0, gapDays: [] };
  }
  if (sortedInvs.length === 1) {
    const last = sortedInvs[0].date.getTime();
    return {
      medianGapDays: 30,
      avgInvoiceAmount: +sortedInvs[0].amount.toFixed(2),
      lastInvoiceMs: last,
      nextExpectedMs: Math.max(last + 30 * MS_PER_DAY, todayMs + 15 * MS_PER_DAY),
      gapDays: [],
    };
  }
  const gaps: number[] = [];
  for (let i = 1; i < sortedInvs.length; i++) {
    const dt = (sortedInvs[i].date.getTime() - sortedInvs[i - 1].date.getTime()) / MS_PER_DAY;
    if (dt >= 0.5) gaps.push(dt);
  }
  const medGap = Math.max(7, Math.round(median(gaps)));
  const recent = sortedInvs.slice(-Math.min(6, sortedInvs.length)).map((i) => i.amount);
  const win = winsorize(recent, 0.9);
  const avg = win.reduce((s, v) => s + v, 0) / win.length;
  const lastMs = sortedInvs[sortedInvs.length - 1].date.getTime();
  let nextMs = lastMs + medGap * MS_PER_DAY;
  if (nextMs < todayMs) nextMs = todayMs + Math.max(1, Math.floor(medGap / 2)) * MS_PER_DAY;
  return {
    medianGapDays: medGap,
    avgInvoiceAmount: +avg.toFixed(2),
    lastInvoiceMs: lastMs,
    nextExpectedMs: nextMs,
    gapDays: gaps.map((g) => +g.toFixed(0)),
  };
}

/**
 * Month-of-year seasonality (0=Jan..11=Dec). Only meaningful with ≥ 9
 * distinct months of data. Smoothed 70/30 toward 1.0 to dampen noise.
 */
function computeSeasonality(sortedInvs: BrandInvoice[]): { indices: number[]; hasSeasonality: boolean } {
  const flat = new Array(12).fill(1.0);
  const monthSet = new Set<string>();
  for (const inv of sortedInvs) {
    monthSet.add(`${inv.date.getUTCFullYear()}-${inv.date.getUTCMonth()}`);
  }
  if (monthSet.size < 9) return { indices: flat, hasSeasonality: false };

  const monthSums = new Array(12).fill(0);
  const monthCounts = new Array(12).fill(0);
  for (const inv of sortedInvs) {
    const m = inv.date.getUTCMonth();
    monthSums[m] += inv.amount;
    monthCounts[m] += 1;
  }
  const monthMeans = monthSums.map((s, i) => (monthCounts[i] > 0 ? s / monthCounts[i] : 0));
  const observed = monthMeans.filter((v) => v > 0);
  if (observed.length === 0) return { indices: flat, hasSeasonality: false };
  const overallMean = observed.reduce((s, v) => s + v, 0) / observed.length;
  const smoothed = monthMeans.map((m) => {
    const raw = m > 0 ? m / overallMean : 1.0;
    return Math.max(0.4, Math.min(1.8, 0.7 * raw + 0.3 * 1.0));
  });
  return { indices: smoothed, hasSeasonality: true };
}

/** Recent 90d $ ÷ prior 90d $, clipped to [0.5, 1.8]. */
function computeGrowth(sortedInvs: BrandInvoice[], todayMs: number): number {
  const r90 = todayMs - 90 * MS_PER_DAY;
  const r180 = todayMs - 180 * MS_PER_DAY;
  let recent = 0, prior = 0;
  for (const inv of sortedInvs) {
    const t = inv.date.getTime();
    if (t >= r90) recent += inv.amount;
    else if (t >= r180) prior += inv.amount;
  }
  if (prior <= 0) return 1.0;
  return Math.max(0.5, Math.min(1.8, recent / prior));
}

type ProjectedInvoice = { date: Date; amount: number; ym: string; monthOfYear: number };

function projectInvoices(
  cadence: { medianGapDays: number; avgInvoiceAmount: number; nextExpectedMs: number },
  growth: number,
  seasonal: { indices: number[]; hasSeasonality: boolean },
  tierWeight: number,
  horizonDaysAhead: number,
): ProjectedInvoice[] {
  const out: ProjectedInvoice[] = [];
  if (cadence.avgInvoiceAmount <= 0 || cadence.medianGapDays <= 0) return out;
  const endMs = Date.now() + horizonDaysAhead * MS_PER_DAY;
  let nextMs = cadence.nextExpectedMs;
  let safety = 0;
  while (nextMs <= endMs && safety < 24) {
    safety++;
    const d = new Date(nextMs);
    const moy = d.getUTCMonth();
    const seasonMult = seasonal.hasSeasonality ? seasonal.indices[moy] : 1.0;
    const amount = cadence.avgInvoiceAmount * growth * seasonMult * tierWeight;
    if (amount > 0.01) {
      out.push({
        date: d,
        amount: +amount.toFixed(2),
        ym: `${d.getUTCFullYear()}-${String(moy + 1).padStart(2, '0')}`,
        monthOfYear: moy,
      });
    }
    nextMs += cadence.medianGapDays * MS_PER_DAY;
  }
  return out;
}

// --- Main ---

function ymdOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function emptyBucket(bucket: SalesBucket, label: string, weeks: Week[]): BucketForecast {
  return {
    bucket,
    label,
    customerCount: 0,
    yearlyHistory: [],
    monthlyHistory: [],
    seasonality: [],
    yoy: { rate: 0, rawRate: 0, currYearLabel: '', prevYearLabel: '', monthsCompared: 0, currYTD: 0, prevYTD: 0 },
    yoyChain: [],
    weeklyAnalysis: { history: [], trend: { slope: 0, intercept: 0, r2: 0, basisWeeks: 0 }, weekOfYearSeasonality: [], forecast: [] },
    monthlyForecast: [],
    monthlyForecastBest: [],
    monthlyForecastWorst: [],
    weeklyInflow: new Array(weeks.length).fill(0),
    weeklyInflowBest: new Array(weeks.length).fill(0),
    weeklyInflowWorst: new Array(weeks.length).fill(0),
    scenarioTotals: {
      base: { invoiced: 0, cash: 0 },
      best: { invoiced: 0, cash: 0 },
      worst: { invoiced: 0, cash: 0 },
    },
    deseasonalizedBase: 0,
    baseCalibration: { windowMonths: 0, contributors: [], deseasonalizedBase: 0 },
  };
}

function emptyResult(weeks: Week[], warnings: string[]): SalesForecastResult {
  return {
    asOf: new Date().toISOString(),
    driver: {
      lookbackMonths: LOOKBACK_MONTHS,
      forecastHorizonMonths: FORECAST_HORIZON_MONTHS,
      maxLagMonths: MAX_LAG_MONTHS,
      tiers: ACTIVITY_TIERS.map((t) => ({ name: t.name, maxDays: t.maxDays, weight: t.weight })),
    },
    yearlyHistory: [],
    monthlyHistory: [],
    seasonality: [],
    yoy: { rate: 0, rawRate: 0, currYearLabel: '', prevYearLabel: '', monthsCompared: 0, currYTD: 0, prevYTD: 0 },
    yoyChain: [],
    weeklyAnalysis: { history: [], trend: { slope: 0, intercept: 0, r2: 0, basisWeeks: 0 }, weekOfYearSeasonality: [], forecast: [] },
    monthlyForecastV2: [],
    monthlyForecastBest: [],
    monthlyForecastWorst: [],
    weeklyInflowV2: new Array(weeks.length).fill(0),
    weeklyInflowBest: new Array(weeks.length).fill(0),
    weeklyInflowWorst: new Array(weeks.length).fill(0),
    totalForecastedInvoiceV2: 0,
    totalProjectedCashV2: 0,
    scenarioTotals: {
      base: { invoiced: 0, cash: 0 },
      best: { invoiced: 0, cash: 0 },
      worst: { invoiced: 0, cash: 0 },
    },
    approvedAssumptions: {
      deseasonalizedBase: 0,
      bestMultiplier: 1.18,
      worstMultiplier: 0.82,
      growthTrend: 0,
      excisetaxNote: 'Excise tax (24%) impact already baked into post-Jan-2026 baseline; -14.2% observed YoY drag',
      calibration: { windowMonths: 0, contributors: [], deseasonalizedBase: 0 },
    },
    lookbackWindow: [],
    horizonMonths: [],
    weeks: weeks.map((w, i) => ({ index: i, start: w.start, end: w.end, label: w.label ?? w.start.slice(5) })),
    globalLagCurve: new Array(MAX_LAG_MONTHS + 1).fill(0),
    brands: [],
    churnedBrands: [],
    weeklyInflow: new Array(weeks.length).fill(0),
    monthlyForecast: [],
    totalForecastedSales: 0,
    totalProjectedCash: 0,
    cohortForecast: null,
    buckets: {
      wholesale: emptyBucket('wholesale', 'Little Tree', weeks),
      privateLabel: emptyBucket('privateLabel', 'Private Label / Co-pack', weeks),
      gelato: emptyBucket('gelato', 'Little Tree Gelato', weeks),
    },
    warnings,
  };
}

// =====================================================================
// Multi-level total-level forecast (v2)
//
// Validates at THREE levels before projecting:
//   1. Year   - what's each calendar year's total non-Gelato sales?
//   2. Month  - which months are seasonally strong/weak (using last
//               COMPLETE year as the reference)?
//   3. YoY    - how does the current year-to-date compare to the same
//               period last year? (drives the growth multiplier)
//
// Then forecasts each upcoming month using the most reliable available
// signal in this order of preference:
//   a. Same calendar month, prior year × (1 + yoy)   ← strongest
//   b. Last-3-month mean × seasonalIndex             ← fallback
//   c. Last-3-month mean                              ← weakest
//
// Sanity bound: each forecast clamped to [0.4× peak, 1.6× peak] of recent
// 12-month history. Both bounds applied AFTER the seasonality / yoy math
// so we don't kill seasonal spikes outright.
// =====================================================================

type TotalForecastResult = {
  yearly: YearlyHistoryPoint[];
  monthly: MonthlyHistoryPoint[];
  seasonality: SeasonalityPoint[];
  yoy: SalesForecastResult['yoy'];
  yoyChain: SalesForecastResult['yoyChain'];
  weeklyAnalysis: WeeklyAnalysis;
  monthlyForecast: ForecastMonthRow[];
  monthlyForecastBest: ForecastMonthRow[];
  monthlyForecastWorst: ForecastMonthRow[];
  weeklyInflow: number[];
  weeklyInflowBest: number[];
  weeklyInflowWorst: number[];
  totalForecastedInvoice: number;
  totalProjectedCash: number;
  totalForecastedInvoiceBest: number;
  totalProjectedCashBest: number;
  totalForecastedInvoiceWorst: number;
  totalProjectedCashWorst: number;
  deseasonalizedBase: number;
  baseCalibration: {
    windowMonths: number;
    contributors: Array<{ ym: string; actual: number; seasonality: number; deseasonalized: number; kept: boolean }>;
    deseasonalizedBase: number;
  };
};

function ymKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Returns weights for each "week-of-month" position (1..5) from historical
 * invoice ISSUE dates. Real-world wholesale invoicing is NOT uniform within
 * a month - week 1 (month-start) and week 4 (month-end statement cycle) are
 * usually heavier than weeks 2/3. Using historical pattern instead of a
 * flat 1/4 split gives realistic lumpy projections.
 *
 * Returns [w1, w2, w3, w4, w5] summing to 1.0. Falls back to uniform 0.2 if
 * no history.
 */
/** Structural shape used by the total-level forecast. Both Invoice Tracker
 *  rows and Little Tree Financials rows satisfy this - we only need date /
 *  amount / customer to compute multi-level history + forecast. */
type SalesRecord = { invoiceDate: Date; amount: number; customer: string };

function computeWeekOfMonthWeights(
  invoices: SalesRecord[],
  includeCustomer: (c: string) => boolean = (c) => !EXCLUDED_SALES_CUSTOMERS.test(c),
): number[] {
  const buckets = [0, 0, 0, 0, 0];
  let total = 0;
  for (const inv of invoices) {
    if (inv.amount <= 0) continue;
    if (!includeCustomer(inv.customer)) continue;
    const dom = inv.invoiceDate.getUTCDate();
    const wom = Math.min(4, Math.floor((dom - 1) / 7));
    buckets[wom] += inv.amount;
    total += inv.amount;
  }
  if (total === 0) return [0.2, 0.2, 0.2, 0.2, 0.2];
  return buckets.map((b) => b / total);
}

/** Use the midpoint day of the calendar week to pick its week-of-month. */
function weekOfMonthIndex(weekStart: Date): number {
  const mid = new Date(weekStart);
  mid.setUTCDate(mid.getUTCDate() + 3);
  return Math.min(4, Math.floor((mid.getUTCDate() - 1) / 7));
}

/** Year floor: forecast basis = 2024+2025 (the two most recent complete
 *  years). 2023 was a different business stage and would skew the trend;
 *  2022 was partial. Forecast validation walks:
 *    2024 weekly → 2024 monthly → 2025 monthly (vs 2024) →
 *    2026 YTD (vs 2025) → projection.
 *  Each layer is a cross-check; the projection auto-updates as new actuals
 *  land in the sheet (LT Financials cache TTL = 60s). */
const FORECAST_YEAR_FLOOR = 2024;

/**
 * Customers explicitly excluded from the sales forecast basis.
 *
 * These are intercompany / brand-side / co-pack partners whose sales don't
 * behave like normal wholesale retail revenue:
 *   - Little Tree → Gelato : intercompany clearing (Gelato has its own
 *     cashflow row at Net 97 terms; forecasting Gelato sales separately
 *     would double-count).
 *   - Alien Brainz (and "Alien Brains" / "Alien Arainz" misspellings):
 *     brand-side bulk transactions, not retail volume.
 *   - Funk'd Up / FunkdUp / Funk'D Up: same.
 *   - Yacht Fuel: same.
 *
 * NOTE: "Only Alien Cannabis Kalamazoo" (a retail dispensary) is NOT in this
 * list - it's a normal retail customer that happens to share the word
 * "Alien". The regex is anchored against the brand markers, not the substring.
 */
const EXCLUDED_SALES_CUSTOMERS = /(?:little tree[- ]+)?(gelato|alien\s+(?:brainz|brains|arainz)\b|funk'?d?\s*up\b|(?:yacht|tacht)\s+fuel)/i;

/**
 * Bucket filters for the 3-way sales projection.
 *   - wholesale   : Little Tree non-Gelato retail/wholesale (default, current model)
 *   - privateLabel: Alien Brainz + Funk'd Up + Yacht Fuel (brand-side / co-pack)
 *   - gelato      : Little Tree Gelato line (intercompany - own AR pipeline)
 * Each bucket gets its own deseasonalized base, seasonality, scenarios.
 */
const PRIVATE_LABEL_RX = /(alien\s+(?:brainz|brains|arainz)\b|funk'?d?\s*up\b|(?:yacht|tacht)\s+fuel)/i;
const GELATO_RX = /(?:little tree[- ]+)?gelato/i;

export type SalesBucket = 'wholesale' | 'privateLabel' | 'gelato';

const BUCKET_FILTERS: Record<SalesBucket, (customer: string) => boolean> = {
  wholesale: (c: string) => !EXCLUDED_SALES_CUSTOMERS.test(c),
  privateLabel: (c: string) => PRIVATE_LABEL_RX.test(c),
  gelato: (c: string) => GELATO_RX.test(c),
};

// =====================================================================
// Weekly time-series analysis (the rigorous part of the forecast)
//
// Instead of "average the same month over 2 years and multiply by YoY",
// we decompose the actual WEEKLY history into:
//   - Trend       : linear regression on the most-recent 13 weeks (slope+intercept)
//   - Seasonality : per-week-of-year, the ratio actual/trend averaged across history
// Then each future week's forecast = extrapolated_trend × seasonal_index.
//
// This catches WoW momentum the monthly-average model would miss and respects
// the actual seasonal pattern (Apr peak, May dip, Dec spike, etc.) at week
// granularity rather than month granularity.
// =====================================================================

const TREND_BASIS_WEEKS = 13;  // last quarter drives the slope
const HISTORY_WEEKS = 78;       // ~18 months of weekly data for seasonality

/** Monday on or before `d`. */
function mondayOf(d: Date): Date {
  const day = d.getUTCDay();              // 0=Sun, 1=Mon, ...
  const shift = day === 0 ? 6 : day - 1;
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() - shift);
  r.setUTCHours(0, 0, 0, 0);
  return r;
}

function ymdOfDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** ISO week number (1..53). Simple Mon-anchored implementation. */
function isoWeekOfYear(d: Date): number {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of this week determines the ISO year+week
  const dayNum = (target.getUTCDay() + 6) % 7;     // Mon=0..Sun=6
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const diffDays = (target.getTime() - firstThursday.getTime()) / 86400000;
  return 1 + Math.round(diffDays / 7);
}

/** Build the weekly history: sum sales (after exclusions) per Mon-Sun week. */
function buildWeeklyHistory(
  invoices: SalesRecord[],
  todayUtc: Date,
  includeCustomer: (c: string) => boolean = (c) => !EXCLUDED_SALES_CUSTOMERS.test(c),
): WeeklySeriesPoint[] {
  const todayMonday = mondayOf(todayUtc);
  // Earliest week we care about: HISTORY_WEEKS back from today.
  const earliestMonday = new Date(todayMonday.getTime() - HISTORY_WEEKS * 7 * 86400000);
  const buckets = new Map<string, { total: number; count: number }>();
  for (const inv of invoices) {
    if (inv.amount <= 0) continue;
    if (!includeCustomer(inv.customer)) continue;
    if (inv.invoiceDate < earliestMonday) continue;
    if (inv.invoiceDate >= todayMonday) continue; // current incomplete week excluded
    const wkStart = mondayOf(inv.invoiceDate);
    const key = ymdOfDate(wkStart);
    const b = buckets.get(key) ?? { total: 0, count: 0 };
    b.total += inv.amount;
    b.count += 1;
    buckets.set(key, b);
  }
  // Walk every Monday in window so missing weeks show $0 (preserves trend math).
  const series: WeeklySeriesPoint[] = [];
  let cur = new Date(earliestMonday);
  while (cur < todayMonday) {
    const key = ymdOfDate(cur);
    const b = buckets.get(key) ?? { total: 0, count: 0 };
    series.push({
      weekStart: key,
      weekOfYear: isoWeekOfYear(cur),
      total: +b.total.toFixed(2),
      invoiceCount: b.count,
      isForecast: false,
    });
    cur = new Date(cur.getTime() + 7 * 86400000);
  }
  return series;
}

/** Fit y = a + b·t (OLS) on the last `n` points. */
function linearFitLastN(values: number[], n: number): { slope: number; intercept: number; r2: number } {
  const xs = values.slice(-n);
  const len = xs.length;
  if (len < 2) return { slope: 0, intercept: xs[0] ?? 0, r2: 0 };
  const ts = xs.map((_, i) => i);
  const meanT = ts.reduce((s, t) => s + t, 0) / len;
  const meanY = xs.reduce((s, y) => s + y, 0) / len;
  let num = 0, denT = 0, denY = 0;
  for (let i = 0; i < len; i++) {
    const dt = ts[i] - meanT;
    const dy = xs[i] - meanY;
    num += dt * dy;
    denT += dt * dt;
    denY += dy * dy;
  }
  const slope = denT > 0 ? num / denT : 0;
  const intercept = meanY - slope * meanT;
  const r2 = denY > 0 ? (num * num) / (denT * denY) : 0;
  return { slope, intercept, r2 };
}

/** For each ISO week-of-year (1..53), seasonal index = avg(actual / trend).
 *  Trend = 13-week centered moving average. */
function computeWeekOfYearSeasonality(series: WeeklySeriesPoint[]): Array<{ weekOfYear: number; index: number; samples: number }> {
  const windowHalf = 6;        // 13-week centered MA
  const ratios = new Map<number, number[]>();
  for (let i = windowHalf; i < series.length - windowHalf; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = i - windowHalf; j <= i + windowHalf; j++) {
      sum += series[j].total;
      cnt++;
    }
    const ma = cnt > 0 ? sum / cnt : 0;
    if (ma <= 0) continue;
    const ratio = series[i].total / ma;
    if (!Number.isFinite(ratio)) continue;
    const woy = series[i].weekOfYear;
    const arr = ratios.get(woy) ?? [];
    arr.push(ratio);
    ratios.set(woy, arr);
  }
  const out: Array<{ weekOfYear: number; index: number; samples: number }> = [];
  for (let woy = 1; woy <= 53; woy++) {
    const arr = ratios.get(woy) ?? [];
    const index = arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 1;
    out.push({ weekOfYear: woy, index: +index.toFixed(3), samples: arr.length });
  }
  return out;
}

/**
 * Full weekly analysis + forecast for the next `weeks.length` weeks.
 * Each forecast week = trend extrapolation × week-of-year seasonal index.
 */
function computeWeeklyAnalysis(
  invoices: SalesRecord[],
  weeks: Week[],
  todayUtc: Date,
  includeCustomer: (c: string) => boolean = (c) => !EXCLUDED_SALES_CUSTOMERS.test(c),
): WeeklyAnalysis {
  const history = buildWeeklyHistory(invoices, todayUtc, includeCustomer);
  const totals = history.map((h) => h.total);
  const fit = linearFitLastN(totals, TREND_BASIS_WEEKS);
  const trend = {
    slope: +fit.slope.toFixed(2),
    intercept: +fit.intercept.toFixed(2),
    r2: +fit.r2.toFixed(3),
    basisWeeks: Math.min(totals.length, TREND_BASIS_WEEKS),
  };
  const seasonality = computeWeekOfYearSeasonality(history);
  const seasonByWeek = new Map(seasonality.map((s) => [s.weekOfYear, s.index]));

  // For the trend extrapolation we treat "t" as the position in the local
  // basis window (last 13 weeks indexed 0..12). The next forecast week is
  // t = TREND_BASIS_WEEKS (one past the end).
  const forecast: WeeklySeriesPoint[] = weeks.map((w, i) => {
    const tValue = trend.intercept + trend.slope * (trend.basisWeeks + i);
    const ws = new Date(w.start + 'T00:00:00Z');
    const woy = isoWeekOfYear(ws);
    const seasonalIdx = seasonByWeek.get(woy) ?? 1;
    const value = Math.max(0, tValue * seasonalIdx);
    return {
      weekStart: w.start,
      weekOfYear: woy,
      total: +value.toFixed(2),
      invoiceCount: 0,
      isForecast: true,
    };
  });

  return { history, trend, weekOfYearSeasonality: seasonality, forecast };
}

function computeTotalLevelForecast(
  invoices: SalesRecord[],
  weeks: Week[],
  todayUtc: Date,
  globalLagCurve: number[],
  includeCustomer: (c: string) => boolean = (c) => !EXCLUDED_SALES_CUSTOMERS.test(c),
): TotalForecastResult {
  // History + forecast filter via includeCustomer predicate so callers can
  // produce per-bucket projections (wholesale / private label / gelato).
  // Default = the original non-Gelato wholesale model.
  const nonGelato = invoices.filter((inv) =>
    inv.amount > 0
    && inv.invoiceDate.getUTCFullYear() >= FORECAST_YEAR_FLOOR
    && includeCustomer(inv.customer),
  );
  // Pre-compute week-of-month weights once for the whole forecast pass.
  const womWeights = computeWeekOfMonthWeights(
    invoices.filter((inv) => inv.invoiceDate.getUTCFullYear() >= FORECAST_YEAR_FLOOR),
    includeCustomer,
  );

  // --- 1. Yearly totals ---
  const yearlyMap = new Map<string, { total: number; invoiceCount: number; monthsSeen: Set<string> }>();
  for (const inv of nonGelato) {
    const y = String(inv.invoiceDate.getUTCFullYear());
    const entry = yearlyMap.get(y) ?? { total: 0, invoiceCount: 0, monthsSeen: new Set<string>() };
    entry.total += inv.amount;
    entry.invoiceCount += 1;
    entry.monthsSeen.add(ymKey(inv.invoiceDate));
    yearlyMap.set(y, entry);
  }
  const currentYear = todayUtc.getUTCFullYear();
  const yearly: YearlyHistoryPoint[] = [...yearlyMap.entries()]
    .map(([year, e]) => ({
      year,
      total: +e.total.toFixed(2),
      invoiceCount: e.invoiceCount,
      isPartial: Number(year) >= currentYear,
      monthsObserved: e.monthsSeen.size,
    }))
    .sort((a, b) => a.year.localeCompare(b.year));

  // --- 2. Monthly series ---
  const monthlyMap = new Map<string, { total: number; invoiceCount: number }>();
  for (const inv of nonGelato) {
    const ym = ymKey(inv.invoiceDate);
    const m = monthlyMap.get(ym) ?? { total: 0, invoiceCount: 0 };
    m.total += inv.amount;
    m.invoiceCount += 1;
    monthlyMap.set(ym, m);
  }
  const monthly: MonthlyHistoryPoint[] = [...monthlyMap.entries()]
    .map(([ym, m]) => ({ ym, total: +m.total.toFixed(2), invoiceCount: m.invoiceCount }))
    .sort((a, b) => a.ym.localeCompare(b.ym));

  // --- 3. Seasonality (average across ALL complete years, not just the most recent) ---
  // More years = smoother, more robust seasonality signal. With 2024+2025
  // both available, we average each month's value across both years and
  // normalise to the 2-year per-month mean. Falls back to single-year if
  // only one complete year exists.
  const completeYears = yearly.filter((y) => !y.isPartial && y.monthsObserved >= 10);
  const seasonality: SeasonalityPoint[] = [];
  if (completeYears.length > 0) {
    const sumByMonth = new Array(12).fill(0);
    const cntByMonth = new Array(12).fill(0);
    for (const cy of completeYears) {
      for (const m of monthly) {
        if (m.ym.startsWith(cy.year + '-')) {
          const mi = Number(m.ym.split('-')[1]) - 1;
          sumByMonth[mi] += m.total;
          cntByMonth[mi] += 1;
        }
      }
    }
    const avgByMonth = sumByMonth.map((s, i) => (cntByMonth[i] > 0 ? s / cntByMonth[i] : 0));
    const grandMean = avgByMonth.reduce((s, v) => s + v, 0) / 12 || 1;
    const basisLabel = completeYears.length === 1
      ? completeYears[0].year
      : `${completeYears[0].year}-${completeYears[completeYears.length - 1].year} avg`;
    for (let i = 0; i < 12; i++) {
      const idx = grandMean > 0 ? avgByMonth[i] / grandMean : 1;
      seasonality.push({ monthOfYear: i + 1, index: +idx.toFixed(3), basisYear: basisLabel });
    }
  } else {
    for (let i = 0; i < 12; i++) {
      seasonality.push({ monthOfYear: i + 1, index: 1, basisYear: '' });
    }
  }

  // --- 4. YoY growth ---
  // Compare current YTD (completed months only) to same months prior year.
  const currentYearStr = String(currentYear);
  const priorYearStr = String(currentYear - 1);
  const currentMonth0 = todayUtc.getUTCMonth();        // 0-11, INCOMPLETE
  // Use months 0..currentMonth0-1 (i.e. fully closed months only).
  let currYTD = 0;
  let prevYTD = 0;
  let monthsCompared = 0;
  for (let m = 0; m < currentMonth0; m++) {
    const ymCurr = `${currentYearStr}-${String(m + 1).padStart(2, '0')}`;
    const ymPrev = `${priorYearStr}-${String(m + 1).padStart(2, '0')}`;
    const cv = monthlyMap.get(ymCurr)?.total ?? 0;
    const pv = monthlyMap.get(ymPrev)?.total ?? 0;
    if (cv > 0 && pv > 0) {
      currYTD += cv;
      prevYTD += pv;
      monthsCompared++;
    }
  }
  const rawRate = prevYTD > 0 ? (currYTD - prevYTD) / prevYTD : 0;
  const yoyRate = Math.max(-0.5, Math.min(1.0, rawRate));   // clamp [-50%, +100%]

  // --- 4b. YoY chain: pairwise consecutive-year growth (full years +
  // current YTD vs prev same-period). Shows whether growth accelerated or
  // decelerated over time. ---
  const chain: SalesForecastResult['yoyChain'] = [];
  for (let i = 1; i < yearly.length; i++) {
    const prev = yearly[i - 1];
    const curr = yearly[i];
    // Skip if either year is below the floor.
    if (Number(prev.year) < FORECAST_YEAR_FLOOR) continue;
    if (curr.isPartial) {
      // YTD vs same-period prior: use the YTD math we just did when this
      // is the latest pair; otherwise compute manually.
      const currMonth0 = todayUtc.getUTCMonth();
      let cAcc = 0, pAcc = 0, monthsAcc = 0;
      for (let m = 0; m < currMonth0; m++) {
        const ymC = `${curr.year}-${String(m + 1).padStart(2, '0')}`;
        const ymP = `${prev.year}-${String(m + 1).padStart(2, '0')}`;
        const cv = monthlyMap.get(ymC)?.total ?? 0;
        const pv = monthlyMap.get(ymP)?.total ?? 0;
        if (cv > 0 && pv > 0) { cAcc += cv; pAcc += pv; monthsAcc++; }
      }
      if (pAcc > 0) {
        chain.push({
          fromYear: prev.year, toYear: curr.year,
          fromValue: +pAcc.toFixed(2), toValue: +cAcc.toFixed(2),
          monthsCompared: monthsAcc, aligned: true,
          rate: +((cAcc - pAcc) / pAcc).toFixed(3),
        });
      }
    } else if (!prev.isPartial && prev.total > 0) {
      // Both years complete - simple year-over-year on totals.
      chain.push({
        fromYear: prev.year, toYear: curr.year,
        fromValue: prev.total, toValue: curr.total,
        monthsCompared: 12, aligned: true,
        rate: +((curr.total - prev.total) / prev.total).toFixed(3),
      });
    }
  }

  // --- 5. Forecast next FORECAST_HORIZON_MONTHS ---
  const horizonMonths: Array<{ year: number; month: number; ym: string }> = [];
  for (let i = 0; i < FORECAST_HORIZON_MONTHS; i++) {
    horizonMonths.push(monthAdd(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), i));
  }

  // Last 3 months of actual data (excluding partial current month) - used as
  // the safety fallback baseline if calibration can't run (e.g. very thin
  // history). The main projection no longer relies on this.
  const completedMonths = monthly.filter((m) => m.ym < ymKey(todayUtc));
  const last3 = completedMonths.slice(-3);
  const recent3Mean = last3.length > 0
    ? last3.reduce((s, m) => s + m.total, 0) / last3.length
    : 0;

  // Weekly history + trend (INFORMATIONAL only - surfaced on the Sales
  // Forecast page so the user can see recent momentum. The monthly
  // projection itself doesn't use this; it caused wild spikes when single
  // big invoices inflated a single ISO week's index 3-4×).
  const weeklyAnalysis = computeWeeklyAnalysis(nonGelato, weeks, todayUtc, includeCustomer);

  // === APPROVED PROJECTION MODEL - auto-calibrated base ===
  // Per user-approved assumption analysis (see scripts/sales-assumption-analysis.mjs).
  //
  // BASELINE is auto-calibrated each request so it stays current as new
  // months land - no more stale "$327k" hardcoded value drifting over time:
  //   1. Take the last 6 completed months of history.
  //   2. Drop the single highest and single lowest (trims outliers like the
  //      Dec 2025 $777k stocking spike or one-off slow months).
  //   3. Divide each remaining month's actual by its calendar-month
  //      seasonality index → deseasonalized monthly figures.
  //   4. Average them → the deseasonalized base.
  // This produces $327k today from Nov 25 - Apr 26 (the calibration that
  // the user approved); next month it will incorporate May's actuals
  // automatically.
  //
  // Other knobs:
  //   - Growth trend: 0% (Q1 YoY -23% offset by Apr YoY +10% recovery)
  //   - Seasonality: 2024+2025 monthly index applied per target month
  //   - Excise tax: NOT separately adjusted - already baked into baseline
  //   - Current month special: pace-based override from MTD actuals
  //   - Scenarios: Best = ×1.18, Worst = ×0.82
  const BEST_MULTIPLIER = 1.18;
  const WORST_MULTIPLIER = 0.82;
  const BASE_CALIBRATION_WINDOW = 6;

  const calibBasis = completedMonths.slice(-BASE_CALIBRATION_WINDOW);
  const calibContribs: Array<{ ym: string; actual: number; index: number; deseasonalized: number }> = [];
  for (const m of calibBasis) {
    const moIdx = Number(m.ym.split('-')[1]) - 1;
    const idx = seasonality[moIdx]?.index ?? 1;
    if (idx > 0 && m.total > 0) {
      calibContribs.push({ ym: m.ym, actual: m.total, index: idx, deseasonalized: m.total / idx });
    }
  }
  // Trim single highest + single lowest deseasonalized value to drop outliers.
  let calibKept = calibContribs;
  if (calibContribs.length >= 4) {
    const sorted = [...calibContribs].sort((a, b) => a.deseasonalized - b.deseasonalized);
    calibKept = sorted.slice(1, sorted.length - 1);
  }
  const APPROVED_DESEASON_BASE = calibKept.length > 0
    ? calibKept.reduce((s, c) => s + c.deseasonalized, 0) / calibKept.length
    : (recent3Mean > 0 ? recent3Mean : 300000);   // safety fallback
  // Calibration details exposed in API for transparency.
  const baseCalibrationMeta = {
    windowMonths: BASE_CALIBRATION_WINDOW,
    contributors: calibContribs.map((c) => ({
      ym: c.ym,
      actual: +c.actual.toFixed(0),
      seasonality: +c.index.toFixed(3),
      deseasonalized: +c.deseasonalized.toFixed(0),
      kept: calibKept.includes(c),
    })),
    deseasonalizedBase: +APPROVED_DESEASON_BASE.toFixed(0),
  };

  // Day-of-month CDF - what fraction of a month's total sales typically lands
  // by day-X of the month. Built from the last 24 months of history so we can
  // EXTRAPOLATE the current month's full-month total from its MTD actuals
  // (e.g. on May 16 with $132k invoiced, if history shows ~52% lands by day
  // 16, full-May ≈ $132k / 0.52 = $254k).
  const domBuckets = new Array(31).fill(0);
  let domTotal = 0;
  const cutoffMonth = ymKey(todayUtc);
  for (const inv of nonGelato) {
    const ym = ymKey(inv.invoiceDate);
    if (ym >= cutoffMonth) continue;        // exclude current month
    const day = inv.invoiceDate.getUTCDate(); // 1..31
    domBuckets[day - 1] += inv.amount;
    domTotal += inv.amount;
  }
  // Convert to cumulative fraction. Pad to 31 days.
  const domCdf = new Array(31).fill(1);
  if (domTotal > 0) {
    let cum = 0;
    for (let i = 0; i < 31; i++) {
      cum += domBuckets[i] / domTotal;
      domCdf[i] = cum;
    }
    // Force last day = 1.0 to handle rounding.
    domCdf[30] = 1;
  }

  // Current month actuals - used to override the stat-anchor with a value
  // grounded in what's already been invoiced.
  const currentYm = cutoffMonth;
  const currentMtd = monthlyMap.get(currentYm)?.total ?? 0;
  const todayDay = todayUtc.getUTCDate();
  const daysInCurrMonth = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth() + 1, 0)).getUTCDate();
  const pctCompletedExpected = domCdf[Math.max(0, Math.min(30, todayDay - 1))];

  const monthlyForecast: ForecastMonthRow[] = [];
  const monthlyForecastBest: ForecastMonthRow[] = [];
  const monthlyForecastWorst: ForecastMonthRow[] = [];
  for (const h of horizonMonths) {
    const seasonalIdx = seasonality[h.month]?.index ?? 1;
    let baseValue: number;
    let methodLabel: ForecastMonthRow['method'];

    if (h.ym === currentYm && currentMtd > 0) {
      // Current month override: pace-based extrapolation from MTD actuals.
      // For May 16 with $132k invoiced this gives ~$256k full-month, which
      // is what the user asked us to honour (pace over biased seasonality).
      const paceFullMonth = pctCompletedExpected > 0.02
        ? currentMtd / pctCompletedExpected
        : currentMtd * (daysInCurrMonth / Math.max(1, todayDay));
      baseValue = Math.max(currentMtd, paceFullMonth);
      methodLabel = 'baseline-x-seasonal';   // pace-based; label kept for type compat
    } else {
      // Approved methodology: deseasonalized base × seasonality index.
      baseValue = APPROVED_DESEASON_BASE * seasonalIdx;
      methodLabel = 'baseline-x-seasonal';
    }
    if (baseValue < 0) baseValue = 0;

    const bestValue = baseValue * BEST_MULTIPLIER;
    let worstValue = baseValue * WORST_MULTIPLIER;
    // Current-month worst case still cannot be below what's already invoiced.
    if (h.ym === currentYm && worstValue < currentMtd) worstValue = currentMtd;

    const rowCommon = {
      ym: h.ym,
      method: methodLabel,
      priorYearValue: null,
      yoyMultiplier: null,
      seasonalIndex: seasonalIdx,
      clamped: null,
    } as const;
    monthlyForecast.push({ ...rowCommon, forecastedSales: +baseValue.toFixed(2) });
    monthlyForecastBest.push({ ...rowCommon, forecastedSales: +bestValue.toFixed(2) });
    monthlyForecastWorst.push({ ...rowCommon, forecastedSales: +worstValue.toFixed(2) });
  }

  // --- 6. Distribute each forecast month's value to weeks + apply lag curve ---
  // For each forecast month F and each lag bucket L, the lag-L cash lands in
  // calendar month (F + L). Within that target month, distribute the cash
  // across its weeks using the HISTORICAL week-of-month weight pattern
  // (real businesses are lumpy - month-end + month-start tend to be heavier
  // than mid-month). If a target month has only some of its weeks inside
  // our 13-week window, weights are renormalised over the visible subset.
  function distributeMonthlyToWeeks(monthly: ForecastMonthRow[]): number[] {
    const inflow = new Array(weeks.length).fill(0);
    for (const mf of monthly) {
      const [yr, mo] = mf.ym.split('-').map(Number);
      const fcMonthYear = yr, fcMonthIdx = mo - 1;
      for (let lag = 0; lag <= MAX_LAG_MONTHS; lag++) {
        const lagPct = globalLagCurve[lag] ?? 0;
        if (lagPct <= 0) continue;
        const cashAmount = mf.forecastedSales * lagPct;
        const targetMonthIdx = fcMonthIdx + lag;
        const targetYear = fcMonthYear + Math.floor(targetMonthIdx / 12);
        const targetMonth = ((targetMonthIdx % 12) + 12) % 12;
        const wInTargetMonth = weeksInMonth(targetYear, targetMonth, weeks);
        if (wInTargetMonth.length === 0) continue;
        const womForEach = wInTargetMonth.map((wIdx) =>
          weekOfMonthIndex(new Date(weeks[wIdx].start + 'T00:00:00Z')),
        );
        const rawWeights = womForEach.map((wom) => womWeights[wom] ?? 0);
        const weightSum = rawWeights.reduce((s, w) => s + w, 0);
        if (weightSum > 0) {
          for (let i = 0; i < wInTargetMonth.length; i++) {
            const share = rawWeights[i] / weightSum;
            inflow[wInTargetMonth[i]] += cashAmount * share;
          }
        } else {
          const perWeek = cashAmount / wInTargetMonth.length;
          for (const wIdx of wInTargetMonth) inflow[wIdx] += perWeek;
        }
      }
    }
    for (let i = 0; i < inflow.length; i++) inflow[i] = +inflow[i].toFixed(2);
    return inflow;
  }
  const weeklyInflow = distributeMonthlyToWeeks(monthlyForecast);
  const weeklyInflowBest = distributeMonthlyToWeeks(monthlyForecastBest);
  const weeklyInflowWorst = distributeMonthlyToWeeks(monthlyForecastWorst);

  return {
    yearly,
    monthly,
    seasonality,
    yoy: {
      rate: +yoyRate.toFixed(3),
      rawRate: +rawRate.toFixed(3),
      currYearLabel: currentYearStr,
      prevYearLabel: priorYearStr,
      monthsCompared,
      currYTD: +currYTD.toFixed(2),
      prevYTD: +prevYTD.toFixed(2),
    },
    yoyChain: chain,
    weeklyAnalysis,
    monthlyForecast,
    monthlyForecastBest,
    monthlyForecastWorst,
    weeklyInflow,
    weeklyInflowBest,
    weeklyInflowWorst,
    totalForecastedInvoice: +monthlyForecast.reduce((s, m) => s + m.forecastedSales, 0).toFixed(2),
    totalProjectedCash: +weeklyInflow.reduce((s, v) => s + v, 0).toFixed(2),
    totalForecastedInvoiceBest: +monthlyForecastBest.reduce((s, m) => s + m.forecastedSales, 0).toFixed(2),
    totalProjectedCashBest: +weeklyInflowBest.reduce((s, v) => s + v, 0).toFixed(2),
    totalForecastedInvoiceWorst: +monthlyForecastWorst.reduce((s, m) => s + m.forecastedSales, 0).toFixed(2),
    totalProjectedCashWorst: +weeklyInflowWorst.reduce((s, v) => s + v, 0).toFixed(2),
    deseasonalizedBase: +APPROVED_DESEASON_BASE.toFixed(0),
    baseCalibration: baseCalibrationMeta,
  };
}

export async function getSalesForecast(weeks: Week[]): Promise<SalesForecastResult> {
  const warnings: string[] = [];
  if (weeks.length === 0) return emptyResult(weeks, warnings);

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  let tracker;
  try {
    tracker = await getInvoiceTracker();
  } catch (e) {
    warnings.push(`Invoice Tracker fetch failed (${e instanceof Error ? e.message : '?'}) - sales forecast = 0.`);
    return emptyResult(weeks, warnings);
  }

  // Build the lookback window of months we'll fit the trend on.
  const lookbackWindow: Array<{ year: number; month: number; ym: string }> = [];
  for (let i = LOOKBACK_MONTHS - 1; i >= 0; i--) {
    lookbackWindow.push(monthAdd(today.getUTCFullYear(), today.getUTCMonth(), -i - 1));
  }

  // Identify ALL distinct non-Gelato brands seen.
  // Brand-level exclusion: drop any brand whose NAME matches the excluded
  // customers regex (Alien Brainz, Funk'd Up, Yacht Fuel) - the Invoice
  // Tracker brand column shows these as brand names, so they sneak into
  // the per-brand list even though their customer rows are excluded from
  // the total forecast. Apply the same regex at the brand-name level.
  const seenBrands = new Map<string, { lastInvoiceDate: Date; brandKey: string }>();
  for (const inv of tracker.invoices) {
    if (channelOf(inv.customer) === 'Gelato') continue;
    if (EXCLUDED_SALES_CUSTOMERS.test(inv.customer)) continue;
    const b = inv.brand || channelOf(inv.customer);
    if (!b || b === '(unknown)') continue;
    if (EXCLUDED_SALES_CUSTOMERS.test(b)) continue;       // brand-name match
    const prev = seenBrands.get(b);
    if (!prev || inv.invoiceDate > prev.lastInvoiceDate) {
      seenBrands.set(b, { lastInvoiceDate: inv.invoiceDate, brandKey: b });
    }
  }

  // Compute tier for every brand based on days since last invoice. No hard
  // exclusion - even silent brands stay in (just at a discounted weight) so
  // we don't zero out customers who reorder every 4-6 months.
  const allBrands = [...seenBrands.values()];
  const churnedBrandsList: SalesForecastResult['churnedBrands'] = [];

  const globalLag = buildGlobalLagCurve(tracker.invoices);

  // Forecast horizon months.
  const horizonMonths: Array<{ year: number; month: number; ym: string }> = [];
  for (let i = 0; i < FORECAST_HORIZON_MONTHS; i++) {
    horizonMonths.push(monthAdd(today.getUTCFullYear(), today.getUTCMonth(), i));
  }

  const weeklyInflow = new Array(weeks.length).fill(0);
  const brandForecasts: BrandForecast[] = [];
  const monthlyForecastMap = new Map<string, number>();
  let totalForecastedSales = 0;

  for (const brandInfo of allBrands) {
    const brand = brandInfo.brandKey;
    const daysSince = Math.floor((todayUtc.getTime() - brandInfo.lastInvoiceDate.getTime()) / MS_PER_DAY);
    const tier = tierForDaysSince(daysSince);

    // Churned: keep them visible but skip the trend math entirely.
    if (tier.weight === 0) {
      churnedBrandsList.push({
        brand,
        lastInvoiceDate: ymdOf(brandInfo.lastInvoiceDate),
        daysSinceLastInvoice: daysSince,
      });
      continue;
    }

    const series = brandMonthlySeries(tracker.invoices, brand, lookbackWindow);
    const monthsWithData = series.filter((v) => v > 0).length;
    if (monthsWithData < 1) continue;

    // Cadence + collection-health stats over the lookback window. These
    // surface "what's actually been coming in" so the user can sanity-check
    // the forecast against real activity.
    let invoiceCount = 0;
    let invoicedSum = 0;
    let paidSum = 0;
    const lookbackStartMs = todayUtc.getTime() - LOOKBACK_MONTHS * 30 * MS_PER_DAY;
    const ninetyDaysAgoMs = todayUtc.getTime() - 90 * MS_PER_DAY;
    const oneEightyDaysAgoMs = todayUtc.getTime() - 180 * MS_PER_DAY;
    let recent90Sum = 0;
    let prior90Sum = 0;
    let sheetSourceCount = 0;
    let derivedSourceCount = 0;
    for (const inv of tracker.invoices) {
      if (channelOf(inv.customer) === 'Gelato') continue;
      if ((inv.brand || channelOf(inv.customer)) !== brand) continue;
      const t = inv.invoiceDate.getTime();
      if (t < lookbackStartMs) continue;
      invoiceCount++;
      invoicedSum += inv.amount;
      paidSum += inv.paid;
      if (t >= ninetyDaysAgoMs) recent90Sum += inv.amount;
      else if (t >= oneEightyDaysAgoMs) prior90Sum += inv.amount;
      if (inv.brandSource === 'sheet') sheetSourceCount++;
      else derivedSourceCount++;
    }
    const brandSource: BrandForecast['brandSource'] = derivedSourceCount === 0
      ? 'sheet'
      : sheetSourceCount === 0 ? 'derived' : 'mixed';
    const invoicesPerActiveMonth = +(invoiceCount / Math.max(1, monthsWithData)).toFixed(2);
    const paidRatio = invoicedSum > 0 ? +(paidSum / invoicedSum).toFixed(3) : 0;
    const momentumDeltaPct = prior90Sum > 0
      ? +(((recent90Sum - prior90Sum) / prior90Sum) * 100).toFixed(1)
      : (recent90Sum > 0 ? null : 0);  // null = uncomputable (no prior baseline)

    // Linear-fit stats are kept for INFORMATIONAL display (R², slope as
    // monthly $-delta) but the actual forecast uses cadence-driven per-invoice
    // projection below - that respects reorder rhythm + seasonality, where
    // the old monthly OLS just gave flat numbers for sparse brands and got
    // clamped to bounds for spiky ones.
    let baselineMonthly: number;
    let slope = 0;
    let r2 = 0;
    if (monthsWithData >= 3) {
      const fit = linearFit(series);
      slope = fit.b;
      r2 = fit.r2;
      const last3 = series.slice(-3);
      baselineMonthly = last3.reduce((s, v) => s + v, 0) / 3;
    } else {
      baselineMonthly = series.filter((v) => v > 0).reduce((s, v) => s + v, 0) / Math.max(1, monthsWithData);
    }
    const maxHistory = Math.max(...series, 0);
    // Bounds are now informational only - no clamping applied to forecast.
    const lowerBound = maxHistory * 0.3;
    const upperBound = maxHistory * 2.0;

    const brandLag = buildLagCurve(tracker.invoices, brand);
    const lagSum = brandLag.reduce((s, v) => s + v, 0);
    const useBrandLag = lagSum > 0.3;
    const lagCurve = useBrandLag ? brandLag : globalLag;

    // --- DEPTH ANALYSIS: cadence + seasonality + growth ---
    const sortedInvs = gatherBrandInvoices(tracker.invoices, brand, lookbackStartMs);
    const cadence = computeCadence(sortedInvs, todayUtc.getTime());
    const seasonality = computeSeasonality(sortedInvs);
    const growthMult = computeGrowth(sortedInvs, todayUtc.getTime());

    // Project future invoices walking forward at cadence intervals. We need
    // enough horizon to cover (last forecast month + max lag) so the lag-curve
    // can produce cash arrivals throughout the 13-week window.
    const horizonDaysAhead = (FORECAST_HORIZON_MONTHS + MAX_LAG_MONTHS) * 31;
    const projected = projectInvoices(cadence, growthMult, seasonality, tier.weight, horizonDaysAhead);

    // Cash distribution: each PROJECTED INVOICE is lagged individually by the
    // lag curve. For lag 0 the cash lands the invoice week; for lag k it lands
    // k months later. This produces non-uniform weekly cash for brands with
    // quarterly cadence (their cash arrives in spikes, not smoothed mush).
    const weeklyInflowBrand = new Array(weeks.length).fill(0);
    for (const pi of projected) {
      for (let lag = 0; lag <= MAX_LAG_MONTHS; lag++) {
        const lagAmount = pi.amount * (lagCurve[lag] ?? 0);
        if (lagAmount <= 0.01) continue;
        // Place lag-k cash at (invoice_date + k months). Find the week index.
        const cashDate = new Date(Date.UTC(
          pi.date.getUTCFullYear(),
          pi.date.getUTCMonth() + lag,
          pi.date.getUTCDate(),
        ));
        const wIdx = weekIndexFor(cashDate, weeks);
        if (wIdx < 0) continue;
        weeklyInflow[wIdx] += lagAmount;
        weeklyInflowBrand[wIdx] += lagAmount;
      }
    }

    // Monthly forecast (per horizon month) = sum of projected invoice amounts
    // whose issue date falls in that month.
    const forecast: BrandForecast['forecast'] = horizonMonths.map((hm) => {
      const sum = projected
        .filter((p) => p.ym === hm.ym)
        .reduce((s, p) => s + p.amount, 0);
      totalForecastedSales += sum;
      monthlyForecastMap.set(hm.ym, (monthlyForecastMap.get(hm.ym) ?? 0) + sum);
      return { ym: hm.ym, amount: +sum.toFixed(2) };
    });

    // Recent invoices for the page drilldown (most recent 12).
    const recentInvoices = sortedInvs
      .slice(-12)
      .map((i) => ({ date: ymdOf(i.date), amount: +i.amount.toFixed(2) }));

    brandForecasts.push({
      brand,
      brandSource,
      monthsObserved: monthsWithData,
      invoiceCount,
      invoicesPerActiveMonth,
      momentum90d: {
        recent: +recent90Sum.toFixed(2),
        prior: +prior90Sum.toFixed(2),
        deltaPct: momentumDeltaPct,
      },
      paidRatio,
      baselineMonthly: +baselineMonthly.toFixed(2),
      trendSlope: +slope.toFixed(2),
      r2: +r2.toFixed(3),
      bounds: { lower: +lowerBound.toFixed(2), upper: +upperBound.toFixed(2) },
      clamped: false,  // no longer clamping
      daysSinceLastInvoice: daysSince,
      activityTier: tier.name,
      recencyWeight: tier.weight,
      history: lookbackWindow.map((w, idx) => ({ ym: w.ym, amount: +series[idx].toFixed(2) })),
      forecast,
      lagCurve: lagCurve.map((v) => +v.toFixed(4)),
      lagSource: useBrandLag ? 'brand' : 'global',
      weeklyInflow: weeklyInflowBrand.map((v) => +v.toFixed(2)),
      totalProjectedCash: +weeklyInflowBrand.reduce((s, v) => s + v, 0).toFixed(2),
      lastInvoiceDate: ymdOf(brandInfo.lastInvoiceDate),
      // Depth-analysis fields
      cadenceDays: cadence.medianGapDays,
      avgInvoiceAmount: cadence.avgInvoiceAmount,
      nextExpectedDate: cadence.nextExpectedMs > 0 ? ymdOf(new Date(cadence.nextExpectedMs)) : '',
      growthMultiplier: +growthMult.toFixed(3),
      seasonalIndices: seasonality.indices.map((v) => +v.toFixed(3)),
      hasSeasonality: seasonality.hasSeasonality,
      projectedInvoices: projected.map((p) => ({
        date: ymdOf(p.date),
        amount: p.amount,
        ym: p.ym,
        monthOfYear: p.monthOfYear,
      })),
      recentInvoices,
      gapDays: cadence.gapDays,
    });
  }

  for (let i = 0; i < weeklyInflow.length; i++) weeklyInflow[i] = +weeklyInflow[i].toFixed(2);
  // Sort by 13-week cash so the brands driving the forecast surface first.
  brandForecasts.sort((a, b) => b.totalProjectedCash - a.totalProjectedCash);

  // === v2: multi-level total forecast - sourced from LT Financials sheet ===
  // (User direction: the lender-facing sales forecast should anchor on the
  // Little Tree Financials ledger, the company's invoice source-of-truth.
  // Brand-level details above stay on Invoice Tracker since LT Financials
  // doesn't carry a Brand column.)
  let totalLevelSource: SalesRecord[] = tracker.invoices;
  let ltFinInvoices: LtFinancialsInvoice[] | null = null;
  try {
    const ltFin = await getLtFinancialsSales();
    ltFinInvoices = ltFin.invoices;
    totalLevelSource = ltFin.invoices.map((r) => ({
      invoiceDate: r.invoiceDate,
      amount: r.amount,
      customer: r.customer,
    }));
  } catch (e) {
    warnings.push(`LT Financials fetch failed (${e instanceof Error ? e.message : '?'}) - falling back to Invoice Tracker for total-level forecast.`);
  }
  const totalLevel = computeTotalLevelForecast(totalLevelSource, weeks, todayUtc, globalLag, BUCKET_FILTERS.wholesale);

  // === 3-bucket projection: wholesale + private label + gelato ===
  // Each bucket runs the same auto-calibrated model on its own customer slice.
  // Wholesale = totalLevel (reused so we don't double-compute the default).
  function makeBucket(b: SalesBucket, label: string, src: SalesRecord[], r: TotalForecastResult): BucketForecast {
    const customers = new Set<string>();
    for (const inv of src) {
      if (inv.amount > 0 && BUCKET_FILTERS[b](inv.customer)) customers.add(inv.customer);
    }
    return {
      bucket: b,
      label,
      customerCount: customers.size,
      yearlyHistory: r.yearly,
      monthlyHistory: r.monthly,
      seasonality: r.seasonality,
      yoy: r.yoy,
      yoyChain: r.yoyChain,
      weeklyAnalysis: r.weeklyAnalysis,
      monthlyForecast: r.monthlyForecast,
      monthlyForecastBest: r.monthlyForecastBest,
      monthlyForecastWorst: r.monthlyForecastWorst,
      weeklyInflow: r.weeklyInflow,
      weeklyInflowBest: r.weeklyInflowBest,
      weeklyInflowWorst: r.weeklyInflowWorst,
      scenarioTotals: {
        base: { invoiced: r.totalForecastedInvoice, cash: r.totalProjectedCash },
        best: { invoiced: r.totalForecastedInvoiceBest, cash: r.totalProjectedCashBest },
        worst: { invoiced: r.totalForecastedInvoiceWorst, cash: r.totalProjectedCashWorst },
      },
      deseasonalizedBase: r.deseasonalizedBase,
      baseCalibration: r.baseCalibration,
    };
  }
  const privateLabelLevel = computeTotalLevelForecast(totalLevelSource, weeks, todayUtc, globalLag, BUCKET_FILTERS.privateLabel);
  const gelatoLevel = computeTotalLevelForecast(totalLevelSource, weeks, todayUtc, globalLag, BUCKET_FILTERS.gelato);
  const buckets = {
    wholesale: makeBucket('wholesale', 'Little Tree', totalLevelSource, totalLevel),
    privateLabel: makeBucket('privateLabel', 'Private Label / Co-pack', totalLevelSource, privateLabelLevel),
    gelato: makeBucket('gelato', 'Little Tree Gelato', totalLevelSource, gelatoLevel),
  };

  // Customer-cohort projection (LT Financials, per-customer reorder cycle).
  // Runs in parallel to the statistical anchor above; the UI shows both so
  // the user can compare top-down vs bottom-up.
  let cohortForecast: CohortForecastResult | null = null;
  if (ltFinInvoices) {
    cohortForecast = computeCustomerCohortForecast(ltFinInvoices, {
      asOf: todayUtc,
      horizonWeeks: weeks.length,
      horizonMonths: FORECAST_HORIZON_MONTHS,
      excludeCustomer: (name) => EXCLUDED_SALES_CUSTOMERS.test(name),
    });
  }

  return {
    asOf: new Date().toISOString(),
    driver: {
      lookbackMonths: LOOKBACK_MONTHS,
      forecastHorizonMonths: FORECAST_HORIZON_MONTHS,
      maxLagMonths: MAX_LAG_MONTHS,
      tiers: ACTIVITY_TIERS.map((t) => ({ name: t.name, maxDays: t.maxDays, weight: t.weight })),
    },
    yearlyHistory: totalLevel.yearly,
    monthlyHistory: totalLevel.monthly,
    seasonality: totalLevel.seasonality,
    yoy: totalLevel.yoy,
    yoyChain: totalLevel.yoyChain,
    weeklyAnalysis: totalLevel.weeklyAnalysis,
    monthlyForecastV2: totalLevel.monthlyForecast,
    monthlyForecastBest: totalLevel.monthlyForecastBest,
    monthlyForecastWorst: totalLevel.monthlyForecastWorst,
    weeklyInflowV2: totalLevel.weeklyInflow,
    weeklyInflowBest: totalLevel.weeklyInflowBest,
    weeklyInflowWorst: totalLevel.weeklyInflowWorst,
    totalForecastedInvoiceV2: totalLevel.totalForecastedInvoice,
    totalProjectedCashV2: totalLevel.totalProjectedCash,
    scenarioTotals: {
      base: { invoiced: totalLevel.totalForecastedInvoice, cash: totalLevel.totalProjectedCash },
      best: { invoiced: totalLevel.totalForecastedInvoiceBest, cash: totalLevel.totalProjectedCashBest },
      worst: { invoiced: totalLevel.totalForecastedInvoiceWorst, cash: totalLevel.totalProjectedCashWorst },
    },
    approvedAssumptions: {
      deseasonalizedBase: totalLevel.deseasonalizedBase,
      bestMultiplier: 1.18,
      worstMultiplier: 0.82,
      growthTrend: 0,
      excisetaxNote: 'Excise tax (24%) impact already baked into post-Jan-2026 baseline; -14.2% observed YoY drag',
      calibration: totalLevel.baseCalibration,
    },
    lookbackWindow: lookbackWindow.map((w) => w.ym),
    horizonMonths: horizonMonths.map((w) => w.ym),
    weeks: weeks.map((w, i) => ({ index: i, start: w.start, end: w.end, label: w.label ?? w.start.slice(5) })),
    globalLagCurve: globalLag.map((v) => +v.toFixed(4)),
    brands: brandForecasts,
    churnedBrands: churnedBrandsList,
    weeklyInflow,
    monthlyForecast: [...monthlyForecastMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ym, amount]) => ({ ym, amount: +amount.toFixed(2) })),
    totalForecastedSales: +totalForecastedSales.toFixed(2),
    totalProjectedCash: +weeklyInflow.reduce((s, v) => s + v, 0).toFixed(2),
    cohortForecast,
    buckets,
    warnings,
  };
}
