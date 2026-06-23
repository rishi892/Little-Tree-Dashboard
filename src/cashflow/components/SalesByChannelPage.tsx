import { useEffect, useMemo, useState } from 'react';
import { fetchSalesByChannel, type SalesByChannelResult } from '../api';
import { formatCurrency } from '../format';

const dash = (n: number) => (n === 0 ? <span style={{ color: 'var(--muted)' }}>-</span> : formatCurrency(n));

export default function SalesByChannelPage() {
 const [data, setData] = useState<SalesByChannelResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);

 async function load(refresh = false) {
 setLoading(true);
 setError(null);
 try {
 setData(await fetchSalesByChannel({ refresh }));
 } catch (e) {
 setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 setLoading(false);
 }
 }
 useEffect(() => { load(false); }, []);

 const kpis = useMemo(() => {
 if (!data) return null;
 const gelatoTotal = data.subtotals.gelatoRaw.reduce((s, v) => s + v, 0);
 const othersTotal = data.subtotals.othersRaw.reduce((s, v) => s + v, 0);
 const grandTotal = gelatoTotal + othersTotal;
 return { gelatoTotal, othersTotal, grandTotal, months: data.months.length };
 }, [data]);

 if (loading && !data) {
 return (
 <div className="page-head">
 <div>
 <h1 className="page-title">Historical Sales by Channel</h1>
 <div className="page-sub">Loading from Invoice Tracker + Gelato Sales sheet…</div>
 </div>
 </div>
 );
 }
 if (error) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Historical Sales by Channel</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data || !kpis) return null;

 const gelatoRows = data.rows.filter((r) => r.group === 'Gelato');
 const otherRows = data.rows.filter((r) => r.group === 'Other');
 const monthCount = data.months.length;
 const periodStart = data.months[0].label.replace('*', '');
 const periodEnd = data.months[data.months.length - 1].label.replace('*', '');

 // Strip "Little Tree- " prefix from customer name for cleaner KPI cards.
 const cleanCust = (s: string) => s.replace(/^little tree[-\s]+/i, '').trim();

 function renderChannelRow(r: { channel: string; monthly: number[] }) {
 const series = r.monthly;
 const total = series.reduce((s, v) => s + v, 0);
 const avg = total / monthCount;
 const isEmpty = total === 0;
 return (
 <tr key={r.channel} style={isEmpty ? { color: 'var(--muted)' } : undefined}>
 <td><strong>{r.channel}</strong></td>
 {series.map((v, i) => (
   <td key={i} className="num">{dash(v)}</td>
 ))}
 <td className="num"><strong>{dash(total)}</strong></td>
 <td className="num" style={{ color: 'var(--muted)' }}>{dash(avg)}</td>
 </tr>
 );
 }

 function renderSubtotalRow(label: string, raw: number[]) {
 const total = raw.reduce((s, v) => s + v, 0);
 const avg = total / monthCount;
 return (
 <tr className="subtotal-row">
 <td>{label}</td>
 {raw.map((v, i) => (
 <td key={i} className="num">{dash(v)}</td>
 ))}
 <td className="num">{dash(total)}</td>
 <td className="num">{dash(avg)}</td>
 </tr>
 );
 }

 function renderGrandTotalRow() {
 const series = data!.months.map((_, i) => data!.subtotals.gelatoRaw[i] + data!.subtotals.othersRaw[i]);
 const total = series.reduce((s, v) => s + v, 0);
 const avg = total / monthCount;
 return (
 <tr className="total-row">
 <td>GRAND TOTAL</td>
 {series.map((v, i) => (
 <td key={i} className="num">{formatCurrency(v)}</td>
 ))}
 <td className="num">{formatCurrency(total)}</td>
 <td className="num">{formatCurrency(avg)}</td>
 </tr>
 );
 }

 function renderGroupHeader(label: string, badge?: string) {
 return (
 <tr className="group-row">
 <td colSpan={monthCount + 3}>
 <span>{label}</span>
 {badge && <span style={{ marginLeft: 10, padding: '2px 8px', background: 'rgba(255,255,255,0.6)', borderRadius: 4, color: 'var(--accent)', fontSize: 10 }}>{badge}</span>}
 </td>
 </tr>
 );
 }

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Historical Sales by Channel</h1>
 <div className="page-sub">
 {periodStart} – {periodEnd} · raw sales straight from Invoice Tracker + Gelato Sales sheet · no normalisation
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 {/* Top-line totals strip */}
 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">GRAND TOTAL</div>
 <div className="kpi-period">{periodStart} – {periodEnd}</div>
 <div className="kpi-value">{formatCurrency(kpis.grandTotal)}</div>
 <div className="kpi-sub">{formatCurrency(kpis.grandTotal / kpis.months)} avg/mo</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Gelato Sales</div>
 <div className="kpi-period">Net 90 · dedicated sheet</div>
 <div className="kpi-value">{formatCurrency(kpis.gelatoTotal)}</div>
 <div className="kpi-sub">{formatCurrency(kpis.gelatoTotal / kpis.months)} avg/mo</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Other Customers</div>
 <div className="kpi-period">Net 30 · Invoice Tracker</div>
 <div className="kpi-value">{formatCurrency(kpis.othersTotal)}</div>
 <div className="kpi-sub">{formatCurrency(kpis.othersTotal / kpis.months)} avg/mo</div>
 </div>
 </div>

 {/* Top 5 customers by total $ - actual customer names from Invoice Tracker. */}
 {data.topCustomers.length > 0 && (
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Top 5 customers · {periodStart} – {periodEnd}</div>
 <div className="section-sub">Biggest buyers by gross $ over the window. Channel tag shows which group each customer rolls up into.</div>
 </div>
 </div>
 <div className="kpis" style={{ marginTop: 0 }}>
 {data.topCustomers.map((c, idx) => (
 <div className="kpi" key={c.customer}>
 <div className="kpi-label">#{idx + 1} · {cleanCust(c.customer).slice(0, 30)}{cleanCust(c.customer).length > 30 ? '…' : ''}</div>
 <div className="kpi-period">{c.channel}</div>
 <div className="kpi-value">{formatCurrency(c.total)}</div>
 <div className="kpi-sub">{c.invoiceCount} inv · {c.monthsActive} months active · last {c.lastInvoiceMonth ?? '-'}</div>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Cooling / lost customers: active 4-6 months ago, silent in last 3 months.
     Sorted by lost revenue so the biggest at-risk accounts surface first. */}
 {data.coolingCustomers.length > 0 && (
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">⚠ Cooling customers · went silent</div>
 <div className="section-sub">
 Had real orders 4-6 months ago (≥2 of those 3 months) but zero in the last 3 months.
 Sorted by lost revenue · total at risk{' '}
 <strong>{formatCurrency(data.coolingCustomers.reduce((s, c) => s + c.prior3Total, 0))}</strong>
 {' '}({data.coolingCustomers.length} accounts).
 </div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Customer</th>
 <th>Channel</th>
 <th className="num">Sales 4-6 mo ago</th>
 <th className="num">Active months</th>
 <th className="num">Last invoice</th>
 </tr>
 </thead>
 <tbody>
 {data.coolingCustomers.map((c) => (
 <tr key={c.customer}>
 <td><strong>{cleanCust(c.customer)}</strong></td>
 <td style={{ color: 'var(--muted)' }}>{c.channel}</td>
 <td className="num"><strong>{formatCurrency(c.prior3Total)}</strong></td>
 <td className="num">{c.prior3MonthsActive}/3</td>
 <td className="num" style={{ color: 'var(--muted)' }}>{c.lastInvoiceMonth ?? '-'}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}

 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Monthly Detail</div>
 <div className="section-sub">
 5 channels only · raw amounts straight from <strong>Little Tree Financials</strong> sheet (no normalisation).
 Gelato shown separately from its dedicated Gelato Sales sheet.
 </div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Channel / Customer</th>
 {data.months.map((m) => (
 <th key={m.key} className="num">{m.label}</th>
 ))}
 <th className="num">Total</th>
 <th className="num">Avg/Mo</th>
 </tr>
 </thead>
 <tbody>
 {renderGroupHeader('Gelato Channel', 'NET 90')}
 {gelatoRows.map(renderChannelRow)}
 {renderSubtotalRow('Gelato Subtotal', data.subtotals.gelatoRaw)}

 {renderGroupHeader('Other Customers', 'NET 30')}
 {otherRows.map(renderChannelRow)}
 {renderSubtotalRow('Others Subtotal', data.subtotals.othersRaw)}

 {renderGrandTotalRow()}
 </tbody>
 </table>
 </div>
 </div>
 </>
 );
}
