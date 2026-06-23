import { useEffect, useState } from 'react';
import { fetchGelatoArStatus, type GelatoArStatusResult } from '../api';
import { formatCurrency } from '../format';
import { CollapsibleSection } from './CollapsibleSection';

const cleanCust = (s: string) => s.replace(/^gelato[-\s]+/i, '').trim();

export function GelatoArStatus() {
 const [data, setData] = useState<GelatoArStatusResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);

 async function load() {
   setLoading(true);
   setError(null);
   try { setData(await fetchGelatoArStatus()); }
   catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
   finally { setLoading(false); }
 }
 useEffect(() => { load(); }, []);

 if (loading && !data) return (
   <div className="page-head"><h1 className="page-title">Gelato AR Status · {new Date().getUTCFullYear()}</h1><div className="page-sub">Loading Gelato Invoice Tracker…</div></div>
 );
 if (error) return (<>
   <div className="page-head"><h1 className="page-title">Gelato AR Status</h1></div>
   <div className="error">{error}</div>
   <button className="btn ghost" onClick={load}>Retry</button>
 </>);
 if (!data) return null;

 const aging = data.outstandingByAge;
 const agingRows = [
   { label: 'Current (0-30d)', amount: aging.current.amount, count: aging.current.count, tone: '#059669' },
   { label: '31-60 days',      amount: aging.d31_60.amount,  count: aging.d31_60.count,  tone: '#eab308' },
   { label: '61-90 days',      amount: aging.d61_90.amount,  count: aging.d61_90.count,  tone: '#f97316' },
   { label: '91+ days',        amount: aging.d91Plus.amount, count: aging.d91Plus.count, tone: 'var(--danger)' },
 ];

 return (
   <>
     <div className="page-head">
       <div>
         <h1 className="page-title">Gelato AR Status · {data.year}</h1>
         <div className="page-sub">
           Cash collection from the <a href={data.sheetUrl} target="_blank" rel="noreferrer">Gelato Invoice Tracker</a> bucketed by <strong>paid date</strong>. Write-offs excluded from outstanding. As of {data.asOfDate}.
         </div>
       </div>
       <button className="btn ghost" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
     </div>

     <div className="kpis">
       <div className="kpi highlight">
         <div className="kpi-label">YTD collected · {data.year}</div>
         <div className="kpi-period">Cash that landed since Jan 1</div>
         <div className="kpi-value">{formatCurrency(data.collectedYtd)}</div>
         <div className="kpi-sub">{data.collectedYtdInvoiceCount} invoices paid</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">{data.currentMonth.label} collected</div>
         <div className="kpi-period">Current month MTD</div>
         <div className="kpi-value">{formatCurrency(data.collectedThisMonth)}</div>
         <div className="kpi-sub">{data.collectedThisMonthInvoiceCount} invoices</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Outstanding AR</div>
         <div className="kpi-period">All open invoices, any year</div>
         <div className="kpi-value">{formatCurrency(data.outstandingTotal)}</div>
         <div className="kpi-sub">{data.outstandingCount} open</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Prior-year leakage</div>
         <div className="kpi-period">YTD cash from {data.year - 1} invoices</div>
         <div className="kpi-value">{formatCurrency(data.ytdFromPriorYearInvoices)}</div>
         <div className="kpi-sub">{data.ytdFromPriorYearInvoiceCount} invoices · {data.collectedYtd > 0 ? ((data.ytdFromPriorYearInvoices / data.collectedYtd) * 100).toFixed(1) : '0'}% of YTD</div>
       </div>
     </div>

     {/* Missing-date drilldown (collapsed) */}
     {data.paidWithMissingDate > 0 && (
       <CollapsibleSection
         title={`⚠ ${formatCurrency(data.paidWithMissingDate)} paid · date missing on sheet (${data.paidWithMissingDateCount} invoices)`}
         sub="These dollars have a paid amount but no parseable paid-date column - excluded from the monthly/weekly buckets above."
       >
         <div className="table-wrap">
           <table className="data-table" style={{ fontSize: 12 }}>
             <thead>
               <tr>
                 <th>Invoice #</th>
                 <th>Customer</th>
                 <th className="num">Issued</th>
                 <th className="num">Amount</th>
                 <th className="num">Paid</th>
                 <th>Paid-date cell value</th>
               </tr>
             </thead>
             <tbody>
               {data.paidWithMissingDateSamples.map((s) => (
                 <tr key={s.invoiceNumber + s.customer}>
                   <td><strong>{s.invoiceNumber || '-'}</strong></td>
                   <td>{cleanCust(s.customer)}</td>
                   <td className="num vendor-note">{s.invoiceDate || '-'}</td>
                   <td className="num">{formatCurrency(s.amount)}</td>
                   <td className="num"><strong>{formatCurrency(s.paid)}</strong></td>
                   <td style={{ color: 'var(--danger)', fontFamily: 'monospace' }}>{s.paidDateRaw ? `"${s.paidDateRaw}"` : <em style={{ color: 'var(--muted)' }}>(empty)</em>}</td>
                 </tr>
               ))}
             </tbody>
           </table>
         </div>
       </CollapsibleSection>
     )}

     {/* Current-month per-week collection */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">{data.currentMonth.label} · per-week collection</div>
           <div className="section-sub">Mon-Sun weeks clipped to the month.</div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table">
           <thead>
             <tr>
               <th>Week (in-month)</th>
               <th className="num">Collected</th>
               <th className="num">Invoices</th>
               <th></th>
             </tr>
           </thead>
           <tbody>
             {data.collectedByWeekCurrentMonth.map((w) => (
               <tr key={w.weekStart} style={w.isCurrent ? { background: 'var(--accent-soft, #e6f4ef)' } : undefined}>
                 <td><strong>{w.label}</strong>{w.isCurrent && <span className="vendor-note" style={{ marginLeft: 6, fontSize: 10 }}>current</span>}</td>
                 <td className="num">{w.amount > 0 ? formatCurrency(w.amount) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                 <td className="num">{w.invoiceCount || <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                 <td className="num" style={{ color: 'var(--muted)', fontSize: 11 }}>{w.weekStart} → {w.weekEnd}</td>
               </tr>
             ))}
           </tbody>
         </table>
       </div>
     </div>

     {/* Monthly collection ladder */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">{data.year} collection by month</div>
           <div className="section-sub">$ that landed in each calendar month.</div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table">
           <thead>
             <tr>
               <th>Month</th>
               <th className="num">Collected</th>
               <th className="num">Invoices</th>
             </tr>
           </thead>
           <tbody>
             {data.collectedByMonth.map((m) => (
               <tr key={m.ym} style={m.isCurrent ? { background: 'var(--accent-soft, #e6f4ef)' } : undefined}>
                 <td><strong>{m.label}</strong>{m.isCurrent && <span className="vendor-note" style={{ marginLeft: 6, fontSize: 10 }}>MTD</span>}</td>
                 <td className="num">{m.amount > 0 ? formatCurrency(m.amount) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                 <td className="num">{m.invoiceCount || <span style={{ color: 'var(--muted)' }}>-</span>}</td>
               </tr>
             ))}
           </tbody>
         </table>
       </div>
     </div>

     {/* AR aging buckets */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">Outstanding AR · aging buckets</div>
           <div className="section-sub">Days since invoice issue. Write-offs ({data.writeOffStats.count} · {formatCurrency(data.writeOffStats.amount)}) excluded.</div>
         </div>
       </div>
       <div className="kpis" style={{ marginTop: 0 }}>
         {agingRows.map((r) => (
           <div className="kpi" key={r.label}>
             <div className="kpi-label">{r.label}</div>
             <div className="kpi-period">{r.count} invoices</div>
             <div className="kpi-value" style={{ color: r.tone }}>{formatCurrency(r.amount)}</div>
             <div className="kpi-sub">{data.outstandingTotal > 0 ? ((r.amount / data.outstandingTotal) * 100).toFixed(1) : '0'}% of open</div>
           </div>
         ))}
       </div>
     </div>

     {/* Top 10 open invoices */}
     {data.topOpenInvoices.length > 0 && (
       <div className="section">
         <div className="section-head">
           <div>
             <div className="section-title">Top 10 open invoices · biggest $</div>
             <div className="section-sub">The largest outstanding balances. Chase these first.</div>
           </div>
         </div>
         <div className="table-wrap">
           <table className="data-table">
             <thead>
               <tr>
                 <th>Invoice #</th>
                 <th>Customer</th>
                 <th className="num">Issued</th>
                 <th className="num">Amount</th>
                 <th className="num">Paid</th>
                 <th className="num">Outstanding</th>
                 <th className="num">Days open</th>
                 <th>Status</th>
               </tr>
             </thead>
             <tbody>
               {data.topOpenInvoices.map((o) => (
                 <tr key={o.invoiceNumber + o.customer}>
                   <td><strong>{o.invoiceNumber || '-'}</strong></td>
                   <td>{cleanCust(o.customer)}</td>
                   <td className="num vendor-note">{o.invoiceDate || '-'}</td>
                   <td className="num">{formatCurrency(o.amount)}</td>
                   <td className="num" style={{ color: 'var(--muted)' }}>{o.paid > 0 ? formatCurrency(o.paid) : '-'}</td>
                   <td className="num"><strong>{formatCurrency(o.outstanding)}</strong></td>
                   <td className="num" style={{ color: o.daysOpen > 90 ? 'var(--danger)' : o.daysOpen > 60 ? '#f97316' : 'var(--muted)' }}>{o.daysOpen}d</td>
                   <td style={{ color: 'var(--muted)', fontSize: 11 }}>{o.status || '-'}</td>
                 </tr>
               ))}
             </tbody>
           </table>
         </div>
       </div>
     )}
   </>
 );
}
