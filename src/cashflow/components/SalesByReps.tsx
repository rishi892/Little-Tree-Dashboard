import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSalesByReps, type SalesByRepsResult } from '../api';
import { formatCurrency } from '../format';

const cleanCust = (s: string) => s.replace(/^little tree[-\s]+/i, '').trim();
const dash = (n: number) => (n === 0 ? <span style={{ color: 'var(--muted)' }}>-</span> : formatCurrency(n));

// Background poll cadence - matches commission sheet's server-side 60s TTL,
// so the UI sees sheet edits within ~1 minute without a manual refresh.
const POLL_MS = 60_000;

export function SalesByReps() {
 const [data, setData] = useState<SalesByRepsResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [silentRefreshing, setSilentRefreshing] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [expanded, setExpanded] = useState<string | null>(null);
 const lastFetchedRef = useRef<number>(0);

 // silent=true → background refresh (no full-screen loader, just amber dot pulse).
 async function load(silent = false) {
   if (silent) setSilentRefreshing(true);
   else setLoading(true);
   setError(null);
   try {
     setData(await fetchSalesByReps());
     lastFetchedRef.current = Date.now();
   } catch (e) {
     if (!silent) setError(e instanceof Error ? e.message : 'Failed');
   } finally {
     if (silent) setSilentRefreshing(false);
     else setLoading(false);
   }
 }

 useEffect(() => {
   load();
   const poll = window.setInterval(() => load(true), POLL_MS);
   const onFocus = () => { if (Date.now() - lastFetchedRef.current > 10_000) load(true); };
   const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
   window.addEventListener('focus', onFocus);
   document.addEventListener('visibilitychange', onVisibility);
   return () => {
     window.clearInterval(poll);
     window.removeEventListener('focus', onFocus);
     document.removeEventListener('visibilitychange', onVisibility);
   };
 }, []);

 const realReps = useMemo(() => data?.rows.filter((r) => r.rep !== 'Unmapped') ?? [], [data]);
 const unmappedRow = useMemo(() => data?.rows.find((r) => r.rep === 'Unmapped') ?? null, [data]);
 const topRep = realReps[0];

 if (loading && !data) return (
   <div className="page-head"><h1 className="page-title">Sales by Reps</h1><div className="page-sub">Loading from LT Financials + commission sheet (12 monthly tabs)…</div></div>
 );
 if (error) return (<>
   <div className="page-head"><h1 className="page-title">Sales by Reps</h1></div>
   <div className="error">{error}</div>
   <button className="btn ghost" onClick={load}>Retry</button>
 </>);
 if (!data) return null;

 const { months, totals, warnings } = data;

 return (
   <>
     <div className="page-head">
       <div>
         <h1 className="page-title">
           Sales by Reps
           <span
             title={silentRefreshing ? 'Re-fetching…' : `Auto-refreshes every ${POLL_MS / 1000}s`}
             style={{
               display: 'inline-block',
               marginLeft: 10,
               width: 8,
               height: 8,
               borderRadius: 8,
               background: silentRefreshing ? '#eab308' : '#059669',
               boxShadow: silentRefreshing ? '0 0 6px #eab308' : '0 0 6px #059669',
               verticalAlign: 'middle',
             }}
           />
         </h1>
         <div className="page-sub">
           Auto-refreshing every {POLL_MS / 1000}s · sales from <a href={data.sourceLtFinancialsUrl} target="_blank" rel="noreferrer">LT Financials</a>{' '}
           · rep attribution from <a href={data.sourceCommissionSheetUrl} target="_blank" rel="noreferrer">commission sheet</a> · Gelato + brand-side (Alien Brainz · Funk'd Up · Yacht Fuel) excluded.
           {silentRefreshing && <span style={{ marginLeft: 8, color: '#eab308' }}>· refreshing…</span>}
         </div>
       </div>
       <button className="btn ghost" onClick={() => load(false)} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh now'}</button>
     </div>

     {warnings.length > 0 && (
       <div className="section" style={{ background: 'rgba(234, 179, 8, 0.06)', border: '1px dashed rgba(234, 179, 8, 0.4)', borderRadius: 6, padding: 10, fontSize: 12, color: 'var(--muted)' }}>
         {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
       </div>
     )}

     <div className="kpis">
       <div className="kpi highlight">
         <div className="kpi-label">Total sales (mapped + unmapped)</div>
         <div className="kpi-period">{months[0]?.label} → {months[months.length - 1]?.label}</div>
         <div className="kpi-value">{formatCurrency(totals.grandTotal)}</div>
         <div className="kpi-sub">{totals.invoiceCount.toLocaleString()} invoices</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Top rep</div>
         <div className="kpi-period">{topRep?.rep ?? '-'}</div>
         <div className="kpi-value">{formatCurrency(topRep?.total ?? 0)}</div>
         <div className="kpi-sub">{topRep?.invoiceCount ?? 0} invoices</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Active reps</div>
         <div className="kpi-period">{realReps.length} reps with sales</div>
         <div className="kpi-value">{realReps.length}</div>
         <div className="kpi-sub">{realReps.map((r) => r.rep).join(', ')}</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Coverage (with prediction)</div>
         <div className="kpi-period">{totals.coveragePct.toFixed(1)}% confirmed · {(totals.coveragePctIncludingPredicted - totals.coveragePct).toFixed(1)}% predicted</div>
         <div className="kpi-value" style={{ color: totals.coveragePctIncludingPredicted < 70 ? 'var(--danger)' : totals.coveragePctIncludingPredicted < 90 ? '#eab308' : '#059669' }}>{totals.coveragePctIncludingPredicted.toFixed(1)}%</div>
         <div className="kpi-sub">{formatCurrency(totals.unmappedAmount)} still unmapped</div>
       </div>
     </div>

     {/* Aggregate YoY KPI (same shape as Sales Forecast page's card) */}
     {totals.yoyTrend && (
       <div className="kpis" style={{ marginBottom: 16 }}>
         <div className="kpi" style={{ background: 'var(--surface-soft, #fafafa)' }}>
           <div className="kpi-label">YoY trend (all reps)</div>
           <div className="kpi-period">{totals.yoyTrend.currYearLabel} vs {totals.yoyTrend.prevYearLabel} ({totals.yoyTrend.monthsCompared} closed months · current month excluded)</div>
           <div className="kpi-value" style={{ color: totals.yoyTrend.rawRate >= 0 ? '#059669' : 'var(--danger)' }}>
             {totals.yoyTrend.rawRate >= 0 ? '+' : ''}{(totals.yoyTrend.rawRate * 100).toFixed(1)}%
           </div>
           <div className="kpi-sub">{formatCurrency(totals.yoyTrend.currYTD)} vs {formatCurrency(totals.yoyTrend.prevYTD)}</div>
         </div>
         {data.rows.filter((r) => r.yoyTrend !== null && r.rep !== 'Unmapped').map((r) => {
           const t = r.yoyTrend!;
           const tone = t.rawRate >= 0.05 ? '#059669' : t.rawRate >= -0.05 ? '#eab308' : 'var(--danger)';
           return (
             <div className="kpi" key={r.rep}>
               <div className="kpi-label">{r.rep}</div>
               <div className="kpi-period">{t.currYearLabel} vs {t.prevYearLabel} ({t.monthsCompared} months)</div>
               <div className="kpi-value" style={{ color: tone }}>
                 {t.rawRate >= 0 ? '+' : ''}{(t.rawRate * 100).toFixed(1)}%
               </div>
               <div className="kpi-sub">{formatCurrency(t.currYTD)} vs {formatCurrency(t.prevYTD)}</div>
             </div>
           );
         })}
       </div>
     )}

     {/* Monthly history matrix · year × month (same layout as channel page) */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">Monthly history matrix · year × month (all reps combined)</div>
           <div className="section-sub">Year-by-year sales pivot. Lets you eyeball seasonality + growth at a glance.</div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table">
           <thead>
             <tr>
               <th>Year</th>
               {['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].map((m) => (
                 <th key={m} className="num">{m}</th>
               ))}
               <th className="num">Total</th>
             </tr>
           </thead>
           <tbody>
             {totals.monthlyMatrix.map((y) => (
               <tr key={y.year}>
                 <td><strong>{y.year}</strong>{y.isPartial && <span className="vendor-note" style={{ marginLeft: 6, fontSize: 10 }}>YTD</span>}</td>
                 {y.monthly.map((v, i) => (
                   <td key={i} className="num">{v > 0 ? formatCurrency(v) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                 ))}
                 <td className="num"><strong>{formatCurrency(y.total)}</strong></td>
               </tr>
             ))}
           </tbody>
         </table>
       </div>
     </div>

     {/* Aggregate year-over-year */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">Year-over-year (all reps combined)</div>
           <div className="section-sub">Total Little Tree sales per calendar year + YoY % growth. Current year is YTD compared to same-months-prior-year.</div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table">
           <thead>
             <tr>
               <th>Year</th>
               <th className="num">Total sales</th>
               <th className="num">Months in window</th>
               <th className="num">YoY change</th>
             </tr>
           </thead>
           <tbody>
             {totals.yearly.map((y) => {
               const tone = y.yoyPct === null ? 'var(--muted)' : y.yoyPct >= 10 ? '#059669' : y.yoyPct >= 0 ? '#eab308' : 'var(--danger)';
               return (
                 <tr key={y.year}>
                   <td><strong>{y.year}</strong>{y.isPartial && <span className="vendor-note" style={{ marginLeft: 6, fontSize: 10 }}>YTD</span>}</td>
                   <td className="num"><strong>{formatCurrency(y.total)}</strong></td>
                   <td className="num" style={{ color: 'var(--muted)' }}>{y.monthsInYearReported}/12</td>
                   <td className="num" style={{ color: tone, fontWeight: 600 }}>
                     {y.yoyPct === null ? '-' : `${y.yoyPct >= 0 ? '+' : ''}${y.yoyPct.toFixed(1)}%`}
                     {y.yoyDelta !== null && <div className="vendor-note" style={{ fontSize: 10, fontWeight: 400 }}>{y.yoyDelta >= 0 ? '+' : ''}{formatCurrency(y.yoyDelta)}</div>}
                   </td>
                 </tr>
               );
             })}
           </tbody>
         </table>
       </div>
     </div>

     {/* Per-rep year-over-year */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">Year-over-year per rep · with growth %</div>
           <div className="section-sub">
             Each rep's yearly totals (confirmed + predicted combined) + YoY %. Share = what fraction of the grand total this rep represents in the full window.
           </div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table" style={{ fontSize: 12 }}>
           <thead>
             <tr>
               <th>Rep</th>
               <th className="num">Share of total</th>
               {totals.yearly.map((y) => (
                 <th key={y.year} className="num" colSpan={2}>{y.year}{y.isPartial ? ' (YTD)' : ''}</th>
               ))}
             </tr>
             <tr>
               <th></th>
               <th></th>
               {totals.yearly.map((y) => (
                 <Fragment key={y.year}>
                   <th className="num" style={{ fontSize: 10, color: 'var(--muted)' }}>$</th>
                   <th className="num" style={{ fontSize: 10, color: 'var(--muted)' }}>YoY %</th>
                 </Fragment>
               ))}
             </tr>
           </thead>
           <tbody>
             {data.rows.map((r) => {
               const isUnmapped = r.rep === 'Unmapped';
               return (
                 <tr key={r.rep} style={isUnmapped ? { color: 'var(--muted)' } : undefined}>
                   <td><strong>{r.rep}</strong></td>
                   <td className="num"><strong>{r.shareOfTotalPct.toFixed(1)}%</strong></td>
                   {r.yearly.map((y) => {
                     const tone = y.yoyPct === null ? 'var(--muted)' : y.yoyPct >= 10 ? '#059669' : y.yoyPct >= 0 ? '#eab308' : 'var(--danger)';
                     return (
                       <Fragment key={y.year}>
                         <td className="num">{y.total > 0 ? formatCurrency(y.total) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                         <td className="num" style={{ color: tone, fontWeight: 600 }}>
                           {y.yoyPct === null ? '-' : `${y.yoyPct >= 0 ? '+' : ''}${y.yoyPct.toFixed(1)}%`}
                         </td>
                       </Fragment>
                     );
                   })}
                 </tr>
               );
             })}
           </tbody>
         </table>
       </div>
     </div>

     {/* Per-rep monthly matrix */}
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">Monthly sales · rep × month <span className="vendor-note" style={{ fontSize: 11 }}>(confirmed + predicted from past behavior)</span></div>
           <div className="section-sub">
             Each cell = confirmed $ (from commission sheet) <strong>+ predicted $</strong> (unmapped invoices attributed to that rep because their customer has a dominant historical rep there).
             Click a row to see top customers · predicted-from list · raw rep variants. Grayed bottom number in each cell = predicted only.
           </div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table" style={{ fontSize: 12 }}>
           <thead>
             <tr>
               <th></th>
               <th>Rep</th>
               {months.map((m) => <th key={m.key} className="num">{m.label}</th>)}
               <th className="num">Total</th>
               <th className="num">Share</th>
               <th className="num">Avg/Mo</th>
               <th className="num">Invoices</th>
             </tr>
           </thead>
           <tbody>
             {data.rows.map((r) => {
               const isExp = expanded === r.rep;
               const isUnmapped = r.rep === 'Unmapped';
               const grandTotal = r.grandTotal;
               const grandInvoices = r.invoiceCount + r.predictedInvoiceCount;
               return (
                 <Fragment key={r.rep}>
                   <tr
                     style={{ cursor: 'pointer', ...(isUnmapped ? { color: 'var(--muted)' } : {}) }}
                     onClick={() => setExpanded(isExp ? null : r.rep)}
                   >
                     <td style={{ color: 'var(--muted)', width: 20 }}>{isExp ? '▼' : '▶'}</td>
                     <td>
                       <strong>{r.rep}</strong>
                       {isUnmapped && <span className="vendor-note" style={{ marginLeft: 6, fontSize: 10 }}>no historical match</span>}
                     </td>
                     {r.monthly.map((v, i) => {
                       const pred = r.predictedMonthly[i] ?? 0;
                       return (
                         <td key={i} className="num">
                           {v > 0 ? formatCurrency(v) : (pred === 0 ? <span style={{ color: 'var(--muted)' }}>-</span> : '')}
                           {pred > 0 && (
                             <div style={{ fontSize: 10, color: 'var(--muted)' }}>+{formatCurrency(pred)}</div>
                           )}
                         </td>
                       );
                     })}
                     <td className="num">
                       <strong>{formatCurrency(grandTotal)}</strong>
                       {r.predictedTotal > 0 && (
                         <div style={{ fontSize: 10, color: 'var(--muted)' }}>conf {formatCurrency(r.total)} + pred {formatCurrency(r.predictedTotal)}</div>
                       )}
                     </td>
                     <td className="num"><strong>{r.shareOfTotalPct.toFixed(1)}%</strong></td>
                     <td className="num" style={{ color: 'var(--muted)' }}>{formatCurrency(grandTotal / months.length)}</td>
                     <td className="num">{grandInvoices}{r.predictedInvoiceCount > 0 && <div style={{ fontSize: 10, color: 'var(--muted)' }}>{r.invoiceCount}+{r.predictedInvoiceCount}</div>}</td>
                   </tr>
                   {isExp && (
                     <tr>
                       <td colSpan={months.length + 6} style={{ background: 'var(--accent-soft, #f6faf8)', padding: 12 }}>
                         {/* Per-rep monthly history matrix (year × month) */}
                         <div style={{ marginBottom: 12 }}>
                           <div style={{ fontWeight: 600, marginBottom: 6 }}>Monthly history · {r.rep}</div>
                           <table className="data-table" style={{ fontSize: 11 }}>
                             <thead>
                               <tr>
                                 <th>Year</th>
                                 {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m) => (
                                   <th key={m} className="num">{m}</th>
                                 ))}
                                 <th className="num">Total</th>
                               </tr>
                             </thead>
                             <tbody>
                               {r.monthlyMatrix.map((y) => (
                                 <tr key={y.year}>
                                   <td><strong>{y.year}</strong>{y.isPartial && <span className="vendor-note" style={{ marginLeft: 4, fontSize: 9 }}>YTD</span>}</td>
                                   {y.monthly.map((v, i) => (
                                     <td key={i} className="num">{v > 0 ? formatCurrency(v) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                                   ))}
                                   <td className="num"><strong>{formatCurrency(y.total)}</strong></td>
                                 </tr>
                               ))}
                             </tbody>
                           </table>
                           {r.yoyTrend && (
                             <div className="vendor-note" style={{ marginTop: 6, fontSize: 11 }}>
                               YoY trend · {r.yoyTrend.currYearLabel} YTD <strong>{formatCurrency(r.yoyTrend.currYTD)}</strong> vs {r.yoyTrend.prevYearLabel} same {r.yoyTrend.monthsCompared} months <strong>{formatCurrency(r.yoyTrend.prevYTD)}</strong> ={' '}
                               <strong style={{ color: r.yoyTrend.rawRate >= 0 ? '#059669' : 'var(--danger)' }}>
                                 {r.yoyTrend.rawRate >= 0 ? '+' : ''}{(r.yoyTrend.rawRate * 100).toFixed(1)}%
                               </strong>
                             </div>
                           )}
                         </div>
                         <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 18 }}>
                           <div>
                             <div style={{ fontWeight: 600, marginBottom: 6 }}>Top 10 confirmed customers</div>
                             <table className="data-table" style={{ fontSize: 11 }}>
                               <thead><tr><th>Customer</th><th className="num">Total</th><th className="num">Inv</th></tr></thead>
                               <tbody>
                                 {r.topCustomers.map((c) => (
                                   <tr key={c.customer}>
                                     <td>{cleanCust(c.customer)}</td>
                                     <td className="num"><strong>{formatCurrency(c.total)}</strong></td>
                                     <td className="num">{c.invoiceCount}</td>
                                   </tr>
                                 ))}
                                 {r.topCustomers.length === 0 && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>no confirmed customers</td></tr>}
                               </tbody>
                             </table>
                           </div>
                           <div>
                             <div style={{ fontWeight: 600, marginBottom: 6 }}>Top 10 predicted (from past behavior)</div>
                             {r.predictedFromCustomers.length === 0 ? (
                               <div className="vendor-note">no predicted attributions</div>
                             ) : (
                               <table className="data-table" style={{ fontSize: 11 }}>
                                 <thead><tr><th>Customer</th><th className="num">Predicted $</th><th className="num">Conf</th></tr></thead>
                                 <tbody>
                                   {r.predictedFromCustomers.map((c) => (
                                     <tr key={c.customer}>
                                       <td>{cleanCust(c.customer)}</td>
                                       <td className="num"><strong>{formatCurrency(c.total)}</strong> <span style={{ color: 'var(--muted)' }}>({c.invoiceCount} inv)</span></td>
                                       <td className="num" style={{ color: c.confidence === 1 ? '#059669' : c.confidence >= 0.7 ? '#eab308' : 'var(--danger)' }}>{(c.confidence * 100).toFixed(0)}%</td>
                                     </tr>
                                   ))}
                                 </tbody>
                               </table>
                             )}
                           </div>
                           <div style={{ fontSize: 12 }}>
                             <div style={{ fontWeight: 600, marginBottom: 6 }}>Sheet metadata</div>
                             <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', rowGap: 4, columnGap: 8, color: 'var(--muted)' }}>
                               <div>Confirmed total</div><div style={{ color: 'var(--text)' }}>{formatCurrency(r.total)} <span className="vendor-note">({r.invoiceCount} inv)</span></div>
                               <div>Predicted total</div><div style={{ color: 'var(--text)' }}>{formatCurrency(r.predictedTotal)} <span className="vendor-note">({r.predictedInvoiceCount} inv)</span></div>
                               <div>Combined</div><div style={{ color: 'var(--text)' }}><strong>{formatCurrency(grandTotal)}</strong></div>
                               <div>Months active</div><div style={{ color: 'var(--text)' }}>{r.monthsActive}/{months.length}</div>
                               <div>Last invoice</div><div style={{ color: 'var(--text)' }}>{r.lastInvoiceMonth ?? '-'}</div>
                               <div>Raw variants</div>
                               <div style={{ color: 'var(--text)' }}>
                                 {r.rawVariants.length === 0
                                   ? <em style={{ color: 'var(--muted)' }}>none</em>
                                   : r.rawVariants.map((v) => <code key={v} style={{ marginRight: 6, fontSize: 11 }}>"{v}"</code>)}
                               </div>
                             </div>
                           </div>
                         </div>
                       </td>
                     </tr>
                   )}
                 </Fragment>
               );
             })}
             {/* Grand total row */}
             <tr className="total-row">
               <td></td>
               <td>GRAND TOTAL</td>
               {totals.monthly.map((v, i) => <td key={i} className="num">{formatCurrency(v)}</td>)}
               <td className="num">{formatCurrency(totals.grandTotal)}</td>
               <td className="num">100%</td>
               <td className="num">{formatCurrency(totals.grandTotal / months.length)}</td>
               <td className="num">{totals.invoiceCount}</td>
             </tr>
           </tbody>
         </table>
       </div>
       <div className="page-sub" style={{ marginTop: 12, fontSize: 11, color: 'var(--muted)' }}>
         <div>✓ <strong>{formatCurrency(totals.grandTotal - totals.unmappedAmount - totals.predictedAmount)}</strong> confirmed (rep directly listed in commission sheet)</div>
         <div>• <strong>{formatCurrency(totals.predictedAmount)}</strong> predicted from past behavior · {totals.predictedInvoiceCount} invoices · attributed because each customer has a dominant historical rep</div>
         {unmappedRow && (
           <div>⚠ <strong>{formatCurrency(unmappedRow.total)}</strong> still unmapped · {unmappedRow.invoiceCount} invoices · these customers were never seen in any commission sheet so we can't predict (likely brand-new accounts)</div>
         )}
         <div style={{ marginTop: 4 }}>{data.customerRepLearned.length} customer→rep mappings learned from confirmed data.</div>
       </div>
     </div>
   </>
 );
}
