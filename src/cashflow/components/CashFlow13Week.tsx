import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
 fetchCashflow13, fetchCashflowOverrides, saveCashflowOverrides,
 fetchCurrentMonthOverview, fetchPastWeeksGrid,
 type Cashflow13, type CashflowSource, type CashflowStatus, type CashflowOverrides,
 type CashflowLine, type CurrentMonthOverview, type PastWeeksGridResponse,
 type PastWeeksGridItem, type WeekActuals,
} from '../api';
import { CollapsibleSection } from './CollapsibleSection';
import InfoTip from '../../ar/dashboard/components/InfoTip.jsx';
import { formatCurrency, formatSigned } from '../format';

// Plain-language "how is this number computed" explainers, shown as a round ⓘ
// next to each inflow / outflow row (matches the AR dashboard's info buttons).
const ROW_INFO: Record<string, { title: string; purpose: string; detail: string; source: string }> = {
 // --- Inflows ---
 'Gelato AR Collections (Net 97)': {
 title: 'Gelato AR Collections (Net 97)',
 purpose: 'Gelato batch money we expect to collect, week by week.',
 detail: 'Each PENDING Gelato batch invoice (from the Gelato Sales / Batches sheet) is placed in the week it should be collected = invoice issue date + 97 days (Net 90 + a 7-day payment buffer). Any batch already past due lands in Week 1. Adding up those placements per week gives this row.',
 source: 'Gelato Sales / Batches sheet (pending batch invoices).',
 },
 'Little Tree AR Collections (lag-curve)': {
 title: 'Little Tree AR Collections (lag-curve)',
 purpose: 'Expected weekly collections from open Little Tree (non-Gelato) invoices.',
 detail: 'Every open non-Gelato invoice in the Invoice Tracker is spread across the 13 weeks using that customer’s own historical pay-day pattern (median days-to-pay ± spread, learned from their past paid invoices). Overdue invoices are pulled into Week 1; not-yet-due ones land in their expected week. The per-week totals make up this row.',
 source: 'Invoice Tracker (open invoices) + each customer’s paid-history timing.',
 },
 'Projected AR from new sales (3-bucket)': {
 title: 'Projected AR from new sales (3-bucket)',
 purpose: 'Cash from NEW sales not yet invoiced (separate from the open invoices above).',
 detail: 'A forward sales forecast across three buckets - Little Tree, Private Label and Gelato - each projected from the recent sales run-rate, then spread into weeks by that bucket’s typical collection lag. These are brand-new invoices that don’t exist yet, so there’s no double-count with the AR collection rows. The Worst / Base / Best buttons flex this row ±18%.',
 source: 'Sales forecast (recent per-bucket run-rate + collection lag).',
 },
 // --- Outflows ---
 'Inventory & Raw Materials': {
 title: 'Inventory & Raw Materials',
 purpose: 'Weekly spend on inventory / raw materials.',
 detail: 'Last-3-month average of the COGS / raw-material expense accounts in QuickBooks ÷ 4.33, spread level across all 13 weeks.',
 source: 'QuickBooks expense detail (COGS / raw-material accounts).',
 },
 'Payroll': {
 title: 'Payroll',
 purpose: 'Weekly payroll outflow.',
 detail: 'Last-3-month average of the Payroll expense group in QuickBooks ÷ 4.33, spread level across all 13 weeks.',
 source: 'QuickBooks expense detail (Payroll group).',
 },
 'Software & Subscriptions': {
 title: 'Software & Subscriptions',
 purpose: 'Weekly software / subscription spend.',
 detail: 'Projected from the QuickBooks subscription audit (active recurring charges) as a per-week amount.',
 source: 'QuickBooks subscription audit (active recurring charges).',
 },
 'Other Expenses': {
 title: 'Other Expenses',
 purpose: 'All other weekly operating spend.',
 detail: 'Last-3-month average of every remaining operating-expense category (everything that isn’t payroll, inventory or subscriptions) ÷ 4.33, spread level across the 13 weeks.',
 source: 'QuickBooks expense detail (all other categories).',
 },
 'Credit Card Payments': {
 title: 'Credit Card Payments',
 purpose: 'Scheduled credit-card bill payments, week by week.',
 detail: 'Each business card’s real statement / due-date schedule places its payment in the week it falls due. Summing those due payments per week gives this row.',
 source: 'Per-card payment schedule (Tiller credit-card due dates).',
 },
};

function srcLabel(s: CashflowSource): string {
 return s === 'live' ? 'Live' : s === 'computed' ? 'Calc' : '-';
}
function srcTone(s: CashflowSource): string {
 return s === 'live' ? 'strong' : s === 'computed' ? 'fuzzy' : 'none';
}
function statusTone(s: CashflowStatus): string {
 return s === 'HEALTHY' ? 'strong' : s === 'TIGHT' ? 'warn' : 'none';
}

const POLL_INTERVAL_MS = 30_000;

type Direction = 'future' | 'past';
// Four user-facing tabs. 'budgeted' is the forward plan (direction=future);
// 'past' / 'actual' / 'variance' are three lenses on the SAME closed-week data
// (direction=past) - past = forecast+actual combined, actual = what really
// happened, variance = budget vs actual week-by-week.
type View = 'budgeted' | 'past' | 'actual' | 'variance';

export function CashFlow13Week() {
 const [view, setView] = useState<View>('budgeted');
 const direction: Direction = view === 'budgeted' ? 'future' : 'past';
 const [data, setData] = useState<Cashflow13 | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [overrides, setOverrides] = useState<CashflowOverrides | null>(null);
 const [savingOverrides, setSavingOverrides] = useState(false);
 const [editsBuffer, setEditsBuffer] = useState<Record<string, string>>({});
 // Per-cell what-if overrides - key = `${label}|${weekIdx}`, value = $ amount.
 // Persisted to localStorage so the CFO's edits survive page reloads until
 // they hit "Reset". These layer on top of the live data without changing
 // backend state, so a refresh of the underlying QB numbers won't blow them
 // away. Phase 2: lift this to backend so the whole team sees the scenario.
 const [cellOverrides, setCellOverrides] = useState<Record<string, number>>({});
 const [editingCell, setEditingCell] = useState<
   { label: string; weekIdx: number; current: number } | null
 >(null);
 const [salesScenario, setSalesScenario] = useState<'worst' | 'base' | 'best'>('base');
 // Row whose breakdown modal ("what's included") is open.
 const [breakdownLine, setBreakdownLine] = useState<CashflowLine | null>(null);
 const [monthOverview, setMonthOverview] = useState<CurrentMonthOverview | null>(null);
 // Future cashflow ALWAYS fetched alongside past, so the past view can use
 // LIVE Wk1 projection (latest methodology) for the in-progress current week
 // instead of the stale Monday-morning snapshot value.
 const [futureData, setFutureData] = useState<Cashflow13 | null>(null);
 const [pastGrid, setPastGrid] = useState<PastWeeksGridResponse | null>(null);

 async function load(refresh = false, silent = false, dir: Direction = direction) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 const d = await fetchCashflow13({ refresh, direction: dir });
 setData(d);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed to load');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 // Hydrate cell-overrides from localStorage once on mount.
 useEffect(() => {
   try {
     const raw = window.localStorage.getItem('cf13-cell-overrides');
     if (raw) {
       const parsed = JSON.parse(raw);
       if (parsed && typeof parsed === 'object') setCellOverrides(parsed);
     }
   } catch { /* ignore corrupt storage */ }
 }, []);

 // Persist overrides whenever they change.
 useEffect(() => {
   try {
     if (Object.keys(cellOverrides).length === 0) {
       window.localStorage.removeItem('cf13-cell-overrides');
     } else {
       window.localStorage.setItem('cf13-cell-overrides', JSON.stringify(cellOverrides));
     }
   } catch { /* storage full / blocked - skip silently */ }
 }, [cellOverrides]);

 useEffect(() => {
 load(false, false, direction);
 if (direction === 'future') {
 fetchCashflowOverrides().then(setOverrides).catch(() => { /* silent */ });
 }
 if (direction === 'past') {
 fetchCurrentMonthOverview().then(setMonthOverview).catch(() => setMonthOverview(null));
 // Pull future-direction Wk1 numbers so PastCashflowTable can show the
 // CURRENT methodology's projection for the in-progress week.
 fetchCashflow13({ direction: 'future' }).then(setFutureData).catch(() => setFutureData(null));
 // Calendar-based past weeks (every Monday back, even without snapshot)
 // - this is what populates the past cashflow table so weeks without a
 // captured snapshot still show their actuals.
 fetchPastWeeksGrid(13).then(setPastGrid).catch(() => setPastGrid(null));
 }
 const poll = window.setInterval(() => load(false, true, direction), POLL_INTERVAL_MS);
 const onFocus = () => load(false, true, direction);
 window.addEventListener('focus', onFocus);
 return () => {
 window.clearInterval(poll);
 window.removeEventListener('focus', onFocus);
 };
 }, [direction]);

 function bufferedValue(weekIdx: number): string {
 const key = `WK${String(weekIdx + 1).padStart(2, '0')}`;
 if (Object.prototype.hasOwnProperty.call(editsBuffer, key)) return editsBuffer[key];
 const v = overrides?.ccUtilisationByWeek[key];
 return v ? String(v) : '';
 }

 async function commitOverrides(nextMode?: 'manual' | 'auto') {
 if (!overrides) return;
 setSavingOverrides(true);
 try {
 const mergedMap: Record<string, number> = { ...overrides.ccUtilisationByWeek };
 for (const [k, v] of Object.entries(editsBuffer)) {
 const n = Number(v.replace(/[^0-9.-]/g, ''));
 if (!Number.isFinite(n) || n === 0) delete mergedMap[k];
 else mergedMap[k] = n;
 }
 const saved = await saveCashflowOverrides({
 mode: nextMode ?? overrides.mode,
 ccUtilisationByWeek: mergedMap,
 });
 setOverrides(saved);
 setEditsBuffer({});
 await load(true); // reload 13-week with new overrides
 } catch (e) {
 console.error('saveCashflowOverrides failed', e);
 } finally {
 setSavingOverrides(false);
 }
 }

 if (loading && !data) {
 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">13-Week Cash Flow</h1>
 <div className="page-sub">Building the lender-facing 13-week schedule…</div>
 </div>
 </div>
 </>
 );
 }

 if (error) {
 const isAuth = /not connected|invalid|authorize/i.test(error);
 return (
 <>
 <div className="page-head">
 <div><h1 className="page-title">13-Week Cash Flow</h1></div>
 </div>
 <div className="error">
 {error}
 {isAuth && (<><br /><strong>Reconnect:</strong> open <a href="/auth/connect">/auth/connect</a> to re-authorize QuickBooks.</>)}
 </div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const { weeks, inflows, outflows, totals, openingCashWk1, openingCashSource, assumptions, warnings } = data;

 // ── What-if cell overrides - derived helpers ──────────────────────────
 const overrideKey = (label: string, weekIdx: number) => `${label}|${weekIdx}`;
 const effectiveOutflow = (label: string, baseVal: number, weekIdx: number): number => {
   const ov = cellOverrides[overrideKey(label, weekIdx)];
   return typeof ov === 'number' ? ov : baseVal;
 };
 const hasOverride = (label: string, weekIdx: number) =>
   typeof cellOverrides[overrideKey(label, weekIdx)] === 'number';
 const hasAnyOverride = Object.keys(cellOverrides).length > 0;

 // Recompute inflow + outflow totals + net change + closing cash with the
 // active SCENARIO (sales best/base/worst) and any what-if cell overrides
 // applied. We DON'T touch backend `totals` - that stays as live truth; these
 // "adjusted" arrays drive EVERY downstream number (TOTAL INFLOWS / OUTFLOWS /
 // NET / CLOSING / STATUS + the KPI cards) so the CFO's scenario propagates
 // consistently. Previously the sales scenario only re-coloured the TOTAL
 // INFLOWS display row while closing cash, status and KPIs stayed on the base
 // case - so "Worst case" gave false comfort. Now it flows all the way through.
 const sfScenario = data.salesForecast;
 const projSalesIdx = inflows.findIndex((l) => /^projected sales/i.test(l.label));
 const adjustedInflowTotals = weeks.map((_, i) => {
   if (sfScenario && projSalesIdx >= 0 && salesScenario !== 'base') {
     const baseRow = inflows[projSalesIdx].values[i] ?? 0;
     const scenarioRow = (salesScenario === 'best' ? sfScenario.weeklyInflowBest[i] : sfScenario.weeklyInflowWorst[i]) ?? 0;
     return (totals.inflows[i] ?? 0) - baseRow + scenarioRow;
   }
   return totals.inflows[i] ?? 0;
 });
 const adjustedOutflowTotals = weeks.map((_, i) =>
   outflows.reduce((sum, line) => sum + effectiveOutflow(line.label, line.values[i] ?? 0, i), 0)
 );
 const adjustedNetChange = weeks.map((_, i) => adjustedInflowTotals[i] - adjustedOutflowTotals[i]);
 const adjustedClosingCash: number[] = [];
 {
   let running = openingCashWk1;
   for (let i = 0; i < weeks.length; i++) {
     running += adjustedNetChange[i];
     adjustedClosingCash.push(running);
   }
 }
 // ONE status definition for the whole UI, computed on the ADJUSTED position:
 // CRITICAL if closing < 1 week of (adjusted) burn, TIGHT if < 2 weeks, else
 // HEALTHY. Using the adjusted burn means cutting an outflow in a what-if also
 // relaxes the thresholds, instead of judging the new cash against the old burn.
 const adjustedWeekBurn = (adjustedOutflowTotals.reduce((s, v) => s + v, 0) || 0) / weeks.length;
 const adjustedStatus: CashflowStatus[] = adjustedClosingCash.map((c) =>
   c < adjustedWeekBurn ? 'CRITICAL' : c < adjustedWeekBurn * 2 ? 'TIGHT' : 'HEALTHY'
 );

 const peakInflowIdx = adjustedInflowTotals.indexOf(Math.max(...adjustedInflowTotals));
 const minClosing = Math.min(...adjustedClosingCash);
 const minClosingIdx = adjustedClosingCash.indexOf(minClosing);
 const adjustedInflowTotal13w = adjustedInflowTotals.reduce((s, v) => s + v, 0);
 const sum13InOut = adjustedInflowTotal13w - adjustedOutflowTotals.reduce((s, v) => s + v, 0);
 const criticalWeeks = adjustedStatus.filter((s) => s === 'CRITICAL').length;

 // ── Cell override handlers ────────────────────────────────────────────
 const applyOverride = (label: string, weekIdx: number, value: number, applyForward: boolean) => {
   setCellOverrides((prev) => {
     const next = { ...prev };
     if (applyForward) {
       for (let i = weekIdx; i < weeks.length; i++) next[overrideKey(label, i)] = value;
     } else {
       next[overrideKey(label, weekIdx)] = value;
     }
     return next;
   });
 };
 const clearOverride = (label: string, weekIdx: number) => {
   setCellOverrides((prev) => {
     const next = { ...prev };
     delete next[overrideKey(label, weekIdx)];
     return next;
   });
 };
 const clearRowOverrides = (label: string) => {
   setCellOverrides((prev) => {
     const next: Record<string, number> = {};
     for (const k of Object.keys(prev)) if (!k.startsWith(`${label}|`)) next[k] = prev[k];
     return next;
   });
 };
 const clearAllOverrides = () => setCellOverrides({});

 return (
 <>
 {breakdownLine && createPortal(
 <div className="cm-modal-backdrop" style={{ zIndex: 10000 }} onClick={() => setBreakdownLine(null)}>
 <div className="cm-modal" style={{ width: 'min(560px, 100%)', margin: 'auto' }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
 <div className="cm-modal-head">
 <div className="cm-head-left">
 <div>
 <div className="cm-title">{breakdownLine.label}</div>
 <div className="cm-sub">What’s included · {(breakdownLine.breakdown ?? []).length} items · total {formatCurrency((breakdownLine.breakdown ?? []).reduce((s, b) => s + b.amount, 0))}</div>
 </div>
 </div>
 <button className="cm-modal-close" onClick={() => setBreakdownLine(null)} aria-label="Close">✕</button>
 </div>
 <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
 <table className="data-table">
 <thead><tr><th>Item</th><th className="num">Amount</th></tr></thead>
 <tbody>
 {(breakdownLine.breakdown ?? []).map((b, i) => (
 <tr key={i}>
 <td><div>{b.label}</div>{b.sub && <div className="vendor-note">{b.sub}</div>}</td>
 <td className="num">{formatCurrency(b.amount)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 </div>,
 document.body,
 )}
 <div className="page-head">
 <div>
 <h1 className="page-title">13-Week Cash Flow {view !== 'budgeted' && <span style={{ fontSize: 14, color: 'var(--muted)', fontWeight: 400 }}>· {view === 'past' ? 'Past Weeks' : view === 'actual' ? 'Actual' : 'Variance'}</span>}</h1>
 <div className="page-sub">
 {direction === 'future'
 ? <>Rolling 13-week plan · Wk 1 starts Mon <strong>{data.anchor}</strong> (auto-rolls forward each Monday) · Wk 1 opening cash <strong>{formatCurrency(openingCashWk1)}</strong></>
 : <>Trailing 13 weeks · <strong>Wk -1</strong> = most recent closed week (Mon <strong>{data.anchor}</strong>), then Wk -2, Wk -3 ... going back. Current in-progress week lives in the Budgeted tab.</>
 }
 {data.cached && ' · cached'}
 </div>
 </div>
 <div style={{ display: 'flex', gap: 8 }}>
 <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
 {([['budgeted', 'Budgeted'], ['past', 'Past'], ['actual', 'Actual'], ['variance', 'Variance']] as Array<[View, string]>).map(([key, label]) => (
 <button
 key={key}
 className={`filter-tab ${view === key ? 'active' : ''}`}
 style={{ borderRadius: 0, border: 'none' }}
 onClick={() => setView(key)}
 >
 {label}
 </button>
 ))}
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>
 </div>

 {hasAnyOverride && (
   <div style={{
     background: '#fef9c3',
     border: '1px solid #fde68a',
     borderRadius: 8,
     padding: '10px 14px',
     marginBottom: 12,
     display: 'flex',
     justifyContent: 'space-between',
     alignItems: 'center',
     gap: 12,
   }}>
     <div style={{ fontSize: 13, color: '#854d0e' }}>
       <strong>⚡ What-if scenario active</strong> · {Object.keys(cellOverrides).length} cell{Object.keys(cellOverrides).length === 1 ? '' : 's'} overridden.
       Closing cash and status pills below reflect your edits, not the live forecast.
     </div>
     <button
       type="button"
       onClick={clearAllOverrides}
       style={{
         background: '#fff',
         border: '1px solid #fbbf24',
         color: '#854d0e',
         padding: '6px 12px',
         borderRadius: 6,
         fontSize: 12,
         fontWeight: 600,
         cursor: 'pointer',
       }}
     >Reset all overrides</button>
   </div>
 )}

 {warnings.length > 0 && (
 <div className="section" style={{ padding: '12px 16px', background: 'var(--warn-soft)', border: '1px solid var(--warn)' }}>
 <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warn)', marginBottom: 4 }}>DATA SOURCE WARNINGS</div>
 {warnings.map((w, i) => <div key={i} className="page-sub" style={{ fontSize: 12 }}>· {w}</div>)}
 </div>
 )}

 {/* Past Weeks layout: month overview cards on top + full week-by-week
   * cashflow table where each cell shows projected + actual + variance.
   * Built from captured Monday snapshots (proj) + live-computed actuals
   * for each closed week. This replaces the broken "run forward-projection
   * algorithm on past dates" approach which produced $0 / dashes. */}
 {/* Past = the SAME budgeted schedule, just for the weeks that have elapsed
   * (rendered by the budget block below with direction=past data). */}
 {view === 'actual' && (
 <CurrentMonthOverviewSection data={monthOverview} />
 )}
 {view === 'actual' && (
 <ActualCashflowTable budgetData={data} pastGrid={pastGrid} />
 )}
 {view === 'variance' && (
 <VarianceCashflowTable budgetData={data} pastGrid={pastGrid} />
 )}

 {/* CC Utilisation editor removed - CC financing is no longer part of the 13-week plan. */}

 {/* Future-direction-only sections: KPI strip + CC editor + Weekly schedule
   * + Totals row. Past direction shows only the snapshot variance + month
   * overview above - the main cashflow projection logic is forward-looking
   * by nature (AR projection, sales forecast, opening cash), so running it
   * against a past window produces $0 / dashes that misrepresent history.
   * For past data the right artefacts are the captured Monday snapshots +
   * the actuals computed in the variance section above. */}
 {(view === 'budgeted' || view === 'past') && <>
 <div className="kpis" data-cfo-anchor="cf-kpis">
 <div className="kpi highlight">
 <div className="kpi-label">Wk 1 Opening Cash</div>
 <div className="kpi-period">{data.anchor}</div>
 <div className="kpi-value">{formatCurrency(openingCashWk1)}</div>
 <div className="kpi-sub">From {srcLabel(openingCashSource)}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">13-Week Net</div>
 <div className="kpi-period">Inflows − Outflows</div>
 <div className="kpi-value">{formatSigned(sum13InOut)}</div>
 <div className="kpi-sub">Total inflows {formatCurrency(adjustedInflowTotal13w)}{salesScenario !== 'base' ? ` · ${salesScenario} case` : ''}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Min Closing Cash</div>
 <div className="kpi-period">Wk {minClosingIdx + 1} · {weeks[minClosingIdx].label}</div>
 <div className="kpi-value">{formatCurrency(minClosing)}</div>
 <div className="kpi-sub">{criticalWeeks > 0 ? `${criticalWeeks} CRITICAL weeks` : 'No critical weeks'}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Peak Inflow</div>
 <div className="kpi-period">Wk {peakInflowIdx + 1} · {weeks[peakInflowIdx].label}</div>
 <div className="kpi-value">{formatCurrency(adjustedInflowTotals[peakInflowIdx])}</div>
 <div className="kpi-sub">AR collections + projected sales</div>
 </div>
 </div>

 <div className="section" data-cfo-anchor="cf-schedule">
 <div className="section-head">
 <div>
 <div className="section-title">Weekly schedule</div>
 <div className="section-sub">
 Rows tagged <span className="pill-tag tag-strong">Live</span> are pulled live from
 Tiller / QB / sheets. Inventory + Payroll + Other = Last 3 months ÷ 4.33.
 </div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th style={{ minWidth: 260 }}>Line item</th>
 <th>Source</th>
 {weeks.map((w, i) => (
 <th key={i} className="num">
 <div style={{ fontSize: 11, fontWeight: 700 }}>{direction === 'past' ? `Wk -${i + 1}` : `Wk ${i + 1}`}</div>
 <div style={{ fontSize: 10, color: 'var(--muted)' }}>{w.label} – {w.end.slice(5).replace('-', '/')}</div>
 </th>
 ))}
 <th className="num">13-wk total</th>
 </tr>
 </thead>
 <tbody>
 {/* OPENING CASH */}
 <tr className="row-fuzzy">
 <td>
 <strong>OPENING CASH</strong>
 {data.openingCashNote && <div className="vendor-note">{data.openingCashNote}</div>}
 </td>
 <td><span className={`pill-tag tag-${srcTone(openingCashSource)}`}>{srcLabel(openingCashSource)}</span></td>
 {totals.openingCash.map((v, i) => (
 <td key={i} className="num"><strong>{formatCurrency(v)}</strong></td>
 ))}
 <td className="num">-</td>
 </tr>

 {/* INFLOWS HEADER */}
 <tr>
 <td colSpan={2 + weeks.length + 1} style={{ background: 'var(--accent-soft)', fontWeight: 700, color: '#059669' }}>
 CASH INFLOWS
 </td>
 </tr>
 {inflows.map((line, idx) => {
 const isProjectedSales = /^projected sales/i.test(line.label);
 const sf = data.salesForecast;
 // Scenario swap: if this is the Projected Sales row and a non-base
 // scenario is selected, replace the row's weekly values with the
 // matching weekly-inflow array from the sales forecast.
 const rowValues = (isProjectedSales && sf && salesScenario !== 'base')
   ? (salesScenario === 'best' ? sf.weeklyInflowBest : sf.weeklyInflowWorst)
   : line.values;
 const rowTotal = rowValues.reduce((s, v) => s + v, 0);
 const scenarioPct = salesScenario === 'best' ? '+18%' : salesScenario === 'worst' ? '-18%' : null;
 return (
 <tr key={`in-${idx}`}>
 <td>
 <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
 {line.breakdown && line.breakdown.length > 0 ? (
   <button type="button" onClick={() => setBreakdownLine(line)} title="See what's included"
     style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--accent-hover, #047857)', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>
     {line.label}
   </button>
 ) : <span>{line.label}</span>}
 {ROW_INFO[line.label] && (
   <InfoTip
     {...ROW_INFO[line.label]}
     style={{ position: 'static', top: 'auto', right: 'auto', display: 'inline-flex' }}
   />
 )}
 {isProjectedSales && sf && (
   <div style={{ display: 'inline-flex', gap: 4, fontSize: 11 }}>
   {(['worst', 'base', 'best'] as const).map((sc) => (
     <button
       key={sc}
       type="button"
       onClick={() => setSalesScenario(sc)}
       style={{
         padding: '2px 8px',
         border: salesScenario === sc ? '1px solid var(--accent)' : '1px solid var(--border)',
         background: salesScenario === sc ? 'var(--accent-soft)' : 'var(--bg)',
         color: salesScenario === sc ? 'var(--accent-hover)' : 'var(--muted)',
         borderRadius: 4,
         cursor: 'pointer',
         fontWeight: salesScenario === sc ? 700 : 500,
         textTransform: 'capitalize',
       }}
     >
       {sc}
     </button>
   ))}
   </div>
 )}
 </div>
 {line.note && <div className="vendor-note">{isProjectedSales && scenarioPct ? `Scenario: ${salesScenario} (${scenarioPct}) · ` : ''}{line.note}</div>}
 </td>
 <td><span className={`pill-tag tag-${srcTone(line.source)}`}>{srcLabel(line.source)}</span></td>
 {rowValues.map((v, i) => (
 <td key={i} className="num">{v ? formatCurrency(v) : '-'}</td>
 ))}
 <td className="num"><strong>{formatCurrency(rowTotal)}</strong></td>
 </tr>
 );
 })}
 <tr className="total-row">
 <td>TOTAL INFLOWS{salesScenario !== 'base' ? <span className="vendor-note"> · {salesScenario} case</span> : null}</td>
 <td>-</td>
 {adjustedInflowTotals.map((v, i) => (
   <td key={i} className="num">{formatCurrency(v)}</td>
 ))}
 <td className="num">{formatCurrency(adjustedInflowTotal13w)}</td>
 </tr>

 {/* OUTFLOWS HEADER */}
 <tr>
 <td colSpan={2 + weeks.length + 1} style={{ background: 'var(--danger-soft)', fontWeight: 700, color: 'var(--danger)' }}>
 CASH OUTFLOWS
 </td>
 </tr>
 {outflows.map((line, idx) => {
 const effectiveValues = line.values.map((v, i) => effectiveOutflow(line.label, v ?? 0, i));
 const rowTotal = effectiveValues.reduce((s, v) => s + v, 0);
 const rowHasOverride = line.values.some((_, i) => hasOverride(line.label, i));
 return (
 <tr key={`out-${idx}`}>
 <td>
 <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
   {line.breakdown && line.breakdown.length > 0 ? (
     <button type="button" onClick={() => setBreakdownLine(line)} title="See what's included"
       style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--accent-hover, #047857)', cursor: 'pointer', textDecoration: 'underline dotted', textUnderlineOffset: 3 }}>
       {line.label}
     </button>
   ) : <span>{line.label}</span>}
   {ROW_INFO[line.label] && (
     <InfoTip
       {...ROW_INFO[line.label]}
       style={{ position: 'static', top: 'auto', right: 'auto', display: 'inline-flex' }}
     />
   )}
   {rowHasOverride && (
     <button
       type="button"
       title="Reset overrides on this row"
       onClick={() => clearRowOverrides(line.label)}
       style={{ background: 'none', border: 'none', color: 'var(--warn)', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: 11 }}
     >↺ reset row</button>
   )}
 </div>
 {line.note && <div className="vendor-note">{line.note}</div>}
 </td>
 <td><span className={`pill-tag tag-${srcTone(line.source)}`}>{srcLabel(line.source)}</span></td>
 {line.values.map((v, i) => {
   const effVal = effectiveOutflow(line.label, v ?? 0, i);
   const isOver = hasOverride(line.label, i);
   return (
     <td
       key={i}
       className="num cf-edit-cell"
       style={{
         cursor: 'pointer',
         background: isOver ? '#fef9c3' : undefined,
         position: 'relative',
       }}
       onClick={() => setEditingCell({ label: line.label, weekIdx: i, current: effVal })}
       title={isOver ? `Overridden - was ${formatCurrency(v ?? 0)}` : 'Click to edit (what-if)'}
     >
       {effVal ? formatCurrency(effVal) : '-'}
       {isOver && <span style={{ marginLeft: 4, color: '#a16207', fontSize: 10 }}>⚡</span>}
     </td>
   );
 })}
 <td className="num"><strong>{formatCurrency(rowTotal)}</strong></td>
 </tr>
 );
 })}
 <tr className="total-row">
 <td>TOTAL OUTFLOWS</td>
 <td>-</td>
 {adjustedOutflowTotals.map((v, i) => (
 <td key={i} className="num">{formatCurrency(v)}</td>
 ))}
 <td className="num">{formatCurrency(adjustedOutflowTotals.reduce((s, v) => s + v, 0))}</td>
 </tr>

 {/* NET / CLOSING / STATUS - driven by overrides if any */}
 <tr>
 <td><strong>NET CASH CHANGE</strong></td>
 <td>-</td>
 {adjustedNetChange.map((v, i) => (
 <td key={i} className="num" style={{ color: v >= 0 ? '#059669' : 'var(--danger)' }}>
 <strong>{formatSigned(v)}</strong>
 </td>
 ))}
 <td className="num"><strong>{formatSigned(adjustedNetChange.reduce((s, v) => s + v, 0))}</strong></td>
 </tr>
 <tr className="total-row">
 <td>CLOSING CASH</td>
 <td>-</td>
 {adjustedClosingCash.map((v, i) => (
 <td key={i} className="num"><strong>{formatCurrency(v)}</strong></td>
 ))}
 <td className="num">-</td>
 </tr>
 <tr>
 <td><strong>STATUS</strong></td>
 <td>-</td>
 {adjustedStatus.map((s, i) => (
 <td key={i} className="num">
 <span className={`pill-tag tag-${statusTone(s)}`}>{s}</span>
 </td>
 ))}
 <td className="num">-</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>

 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Weekly run-rates</div>
 <div className="section-sub">All from QB · L3M average ÷ 4.33.</div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <tbody>
 <tr>
 <td>Credit Card payoff (Wk 1)</td>
 <td className="num"><strong>{formatCurrency(assumptions.ccPayoffWk1)}</strong></td>
 <td className="vendor-note">Sum of Tiller Credit Card balances (live).</td>
 </tr>
 <tr>
 <td>Payroll per week</td>
 <td className="num"><strong>{formatCurrency(Math.round(assumptions.payrollPerWeek))}</strong></td>
 <td className="vendor-note">QB Payroll group L3M ÷ 4.33.</td>
 </tr>
 <tr>
 <td>Inventory & Raw Materials per week</td>
 <td className="num"><strong>{formatCurrency(Math.round(assumptions.inventoryPerWeek))}</strong></td>
 <td className="vendor-note">QB COGS Inventory & Raw Materials L3M ÷ 4.33.</td>
 </tr>
 <tr>
 <td>Other operating expenses per week</td>
 <td className="num"><strong>{formatCurrency(Math.round(assumptions.otherPerWeek))}</strong></td>
 <td className="vendor-note">All other Non-Payroll · QB L3M ÷ 4.33.</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 </>}

 {editingCell && (
   <EditOutflowModal
     label={editingCell.label}
     weekIdx={editingCell.weekIdx}
     weekLabel={`Wk ${editingCell.weekIdx + 1} · ${weeks[editingCell.weekIdx]?.label ?? ''}`}
     liveValue={outflows.find((l) => l.label === editingCell.label)?.values[editingCell.weekIdx] ?? 0}
     currentValue={editingCell.current}
     isOverridden={hasOverride(editingCell.label, editingCell.weekIdx)}
     onSave={(value, applyForward) => {
       applyOverride(editingCell.label, editingCell.weekIdx, value, applyForward);
       setEditingCell(null);
     }}
     onClear={() => {
       clearOverride(editingCell.label, editingCell.weekIdx);
       setEditingCell(null);
     }}
     onCancel={() => setEditingCell(null)}
   />
 )}
 </>
 );
}

// ---- Edit Outflow Modal ---------------------------------------------------
function EditOutflowModal({
 label, weekIdx, weekLabel, liveValue, currentValue, isOverridden,
 onSave, onClear, onCancel,
}: {
 label: string;
 weekIdx: number;
 weekLabel: string;
 liveValue: number;
 currentValue: number;
 isOverridden: boolean;
 onSave: (value: number, applyForward: boolean) => void;
 onClear: () => void;
 onCancel: () => void;
}) {
 // Two input modes - operators usually think in MONTHLY budgets, not
 // weekly drips. Weekly mode = enter the per-week dollar amount as-is.
 // Monthly mode = enter the monthly target; we divide by 4.33 to get
 // the per-week value the grid uses. Toggle stays sticky so the same
 // mode is preselected next edit (saved in localStorage).
 const WEEKS_PER_MONTH = 4.33;
 const [mode, setMode] = useState<'week' | 'month'>(() => {
   try { return (window.localStorage.getItem('cf13-edit-mode') as 'week' | 'month') || 'week'; }
   catch { return 'week'; }
 });
 useEffect(() => {
   try { window.localStorage.setItem('cf13-edit-mode', mode); } catch { /* ignore */ }
 }, [mode]);
 const [val, setVal] = useState<string>(() =>
   String(Math.round(mode === 'month' ? currentValue * WEEKS_PER_MONTH : currentValue))
 );
 const [applyFwd, setApplyFwd] = useState(true);

 // ESC to cancel for keyboard-driven users
 useEffect(() => {
   const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
   window.addEventListener('keydown', onKey);
   return () => window.removeEventListener('keydown', onKey);
 }, [onCancel]);

 const numericInput = parseFloat(val.replace(/[$,\s]/g, ''));
 const validNumber = Number.isFinite(numericInput) && numericInput >= 0;
 // Whatever the user typed → translate to per-week value (what gets saved).
 const numericVal = validNumber
   ? (mode === 'month' ? numericInput / WEEKS_PER_MONTH : numericInput)
   : 0;
 const delta = validNumber ? numericVal - currentValue : 0;
 // The "other" view of the same value - shown next to the input as context.
 const otherValue = validNumber
   ? (mode === 'month' ? numericVal : numericVal * WEEKS_PER_MONTH)
   : 0;

 return (
   <div
     onClick={onCancel}
     style={{
       position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
       backdropFilter: 'blur(4px)', zIndex: 1000,
       display: 'flex', alignItems: 'center', justifyContent: 'center',
       padding: 16,
     }}
   >
     <div
       onClick={(e) => e.stopPropagation()}
       style={{
         background: '#fff', borderRadius: 12, maxWidth: 480, width: '100%',
         padding: 22, boxShadow: '0 24px 60px rgba(15,23,42,0.3)',
         fontFamily: 'inherit',
       }}
     >
       <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>
         What-if edit · {weekLabel}
       </div>
       <h3 style={{ margin: '4px 0 18px', fontSize: 18, fontWeight: 600 }}>{label}</h3>

       {/* Live snapshot showing BOTH weekly and monthly equivalent of
           the current value, so the user sees the relationship before
           they edit. */}
       <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
         <div style={{ padding: '10px 12px', background: '#f8fafc', border: '1px solid var(--border)', borderRadius: 8 }}>
           <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>This week (live)</div>
           <div style={{ fontSize: 15, fontWeight: 600 }}>${liveValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
           <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
             ≈ ${(liveValue * WEEKS_PER_MONTH).toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo
           </div>
         </div>
         <div style={{ padding: '10px 12px', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8 }}>
           <div style={{ fontSize: 11, color: '#854d0e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>
             New value {isOverridden && '(overridden)'}
           </div>
           <div style={{ fontSize: 15, fontWeight: 600, color: '#854d0e' }}>
             ${validNumber ? numericVal.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}/wk
           </div>
           <div style={{ fontSize: 11, color: '#854d0e', marginTop: 2 }}>
             ≈ ${validNumber ? (numericVal * WEEKS_PER_MONTH).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '-'}/mo
           </div>
         </div>
       </div>

       {/* Mode toggle - weekly vs monthly input. Most CFOs think in
           monthly budgets, so this is the key UX hook that makes the
           edit feel intuitive. */}
       <div style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 8, padding: 3, gap: 2, marginBottom: 10 }}>
         {(['week', 'month'] as const).map((m) => (
           <button
             key={m}
             type="button"
             onClick={() => {
               // Re-seed the input so switching modes shows the equivalent value.
               const baseWeekly = validNumber ? numericVal : currentValue;
               setVal(String(Math.round(m === 'month' ? baseWeekly * WEEKS_PER_MONTH : baseWeekly)));
               setMode(m);
             }}
             style={{
               background: mode === m ? '#fff' : 'transparent',
               border: 'none', padding: '6px 14px', borderRadius: 6,
               fontSize: 12, fontWeight: 600,
               color: mode === m ? 'var(--accent)' : 'var(--muted-strong)',
               cursor: 'pointer',
               boxShadow: mode === m ? '0 1px 2px rgba(15,23,42,0.06)' : 'none',
             }}
           >Edit {m === 'week' ? 'weekly' : 'monthly'}</button>
         ))}
       </div>

       <label style={{ display: 'block', marginBottom: 10 }}>
         <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
           <span>New {mode === 'month' ? 'monthly' : 'weekly'} amount ($)</span>
           {validNumber && (
             <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
               = ${otherValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}/{mode === 'month' ? 'wk' : 'mo'}
             </span>
           )}
         </div>
         <input
           type="text"
           autoFocus
           value={val}
           onChange={(e) => setVal(e.target.value)}
           onKeyDown={(e) => { if (e.key === 'Enter' && validNumber) onSave(numericVal, applyFwd); }}
           style={{
             width: '100%', padding: '10px 12px', border: '1px solid var(--border)',
             borderRadius: 8, fontSize: 15, fontFamily: 'inherit', boxSizing: 'border-box',
           }}
         />
         {validNumber && delta !== 0 && (
           <div style={{ fontSize: 11, marginTop: 4, color: delta > 0 ? 'var(--danger)' : '#059669' }}>
             {delta > 0 ? '↑ Increase' : '↓ Decrease'} of ${Math.abs(delta).toLocaleString(undefined, { maximumFractionDigits: 0 })}/wk vs current
           </div>
         )}
       </label>

       <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer', fontSize: 13 }}>
         <input type="checkbox" checked={applyFwd} onChange={(e) => setApplyFwd(e.target.checked)} />
         <span>Apply forward - push this value to all remaining weeks ({weekIdx + 1} onwards)</span>
       </label>

       <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
         <div style={{ display: 'flex', gap: 8 }}>
           {isOverridden && (
             <button
               type="button"
               onClick={onClear}
               style={{ background: '#fff', border: '1px solid var(--border)', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', color: 'var(--muted-strong)', fontSize: 13 }}
             >Clear override</button>
           )}
         </div>
         <div style={{ display: 'flex', gap: 8 }}>
           <button
             type="button"
             onClick={onCancel}
             style={{ background: '#fff', border: '1px solid var(--border)', padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}
           >Cancel</button>
           <button
             type="button"
             onClick={() => onSave(numericVal, applyFwd)}
             disabled={!validNumber}
             style={{
               background: validNumber ? 'var(--accent)' : 'var(--border)',
               color: '#fff', border: 'none', padding: '8px 16px',
               borderRadius: 8, cursor: validNumber ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 600,
             }}
           >Save</button>
         </div>
       </div>
     </div>
   </div>
 );
}

// ---- Snapshot Variance (Past Weeks) ---------------------------------------
// Each captured Monday is a row: what we forecasted for that week's Wk1 vs.
// what actually hit the business bank accounts (computed live from Tiller).
// Weeks that haven't closed yet show "pending" for actuals.

/** Live overview for the CURRENT calendar month - mirrors the WeekVariance
 *  card design but at the month level so the user can see at a glance:
 *  what was projected for May, what's been invoiced/collected so far. */
function CurrentMonthOverviewSection({ data }: { data: CurrentMonthOverview | null }) {
 if (!data) {
  return (
   <div className="section">
   <div className="section-head">
   <div>
   <div className="section-title">Current month · live projection vs reality</div>
   <div className="section-sub">Loading…</div>
   </div>
   </div>
   </div>
  );
 }
 const m = data.month;
 const salesProj = data.sales.projected.base;
 const salesActual = data.sales.invoicedMtd.total;
 const arNgProj = data.ar.nonGelato.projected;
 const arNgActual = data.ar.nonGelato.collected;
 const arGelProj = data.ar.gelato.projected;
 const arGelActual = data.ar.gelato.collected;

 function delta(fc: number, ac: number) {
  const d = ac - fc;
  const tone = d >= 0 ? '#059669' : 'var(--danger)';
  return <span style={{ color: tone, fontWeight: 600 }}>{d >= 0 ? '+' : ''}{formatCurrency(d)}</span>;
 }
 function pctOf(ac: number, fc: number) {
  if (fc <= 0) return null;
  const p = (ac / fc) * 100;
  return <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {p.toFixed(0)}% of projected</span>;
 }
 function Card({
  title, projected, actual, actualLabel, hint,
 }: { title: string; projected: number; actual: number; actualLabel: string; hint?: string }) {
  return (
   <div style={{
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '14px 16px',
    background: 'var(--panel, #fff)',
    flex: 1,
    minWidth: 240,
   }}>
   <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{title}</div>
   <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
    <div>
    <div style={{ fontSize: 10, color: 'var(--muted)' }}>Projected ({m.label})</div>
    <div style={{ fontSize: 18, fontWeight: 700 }}>{formatCurrency(projected)}</div>
    </div>
    <div style={{ textAlign: 'right' }}>
    <div style={{ fontSize: 10, color: 'var(--muted)' }}>{actualLabel}</div>
    <div style={{ fontSize: 18, fontWeight: 700 }}>{formatCurrency(actual)}</div>
    </div>
   </div>
   <div style={{ marginTop: 8, fontSize: 12 }}>
    Δ {delta(projected, actual)}{pctOf(actual, projected)}
   </div>
   {hint && <div className="vendor-note" style={{ fontSize: 10, marginTop: 6 }}>{hint}</div>}
   </div>
  );
 }
 return (
  <div className="section">
  <div className="section-head">
  <div>
  <div className="section-title">{m.label} · live projection vs reality</div>
  <div className="section-sub">
   Day <strong>{m.dayOfMonth}</strong> of {m.daysInMonth} ({m.progressPct.toFixed(0)}% of month elapsed) · open AR <strong>{formatCurrency(data.openArAsOfToday.amount)}</strong> across {data.openArAsOfToday.invoiceCount} invoices
  </div>
  </div>
  </div>
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
   {/* Scenario range chip - small + unobtrusive */}
   <div style={{
    flexBasis: '100%',
    fontSize: 11,
    color: 'var(--muted)',
    marginBottom: -4,
   }}>
   Sales range: worst <strong>{formatCurrency(data.sales.projected.worst)}</strong> · base <strong>{formatCurrency(data.sales.projected.base)}</strong> · best <strong>{formatCurrency(data.sales.projected.best)}</strong>
   </div>
   <Card
    title="Sales projection"
    projected={salesProj}
    actual={salesActual}
    actualLabel="Invoiced MTD"
    hint={`${data.sales.invoicedMtd.invoiceCount} invoices issued so far`}
   />
   <Card
    title="Little Tree AR"
    projected={arNgProj}
    actual={arNgActual}
    actualLabel="Collected MTD"
    hint={`Cash already received from already-issued invoices · ${data.ar.nonGelato.invoiceCount} invoices paid`}
   />
   <Card
    title="Gelato AR (Net 97)"
    projected={arGelProj}
    actual={arGelActual}
    actualLabel="Collected MTD"
    hint={arGelProj === 0 ? 'No Gelato Net-97 batches due to land this month' : `${data.ar.gelato.invoiceCount} Gelato invoices paid`}
   />
  </div>
  </div>
 );
}

/**
 * Past Weeks cashflow table - same row/column structure as the future
 * cashflow table (line items × weeks), but each cell shows BOTH the
 * projected value (snapshot frozen that Monday) AND the actual value
 * (live computed for that closed week) + variance.
 *
 * Columns: Wk 1 = current week (May 11 today, in progress with live data),
 * then closed weeks going backward (Wk 2 = May 4, Wk 3 = Apr 27...).
 *
 * Rows: Per inflow/outflow line item from snapshots. Per-line outflow
 * actuals aren't tracked (only total inflow/outflow is computed live), so
 * outflow cells show projected only.
 */
function PastCashflowTable({
 pastGrid, liveData, futureData, salesScenario,
}: {
 pastGrid: PastWeeksGridResponse | null;
 liveData: Cashflow13;
 futureData: Cashflow13 | null;
 salesScenario: 'worst' | 'base' | 'best';
}) {
 if (!pastGrid) {
  return (
   <div className="section">
   <div className="section-head">
   <div>
   <div className="section-title">Past weeks · projection vs actual</div>
   <div className="section-sub">Loading past weeks…</div>
   </div>
   </div>
   </div>
  );
 }
 // Items already in newest-first order from the server.
 const items = pastGrid.items;
 if (items.length === 0) {
  return (
   <div className="section">
   <div className="section-head">
   <div>
   <div className="section-title">Past weeks · projection vs actual</div>
   <div className="section-sub">No past weeks data.</div>
   </div>
   </div>
   </div>
  );
 }

 // Standard inflow/outflow labels (use the same set as the future cashflow so
 // the row layout is stable even for weeks without a snapshot). Falls back to
 // whatever labels exist on the snapshots we DO have.
 const standardInflowLabels = ['Gelato AR Collections (Net 97)', 'Little Tree AR Collections (lag-curve)', 'Projected AR from new sales (3-bucket)', 'CC Utilisation'];

 // Historical label aliases - older snapshots used different names for what
 // are now the same lines. Map old → current so they merge into one row
 // instead of showing up twice with identical numbers.
 const LABEL_ALIASES: Record<string, string> = {
   'Non-Gelato AR Collections (lag-curve)': 'Little Tree AR Collections (lag-curve)',
 };
 const canonLabel = (l: string) => LABEL_ALIASES[l] ?? l;

 const inflowLabels: string[] = [...standardInflowLabels];
 const outflowLabels: string[] = [];
 const seenIn = new Set(standardInflowLabels);
 const seenOut = new Set<string>();
 for (const it of items) {
  if (!it.snapshot) continue;
  for (const l of it.snapshot.inflows) {
    const canon = canonLabel(l.label);
    if (!seenIn.has(canon)) { seenIn.add(canon); inflowLabels.push(canon); }
  }
  for (const l of it.snapshot.outflows) {
    const canon = canonLabel(l.label);
    if (!seenOut.has(canon)) { seenOut.add(canon); outflowLabels.push(canon); }
  }
 }
 // Fallback outflow labels from future cashflow when no snapshot in window.
 if (outflowLabels.length === 0 && futureData) {
  for (const l of futureData.outflows) { seenOut.add(l.label); outflowLabels.push(l.label); }
 }

 /** Projection for a given week's line item.
  *  - In-progress (current) week: use FUTURE direction's live Wk 1 value -
  *    reflects today's latest methodology + scenario selector, matches what
  *    the user sees in the Future tab.
  *  - Closed weeks: use snapshot.wk1Value (historical truth - what we said
  *    that Monday morning, never changes after that). */
 function projFor(it: PastWeeksGridResponse['items'][number], label: string, side: 'in' | 'out'): number | null {
  if (!it.weekClosed && futureData) {
   const liveList = side === 'in' ? futureData.inflows : futureData.outflows;
   const liveHit = liveList.find((l) => l.label === label);
   if (liveHit) {
    // Sales row honours the scenario selector to match Future tab.
    if (side === 'in' && /^projected sales/i.test(label) && futureData.salesForecast) {
     if (salesScenario === 'best')  return futureData.salesForecast.weeklyInflowBest?.[0] ?? liveHit.values[0] ?? 0;
     if (salesScenario === 'worst') return futureData.salesForecast.weeklyInflowWorst?.[0] ?? liveHit.values[0] ?? 0;
    }
    return liveHit.values[0] ?? 0;
   }
  }
  if (!it.snapshot) return null;
  const list = side === 'in' ? it.snapshot.inflows : it.snapshot.outflows;
  // Try canonical name first; fall back to any alias that maps to it
  // (lets old snapshots written under the previous label name still match).
  let hit = list.find((l) => l.label === label);
  if (!hit) {
   hit = list.find((l) => canonLabel(l.label) === label);
  }
  return hit?.wk1Value ?? 0;
 }
 void liveData;

 /** Actual amount for an inflow line label (only some are mapped). */
 function actualInflowFor(it: PastWeeksGridResponse['items'][number], label: string): number | null {
  const a = it.actuals;
  if (!a) return null;
  if (/^gelato/i.test(label))      return a.arActuals?.gelato?.amount ?? 0;
  if (/^little tree|^non-gelato/i.test(label))  return a.arActuals?.nonGelato?.amount ?? 0;
  if (/^projected sales/i.test(label)) return (a.salesInvoiced?.gelato?.amount ?? 0) + (a.salesInvoiced?.nonGelato?.amount ?? 0);
  // CC Util etc. have no direct actuals - return null so cell shows just projected.
  return null;
 }

 function fmt(n: number): string {
  return formatCurrency(Math.round(n));
 }
 function cell(proj: number | null, act: number | null): React.ReactNode {
  const hasProj = proj !== null && proj !== 0;
  const hasAct = act !== null && act !== 0;
  if (!hasProj && !hasAct) return <span style={{ color: 'var(--muted)' }}>-</span>;
  if (proj === null && act !== null) {
   // Closed week with no snapshot - show actual only (no clutter).
   return <div style={{ lineHeight: 1.2 }}><div style={{ fontWeight: 600 }}>{fmt(act)}</div></div>;
  }
  const p = proj ?? 0;
  if (act === null) return <div style={{ lineHeight: 1.2 }}><div>{fmt(p)}</div></div>;
  const d = act - p;
  const tone = d >= 0 ? '#059669' : 'var(--danger)';
  return (
   <div style={{ lineHeight: 1.2 }}>
    <div style={{ fontSize: 10, color: 'var(--muted)' }}>fc {fmt(p)}</div>
    <div style={{ fontWeight: 600 }}>{fmt(act)}</div>
    <div style={{ fontSize: 10, color: tone, fontWeight: 600 }}>{d >= 0 ? '+' : ''}{fmt(d)}</div>
   </div>
  );
 }
 function rowCell(proj: number | null, act: number | null): React.ReactNode {
  return cell(proj, act);
 }

 return (
  <CollapsibleSection
   title={`Past weeks · projection vs actual (${items.length} closed week${items.length === 1 ? '' : 's'})`}
   sub={<>Closed weeks only - "Wk -1" = the most recent Sunday, then "Wk -2", "Wk -3"... going back. Each cell shows <strong>fc</strong> (snapshot frozen that Monday, where captured) over <strong>actual</strong> (sales invoiced + AR collected per LT Financials in that range) over <strong>Δ</strong> (variance). The current in-progress week lives in the Budgeted tab as its Wk 1.</>}
  >
   <div className="table-wrap">
   <table className="data-table" style={{ fontSize: 12 }}>
   <thead>
   <tr>
   <th>Line item</th>
   <th>Source</th>
   {items.map((it, i) => (
    <th key={it.monday} className="num">
     <div>Wk -{i + 1}</div>
     <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{it.monday.slice(5)}</div>
    </th>
   ))}
   </tr>
   </thead>
   <tbody>
   <tr>
   <td><strong>Opening cash</strong></td>
   <td><span className="pill-tag tag-strong" style={{ fontSize: 10 }}>Live</span></td>
   {items.map((it) => (
    <td key={it.monday} className="num">{it.snapshot ? fmt(it.snapshot.openingCash) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
   ))}
   </tr>

   <tr><td colSpan={2 + items.length} style={{ background: 'var(--accent-soft)', fontWeight: 700, color: '#059669' }}>CASH INFLOWS</td></tr>
   {inflowLabels.map((label) => (
    <tr key={`in-${label}`}>
    <td>{label}</td>
    <td><span className="pill-tag tag-fuzzy" style={{ fontSize: 10 }}>Calc</span></td>
    {items.map((it) => {
     const proj = projFor(it, label, 'in');
     const act = actualInflowFor(it, label);
     return <td key={it.monday} className="num">{cell(proj, act)}</td>;
    })}
    </tr>
   ))}
   <tr className="total-row">
   <td>TOTAL INFLOWS</td>
   <td>-</td>
   {items.map((it) => {
    // For in-progress week: use Future tab's authoritative totals[0] so
    // the number matches Future tab exactly. For closed weeks: use the
    // snapshot's totalInflowWk1 (also authoritative for that Monday).
    let proj: number | null;
    if (!it.weekClosed && futureData) proj = futureData.totals.inflows[0] ?? null;
    else if (it.snapshot) proj = it.snapshot.totalInflowWk1;
    else proj = null;
    const act = it.actuals?.inflow ?? null;
    return <td key={it.monday} className="num">{rowCell(proj, act)}</td>;
   })}
   </tr>

   <tr><td colSpan={2 + items.length} style={{ background: 'var(--danger-soft)', fontWeight: 700, color: 'var(--danger)' }}>CASH OUTFLOWS</td></tr>
   {outflowLabels.map((label) => (
    <tr key={`out-${label}`}>
    <td>{label}</td>
    <td><span className="pill-tag tag-fuzzy" style={{ fontSize: 10 }}>Calc</span></td>
    {items.map((it) => {
     const proj = projFor(it, label, 'out');
     // Per-line outflow actuals not available - cell shows projected only.
     return <td key={it.monday} className="num">{cell(proj, null)}</td>;
    })}
    </tr>
   ))}
   <tr className="total-row">
   <td>TOTAL OUTFLOWS</td>
   <td>-</td>
   {items.map((it) => {
    // Per user: show projection only, no actual. Tiller's outflow total
    // mixes payroll/CC payments/transfers without per-line attribution,
    // so the variance signal is noisy. Projection from Future tab.
    let proj: number | null;
    if (!it.weekClosed && futureData) proj = futureData.totals.outflows[0] ?? null;
    else if (it.snapshot) proj = it.snapshot.totalOutflowWk1;
    else proj = null;
    return <td key={it.monday} className="num">{rowCell(proj, null)}</td>;
   })}
   </tr>

   <tr className="total-row">
   <td><strong>NET CHANGE</strong></td>
   <td>-</td>
   {items.map((it) => {
    // Projection only - net change actual depends on outflow actual which
    // we're hiding for now.
    let proj: number | null;
    if (!it.weekClosed && futureData) {
     proj = (futureData.totals.inflows[0] ?? 0) - (futureData.totals.outflows[0] ?? 0);
    } else if (it.snapshot) {
     proj = it.snapshot.netChangeWk1;
    } else proj = null;
    return <td key={it.monday} className="num">{rowCell(proj, null)}</td>;
   })}
   </tr>
   </tbody>
   </table>
   </div>
  </CollapsibleSection>
 );
}

// ---- Small section shells -------------------------------------------------
function LoadingSection({ title }: { title: string }) {
 return (
  <div className="section">
   <div className="section-head"><div>
    <div className="section-title">{title}</div>
    <div className="section-sub">Loading…</div>
   </div></div>
  </div>
 );
}
function EmptySection({ title, sub }: { title: string; sub: string }) {
 return (
  <div className="section">
   <div className="section-head"><div>
    <div className="section-title">{title}</div>
    <div className="section-sub">{sub}</div>
   </div></div>
  </div>
 );
}
// ---- actuals mapping ------------------------------------------------------
// Map a budget INFLOW line to its actual counterpart for a week (AR collected
// + sales invoiced - the same figures the current-month view pulls from QB).
// Outflow / unmapped lines return null -> rendered as "entry yet to be done".
function actualForInflowLine(label: string, a: WeekActuals): number | null {
 if (/gelato/i.test(label)) return a.arActuals?.gelato?.amount ?? 0;
 if (/little tree|non-gelato/i.test(label)) return a.arActuals?.nonGelato?.amount ?? 0;
 if (/projected|new sales/i.test(label)) return a.salesInvoiced?.total ?? 0;
 return null;
}

// ---- Actual (Past Weeks) --------------------------------------------------
// Same line-item layout as the Budgeted schedule, but each cell is the ACTUAL
// pulled from QB / collections for that elapsed week. Where the entry isn't
// booked yet it shows "entry yet to be done".
function ActualCashflowTable({ budgetData, pastGrid }: { budgetData: Cashflow13; pastGrid: PastWeeksGridResponse | null }) {
 if (!pastGrid) return <LoadingSection title="Actual · what really happened" />;
 const weeks = budgetData.weeks;
 const byMonday = new Map(pastGrid.items.map((it) => [it.monday, it]));
 const fmt = (n: number) => formatCurrency(Math.round(n));
 const TBD = <span style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 11 }}>entry yet to be done</span>;
 const hdr = (w: Cashflow13['weeks'][number], i: number) => (
  <th key={w.start} className="num">
   <div>Wk -{i + 1}</div>
   <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{w.label} – {w.end.slice(5).replace('-', '/')}</div>
  </th>
 );
 return (
  <CollapsibleSection
   title="Actual · what really happened"
   sub={<>Each elapsed week's real entries - sales invoiced + AR collected (pulled from QB / collections, like the current-month view). Outflow actuals aren't booked per category, so per-line outflows show <em>entry yet to be done</em>; the bank total appears on TOTAL OUTFLOWS.</>}
  >
   <div className="table-wrap">
    <table className="data-table" style={{ fontSize: 12 }}>
     <thead><tr><th>Line item</th>{weeks.map(hdr)}</tr></thead>
     <tbody>
      <tr>
       <td><strong>Opening cash</strong></td>
       {weeks.map((w) => { const it = byMonday.get(w.start); return <td key={w.start} className="num">{it?.snapshot ? fmt(it.snapshot.openingCash) : TBD}</td>; })}
      </tr>
      <tr><td colSpan={1 + weeks.length} style={{ background: 'var(--accent-soft)', fontWeight: 700, color: '#059669' }}>CASH INFLOWS</td></tr>
      {budgetData.inflows.map((line) => (
       <tr key={`in-${line.label}`}>
        <td>{line.label}</td>
        {weeks.map((w) => {
         const a = byMonday.get(w.start)?.actuals ?? null;
         const v = a ? actualForInflowLine(line.label, a) : null;
         return <td key={w.start} className="num">{a && v !== null ? fmt(v) : TBD}</td>;
        })}
       </tr>
      ))}
      <tr className="total-row">
       <td>TOTAL INFLOWS</td>
       {weeks.map((w) => {
        const a = byMonday.get(w.start)?.actuals ?? null;
        return <td key={w.start} className="num">{a ? fmt((a.arActuals?.total ?? 0) + (a.salesInvoiced?.total ?? 0)) : TBD}</td>;
       })}
      </tr>
      <tr><td colSpan={1 + weeks.length} style={{ background: 'var(--danger-soft)', fontWeight: 700, color: 'var(--danger)' }}>CASH OUTFLOWS</td></tr>
      {budgetData.outflows.map((line) => (
       <tr key={`out-${line.label}`}>
        <td>{line.label}</td>
        {weeks.map((w) => <td key={w.start} className="num">{TBD}</td>)}
       </tr>
      ))}
      <tr className="total-row">
       <td>TOTAL OUTFLOWS <span className="vendor-note">bank debits</span></td>
       {weeks.map((w) => { const a = byMonday.get(w.start)?.actuals ?? null; return <td key={w.start} className="num">{a ? fmt(a.outflow) : TBD}</td>; })}
      </tr>
      <tr className="total-row">
       <td><strong>NET CHANGE</strong></td>
       {weeks.map((w) => {
        const a = byMonday.get(w.start)?.actuals ?? null;
        return <td key={w.start} className="num">{a ? <strong style={{ color: a.netChange >= 0 ? '#059669' : 'var(--danger)' }}>{a.netChange >= 0 ? '+' : ''}{fmt(a.netChange)}</strong> : TBD}</td>;
       })}
      </tr>
     </tbody>
    </table>
   </div>
  </CollapsibleSection>
 );
}

// ---- Variance (Past Weeks) ------------------------------------------------
// Same line-item layout: each cell is budget (the plan for that week) over
// actual over Δ. Lines with no booked actual show "entry yet to be done".
function VarianceCashflowTable({ budgetData, pastGrid }: { budgetData: Cashflow13; pastGrid: PastWeeksGridResponse | null }) {
 if (!pastGrid) return <LoadingSection title="Variance · budget vs actual" />;
 const weeks = budgetData.weeks;
 const byMonday = new Map(pastGrid.items.map((it) => [it.monday, it]));
 const fmt = (n: number) => formatCurrency(Math.round(n));
 const vcell = (budget: number, actual: number | null, lowerIsBetter = false): React.ReactNode => {
  if (actual === null) {
   return <div style={{ lineHeight: 1.3 }}><div style={{ fontSize: 10, color: 'var(--muted)' }}>budget {fmt(budget)}</div><div className="vendor-note" style={{ fontStyle: 'italic' }}>entry yet to be done</div></div>;
  }
  const d = actual - budget;
  const good = lowerIsBetter ? d <= 0 : d >= 0;
  const tone = good ? '#059669' : 'var(--danger)';
  const pct = budget !== 0 ? Math.round((actual / budget) * 100) : null;
  return (
   <div style={{ lineHeight: 1.3 }}>
    <div style={{ fontSize: 10, color: 'var(--muted)' }}>budget {fmt(budget)}</div>
    <div style={{ fontWeight: 600 }}>actual {fmt(actual)}</div>
    <div style={{ fontSize: 10, color: tone, fontWeight: 600 }}>{d >= 0 ? '+' : ''}{fmt(d)}{pct !== null ? ` · ${pct}%` : ''}</div>
   </div>
  );
 };
 const hdr = (w: Cashflow13['weeks'][number], i: number) => (
  <th key={w.start} className="num">
   <div>Wk -{i + 1}</div>
   <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{w.label} – {w.end.slice(5).replace('-', '/')}</div>
  </th>
 );
 return (
  <CollapsibleSection
   title="Variance · budget vs actual"
   sub={<>Per elapsed week: <strong>budget</strong> (the plan for that week) over <strong>actual</strong> over the <strong>Δ</strong>. Green = better than plan (more cash in, less out, higher net). Lines whose actual isn't booked yet show <em>entry yet to be done</em>.</>}
  >
   <div className="table-wrap">
    <table className="data-table" style={{ fontSize: 12 }}>
     <thead><tr><th>Line item</th>{weeks.map(hdr)}</tr></thead>
     <tbody>
      <tr><td colSpan={1 + weeks.length} style={{ background: 'var(--accent-soft)', fontWeight: 700, color: '#059669' }}>CASH INFLOWS</td></tr>
      {budgetData.inflows.map((line, idx) => (
       <tr key={`in-${line.label}`}>
        <td>{line.label}</td>
        {weeks.map((w, wi) => {
         const a = byMonday.get(w.start)?.actuals ?? null;
         const actual = a ? actualForInflowLine(line.label, a) : null;
         return <td key={w.start} className="num">{vcell(budgetData.inflows[idx].values[wi] ?? 0, actual)}</td>;
        })}
       </tr>
      ))}
      <tr className="total-row">
       <td>TOTAL INFLOWS</td>
       {weeks.map((w, wi) => {
        const a = byMonday.get(w.start)?.actuals ?? null;
        const actual = a ? (a.arActuals?.total ?? 0) + (a.salesInvoiced?.total ?? 0) : null;
        return <td key={w.start} className="num">{vcell(budgetData.totals.inflows[wi] ?? 0, actual)}</td>;
       })}
      </tr>
      <tr><td colSpan={1 + weeks.length} style={{ background: 'var(--danger-soft)', fontWeight: 700, color: 'var(--danger)' }}>CASH OUTFLOWS</td></tr>
      {budgetData.outflows.map((line, idx) => (
       <tr key={`out-${line.label}`}>
        <td>{line.label}</td>
        {weeks.map((w, wi) => <td key={w.start} className="num">{vcell(budgetData.outflows[idx].values[wi] ?? 0, null)}</td>)}
       </tr>
      ))}
      <tr className="total-row">
       <td>TOTAL OUTFLOWS</td>
       {weeks.map((w, wi) => { const a = byMonday.get(w.start)?.actuals ?? null; return <td key={w.start} className="num">{vcell(budgetData.totals.outflows[wi] ?? 0, a ? a.outflow : null, true)}</td>; })}
      </tr>
      <tr className="total-row">
       <td><strong>NET CHANGE</strong></td>
       {weeks.map((w, wi) => { const a = byMonday.get(w.start)?.actuals ?? null; return <td key={w.start} className="num">{vcell(budgetData.totals.netChange[wi] ?? 0, a ? a.netChange : null)}</td>; })}
      </tr>
     </tbody>
    </table>
   </div>
   <div className="vendor-note" style={{ marginTop: 8 }}>Outflow actuals are booked at the bank-total level only (TOTAL OUTFLOWS), so per-category outflows show pending. Green Δ on outflows = spent less than planned.</div>
  </CollapsibleSection>
 );
}
