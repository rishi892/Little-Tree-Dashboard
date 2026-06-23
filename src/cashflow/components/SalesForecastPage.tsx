import { useEffect, useState } from 'react';
import { fetchSalesForecast, fetchSalesWeekInvoices, type SalesForecastResult, type SalesForecastBrand, type SalesWeekInvoicesResponse, type SalesBucket } from '../api';
import { formatCurrency, formatSigned } from '../format';
import { CollapsibleSection } from './CollapsibleSection';

const BUCKET_ORDER: Array<{ key: SalesBucket; short: string; hint: string }> = [
 { key: 'wholesale',    short: 'Little Tree',   hint: 'Little Tree retail sales' },
 { key: 'privateLabel', short: 'Private Label', hint: 'Alien Brainz · Funk’d Up · Yacht Fuel' },
 { key: 'gelato',       short: 'Gelato',        hint: 'Little Tree Gelato line' },
];

const POLL_MS = 60_000;

function ymLabel(ym: string): string {
 const [y, m] = ym.split('-');
 const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
 return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function SalesForecastPage() {
 const [data, setData] = useState<SalesForecastResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [expandedBrand, setExpandedBrand] = useState<string | null>(null);
 const [expandedWeek, setExpandedWeek] = useState<string | null>(null);
 const [weekInvoices, setWeekInvoices] = useState<Record<string, SalesWeekInvoicesResponse>>({});
 const [weekLoading, setWeekLoading] = useState<string | null>(null);
 const [selectedBucket, setSelectedBucket] = useState<SalesBucket>('wholesale');

 async function toggleWeek(weekStart: string) {
  if (expandedWeek === weekStart) { setExpandedWeek(null); return; }
  setExpandedWeek(weekStart);
  if (!weekInvoices[weekStart]) {
   setWeekLoading(weekStart);
   try {
    const r = await fetchSalesWeekInvoices(weekStart);
    setWeekInvoices((p) => ({ ...p, [weekStart]: r }));
   } catch {
    /* swallow - UI shows pending state */
   } finally {
    setWeekLoading(null);
   }
  }
 }

 async function load(silent = false) {
 if (!silent) { setLoading(true); setError(null); }
 try {
 const d = await fetchSalesForecast();
 setData(d);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed to load');
 } finally {
 if (!silent) setLoading(false);
 }
 }

 useEffect(() => {
 load();
 const poll = window.setInterval(() => load(true), POLL_MS);
 const onFocus = () => load(true);
 window.addEventListener('focus', onFocus);
 return () => { window.clearInterval(poll); window.removeEventListener('focus', onFocus); };
 }, []);

 if (loading && !data) {
 return <div className="page-head"><h1 className="page-title">Sales Forecast</h1><div className="page-sub">Computing per-brand trends...</div></div>;
 }
 if (error) return <div className="error">{error}</div>;
 if (!data) return null;

 const { driver, lookbackWindow, horizonMonths, weeks, brands, churnedBrands, weeklyInflow, monthlyForecast, totalForecastedSales, totalProjectedCash, globalLagCurve } = data;

 // Bucket-driven projection fields (each bucket has its own deseasonalized
 // base, seasonality, history, and per-week cash). When a non-wholesale
 // bucket is selected, the brand drilldown is hidden because brands are
 // a wholesale-only concept.
 const bucket = data.buckets[selectedBucket];
 const yearlyHistory = bucket.yearlyHistory;
 const monthlyHistory = bucket.monthlyHistory;
 const seasonality = bucket.seasonality;
 const yoy = bucket.yoy;
 const yoyChain = bucket.yoyChain;
 const weeklyAnalysis = bucket.weeklyAnalysis;
 const monthlyForecastV2 = bucket.monthlyForecast;
 const weeklyInflowV2 = bucket.weeklyInflow;
 const totalForecastedInvoiceV2 = bucket.scenarioTotals.base.invoiced;
 const totalProjectedCashV2 = bucket.scenarioTotals.base.cash;
 const showBrandDrilldown = selectedBucket === 'wholesale';

 void weeklyInflow; void monthlyForecast; void totalForecastedSales; void totalProjectedCash; void horizonMonths; void lookbackWindow; void globalLagCurve; // legacy v1 fields kept on the response for backward compat
 // Peak-cash week is computed from the SELECTED bucket so the KPI matches what
 // the rest of the page is showing.
 const peakWeekIdx = weeklyInflowV2.indexOf(Math.max(...weeklyInflowV2, 0));
 const brandLagCount = brands.filter((b) => b.lagSource === 'brand').length;
 const seasonalCount = brands.filter((b) => b.hasSeasonality).length;
 const tierCounts = {
 active: brands.filter((b) => b.activityTier === 'active').length,
 cooling: brands.filter((b) => b.activityTier === 'cooling').length,
 dormant: brands.filter((b) => b.activityTier === 'dormant').length,
 churned: churnedBrands.length,
 };

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Sales Forecast</h1>
 <div className="page-sub">
 Forward-looking projection of cash from invoices NOT yet booked. Anchors on
 the same Monday as the 13-week plan · cadence-driven per-invoice projection
 with growth and month-of-year seasonality · cash routed through each brand's
 collection lag curve.
 </div>
 </div>
 <button className="btn ghost" onClick={() => load()} disabled={loading}>{loading ? 'Refreshing...' : 'Refresh'}</button>
 </div>

 <div className="expenses-tabs" style={{ marginTop: 8, marginBottom: 4 }}>
 {BUCKET_ORDER.map((b) => {
  const bk = data.buckets[b.key];
  const active = selectedBucket === b.key;
  return (
   <button
    key={b.key}
    className={`expenses-tab ${active ? 'active' : ''}`}
    onClick={() => setSelectedBucket(b.key)}
    title={b.hint}
   >
    {b.short}
    {/* Subtitle color: when the tab is ACTIVE the background is dark teal,
        so the muted-gray vendor-note class becomes invisible. Switch to
        translucent white for legibility on the active background and keep
        the muted gray on inactive tabs. */}
    <span style={{
      marginLeft: 8,
      fontSize: 11,
      color: active ? 'rgba(255,255,255,0.85)' : 'var(--muted)',
      fontWeight: 400,
    }}>
     {formatCurrency(bk.scenarioTotals.base.cash)} / 13w
    </span>
   </button>
  );
 })}
 </div>
 <div className="page-sub" style={{ marginBottom: 12, fontSize: 12 }}>
  <strong>{bucket.label}</strong> · {bucket.customerCount} customers · deseasonalized base {formatCurrency(bucket.deseasonalizedBase)}/mo
 </div>

 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">13-week projected cash</div>
 <div className="kpi-period">After collection lag</div>
 <div className="kpi-value">{formatCurrency(totalProjectedCashV2)}</div>
 <div className="kpi-sub">Lender-facing figure (matches cashflow row)</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Total gross forecast</div>
 <div className="kpi-period">Next {monthlyForecastV2.length} months invoiced</div>
 <div className="kpi-value">{formatCurrency(totalForecastedInvoiceV2)}</div>
 <div className="kpi-sub">{monthlyForecastV2[0]?.ym} → {monthlyForecastV2[monthlyForecastV2.length - 1]?.ym}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">YoY trend</div>
 <div className="kpi-period">{yoy.currYearLabel} vs {yoy.prevYearLabel} ({yoy.monthsCompared} months)</div>
 <div className="kpi-value" style={{ color: yoy.rate >= 0 ? '#059669' : 'var(--danger)' }}>{(yoy.rate * 100).toFixed(1)}%</div>
 <div className="kpi-sub">{formatCurrency(yoy.currYTD)} vs {formatCurrency(yoy.prevYTD)}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Peak cash week</div>
 <div className="kpi-period">Wk {peakWeekIdx + 1} · {weeks[peakWeekIdx]?.label}</div>
 <div className="kpi-value">{formatCurrency(weeklyInflowV2[peakWeekIdx] ?? 0)}</div>
 <div className="kpi-sub">{brandLagCount}/{brands.length} brands have own lag curve</div>
 </div>
 </div>

 {/* V2 MULTI-LEVEL VALIDATION */}
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Year-over-year history ({bucket.label})</div>
 <div className="section-sub">
 Full calendar-year totals to spot growth direction.
 YoY for forecast: <strong>{(yoy.rate * 100).toFixed(1)}%</strong>
 ({yoy.monthsCompared} matched months: {yoy.currYearLabel} YTD <strong>{formatCurrency(yoy.currYTD)}</strong> vs {yoy.prevYearLabel} same period <strong>{formatCurrency(yoy.prevYTD)}</strong>).
 </div>
 {yoyChain.length > 0 && (
 <div className="section-sub" style={{ marginTop: 6, fontSize: 12 }}>
 <strong>Growth chain</strong> ·{' '}
 {yoyChain.map((c, i) => (
 <span key={`${c.fromYear}-${c.toYear}`} style={{ marginRight: 12 }}>
 {c.fromYear} → {c.toYear}:{' '}
 <strong style={{ color: c.rate >= 0 ? '#059669' : 'var(--danger)' }}>
 {(c.rate * 100).toFixed(1)}%
 </strong>
 {' '}<span className="vendor-note" style={{ fontSize: 10 }}>({c.monthsCompared}mo)</span>
 {i < yoyChain.length - 1 && <span style={{ color: 'var(--muted)' }}> · </span>}
 </span>
 ))}
 </div>
 )}
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Year</th>
 <th className="num">Total {bucket.label} sales</th>
 <th className="num">Invoices</th>
 <th className="num">Months observed</th>
 <th className="num">YoY change</th>
 </tr>
 </thead>
 <tbody>
 {yearlyHistory.map((y, i) => {
 const prev = yearlyHistory[i - 1];
 const yoyPct = prev && prev.total > 0 ? ((y.total - prev.total) / prev.total) * 100 : null;
 const yoyTone = yoyPct === null ? 'var(--muted)' : yoyPct > 0 ? '#059669' : yoyPct < 0 ? 'var(--danger)' : 'var(--muted)';
 return (
 <tr key={y.year}>
 <td><strong>{y.year}</strong>{y.isPartial && <span className="vendor-note" style={{ marginLeft: 6, fontSize: 10 }}>(YTD)</span>}</td>
 <td className="num"><strong>{formatCurrency(y.total)}</strong></td>
 <td className="num">{y.invoiceCount.toLocaleString()}</td>
 <td className="num">{y.monthsObserved}/12</td>
 <td className="num" style={{ color: yoyTone }}>{yoyPct !== null ? `${yoyPct >= 0 ? '+' : ''}${yoyPct.toFixed(1)}%` : '-'}</td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </div>

 <CollapsibleSection
 title="Monthly history matrix · year × month"
 sub={`Pivots all ${bucket.label} monthly totals so seasonal patterns are visible at a glance. Seasonal indices (last complete year basis) drive the forecast when prior-year same-month is missing.`}
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Year</th>
 {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m => (
 <th key={m} className="num">{m}</th>
 ))}
 <th className="num">Total</th>
 </tr>
 </thead>
 <tbody>
 {yearlyHistory.map(y => {
 const byMonth: number[] = new Array(12).fill(0);
 for (const m of monthlyHistory) {
 if (m.ym.startsWith(y.year)) {
 const idx = Number(m.ym.split('-')[1]) - 1;
 byMonth[idx] = m.total;
 }
 }
 return (
 <tr key={y.year}>
 <td><strong>{y.year}</strong></td>
 {byMonth.map((v, i) => (
 <td key={i} className="num">{v > 0 ? formatCurrency(v) : <span className="vendor-note">-</span>}</td>
 ))}
 <td className="num"><strong>{formatCurrency(byMonth.reduce((s,v)=>s+v,0))}</strong></td>
 </tr>
 );
 })}
 <tr style={{ background: 'var(--accent-soft, #e6f4ef)' }}>
 <td><strong>Seasonality</strong><div className="vendor-note" style={{ fontSize: 10 }}>basis {seasonality[0]?.basisYear || '-'}</div></td>
 {seasonality.map(s => {
 const dev = s.index - 1;
 const tone = Math.abs(dev) < 0.1 ? 'var(--muted)' : dev > 0 ? '#059669' : 'var(--danger)';
 return (
 <td key={s.monthOfYear} className="num" style={{ color: tone, fontWeight: 600 }}>
 {s.index.toFixed(2)}×
 </td>
 );
 })}
 <td className="num vendor-note">1.00×</td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 <CollapsibleSection
 title={`Weekly trend (last ${weeklyAnalysis.trend.basisWeeks} weeks)`}
 sub={
 <>
 Linear fit on the most-recent {weeklyAnalysis.trend.basisWeeks} weeks of actual sales.
 {' '}
 Slope: <strong style={{ color: weeklyAnalysis.trend.slope >= 0 ? '#059669' : 'var(--danger)' }}>
 {weeklyAnalysis.trend.slope >= 0 ? '+' : ''}{formatCurrency(weeklyAnalysis.trend.slope)}/wk
 </strong>
 {' · '}
 R² <strong>{weeklyAnalysis.trend.r2.toFixed(2)}</strong>
 {weeklyAnalysis.trend.r2 < 0.2 && <span className="vendor-note" style={{ marginLeft: 6, fontSize: 11 }}>(weak fit - seasonality dominates)</span>}
 </>
 }
 >
 <div className="table-wrap">
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>
 <th>Week start</th>
 <th>ISO wk</th>
 <th className="num">Sales</th>
 <th className="num">Invoices</th>
 </tr>
 </thead>
 <tbody>
 {weeklyAnalysis.history.slice(-13).map(h => {
   const isExpanded = expandedWeek === h.weekStart;
   const inv = weekInvoices[h.weekStart];
   return (
     <>
     <tr key={`h-${h.weekStart}`} style={{ cursor: h.invoiceCount > 0 ? 'pointer' : 'default' }}
       onClick={() => h.invoiceCount > 0 && toggleWeek(h.weekStart)}>
     <td>
       {h.invoiceCount > 0 && (
         <span style={{ display: 'inline-block', width: 14, color: 'var(--muted)' }}>{isExpanded ? '▾' : '▸'}</span>
       )}
       {h.weekStart}
     </td>
     <td>{h.weekOfYear}</td>
     <td className="num"><strong>{formatCurrency(h.total)}</strong></td>
     <td className="num">{h.invoiceCount}</td>
     </tr>
     {isExpanded && (
       <tr key={`h-${h.weekStart}-detail`}>
       <td colSpan={4} style={{ background: 'var(--panel-soft, #f8fbfa)', padding: '10px 16px' }}>
       {weekLoading === h.weekStart && !inv && <span className="vendor-note">Loading invoices…</span>}
       {inv && inv.invoices.length === 0 && <span className="vendor-note">No invoices this week.</span>}
       {inv && inv.invoices.length > 0 && (
         <table style={{ width: '100%', fontSize: 12 }}>
         <thead>
         <tr style={{ color: 'var(--muted)' }}>
         <th style={{ textAlign: 'left' }}>Invoice #</th>
         <th style={{ textAlign: 'left' }}>Date</th>
         <th style={{ textAlign: 'left' }}>Customer</th>
         <th style={{ textAlign: 'right' }}>Amount</th>
         <th style={{ textAlign: 'right' }}>Paid</th>
         <th style={{ textAlign: 'left' }}>Paid date</th>
         </tr>
         </thead>
         <tbody>
         {inv.invoices.map((row) => (
           <tr key={row.invoiceNumber}>
           <td style={{ fontFamily: 'monospace' }}>{row.invoiceNumber}</td>
           <td>{row.date}</td>
           <td>{row.customer}</td>
           <td className="num"><strong>{formatCurrency(row.amount)}</strong></td>
           <td className="num">{row.paid > 0 ? formatCurrency(row.paid) : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
           <td>{row.paidDate || <span style={{ color: 'var(--muted)' }}>unpaid</span>}</td>
           </tr>
         ))}
         <tr>
         <td colSpan={3} style={{ fontWeight: 600, paddingTop: 6 }}>{inv.invoiceCount} invoices</td>
         <td className="num" style={{ fontWeight: 700, paddingTop: 6 }}>{formatCurrency(inv.total)}</td>
         <td colSpan={2}></td>
         </tr>
         </tbody>
         </table>
       )}
       </td>
       </tr>
     )}
     </>
   );
 })}
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 <CollapsibleSection
 title="Weekly forecast - next 13 weeks"
 sub={<>Each future week = <strong>trend extrapolation × week-of-year seasonal index</strong>. Seasonal index = avg(actual / 13-wk centered moving average) for that ISO week across history.</>}
 >
 <div className="table-wrap">
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>
 <th>Week start</th>
 <th>ISO wk</th>
 <th className="num">Seasonal idx</th>
 <th className="num">Forecast</th>
 </tr>
 </thead>
 <tbody>
 {weeklyAnalysis.forecast.map(f => {
 const seasonal = weeklyAnalysis.weekOfYearSeasonality.find(s => s.weekOfYear === f.weekOfYear);
 const idx = seasonal?.index ?? 1;
 const tone = idx > 1.2 ? '#059669' : idx < 0.7 ? 'var(--danger)' : 'var(--muted)';
 return (
 <tr key={`f-${f.weekStart}`}>
 <td>{f.weekStart}</td>
 <td>{f.weekOfYear}</td>
 <td className="num" style={{ color: tone, fontWeight: 600 }}>{idx.toFixed(2)}×</td>
 <td className="num"><strong>{formatCurrency(f.total)}</strong></td>
 </tr>
 );
 })}
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Forecast - next {monthlyForecastV2.length} months (aggregated from weekly)</div>
 <div className="section-sub">
 Monthly rows = sum of the weekly forecasts that fall in each calendar month.
 Total gross forecast: <strong>{formatCurrency(totalForecastedInvoiceV2)}</strong>; cash arriving in 13-week window after collection lag: <strong>{formatCurrency(totalProjectedCashV2)}</strong>.
 </div>
 </div>
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Month</th>
 <th className="num">Forecast</th>
 <th>Method</th>
 <th className="num">Prior year</th>
 <th className="num">YoY ×</th>
 <th className="num">Seasonal ×</th>
 <th className="num">Clamped</th>
 </tr>
 </thead>
 <tbody>
 {monthlyForecastV2.map(m => (
 <tr key={m.ym}>
 <td><strong>{m.ym}</strong></td>
 <td className="num"><strong>{formatCurrency(m.forecastedSales)}</strong></td>
 <td><span className={`pill-tag tag-${m.method === 'prior-year-x-yoy' ? 'strong' : 'fuzzy'}`}>{m.method}</span></td>
 <td className="num">{m.priorYearValue !== null ? formatCurrency(m.priorYearValue) : <span className="vendor-note">-</span>}</td>
 <td className="num">{m.yoyMultiplier !== null ? `${m.yoyMultiplier.toFixed(2)}×` : <span className="vendor-note">-</span>}</td>
 <td className="num">{m.seasonalIndex !== null ? `${m.seasonalIndex.toFixed(2)}×` : <span className="vendor-note">-</span>}</td>
 <td className="num">{m.clamped ? <span className="pill-tag tag-warn">{m.clamped}</span> : <span className="vendor-note">-</span>}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>

 <CollapsibleSection
 title="Weekly cash arrival (v2) - 13-week window"
 sub="Forecasted invoices (above) spread evenly across each month's calendar weeks, then routed through the global collection-lag curve so cash lands in the week it's actually expected."
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 {weeks.map(w => (
 <th key={w.index} className="num">
 <div style={{ fontSize: 11 }}>Wk {w.index + 1}</div>
 <div style={{ fontSize: 10, color: 'var(--muted)' }}>{w.label}</div>
 </th>
 ))}
 <th className="num">Total</th>
 </tr>
 </thead>
 <tbody>
 <tr>
 {weeklyInflowV2.map((v, i) => (
 <td key={i} className="num">{v > 0 ? formatCurrency(v) : <span className="vendor-note">-</span>}</td>
 ))}
 <td className="num"><strong>{formatCurrency(totalProjectedCashV2)}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 {/* DRIVER / METHODOLOGY */}
 <CollapsibleSection
 title="How this forecast is built"
 sub="Same inputs the 13-week cashflow uses · everything below is computed live, not hardcoded."
 >
 <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: 'var(--muted)' }}>1. LOOKBACK ({driver.lookbackMonths} months)</div>
 <div style={{ fontSize: 13 }}>For each brand, pull the last {driver.lookbackMonths} calendar months of invoice activity from Invoice Tracker.</div>
 <div className="vendor-note" style={{ marginTop: 4 }}>Window: {lookbackWindow[0]} - {lookbackWindow[lookbackWindow.length - 1]}</div>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: 'var(--muted)' }}>2. RECENCY TIERS (no hard cutoff)</div>
 <div style={{ fontSize: 13 }}>Every brand stays in the forecast but is weighted by how stale its last invoice is. Retailers that reorder every few months are real revenue, not noise.</div>
 <div className="vendor-note" style={{ marginTop: 6, lineHeight: 1.5 }}>
 {driver.tiers.map((t, i) => {
 const prevMax = i === 0 ? 0 : driver.tiers[i - 1].maxDays;
 const range = t.maxDays === Infinity || t.maxDays > 10000
 ? `>${prevMax}d`
 : i === 0 ? `≤${t.maxDays}d` : `${prevMax + 1}-${t.maxDays}d`;
 const count = t.name === 'churned' ? tierCounts.churned : (tierCounts as any)[t.name] ?? 0;
 const tone = t.name === 'active' ? 'strong' : t.name === 'churned' ? 'none' : 'fuzzy';
 return (
 <div key={t.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
 <span><span className={`pill-tag tag-${tone}`} style={{ fontSize: 10, marginRight: 6 }}>{t.name}</span>{range} · weight {(t.weight * 100).toFixed(0)}%</span>
 <strong>{count}</strong>
 </div>
 );
 })}
 </div>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: 'var(--muted)' }}>3. CADENCE (median gap between invoices)</div>
 <div style={{ fontSize: 13 }}>For each brand, compute the median # of days between consecutive invoices. A retailer that orders every 4-6 months has a ~150d cadence; an active brand sits ~30d. <strong>Avg invoice $</strong> = winsorized mean of last 6 amounts (single outlier capped at 90th percentile so one mega-PO doesn't inflate the typical).</div>
 <div className="vendor-note" style={{ marginTop: 4 }}>Next-expected invoice = last invoice + cadence. We then walk forward at that interval to project the next ~9 months.</div>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: 'var(--muted)' }}>4. GROWTH × SEASONALITY (per projected invoice)</div>
 <div style={{ fontSize: 13 }}>Each projected invoice is sized as <strong>avg × growth × seasonal[monthOfYear] × tierWeight</strong>. <strong>Growth</strong> = recent 90d $ ÷ prior 90d $ (clipped to 0.5-1.8 so a single quarter spike can't 5× the forecast). <strong>Seasonal index</strong> is only applied when ≥ 9 distinct months of history exist (smoothed 70/30 toward 1.0).</div>
 <div className="vendor-note" style={{ marginTop: 4 }}>{seasonalCount} brand{seasonalCount === 1 ? '' : 's'} have enough data for seasonality · others use flat 1.0</div>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: 'var(--muted)' }}>5. PER-INVOICE WEEK PLACEMENT</div>
 <div style={{ fontSize: 13 }}>Each projected invoice's cash is lagged individually: lag-k portion (from the brand's paid history) lands at <strong>invoice_date + k months</strong> in the exact week it falls into. Brands with quarterly cadence get spiky cash, not smoothed mush.</div>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4, color: 'var(--muted)' }}>6. COLLECTION LAG → CASH</div>
 <div style={{ fontSize: 13 }}>Apply each brand's paid-invoice lag curve (months 0-{driver.maxLagMonths}) to route the invoice value into the future week when cash arrives. Brands with &lt;30% paid coverage fall back to a global curve.</div>
 </div>
 </div>
 </CollapsibleSection>

 {/* WHY EARLY WEEKS LOOK LIGHT */}
 <CollapsibleSection
 title="Why are early weeks lighter?"
 sub={
 <>
 This row models <strong>future invoices</strong> not yet booked. Each forecasted month's
 cash is spread uniformly across the weeks of its (issue-month + lag) target month using the
 global average lag curve:
 <strong> {(globalLagCurve[0] * 100).toFixed(0)}%</strong> pays same month,
 <strong> {(globalLagCurve[1] * 100).toFixed(0)}%</strong> next,
 <strong> {(globalLagCurve[2] * 100).toFixed(0)}%</strong> two months out.
 So Wk 1/2 DO get cash from this row (same-month share of the current month's forecast), but
 less than Wk 5+ which start accumulating contributions from multiple forecast months at once.
 Cash from <strong>already-issued open invoices</strong> shows separately in the "Little Tree AR
 Collections" row on the 13-Week Plan - it's not in this number.
 </>
 }
 ><div /></CollapsibleSection>

 {/* MONTHLY ROLLUP - legacy v1 */}
 <CollapsibleSection
 title="Monthly forecast (legacy per-brand)"
 sub="Before lag · summed across all active brands. Kept for drilldown comparison vs the approved methodology."
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 {monthlyForecast.map((m) => <th key={m.ym} className="num">{ymLabel(m.ym)}</th>)}
 <th className="num">Total</th>
 </tr>
 </thead>
 <tbody>
 <tr>
 {monthlyForecast.map((m) => <td key={m.ym} className="num"><strong>{formatCurrency(m.amount)}</strong></td>)}
 <td className="num"><strong>{formatCurrency(totalForecastedSales)}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 {/* WEEKLY ROLLUP - legacy v1 */}
 <CollapsibleSection
 title="Weekly cash arrival (legacy per-brand)"
 sub="After lag · cash that we expect to land each week from these future invoices."
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 {weeks.map((w) => (
 <th key={w.index} className="num">
 <div style={{ fontSize: 11, fontWeight: 700 }}>Wk {w.index + 1}</div>
 <div style={{ fontSize: 10, color: 'var(--muted)' }}>{w.label}</div>
 </th>
 ))}
 <th className="num">Total</th>
 </tr>
 </thead>
 <tbody>
 <tr>
 {weeklyInflow.map((v, i) => (
 <td key={i} className="num">{v > 0 ? formatCurrency(v) : <span className="vendor-note">-</span>}</td>
 ))}
 <td className="num"><strong>{formatCurrency(totalProjectedCash)}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 </CollapsibleSection>

 {/* PER-BRAND DETAIL - only meaningful for the wholesale bucket
     (private label / gelato are single-customer slices, no brand axis) */}
 {showBrandDrilldown && <CollapsibleSection
 title={`Per-brand detail (${brands.length} brands)`}
 sub="Each row shows what's actually been coming in (last 6 months observed, cadence, 90d momentum) alongside the forecast. Click a row to expand full 12-month history, lag curve, and weekly cash distribution."
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th rowSpan={2}>Brand</th>
 <th rowSpan={2}>Tier</th>
 <th className="num" rowSpan={2}>Invoices · cadence</th>
 <th className="num" rowSpan={2}>Paid %</th>
 <th className="num" rowSpan={2}>90d momentum</th>
 <th className="num" colSpan={6} style={{ borderBottom: '1px solid var(--border)' }}>RECENT 6 MONTHS (actual sales $)</th>
 <th className="num" rowSpan={2}>Last 3m avg</th>
 <th className="num" rowSpan={2}>Trend / mo</th>
 <th className="num" colSpan={4} style={{ borderBottom: '1px solid var(--border)' }}>FORECAST (after tier weight)</th>
 <th className="num" rowSpan={2}>13-wk cash</th>
 </tr>
 <tr>
 {[5, 4, 3, 2, 1, 0].map((offset) => (
 <th key={`h${offset}`} className="num" style={{ fontSize: 10, color: 'var(--muted)' }}>m-{offset}</th>
 ))}
 {[0, 1, 2, 3].map((i) => (
 <th key={`f${i}`} className="num" style={{ fontSize: 10, color: 'var(--muted)' }}>+{i + 1}m</th>
 ))}
 </tr>
 </thead>
 <tbody>
 {brands.map((b) => (
 <BrandRows
 key={b.brand}
 brand={b}
 weeks={weeks}
 horizonMonths={horizonMonths}
 lookbackWindow={lookbackWindow}
 lookbackMonths={driver.lookbackMonths}
 expanded={expandedBrand === b.brand}
 onToggle={() => setExpandedBrand(expandedBrand === b.brand ? null : b.brand)}
 />
 ))}
 </tbody>
 </table>
 </div>
 </CollapsibleSection>}

 {/* CHURNED BRANDS (visible for transparency, zero weight) */}
 {showBrandDrilldown && churnedBrands.length > 0 && (
 <CollapsibleSection
 title={`Likely churned (${churnedBrands.length})`}
 sub="No invoice in over a year · weight 0 in the forecast. Kept here for transparency so you can spot any that you'd expect to come back."
 >
 <div className="table-wrap">
 <table className="data-table">
 <thead><tr><th>Brand</th><th className="num">Last invoice</th><th className="num">Days silent</th></tr></thead>
 <tbody>
 {churnedBrands.map((d) => (
 <tr key={d.brand}>
 <td>{d.brand}</td>
 <td className="num vendor-note">{d.lastInvoiceDate}</td>
 <td className="num vendor-note">{d.daysSinceLastInvoice}d</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </CollapsibleSection>
 )}
 </>
 );
}

function BrandRows({
 brand: b, weeks, horizonMonths: _horizon, lookbackWindow: _look, lookbackMonths, expanded, onToggle,
}: {
 brand: SalesForecastBrand;
 weeks: { index: number; start: string; end: string; label: string }[];
 horizonMonths: string[];
 lookbackWindow: string[];
 lookbackMonths: number;
 expanded: boolean;
 onToggle: () => void;
}) {
 const trendTone = b.trendSlope > 0 ? '#059669' : b.trendSlope < 0 ? 'var(--danger)' : 'var(--muted)';
 // Pull the last 6 entries from the 12-month history strip (newest last in the array).
 const last6 = b.history.slice(-6);
 const momTone = b.momentum90d.deltaPct === null
 ? 'var(--muted)'
 : b.momentum90d.deltaPct > 0 ? '#059669' : b.momentum90d.deltaPct < 0 ? 'var(--danger)' : 'var(--muted)';
 const paidTone = b.paidRatio >= 0.85 ? '#059669' : b.paidRatio >= 0.6 ? 'var(--warn)' : 'var(--danger)';
 const totalColumns = 17; // brand + tier + cadence + paid + momentum + 6 history + baseline + trend + 4 forecast + cash
 return (
 <>
 <tr style={{ cursor: 'pointer' }} onClick={onToggle}>
 <td>
 <strong>{b.brand}</strong>
 {b.hasSeasonality && <span className="pill-tag tag-fuzzy" style={{ marginLeft: 6, fontSize: 10 }}>seasonal</span>}
 {b.brandSource !== 'sheet' && (
   <span
     className="pill-tag tag-warn"
     title={b.brandSource === 'derived'
       ? 'Brand name auto-derived from customer name (Invoice Tracker brand column was empty for these invoices)'
       : 'Some invoices for this brand have empty Brand column in Invoice Tracker - partial auto-derivation'
     }
     style={{ marginLeft: 6, fontSize: 10 }}
   >
   {b.brandSource === 'derived' ? 'auto-derived' : 'partial sheet'}
   </span>
 )}
 <div className="vendor-note" style={{ fontSize: 10, marginTop: 2 }}>
 ~{b.cadenceDays}d cadence · avg {formatCurrency(b.avgInvoiceAmount)} · next {b.nextExpectedDate || '-'}
 </div>
 <div className="vendor-note" style={{ fontSize: 10 }}>
 last {b.daysSinceLastInvoice}d · {b.monthsObserved}/{lookbackMonths}m · growth ×{b.growthMultiplier.toFixed(2)}
 </div>
 </td>
 <td>
 <span className={`pill-tag tag-${b.activityTier === 'active' ? 'strong' : b.activityTier === 'cooling' ? 'fuzzy' : 'warn'}`}>
 {b.activityTier} · {(b.recencyWeight * 100).toFixed(0)}%
 </span>
 </td>
 <td className="num">
 <strong>{b.invoiceCount}</strong>
 <div className="vendor-note" style={{ fontSize: 10 }}>{b.invoicesPerActiveMonth}/mo active</div>
 </td>
 <td className="num" style={{ color: paidTone }}>{(b.paidRatio * 100).toFixed(0)}%</td>
 <td className="num" style={{ color: momTone }}>
 {b.momentum90d.deltaPct === null ? <span className="vendor-note">-</span> : `${b.momentum90d.deltaPct >= 0 ? '+' : ''}${b.momentum90d.deltaPct.toFixed(0)}%`}
 <div className="vendor-note" style={{ fontSize: 10 }}>
 {formatCurrency(b.momentum90d.recent)} vs {formatCurrency(b.momentum90d.prior)}
 </div>
 </td>
 {/* 6-month inline history (newest right) */}
 {last6.map((h) => (
 <td key={`hi-${h.ym}`} className="num" style={{ fontSize: 11 }}>
 {h.amount > 0 ? formatCurrency(h.amount) : <span className="vendor-note">-</span>}
 </td>
 ))}
 <td className="num">{formatCurrency(b.baselineMonthly)}</td>
 <td className="num" style={{ color: trendTone }}>{formatSigned(b.trendSlope)}</td>
 {/* 4-month inline forecast */}
 {b.forecast.map((f) => (
 <td key={`fi-${f.ym}`} className="num" style={{ fontSize: 11, fontWeight: 600 }}>
 {f.amount > 0 ? formatCurrency(f.amount) : <span className="vendor-note">-</span>}
 </td>
 ))}
 <td className="num"><strong>{formatCurrency(b.totalProjectedCash)}</strong></td>
 </tr>
 {expanded && (
 <tr>
 <td colSpan={totalColumns} style={{ background: 'var(--panel-soft)', padding: 16 }}>
 <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>OBSERVED HISTORY (used to fit the trend)</div>
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>{b.history.map((h) => <th key={h.ym} className="num">{ymLabel(h.ym)}</th>)}</tr>
 </thead>
 <tbody>
 <tr>{b.history.map((h) => <td key={h.ym} className="num">{h.amount > 0 ? formatCurrency(h.amount) : <span className="vendor-note">-</span>}</td>)}</tr>
 </tbody>
 </table>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>FORECASTED MONTHS</div>
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>{b.forecast.map((f) => <th key={f.ym} className="num">{ymLabel(f.ym)}</th>)}</tr>
 </thead>
 <tbody>
 <tr>{b.forecast.map((f) => <td key={f.ym} className="num"><strong>{formatCurrency(f.amount)}</strong></td>)}</tr>
 </tbody>
 </table>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>LAG CURVE ({b.lagSource === 'brand' ? 'brand-specific' : 'global fallback'})</div>
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>{b.lagCurve.map((_, i) => <th key={i} className="num">{i}m</th>)}</tr>
 </thead>
 <tbody>
 <tr>{b.lagCurve.map((v, i) => <td key={i} className="num">{(v * 100).toFixed(1)}%</td>)}</tr>
 </tbody>
 </table>
 <div className="vendor-note" style={{ marginTop: 4 }}>
 % of invoice $ that pays at each lag, fit from this brand's paid history.
 </div>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>WEEKLY CASH (13-week window)</div>
 <div className="table-wrap" style={{ overflowX: 'auto' }}>
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>{weeks.map((w) => <th key={w.index} className="num">W{w.index + 1}</th>)}</tr>
 </thead>
 <tbody>
 <tr>{b.weeklyInflow.map((v, i) => (
 <td key={i} className="num">{v > 0 ? formatCurrency(v) : <span className="vendor-note">-</span>}</td>
 ))}</tr>
 </tbody>
 </table>
 </div>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>CADENCE & GROWTH DRIVERS</div>
 <div style={{ fontSize: 12, lineHeight: 1.6 }}>
 <div>Median gap: <strong>{b.cadenceDays}d</strong> {b.gapDays.length > 0 && <span className="vendor-note">(observed gaps: {b.gapDays.join('d, ')}d)</span>}</div>
 <div>Avg invoice (last 6, winsorized): <strong>{formatCurrency(b.avgInvoiceAmount)}</strong></div>
 <div>Growth multiplier: <strong>×{b.growthMultiplier.toFixed(2)}</strong> <span className="vendor-note">(recent 90d ÷ prior 90d)</span></div>
 <div>Last invoice: <strong>{b.lastInvoiceDate}</strong> ({b.daysSinceLastInvoice}d ago)</div>
 <div>Next expected: <strong>{b.nextExpectedDate || '-'}</strong></div>
 <div>Activity tier: <strong>{b.activityTier}</strong> · weight {(b.recencyWeight * 100).toFixed(0)}%</div>
 </div>
 </div>
 {b.hasSeasonality && (
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>SEASONAL INDICES (month-of-year)</div>
 <table className="data-table" style={{ fontSize: 11 }}>
 <thead>
 <tr>{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m) => <th key={m} className="num">{m}</th>)}</tr>
 </thead>
 <tbody>
 <tr>{b.seasonalIndices.map((v, i) => (
 <td key={i} className="num" style={{ color: v > 1.1 ? '#059669' : v < 0.9 ? 'var(--danger)' : 'var(--muted)' }}>
 {v.toFixed(2)}
 </td>
 ))}</tr>
 </tbody>
 </table>
 <div className="vendor-note" style={{ marginTop: 4 }}>
 &gt;1.0 = above-avg month for this brand · &lt;1.0 = below-avg · smoothed 70/30 toward 1.0.
 </div>
 </div>
 )}
 <div style={{ gridColumn: '1 / -1' }}>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>PROJECTED INVOICES (cadence-walked from last observed)</div>
 {b.projectedInvoices.length === 0 ? (
 <div className="vendor-note">No projected invoices in horizon (avg amount = 0 or cadence not computable).</div>
 ) : (
 <div className="table-wrap" style={{ overflowX: 'auto' }}>
 <table className="data-table" style={{ fontSize: 11 }}>
 <thead>
 <tr>
 <th>#</th>
 <th>Expected date</th>
 <th className="num">Month</th>
 <th className="num">Amount</th>
 </tr>
 </thead>
 <tbody>
 {b.projectedInvoices.map((p, i) => (
 <tr key={`p-${i}`}>
 <td>{i + 1}</td>
 <td>{p.date}</td>
 <td className="num">{p.ym}</td>
 <td className="num"><strong>{formatCurrency(p.amount)}</strong></td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </div>
 <div style={{ gridColumn: '1 / -1' }}>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>RECENT INVOICES (last {b.recentInvoices.length})</div>
 {b.recentInvoices.length === 0 ? (
 <div className="vendor-note">No invoices in lookback.</div>
 ) : (
 <div className="table-wrap" style={{ overflowX: 'auto' }}>
 <table className="data-table" style={{ fontSize: 11 }}>
 <thead>
 <tr>
 <th>Date</th>
 <th className="num">Amount</th>
 </tr>
 </thead>
 <tbody>
 {b.recentInvoices.map((r, i) => (
 <tr key={`r-${i}`}>
 <td>{r.date}</td>
 <td className="num">{formatCurrency(r.amount)}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 )}
 </div>
 </div>
 </td>
 </tr>
 )}
 </>
 );
}
