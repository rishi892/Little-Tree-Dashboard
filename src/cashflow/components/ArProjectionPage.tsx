import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchArOpenInvoices, fetchArCollectionsHistory, type ArOpenResult, type ArOpenInvoice, type ArCollectionsHistory } from '../api';
import { formatCurrency } from '../format';
import { WeeklyRowEdit } from './WeeklyRowEdit';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Seg = 'all' | 'littleTree' | 'infusedOrigin';
const SEGS: Array<{ key: Seg; label: string }> = [
 { key: 'all', label: 'All' },
 { key: 'littleTree', label: 'Little Tree' },
 { key: 'infusedOrigin', label: 'Infused Origin' },
];

const AMBER = '#d97706';   // matches the AR dashboard's outstanding colour
const RED = '#dc2626';

/**
 * AR tab - Little Tree open AR straight from the Invoice Tracker, computed
 * EXACTLY like the AR dashboard (Money Owed). KPI cards (dashboard colours) open
 * the invoice list in a popup; All / Little Tree / Infused Origin toggle; the
 * editable weekly AR feeds the 13-Week.
 */
export function ArProjectionPage() {
 const [data, setData] = useState<ArOpenResult | null>(null);
 const [seg, setSeg] = useState<Seg>('all');
 const [modal, setModal] = useState<{ title: string; rows: ArOpenInvoice[] } | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);

 async function load() {
 setLoading(true); setError(null);
 try { setData(await fetchArOpenInvoices()); }
 catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
 finally { setLoading(false); }
 }
 useEffect(() => { void load(); }, []);

 const inSeg = (i: ArOpenInvoice) => seg === 'all' ? true : seg === 'infusedOrigin' ? i.infusedOrigin : !i.infusedOrigin;
 const invoices = useMemo(() => (data?.invoices ?? []).filter(inSeg), [data, seg]);
 const total = useMemo(() => invoices.reduce((s, i) => s + i.amount, 0), [invoices]);
 const overdueRows = useMemo(() => invoices.filter((i) => i.status === 'Overdue'), [invoices]);
 const oldRows = useMemo(() => invoices.filter((i) => i.bucket === '180+'), [invoices]);
 const BUCKET_ORDER = ['Current', '1-30', '31-60', '61-90', '91-120', '121-180', '180+'];
 const buckets = useMemo(() => {
 const b: Record<string, number> = {};
 for (const k of BUCKET_ORDER) b[k] = 0;
 for (const i of invoices) b[i.bucket] = (b[i.bucket] ?? 0) + i.amount;
 return b;
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [invoices]);

 if (loading && !data) {
 return <div className="page-head"><div><h1 className="page-title">AR · Little Tree</h1><div className="page-sub">Loading…</div></div></div>;
 }
 if (error && !data) {
 return (<>
 <div className="page-head"><div><h1 className="page-title">AR · Little Tree</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => void load()}>Retry</button>
 </>);
 }
 if (!data) return null;

 const fmt0 = (n: number) => formatCurrency(Math.round(n));
 const overdue = overdueRows.reduce((s, i) => s + i.amount, 0);

 const kpis = [
 { label: 'TOTAL OUTSTANDING', val: total, color: AMBER, sub: `${invoices.length} invoices`, rows: invoices, title: 'Open invoices' },
 { label: 'OVERDUE (>30d)', val: overdue, color: AMBER, sub: `${overdueRows.length} invoices`, rows: overdueRows, title: 'Overdue invoices' },
 { label: '180+ DAYS PAST DUE', val: buckets['180+'] ?? 0, color: RED, sub: `${oldRows.length} invoices`, rows: oldRows, title: '180+ days past due' },
 ];

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">AR · Little Tree</h1>
 <div className="page-sub">Open invoices from the AR dashboard source of truth (Invoice Tracker · "Money Owed") · as of {data.asOfDate}. Click a card to see its invoices.</div>
 </div>
 <button className="btn ghost" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
 </div>

 {/* All / Little Tree / Infused Origin toggle */}
 <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
 <div style={{ display: 'inline-flex', background: 'var(--surface, #f1f5f9)', borderRadius: 10, padding: 3, gap: 2 }}>
 {SEGS.map((sgmt) => (
 <button key={sgmt.key} onClick={() => setSeg(sgmt.key)}
 style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: seg === sgmt.key ? 700 : 500,
 background: seg === sgmt.key ? 'var(--accent, #047857)' : 'transparent', color: seg === sgmt.key ? '#fff' : 'var(--muted)' }}>
 {sgmt.label}
 </button>
 ))}
 </div>
 </div>

 {/* KPI cards - dashboard colours, clickable → popup */}
 <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginBottom: 16 }}>
 {kpis.map((k) => (
 <button key={k.label} onClick={() => setModal({ title: `${k.title} · ${SEGS.find((x) => x.key === seg)?.label}`, rows: k.rows })}
 className="section" style={{ padding: '16px 18px', textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--bg)' }}
 title="Click to see invoices">
 <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.04em' }}>{k.label}</div>
 <div style={{ fontSize: 28, fontWeight: 700, margin: '4px 0', color: k.color }}>{fmt0(k.val)}</div>
 <div style={{ fontSize: 11, color: 'var(--muted)' }}>{k.sub} · <span style={{ color: 'var(--accent-hover, #047857)' }}>view →</span></div>
 </button>
 ))}
 </div>

 {/* Editable weekly AR (feeds the 13-Week grid) — top */}
 <WeeklyRowEdit rowRx={/past ar/i} heading="Edit weekly AR collections" sub="What we expect to collect each week (all non-Gelato AR)" />

 {/* Aging buckets */}
 <div className="section">
 <div className="section-head"><div><div className="section-title">Aging · {SEGS.find((x) => x.key === seg)?.label}</div><div className="section-sub">Open AR by days past due (today − due date) · same as the AR dashboard. Click a row to see invoices.</div></div></div>
 <div className="table-wrap">
 <table className="data-table">
 <thead><tr><th>Days past due</th><th className="num">Open AR</th><th>Spread</th></tr></thead>
 <tbody>
 {BUCKET_ORDER.filter((b) => (buckets[b] ?? 0) > 0).map((bucket) => {
 const amt = buckets[bucket] ?? 0;
 return (
 <tr key={bucket} style={{ cursor: 'pointer' }} onClick={() => setModal({ title: `${bucket === 'Current' ? 'Current (not due)' : bucket + ' days past due'} · ${SEGS.find((x) => x.key === seg)?.label}`, rows: invoices.filter((i) => i.bucket === bucket) })}>
 <td>{bucket === 'Current' ? 'Current (not due)' : `${bucket} days`}</td>
 <td className="num">{fmt0(amt)}</td>
 <td><div style={{ height: 10, width: `${Math.min(100, (amt / Math.max(1, total)) * 100)}%`, minWidth: 2, background: bucket === '180+' ? RED : AMBER, borderRadius: 3 }} /></td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>

 {/* AR collections trend — month × year (reference, at the bottom) */}
 <ArCollectionsHistorySection />

 {modal && createPortal(
 <InvoiceModal title={modal.title} rows={modal.rows} onClose={() => setModal(null)} />,
 document.body,
 )}
 </>
 );
}

/**
 * AR collections trend — month × year grid + seasonality, from LT Financials paid
 * history (non-Gelato, by paid date). The AR-side mirror of the Sales Projection
 * page: "kitna AR har month/year wapas aata hai" — the trend the projection rests on.
 */
function ArCollectionsHistorySection() {
 const [h, setH] = useState<ArCollectionsHistory | null>(null);
 const [err, setErr] = useState<string | null>(null);
 useEffect(() => { fetchArCollectionsHistory().then(setH).catch((e) => setErr(e instanceof Error ? e.message : 'Failed')); }, []);
 const fmtK = (n: number) => (n > 0 ? formatCurrency(Math.round(n)) : '–');
 if (err) return <div className="section"><div className="section-title">AR collections trend</div><div className="error" style={{ marginTop: 8 }}>{err}</div></div>;
 if (!h) return <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading AR collections trend…</div>;

 const years = h.years;
 return (
  <div className="section">
   <div className="section-head"><div>
    <div className="section-title">AR collections trend · month × year</div>
    <div className="section-sub">How much AR actually collected each month/year (Little Tree non-Gelato, by paid date — from LT Financials). This is the real trend the AR projection rests on. Recent run-rate <strong>{fmtK(h.recentMonthlyAvg)}/mo ≈ {fmtK(h.recentWeeklyAvg)}/wk</strong>.</div>
   </div></div>
   <div className="table-wrap">
    <table className="data-table" style={{ fontSize: 12 }}>
     <thead><tr>
      <th>Month</th>
      {years.map((y) => <th key={y} className="num">{y}</th>)}
     </tr></thead>
     <tbody>
      {MONTHS.map((mn, m) => (
       <tr key={mn}>
        <td><strong>{mn}</strong></td>
        {years.map((y) => <td key={y} className="num" style={{ color: h.grid[m][y] ? 'var(--text)' : 'var(--muted)' }}>{fmtK(h.grid[m][y] ?? 0)}</td>)}
       </tr>
      ))}
      <tr className="total-row">
       <td><strong>YEAR TOTAL</strong></td>
       {years.map((y) => <td key={y} className="num"><strong>{fmtK(h.yearTotals[y] ?? 0)}</strong></td>)}
      </tr>
     </tbody>
    </table>
   </div>
  </div>
 );
}

function InvoiceModal({ title, rows, onClose }: { title: string; rows: ArOpenInvoice[]; onClose: () => void }) {
 const fmt0 = (n: number) => formatCurrency(Math.round(n));
 const total = rows.reduce((s, i) => s + i.amount, 0);
 return (
 <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
 <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg, #fff)', borderRadius: 12, maxWidth: 980, width: '100%', maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
 <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
 <div><strong style={{ fontSize: 16 }}>{title}</strong> <span style={{ color: 'var(--muted)' }}>· {rows.length} invoices · {fmt0(total)}</span></div>
 <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--muted)' }}>×</button>
 </div>
 <div style={{ overflow: 'auto', padding: '0 4px' }}>
 <table className="data-table">
 <thead><tr>
 <th style={{ minWidth: 220 }}>Customer</th><th>Invoice</th><th>Issued</th>
 <th className="num">Open</th><th className="num">Days past due</th><th>Bucket</th><th>Type</th>
 </tr></thead>
 <tbody>
 {rows.slice(0, 400).map((inv) => (
 <tr key={`${inv.invoiceNumber}-${inv.customer}`}>
 <td>{inv.customer}</td>
 <td>{inv.invoiceNumber}</td>
 <td style={{ whiteSpace: 'nowrap' }}>{inv.issueDate}</td>
 <td className="num"><strong>{fmt0(inv.amount)}</strong></td>
 <td className="num">{inv.daysOut}</td>
 <td>{inv.bucket}</td>
 <td>{inv.infusedOrigin ? <span style={{ fontSize: 11, color: 'var(--accent-hover, #047857)' }}>Infused Origin</span> : <span style={{ fontSize: 11, color: 'var(--muted)' }}>Little Tree</span>}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 );
}
