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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_FILE = path.resolve(__dirname, '..', '.weekly-snapshots.json');

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

export type SnapshotFile = {
  version: 1;
  snapshots: Record<string, WeeklySnapshot>;
};

let cache: SnapshotFile | null = null;

async function loadFile(): Promise<SnapshotFile> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(SNAPSHOTS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as SnapshotFile;
    cache = parsed.snapshots ? parsed : { version: 1, snapshots: {} };
    return cache;
  } catch {
    cache = { version: 1, snapshots: {} };
    return cache;
  }
}

async function saveFile(file: SnapshotFile): Promise<void> {
  cache = file;
  await fs.writeFile(SNAPSHOTS_FILE, JSON.stringify(file, null, 2), 'utf8');
}

/** Return all snapshots, sorted by Monday descending (newest first). */
export async function listSnapshots(): Promise<WeeklySnapshot[]> {
  const file = await loadFile();
  return Object.values(file.snapshots).sort((a, b) => b.monday.localeCompare(a.monday));
}

export async function getSnapshot(monday: string): Promise<WeeklySnapshot | null> {
  const file = await loadFile();
  return file.snapshots[monday] ?? null;
}

/**
 * Persist a snapshot for the given Monday. Idempotent: if a snapshot exists
 * for this Monday, returns without overwriting (the original forecast is the
 * historical artifact we want to preserve). Force = true overrides.
 */
export async function captureSnapshotIfNeeded(snap: WeeklySnapshot, opts: { force?: boolean } = {}): Promise<{ wrote: boolean; reason: string }> {
  const file = await loadFile();
  if (!opts.force && file.snapshots[snap.monday]) {
    return { wrote: false, reason: 'already captured for this Monday' };
  }
  file.snapshots[snap.monday] = snap;
  await saveFile(file);
  return { wrote: true, reason: opts.force ? 'forced overwrite' : 'new snapshot' };
}

/** Manual delete - admin use. */
export async function deleteSnapshot(monday: string): Promise<boolean> {
  const file = await loadFile();
  if (!file.snapshots[monday]) return false;
  delete file.snapshots[monday];
  await saveFile(file);
  return true;
}

/** Force cache refresh from disk (after external edits). */
export function invalidateSnapshotsCache(): void {
  cache = null;
}
