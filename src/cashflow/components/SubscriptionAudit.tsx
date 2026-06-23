import { useEffect, useState } from 'react';
import { fetchSubscriptionAudit, type AuditRow, type SubscriptionAudit } from '../api';
import { formatCurrency } from '../format';

const TYPE_LABEL: Record<AuditRow['matchType'], string> = {
 strong: 'Strong',
 fuzzy: 'Fuzzy',
 line: 'Line-item',
 none: 'Missing',
};

function diffFlag(row: AuditRow): { text: string; tone: 'warn' | 'ok' | 'muted' } | null {
 if (row.matchType === 'none') return { text: 'Not in QBO', tone: 'warn' };
 if (!row.activity) return null;
 const diff = row.activity.avgAmount - row.expected.monthly;
 const tolerance = Math.max(5, row.expected.monthly * 0.15);
 if (Math.abs(diff) <= tolerance) return { text: 'In range', tone: 'ok' };
 const sign = diff > 0 ? '+' : '';
 return { text: `${sign}${formatCurrency(diff)} vs expected`, tone: 'warn' };
}

export function SubscriptionAudit() {
 const [data, setData] = useState<SubscriptionAudit | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [filter, setFilter] = useState<AuditRow['matchType'] | 'all'>('all');

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 const d = await fetchSubscriptionAudit({ months: 16, refresh });
 setData(d);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed to load audit');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load(false);
 const poll = window.setInterval(() => load(false, true), 60_000);
 const onFocus = () => load(false, true);
 window.addEventListener('focus', onFocus);
 return () => {
 window.clearInterval(poll);
 window.removeEventListener('focus', onFocus);
 };
 }, []);

 if (loading && !data) {
 return (
 <section className="card chart-card">
 <div className="chart-title">Subscriptions audit</div>
 <div className="chart-subtitle">Loading… (first run pulls all vendors + 6 months of purchases, ~5–10s)</div>
 </section>
 );
 }

 if (error) {
 return (
 <section className="card chart-card">
 <div className="chart-title">Subscriptions audit</div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </section>
 );
 }

 if (!data) return null;

 const rows = filter === 'all' ? data.rows : data.rows.filter((r) => r.matchType === filter);

 const expectedTotal = data.rows.reduce((s, r) => s + r.expected.monthly, 0);
 const observedTotal = data.rows.reduce((s, r) => s + (r.activity?.avgAmount ?? 0), 0);

 return (
 <section className="card chart-card">
 <div className="audit-head">
 <div>
 <div className="chart-title">Subscriptions audit</div>
 <div className="chart-subtitle">
 {data.rows.length} expected vendors vs QBO ({data.totals.vendors} vendors, {data.totals.purchases} purchases,
 {' '}{data.totals.bills} bills in last {data.lookbackMonths} mo).
 {data.cached && <> · cached</>}
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 <div className="audit-summary">
 <Pill label="Strong" value={data.counts.strong} active={filter === 'strong'} onClick={() => setFilter(filter === 'strong' ? 'all' : 'strong')} tone="ok" />
 <Pill label="Fuzzy" value={data.counts.fuzzy} active={filter === 'fuzzy'} onClick={() => setFilter(filter === 'fuzzy' ? 'all' : 'fuzzy')} tone="warn" />
 <Pill label="Line-item" value={data.counts.line} active={filter === 'line'} onClick={() => setFilter(filter === 'line' ? 'all' : 'line')} tone="info" />
 <Pill label="Missing" value={data.counts.missing} active={filter === 'none'} onClick={() => setFilter(filter === 'none' ? 'all' : 'none')} tone="danger" />
 <Pill label="Expected /mo" value={formatCurrency(expectedTotal)} tone="muted" />
 <Pill label="Observed avg" value={formatCurrency(observedTotal)} tone="muted" />
 </div>

 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Vendor</th>
 <th className="num">Expected /mo</th>
 <th>Match (QBO)</th>
 <th>Type</th>
 {data.monthLabels.map((label, i) => (
 <th key={data.months[i]} className="num">{label}</th>
 ))}
 <th className="num">Total</th>
 <th className="num">Avg amt</th>
 <th>Flag</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((r) => {
 const flag = diffFlag(r);
 return (
 <tr key={r.expected.name} className={`row-${r.matchType}`}>
 <td>
 <div className="vendor-name">{r.expected.name}</div>
 {r.expected.notes && <div className="vendor-note">{r.expected.notes}</div>}
 </td>
 <td className="num">{formatCurrency(r.expected.monthly)}</td>
 <td>
 {r.bestMatchName ? (
 <span>{r.bestMatchName}</span>
 ) : r.lineHits.length > 0 ? (
 <span className="vendor-note" title={r.lineHits[0].description}>
 {r.lineHits[0].description.slice(0, 40)}{r.lineHits[0].description.length > 40 ? '…' : ''}
 </span>
 ) : (
 <span className="vendor-note">-</span>
 )}
 </td>
 <td>
 <span className={`pill-tag tag-${r.matchType}`}>{TYPE_LABEL[r.matchType]}</span>
 {r.bestMatchScore > 0 && r.matchType !== 'line' && (
 <span className="vendor-note" style={{ marginLeft: 6 }}>{r.bestMatchScore.toFixed(2)}</span>
 )}
 </td>
 {r.monthlyAmounts.map((v, idx) => (
 <td key={idx} className="num">{v ? formatCurrency(v) : '-'}</td>
 ))}
 <td className="num"><strong>{r.activity ? formatCurrency(r.activity.totalAmount) : '-'}</strong></td>
 <td className="num">{r.activity ? formatCurrency(r.activity.avgAmount) : '-'}</td>
 <td>{flag ? <span className={`pill-tag tag-${flag.tone}`}>{flag.text}</span> : null}</td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>

 {data.unexpectedVendors.length > 0 && (
 <details className="audit-unexpected">
 <summary>
 Recurring QBO vendors <em>not</em> on the expected list ({data.unexpectedVendors.length}) - possible missed subs or other recurring spend
 </summary>
 <div className="table-wrap" style={{ marginTop: 12 }}>
 <table className="data-table">
 <thead>
 <tr>
 <th>Vendor</th>
 <th className="num">Txns</th>
 <th className="num">Total</th>
 <th className="num">Avg</th>
 <th>Last seen</th>
 </tr>
 </thead>
 <tbody>
 {data.unexpectedVendors.map((u) => (
 <tr key={u.displayName}>
 <td>{u.displayName}</td>
 <td className="num">{u.txnCount}</td>
 <td className="num">{formatCurrency(u.totalAmount)}</td>
 <td className="num">{formatCurrency(u.avgAmount)}</td>
 <td>{u.lastDate}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </details>
 )}
 </section>
 );
}

function Pill({
 label,
 value,
 tone,
 active,
 onClick,
}: {
 label: string;
 value: string | number;
 tone: 'ok' | 'warn' | 'info' | 'danger' | 'muted';
 active?: boolean;
 onClick?: () => void;
}) {
 return (
 <button
 type="button"
 className={`audit-pill tone-${tone}${active ? ' active' : ''}${onClick ? '' : ' static'}`}
 onClick={onClick}
 disabled={!onClick}
 >
 <span className="audit-pill-label">{label}</span>
 <span className="audit-pill-value">{value}</span>
 </button>
 );
}
