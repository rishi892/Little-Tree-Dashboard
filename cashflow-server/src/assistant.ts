/**
 * CFO Copilot - a fully data-driven (no-LLM) question answerer.
 *
 * It assembles a live financial snapshot from the same compute functions the
 * dashboard uses (13-week cashflow, Gelato AR, Tiller balances), then routes a
 * natural-language question (English or Hinglish) to a deterministic handler
 * that reads the snapshot and replies in plain, friendly language. Every answer
 * is structured (title + lines + a "where this comes from" note) and traces
 * back to a real snapshot field - nothing is invented. It also knows who's
 * asking (CEO Joey / CFO Rishi) and addresses them by name.
 */

import { getCashflow13Week, type CashflowResult, type CashflowLine } from './cashflow13.js';
import { getGelatoAr, type GelatoArResult } from './gelatoAr.js';
import { getTillerBalances, type TillerBalances } from './tiller.js';
import { getPurexClearing, type PurexClearingResult } from './purexClearing.js';
import { getLinkedBalances, type LinkedBalances } from './linkedAccounts.js';
import { getSameWeekCollectionRate, getCollectionLagCurve } from './snapshotActuals.js';
import { recordHistory, getChanges } from './assistantHistory.js';
import { dbInsert } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The 90-metric knowledge registry (mined from the codebase): each metric's
// plain-English definition, source, formula, dependencies and downstream
// effects. Loaded from disk so the bot can explain ANY number's what/how/why.
type KbMetric = {
  id: string; label: string; aliases: string[];
  definition: string; source: string; formula: string;
  dependsOn: string[]; affects: string[]; snapshotField: string;
};
let KB_REGISTRY: KbMetric[] = [];
try {
  const kbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'botKnowledge.json');
  KB_REGISTRY = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
} catch { /* registry optional - bot still works without it */ }

const STATUS_CRITICAL = 10_000;

// ── Snapshot ───────────────────────────────────────────────────────────────

export type CustomerAr = { customer: string; open: number; collectible: number; collectibility: number };

export type FinancialSnapshot = {
  asOf: string;
  anchor: string;
  weeks: { label: string; start: string; end: string }[];
  cash: {
    businessCash: number;   // pure bank balance (liquid today)
    openingCash: number;    // 13-week Wk1 opening = bank + Due From PureX (overdue Gelato)
    ccDebt: number;
    netCash: number;
    accounts: { name: string; balance: number; lastUpdated: string }[];
    cards: { name: string; used: number; limit: number | null; available: number | null; usePct: number | null }[];
  };
  totals: CashflowResult['totals'];
  inflows: CashflowLine[];
  outflows: CashflowLine[];
  assumptions: CashflowResult['assumptions'];
  runway: { negativeWeekIdx: number | null; criticalWeekIdx: number | null; minClosing: number; minClosingIdx: number };
  inflow13w: number;
  outflow13w: number;
  net13w: number;
  ar: {
    projected13w: number;
    collectibilityRate: number;
    globalCollectionRate: number;
    collectionDays: number;
    topCustomers: CustomerAr[];
  };
  collections: {
    aging: { d0_30: number; d31_60: number; d61_90: number; d90plus: number; total: number };
    chase: {
      customer: string; open: number; collectible: number;
      daysOldest: number;          // oldest open invoice age (days)
      usualPayDays: number | null; // customer's historical median days-to-pay
      overdueBy: number | null;    // daysOldest − usualPayDays (how late vs their own norm)
      expectedWeek: number | null; // earliest week (1-based) they're projected to pay
      invoices: number;
    }[];
  };
  // Inputs for live what-if maths (e.g. "if sales rise 20%, weekly collection?").
  scenarioData: { salesWeekly: number[]; sameWeekRate: number; lagCurve: number[] };
  intercompany: { purexClearing: number | null; dueFromPurex: number | null };
  burn: { weekly: number; monthly: number };
  health: { qbDown: boolean; warnings: string[] };
  gelato: {
    open: number;
    received: number;
    net: number;
    openCount: number;
    underpaidCount: number;
    invoices: { id: string; period: string; billed: number; received: number; status: string; shortfall: number }[];
  };
  sales: { base: number; best: number; worst: number; little_tree: number; private_label: number; gelato: number } | null;
  warnings: string[];
};

let snapCache: { at: number; snap: FinancialSnapshot } | null = null;
const SNAP_TTL_MS = 30 * 1000;

export async function buildSnapshot(force = false): Promise<FinancialSnapshot> {
  if (!force && snapCache && Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache.snap;

  const [cf, gel, till, purex, linked, sameWeekRate, lagCurve] = await Promise.all([
    getCashflow13Week(),
    getGelatoAr().catch(() => null as GelatoArResult | null),
    getTillerBalances().catch(() => null as TillerBalances | null),
    getPurexClearing().catch(() => null as PurexClearingResult | null),
    getLinkedBalances().catch(() => null as LinkedBalances | null),
    getSameWeekCollectionRate().catch(() => 0.13),
    getCollectionLagCurve().catch(() => []),
  ]);

  const closing = cf.totals.closingCash;
  const negativeWeekIdx = closing.findIndex((c) => c < 0);
  const criticalWeekIdx = closing.findIndex((c) => c < STATUS_CRITICAL);
  let minClosing = Infinity, minClosingIdx = 0;
  closing.forEach((c, i) => { if (c < minClosing) { minClosing = c; minClosingIdx = i; } });

  const inflow13w = cf.totals.inflows.reduce((s, v) => s + v, 0);
  const outflow13w = cf.totals.outflows.reduce((s, v) => s + v, 0);

  const arProj = cf.arProjection;
  const custMap = new Map<string, CustomerAr>();
  if (arProj) {
    for (const p of arProj.placements) {
      const cur = custMap.get(p.customer) ?? { customer: p.customer, open: 0, collectible: 0, collectibility: 1 };
      cur.open += p.openBalance ?? 0;
      cur.collectible += p.projectedCollectible ?? p.openBalance ?? 0;
      custMap.set(p.customer, cur);
    }
  }
  const topCustomers = [...custMap.values()]
    .map((c) => ({ ...c, open: +c.open.toFixed(2), collectible: +c.collectible.toFixed(2), collectibility: c.open > 0 ? +(c.collectible / c.open).toFixed(3) : 1 }))
    .sort((a, b) => b.open - a.open);

  // Collections intelligence: aging + who-to-chase, from the per-invoice AR
  // projection. Each invoice carries its age, the customer's historical median
  // pay-days, and the week it's projected to pay - so the bot can advise WHO to
  // collect from and which invoices have crossed Net 30 / 60 / 90.
  const aging = { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };
  type ChaseAcc = { customer: string; open: number; collectible: number; daysOldest: number; usualPayDays: number | null; expectedWeek: number | null; invoices: number };
  const chaseMap = new Map<string, ChaseAcc>();
  const todayMs = Date.parse(cf.asOf) || Date.now();
  if (arProj) {
    for (const p of arProj.placements) {
      const open = p.openBalance ?? 0;
      if (open <= 0) continue;
      const invMs = Date.parse(p.invoiceDate + 'T00:00:00Z');
      const daysOut = Number.isFinite(invMs) ? Math.max(0, Math.floor((todayMs - invMs) / 86_400_000)) : 0;
      if (daysOut <= 30) aging.d0_30 += open;
      else if (daysOut <= 60) aging.d31_60 += open;
      else if (daysOut <= 90) aging.d61_90 += open;
      else aging.d90plus += open;
      aging.total += open;
      const note = p.placements?.[0]?.targetMonth ?? '';
      const mm = note.match(/median\s+(\d+)\s*d/i);
      const median = mm ? Number(mm[1]) : null;
      let expWk: number | null = null;
      for (const pl of p.placements ?? []) for (const wi of pl.weekIndices ?? []) if (expWk == null || wi < expWk) expWk = wi;
      const cur = chaseMap.get(p.customer) ?? { customer: p.customer, open: 0, collectible: 0, daysOldest: 0, usualPayDays: median, expectedWeek: expWk, invoices: 0 };
      cur.open += open;
      cur.collectible += p.projectedCollectible ?? open;
      cur.daysOldest = Math.max(cur.daysOldest, daysOut);
      if (cur.usualPayDays == null && median != null) cur.usualPayDays = median;
      if (expWk != null && (cur.expectedWeek == null || expWk < cur.expectedWeek)) cur.expectedWeek = expWk;
      cur.invoices += 1;
      chaseMap.set(p.customer, cur);
    }
  }
  (Object.keys(aging) as (keyof typeof aging)[]).forEach((k) => { aging[k] = +aging[k].toFixed(2); });
  const chase = [...chaseMap.values()].map((c) => ({
    customer: c.customer, open: +c.open.toFixed(2), collectible: +c.collectible.toFixed(2),
    daysOldest: c.daysOldest, usualPayDays: c.usualPayDays,
    overdueBy: c.usualPayDays != null ? c.daysOldest - c.usualPayDays : null,
    expectedWeek: c.expectedWeek != null ? c.expectedWeek + 1 : null, invoices: c.invoices,
  })).sort((a, b) => b.collectible - a.collectible);

  const BUSINESS_CASH_RE = /crb indirect|7561|business mm|0910/i;
  const accounts = (till?.cashAccounts ?? [])
    .filter((a) => BUSINESS_CASH_RE.test(a.name))
    .map((a) => ({ name: a.name, balance: a.balance, lastUpdated: a.lastUpdated }));
  const cards = [...(till?.creditCards ?? []), ...(till?.loans ?? [])].map((a) => {
    const used = Math.abs(a.balance);
    const limit = a.balanceLimit != null ? Math.abs(a.balanceLimit) : null;
    const available = limit != null ? limit - used : (a.balanceAvailable != null ? Math.abs(a.balanceAvailable) : null);
    return { name: a.name, used, limit, available, usePct: a.usePct };
  });

  const sf = cf.salesForecast;
  const sales = sf ? {
    base: sf.scenarioTotals.base.cash,
    best: sf.scenarioTotals.best.cash,
    worst: sf.scenarioTotals.worst.cash,
    little_tree: sf.buckets.wholesale.scenarioTotals.base.cash,
    private_label: sf.buckets.privateLabel.scenarioTotals.base.cash,
    gelato: sf.buckets.gelato.scenarioTotals.base.cash,
  } : null;

  const snap: FinancialSnapshot = {
    asOf: cf.asOf,
    anchor: cf.anchor,
    weeks: cf.weeks,
    cash: { businessCash: cf.bankCashWk1, openingCash: cf.openingCashWk1, ccDebt: cf.assumptions.ccPayoffWk1, netCash: +(cf.openingCashWk1 - cf.assumptions.ccPayoffWk1).toFixed(2), accounts, cards },
    totals: cf.totals,
    inflows: cf.inflows,
    outflows: cf.outflows,
    assumptions: cf.assumptions,
    runway: { negativeWeekIdx: negativeWeekIdx < 0 ? null : negativeWeekIdx, criticalWeekIdx: criticalWeekIdx < 0 ? null : criticalWeekIdx, minClosing: +minClosing.toFixed(2), minClosingIdx },
    inflow13w: +inflow13w.toFixed(2),
    outflow13w: +outflow13w.toFixed(2),
    net13w: +(inflow13w - outflow13w).toFixed(2),
    ar: {
      projected13w: +(arProj?.arByWeek.reduce((s, v) => s + v, 0) ?? 0).toFixed(2),
      collectibilityRate: arProj?.projectedCollectibilityRate ?? 1,
      globalCollectionRate: arProj?.globalCollectionRate ?? 0,
      collectionDays: arProj?.globalAvgCollectionDays ?? 0,
      topCustomers,
    },
    collections: { aging, chase },
    scenarioData: {
      salesWeekly: (cf.inflows.find((l) => /sales.*forecast/i.test(l.label))?.values ?? cf.weeks.map(() => 0)),
      sameWeekRate: typeof sameWeekRate === 'number' && sameWeekRate > 0 ? sameWeekRate : 0.13,
      lagCurve: Array.isArray(lagCurve) && lagCurve.length > 0 ? lagCurve : [],
    },
    intercompany: {
      purexClearing: purex ? purex.clearing : null,
      dueFromPurex: (linked?.qb.intercompanyExcluded ?? []).find((a) => /due from purex|gelato net ?90/i.test(a.name))?.balance ?? null,
    },
    burn: { weekly: +(outflow13w / 13).toFixed(2), monthly: +((outflow13w / 13) * 4.33).toFixed(2) },
    health: {
      qbDown: cf.warnings.some((w) => /refresh token|authorize again|expense.*fail|not connected|invalid/i.test(w)),
      warnings: cf.warnings,
    },
    gelato: {
      open: gel?.totals.open ?? 0,
      received: gel?.totals.receivedOnOpen ?? 0,
      net: Math.max(0, (gel?.totals.open ?? 0) - (gel?.totals.receivedOnOpen ?? 0)),
      openCount: gel?.totals.openCount ?? 0,
      underpaidCount: gel?.totals.underpaidCount ?? 0,
      invoices: (gel?.pendingInvoices ?? []).map((inv) => ({
        id: inv.invoiceNumber || inv.period, period: inv.period, billed: inv.amount,
        received: inv.receivedAmount ?? 0, status: inv.paymentStatus ?? 'pending', shortfall: inv.shortfall ?? 0,
      })),
    },
    sales,
    warnings: cf.warnings,
  };

  snapCache = { at: Date.now(), snap };

  // Record a small time-series of key metrics so the bot can answer "what
  // changed" on its own (throttled inside recordHistory). Fire-and-forget.
  void recordHistory({
    bankCash: snap.cash.businessCash,
    openingCash: snap.cash.openingCash,
    ccDebt: snap.cash.ccDebt,
    netCash: snap.cash.netCash,
    gelatoNet: snap.gelato.net,
    gelatoReceived: snap.gelato.received,
    ltArProjected: snap.ar.projected13w,
    inflow13w: snap.inflow13w,
    outflow13w: snap.outflow13w,
    closingWk13: snap.totals.closingCash[snap.totals.closingCash.length - 1] ?? 0,
    minClosing: snap.runway.minClosing,
    runwayNegativeWeek: snap.runway.negativeWeekIdx,
    qbDown: snap.health.qbDown,
  }).catch(() => { /* history is best-effort */ });

  return snap;
}

// ── "What changed" (auto change-tracking) ────────────────────────────────────

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return 'a little while ago';
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

function isWhatChanged(n: string): boolean {
  return /\bwhat changed\b|\bwhats new\b|\bwhat s new\b|\bany update\b|\bany news\b|\bkya badla\b|\bkya naya\b|\bkya change\b|\bwhat happened\b|\bsince last\b|\bupdates?\b|\bnaya kya\b/.test(n);
}

export async function getChangesAnswer(sinceISO?: string): Promise<Answer> {
  const res = await getChanges(sinceISO);
  if (!res.baselineAt || res.changes.length === 0) {
    return {
      title: `Nothing major has changed${res.baselineAt ? ` since ${relTime(res.baselineAt)}` : ' yet'}.`,
      lines: [`I'm watching your cash, AR, Gelato payments and the 13-week plan around the clock - the moment something real moves, I'll flag it here. You don't have to tell me anything.`],
    };
  }
  const lines = res.changes.map((c) => {
    if (c.kind === 'status') return `• ${c.label}`;
    const dir = c.delta > 0 ? 'up' : 'down';
    return `• ${c.label}: ${dir} ${money(Math.abs(c.delta))} → now ${money(c.after)}`;
  });
  return {
    title: `Here's what changed since ${relTime(res.baselineAt)}:`,
    lines,
    note: `I track these automatically as your data updates - just ask "what changed" anytime, or I'll show it when you open me.`,
  };
}

// ── Formatting + small helpers ───────────────────────────────────────────────

function money(n: number): string {
  const r = Math.round(n);
  return (r < 0 ? '-$' : '$') + Math.abs(r).toLocaleString('en-US');
}
function pct(n: number): string { return Math.round(n * 100) + '%'; }
function weekName(snap: FinancialSnapshot, i: number): string {
  const w = snap.weeks[i];
  return w ? `week ${i + 1} (starting ${w.label})` : `week ${i + 1}`;
}
/** Re-roll closing cash with a custom per-week inflow series. */
function rollClosing(snap: FinancialSnapshot, inflowSeries: number[]): number[] {
  let running = snap.cash.openingCash;
  const out: number[] = [];
  for (let i = 0; i < snap.weeks.length; i++) {
    running += (inflowSeries[i] ?? 0) - (snap.totals.outflows[i] ?? 0);
    out.push(running);
  }
  return out;
}

// Plain-language "where this number comes from" lines (no jargon, no symbols).
const SOURCE = {
  cash: 'Bank balances are live from Tiller (CRB Indirect 7561 + Business MM 0910), plus Due From PureX - the Gelato money past Net 90 that PureX owes you, counted as cash since it is available to draw.',
  cc: 'Live credit-card balances from Tiller. "Available" on each card is its limit minus what you have already used.',
  ar_lt: 'Built from your Invoice Tracker sheet. Each open invoice is placed in the week that customer normally pays (learned from their own past payments), and older or riskier invoices are trimmed down so we do not count money that may never arrive.',
  ar_gelato: 'From the Gelato Sales sheet, then checked against the Invoice Tracker to see what has already been paid. Gelato pays on Net 97 (Net 90 plus a 7-day buffer), so each batch lands about 97 days after it is billed.',
  expenses: 'From QuickBooks - your actual spending over the last 3 months, averaged into a weekly run-rate (monthly amount divided by 4.33 weeks).',
  sales: 'A trend line on your QuickBooks sales history, run separately for Little Tree, Private Label and Gelato, then turned into expected new invoices and the weeks their cash lands.',
  closing: 'Each week we take the cash you start with, add what comes in, subtract what goes out, and carry the result into the next week. Week 1 starts from your real bank balance today.',
};

// ── Answer shape ─────────────────────────────────────────────────────────────

export type NavTarget = { view: string; tab: string; anchor: string; where: string };
export type Answer = { title: string; lines: string[]; note?: string; nav?: NavTarget };
export type User = { name?: string; title?: string };

// Where each metric lives in the UI, so the bot can point you there (and the
// frontend can navigate + highlight it - the "show me where" walkthrough).
const LOC: Record<string, NavTarget> = {
  cashOnHand:   { view: 'cashflow', tab: 'position',   anchor: 'cash-on-hand',  where: 'Cash Flow → Current Position tab → "1. Cash on Hand"' },
  creditCards:  { view: 'cashflow', tab: 'position',   anchor: 'credit-cards',  where: 'Cash Flow → Current Position tab → "2. Credit Card Debt"' },
  intercompany: { view: 'cashflow', tab: 'position',   anchor: 'intercompany',  where: 'Cash Flow → Current Position tab → "3. Intercompany (PureX)"' },
  gelatoAr:     { view: 'cashflow', tab: 'position',   anchor: 'gelato-ar',     where: 'Cash Flow → Current Position tab → "4. Accounts Receivable (Gelato)"' },
  netLiquidity: { view: 'cashflow', tab: 'position',   anchor: 'net-liquidity', where: 'Cash Flow → Current Position tab → "5. Net Liquidity Position"' },
  schedule:     { view: 'cashflow', tab: 'cashflow13', anchor: 'cf-schedule',   where: 'Cash Flow → 13-Week Plan tab → Weekly schedule' },
  kpis:         { view: 'cashflow', tab: 'cashflow13', anchor: 'cf-kpis',       where: 'Cash Flow → 13-Week Plan tab → KPI cards (top)' },
  // Expenses view
  expCombined:  { view: 'expenses', tab: 'combined',      anchor: 'expenses-tabs', where: 'Expenses tab → "Combined" (PureX + Moysh)' },
  expMonthly:   { view: 'expenses', tab: 'monthly',       anchor: 'expenses-tabs', where: 'Expenses tab → "Monthly LT vs PureX"' },
  expPurex:     { view: 'expenses', tab: 'purex',         anchor: 'expenses-tabs', where: 'Expenses tab → "PureX"' },
  expMoysh:     { view: 'expenses', tab: 'moysh',         anchor: 'expenses-tabs', where: 'Expenses tab → "Moysh"' },
  subscriptions:{ view: 'expenses', tab: 'subscriptions', anchor: 'expenses-tabs', where: 'Expenses tab → "Subscriptions"' },
  // Reports view
  pnl:          { view: 'reports', tab: 'pl',             anchor: 'reports-tabs',  where: 'Reports tab → "LT P&L"' },
  balanceSheet: { view: 'reports', tab: 'bs',             anchor: 'reports-tabs',  where: 'Reports tab → "Balance Sheet"' },
  bankTxns:     { view: 'reports', tab: 'bank',           anchor: 'reports-tabs',  where: 'Reports tab → "Bank Transactions"' },
  ccTxns:       { view: 'reports', tab: 'cc',             anchor: 'reports-tabs',  where: 'Reports tab → "Credit Card Transactions"' },
  reconciliation:{ view: 'reports', tab: 'reco',          anchor: 'reports-tabs',  where: 'Reports tab → "Reconciliation"' },
  salesByProduct:{ view: 'reports', tab: 'salesByProduct',anchor: 'reports-tabs',  where: 'Reports tab → "Sales by Product"' },
  // Upflow view (collections / dunning)
  upflow:        { view: 'upflow', tab: 'overview',       anchor: 'upflow-tabs',   where: 'Upflow tab → "Overview"' },
  upflowInvoices:{ view: 'upflow', tab: 'invoices',       anchor: 'upflow-tabs',   where: 'Upflow tab → "Invoices"' },
  upflowReminders:{ view: 'upflow', tab: 'reminders',     anchor: 'upflow-tabs',   where: 'Upflow tab → "Reminders"' },
};

// Which dashboard location each intent's number lives at.
const INTENT_LOCATION: Record<string, NavTarget> = {
  cash_on_hand: LOC.cashOnHand,
  due_from_purex: LOC.cashOnHand,
  cc_debt: LOC.creditCards,
  net_position: LOC.netLiquidity,
  gelato_ar: LOC.gelatoAr,
  customer_ar: LOC.gelatoAr,
  ar_total: LOC.gelatoAr,
  runway: LOC.schedule,
  closing_week: LOC.schedule,
  inflow: LOC.schedule,
  outflow: LOC.schedule,
  expense_category: LOC.schedule,
  top_expense: LOC.schedule,
  sales_forecast: LOC.schedule,
  effect_no_ar: LOC.schedule,
  scenario: LOC.schedule,
  min_cash: LOC.kpis,
  status: LOC.kpis,
  subscriptions: LOC.subscriptions,
  expenses_detail: LOC.expCombined,
  pnl: LOC.pnl,
  balance_sheet: LOC.balanceSheet,
  bank_transactions: LOC.bankTxns,
  cc_transactions: LOC.ccTxns,
  reconciliation: LOC.reconciliation,
  sales_by_product: LOC.salesByProduct,
  upflow: LOC.upflow,
};

/** Does the question ask to be shown / located on the dashboard? */
function wantsLocation(n: string): boolean {
  return /\bshow me\b|\bshow it\b|\bwhere is\b|\bwhere can i\b|\bwhere do i\b|\bwhere s\b|\blocate\b|\btake me\b|\bkaha?n? ?(hai|h|pe|par)\b|\bdikha\b|\bdikhao\b|\bdikha do\b|\ble chalo\b|\bwhich (page|tab|section)\b|\bfind (it|this)\b|\bon the dashboard\b/.test(n);
}

export type AssistantAnswer = {
  intent: string;
  title: string;
  lines: string[];
  note?: string;
  warning?: string;
  nav?: NavTarget;
  confidence: number;
  suggestions: string[];
};

// ── Knowledge registry helpers (breadth fallback + why/how) ──────────────────

/** Find the best registry metric for a question by alias + content overlap. */
const KB_STOP = new Set(['what', 'where', 'when', 'which', 'does', 'come', 'from', 'how', 'why', 'the', 'this', 'that', 'number', 'show', 'tell', 'about', 'calculated', 'computed', 'mean', 'means']);
function findKbMetric(n: string): KbMetric | null {
  const qTokens = n.trim().split(' ').filter((t) => t.length >= 4 && !KB_STOP.has(t));
  let best: KbMetric | null = null, score = 0;
  for (const m of KB_REGISTRY) {
    let sc = 0;
    for (const a of m.aliases) if (a.length >= 4 && n.includes(' ' + a + ' ')) sc += 4 + a.length * 0.1;
    const hay = (m.label + ' ' + m.definition + ' ' + m.formula).toLowerCase();
    for (const tok of qTokens) if (hay.includes(tok)) sc += 1.3;
    if (sc > score) { score = sc; best = m; }
  }
  return score >= 2.5 ? best : null;
}

// Intents whose answer leans on QuickBooks-sourced data (expenses, the rolled
// closing cash, intercompany). If QB is down these read falsely-rosy, so we
// warn instead of presenting them as fact.
const QB_DEPENDENT = new Set([
  'expense_category', 'outflow', 'top_expense', 'closing_week', 'runway',
  'status', 'net_position', 'due_from_purex', 'scenario', 'effect_no_ar', 'min_cash',
]);

function firstName(user?: User): string {
  const n = (user?.name || '').trim();
  if (!n) return '';
  return n.split(/\s+/)[0];
}

// ── Intent engine ────────────────────────────────────────────────────────────

function norm(s: string): string {
  return ' ' + s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

function extractWeek(n: string): number | null {
  if (/\b(this|current|is|abhi)\s+(week|hafta|hafte)\b/.test(n) || /\bthis week\b/.test(n)) return 1;
  if (/\b(next|agla|agle)\s+(week|hafta|hafte)\b/.test(n)) return 2;
  const m = n.match(/\b(?:week|wk|hafta|hafte)\s*#?\s*(\d{1,2})\b/) || n.match(/\b(\d{1,2})\s*(?:week|wk|hafta|hafte)\b/);
  if (m) { const v = Number(m[1]); if (v >= 1 && v <= 13) return v; }
  return null;
}

function extractScenario(n: string): number | null {
  const m = n.match(/(\d{1,3})\s*(?:%|percent|pct)/);
  if (!m) {
    if (/\bworst\b|\bworse\b/.test(n)) return -18;
    if (/\bbest\b/.test(n)) return 18;
    return null;
  }
  const mag = Number(m[1]);
  const down = /\b(gir|drop|down|fall|decline|less|kam|ghat|decrease|reduce|miss|lose|loss|slow)\b/.test(n);
  const up = /\b(badh|rise|up|grow|increase|more|zyada|jump|gain)\b/.test(n);
  if (down && !up) return -mag;
  if (up && !down) return mag;
  return -mag;
}

type Intent = {
  id: string;
  phrases: string[];
  keywords: string[];
  location?: NavTarget;
  handler: (snap: FinancialSnapshot, n: string, user?: User) => Answer;
};

function findExpenseRow(snap: FinancialSnapshot, n: string) {
  const items: { label: string; weekly: number; parent: string }[] = [];
  for (const l of snap.outflows) {
    const weekly = l.values.reduce((a, b) => a + b, 0) / 13;
    items.push({ label: l.label, weekly, parent: l.label });
    for (const b of l.breakdown ?? []) items.push({ label: b.label, weekly: b.amount, parent: l.label });
  }
  const tokens = n.trim().split(' ').filter((t) => t.length >= 3);
  let best: { label: string; weekly: number; parent: string } | null = null, score = 0;
  for (const it of items) {
    const lab = ' ' + it.label.toLowerCase() + ' ';
    let sc = 0;
    for (const t of tokens) if (lab.includes(t)) sc += t.length;
    if (sc > score) { score = sc; best = it; }
  }
  return score > 0 ? best : null;
}

// Match a question to ANY cashflow line (inflow OR outflow), also peeking at each
// line's breakdown labels so "hubspot breakdown" finds the Software line.
function findAnyLine(snap: FinancialSnapshot, n: string): CashflowLine | null {
  const lines = [...snap.inflows, ...snap.outflows];
  const tokens = n.trim().split(' ').filter((t) => t.length >= 3);
  let best: CashflowLine | null = null, score = 0;
  for (const l of lines) {
    const lab = ' ' + l.label.toLowerCase() + ' ';
    let sc = 0;
    for (const t of tokens) if (lab.includes(t)) sc += t.length;
    for (const b of l.breakdown ?? []) {
      const bl = ' ' + b.label.toLowerCase() + ' ';
      for (const t of tokens) if (bl.includes(t)) sc += t.length * 0.5;
    }
    if (sc > score) { score = sc; best = l; }
  }
  return score > 0 ? best : null;
}

const BREAKDOWN_WORDS = ['breakdown', 'break down', 'break up', 'kiska kitna', 'kaun kaun', 'kon kon', 'components', 'itemize', 'itemise', 'split up', 'saare', 'sab kaun', 'puri list', 'full list', 'list of', 'who all', 'line by line', 'kis kis'];
function hasBreakdownWords(n: string): boolean {
  return BREAKDOWN_WORDS.some((w) => n.includes(w));
}

// List EVERY component of a line (payroll payees, software vendors, AR heads...),
// proportioned to the line's real total - the same "who/what" the dashboard shows.
function breakdownAnswer(s: FinancialSnapshot, line: CashflowLine, n: string): Answer {
  const total13 = line.values.reduce((a, b) => a + b, 0);
  const bd = line.breakdown ?? [];
  if (bd.length === 0) {
    return { title: `${line.label} has no further breakdown.`, lines: [`It totals ${money(total13)} over the 13 weeks.`], note: SOURCE.expenses };
  }
  const sumAmt = bd.reduce((a, b) => a + Math.abs(b.amount), 0) || 1;
  const ranked = bd.map((b) => ({ label: b.label, share: Math.abs(b.amount) / sumAmt })).sort((a, b) => b.share - a.share);
  const wk = extractWeek(n);
  if (wk != null) {
    const i = wk - 1; const lineWk = line.values[i] ?? 0;
    return {
      title: `${line.label} in ${weekName(s, i)} is ${money(lineWk)}, split by who/what:`,
      lines: ranked.map((x) => `• ${x.label}: ${money(lineWk * x.share)} (${pct(x.share)})`),
      note: `Each component's share of that week - the same breakdown shown on the dashboard.`,
    };
  }
  return {
    title: `${line.label} = ${money(total13)} over 13 weeks, broken down by who/what (${bd.length} items):`,
    lines: ranked.map((x) => `• ${x.label}: ${money(total13 * x.share)} (${pct(x.share)})`),
    note: `Each item's share of the line - the same per-payee / per-vendor breakdown shown on the dashboard.`,
  };
}

const INTENTS: Intent[] = [
  {
    id: 'greeting',
    phrases: ['hello', 'hey there', 'good morning', 'good evening', 'namaste', 'kaise ho', 'whats up', 'hi there'],
    keywords: ['hi', 'hey', 'hello', 'yo'],
    handler: (_s, _n, user) => {
      const fn = firstName(user);
      // Time of day in Little Tree's timezone (Michigan = US Eastern).
      const hr = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Detroit', hour: '2-digit', hour12: false }));
      const partOfDay = hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening';
      return {
        title: `Good ${partOfDay}${fn ? `, ${fn}` : ''}!`,
        lines: [`Ask me anything about the cashflow - cash, runway, who to collect from, expenses, a what-if, or "show me on the dashboard".`],
      };
    },
  },
  {
    id: 'help',
    phrases: ['what can you do', 'what can i ask', 'help me', 'how do you work', 'kya kar sakte', 'what do you know', 'your capabilities'],
    keywords: ['help', 'capabilities'],
    handler: () => ({
      title: `Here's what I can help with - just ask in plain words.`,
      lines: [
        `• Cash and debt - "how much cash do we have", "credit card debt"`,
        `• Runway and health - "how long will cash last", "are we okay"`,
        `• Money coming in - "how much is Gelato AR", "who owes us the most"`,
        `• Spending - "biggest expense", "how much is payroll"`,
        `• What-ifs - "what if sales drop 20%", "what if customers pay late"`,
        `• How things work - "where does the AR number come from"`,
      ],
      note: `Every answer is calculated live from your own dashboard data.`,
    }),
  },
  {
    id: 'cash_on_hand',
    phrases: ['cash on hand', 'how much cash', 'kitna cash', 'kitna paisa', 'bank balance', 'cash position', 'cash hai', 'paisa hai', 'liquid cash', 'money in bank', 'how much money'],
    keywords: ['cash', 'paisa', 'balance', 'bank', 'funds'],
    handler: (s) => {
      // Due From PureX = the amount folded into cash on hand (opening − bank).
      // Computed from cash-on-hand itself so it always reconciles, even if QB
      // (which supplies the book balance) is momentarily down.
      const dfp = +(s.cash.openingCash - s.cash.businessCash).toFixed(2);
      const lines = [
        ...s.cash.accounts.map((a) => `• ${a.name}: ${money(a.balance)}`),
      ];
      if (dfp > 0) lines.push(`• Due From PureX (Gelato, past Net 90): ${money(dfp)} - owed to you and available, so it counts as cash.`);
      lines.push(`After credit-card debt of ${money(s.cash.ccDebt)}, your net is ${money(s.cash.netCash)}.`);
      return {
        title: `Your cash on hand is ${money(s.cash.openingCash)}.`,
        lines,
        note: `Bank balances are live from Tiller. Due From PureX - the Gelato money past Net 90 - is counted as cash since PureX owes it and it's available to you.`,
      };
    },
  },
  {
    id: 'due_from_purex',
    phrases: ['due from purex', 'cash low', 'cash kam', 'kum kyu', 'kam kyu', 'why is cash', 'why cash', 'purex come', 'purex 13 week', 'gelato net 90', 'where is my cash', 'paisa kahan', 'cash itna kam'],
    keywords: ['purex'],
    handler: (s) => {
      const dfp = +(s.cash.openingCash - s.cash.businessCash).toFixed(2);
      const gRow = s.inflows.find((l) => /gelato ar collections/i.test(l.label));
      const futureGelato = gRow ? gRow.values.reduce((a, b) => a + b, 0) : 0;
      return {
        title: `Your cash on hand is ${money(s.cash.openingCash)} - that's bank ${money(s.cash.businessCash)} + Due From PureX ${money(dfp)} (Gelato money past Net 90, treated as cash).`,
        lines: [
          `Due From PureX (${money(dfp)}) is the overdue Gelato (Jan + Feb) PureX already owes - so it counts as cash you have, sitting in opening cash.`,
          `The Gelato that's not yet due (the March batch, about ${money(futureGelato)}) still shows up as a collection in the week it lands - you watch it come in.`,
          `So all ${money(dfp + futureGelato)} of Gelato is accounted for: ${money(dfp)} already in opening cash + ${money(futureGelato)} coming in later. Nothing lost, nothing double-counted.`,
        ],
        note: `Opening cash = Total Cash on Hand (bank + Due From PureX). Future Gelato batches collect at their Net 97 date.`,
      };
    },
  },
  {
    id: 'cc_debt',
    phrases: ['credit card debt', 'card debt', 'cc debt', 'kitna card', 'card pe kitna', 'card utilization', 'card utilisation', 'how much owe on card', 'credit card balance'],
    keywords: ['card', 'cards', 'cc', 'utilization', 'utilisation'],
    handler: (s) => ({
      title: `Your total business credit-card debt is ${money(s.cash.ccDebt)}.`,
      lines: s.cash.cards.filter((c) => c.used > 0 || (c.limit ?? 0) > 0).sort((a, b) => b.used - a.used)
        .map((c) => `• ${c.name}: ${money(c.used)} used${c.limit != null ? ` of ${money(c.limit)} limit (${c.usePct != null ? pct(c.usePct) : '-'})` : ''}${c.available != null ? `, ${money(c.available)} still available` : ''}`),
      note: SOURCE.cc,
    }),
  },
  {
    id: 'net_position',
    phrases: ['net working capital', 'working capital', 'net position', 'net liquidity', 'liquidity position', 'overall position', 'net worth', 'real position'],
    keywords: ['liquidity', 'networth', 'position', 'workingcapital'],
    handler: (s) => {
      const dfp = s.intercompany.dueFromPurex ?? 0;
      const gRow = s.inflows.find((l) => /gelato ar collections/i.test(l.label));
      const futureGelato = gRow ? gRow.values.reduce((a, b) => a + b, 0) : Math.max(0, s.gelato.net - dfp);
      const withFuture = s.cash.netCash + futureGelato + s.ar.projected13w;
      return {
        title: `Net cash position: ${money(s.cash.netCash)} (cash on hand ${money(s.cash.openingCash)} minus card debt ${money(s.cash.ccDebt)}).`,
        lines: [
          `• Cash on hand: ${money(s.cash.openingCash)} (bank + Due From PureX, which is past Net 90 and available to you)`,
          `• Minus credit-card debt: ${money(s.cash.ccDebt)}`,
          `• Plus receivables still to land: future Gelato ${money(futureGelato)} + Little Tree AR ${money(s.ar.projected13w)}`,
          `Counting those, your working-capital view is about ${money(withFuture)}.`,
        ],
        note: `Cash on hand includes Due From PureX (past Net 90). The other receivables are not yet due and arrive over the coming weeks.`,
      };
    },
  },
  {
    id: 'runway',
    phrases: ['runway', 'how long will cash last', 'kitne din', 'kitna chalega', 'kab khatam', 'kab tak', 'run out of cash', 'out of cash', 'will we survive', 'cash last', 'how long can we'],
    keywords: ['runway', 'survive', 'chalega'],
    handler: (s) => {
      const tail = s.totals.closingCash[s.totals.closingCash.length - 1];
      if (s.runway.negativeWeekIdx != null) {
        return {
          title: `Heads up - on the current plan, cash runs out around ${weekName(s, s.runway.negativeWeekIdx)}.`,
          lines: [
            `The lowest point is ${money(s.runway.minClosing)} at ${weekName(s, s.runway.minClosingIdx)}.`,
            `You'd want to pull in collections faster or push a large payment before then to avoid the dip.`,
          ],
          note: SOURCE.closing,
        };
      }
      return {
        title: `You're covered - cash stays positive through all 13 weeks.`,
        lines: [
          `By week 13 you're projected to have ${money(tail)} in the bank.`,
          s.runway.criticalWeekIdx != null
            ? `It does get a little tight around ${weekName(s, s.runway.criticalWeekIdx)} (low point ${money(s.runway.minClosing)}), so keep an eye there.`
            : `The tightest week never drops below ${money(s.runway.minClosing)}, so there's a comfortable buffer.`,
          `Rolled forward from ${money(s.cash.openingCash)} opening cash.`,
        ],
        note: SOURCE.closing,
      };
    },
  },
  {
    id: 'closing_week',
    phrases: ['closing cash', 'closing balance', 'end of week', 'cash at week', 'balance at week', 'kitna bachega', 'week me kitna'],
    keywords: ['closing', 'bachega'],
    handler: (s, n) => {
      const wk = extractWeek(n);
      if (wk == null) {
        return {
          title: `Here's the projected cash at the end of each week:`,
          lines: s.totals.closingCash.map((c, i) => `• ${weekName(s, i)}: ${money(c)} (${s.totals.status[i].toLowerCase()})`),
          note: SOURCE.closing,
        };
      }
      const i = wk - 1;
      return {
        title: `By the end of ${weekName(s, i)}, you're projected to have ${money(s.totals.closingCash[i])}.`,
        lines: [
          `That week: ${money(s.totals.inflows[i])} comes in, ${money(s.totals.outflows[i])} goes out, so the change is ${money(s.totals.netChange[i])}.`,
          `You start the week with ${money(s.totals.openingCash[i])} and the position is ${s.totals.status[i].toLowerCase()}.`,
        ],
        note: SOURCE.closing,
      };
    },
  },
  {
    id: 'inflow',
    phrases: ['how much coming in', 'kitna aayega', 'kitna aa raha', 'inflows', 'collections', 'money coming in', 'paisa aayega', 'incoming cash'],
    keywords: ['inflow', 'inflows', 'collections', 'incoming', 'aayega'],
    handler: (s, n) => {
      const wk = extractWeek(n);
      if (wk != null) {
        const i = wk - 1;
        return {
          title: `In ${weekName(s, i)}, about ${money(s.totals.inflows[i])} is expected to come in.`,
          lines: s.inflows.map((l) => `• ${l.label}: ${money(l.values[i] ?? 0)}`),
          note: `Money in is collections on existing invoices plus expected new sales. No row is counted twice.`,
        };
      }
      return {
        title: `Over the next 13 weeks, about ${money(s.inflow13w)} is expected to come in.`,
        lines: s.inflows.map((l) => `• ${l.label}: ${money(l.values.reduce((a, b) => a + b, 0))}`),
        note: `That's Gelato collections, Little Tree invoice collections, and projected new sales - each from its own source, no double-counting.`,
      };
    },
  },
  {
    id: 'outflow',
    phrases: ['how much going out', 'kitna kharch', 'kitna ja raha', 'outflows', 'total expenses', 'spending', 'kharcha', 'paisa jaayega', 'burn rate', 'monthly burn'],
    keywords: ['outflow', 'outflows', 'spend', 'spending', 'kharch', 'kharcha', 'burn'],
    handler: (s, n) => {
      const wk = extractWeek(n);
      if (wk != null) {
        const i = wk - 1;
        return {
          title: `In ${weekName(s, i)}, about ${money(s.totals.outflows[i])} goes out.`,
          lines: s.outflows.map((l) => `• ${l.label}: ${money(l.values[i] ?? 0)}`),
          note: SOURCE.expenses,
        };
      }
      return {
        title: `Over 13 weeks you spend about ${money(s.outflow13w)} - roughly ${money(s.outflow13w / 13)} a week.`,
        lines: s.outflows.map((l) => ({ label: l.label, t: l.values.reduce((a, b) => a + b, 0) })).sort((a, b) => b.t - a.t).map((x) => `• ${x.label}: ${money(x.t)}`),
        note: SOURCE.expenses,
      };
    },
  },
  {
    id: 'expense_category',
    phrases: ['payroll', 'salary', 'salaries', 'inventory', 'raw material', 'rent', 'insurance', 'how much on', 'kis pe kitna', 'spend on'],
    keywords: ['payroll', 'salary', 'inventory', 'rent'],
    handler: (s, n) => {
      // "payroll breakdown" / "software me kaun kaun" → list the full breakdown.
      if (hasBreakdownWords(n)) {
        const line = findAnyLine(s, n);
        if (line) return breakdownAnswer(s, line, n);
      }
      const best = findExpenseRow(s, n);
      if (!best) {
        return {
          title: `Here are your expense categories (per week):`,
          lines: s.outflows.map((l) => `• ${l.label}: ${money(l.values.reduce((a, b) => a + b, 0) / 13)} a week`),
          note: `Ask about any one, e.g. "how much is payroll".`,
        };
      }
      const monthly = best.weekly * 4.33;
      const ctx = best.parent !== best.label ? ` (part of ${best.parent})` : '';
      return {
        title: `${best.label}${ctx} runs about ${money(best.weekly)} a week.`,
        lines: [
          `That's roughly ${money(monthly)} a month, or ${money(best.weekly * 13)} across the 13-week plan.`,
        ],
        note: SOURCE.expenses,
      };
    },
  },
  {
    id: 'top_expense',
    phrases: ['biggest expense', 'largest expense', 'sabse bada kharch', 'top expense', 'biggest cost', 'main cost', 'where is money going', 'highest spend', 'where does money go'],
    keywords: ['biggest', 'largest', 'highest'],
    handler: (s) => {
      const ranked = s.outflows.map((l) => ({ label: l.label, t: l.values.reduce((a, b) => a + b, 0) })).sort((a, b) => b.t - a.t);
      const top = ranked[0];
      return {
        title: `Your biggest cost is ${top.label} at ${money(top.t)} over 13 weeks - about ${pct(top.t / s.outflow13w)} of all spending.`,
        lines: ranked.map((x, i) => `• ${i + 1}. ${x.label}: ${money(x.t)} (${pct(x.t / s.outflow13w)})`),
        note: SOURCE.expenses,
      };
    },
  },
  {
    id: 'breakdown',
    phrases: ['breakdown', 'break down', 'break up', 'kiska kitna', 'kaun kaun', 'kon kon', 'kis kis', 'components', 'itemize', 'split up', 'puri list', 'full list', 'list of', 'who all', 'line by line', 'sab kaun'],
    keywords: ['breakdown', 'components', 'itemize'],
    handler: (s, n) => {
      const line = findAnyLine(s, n);
      if (!line) {
        return {
          title: `Which line should I break down?`,
          lines: [
            `Money in: ${s.inflows.map((l) => l.label).join(' · ')}`,
            `Money out: ${s.outflows.map((l) => l.label).join(' · ')}`,
            `Try "payroll breakdown", "software breakdown", "past AR breakdown" - add a week like "payroll breakdown week 3" for that week.`,
          ],
        };
      }
      return breakdownAnswer(s, line, n);
    },
  },
  {
    id: 'gelato_ar',
    phrases: ['gelato pending', 'gelato ar', 'gelato receivable', 'gelato kitna', 'gelato owe', 'purex owe', 'gelato collect', 'gelato due', 'gelato money'],
    keywords: ['gelato', 'purex'],
    handler: (s, n) => {
      if (/underpaid|short|kam paya|less paid|paid less/.test(n) && s.gelato.underpaidCount > 0) {
        const up = s.gelato.invoices.filter((i) => i.status === 'underpaid');
        return {
          title: `${s.gelato.underpaidCount} Gelato batch${s.gelato.underpaidCount > 1 ? 'es' : ''} came in short of what was billed:`,
          lines: up.map((i) => `• ${i.id} (${i.period}): billed ${money(i.billed)}, only ${money(i.received)} received - short by ${money(i.shortfall)}`),
          note: `Checked line-by-line against the Invoice Tracker.`,
        };
      }
      return {
        title: `Gelato owes ${money(s.gelato.net)} still to collect.`,
        lines: [
          `Total billed across ${s.gelato.openCount} open batches: ${money(s.gelato.open)}.`,
          `Already received (per the Invoice Tracker): ${money(s.gelato.received)}.`,
          `So the money still coming is ${money(s.gelato.net)}.`,
          s.gelato.underpaidCount > 0 ? `${s.gelato.underpaidCount} batch came in underpaid - ask "gelato underpaid" for the detail.` : ``,
        ].filter(Boolean),
        note: SOURCE.ar_gelato,
      };
    },
  },
  {
    id: 'customer_ar',
    phrases: ['who owes', 'kaun dega', 'customer owe', 'top customer', 'biggest customer', 'kis customer', 'receivable from', 'owes the most', 'how much does', 'owe us', 'pay us', 'owes us'],
    keywords: ['owes', 'owe', 'owed', 'customer', 'customers', 'dega'],
    handler: (s, n) => {
      const top = s.ar.topCustomers;
      const stop = new Set(['who', 'owes', 'owe', 'owed', 'customer', 'the', 'most', 'dega', 'kaun', 'from', 'receivable', 'how', 'much', 'does', 'us', 'kitna', 'kis']);
      const tokens = n.trim().split(' ').filter((t) => t.length >= 3 && !stop.has(t));
      let match: CustomerAr | null = null, score = 0;
      for (const c of top) {
        const lab = ' ' + c.customer.toLowerCase() + ' ';
        let sc = 0;
        for (const t of tokens) if (lab.includes(t)) sc += t.length;
        if (sc > score) { score = sc; match = c; }
      }
      if (match && score > 0) {
        return {
          title: `${match.customer} owes ${money(match.open)}.`,
          lines: [
            `Based on how they've paid before, we expect ${money(match.collectible)} of that to actually come in (${pct(match.collectibility)} of the balance).`,
          ],
          note: SOURCE.ar_lt,
        };
      }
      const total = top.reduce((a, b) => a + b.open, 0);
      return {
        title: `Your Little Tree customers owe ${money(total)} in total. The biggest are:`,
        lines: top.slice(0, 10).map((c, i) => `• ${i + 1}. ${c.customer}: ${money(c.open)}`),
        note: `Ask "how much does <name> owe" for any one. ${SOURCE.ar_lt}`,
      };
    },
  },
  {
    id: 'ar_total',
    phrases: ['total ar', 'total receivable', 'total receivables', 'how much ar', 'kitna receivable', 'total owed to us', 'accounts receivable total', 'how much do people owe'],
    keywords: ['receivable', 'receivables', 'ar'],
    handler: (s) => {
      const ltOpen = s.ar.topCustomers.reduce((a, b) => a + b.open, 0);
      return {
        title: `People owe you ${money(ltOpen + s.gelato.net)} in total right now.`,
        lines: [
          `• Little Tree customers: ${money(ltOpen)} on the books. After trimming older/risky invoices, we expect ${money(s.ar.projected13w)} to come in over 13 weeks.`,
          `• Gelato: ${money(s.gelato.net)} still to collect.`,
        ],
        note: SOURCE.ar_lt,
      };
    },
  },
  {
    id: 'collect_from',
    phrases: ['who to collect', 'who should i chase', 'kisse paisa', 'kis se paisa', 'kisse paise', 'paisa kis se', 'kis se le', 'vasooli', 'collect from', 'chase payment', 'follow up', 'recover money', 'paise kaun dega', 'kaun dega paisa', 'whom to call', 'collection priority', 'easy collections', 'low hanging'],
    keywords: ['collect', 'chase', 'vasooli', 'recover'],
    handler: (s) => {
      const chase = s.collections.chase;
      if (chase.length === 0) return { title: `Nothing to chase right now.`, lines: [`No open Little Tree receivables - it's all collected.`] };
      // Overdue vs each customer's OWN pay history first, then largest collectible.
      const ranked = [...chase].sort((a, b) => {
        const aOver = (a.overdueBy ?? -999) > 5 ? 1 : 0, bOver = (b.overdueBy ?? -999) > 5 ? 1 : 0;
        if (aOver !== bOver) return bOver - aOver;
        return b.collectible - a.collectible;
      }).slice(0, 12);
      const lines = ranked.map((c) => {
        const bits = [`${c.customer}: ${money(c.collectible)}`];
        if (c.usualPayDays != null) {
          bits.push((c.overdueBy ?? 0) > 5
            ? `usually pays in ~${c.usualPayDays}d, now ${c.daysOldest}d - overdue by ${c.overdueBy}d, chase now`
            : `usually pays in ~${c.usualPayDays}d, at ${c.daysOldest}d`);
        } else bits.push(`${c.daysOldest}d outstanding`);
        if (c.expectedWeek != null) bits.push(`expected ~wk ${c.expectedWeek}`);
        return `• ${bits.join(' · ')}`;
      });
      const overdue = ranked.filter((c) => (c.overdueBy ?? 0) > 5);
      const overdueTot = overdue.reduce((t, c) => t + c.collectible, 0);
      return {
        title: overdue.length
          ? `Chase these first - ${money(overdueTot)} from ${overdue.length} customer${overdue.length > 1 ? 's' : ''} past their usual pay timing:`
          : `Top receivables to collect:`,
        lines,
        note: `"Usually pays in Nd" = each customer's median from their paid history. Well past it = easiest wins to call. Sorted by overdue-vs-their-own-norm, then size.`,
      };
    },
  },
  {
    id: 'aging',
    phrases: ['aging', 'ageing', 'net 30', 'net 60', 'net 90', 'past due', 'overdue invoices', 'how overdue', 'kitne din se', 'kitne din ho gaye', 'days outstanding', 'invoices overdue', 'old invoices', 'invoice net', 'crossed net'],
    keywords: ['aging', 'ageing', 'overdue'],
    handler: (s) => {
      const a = s.collections.aging;
      if (a.total <= 0) return { title: `No open receivables to age right now.`, lines: [`It's all collected.`] };
      const pastNet30 = a.d31_60 + a.d61_90 + a.d90plus;
      const pastNet60 = a.d61_90 + a.d90plus;
      return {
        title: `AR aging on ${money(a.total)} outstanding:`,
        lines: [
          `• Current (0-30 days): ${money(a.d0_30)} (${pct(a.d0_30 / a.total)})`,
          `• Past Net 30 (31-60 days): ${money(a.d31_60)} (${pct(a.d31_60 / a.total)})`,
          `• Past Net 60 (61-90 days): ${money(a.d61_90)} (${pct(a.d61_90 / a.total)})`,
          `• Past Net 90 (90+ days): ${money(a.d90plus)} (${pct(a.d90plus / a.total)})`,
          `${money(pastNet30)} has crossed Net 30 and ${money(pastNet60)} crossed Net 60 - that's what needs chasing. Ask "who to collect from" for the priority list.`,
        ],
        note: `Age = today minus each invoice's date (non-Gelato AR).`,
      };
    },
  },
  {
    id: 'sales_forecast',
    phrases: ['projected sales', 'new sales', 'sales forecast', 'future sales', 'expected sales', 'sales projection', 'naya sales', 'new business', 'sales coming'],
    keywords: ['forecast', 'projected', 'projection'],
    handler: (s) => {
      if (!s.sales) return { title: `The sales forecast isn't available right now.`, lines: [`The forecast engine returned nothing - the underlying sales sheet may be loading.`] };
      return {
        title: `New sales should bring in about ${money(s.sales.base)} of cash over the next 13 weeks.`,
        lines: [
          `• Little Tree: ${money(s.sales.little_tree)}`,
          `• Private Label: ${money(s.sales.private_label)}`,
          `• Gelato: ${money(s.sales.gelato)}`,
          `If business runs hot it could be ${money(s.sales.best)}; if it's slow, around ${money(s.sales.worst)}.`,
          `This is brand-new invoices that don't exist yet - separate from the money customers already owe you.`,
        ],
        note: SOURCE.sales,
      };
    },
  },
  {
    id: 'effect_no_ar',
    phrases: ['if money doesnt come', 'agar paisa nahi aaya', 'if customers dont pay', 'if ar doesnt come', 'collections dont come', 'paisa nahi aaya', 'customers pay late', 'no collections', 'what happens if we dont collect', 'if nobody pays'],
    keywords: ['late', 'dont', 'nahi'],
    handler: (s) => {
      // Remove the two existing-invoice collection rows, keep new-sales, re-roll.
      const arRows = s.inflows.filter((l) => /collections/i.test(l.label) && !/new sales/i.test(l.label));
      const arSeries = s.weeks.map((_, i) => arRows.reduce((sum, l) => sum + (l.values[i] ?? 0), 0));
      const without = s.weeks.map((_, i) => (s.totals.inflows[i] ?? 0) - arSeries[i]);
      const newClosing = rollClosing(s, without);
      const neg = newClosing.findIndex((c) => c < 0);
      const minC = Math.min(...newClosing);
      const arTotal = arSeries.reduce((a, b) => a + b, 0);
      const baseTail = s.totals.closingCash[s.totals.closingCash.length - 1];
      return {
        title: `If none of the money customers owe you came in, it would hurt - here's how much.`,
        lines: [
          `Those collections are worth about ${money(arTotal)} over 13 weeks (Gelato + Little Tree invoices).`,
          `Without them, week-13 cash drops from ${money(baseTail)} to ${money(newClosing[newClosing.length - 1])}, and the low point would be ${money(minC)}.`,
          neg >= 0 ? `Cash would actually go negative around ${weekName(s, neg)} - that's the real risk if collections stall.` : `Even then cash stays positive, but the cushion gets much thinner.`,
          `The takeaway: chasing these collections on time is what keeps the plan healthy.`,
        ],
        note: `Modelled by removing the existing-invoice collections and re-rolling the weekly cash. ${SOURCE.closing}`,
      };
    },
  },
  {
    id: 'sales_scenario',
    phrases: ['if sales', 'agar sales', 'sales badhao', 'sales badhe', 'sales badh', 'increase sales', 'sales double', 'sales dugna', 'sales up', 'sales grow', 'more sales', 'sales drop', 'sales fall', 'sales gir', 'sales kam', 'sales se collection', 'collection if sales', 'weekly collection if sales', 'sales badhne'],
    keywords: ['sales'],
    handler: (s, n) => {
      let shock = extractScenario(n);
      if (shock == null && /\b(double|dugna|twice|2x)\b/.test(n)) shock = 100;
      if (shock == null && /\b(half|aadha|2x down)\b/.test(n)) shock = -50;
      if (shock == null) {
        return { title: `By how much should sales change?`, lines: [`E.g. "if sales go up 20%" or "if sales double" - I'll show how much extra actually COLLECTS in each week and how cash moves. (~${pct(s.scenarioData.sameWeekRate)} of each week's sales lands the same week, the rest collects over the following weeks.)`] };
      }
      const sd = s.scenarioData;
      const factor = shock / 100;
      const delta = sd.salesWeekly.map((v) => v * factor);
      const rate = sd.sameWeekRate;
      const tail = sd.lagCurve.length > 1 ? sd.lagCurve.slice(1) : [1];
      const tsum = tail.reduce((a, b) => a + b, 0) || 1;
      const lagged = tail.map((v) => v / tsum);
      const W = s.weeks.length;
      const collDelta = new Array(W).fill(0);
      for (let w = 0; w < W; w++) {
        collDelta[w] += (delta[w] ?? 0) * rate;
        for (let j = 0; j < lagged.length && w + 1 + j < W; j++) collDelta[w + 1 + j] += (delta[w] ?? 0) * (1 - rate) * lagged[j];
      }
      const newClosing = rollClosing(s, s.totals.inflows.map((v, i) => v + collDelta[i]));
      const extra13 = collDelta.reduce((a, b) => a + b, 0);
      const salesDelta13 = delta.reduce((a, b) => a + b, 0);
      const baseTail = s.totals.closingCash[s.totals.closingCash.length - 1];
      const newTail = newClosing[newClosing.length - 1];
      const dir = shock > 0 ? 'up' : 'down', more = shock > 0 ? 'more' : 'less';
      return {
        title: `If sales go ${dir} ${Math.abs(shock)}% (${money(Math.abs(salesDelta13))} over 13 weeks), about ${money(Math.abs(extra13))} ${more} actually collects in:`,
        lines: [
          `Extra collection by week: ${collDelta.slice(0, 8).map((v, i) => `Wk${i + 1} ${money(v)}`).join(' · ')} …`,
          `Why: ~${pct(rate)} of each week's sales lands the SAME week; the other ~${pct(1 - rate)} collects over the following weeks (your real lag curve).`,
          `Week-13 cash would be ${money(newTail)} vs ${money(baseTail)} now - a change of ${money(newTail - baseTail)}.`,
        ],
        note: `Live maths on your own same-week rate (${pct(rate)}) + collection lag curve - same model the 13-week uses.`,
      };
    },
  },
  {
    id: 'scenario',
    phrases: ['what if', 'agar', 'scenario', 'collections drop', 'collections lower', 'if collections', 'suppose', 'maan lo', 'collections gir'],
    keywords: ['whatif', 'agar', 'suppose', 'scenario'],
    handler: (s, n) => {
      const shock = extractScenario(n);
      if (shock == null) {
        return { title: `Tell me the change and I'll run it.`, lines: [`For example: "what if sales drop 20%" or "what if collections are 15% lower". I'll re-run the 13-week cash and show the impact.`] };
      }
      const factor = 1 + shock / 100;
      const newClosing = rollClosing(s, s.totals.inflows.map((v) => v * factor));
      const baseTail = s.totals.closingCash[s.totals.closingCash.length - 1];
      const newTail = newClosing[newClosing.length - 1];
      const neg = newClosing.findIndex((c) => c < 0);
      const minC = Math.min(...newClosing);
      return {
        title: `If money coming in is ${shock > 0 ? 'up' : 'down'} ${Math.abs(shock)}%, here's what happens:`,
        lines: [
          `Week-13 cash would be ${money(newTail)} instead of ${money(baseTail)} - a difference of ${money(newTail - baseTail)}.`,
          `The lowest point in the plan would be ${money(minC)}.`,
          neg >= 0 ? `Cash would dip negative around ${weekName(s, neg)} under this scenario - worth planning for.` : `Cash still stays positive the whole way through.`,
        ],
        note: `Applies the change evenly to money coming in and re-rolls the weekly cash from today's bank balance.`,
      };
    },
  },
  {
    id: 'min_cash',
    phrases: ['lowest cash', 'minimum cash', 'sabse kam cash', 'tightest week', 'worst week', 'lowest point', 'kab kam', 'most risky week'],
    keywords: ['lowest', 'minimum', 'tightest'],
    handler: (s) => ({
      title: `Your tightest week is ${weekName(s, s.runway.minClosingIdx)}, when cash dips to about ${money(s.runway.minClosing)}.`,
      lines: [`That's the moment to be careful - try not to schedule any big payment right around then.`],
      note: SOURCE.closing,
    }),
  },
  {
    id: 'expense_cut',
    phrases: ['kahan kharcha kam', 'where to cut', 'cut costs', 'cut cost', 'reduce expenses', 'kharcha kam', 'save on expenses', 'reduce spending', 'cut expenses', 'where can i save', 'cost cutting', 'trim costs', 'kahan se kam', 'kaha kam karu', 'reduce cost', 'lower expenses'],
    keywords: ['cut', 'reduce', 'trim'],
    handler: (s) => {
      const ranked = s.outflows
        .map((l) => ({ label: l.label, t: l.values.reduce((a, b) => a + b, 0) }))
        .filter((x) => x.t > 0).sort((a, b) => b.t - a.t);
      const isDiscretionary = (lab: string) => /software|subscription|other|travel|meals|marketing/i.test(lab);
      const disc = ranked.filter((x) => isDiscretionary(x.label));
      const discTot = disc.reduce((a, b) => a + b.t, 0);
      const lines = ranked.map((x) => `• ${x.label}: ${money(x.t)} over 13w${isDiscretionary(x.label) ? ' (discretionary - easiest to trim)' : ' (mostly fixed)'} - 10% off = ${money(x.t * 0.1)}`);
      return {
        title: `Where to cut - biggest levers first:`,
        lines: [
          ...lines,
          `Quick win: a 15% trim on the discretionary lines (${disc.map((d) => d.label).join(', ') || 'Software, Other'}) frees about ${money(discTot * 0.15)} over 13 weeks - straight onto your closing cash.`,
        ],
        note: `Payroll, Inventory, COGS and Rent are mostly fixed; Software/Subscriptions, Other, Travel & Marketing are the easiest cuts. ${SOURCE.expenses}`,
      };
    },
  },
  {
    id: 'cash_save',
    phrases: ['cash kaise bachau', 'how to improve cash', 'improve cashflow', 'improve cash flow', 'save cash', 'cash badhau', 'how to save money', 'increase cash', 'runway badhau', 'extend runway', 'cash kaise badhe', 'protect cash', 'how do i save cash', 'kaise bachau', 'cash kaise badhau', 'strengthen cash'],
    keywords: ['improve', 'extend', 'strengthen', 'bachau'],
    handler: (s) => {
      const overdue = s.collections.chase.filter((c) => (c.overdueBy ?? 0) > 5);
      const overdueTot = overdue.reduce((t, c) => t + c.collectible, 0);
      const disc = s.outflows.filter((l) => /software|subscription|other|travel|meals|marketing/i.test(l.label)).reduce((t, l) => t + l.values.reduce((a, b) => a + b, 0), 0);
      const lines = [
        `1. Collect: ${money(overdueTot)} is overdue from ${overdue.length} customer${overdue.length === 1 ? '' : 's'} past their usual pay timing - the fastest cash. Ask "who to collect from" for the call list.`,
        `2. Trim: discretionary spend (Software, Other, Travel, Marketing) is ${money(disc)} over 13 weeks - a 15% cut frees ${money(disc * 0.15)}.`,
        `3. Time it: tightest week is ${weekName(s, s.runway.minClosingIdx)} at ${money(s.runway.minClosing)} - avoid big payments right around then.`,
      ];
      if (s.runway.negativeWeekIdx != null) lines.push(`⚠ Cash dips negative around ${weekName(s, s.runway.negativeWeekIdx)} - the collections in step 1 are what keep you out of the red.`);
      else lines.push(`Cash stays positive throughout if those collections land on time.`);
      return {
        title: `Here's how to strengthen cash over the next 13 weeks:`,
        lines,
        note: `Built live from your collections, expenses and weekly closing-cash numbers.`,
      };
    },
  },
  {
    id: 'status',
    phrases: ['how are we doing', 'financial health', 'are we healthy', 'are we okay', 'kaise chal raha', 'overall health', 'summary', 'overview', 'how is cashflow', 'snapshot', 'big picture'],
    keywords: ['health', 'healthy', 'summary', 'overview', 'snapshot'],
    handler: (s, _n, user) => {
      const crit = s.totals.status.filter((x) => x === 'CRITICAL').length;
      const tail = s.totals.closingCash[s.totals.closingCash.length - 1];
      const verdict = s.runway.negativeWeekIdx != null
        ? `cash gets tight and dips negative around ${weekName(s, s.runway.negativeWeekIdx)} - needs attention`
        : crit > 0 ? `mostly healthy, with ${crit} tight week${crit > 1 ? 's' : ''} to watch`
        : `healthy - cash stays positive the whole way through`;
      const fn = firstName(user);
      // Future Gelato = the collections row (the overdue part is already folded
      // into opening cash). Use the row, not gelato.net - dfp, so it stays right
      // even if QB (which supplies dfp) is momentarily down.
      const gRow = s.inflows.find((l) => /gelato ar collections/i.test(l.label));
      const futureGelato = gRow ? gRow.values.reduce((a, b) => a + b, 0) : s.gelato.net;
      return {
        title: `${fn ? fn + ', here' : 'Here'}'s the quick picture: ${verdict}.`,
        lines: [
          `• Cash on hand: ${money(s.cash.openingCash)} (net of card debt: ${money(s.cash.netCash)})`,
          `• Next 13 weeks: ${money(s.inflow13w)} coming in, ${money(s.outflow13w)} going out`,
          `• Projected cash by week 13: ${money(tail)}; tightest point ${money(s.runway.minClosing)} at ${weekName(s, s.runway.minClosingIdx)}`,
          `• Still to collect: ${money(futureGelato)} more from Gelato + ${money(s.ar.projected13w)} from Little Tree customers`,
        ],
        note: `Pulled live from your bank (Tiller), QuickBooks and the invoice sheets as of ${s.anchor}.`,
      };
    },
  },
  {
    id: 'subscriptions',
    phrases: ['subscriptions', 'subscription', 'software subscription', 'subscription audit', 'recurring software', 'saas', 'which subscriptions', 'subscription list', 'tools we pay for', 'dormant subscription'],
    keywords: ['subscriptions', 'saas'],
    handler: (s) => {
      const sub = s.outflows.find((l) => /subscription/i.test(l.label));
      const weekly = sub ? sub.values.reduce((a, b) => a + b, 0) / 13 : 0;
      return {
        title: weekly > 0 ? `Software & subscriptions run about ${money(weekly)}/week (~${money(weekly * 4.33)}/month).` : `Here are your software subscriptions.`,
        lines: [`The full active-vs-dormant list - which tools you pay for, monthly cost, and which look unused - is on the Expenses tab under "Subscriptions".`],
        note: `Active = QuickBooks activity in the last 4 months; dormant ones are flagged so you can cancel them.`,
      };
    },
  },
  {
    id: 'expenses_detail',
    phrases: ['expenses page', 'expense breakdown', 'expense detail', 'detailed expenses', 'purex expenses', 'moysh expenses', 'combined expenses', 'expenses tab', 'all expenses', 'expense categories', 'kharch detail', 'kharcha breakdown'],
    keywords: [],
    handler: (s) => ({
      title: `Your full expense breakdown is on the Expenses tab.`,
      lines: [
        `• Combined - PureX + Moysh totals by category`,
        `• PureX / Moysh - each entity on its own`,
        `• Monthly LT vs PureX - month-by-month split`,
        `• Subscriptions - active vs dormant software`,
        `Next 13 weeks total spend is about ${money(s.outflow13w)} (~${money(s.outflow13w / 13)}/week).`,
      ],
      note: SOURCE.expenses,
    }),
  },
  {
    id: 'pnl',
    phrases: ['profit and loss', 'profit loss', 'income statement', 'p and l', 'p l', 'pnl', 'net income', 'are we profitable', 'profitable', 'profit'],
    keywords: ['pnl', 'profit'],
    handler: () => ({
      title: `Your live Profit & Loss (income statement) is on the Reports tab.`,
      lines: [`Revenue, cost of goods, expenses and net profit - pulled live from QuickBooks on a cash basis.`],
      note: `Reports tab → "LT P&L".`,
    }),
  },
  {
    id: 'balance_sheet',
    phrases: ['balance sheet', 'assets and liabilities', 'assets liabilities', 'balance sheet report'],
    keywords: ['assets', 'liabilities'],
    handler: () => ({
      title: `Your live Balance Sheet is on the Reports tab.`,
      lines: [`Assets, liabilities and equity - including the Due From PureX intercompany line - live from QuickBooks.`],
      note: `Reports tab → "Balance Sheet".`,
    }),
  },
  {
    id: 'bank_transactions',
    phrases: ['bank transactions', 'bank txns', 'bank activity', 'transactions in bank', 'bank statement', 'what hit the bank', 'bank ledger'],
    keywords: [],
    handler: () => ({
      title: `Every bank transaction is on the Reports tab.`,
      lines: [`All activity across your business bank accounts, live from Tiller - under "Bank Transactions".`],
      note: `Reports tab → "Bank Transactions".`,
    }),
  },
  {
    id: 'cc_transactions',
    phrases: ['credit card transactions', 'card transactions', 'card activity', 'card spending detail', 'cc txns', 'card ledger'],
    keywords: [],
    handler: () => ({
      title: `Every credit-card transaction is on the Reports tab.`,
      lines: [`All charges across your corporate cards, live from Tiller - under "Credit Card Transactions".`],
      note: `Reports tab → "Credit Card Transactions".`,
    }),
  },
  {
    id: 'reconciliation',
    phrases: ['reconciliation', 'reconcile', 'qb vs tiller', 'books vs bank', 'reco', 'matching transactions', 'does it reconcile'],
    keywords: ['reconcile', 'reconciliation', 'reco'],
    handler: () => ({
      title: `The QuickBooks vs Tiller reconciliation is on the Reports tab.`,
      lines: [`It matches your books (QuickBooks) against the bank (Tiller) so you can spot anything that doesn't line up.`],
      note: `Reports tab → "Reconciliation".`,
    }),
  },
  {
    id: 'sales_by_product',
    phrases: ['sales by product', 'product sales', 'which product sells', 'top products', 'best selling', 'sales per product', 'best product'],
    keywords: ['product', 'products'],
    handler: () => ({
      title: `Sales broken down by product is on the Reports tab.`,
      lines: [`See which products drive your revenue - under "Sales by Product".`],
      note: `Reports tab → "Sales by Product".`,
    }),
  },
  {
    id: 'upflow',
    phrases: ['upflow', 'collections tool', 'dunning', 'chase invoices', 'payment reminders', 'invoice reminders', 'follow up invoices', 'who to chase', 'collection reminders', 'reminders sent', 'payment plans', 'chase customers'],
    keywords: ['upflow', 'dunning', 'reminders'],
    handler: () => ({
      title: `Upflow is your collections tool - it chases unpaid invoices for you.`,
      lines: [
        `It tracks open invoices, sends payment reminders, logs customer replies, runs dunning workflows and payment plans, and records payments.`,
        `It's the "Upflow" tab in the sidebar - with Overview, Invoices, Customers, Reminders, Replies, Workflows, Payments and Team.`,
      ],
      note: `Use it to see who to chase and what reminders have gone out.`,
    }),
  },
  {
    id: 'dashboard_tour',
    phrases: ['what can you show', 'what is in the dashboard', 'whats in the dashboard', 'dashboard overview', 'show me everything', 'what sections', 'what tabs', 'whole dashboard', 'give me a tour', 'what pages', 'navigate the dashboard', 'poora dashboard', 'kya kya hai dashboard'],
    keywords: ['tour'],
    handler: () => ({
      title: `Here's the whole dashboard - four areas in the sidebar:`,
      lines: [
        `• Cash Flow - Current Position (cash, cards, Gelato AR, net liquidity), live Cash Flow KPIs, and the 13-Week Plan.`,
        `• Expenses - Combined / PureX / Moysh breakdowns, Monthly LT vs PureX, and Subscriptions.`,
        `• Reports - LT P&L, Balance Sheet, Bank & Credit-Card transactions, Reconciliation, and Sales by Product.`,
        `• Upflow - your collections tool: invoices, reminders, replies, workflows and payments.`,
        `Ask me about any of these, or say "show me ..." and I'll walk you there.`,
      ],
    }),
  },
  {
    id: 'explain',
    phrases: ['where does', 'where do these', 'how is this calculated', 'how do you calculate', 'kaise nikla', 'kaise aaya', 'data kaha se', 'how is the number', 'how did you get', 'source of', 'how computed', 'kahan se aaya', 'is number ka source'],
    keywords: ['explain', 'calculate', 'calculated', 'source'],
    handler: (s, n) => {
      const topic =
        /gelato|purex/.test(n) ? 'ar_gelato'
        : /payroll|expense|spend|kharch|cost|inventory|subscription/.test(n) ? 'expenses'
        : /sales|forecast/.test(n) ? 'sales'
        : /card|cc/.test(n) ? 'cc'
        : /closing|runway|week/.test(n) ? 'closing'
        : /ar|receivable|owe|customer|collection/.test(n) ? 'ar_lt'
        : /cash|bank|balance/.test(n) ? 'cash'
        : null;
      if (topic) return { title: `Here's exactly where that comes from:`, lines: [SOURCE[topic as keyof typeof SOURCE]], note: `Nothing is estimated by hand - it's all pulled from your live sources.` };
      return {
        title: `Here's where each part of the dashboard comes from:`,
        lines: [
          `• Cash: ${SOURCE.cash}`,
          `• Credit cards: ${SOURCE.cc}`,
          `• Little Tree AR: ${SOURCE.ar_lt}`,
          `• Gelato AR: ${SOURCE.ar_gelato}`,
          `• Expenses: ${SOURCE.expenses}`,
          `• New sales: ${SOURCE.sales}`,
          `• Weekly closing cash: ${SOURCE.closing}`,
        ],
      };
    },
  },
];

const SUGGESTIONS = [
  'How are we doing?',
  'What changed since yesterday?',
  'How much cash do we have?',
  'What is our runway?',
  'Who owes us the most?',
  'Biggest expense?',
  'What if customers pay late?',
  'Where does the Gelato number come from?',
];

export function routeQuestion(snap: FinancialSnapshot, question: string, user?: User): AssistantAnswer {
  const n = norm(question);
  let best: Intent | null = null, bestScore = 0;
  for (const intent of INTENTS) {
    let score = 0;
    for (const p of intent.phrases) if (n.includes(p)) score += 5 + p.length * 0.15;
    for (const k of intent.keywords) if (n.includes(' ' + k + ' ')) score += 2;
    if (score > bestScore) { bestScore = score; best = intent; }
  }

  if (!best || bestScore < 2) {
    // Breadth fallback: explain any metric from the knowledge registry.
    const kb = findKbMetric(n);
    if (kb) {
      const lines = [kb.definition];
      if (kb.formula) lines.push(`How it's worked out: ${kb.formula}`);
      if (kb.affects && kb.affects.length) lines.push(`If it moves, it changes: ${kb.affects.slice(0, 4).join(', ').replace(/_/g, ' ')}.`);
      return {
        intent: 'kb:' + kb.id, confidence: 0.5,
        title: kb.label.split('/')[0].trim(),
        lines,
        note: kb.source ? `Where it comes from: ${kb.source}` : undefined,
        suggestions: SUGGESTIONS.slice(0, 4),
      };
    }
    const fn = firstName(user);
    return {
      intent: 'fallback',
      confidence: 0,
      title: `${fn ? fn + ', I' : 'I'} didn't quite catch that one.`,
      lines: [`I answer from your live cashflow numbers. Try one of these, or rephrase:`, ...SUGGESTIONS.map((x) => `• ${x}`)],
      suggestions: SUGGESTIONS.slice(0, 4),
    };
  }

  let ans: Answer;
  try {
    ans = best.handler(snap, n, user);
  } catch (e) {
    ans = { title: `I hit a snag reading that.`, lines: [`The data may still be loading - give it a moment and ask again.`], note: e instanceof Error ? e.message : undefined };
  }

  // Attach the UI location so the frontend can offer "show me", and if the user
  // explicitly asked where it is, lead with the location.
  const loc = INTENT_LOCATION[best.id];
  let lines = ans.lines;
  if (loc && wantsLocation(n)) lines = [`📍 On the dashboard: ${loc.where}.`, ...lines];

  const suggestions = SUGGESTIONS.filter((x) => norm(x).indexOf(best!.id.split('_')[0]) === -1).slice(0, 4);
  const warning = snap.health.qbDown && QB_DEPENDENT.has(best.id)
    ? `QuickBooks is disconnected right now, so expense and intercompany data (like Due From PureX) is missing. That makes cash look higher than it really is - reconnect QuickBooks for accurate numbers.`
    : undefined;
  return { intent: best.id, confidence: Math.min(1, bestScore / 10), title: ans.title, lines, note: ans.note, warning, nav: loc, suggestions };
}

export async function askAssistant(question: string, user?: User, sinceISO?: string): Promise<AssistantAnswer & { asOf: string }> {
  const snap = await buildSnapshot();
  let result: AssistantAnswer;
  if (isWhatChanged(norm(question))) {
    const ans = await getChangesAnswer(sinceISO);
    result = { intent: 'what_changed', title: ans.title, lines: ans.lines, note: ans.note, confidence: 1, suggestions: SUGGESTIONS.filter((s) => !/changed/i.test(s)).slice(0, 4) };
  } else {
    result = routeQuestion(snap, question, user);
  }
  // Log every Q&A to Supabase so the bot has a real conversation history to
  // learn from / analyse (what people ask, what got answered, confidence).
  void dbInsert('bot_conversations', {
    user_name: user?.name ?? '',
    question: question.slice(0, 500),
    intent: result.intent,
    answer_title: result.title.slice(0, 300),
    confidence: result.confidence,
  });
  return { ...result, asOf: snap.asOf };
}
