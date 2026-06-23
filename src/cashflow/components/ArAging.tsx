import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { fetchArAging, setBrandEmail, type ArAgingResult, type ArAgingGroup, type ArAgingInvoice, type ArBucket, type CustomerConcentration } from '../api';
import { formatCurrency } from '../format';

/** Concentration KPI strip - top brand, top-N share, HHI, Pareto count. */
function ConcentrationKpis({ cc }: { cc: CustomerConcentration }) {
 const tierColor = cc.hhiTier === 'High' ? 'var(--danger)' : cc.hhiTier === 'Moderate' ? '#b45309' : '#059669';
 const tierBg = cc.hhiTier === 'High' ? 'var(--danger)' : cc.hhiTier === 'Moderate' ? '#b45309' : '#059669';
 return (
 <div className="section" style={{ padding: 0, border: 'none', boxShadow: 'none' }}>
 <div className="section-head" style={{ padding: '12px 18px 4px' }}>
 <div>
 <div className="section-title" style={{ fontSize: 13 }}>Customer Concentration</div>
 <div className="section-sub" style={{ fontSize: 11 }}>
 Credit-risk diagnostics from per-brand AR distribution. HHI &lt;1500 = diversified, 1500-2500 = moderate, &gt;2500 = concentrated.
 </div>
 </div>
 </div>
 <div className="kpis" style={{ padding: '4px 14px 14px' }}>
 <div className="kpi highlight" style={{ borderLeft: `4px solid ${tierBg}` }}>
 <div className="kpi-label">Top Customer</div>
 <div className="kpi-period" title={cc.topBrand?.name}>
 {cc.topBrand?.name ? (cc.topBrand.name.length > 22 ? cc.topBrand.name.slice(0, 22) + '...' : cc.topBrand.name) : '-'}
 </div>
 <div className="kpi-value">{cc.topBrand ? `${cc.topBrand.share.toFixed(1)}%` : '-'}</div>
 <div className="kpi-sub">{cc.topBrand ? formatCurrency(cc.topBrand.ar) : '-'}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Top 3 / 5 / 10</div>
 <div className="kpi-period">Cumulative share</div>
 <div className="kpi-value" style={{ fontSize: 14, lineHeight: 1.4 }}>
 <div>Top 3: <strong>{cc.top3Share.toFixed(1)}%</strong></div>
 <div>Top 5: <strong>{cc.top5Share.toFixed(1)}%</strong></div>
 <div>Top 10: <strong>{cc.top10Share.toFixed(1)}%</strong></div>
 </div>
 <div className="kpi-sub">of total AR</div>
 </div>
 <div
 className="kpi"
 title={`HHI (Herfindahl-Hirschman Index) = Σ(share%²)\n0 - 1500: Low concentration (diversified)\n1500 - 2500: Moderate\n2500+: High concentration (single-customer risk)`}
 style={{ borderLeft: `4px solid ${tierBg}` }}
 >
 <div className="kpi-label">HHI Score</div>
 <div className="kpi-period" style={{ color: tierColor }}>{cc.hhiTier} concentration</div>
 <div className="kpi-value">{cc.hhi.toLocaleString()}</div>
 <div className="kpi-sub">Σ(share%²) across all brands</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Pareto (80%)</div>
 <div className="kpi-period">{cc.customerCount} brands total</div>
 <div className="kpi-value">{cc.paretoCount}</div>
 <div className="kpi-sub">brands cover 80% of AR</div>
 </div>
 </div>
 {cc.topBrands.length > 0 && (
 <div style={{ padding: '0 14px 14px' }}>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Rank</th>
 <th>Brand</th>
 <th className="num">AR</th>
 <th className="num">Share</th>
 <th className="num">Cumulative</th>
 </tr>
 </thead>
 <tbody>
 {cc.topBrands.map((b, i) => (
 <tr key={b.brand}>
 <td><strong>#{i + 1}</strong></td>
 <td>{b.brand}</td>
 <td className="num"><strong>{formatCurrency(b.ar)}</strong></td>
 <td className="num">{b.share.toFixed(1)}%</td>
 <td className="num">{b.cumulativeShare.toFixed(1)}%</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>
 )}
 </div>
 );
}

/** Inline editable brand-email field. */
function BrandEmail({ brand, initialEmail }: { brand: string; initialEmail: string }) {
 const [editing, setEditing] = useState(false);
 const [value, setValue] = useState(initialEmail);
 const [saving, setSaving] = useState(false);

 async function save() {
 setSaving(true);
 try {
 await setBrandEmail(brand, value);
 setEditing(false);
 } catch {
 // keep editing open on error
 } finally {
 setSaving(false);
 }
 }

 if (editing) {
 return (
 <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
 <input
 type="email"
 value={value}
 onChange={(e) => setValue(e.target.value)}
 placeholder="ar@brand.com"
 disabled={saving}
 autoFocus
 style={{ fontSize: 12, padding: '2px 6px', border: '1px solid #d9e2dc', borderRadius: 4, minWidth: 180 }}
 onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') { setValue(initialEmail); setEditing(false); } }}
 />
 <button className="btn ghost" disabled={saving} onClick={() => void save()} style={{ fontSize: 11, padding: '2px 8px' }}>
 {saving ? '…' : 'Save'}
 </button>
 <button className="btn ghost" disabled={saving} onClick={() => { setValue(initialEmail); setEditing(false); }} style={{ fontSize: 11, padding: '2px 8px' }}>
 Cancel
 </button>
 </span>
 );
 }
 return (
 <span
 onClick={(e) => { e.stopPropagation(); setEditing(true); }}
 style={{ cursor: 'pointer', fontSize: 12, color: initialEmail ? 'var(--text)' : 'var(--muted)' }}
 title="Click to edit brand email"
 >
 {initialEmail || '+ add email'}
 </span>
 );
}

/** Compact inline invoice table - rendered inside a colspan'd row right
 * below the bucket/brand row the user clicked. */
function InvoiceMini({ invoices, label }: { invoices: ArAgingInvoice[]; label: string }) {
 const subtotal = invoices.reduce((s, i) => s + i.amount, 0);
 return (
 <div style={{ padding: '8px 0', background: 'var(--bg-soft, #f8fbfa)' }}>
 <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 8px 8px' }}>
 <strong>{invoices.length}</strong> invoice{invoices.length === 1 ? '' : 's'} for {label} · subtotal <strong>{formatCurrency(subtotal)}</strong>
 </div>
 <table className="data-table" style={{ background: 'transparent', fontSize: 13 }}>
 <thead>
 <tr>
 <th>Inv #</th>
 <th>Customer</th>
 <th>Issue</th>
 <th className="num">Amount</th>
 <th className="num">Days</th>
 <th>Bucket</th>
 <th>Status</th>
 </tr>
 </thead>
 <tbody>
 {invoices.map((inv) => (
 <tr key={inv.invoiceNumber}>
 <td><strong>{inv.invoiceNumber}</strong></td>
 <td className="vendor-note" title={inv.description}>{inv.customer}</td>
 <td>{inv.issueDate}</td>
 <td className="num"><strong>{formatCurrency(inv.amount)}</strong></td>
 <td className="num">{inv.daysOut}</td>
 <td><span className={`pill-tag tag-${bucketTone(inv.bucket)}`}>{inv.bucket}</span></td>
 <td><span className={`pill-tag tag-${inv.status === 'Overdue' ? 'none' : 'fuzzy'}`}>{inv.status}</span></td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 );
}

/** Brands-within-a-bucket drill - click a brand row to reveal that brand's
 * invoices inside this specific bucket. Two-level drill: bucket → brand → invoices. */
function BrandsInBucket({ invoices, bucket }: { invoices: ArAgingInvoice[]; bucket: ArBucket }) {
 const [openBrand, setOpenBrand] = useState<string | null>(null);
 const bucketTotal = invoices.reduce((s, i) => s + i.amount, 0);
 const byBrand = new Map<string, ArAgingInvoice[]>();
 for (const inv of invoices) {
 const arr = byBrand.get(inv.channel) ?? [];
 arr.push(inv);
 byBrand.set(inv.channel, arr);
 }
 const brands = [...byBrand.entries()]
 .map(([brand, list]) => ({ brand, list, gross: list.reduce((s, i) => s + i.amount, 0) }))
 .sort((a, b) => b.gross - a.gross);
 return (
 <div style={{ padding: '8px 0', background: 'var(--bg-soft, #f8fbfa)' }}>
 <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 8px 8px' }}>
 <strong>{brands.length}</strong> brand{brands.length === 1 ? '' : 's'} in bucket {bucket} · subtotal <strong>{formatCurrency(bucketTotal)}</strong> · click a brand to see invoices
 </div>
 <table className="data-table" style={{ background: 'transparent', fontSize: 13 }}>
 <thead>
 <tr>
 <th>Brand</th>
 <th className="num">Invoices</th>
 <th className="num">Gross AR</th>
 <th className="num">Share of bucket</th>
 </tr>
 </thead>
 <tbody>
 {brands.map(({ brand, list, gross }) => {
 const isOpen = openBrand === brand;
 const share = bucketTotal > 0 ? (gross / bucketTotal) * 100 : 0;
 return (
 <Fragment key={brand}>
 <tr
 onClick={() => setOpenBrand(isOpen ? null : brand)}
 style={{ cursor: 'pointer', background: isOpen ? 'var(--accent-soft, #e6f4ef)' : undefined }}
 >
 <td>
 <strong>{brand}</strong>
 <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}>
 {isOpen ? '▼ hide' : '▶ view invoices'}
 </span>
 </td>
 <td className="num">{list.length}</td>
 <td className="num"><strong>{formatCurrency(gross)}</strong></td>
 <td className="num">{share.toFixed(1)}%</td>
 </tr>
 {isOpen && (
 <tr>
 <td colSpan={4} style={{ padding: 0 }}>
 <InvoiceMini invoices={list} label={`${brand} · ${bucket}`} />
 </td>
 </tr>
 )}
 </Fragment>
 );
 })}
 </tbody>
 </table>
 </div>
 );
}

const POLL_INTERVAL_MS = 30_000;
const BUCKET_ORDER: ArBucket[] = ['0-14', '15-30', '31-60', '61-90', '90+'];

function bucketTone(b: ArBucket): string {
 switch (b) {
 case '0-14': return 'fuzzy';
 case '15-30': return 'fuzzy';
 case '31-60': return 'warn';
 case '61-90': return 'warn';
 case '90+': return 'none';
 }
}

function GroupCard({
 group,
 open,
 onToggle,
}: {
 group: ArAgingGroup;
 open: boolean;
 onToggle: () => void;
}) {
 const { totals, bucketSummary, channelSummary, dsoPaid, dsoOpen, netTermsDays, invoices } = group;
 const collectRate = totals.grossAr > 0 ? (totals.expectedCollectible / totals.grossAr) * 100 : 0;
 // Inline drill-down - bucket and brand expand independently in their own tables.
 const [selectedBucket, setSelectedBucket] = useState<ArBucket | null>(null);
 const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
 return (
 <div className="section">
 <div
 className="section-head"
 style={{ cursor: 'pointer', userSelect: 'none' }}
 onClick={onToggle}
 >
 <div>
 <div className="section-title">
 {open ? '▼' : '▶'} {group.label} AR <span className="pill-tag tag-fuzzy" style={{ marginLeft: 8 }}>Net {netTermsDays}</span>
 </div>
 <div className="section-sub">
 {totals.invoiceCount} open invoice{totals.invoiceCount === 1 ? '' : 's'}
 {dsoPaid.totalAmount > 0 && (
 <>
 {' '}· Paid DSO <strong title={`Σ(amt × days) ÷ Σ(amt) for fully-paid invoices\n= ${formatCurrency(dsoPaid.weightedDays)} ÷ ${formatCurrency(dsoPaid.totalAmount)}\n= ${dsoPaid.dso.toFixed(1)} days\nSampled across ${dsoPaid.invoiceCount} paid invoices`}>{dsoPaid.dso.toFixed(1)}d</strong>
 </>
 )}
 {dsoOpen.totalAmount > 0 && (
 <>
 {' '}· Open DSO <strong title={`Σ(open × days) ÷ Σ(open) for currently outstanding invoices\n= ${formatCurrency(dsoOpen.weightedDays)} ÷ ${formatCurrency(dsoOpen.totalAmount)}\n= ${dsoOpen.dso.toFixed(1)} days\nSampled across ${dsoOpen.invoiceCount} open invoices`}>{dsoOpen.dso.toFixed(1)}d</strong>
 </>
 )}
 </div>
 </div>
 <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
 <div style={{ textAlign: 'right' }}>
 <div style={{ fontSize: 12, color: 'var(--muted)' }}>Gross AR</div>
 <div style={{ fontSize: 18, fontWeight: 600 }}>{formatCurrency(totals.grossAr)}</div>
 </div>
 <div style={{ textAlign: 'right' }}>
 <div style={{ fontSize: 12, color: 'var(--muted)' }}>Expected ({collectRate.toFixed(0)}%)</div>
 <div style={{ fontSize: 18, fontWeight: 600, color: '#059669' }}>{formatCurrency(totals.expectedCollectible)}</div>
 </div>
 </div>
 </div>

 {open && (
 <>
 {/* Customer Concentration KPI strip - Non-Gelato only (Gelato is single-customer) */}
 {group.customerConcentration && (
 <ConcentrationKpis cc={group.customerConcentration} />
 )}
 {/* Bucket summary - click a bucket row to expand its invoices inline right below */}
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Bucket</th>
 <th className="num">Total $</th>
 <th className="num">Share</th>
 </tr>
 </thead>
 <tbody>
 {BUCKET_ORDER.map((b) => {
 const v = bucketSummary[b];
 const pct = totals.grossAr ? (v / totals.grossAr) * 100 : 0;
 const isSelected = selectedBucket === b;
 const isClickable = v > 0;
 const bucketInvoices = isSelected ? invoices.filter((i) => i.bucket === b) : [];
 return (
 <Fragment key={b}>
 <tr
 onClick={() => isClickable && setSelectedBucket(isSelected ? null : b)}
 style={{
 cursor: isClickable ? 'pointer' : 'default',
 background: isSelected ? 'var(--accent-soft, #e6f4ef)' : undefined,
 }}
 >
 <td>
 <span className={`pill-tag tag-${bucketTone(b)}`}>{b}</span>
 {isClickable && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}>{isSelected ? '▼ hide' : '▶ view invoices'}</span>}
 </td>
 <td className="num"><strong>{v ? formatCurrency(v) : '$ -'}</strong></td>
 <td className="num">{v ? pct.toFixed(1) + '%' : '-'}</td>
 </tr>
 {isSelected && bucketInvoices.length > 0 && (
 <tr>
 <td colSpan={3} style={{ padding: 0 }}>
 <BrandsInBucket invoices={bucketInvoices} bucket={b} />
 </td>
 </tr>
 )}
 </Fragment>
 );
 })}
 <tr className="total-row">
 <td>Total</td>
 <td className="num"><strong>{formatCurrency(totals.grossAr)}</strong></td>
 <td className="num">100%</td>
 </tr>
 </tbody>
 </table>
 </div>

 {/* Per-brand summary - click a row to expand its invoices inline right below */}
 {channelSummary.length > 1 && (
 <div className="section-head" style={{ marginTop: 16 }}>
 <div>
 <div className="section-title" style={{ fontSize: 14 }}>By Brand</div>
 <div className="section-sub">Click a brand to see its invoices</div>
 </div>
 </div>
 )}
 {channelSummary.length > 1 && (
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>Brand</th>
 <th>Email</th>
 <th className="num">Invoices</th>
 <th className="num">Gross AR</th>
 <th className="num">Share</th>
 </tr>
 </thead>
 <tbody>
 {channelSummary.map((c) => {
 const isSelected = selectedChannel === c.channel;
 const brandInvoices = isSelected ? invoices.filter((i) => i.channel === c.channel) : [];
 return (
 <Fragment key={c.channel}>
 <tr
 onClick={() => setSelectedChannel(isSelected ? null : c.channel)}
 style={{
 cursor: 'pointer',
 background: isSelected ? 'var(--accent-soft, #e6f4ef)' : undefined,
 }}
 >
 <td>
 <strong>{c.channel}</strong>
 <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}>
 {isSelected ? '▼ hide' : '▶ view invoices'}
 </span>
 </td>
 <td><BrandEmail brand={c.channel} initialEmail={c.email} /></td>
 <td className="num">{c.invoiceCount}</td>
 <td className="num"><strong>{formatCurrency(c.gross)}</strong></td>
 <td className="num">{c.share.toFixed(1)}%</td>
 </tr>
 {isSelected && brandInvoices.length > 0 && (
 <tr>
 <td colSpan={5} style={{ padding: 0 }}>
 <InvoiceMini invoices={brandInvoices} label={c.channel} />
 </td>
 </tr>
 )}
 </Fragment>
 );
 })}
 <tr className="total-row">
 <td>Total ({channelSummary.length} brands)</td>
 <td></td>
 <td className="num">{totals.invoiceCount}</td>
 <td className="num"><strong>{formatCurrency(totals.grossAr)}</strong></td>
 <td className="num">100%</td>
 </tr>
 </tbody>
 </table>
 </div>
 )}
 </>
 )}
 </div>
 );
}

export function ArAging() {
 const [data, setData] = useState<ArAgingResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [openGelato, setOpenGelato] = useState(false);
 const [openNonGelato, setOpenNonGelato] = useState(false);
 // Which top-strip KPI is currently expanded. Click any KPI to switch
 // focus + see its breakdown below; click the same one again to collapse.
 const [activeKpi, setActiveKpi] = useState<'total' | 'expected' | 'dso' | 'split' | null>('total');

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 try {
 setData(await fetchArAging({ refresh }));
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
 <div className="page-head">
 <div>
 <h1 className="page-title">Accounts Receivable Aging</h1>
 <div className="page-sub">Loading…</div>
 </div>
 </div>
 );
 }
 if (error) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Accounts Receivable Aging</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 const { gelato, nonGelato, combined } = data;

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Accounts Receivable Aging</h1>
 <div className="page-sub">
 Gelato + Little Tree customer receivables · as of <strong>{data.asOfDate}</strong>
 {data.sheetUrl && (<> · <a href={data.sheetUrl} target="_blank" rel="noreferrer">open sheet</a></>)}
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 {/* Combined KPIs at the top - click any to switch focus + see details below */}
 <div className="kpis">
 <button
   type="button"
   className={`kpi ${activeKpi === 'total' ? 'highlight' : ''}`}
   onClick={() => setActiveKpi((k) => (k === 'total' ? null : 'total'))}
   style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
 >
 <div className="kpi-label">Total AR</div>
 <div className="kpi-period">{combined.invoiceCount} open invoices</div>
 <div className="kpi-value">{formatCurrency(combined.grossAr)}</div>
 <div className="kpi-sub">Gross outstanding (Gelato + Little Tree)</div>
 </button>
 <button
   type="button"
   className={`kpi ${activeKpi === 'expected' ? 'highlight' : ''}`}
   onClick={() => setActiveKpi((k) => (k === 'expected' ? null : 'expected'))}
   style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
 >
 <div className="kpi-label">Expected Collectible</div>
 <div className="kpi-period">Weighted by collection %</div>
 <div className="kpi-value" style={{ color: activeKpi === 'expected' ? '#ffffff' : '#059669' }}>{formatCurrency(combined.expectedCollectible)}</div>
 <div className="kpi-sub">
 {combined.grossAr > 0 ? ((combined.expectedCollectible / combined.grossAr) * 100).toFixed(1) : 0}% of gross
 </div>
 </button>
 <button
   type="button"
   className={`kpi ${activeKpi === 'dso' ? 'highlight' : ''}`}
   onClick={() => setActiveKpi((k) => (k === 'dso' ? null : 'dso'))}
   style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
 >
 <div className="kpi-label">DSO (Paid · Open · Combined)</div>
 <div className="kpi-period">Dollar-weighted</div>
 <div className="kpi-value" style={{ fontSize: 14, lineHeight: 1.4 }}>
 <div>Paid: <strong>{combined.dsoPaid.dso.toFixed(1)}d</strong></div>
 <div>Open: <strong>{combined.dsoOpen.dso.toFixed(1)}d</strong></div>
 <div style={{ color: activeKpi === 'dso' ? 'rgba(255,255,255,0.85)' : 'var(--muted)' }}>Combined: <strong>{combined.dsoCombined.dso.toFixed(1)}d</strong></div>
 </div>
 <div className="kpi-sub">Σ(amt × days) ÷ Σ(amt)</div>
 </button>
 <button
   type="button"
   className={`kpi ${activeKpi === 'split' ? 'highlight' : ''}`}
   onClick={() => setActiveKpi((k) => (k === 'split' ? null : 'split'))}
   style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
 >
 <div className="kpi-label">Group Split</div>
 <div className="kpi-period">Gelato vs Little Tree</div>
 <div className="kpi-value" style={{ fontSize: 16, lineHeight: 1.4 }}>
 <div>G: {formatCurrency(gelato.totals.grossAr)}</div>
 <div>LT: {formatCurrency(nonGelato.totals.grossAr)}</div>
 </div>
 <div className="kpi-sub">Click for breakdown</div>
 </button>
 </div>

 {/* KPI detail panel - shows breakdown for the currently-selected KPI */}
 {activeKpi && (
   <KpiDetail
     which={activeKpi}
     combined={combined}
     gelato={gelato}
     nonGelato={nonGelato}
   />
 )}

 {/* Collapsible group sections */}
 <GroupCard group={gelato} open={openGelato} onToggle={() => setOpenGelato((o) => !o)} />
 <GroupCard group={nonGelato} open={openNonGelato} onToggle={() => setOpenNonGelato((o) => !o)} />
 </>
 );
}

/** Detail panel that mirrors the data behind the currently-selected top KPI.
 *  Click the KPI again to collapse this. */
function KpiDetail({
 which,
 combined,
 gelato,
 nonGelato,
}: {
 which: 'total' | 'expected' | 'dso' | 'split';
 combined: ArAgingResult['combined'];
 gelato: ArAgingGroup;
 nonGelato: ArAgingGroup;
}) {
 const Row = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
   <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
     <div style={{ fontSize: 13, color: 'var(--muted-strong)' }}>{label}{sub && <span style={{ color: 'var(--muted)', marginLeft: 6 }}>{sub}</span>}</div>
     <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
   </div>
 );

 let title = '';
 let body: ReactNode = null;

 if (which === 'total') {
   title = 'Total AR breakdown';
   const gPct = combined.grossAr > 0 ? (gelato.totals.grossAr / combined.grossAr) * 100 : 0;
   const lPct = combined.grossAr > 0 ? (nonGelato.totals.grossAr / combined.grossAr) * 100 : 0;
   body = (
     <>
       <Row label="Gelato AR" sub={`(${gelato.totals.invoiceCount} inv)`} value={`${formatCurrency(gelato.totals.grossAr)} · ${gPct.toFixed(1)}%`} />
       <Row label="Little Tree AR" sub={`(${nonGelato.totals.invoiceCount} inv)`} value={`${formatCurrency(nonGelato.totals.grossAr)} · ${lPct.toFixed(1)}%`} />
       <Row label="Combined" sub={`(${combined.invoiceCount} inv)`} value={formatCurrency(combined.grossAr)} />
     </>
   );
 } else if (which === 'expected') {
   title = 'Expected Collectible breakdown';
   const lostAmt = combined.grossAr - combined.expectedCollectible;
   const collectPct = combined.grossAr > 0 ? (combined.expectedCollectible / combined.grossAr) * 100 : 0;
   body = (
     <>
       <Row label="Gross AR" value={formatCurrency(combined.grossAr)} />
       <Row label="Expected to collect" sub={`(${collectPct.toFixed(1)}%)`} value={formatCurrency(combined.expectedCollectible)} />
       <Row label="At risk / write-down" sub={`(${(100 - collectPct).toFixed(1)}%)`} value={formatCurrency(lostAmt)} />
       <Row label="Gelato expected" value={formatCurrency(gelato.totals.expectedCollectible)} />
       <Row label="Little Tree expected" value={formatCurrency(nonGelato.totals.expectedCollectible)} />
     </>
   );
 } else if (which === 'dso') {
   title = 'DSO - dollar-weighted';
   body = (
     <>
       <Row label="Paid DSO" sub={`(${combined.dsoPaid.invoiceCount} inv)`} value={`${combined.dsoPaid.dso.toFixed(1)}d`} />
       <Row label="Open DSO" sub={`(${combined.dsoOpen.invoiceCount} inv)`} value={`${combined.dsoOpen.dso.toFixed(1)}d`} />
       <Row label="Combined" sub={`(${combined.dsoCombined.invoiceCount} inv)`} value={`${combined.dsoCombined.dso.toFixed(1)}d`} />
       <Row label="Formula" value="Σ(amount × days) ÷ Σ(amount)" />
     </>
   );
 } else if (which === 'split') {
   title = 'Gelato vs Little Tree';
   const gPct = combined.grossAr > 0 ? (gelato.totals.grossAr / combined.grossAr) * 100 : 0;
   const lPct = combined.grossAr > 0 ? (nonGelato.totals.grossAr / combined.grossAr) * 100 : 0;
   body = (
     <>
       <Row label="Gelato AR" sub={`(${gelato.totals.invoiceCount} inv)`} value={`${formatCurrency(gelato.totals.grossAr)} · ${gPct.toFixed(1)}%`} />
       <Row label="Gelato expected" value={formatCurrency(gelato.totals.expectedCollectible)} />
       <Row label="Little Tree AR" sub={`(${nonGelato.totals.invoiceCount} inv)`} value={`${formatCurrency(nonGelato.totals.grossAr)} · ${lPct.toFixed(1)}%`} />
       <Row label="Little Tree expected" value={formatCurrency(nonGelato.totals.expectedCollectible)} />
     </>
   );
 }

 return (
   <div className="section" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
     <div className="section-head" style={{ padding: '12px 16px' }}>
       <div className="section-title" style={{ fontSize: 14 }}>{title}</div>
     </div>
     <div>{body}</div>
   </div>
 );
}
