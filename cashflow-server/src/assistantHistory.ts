/**
 * CFO Copilot - change tracking. The bot records a small snapshot of key
 * financial metrics over time (throttled), so it can answer "what changed"
 * without anyone telling it. Diffing the current snapshot against an earlier
 * recorded one surfaces real movements: cash in/out, payments received, AR
 * shifts, closing-cash changes, QuickBooks going up/down.
 *
 * Storage: server/.assistant-history.json - durable, survives restarts.
 */

import { dbSelect, dbSelectOne, dbInsert } from './db.js';

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

type Row = {
  at: string; bank_cash: number; opening_cash: number; cc_debt: number; net_cash: number;
  gelato_net: number; gelato_received: number; lt_ar_projected: number; inflow_13w: number;
  outflow_13w: number; closing_wk13: number; min_closing: number; runway_negative_week: number | null; qb_down: boolean;
};
function rowToRec(r: Row): HistoryRecord {
  return { at: r.at, m: {
    bankCash: Number(r.bank_cash), openingCash: Number(r.opening_cash), ccDebt: Number(r.cc_debt), netCash: Number(r.net_cash),
    gelatoNet: Number(r.gelato_net), gelatoReceived: Number(r.gelato_received), ltArProjected: Number(r.lt_ar_projected),
    inflow13w: Number(r.inflow_13w), outflow13w: Number(r.outflow_13w), closingWk13: Number(r.closing_wk13),
    minClosing: Number(r.min_closing), runwayNegativeWeek: r.runway_negative_week == null ? null : Number(r.runway_negative_week),
    qbDown: Boolean(r.qb_down),
  } };
}
function metricsToRow(m: HistoryMetrics): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    bank_cash: m.bankCash, opening_cash: m.openingCash, cc_debt: m.ccDebt, net_cash: m.netCash,
    gelato_net: m.gelatoNet, gelato_received: m.gelatoReceived, lt_ar_projected: m.ltArProjected,
    inflow_13w: m.inflow13w, outflow_13w: m.outflow13w, closing_wk13: m.closingWk13,
    min_closing: m.minClosing, runway_negative_week: m.runwayNegativeWeek, qb_down: m.qbDown,
  };
}

async function load(): Promise<HistoryRecord[]> {
  const rows = await dbSelect<Row>('bot_metric_history', 'order=at.asc&limit=3000');
  return rows.map(rowToRec);
}

/** Append a record, throttled so we don't write on every poll. */
export async function recordHistory(m: HistoryMetrics): Promise<void> {
  const lastRow = await dbSelectOne<Row>('bot_metric_history', 'order=at.desc');
  const last = lastRow ? rowToRec(lastRow) : null;
  if (last && Date.now() - Date.parse(last.at) < MIN_GAP_MS) return;
  // QB down zeroes expenses; record the status flip once but keep prior money values for comparison.
  const merged = (m.qbDown && (!last || !last.m.qbDown)) ? ({ ...last?.m, ...m, qbDown: true } as HistoryMetrics) : m;
  await dbInsert('bot_metric_history', metricsToRow(merged));
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
