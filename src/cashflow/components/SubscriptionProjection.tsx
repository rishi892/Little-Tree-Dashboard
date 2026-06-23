import { useEffect, useMemo, useState } from 'react';
import { fetchSubscriptionAudit, type SubscriptionAudit, type AuditRow } from '../api';
import { formatCurrency } from '../format';
import { CollapsibleSection } from './CollapsibleSection';

/**
 * Projection anchor (Wk 1 start). Source spreadsheet uses 2026-05-04 - we honour
 * that exact date so the dashboard matches the lender-facing report row-for-row.
 * If we ever roll forward, bump this date to the next Monday before sharing.
 */
const PROJECTION_ANCHOR = new Date(Date.UTC(2026, 4, 4)); // 2026-05-04 (Monday)
function addDays(d: Date, n: number): Date {
 const r = new Date(d);
 r.setUTCDate(d.getUTCDate() + n);
 return r;
}
function fmtMMDD(d: Date): string {
 return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}
function daysInMonth(year: number, month: number): number {
 return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
function buildWeeks(start: Date, count: number): Array<{ start: Date; end: Date; label: string }> {
 const weeks: Array<{ start: Date; end: Date; label: string }> = [];
 for (let i = 0; i < count; i++) {
 const ws = addDays(start, i * 7);
 const we = addDays(ws, 6);
 weeks.push({ start: ws, end: we, label: fmtMMDD(ws) });
 }
 return weeks;
}

/** Place the monthly amount on the bill-day of each month within the 13-week window. */
function projectRow(billDay: number, monthly: number, weeks: Array<{ start: Date; end: Date }>): number[] {
 const out = new Array(weeks.length).fill(0);
 if (weeks.length === 0 || monthly <= 0) return out;
 const start = weeks[0].start;
 const end = weeks[weeks.length - 1].end;
 let curYear = start.getUTCFullYear();
 let curMonth = start.getUTCMonth();
 for (let i = 0; i < 6; i++) {
 const dim = daysInMonth(curYear, curMonth);
 const day = Math.min(billDay, dim);
 const billDate = new Date(Date.UTC(curYear, curMonth, day));
 if (billDate > end) break;
 if (billDate >= start) {
 for (let w = 0; w < weeks.length; w++) {
 if (billDate >= weeks[w].start && billDate <= weeks[w].end) {
 out[w] += monthly;
 break;
 }
 }
 }
 curMonth++;
 if (curMonth > 11) { curMonth = 0; curYear++; }
 }
 return out;
}

type Source = 'all' | 'qb' | 'outlier' | 'expected';

export function SubscriptionProjection() {
 const [data, setData] = useState<SubscriptionAudit | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [source, setSource] = useState<Source>('all');

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 const d = await fetchSubscriptionAudit({ months: 16, refresh });
 setData(d);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed to load');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load(false);
 const poll = window.setInterval(() => load(false, true), 30_000);
 const onFocus = () => load(false, true);
 window.addEventListener('focus', onFocus);
 return () => {
 window.clearInterval(poll);
 window.removeEventListener('focus', onFocus);
 };
 }, []);

 const weeks = useMemo(() => buildWeeks(PROJECTION_ANCHOR, 13), []);

 if (loading && !data) {
 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Active Subscriptions - 13-Week Projection</h1>
 <div className="page-sub">Cross-checking your 46 subscriptions against 16 months of QuickBooks history…</div>
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
 <div><h1 className="page-title">Active Subscriptions - 13-Week Projection</h1></div>
 </div>
 <div className="error">
 {error}
 {isAuth && (<> <br /><strong>Reconnect:</strong> open <a href="/auth/connect">/auth/connect</a> to re-authorize QuickBooks.</>)}
 </div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const filtered = data.rows.filter((r) => {
 if (source === 'qb') return r.usedSource === 'qb';
 if (source === 'outlier') return r.usedSource === 'expected_outlier';
 if (source === 'expected') return r.usedSource === 'expected';
 return true;
 });

 type Row = { audit: AuditRow; projection: number[] };
 const rows: Row[] = filtered
 .map((r) => ({ audit: r, projection: projectRow(r.usedBillDay, r.usedMonthly, weeks) }))
 .sort((a, b) => b.audit.usedMonthly - a.audit.usedMonthly);

 const weeklyTotals = weeks.map((_, i) => rows.reduce((s, r) => s + r.projection[i], 0));
 const grandTotal = weeklyTotals.reduce((s, v) => s + v, 0);
 const monthlyEquivalent = rows.reduce((s, r) => s + r.audit.usedMonthly, 0);
 const avgWeekly = grandTotal / weeks.length;
 const week1Total = weeklyTotals[0] ?? 0;
 const peakWeekIdx = weeklyTotals.indexOf(Math.max(...weeklyTotals));
 const peakWeekTotal = weeklyTotals[peakWeekIdx] ?? 0;

 const counts = {
 qb: data.rows.filter((r) => r.usedSource === 'qb').length,
 outlier: data.rows.filter((r) => r.usedSource === 'expected_outlier').length,
 expected: data.rows.filter((r) => r.usedSource === 'expected').length,
 };

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Active Subscriptions - 13-Week Projection</h1>
 <div className="page-sub">
 Your {data.rows.length} subscriptions · <strong>{counts.qb}</strong> using live QB data, <strong>{counts.outlier}</strong> outliers (QB too off - using expected), <strong>{counts.expected}</strong> not found in QB · audit window {data.monthLabels[0]} – {data.monthLabels[data.monthLabels.length - 1]} · projection starts Mon <strong>{fmtMMDD(weeks[0].start)}</strong>.
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh from QB'}
 </button>
 </div>

 <div className="section" style={{ padding: '14px 20px' }}>
 <div className="section-title" style={{ marginBottom: 8, fontSize: 13 }}>Show</div>
 <div className="filter-row">
 {([
 { k: 'all', l: `All (${data.rows.length})` },
 { k: 'qb', l: `QB matched (${counts.qb})` },
 { k: 'outlier', l: `QB outlier (${counts.outlier})` },
 { k: 'expected', l: `Not in QB (${counts.expected})` },
 ] as const).map(({ k, l }) => (
 <button key={k} className={`filter-tab ${source === k ? 'active' : ''}`} onClick={() => setSource(k)}>{l}</button>
 ))}
 </div>
 <div className="page-sub" style={{ marginTop: 8 }}>
 Only your 46 line items shown. Monthly $ = median of <em>non-zero monthly totals</em> from QB matches. If that's &gt;3× or &lt;1/3× the expected value (likely the vendor catches non-subscription spend like Gusto's wages, or only a partial match), we fall back to expected and tag as <strong>outlier</strong> - see Notes column for the reason.
 </div>
 </div>

 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">Monthly Equivalent</div>
 <div className="kpi-period">Sum across visible subs</div>
 <div className="kpi-value">{formatCurrency(monthlyEquivalent)}</div>
 <div className="kpi-sub">{rows.length} subs</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">13-Week Outflow</div>
 <div className="kpi-period">Sum of projected weeks</div>
 <div className="kpi-value">{formatCurrency(grandTotal)}</div>
 <div className="kpi-sub">Avg {formatCurrency(avgWeekly)}/wk</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">This Week (Wk 1)</div>
 <div className="kpi-period">{fmtMMDD(weeks[0].start)} – {fmtMMDD(weeks[0].end)}</div>
 <div className="kpi-value">{formatCurrency(week1Total)}</div>
 <div className="kpi-sub">{rows.filter((r) => r.projection[0] > 0).length} subs billing</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Peak Week</div>
 <div className="kpi-period">Wk {peakWeekIdx + 1} · {fmtMMDD(weeks[peakWeekIdx].start)}</div>
 <div className="kpi-value">{formatCurrency(peakWeekTotal)}</div>
 <div className="kpi-sub">Cash crunch to plan for</div>
 </div>
 </div>

 <CollapsibleSection
 title="Subscription detail · 13 weeks ahead"
 sub="For each of your 46 subs: Monthly $ + Bill Day derived live from QB transactions where the match is reliable; otherwise your expected values are used."
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Vendor / Service</th>
 <th>Source</th>
 <th className="num">Monthly $ <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(used)</span></th>
 <th className="num">Bill Day</th>
 <th>Pattern</th>
 <th>QB Match</th>
 <th className="num">Expected $/Day</th>
 <th>Notes</th>
 {weeks.map((w, i) => (
 <th key={i} className="num">
 <div style={{ fontSize: 11, fontWeight: 700 }}>Wk {i + 1}</div>
 <div style={{ fontSize: 10, color: 'var(--muted)' }}>{w.label}</div>
 </th>
 ))}
 <th className="num">13-wk total</th>
 </tr>
 </thead>
 <tbody>
 {rows.map(({ audit, projection }) => {
 const rowTotal = projection.reduce((s, v) => s + v, 0);
 const src = audit.usedSource;
 const sourceLabel = src === 'qb' ? 'QB' : src === 'expected_outlier' ? 'Outlier' : 'Expected';
 const sourceTone = src === 'qb' ? 'strong' : src === 'expected_outlier' ? 'fuzzy' : 'none';
 const rowClass = src === 'qb' ? '' : src === 'expected_outlier' ? 'row-fuzzy' : 'row-none';
 return (
 <tr key={audit.expected.name} className={rowClass}>
 <td>
 <div className="vendor-name">{audit.expected.name}</div>
 {audit.bestMatchName && <div className="vendor-note">QB: {audit.bestMatchName}</div>}
 </td>
 <td>
 <span className={`pill-tag tag-${sourceTone}`}>{sourceLabel}</span>
 </td>
 <td className="num"><strong>{formatCurrency(audit.usedMonthly)}</strong></td>
 <td className="num">{audit.usedBillDay}</td>
 <td>
 <span className={`pill-tag tag-${audit.usedPattern === 'FIXED' ? 'strong' : audit.usedPattern === 'VARIABLE' ? 'warn' : 'line'}`}>
 {audit.usedPattern}
 </span>
 </td>
 <td>
 <span className={`pill-tag tag-${audit.matchType === 'strong' ? 'strong' : audit.matchType === 'fuzzy' ? 'fuzzy' : audit.matchType === 'line' ? 'line' : 'none'}`}>
 {audit.matchType === 'none' ? '-' : audit.matchType}
 </span>
 {audit.activity && (
 <div className="vendor-note" style={{ marginTop: 4 }}>
 {audit.activity.txnCount} txns · last {audit.activity.lastDate}
 </div>
 )}
 {audit.hasQbData && audit.derivedMonthly !== audit.usedMonthly && (
 <div className="vendor-note" style={{ marginTop: 4 }}>
 QB-derived: {formatCurrency(audit.derivedMonthly)}
 </div>
 )}
 </td>
 <td className="num">
 <div>{formatCurrency(audit.expected.monthly)}</div>
 <div className="vendor-note">day {audit.expected.billDay}</div>
 </td>
 <td>
 <div className="vendor-note" style={{ maxWidth: 240 }}>
 {audit.outlierReason ?? audit.expected.notes ?? ''}
 </div>
 </td>
 {projection.map((v, idx) => (
 <td key={idx} className="num">{v ? formatCurrency(v) : '-'}</td>
 ))}
 <td className="num"><strong>{formatCurrency(rowTotal)}</strong></td>
 </tr>
 );
 })}
 <tr className="total-row">
 <td colSpan={8}>TOTAL WEEKLY SUBSCRIPTION OUTFLOW</td>
 {weeklyTotals.map((v, idx) => (
 <td key={idx} className="num">{v ? formatCurrency(v) : '-'}</td>
 ))}
 <td className="num">{formatCurrency(grandTotal)}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 </>
 );
}
