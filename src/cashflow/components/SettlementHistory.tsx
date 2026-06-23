import { useEffect, useState } from 'react';
import { fetchSettlementHistory, type SettlementHistoryResult } from '../api';
import { formatCurrency } from '../format';
import { CollapsibleSection } from './CollapsibleSection';

const POLL_INTERVAL_MS = 30_000;

export function SettlementHistory() {
 const [data, setData] = useState<SettlementHistoryResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 setData(await fetchSettlementHistory({ refresh }));
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load(false);
 const poll = window.setInterval(() => load(false, true), POLL_INTERVAL_MS);
 const onFocus = () => load(false, true);
 window.addEventListener('focus', onFocus);
 return () => {
 window.clearInterval(poll);
 window.removeEventListener('focus', onFocus);
 };
 }, []);

 if (loading && !data) {
 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Settlement History: PureX → Little Tree</h1>
 <div className="page-sub">Loading from Expenses tab…</div>
 </div>
 </div>
 </>
 );
 }
 if (error) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Settlement History</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const { settlements, stats, derived } = data;
 const periodStart = settlements[0]?.date ?? '-';
 const periodEnd = settlements[settlements.length - 1]?.date ?? '-';

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Settlement History: PureX → Little Tree</h1>
 <div className="page-sub">
 Source: PureX bank ledger entries labelled "Little Tree Inv ###" ·
 Period: <strong>{periodStart}</strong> to <strong>{periodEnd}</strong> · {' '}
 <a href={data.sheetUrl} target="_blank" rel="noreferrer">open sheet</a>
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 {/* Headline KPIs */}
 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">Total Settled</div>
 <div className="kpi-period">last {derived.monthsCounted} months</div>
 <div className="kpi-value">{formatCurrency(stats.totalAmount)}</div>
 <div className="kpi-sub">{stats.count} settlements</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Avg Monthly Settlement</div>
 <div className="kpi-period">PureX → LT cash run-rate</div>
 <div className="kpi-value">{formatCurrency(derived.avgMonthlySettlement)}</div>
 <div className="kpi-sub">Avg gap {stats.avgDaysBetween.toFixed(1)} days</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Required Monthly OpEx</div>
 <div className="kpi-period">QB last 3-mo avg</div>
 <div className="kpi-value" style={{ color: 'var(--danger)' }}>{formatCurrency(derived.requiredMonthlyOpex)}</div>
 <div className="kpi-sub">What LT needs each month</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Cash Gap / Month</div>
 <div className="kpi-period">Required − Settled</div>
 <div className="kpi-value" style={{ color: derived.cashGapPerMonth > 0 ? 'var(--danger)' : '#059669' }}>
 {formatCurrency(derived.cashGapPerMonth)}
 </div>
 <div className="kpi-sub">Annualized: {formatCurrency(derived.annualizedCashDrag)}</div>
 </div>
 </div>

 {/* Individual settlements table */}
 <CollapsibleSection
 title={`Individual Settlements (${settlements.length})`}
 sub="Every PureX→LT transfer in the window, oldest first."
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Date</th>
 <th className="num">Amount</th>
 <th className="num">Days Since Prior</th>
 <th className="num">Cumulative</th>
 <th>Notes</th>
 </tr>
 </thead>
 <tbody>
 {settlements.map((s, i) => (
 <tr key={s.date + '-' + i}>
 <td><strong>{s.date}</strong></td>
 <td className="num"><strong>{formatCurrency(s.amount)}</strong></td>
 <td className="num">{i === 0 ? '-' : s.daysSincePrior}</td>
 <td className="num">{formatCurrency(s.cumulative)}</td>
 <td className="vendor-note">{s.description}</td>
 </tr>
 ))}
 <tr className="total-row">
 <td>TOTAL</td>
 <td className="num"><strong>{formatCurrency(stats.totalAmount)}</strong></td>
 <td colSpan={3}></td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 {/* Stats */}
 <CollapsibleSection title="Settlement Statistics">
 <div className="table-wrap">
 <table className="data-table">
 <tbody>
 <tr><td>Number of settlements</td><td className="num"><strong>{stats.count}</strong></td></tr>
 <tr><td>Total amount received</td><td className="num"><strong>{formatCurrency(stats.totalAmount)}</strong></td></tr>
 <tr><td>Average settlement size</td><td className="num">{formatCurrency(stats.avg)}</td></tr>
 <tr><td>Median settlement size</td><td className="num">{formatCurrency(stats.median)}</td></tr>
 <tr><td>Smallest settlement</td><td className="num">{formatCurrency(stats.smallest)}</td></tr>
 <tr><td>Largest settlement</td><td className="num">{formatCurrency(stats.largest)}</td></tr>
 <tr><td>Average days between settlements</td><td className="num">{stats.avgDaysBetween.toFixed(2)}</td></tr>
 <tr><td>Max gap between settlements (days)</td><td className="num">{stats.maxGapDays}</td></tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 {/* Derived */}
 <CollapsibleSection
 title="Derived Metrics"
 sub="Cash gap math - how much LT must fund elsewhere each month."
 >
 <div className="table-wrap">
 <table className="data-table">
 <tbody>
 <tr>
 <td>Avg monthly settlement (last {derived.monthsCounted} months)</td>
 <td className="num"><strong>{formatCurrency(derived.avgMonthlySettlement)}</strong></td>
 <td className="vendor-note">From PureX bank ledger</td>
 </tr>
 <tr>
 <td>Required monthly settlement to cover total OpEx</td>
 <td className="num"><strong>{formatCurrency(derived.requiredMonthlyOpex)}</strong></td>
 <td className="vendor-note">QB expense detail · L3M avg</td>
 </tr>
 <tr className="total-row">
 <td>Cash gap per month at current run-rate</td>
 <td className="num" style={{ color: derived.cashGapPerMonth > 0 ? 'var(--danger)' : '#059669' }}>
 <strong>{formatCurrency(derived.cashGapPerMonth)}</strong>
 </td>
 <td className="vendor-note">Required − Settled</td>
 </tr>
 <tr>
 <td>Cash gap over 13 weeks</td>
 <td className="num">{formatCurrency(derived.cashGapOver13Weeks)}</td>
 <td className="vendor-note">Gap × 3 months</td>
 </tr>
 <tr>
 <td>Implied annualized cash drag</td>
 <td className="num">{formatCurrency(derived.annualizedCashDrag)}</td>
 <td className="vendor-note">Gap × 12 months</td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>
 </>
 );
}
