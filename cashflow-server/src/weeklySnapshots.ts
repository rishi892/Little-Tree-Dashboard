/**
 * Weekly cashflow snapshots - frozen state captured each Monday.
 *
 * Why this exists: the user wants the "Past Weeks" tab to show what we
 * ACTUALLY predicted at the time, not a recomputation. Forecasts are
 * forward-looking; once a week passes, the inputs change (invoices flip
 * paid, sales reset, opening cash moves). A snapshot freezes the Wk1 row
 * of the 13-week schedule at the moment it was the "live" Wk 1, so we can
 * compute variance later (forecast vs. actual cash that arrived).
 *
 * Capture model:
 *   - Lazy + idempotent. Every call to getCashflow13Week(future) triggers
 *     captureSnapshotIfNeeded(). If today's Monday-bucket already has a
 *     snapshot, it's a no-op; otherwise we write one.
 *   - Keyed by Monday YMD (e.g. "2026-05-11"). One snapshot per week max.
 *   - Once written, a snapshot is NEVER overwritten (force=true override
 *     for admin). The original forecast is the historical artifact.
 *
 * Read model:
 *   - listSnapshots() returns ALL stored snapshots (sorted desc by Monday).
 *   - getSnapshot(monday) returns a specific Monday's snapshot.
 *   - Past-Weeks UI iterates over the trailing N snapshots and pairs each
 *     with the actuals computed now (from Invoice Tracker payments etc.)
 *     to show variance.
 *
 * Storage: server/.weekly-snapshots.json - durable, survives restarts.
 */

import { dbSelect, dbSelectOne, dbUpsert, dbDelete } from './db.js';

export type SnapshotLineItem = {
  label: string;
  /** Forecast cash amount for the snapshot's Wk1 (when this snapshot was taken). */
  wk1Value: number;
  /** 13-week total at the time of capture. */
  total13w: number;
};

export type WeeklySnapshot = {
  /** Monday YMD - unique snapshot key. */
  monday: string;
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Opening cash for the snapshot's Wk1 (= cash at Monday). */
  openingCash: number;
  /** Forecast Wk1 inflow lines (label → value). */
  inflows: SnapshotLineItem[];
  /** Forecast Wk1 outflow lines (label → value). */
  outflows: SnapshotLineItem[];
  /** Forecast Wk1 totals. */
  totalInflowWk1: number;
  totalOutflowWk1: number;
  netChangeWk1: number;
  closingCashWk1: number;
  /** AR projection sum across 13 weeks (reconcile plan vs actual). */
  arProjection13wTotal: number;
  /** Sales forecast Wk1 (non-Gelato projection arm). */
  salesForecastWk1: number;
  /** Sales forecast 13w total. */
  salesForecast13wTotal: number;
};

type Row = {
  monday: string; captured_at: string; opening_cash: number;
  total_inflow_wk1: number; total_outflow_wk1: number; net_change_wk1: number; closing_cash_wk1: number;
  ar_projection_13w_total: number; sales_forecast_wk1: number; sales_forecast_13w_total: number;
  inflows: SnapshotLineItem[]; outflows: SnapshotLineItem[];
};
function toSnap(r: Row): WeeklySnapshot {
  return {
    monday: r.monday, capturedAt: r.captured_at, openingCash: Number(r.opening_cash),
    inflows: r.inflows ?? [], outflows: r.outflows ?? [],
    totalInflowWk1: Number(r.total_inflow_wk1), totalOutflowWk1: Number(r.total_outflow_wk1),
    netChangeWk1: Number(r.net_change_wk1), closingCashWk1: Number(r.closing_cash_wk1),
    arProjection13wTotal: Number(r.ar_projection_13w_total), salesForecastWk1: Number(r.sales_forecast_wk1),
    salesForecast13wTotal: Number(r.sales_forecast_13w_total),
  };
}
function toRow(s: WeeklySnapshot): Record<string, unknown> {
  return {
    monday: s.monday, captured_at: s.capturedAt, opening_cash: s.openingCash,
    total_inflow_wk1: s.totalInflowWk1, total_outflow_wk1: s.totalOutflowWk1,
    net_change_wk1: s.netChangeWk1, closing_cash_wk1: s.closingCashWk1,
    ar_projection_13w_total: s.arProjection13wTotal, sales_forecast_wk1: s.salesForecastWk1,
    sales_forecast_13w_total: s.salesForecast13wTotal, inflows: s.inflows, outflows: s.outflows,
  };
}

/** Return all snapshots, sorted by Monday descending (newest first). */
export async function listSnapshots(): Promise<WeeklySnapshot[]> {
  const rows = await dbSelect<Row>('weekly_snapshots', 'order=monday.desc');
  return rows.map(toSnap);
}

export async function getSnapshot(monday: string): Promise<WeeklySnapshot | null> {
  const row = await dbSelectOne<Row>('weekly_snapshots', `monday=eq.${encodeURIComponent(monday)}`);
  return row ? toSnap(row) : null;
}

/**
 * Persist a snapshot for the given Monday. Idempotent: if a snapshot exists for
 * this Monday, returns without overwriting (the original forecast is the
 * historical artifact). Force = true overrides.
 */
export async function captureSnapshotIfNeeded(snap: WeeklySnapshot, opts: { force?: boolean } = {}): Promise<{ wrote: boolean; reason: string }> {
  if (!opts.force && (await getSnapshot(snap.monday))) {
    return { wrote: false, reason: 'already captured for this Monday' };
  }
  await dbUpsert('weekly_snapshots', toRow(snap));
  return { wrote: true, reason: opts.force ? 'forced overwrite' : 'new snapshot' };
}

/**
 * The per-account make-up of a Monday's opening cash (Checking, BMM, PureX bank,
 * Due From PureX). weekly_snapshots stores only the opening TOTAL, so the
 * breakdown is parked in the generic qb_cache table keyed by Monday — this lets
 * the 13-week opening drill show the same 4 accounts FROZEN at their Monday
 * values, instead of a single collapsed row.
 */
export type OpeningBreakdownItem = { label: string; amount: number; sub?: string };
const openingBdKey = (monday: string) => `opening-breakdown:${monday}`;

export async function getOpeningBreakdown(monday: string): Promise<OpeningBreakdownItem[] | null> {
  try {
    const row = await dbSelectOne<{ data: OpeningBreakdownItem[] }>('qb_cache', `key=eq.${encodeURIComponent(openingBdKey(monday))}`);
    return Array.isArray(row?.data) ? row!.data : null;
  } catch { return null; }
}

/** Save the Monday opening breakdown. Idempotent unless force=true (used to
 *  refresh a stale pre-definition-change snapshot). */
export async function saveOpeningBreakdown(monday: string, items: OpeningBreakdownItem[], force = false): Promise<void> {
  try {
    if (!force && (await getOpeningBreakdown(monday))) return;
    await dbUpsert('qb_cache', { key: openingBdKey(monday), data: items, updated_at: new Date().toISOString() });
  } catch { /* best-effort */ }
}

/** Manual delete - admin use. */
export async function deleteSnapshot(monday: string): Promise<boolean> {
  await dbDelete('weekly_snapshots', `monday=eq.${encodeURIComponent(monday)}`);
  return true;
}

/** No-op now that snapshots live in Postgres (kept for caller compatibility). */
export function invalidateSnapshotsCache(): void {
  /* table-backed: every read hits the DB, nothing to invalidate */
}
