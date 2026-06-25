/**
 * Little Tree AR COLLECTIONS history — month × year grid + seasonality, built
 * from LT Financials paid history (non-Gelato, by PAID date). This is the "kitna
 * AR wapas aata hai" trend that the AR projection rests on — the AR-side mirror
 * of the Sales Projection page's monthly/yearly view. All live from the sheet.
 */
import { getLtFinancialsSales } from './ltFinancialsSales.js';

export type ArCollectionsHistory = {
  asOf: string;
  years: number[];
  /** grid[monthIndex 0-11] = { [year]: dollars collected that month } */
  grid: Array<Record<number, number>>;
  yearTotals: Record<number, number>;
  /** Seasonality from COMPLETED months only (avoids partial-month distortion). */
  seasonality: Array<{ month: number; index: number; avg: number }>;
  overallMonthlyAvg: number;
  /** Recent run-rate from the last 6 completed months (what the projection should lean on). */
  recentMonthlyAvg: number;
  recentWeeklyAvg: number;
  /** Collection LAG CURVE: share of $ collected wk0 (same week invoiced), +1, … +12.
   *  "invoice banne ke baad kis week me kitna paisa aata hai" — the week-wise timing
   *  that drives the 13-week projection. From LT Financials paid history (last 12mo). */
  lagCurve: number[];
  /** Cumulative version of lagCurve (how much is collected BY week k). */
  lagCumulative: number[];
  /** Measured recovery (paid ÷ resolved) by aging band — the empirical collectibility
   *  the projection haircuts by. ~100% fresh, ~84% for 180+; write-off rate ~0.4%. */
  recoveryBands: Array<{ bucket: string; recovery: number; paid: number; writeOff: number; n: number }>;
};

let _cache: { at: number; data: ArCollectionsHistory } | null = null;
const TTL_MS = 10 * 60 * 1000;
// Trend base: 2024 onwards only. 2022-2023 were the startup/ramp years (tiny +
// not representative) and distort the seasonality. User: "2024 aur 2025 ka lo".
const MIN_YEAR = 2024;

export async function getArCollectionsHistory(): Promise<ArCollectionsHistory> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.data;
  const lt = await getLtFinancialsSales();
  const grid: Array<Record<number, number>> = Array.from({ length: 12 }, () => ({}));
  const yearTotals: Record<number, number> = {};
  const yearsSet = new Set<number>();
  for (const inv of lt.invoices) {
    if (inv.paid <= 0 || !inv.paidDate || inv.channel === 'Gelato') continue;
    const y = inv.paidDate.getUTCFullYear();
    if (y < MIN_YEAR) continue;                            // drop pre-2024 ramp years
    const m = inv.paidDate.getUTCMonth();
    grid[m][y] = +((grid[m][y] ?? 0) + inv.paid).toFixed(2);
    yearTotals[y] = +((yearTotals[y] ?? 0) + inv.paid).toFixed(2);
    yearsSet.add(y);
  }
  const years = [...yearsSet].sort((a, b) => a - b);

  // Seasonality from COMPLETED months only (skip the current + future months of
  // the current year, which are partial and would understate).
  const now = new Date();
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth();
  const monthAvg: number[] = new Array(12).fill(0);
  let grand = 0, cnt = 0;
  for (let m = 0; m < 12; m++) {
    let s = 0, c = 0;
    for (const y of years) {
      if (y > curY || (y === curY && m >= curM)) continue;   // not yet complete
      const v = grid[m][y];
      if (v && v > 0) { s += v; c++; }
    }
    monthAvg[m] = c ? s / c : 0;
    if (c) { grand += s; cnt += c; }
  }
  const overallMonthlyAvg = cnt ? grand / cnt : 0;
  const seasonality = monthAvg.map((avg, month) => ({
    month,
    avg: +avg.toFixed(2),
    index: overallMonthlyAvg > 0 && avg > 0 ? +(avg / overallMonthlyAvg).toFixed(2) : 0,
  }));

  // Recent run-rate = last 6 COMPLETED months (chronological).
  const completed: number[] = [];
  outer: for (let y = curY; y >= (years[0] ?? curY); y--) {
    for (let m = 11; m >= 0; m--) {
      if (y === curY && m >= curM) continue;
      if (!grid[m][y]) continue;
      completed.push(grid[m][y]);
      if (completed.length >= 6) break outer;
    }
  }
  const recentMonthlyAvg = completed.length ? completed.reduce((a, b) => a + b, 0) / completed.length : 0;

  // Collection lag curve (week-wise timing) — reuse the empirical curve the cashflow uses.
  let lagCurve: number[] = [];
  let lagCumulative: number[] = [];
  try {
    const { getCollectionLagCurve } = await import('./snapshotActuals.js');
    lagCurve = (await getCollectionLagCurve()).map((v) => +v.toFixed(4));
    let c = 0;
    lagCumulative = lagCurve.map((v) => { c += v; return +c.toFixed(4); });
  } catch { /* leave empty on failure */ }

  // Measured collectibility (recovery) by aging band.
  let recoveryBands: ArCollectionsHistory['recoveryBands'] = [];
  try {
    const { getRecoveryByBand } = await import('./arDashboardOpen.js');
    recoveryBands = (await getRecoveryByBand()).bands;
  } catch { /* leave empty on failure */ }

  const data: ArCollectionsHistory = {
    asOf: now.toISOString(),
    years,
    grid,
    yearTotals,
    seasonality,
    overallMonthlyAvg: +overallMonthlyAvg.toFixed(2),
    recentMonthlyAvg: +recentMonthlyAvg.toFixed(2),
    recentWeeklyAvg: +(recentMonthlyAvg / 4.33).toFixed(2),
    lagCurve,
    lagCumulative,
    recoveryBands,
  };
  _cache = { at: Date.now(), data };
  return data;
}
