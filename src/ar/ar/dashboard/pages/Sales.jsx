import { useState, useMemo, useEffect } from 'react'
import KpiCard from '../KpiCard.jsx'
import InfoTip from '../components/InfoTip.jsx'
import SalesTrendChart from '../SalesTrendChart.jsx'
import CustomerTable from '../CustomerTable.jsx'
import BrandRollup, { buildVendorBrandMap } from '../components/BrandRollup.jsx'
import { monthlySales, topVendorsSales } from '../../lib/metrics.js'
import { wholesaleScope } from '../../lib/scope.js'
import { isPrivateLabel } from '../../lib/brands.js'
import { useNav } from '../../lib/navigation.jsx'
import { money, num, monthLabel, compactMoney } from '../../lib/format.js'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import { ExportButton } from '../../lib/csv.jsx'
import { ConcentrationTab, SeasonalityTab, BrandMixTab, GeographyTab } from './Insights.jsx'
import { loadBrandCollections } from '../../lib/brandCollections.js'

const LT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'concentration', label: 'Concentration' },
  { id: 'seasonality', label: 'Seasonality' },
  { id: 'brandmix', label: 'Brand Mix' },
  { id: 'geography', label: 'Geography' },
]
const PL2_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'concentration', label: 'Concentration' },
  { id: 'seasonality', label: 'Seasonality' },
  { id: 'brandmix', label: 'Brand Mix' },
]

export default function Sales({ data }) {
  const [book, setBook] = useState('all')          // 'all' = LT + Private Label · 'lt' = Little Tree · 'pl' = Private Label
  const [ltTab, setLtTab] = useState('overview')
  const [ioTab, setIoTab] = useState('pl1')        // 'pl1' | 'pl2'
  const [pl2Tab, setPl2Tab] = useState('overview')

  const ws = useMemo(() => wholesaleScope(data), [data])

  // Little Tree = wholesale book WITHOUT private-label customers.
  // Private Label 2 = private-label customers only (the 4 owned brands are
  // already excluded by `ws`). Same shape as `ws`, so the tab components reuse.
  const ltScope = useMemo(() => ({
    ...ws,
    financials: ws.financials.filter((r) => !r.isPrivateLabelCustomer),
    invoices: ws.invoices.filter((r) => !r.isPrivateLabelCustomer),
  }), [ws])
  const plScope = useMemo(() => ({
    ...ws,
    financials: ws.financials.filter((r) => r.isPrivateLabelCustomer),
    invoices: ws.invoices.filter((r) => r.isPrivateLabelCustomer),
  }), [ws])

  // Lifetime sales reads the invoice tracker, scoped to the same split and
  // excluding the 4 owned private-label brands.
  const ltLifetime = useMemo(() => data.invoices.filter((r) =>
    !r.isPrivateLabelCustomer && !isPrivateLabel(r.brand)), [data.invoices])
  const plLifetime = useMemo(() => data.invoices.filter((r) =>
    r.isPrivateLabelCustomer && !isPrivateLabel(r.brand)), [data.invoices])
  // "All" = Little Tree + Private Label combined (still excludes the 4 owned brands).
  const allLifetime = useMemo(() => data.invoices.filter((r) =>
    !isPrivateLabel(r.brand)), [data.invoices])

  const ltLikeScope = book === 'all' ? ws : ltScope
  const ltLikeLifetime = book === 'all' ? allLifetime : ltLifetime
  const ltLikeLabel = book === 'all' ? 'All' : 'Little Tree'

  return (

    <div className="page">
      {/* Top-level segment toggle - top right */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
        {[['all', 'All'], ['lt', 'Little Tree'], ['pl', 'Infused Origin']].map(([id, lbl]) => (
            <button
              key={id}
              onClick={() => setBook(id)}
              style={{
                fontSize: 13.5, padding: '7px 16px', border: 'none', cursor: 'pointer', fontWeight: book === id ? 600 : 500,
                borderLeft: id !== 'all' ? '1px solid #e2e8f0' : 'none',
                background: book === id ? '#15803d' : '#fff',
                color: book === id ? '#fff' : '#475569',
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {(book === 'all' || book === 'lt') && (
        <>
          <div className="ar-tabs-row subtabs-row">
            <div className="ar-tabs subtabs">
              {LT_TABS.map((t) => (
                <button key={t.id} className={`ar-tab ${ltTab === t.id ? 'active' : ''}`} onClick={() => setLtTab(t.id)}>{t.label}</button>
              ))}
            </div>
          </div>
          {ltTab === 'overview' && <OverviewTab ws={ltLikeScope} lifetimeInvoices={ltLikeLifetime} label={ltLikeLabel} />}
          {ltTab === 'concentration' && <ConcentrationTab ws={ltLikeScope} />}
          {ltTab === 'seasonality' && <SeasonalityTab ws={ltLikeScope} />}
          {ltTab === 'brandmix' && <BrandMixTab ws={ltLikeScope} />}
          {ltTab === 'geography' && <GeographyTab ws={ws} />}
        </>
      )}
      {book === 'pl' && (
        <>
          <div className="ar-tabs-row subtabs-row">
            <div className="ar-tabs subtabs">
              {PL2_TABS.map((t) => (
                <button key={t.id} className={`ar-tab ${pl2Tab === t.id ? 'active' : ''}`} onClick={() => setPl2Tab(t.id)}>{t.label}</button>
              ))}
            </div>
          </div>
          {pl2Tab === 'overview' && <OverviewTab ws={plScope} lifetimeInvoices={plLifetime} label="Infused Origin" />}
          {pl2Tab === 'concentration' && <ConcentrationTab ws={plScope} />}
          {pl2Tab === 'seasonality' && <SeasonalityTab ws={plScope} />}
          {pl2Tab === 'brandmix' && <BrandMixTab ws={plScope} />}
        </>
      )}

    </div>
  )
}

function OverviewTab({ ws, lifetimeInvoices, label = 'Sales' }) {
  const { openInvoiceList } = useNav()
  const lifetimeSales = lifetimeInvoices.reduce((s, r) => s + r.invoiceAmount, 0)
  const lifetimePaid = lifetimeInvoices.reduce((s, r) => s + r.invoicePaid, 0)
  const now = new Date()
  const curYear = now.getFullYear()
    const ytdFin = lifetimeInvoices.filter((r) => r.date && r.date.getFullYear() === curYear)
  const ytdSales = ytdFin.reduce((s, r) => s + r.invoiceAmount, 0)
  const paidPercent = lifetimeSales > 0 ? (lifetimePaid / lifetimeSales) * 100 : 0

  // Year span of the data (earliest to latest invoice year) for the info tips.
  const allYears = lifetimeInvoices.map((r) => r.date && r.date.getFullYear()).filter(Boolean)
  const yMin = allYears.length ? Math.min(...allYears) : null
  const yMax = allYears.length ? Math.max(...allYears) : null
  const span = yMin ? (yMin === yMax ? `${yMin}` : `${yMin}-${yMax}`) : ''

   const trend24 = monthlySales(lifetimeInvoices, 24)
  const allSales = topVendorsSales(lifetimeInvoices, 99999)
  const vendorBrand = buildVendorBrandMap(ws.invoices)

  const last = trend24[trend24.length - 1]
  const prev = trend24[trend24.length - 2]
  const growth = last && prev && prev.sales > 0
    ? ((last.sales - prev.sales) / prev.sales) * 100
    : null
  const latestMonthFin = last
    ? lifetimeInvoices.filter((r) => r.date &&
        `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, '0')}` === last.key)
    : []

  return (
    <>
      <section className="kpi-grid">
        <KpiCard
          label="Lifetime sales" value={money(lifetimeSales)} sub={`${num(lifetimeInvoices.length)} invoices`}
          info={{
            title: 'Lifetime sales',
            purpose: 'Everything this book has ever invoiced.',
            detail: `Sums the invoiced amount across every invoice on record for this book${span ? ` (${span})` : ''}, with the all-time invoice count beneath. Example: $4.2M across 1,850 invoices.`,
            source: 'Invoice tracker.',
          }}
                   onClick={() => openInvoiceList({ hideOutstanding: true, title: `${label} · Lifetime sales`, subtitle: `${num(lifetimeInvoices.length)} invoices · ${money(lifetimeSales)}`, invoices: lifetimeInvoices })}
        />
        <KpiCard
          label="YTD sales" value={money(ytdSales)} sub={String(curYear)}
          info={{
            title: 'YTD sales',
            purpose: 'Invoiced so far this calendar year.',
            detail: 'Sums the invoiced amount of every invoice dated in the current calendar year to date. Example: $760,000 since Jan 1.',
            source: 'Invoice tracker.',
          }}
                    onClick={ytdFin.length ? () => openInvoiceList({ hideOutstanding: true, title: `${label} · YTD sales ${curYear}`, subtitle: `${num(ytdFin.length)} invoices · ${money(ytdSales)}`, invoices: ytdFin }) : undefined}
        />
        <KpiCard
          label="Latest month"
          value={last ? money(last.sales) : ''}
          sub={growth != null ? `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}% vs prev` : ''}
          tone={growth >= 0 ? 'good' : 'warn'}
          info={{
            title: 'Latest month',
            purpose: 'What we invoiced in the most recent month, plus the change vs the month before.',
            detail: 'Total invoiced in the latest month on the trend; the percent beneath is the change vs the PREVIOUS month (not year-over-year). Example: $90,000 last month, +12% vs prior month.',
            source: 'Invoice tracker.',
          }}
          onClick={last ? () => openInvoiceList({ hideOutstanding: true, title: `${label} · ${last.key}`, subtitle: `${num(latestMonthFin.length)} invoices · ${money(last.sales)}`, invoices: latestMonthFin }) : undefined}
        />
        <KpiCard
          label="Collection rate" value={`${paidPercent.toFixed(1)}%`} sub="Of all invoices" tone="good"
          info={{
            title: 'Collection rate',
            purpose: 'Of everything ever invoiced, the share actually paid.',
            detail: `Lifetime paid divided by lifetime invoiced${span ? ` (${span})` : ''}, shown as a percent. Example: $3.9M paid of $4.2M invoiced = 92.9%.`,
            source: 'Invoice tracker.',
          }}
          onClick={() => openInvoiceList({ hideOutstanding: true, title: `${label} · Collection detail`, subtitle: `${money(lifetimePaid)} paid of ${money(lifetimeSales)} · ${paidPercent.toFixed(1)}%`, invoices: ws.financials })}
        />
      </section>
      <section style={{ position: 'relative' }}>
        <InfoTip
          title="Monthly sales trend"
          purpose="Sales momentum over the last two years, invoiced vs paid."
          detail="Plots invoiced and paid totals per month over the last 24 months; click a month to drill into that month's invoices. Example: March invoiced $90,000 with $70,000 paid."
          source="Invoice tracker."
        />
        <SalesTrendChart
          data={trend24}
          onPointClick={(key) => {
            const invs = lifetimeInvoices.filter((r) => r.date &&
              `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, '0')}` === key)
            openInvoiceList({ hideOutstanding: true, title: `${label} · ${key}`, subtitle: `${num(invs.length)} invoices`, invoices: invs })
          }}
        />
      </section>


      <section style={{ position: 'relative' }}>
        <InfoTip
          title="Brands by sales"
          purpose="The same sales rolled up to brand, billed vs collected."
          detail="Groups every invoice by brand and totals invoiced (Sales) and paid for each, largest first; click a brand to see its customers. Example: Gelato $1.8M sales, $1.7M paid."
          source="Invoice tracker."
        />
        <BrandRollup
          rows={allSales}
          brandOf={(v) => vendorBrand.get(v) || 'No brand'}
          title="Brands by sales"
          columns={[
            { label: 'Sales', agg: (rs) => { const s = rs.reduce((a, r) => a + r.sales, 0); return { display: money(s), sortVal: s } } },
            { label: 'Paid', agg: (rs) => { const s = rs.reduce((a, r) => a + r.paid, 0); return { display: money(s), sortVal: s } } },
          ]}
        >
          {(brandRows) => <CustomerTable rows={[...brandRows].sort((a, b) => b.sales - a.sales)} mode="sales" />}
        </BrandRollup>
      </section>
    </>
  )
}
// ============ PRIVATE LABEL 1 (brand sales) ============
const PL1_CARDS = [
  { key: 'gelato', label: 'Gelato Sales', info: {
    title: 'Gelato Sales',
    purpose: 'Total Gelato brand sales (billed) across all months on record.',
    detail: "Gelato's sales tab already holds a dollar Amount for each month, so this card simply sums those monthly Amounts - no per-unit rate is applied (unlike the other three brands).",
    source: 'Customer Master List (Gelato sales tab).',
  } },
  { key: 'alien', label: 'Alien Brainz Sales', info: {
    title: 'Alien Brainz Sales',
    purpose: 'Total Alien Brainz brand sales (billed) across all months on record.',
    detail: "Computed from the Alien Brainz sales tab as units x rate: each row's QTY is multiplied by $0.60 per unit, then summed by month and across all months.",
    source: 'Customer Master List (Alien Brainz sales tab) - QTY x $0.60.',
  } },
  { key: 'yacht', label: 'Yacht Fuel Sales', info: {
    title: 'Yacht Fuel Sales',
    purpose: 'Total Yacht Fuel brand sales (billed) across all months on record.',
    detail: "Computed from the Yacht Fuel sales tab as units x a per-product rate: OG Gummies at $0.65 per unit and Sunken Treasures at $1.75 per unit, summed by month.",
    source: 'Customer Master List (Yacht Fuel sales tab) - QTY x per-SKU rate.',
  } },
  { key: 'funkd', label: 'Funkd Up Sales', info: {
    title: 'Funkd Up Sales',
    purpose: 'Total Funkd Up brand sales (billed) across all months on record.',
    detail: "Computed from the Funkd Up sales tab as units x rate: each row's QTY is multiplied by $0.65 per unit, then summed by month.",
    source: 'Customer Master List (Funkd Up sales tab) - QTY x $0.65.',
  } },
]

const PL1_LINES = [
  { key: 'gelato', label: 'Gelato', color: '#15803d' },
  { key: 'alien', label: 'Alien Brainz', color: '#7c3aed' },
  { key: 'yacht', label: 'Yacht Fuel', color: '#0ea5e9' },
  { key: 'funkd', label: 'Funkd Up', color: '#f97316' },
]

export function PrivateLabel1({ data }) {
  const pl1 = data.pl1 || {}
  const [detail, setDetail] = useState(null)
  const [coll, setColl] = useState({ loading: true, error: null, data: null })

  // Auto-refresh: initial load, then poll every 60s and on window focus /
  // tab becoming visible. Silent refreshes keep the current data on screen
  // (no "Loading…" flash) and don't blank out on a transient fetch error.
  useEffect(() => {
    let alive = true
    const load = () => loadBrandCollections()
      .then((d) => { if (alive) setColl({ loading: false, error: null, data: d }) })
      .catch((e) => { if (alive) setColl((s) => ({ loading: false, error: s.data ? null : (e?.message || 'Failed to load'), data: s.data })) })
    load()
    const poll = window.setInterval(load, 60000)
    const onFocus = () => load()
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      window.clearInterval(poll)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  const chartData = useMemo(() => {
    const map = new Map()
    for (const c of PL1_CARDS) {
      for (const m of (pl1[c.key]?.monthly || [])) {
        if (!m.key) continue
        const row = map.get(m.key) || { key: m.key }
        row[c.key] = (row[c.key] || 0) + m.sales
        map.set(m.key, row)
      }
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
  }, [pl1])

  return (
    <>
      <section className="kpi-grid">
        {PL1_CARDS.map((c) => {
          const b = pl1[c.key] || { total: 0, monthly: [] }
          return (
            <KpiCard
              key={c.key}
              label={c.label}
              value={money(b.total)}
              sub={`${num(b.monthly.length)} months`}
              info={c.info}
              onClick={b.monthly.length ? () => setDetail({ label: c.label, brand: b, hideUnits: c.key === 'gelato' }) : undefined}
            />
          )
        })}
      </section>

      <section className="chart-card" style={{ marginTop: 16, position: 'relative' }}>
        <InfoTip
          title="Monthly sales trend"
          purpose="How much each brand was billed (sold) month by month."
          detail="One area per brand plotting monthly billed sales on a shared month axis. Sales are computed from each brand's sales tab: Alien Brainz = QTY x $0.60, Funkd Up = QTY x $0.65, Yacht Fuel = QTY x per-SKU rate (OG Gummies $0.65 / Sunken Treasures $1.75), and Gelato from its pre-computed monthly Amount. This is billed sales - not cash collected; the collections chart below shows what actually came in."
          source="Customer Master List (per-brand sales tabs)."
        />
        <div className="chart-head">
          <h3>Monthly sales trend</h3>
          <span className="chart-sub">Gelato · Alien Brainz · Yacht Fuel · Funkd Up</span>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 28 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="key" tickFormatter={(k) => monthLabel(k, { short: true })} tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} interval={0} angle={-45} textAnchor="end" height={50} />
            <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: 'rgba(148,163,184,0.12)' }}
              contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, boxShadow: '0 4px 12px rgba(15,23,42,0.08)' }}
              labelStyle={{ color: '#0f172a', fontWeight: 600 }}
              labelFormatter={monthLabel}
              formatter={(v, name) => [money(v), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {PL1_LINES.map((ln, i) => (
              <Bar key={ln.key} dataKey={ln.key} name={ln.label} fill={ln.color} stackId="sales" radius={i === PL1_LINES.length - 1 ? [3, 3, 0, 0] : undefined} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </section>


      <section className="kpi-grid" style={{ marginTop: 16 }}>
        {PL1_LINES.map((b) => {
          const v = coll.data?.yetToReceive?.[b.key]
          return (
            <KpiCard
              key={b.key}
              label={`${b.label} · yet to receive`}
              value={coll.loading ? '…' : (v != null ? money(v) : '-')}
              sub="Latest closing balance"
              tone={v > 0 ? 'warn' : 'muted'}
              info={{
                title: `${b.label} - amount yet to be received`,
                purpose: `How much ${b.label} still owes us - the outstanding balance left to collect.`,
                detail: `${b.label}'s collection sheet carries a running balance each month: Closing Balance = Opening AR + Sales during the year - Amount received till date (less any off-cycle adjustment). Each month's Closing Balance becomes the next month's Opening AR. This card shows the latest month's Closing Balance${v != null ? ` (currently ${money(v)})` : ''} - i.e. billed but not yet collected. Taken from the most recent year's sheet (2026 for Gelato and Alien Brainz, 2025 for Yacht Fuel and Funkd Up).`,
                source: 'Per-brand collection sheet - Closing Balance row.',
              }}
            />
          )
        })}
      </section>

      <BrandCollectionsChart state={coll} />

      {detail && <Pl1DetailModal label={detail.label} brand={detail.brand} hideUnits={detail.hideUnits} onClose={() => setDetail(null)} />}
    </>
  )
}

// Monthly COLLECTIONS (amount received) per brand. Data is loaded by the parent
// (PrivateLabel1) and passed in, so the cards + chart share one fetch.
function BrandCollectionsChart({ state }) {
  const { loading, error, data } = state
  const brands = data?.brands || []

  return (
    <section className="chart-card" style={{ marginTop: 16, position: 'relative' }}>
      <InfoTip
        title="Monthly collections by brand"
        purpose="How much cash we actually received from each brand, month by month."
        detail="Stacked bars showing the cash actually collected each month, split by brand - each month's full bar is the four brands combined. The value is read straight from the 'Amount received till date' row of each brand's monthly summary box (so it counts real product collections, not misc ledger entries like bank fees or transfers). 2025 comes from the 2025 workbook and 2026 from the 2026 workbook (Gelato and Alien Brainz only - Yacht Fuel and Funkd Up have no 2026). Off-cycle adjustments are excluded."
        source="Per-brand collection sheets (2025 & 2026 workbooks)."
      />
      <div className="chart-head">
        <h3>Monthly collections by brand</h3>
        <span className="chart-sub">Amount received · Gelato · Alien Brainz · Yacht Fuel · Funkd Up</span>
      </div>

      {loading && <div className="muted" style={{ padding: '40px 0', textAlign: 'center' }}>Loading collections…</div>}
      {error && !loading && (
        <div className="muted" style={{ padding: '24px 0', textAlign: 'center', color: 'var(--danger, #dc2626)' }}>
          Couldn't load collection sheets: {error}
        </div>
      )}
      {!loading && !error && data && (
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data.chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="key" tickFormatter={(k) => monthLabel(k, { short: true })} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: 'rgba(15,23,42,0.04)' }}
              contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, boxShadow: '0 4px 12px rgba(15,23,42,0.08)' }}
              labelStyle={{ color: '#0f172a', fontWeight: 600 }}
              labelFormatter={monthLabel}
              formatter={(v, name) => [money(v), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {brands.map((b, i) => (
              <Bar
                key={b.key}
                dataKey={b.key}
                name={b.label}
                stackId="collections"
                fill={b.color}
                radius={i === brands.length - 1 ? [4, 4, 0, 0] : undefined}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}
    </section>
  )
}

function Pl1DetailModal({ label, brand, hideUnits, onClose }) {
  const [month, setMonth] = useState(null)
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') { if (month) setMonth(null); else onClose() } }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [month, onClose])

  const monthly = brand.monthly
  const drill = month ? monthly.find((m) => m.month === month) : null
  const totalUnits = monthly.reduce((s, m) => s + (m.units || 0), 0)

  const exportName = `${label.replace(/\s+/g, '-').toLowerCase()}${drill ? '-' + String(month).replace(/\s+/g, '-').toLowerCase() : ''}-${new Date().toISOString().slice(0, 10)}.csv`
  const exportHeaders = drill
    ? (hideUnits ? ['Item', 'Sales'] : ['Item', 'Units', 'Sales'])
    : (hideUnits ? ['Month', 'Sales'] : ['Month', 'Units', 'Sales'])
  const exportRows = drill
    ? drill.rows.map((x) => { const it = x.label || x.date || ''; return hideUnits ? [it, x.sales.toFixed(2)] : [it, x.units || 0, x.sales.toFixed(2)] })
    : monthly.map((m) => hideUnits ? [m.month, m.sales.toFixed(2)] : [m.month, m.units || 0, m.sales.toFixed(2)])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-head-inner">
            <div>
              <div className="modal-eyebrow">{drill ? <button className="export-btn" onClick={() => setMonth(null)}>← Back</button> : 'Detail view'}</div>
              <h3 className="modal-title">{label}{drill ? ` · ${month}` : ''}</h3>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {drill ? `${num(drill.rows.length)} line items · ${money(drill.sales)}` : `${num(monthly.length)} months · ${money(brand.total)}`}
              </div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </header>
        <div className="modal-body">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <ExportButton filename={exportName} headers={exportHeaders} rows={exportRows} />
          </div>
          <div className="modal-table-wrap">
            {!drill ? (
              <table className="data-table">
                <thead><tr><th>Month</th>{!hideUnits && <th className="num">Units</th>}<th className="num">Sales</th></tr></thead>
                <tbody>
                  {monthly.length === 0 && <tr><td colSpan={hideUnits ? 2 : 3} className="table-empty">No data.</td></tr>}
                  {monthly.map((m) => {
                    const clickable = (m.rows || []).length > 0
                    return (
                      <tr key={m.month} className={clickable ? 'clickable-row' : undefined} onClick={clickable ? () => setMonth(m.month) : undefined}>
                        <td>{m.month}</td>
                        {!hideUnits && <td className="num">{m.units ? num(m.units) : ''}</td>}
                        <td className="num">{money(m.sales)}</td>
                      </tr>
                    )
                  })}
                  {monthly.length > 0 && (
                    <tr>
                      <td><strong>Total</strong></td>
                      {!hideUnits && <td className="num"><strong>{totalUnits ? num(totalUnits) : ''}</strong></td>}
                      <td className="num"><strong>{money(brand.total)}</strong></td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table className="data-table">
                <thead><tr><th>Item</th>{!hideUnits && <th className="num">Units</th>}<th className="num">Sales</th></tr></thead>
                <tbody>
                  {drill.rows.length === 0 && <tr><td colSpan={hideUnits ? 2 : 3} className="table-empty">No line items.</td></tr>}
                  {drill.rows.map((x, i) => (
                    <tr key={i}>
                      <td>{x.label || x.date || '-'}</td>
                      {!hideUnits && <td className="num">{x.units ? num(x.units) : ''}</td>}
                      <td className="num">{money(x.sales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
