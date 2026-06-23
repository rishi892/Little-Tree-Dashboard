import { useEffect, useState } from 'react';
import {
 ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { fetchMonthlyOpex, type MonthlyOpexResult } from '../api';
import { formatCurrency } from '../format';
import { CollapsibleSection } from './CollapsibleSection';

const POLL_INTERVAL_MS = 30_000;

export function MonthlySummary() {
 const [data, setData] = useState<MonthlyOpexResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 setData(await fetchMonthlyOpex({ refresh }));
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
 <h1 className="page-title">Monthly Expense Summary: LT vs PureX</h1>
 <div className="page-sub">Loading…</div>
 </div>
 </div>
 </>
 );
 }
 if (error) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Monthly Expense Summary</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const { rows, totals, averages } = data;
 const periodStart = rows[0]?.monthLabel ?? '-';
 const periodEnd = rows[rows.length - 1]?.monthLabel ?? '-';

 const chartData = rows.map((r) => ({
 month: r.monthLabel,
 LT: r.ltDirect,
 PureX: r.purex,
 }));

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Monthly Expense Summary: LT vs PureX</h1>
 <div className="page-sub">
 Source: QB expense detail (per-entity perEntity) + Settlement History · {periodStart} – {periodEnd}
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 {/* Monthly detail table */}
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Monthly Detail</div>
 <div className="section-sub">Live from QB · all months since Jan 2025.</div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Month</th>
 <th className="num">LT Direct OpEx</th>
 <th className="num">PureX OpEx</th>
 <th className="num">TOTAL OpEx</th>
 <th className="num">LT %</th>
 <th className="num">PureX %</th>
 <th className="num">PureX Remitted to LT</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((r) => (
 <tr key={r.monthKey}>
 <td><strong>{r.monthLabel}</strong></td>
 <td className="num">{formatCurrency(r.ltDirect)}</td>
 <td className="num">{formatCurrency(r.purex)}</td>
 <td className="num"><strong>{formatCurrency(r.total)}</strong></td>
 <td className="num">{(r.ltPct * 100).toFixed(1)}%</td>
 <td className="num">{(r.purexPct * 100).toFixed(1)}%</td>
 <td className="num" style={{ color: '#059669' }}>{r.remitted ? formatCurrency(r.remitted) : '-'}</td>
 </tr>
 ))}
 <tr className="total-row">
 <td>TOTAL</td>
 <td className="num"><strong>{formatCurrency(totals.ltDirect)}</strong></td>
 <td className="num"><strong>{formatCurrency(totals.purex)}</strong></td>
 <td className="num"><strong>{formatCurrency(totals.total)}</strong></td>
 <td className="num"><strong>{(totals.ltPct * 100).toFixed(1)}%</strong></td>
 <td className="num"><strong>{(totals.purexPct * 100).toFixed(1)}%</strong></td>
 <td className="num" style={{ color: '#059669' }}><strong>{formatCurrency(totals.remitted)}</strong></td>
 </tr>
 <tr className="total-row">
 <td>AVG / Month</td>
 <td className="num">{formatCurrency(averages.ltDirect)}</td>
 <td className="num">{formatCurrency(averages.purex)}</td>
 <td className="num"><strong>{formatCurrency(averages.total)}</strong></td>
 <td className="num">{(totals.ltPct * 100).toFixed(1)}%</td>
 <td className="num">{(totals.purexPct * 100).toFixed(1)}%</td>
 <td className="num" style={{ color: '#059669' }}>{formatCurrency(averages.remitted)}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>

 {/* Visual chart - collapsed by default */}
 <CollapsibleSection
 title="Visual: Monthly LT vs PureX OpEx"
 sub="Stacked bars - LT-direct (blue) vs PureX-paid (orange)."
 >
 <div style={{ width: '100%', height: 360, padding: '0 12px 16px' }}>
 <ResponsiveContainer>
 <BarChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 8 }}>
 <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
 <XAxis dataKey="month" stroke="var(--muted)" style={{ fontSize: 11 }} />
 <YAxis stroke="var(--muted)" style={{ fontSize: 11 }} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
 <Tooltip
 formatter={(v: number) => formatCurrency(v)}
 contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 6 }}
 />
 <Legend />
 <Bar dataKey="LT" stackId="opex" fill="var(--info)" />
 <Bar dataKey="PureX" stackId="opex" fill="var(--warn)" />
 </BarChart>
 </ResponsiveContainer>
 </div>
 </CollapsibleSection>
 </>
 );
}
