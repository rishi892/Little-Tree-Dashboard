/**
 * CFO Copilot - change tracking. The bot records a small snapshot of key
 * financial metrics over time (throttled), so it can answer "what changed"
 * without anyone telling it. Diffing the current snapshot against an earlier
 * recorded one surfaces real movements: cash in/out, payments received, AR
 * shifts, closing-cash changes, QuickBooks going up/down.
 *
 * Storage: server/.assistant-history.json - durable, survives restarts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '.assistant-history.json');

const MAX_RECORDS = 400;
const MIN_GAP_MS = 20 * 60 * 1000; // record at most once every 20 minutes

export type HistoryMetrics = {
  bankCash: number;
  openingCash: number;      // total cash on hand (bank + Due From PureX)
  ccDebt: number;
  netCash: number;
  gelatoNet: number;        // still to collect
  gelatoReceived: number;
  ltArProjected: number;
  inflow13w: number;
  outflow13w: number;
  closingWk13: number;
  minClosing: number;
  runwayNegativeWeek: number | null;
  qbDown: boolean;
};
export type HistoryRecord = { at: string; m: HistoryMetrics };

let cache: HistoryRecord[] | null = null;

async function load(): Promise<HistoryRecord[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, 'utf8')) as HistoryRecord[];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(recs: HistoryRecord[]): Promise<void> {
  cache = recs.slice(-MAX_RECORDS);
  await fs.writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
}

/** Append a record, throttled so we don't bloat the file on every poll. */
export async function recordHistory(m: HistoryMetrics): Promise<void> {
  const recs = await load();
  const last = recs[recs.length - 1];
  if (last && Date.now() - Date.parse(last.at) < MIN_GAP_MS) return;
  // Skip a degraded record (QB down zeroes expenses) so it doesn't pollute diffs.
  if (m.qbDown && (!last || !last.m.qbDown)) {
    // record the status flip once, but keep prior money values for comparison
    recs.push({ at: new Date().toISOString(), m: { ...last?.m, ...m, qbDown: true } as HistoryMetrics });
    await persist(recs);
    return;
  }
  recs.push({ at: new Date().toISOString(), m });
  await persist(recs);
}

export type Change = { label: string; before: number; after: number; delta: number; kind: 'cash' | 'ar' | 'flow' | 'status' };

function diffMetrics(b: HistoryMetrics, a: HistoryMetrics): Change[] {
  const out: Change[] = [];
  const push = (label: string, bf: number, af: number, kind: Change['kind'], minAbs: number) => {
    const d = +(af - bf).toFixed(2);
    if (Math.abs(d) >= minAbs) out.push({ label, before: bf, after: af, delta: d, kind });
  };
  push('Bank cash', b.bankCash, a.bankCash, 'cash', 100);
  push('Total cash on hand', b.openingCash, a.openingCash, 'cash', 100);
  push('Credit-card debt', b.ccDebt, a.ccDebt, 'cash', 100);
  push('Gelato received', b.gelatoReceived, a.gelatoReceived, 'ar', 100);
  push('Gelato still to collect', b.gelatoNet, a.gelatoNet, 'ar', 100);
  push('Little Tree AR (projected)', b.ltArProjected, a.ltArProjected, 'ar', 200);
  push('13-week inflows', b.inflow13w, a.inflow13w, 'flow', 1000);
  push('13-week outflows', b.outflow13w, a.outflow13w, 'flow', 1000);
  push('Week-13 closing cash', b.closingWk13, a.closingWk13, 'cash', 1000);
  if (b.qbDown !== a.qbDown) {
    out.push({ label: a.qbDown ? 'QuickBooks went offline' : 'QuickBooks reconnected', before: b.qbDown ? 1 : 0, after: a.qbDown ? 1 : 0, delta: 0, kind: 'status' });
  }
  if ((b.runwayNegativeWeek ?? -1) !== (a.runwayNegativeWeek ?? -1)) {
    out.push({ label: 'Cash-negative week', before: b.runwayNegativeWeek ?? 0, after: a.runwayNegativeWeek ?? 0, delta: 0, kind: 'status' });
  }
  return out;
}

export type ChangesResult = { baselineAt: string | null; currentAt: string | null; changes: Change[] };

/**
 * Compare the latest record to an earlier baseline. Baseline = the most recent
 * record at/before `sinceISO` if given; else the record from ~24h ago; else the
 * earliest we have.
 */
export async function getChanges(sinceISO?: string): Promise<ChangesResult> {
  const recs = await load();
  if (recs.length === 0) return { baselineAt: null, currentAt: null, changes: [] };
  const current = recs[recs.length - 1];
  let baseline: HistoryRecord | undefined;
  if (sinceISO) {
    const ms = Date.parse(sinceISO);
    if (!Number.isNaN(ms)) baseline = [...recs].reverse().find((r) => Date.parse(r.at) <= ms);
  }
  if (!baseline) {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    baseline = [...recs].reverse().find((r) => Date.parse(r.at) <= dayAgo) ?? recs[0];
  }
  if (!baseline || baseline === current) return { baselineAt: baseline?.at ?? null, currentAt: current.at, changes: [] };
  return { baselineAt: baseline.at, currentAt: current.at, changes: diffMetrics(baseline.m, current.m) };
}
