import { useEffect, useState } from 'react';
import { fetchSalesStatus, type SalesStatusResult } from '../api';
import { formatCurrency } from '../format';

const cleanCust = (s: string) => s.replace(/^little tree[-\s]+/i, '').trim();

export function SalesStatus() {
 const [data, setData] = useState<SalesStatusResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);

 async function load() {
   setLoading(true);
   setError(null);
   try { setData(await fetchSalesStatus()); }
   catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
   finally { setLoading(false); }
 }
 useEffect(() => { load(); }, []);

 if (loading && !data) return (
   <div className="page-head"><h1 className="page-title">Sales Status · {new Date().getUTCFullYear()}</h1><div className="page-sub">Loading from LT Financials…</div></div>
 );
 if (error) return (<>
   <div className="page-head"><h1 className="page-title">Sales Status</h1></div>
   <div className="error">{error}</div>
   <button className="btn ghost" onClick={load}>Retry</button>
 </>);
 if (!data) return null;

 const collectionRate = data.invoicedYtd > 0 ? (data.collectedFromYtd / data.invoicedYtd) * 100 : 0;

 return (
   <>
     <div className="page-head">
       <div>
         <h1 className="page-title">Sales Status · {data.year}</h1>
         <div className="page-sub">
           Invoicing bucketed by <strong>invoice date</strong>. Gelato + brand-side (Alien Brainz · Funk'd Up · Yacht Fuel) excluded - they have own pipelines. As of {data.asOfDate}.
         </div>
       </div>
       <button className="btn ghost" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
     </div>

     <div className="kpis">
       <div className="kpi highlight">
         <div className="kpi-label">YTD invoiced · {data.year}</div>
         <div className="kpi-period">Billed since Jan 1</div>
         <div className="kpi-value">{formatCurrency(data.invoicedYtd)}</div>
         <div className="kpi-sub">{data.invoicedYtdCount} invoices issued</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">{data.currentMonth.label} invoiced</div>
         <div className="kpi-period">Current month MTD</div>
         <div className="kpi-value">{formatCurrency(data.invoicedThisMonth)}</div>
         <div className="kpi-sub">{data.invoicedThisMonthCount} invoices</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Collected from YTD invoices</div>
         <div className="kpi-period">Paid against {data.year} billing</div>
         <div className="kpi-value" style={{ color: collectionRate > 70 ? '#059669' : collectionRate > 50 ? '#eab308' : 'var(--danger)' }}>{formatCurrency(data.collectedFromYtd)}</div>
         <div className="kpi-sub">{collectionRate.toFixed(1)}% collection rate</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Outstanding from YTD</div>
         <div className="kpi-period">{data.year} invoices still open</div>
         <div className="kpi-value">{formatCurrency(data.outstandingFromYtd)}</div>
         <div className="kpi-sub">{data.outstandingFromYtdCount} open invoices</div>
       </div>
     </div>

     {/* Current-month per-week invoicing */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">{data.currentMonth.label} · per-week invoicing</div>
           <div className="section-sub">Mon-Sun weeks clipped to the month. Invoices grouped by issue date.</div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table">
           <thead>
             <tr>
               <th>Week (in-month)</th>
               <th className="num">Invoiced</th>
               <th className="num">Invoices</th>
               <th></th>
             </tr>
           </thead>
           <tbody>
             {data.invoicedByWeekCurrentMonth.map((w) => (
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

     {/* Monthly invoicing ladder */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">{data.year} invoicing by month</div>
           <div className="section-sub">$ invoiced in each calendar month based on issue date.</div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table">
           <thead>
             <tr>
               <th>Month</th>
               <th className="num">Invoiced</th>
               <th className="num">Invoices</th>
             </tr>
           </thead>
           <tbody>
             {data.invoicedByMonth.map((m) => (
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

     {/* Top 10 customers by YTD invoiced */}
     {data.topCustomersYtd.length > 0 && (
       <div className="section">
         <div className="section-head">
           <div>
             <div className="section-title">Top 10 customers · {data.year} invoiced</div>
             <div className="section-sub">Biggest buyers by $ invoiced this year. Collection rate shows how much of their YTD billing has paid.</div>
           </div>
         </div>
         <div className="table-wrap">
           <table className="data-table">
             <thead>
               <tr>
                 <th>Customer</th>
                 <th className="num">Invoiced ({data.year})</th>
                 <th className="num">Paid</th>
                 <th className="num">Outstanding</th>
                 <th className="num">Invoices</th>
                 <th className="num">Collection %</th>
                 <th className="num">Last invoice</th>
               </tr>
             </thead>
             <tbody>
               {data.topCustomersYtd.map((c) => {
                 const pct = c.invoicedAmount > 0 ? (c.paidAmount / c.invoicedAmount) * 100 : 0;
                 const tone = pct > 80 ? '#059669' : pct > 50 ? '#eab308' : 'var(--danger)';
                 return (
                   <tr key={c.customer}>
                     <td><strong>{cleanCust(c.customer)}</strong></td>
                     <td className="num"><strong>{formatCurrency(c.invoicedAmount)}</strong></td>
                     <td className="num" style={{ color: 'var(--muted)' }}>{formatCurrency(c.paidAmount)}</td>
                     <td className="num">{c.outstandingAmount > 0.5 ? formatCurrency(c.outstandingAmount) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                     <td className="num">{c.invoiceCount}</td>
                     <td className="num" style={{ color: tone }}>{pct.toFixed(1)}%</td>
                     <td className="num vendor-note">{c.lastInvoiceDate ?? '-'}</td>
                   </tr>
                 );
               })}
             </tbody>
           </table>
         </div>
       </div>
     )}
   </>
 );
}
