// Tab components for the Sales / Customers / Collections pages.
// Previously this file also exported a standalone Insights page; now each tab
// lives in its natural-home page (Sales/Customers/Collections) and the
// top-level page is gone.
import { useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import KpiCard from '../KpiCard.jsx'
import { money, compactMoney, num, monthLabel, monthKey } from '../../lib/format.js'
import { ExportButton } from '../../lib/csv.jsx'
import { flowComparison } from '../../lib/trends.js'
import { useNav } from '../../lib/navigation.jsx'
import { usePager, Pager } from '../../lib/pagination.jsx'
import { detectLocation } from '../../lib/regions.js'
import MichiganMap from '../MichiganMap.jsx'
import { ColumnFilter, useColFilter } from '../components/ColumnFilter.jsx'
import BrandRollup, { buildVendorBrandMap, assignBrandStatus } from '../components/BrandRollup.jsx'
import InfoTip from '../components/InfoTip.jsx'

// (no default export - only the named tab exports below are used)

// ============ DECLINING CUSTOMERS ============
export function DecliningTab({ ws, noBrand = false }) {
  const { openCustomer } = useNav()
  const [sort, setSort] = useState({ key: 'daysSilent', dir: 'desc' })
  const [filter, setFilter] = useState('all')

  // Base list - every customer with order history, tagged by health status.
  // NOT filtered by the active tab, so the KPI counts always reflect the TOTAL.
  const allRows = useMemo(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0)
    const cy = now.getFullYear(), py = cy - 1, py2 = cy - 2

    const map = new Map()
    ws.financials.forEach((r) => {
      if (!r.date) return
      const y = r.date.getFullYear()
      const cur = map.get(r.vendor) || {
        vendor: r.vendor, [cy]: 0, [py]: 0, [py2]: 0,
        lifetime: 0, lastOrder: null, totalOrders: 0, dates: [],
      }
      if (y === cy) cur[cy] += r.invoiceAmount
      else if (y === py) cur[py] += r.invoiceAmount
      else if (y === py2) cur[py2] += r.invoiceAmount
      cur.lifetime += r.invoiceAmount
      cur.totalOrders += 1
      cur.dates.push(r.date)
      if (!cur.lastOrder || r.date > cur.lastOrder) cur.lastOrder = r.date
      map.set(r.vendor, cur)
    })

    return [...map.values()].map((c) => {
      const cySales = c[cy] || 0, pySales = c[py] || 0, py2Sales = c[py2] || 0
      const absDrop = pySales - cySales
      const pctChange = pySales > 0 ? ((cySales - pySales) / pySales) * 100 : (cySales > 0 ? 999 : 0)
      const daysSilent = c.lastOrder ? Math.floor((now - c.lastOrder) / 86400000) : null

      // Normal buy cycle = median gap (days) between consecutive orders (needs ≥3 orders)
      let cycle = null
      if (c.dates.length >= 3) {
        const ds = [...c.dates].sort((a, b) => a - b)
        const gaps = []
        for (let i = 1; i < ds.length; i++) gaps.push((ds[i] - ds[i - 1]) / 86400000)
        gaps.sort((a, b) => a - b)
        cycle = Math.round(gaps[Math.floor(gaps.length / 2)])
      }

      // Order-recency status (NOT calendar-year):
      //   churned   = 6 months (180 days) with no order
      //   declining = overdue by ≥2× their normal cycle but not yet churned
      //               (e.g. a 6-week cycle flags at 12 weeks silent)
      let trend = 'active'
      if (daysSilent != null && daysSilent > 180) trend = 'churned'
      else if (cycle && daysSilent != null && daysSilent > cycle * 2) trend = 'declining'

      return { ...c, cy, py, py2, cySales, pySales, py2Sales, absDrop, pctChange, daysSilent, cycle, trend }
    }).filter((c) => c.totalOrders > 0)
  }, [ws.financials])

  const vendorBrand = useMemo(() => buildVendorBrandMap(ws.invoices), [ws.invoices])
  // Gelato has no brand concept - treat each customer as its own unit so health
  // counts/rollup are per-customer, not collapsed under a single "Gelato" brand.
  const brandOf = noBrand ? ((v) => v) : ((v) => vendorBrand.get(v) || 'No brand')
  const unit = noBrand ? 'customers' : 'brands'
  const unitCap = noBrand ? 'Customers' : 'Brands'
  // Classify each brand by its most-active store, then tag every store with its
  // brand's status. A brand is churned only when ALL its stores are churned; a
  // single active store makes the whole brand active.
  const allRowsBranded = useMemo(
    () => assignBrandStatus(allRows, brandOf, 'trend', ['active', 'declining', 'churned']),
    [allRows, vendorBrand]
  )

  // Table rows = base list narrowed by the active filter (brand-level), then sorted.
  const rows = useMemo(() => {
    const list = filter === 'all' ? allRowsBranded : allRowsBranded.filter((c) => c.brandStatus === filter)
    const { key, dir } = sort
    const f = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (av instanceof Date && bv instanceof Date) return (av - bv) * f
      if (typeof av === 'string') return av.localeCompare(bv) * f
      return (av - bv) * f
    })
  }, [allRowsBranded, filter, sort])

  const toggle = (k) => setSort((s) => s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' })
  const arrow = (k) => sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const vendorF = useColFilter(rows, (r) => r.vendor)
  const shown = useMemo(() => rows.filter(vendorF.pass), [rows, vendorF])

  // Counts/totals are BRAND-level - each brand counted once by its brand status
  // (so they never change with the active filter). "No brand" stores count solo.
  const brandCounts = useMemo(() => {
    const ent = new Map()
    for (const r of allRowsBranded) {
      const b = brandOf(r.vendor) || 'No brand'
      const key = b === 'No brand' ? `nb:${r.vendor}` : b
      if (!ent.has(key)) ent.set(key, r.brandStatus)
    }
    const c = { churned: 0, declining: 0, active: 0, total: ent.size }
    for (const s of ent.values()) if (c[s] != null) c[s] += 1
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRowsBranded])
  const churnedValue = allRowsBranded.filter((r) => r.brandStatus === 'churned').reduce((s, r) => s + r.lifetime, 0)
  const decliningValue = allRowsBranded.filter((r) => r.brandStatus === 'declining').reduce((s, r) => s + r.lifetime, 0)
  const pager = usePager(shown.length, 50, `${filter}|${sort.key}|${sort.dir}|${vendorF.key}`)

  const cy = allRows[0]?.cy, py = allRows[0]?.py
  const exportRows = rows.map((r) => [
    r.vendor, r.trend, r.lastOrder ? r.lastOrder.toISOString().slice(0, 10) : '',
    r.daysSilent ?? '', r.cycle ?? '', r.totalOrders, r.lifetime.toFixed(2),
    r.pySales.toFixed(2), r.cySales.toFixed(2), r.pctChange.toFixed(1),
  ])

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label={`Churned ${unit}`} value={num(brandCounts.churned)} sub={`6+ months silent · ${compactMoney(churnedValue)} lifetime`} tone="bad" onClick={() => setFilter('churned')}
          info={{ title: `Churned ${unit}`, purpose: `${unitCap} that stopped ordering, none in over 6 months.`, detail: 'A customer is churned when its last order was more than 180 days ago (recency based, not a year-over-year comparison). Example: last order 210 days ago is churned; 40 days ago is not.', source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard label={`Declining ${unit}`} value={num(brandCounts.declining)} sub={`Overdue past normal cycle · ${compactMoney(decliningValue)} lifetime`} tone="warn" onClick={() => setFilter('declining')}
          info={{ title: `Declining ${unit}`, purpose: `${unitCap} drifting away, overdue by their own rhythm but not yet churned.`, detail: 'Declining when the gap since the last order is more than 2x the normal cycle (median gap between orders, needs at least 3 orders) but still within 180 days. Example: a 30-day cycle, last seen 75 days ago = declining.', source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard label={`Active ${unit}`} value={num(brandCounts.active)} sub="Ordering on cadence" tone="good" onClick={() => setFilter('active')}
          info={{ title: `Active ${unit}`, purpose: `${unitCap} still ordering at or near their normal rhythm.`, detail: 'Active when the last order is within 2x the normal cycle and inside 180 days. Example: a 30-day cycle, last seen 25 days ago = active.', source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard label={unitCap} value={num(brandCounts.total)} sub="With order history" tone="muted" onClick={() => setFilter('all')}
          info={{ title: `${unitCap} tracked`, purpose: `Total ${unit} covered by the health view.`, detail: `Count of distinct ${unit} that have any order history.`, source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
      </section>

      <div className="ar-tabs-row">
        <div className="ar-tabs">
          <button className={`ar-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>All</button>
          <button className={`ar-tab ${filter === 'churned' ? 'active' : ''}`} onClick={() => setFilter('churned')}>Churned ({num(brandCounts.churned)})</button>
          <button className={`ar-tab ${filter === 'declining' ? 'active' : ''}`} onClick={() => setFilter('declining')}>Declining ({num(brandCounts.declining)})</button>
          <button className={`ar-tab ${filter === 'active' ? 'active' : ''}`} onClick={() => setFilter('active')}>Active</button>
        </div>
      </div>

      <BrandRollup
        rows={shown}
        brandOf={brandOf}
        flat={noBrand}
        title="Brands · customer health"
        columns={[
          { label: 'Lifetime', agg: (rs) => { const s = rs.reduce((a, r) => a + r.lifetime, 0); return { display: money(s), sortVal: s } } },
          { label: 'Churned', agg: (rs) => { const n = rs.filter((r) => r.trend === 'churned').length; return { display: num(n), sortVal: n, cls: n > 0 ? 'cell-warn' : '' } } },
        ]}
      >
        {(brandRows) => (
          <div className="table-card">
            <InfoTip title="Customer health" purpose="One screen labelling each customer active, declining, or churned with revenue at stake." detail="Each customer is tagged by order recency: churned when the last order is over 180 days ago; declining when the gap is more than 2x their normal cycle (median gap, needs at least 3 orders) but under 180 days; otherwise active. Prior-year and this-year revenue plus days silent are shown for context, and stores roll up to brand (a brand is churned only when all its stores are). Example: last seen 220 days ago = churned; a 30-day cycle stretched to 80 days = declining." source="Finance sheet (Gelato AR sheet on Gelato pages)." />
            <div className="table-head"><h3>{num(brandRows.length)} customers · churn = 6 mo silent · declining = past 2× buy cycle</h3></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Status</th>
                    <th>Last order</th>
                    <th className="num">Days silent</th>
                    <th className="num">Cycle (days)</th>
                    <th className="num">Orders</th>
                    <th className="num">Lifetime</th>
                    <th className="num">YoY %</th>
                  </tr>
                </thead>
                <tbody>
                  {[...brandRows].sort((a, b) => b.lifetime - a.lifetime).map((r) => (
                    <tr key={r.vendor} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                      <td className="vendor-cell">{r.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                      <td><span className={`trend-pill trend-${r.trend}`}>{r.trend}</span></td>
                      <td className="muted">{r.lastOrder ? r.lastOrder.toLocaleDateString('en-CA') : ''}</td>
                      <td className={`num ${r.trend === 'churned' ? 'cell-warn' : ''}`}>{r.daysSilent ?? ''}</td>
                      <td className="num">{r.cycle != null ? r.cycle : <span className="muted">-</span>}</td>
                      <td className="num">{r.totalOrders}</td>
                      <td className="num">{money(r.lifetime)}</td>
                      <td className={`num ${r.pctChange < -20 ? 'cell-warn' : ''}`}>
                        {r.pySales > 0 ? `${r.pctChange >= 0 ? '+' : ''}${r.pctChange.toFixed(0)}%` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </BrandRollup>
    </>
  )
}

// ============ RECONCILIATION (cross-check tracker vs financials) ============
const RECONCILE_START_YEAR = 2023 // skip 2022 and older - too stale for cross-check

// ============ GEOGRAPHIC BREAKDOWN ============
export function GeographyTab({ ws }) {
  const { openInvoiceList } = useNav()
  const [view, setView] = useState('region') // region | city

  const data = useMemo(() => {
    const regionMap = new Map()
    const cityMap = new Map()

    ws.financials.forEach((r) => {
      const { city, region } = detectLocation(r.vendor)
      const ensureRegion = (key) => {
        if (!regionMap.has(key)) regionMap.set(key, { region: key, sales: 0, paid: 0, vendors: new Set(), invoices: 0 })
        return regionMap.get(key)
      }
      const ensureCity = (key, region) => {
        const id = `${region}|${key}`
        if (!cityMap.has(id)) cityMap.set(id, { city: key, region, sales: 0, paid: 0, vendors: new Set(), invoices: 0 })
        return cityMap.get(id)
      }
      const rg = ensureRegion(region)
      rg.sales += r.invoiceAmount
      rg.paid += r.invoicePaid
      rg.vendors.add(r.vendor)
      rg.invoices += 1
      const ct = ensureCity(city, region)
      ct.sales += r.invoiceAmount
      ct.paid += r.invoicePaid
      ct.vendors.add(r.vendor)
      ct.invoices += 1
    })

    // Add outstanding from invoices
    ws.invoices.filter((r) => r.isOutstanding).forEach((r) => {
      const { city, region } = detectLocation(r.vendor)
      const rg = regionMap.get(region)
      if (rg) rg.outstanding = (rg.outstanding || 0) + r.outstanding
      const ct = cityMap.get(`${region}|${city}`)
      if (ct) ct.outstanding = (ct.outstanding || 0) + r.outstanding
    })

    const regions = [...regionMap.values()].map((r) => ({ ...r, customerCount: r.vendors.size, outstanding: r.outstanding || 0 }))
      .sort((a, b) => b.sales - a.sales)
    const cities = [...cityMap.values()].map((c) => ({ ...c, customerCount: c.vendors.size, outstanding: c.outstanding || 0 }))
      .sort((a, b) => b.sales - a.sales)

    return { regions, cities }
  }, [ws])

  const showRegion = (region) => {
    const invoices = ws.invoices.filter((r) => detectLocation(r.vendor).region === region)
    openInvoiceList({
      title: `${region} Michigan`,
      subtitle: `${new Set(invoices.map((r) => r.vendor)).size} customers · ${invoices.length} invoices`,
      invoices,
    })
  }

  const showCity = (city, region) => {
    const invoices = ws.invoices.filter((r) => {
      const loc = detectLocation(r.vendor)
      return loc.city === city && loc.region === region
    })
    openInvoiceList({
      title: `${city}${region !== 'Other' ? `, ${region} Michigan` : ''}`,
      subtitle: `${new Set(invoices.map((r) => r.vendor)).size} customers · ${invoices.length} invoices`,
      invoices,
    })
  }

  const totalSales = data.regions.reduce((s, r) => s + r.sales, 0)
  const topRegion = data.regions[0]
  const topCity = data.cities[0]
  const unknown = data.regions.find((r) => r.region === 'Other')
  const unknownPct = totalSales > 0 && unknown ? (unknown.sales / totalSales) * 100 : 0

  // Region filter - only meaningful in the city view (each city has a region)
  const cityRegionF = useColFilter(data.cities, (r) => r.region)
  const tableRows = view === 'region' ? data.regions : data.cities.filter(cityRegionF.pass)

  const exportRows = tableRows.map((r) => (
    view === 'region'
      ? [r.region, r.customerCount, r.invoices, r.sales.toFixed(2), r.paid.toFixed(2), (r.outstanding || 0).toFixed(2)]
      : [r.city, r.region, r.customerCount, r.invoices, r.sales.toFixed(2), r.paid.toFixed(2), (r.outstanding || 0).toFixed(2)]
  ))

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Regions" value={num(data.regions.length)} sub={`${num(data.cities.length)} cities`}
          info={{ title: 'Regions', purpose: 'How many Michigan regions we sell into, with the city count beneath.', detail: 'Each customer is placed via a built-in Michigan city/region lookup applied to its name; this counts the distinct regions (including an Other bucket for unmatched) and the distinct cities found. Example: 7 regions across 41 cities.', source: 'Finance sheet (Gelato AR sheet on Gelato pages); Michigan lookup.' }} />
        <KpiCard label="Top region" value={topRegion?.region || ''} sub={topRegion ? `${compactMoney(topRegion.sales)} · ${((topRegion.sales/totalSales)*100).toFixed(0)}% of revenue` : ''} tone="good"
          onClick={topRegion ? () => showRegion(topRegion.region) : undefined}
          info={{ title: 'Top region', purpose: 'The region producing the most sales.', detail: 'Lifetime invoiced sales are summed per region (via the Michigan lookup); this is the highest region and its share of total sales. Example: Metro Detroit $1.2M, 28% of revenue.', source: 'Finance sheet (Gelato AR sheet on Gelato pages); Michigan lookup.' }} />
        <KpiCard label="Top city" value={topCity?.city || ''} sub={topCity ? `${compactMoney(topCity.sales)} · ${topCity.customerCount} customers` : ''}
          onClick={topCity ? () => showCity(topCity.city, topCity.region) : undefined}
          info={{ title: 'Top city', purpose: 'The city producing the most sales.', detail: 'Lifetime invoiced sales are summed per city (via the Michigan lookup); this is the highest city and its distinct customer count. Example: Detroit $0.6M, 22 customers.', source: 'Finance sheet (Gelato AR sheet on Gelato pages); Michigan lookup.' }} />
        <KpiCard label="Unmapped" value={`${unknownPct.toFixed(0)}%`} sub={unknown ? `${compactMoney(unknown.sales)} from cities not in lookup` : '0% - all mapped'} tone={unknownPct > 20 ? 'warn' : 'muted'}
          info={{ title: 'Unmapped', purpose: 'Share of sales that could not be placed on the map.', detail: 'Sales from customers whose city is not in the Michigan lookup fall into the Other region; this is that region\'s sales as a percent of total, flagged when above 20%. Example: 15% (~$120,000) unmapped.', source: 'Finance sheet (Gelato AR sheet on Gelato pages); Michigan lookup.' }} />
      </section>

      <div className="ar-tabs-row">
        <div className="ar-tabs">
          <button className={`ar-tab ${view === 'region' ? 'active' : ''}`} onClick={() => setView('region')}>By Region</button>
          <button className={`ar-tab ${view === 'city' ? 'active' : ''}`} onClick={() => setView('city')}>By City</button>
        </div>
      </div>

      <MichiganMap
        view={view}
        regions={data.regions.filter((r) => r.region !== 'Other')}
        cities={data.cities.filter((c) => c.city !== 'Unknown')}
        onCityClick={showCity}
        onRegionClick={showRegion}
      />

      <div className="chart-card">
        <InfoTip title="Sales by region" purpose="Shows where Michigan sales come from." detail="Every customer's invoiced sales are mapped to a city and region via the Michigan lookup, then summed; the map and bars show lifetime sales per region (sorted by revenue). Toggle region/city and click an area or bar to drill into its invoices. Example: clicking Grand Rapids shows that city's customers and invoices." source="Finance sheet (Gelato AR sheet on Gelato pages); Michigan lookup." />
        <div className="chart-head">
          <h3>Sales by region</h3>
          <span className="chart-sub">Lifetime · sorted by revenue</span>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data.regions} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="region" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}
              formatter={(v) => money(v)}
            />
            <Bar dataKey="sales" fill="#15803d" radius={[6, 6, 0, 0]} name="Sales" cursor="pointer" onClick={(p) => p?.region && showRegion(p.region)} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="table-card">
        <InfoTip title="Regions / cities table" purpose="Lists Michigan regions or cities with their sales, paid, and outstanding." detail="Customers are placed by the Michigan lookup; each row sums invoiced sales and paid amount from the finance sheet plus live open balance from the tracker, with distinct customer and invoice counts. Toggle region/city and click a row to drill into its invoices. Example: clicking the Grand Rapids row opens that city's customers and invoices." source="Finance sheet (Gelato AR sheet on Gelato pages) + Invoice Tracker (open balance); Michigan lookup." />
        <div className="table-head">
          <h3>{view === 'region' ? 'Regions' : 'Cities'} ({tableRows.length})</h3>
          <ExportButton
            filename={`geography-${view}-${new Date().toISOString().slice(0,10)}.csv`}
            headers={view === 'region'
              ? ['Region', 'Customers', 'Invoices', 'Sales', 'Paid', 'Outstanding']
              : ['City', 'Region', 'Customers', 'Invoices', 'Sales', 'Paid', 'Outstanding']
            }
            rows={exportRows}
          />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {view === 'region' ? <th>Region</th> : (<><th>City</th><th>
                  Region
                  <ColumnFilter label="Region" options={cityRegionF.options} excluded={cityRegionF.excluded} onChange={cityRegionF.setExcluded} />
                </th></>)}
                <th className="num">Customers</th>
                <th className="num">Invoices</th>
                <th className="num">Sales</th>
                <th className="num">Paid</th>
                <th className="num">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.slice(0, 80).map((r) => (
                <tr
                  key={view === 'region' ? r.region : `${r.region}|${r.city}`}
                  className="clickable-row"
                  onClick={() => view === 'region' ? showRegion(r.region) : showCity(r.city, r.region)}
                >
                  {view === 'region' ? (
                    <td className="vendor-cell">{r.region}</td>
                  ) : (
                    <><td className="vendor-cell">{r.city}</td><td className="muted">{r.region}</td></>
                  )}
                  <td className="num">{r.customerCount}</td>
                  <td className="num">{r.invoices}</td>
                  <td className="num">{money(r.sales)}</td>
                  <td className="num">{money(r.paid)}</td>
                  <td className={`num ${r.outstanding > 0 ? 'cell-warn' : ''}`}>{r.outstanding > 0 ? money(r.outstanding) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ============ ALL CUSTOMERS (flat sortable view) ============
export function AllCustomersTab({ ws }) {
  const { openCustomer, openInvoiceList } = useNav()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: 'invoicedCY', dir: 'desc' })

  const rows = useMemo(() => {
    const now = new Date()
    const cy = now.getFullYear()
    const map = new Map()

    ws.financials.forEach((r) => {
      const cur = map.get(r.vendor) || {
        vendor: r.vendor, invoicedCY: 0, paidCY: 0, invoicedLifetime: 0,
        paidLifetime: 0, invoiceCount: 0, lastInvoice: null,
      }
      if (r.date) {
        if (r.date.getFullYear() === cy) {
          cur.invoicedCY += r.invoiceAmount
          cur.paidCY += r.invoicePaid
        }
        if (!cur.lastInvoice || r.date > cur.lastInvoice) cur.lastInvoice = r.date
      }
      cur.invoicedLifetime += r.invoiceAmount
      cur.paidLifetime += r.invoicePaid
      cur.invoiceCount += 1
      map.set(r.vendor, cur)
    })

    // Outstanding = Invoiced − Paid (the two columns shown in this row).
    let list = [...map.values()].map((c) => ({
      ...c,
      outstanding: Math.max(0, c.invoicedCY - c.paidCY),
      collectionPct: c.invoicedCY > 0 ? (c.paidCY / c.invoicedCY) * 100 : null,
    }))


    const needle = q.trim().toLowerCase()
    if (needle) list = list.filter((c) => c.vendor.toLowerCase().includes(needle))

    const { key, dir } = sort
    const f = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (av instanceof Date && bv instanceof Date) return (av - bv) * f
      if (typeof av === 'string') return av.localeCompare(bv) * f
      return (av - bv) * f
    })
    return list
  }, [ws, q, sort])

  const vendorF = useColFilter(rows, (r) => r.vendor)
  const shown = useMemo(() => rows.filter(vendorF.pass), [rows, vendorF])

  const toggle = (k) => setSort((s) => s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' })
  const arrow = (k) => sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const pager = usePager(shown.length, 50, `${q}|${sort.key}|${sort.dir}|${vendorF.key}`)

  const cy = new Date().getFullYear()
  const exportRows = rows.map((r) => [
    r.vendor, r.invoicedCY.toFixed(2), r.paidCY.toFixed(2),
    r.outstanding.toFixed(2), r.invoiceCount,
    r.collectionPct != null ? r.collectionPct.toFixed(1) : '',
    r.lastInvoice ? r.lastInvoice.toISOString().slice(0, 10) : '',
    r.invoicedLifetime.toFixed(2),
  ])

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Total customers" value={num(rows.length)} sub="With any sales activity"
          info={{ title: 'Total customers', purpose: 'How many distinct customers have any sales history.', detail: 'Count of unique customer names that appear on at least one invoice. Example: 214 customers.', source: 'Finance sheet (Gelato AR sheet on the Gelato page).' }}
          onClick={() => openInvoiceList({ hideOutstanding: true, title: 'All customers · invoices', subtitle: `${num(rows.length)} customers`, invoices: ws.financials })} />
        <KpiCard label={`Invoiced ${cy}`} value={compactMoney(rows.reduce((s, r) => s + r.invoicedCY, 0))} sub="YTD"
          info={{ title: `Invoiced ${cy}`, purpose: 'Total invoiced to all customers so far this calendar year.', detail: 'Sum of the invoiced amount on every invoice dated in the current year, to date. Example: $760,000 invoiced this year.', source: 'Finance sheet (Gelato AR sheet on the Gelato page).' }}
          onClick={() => { const invs = ws.financials.filter((r) => r.date && r.date.getFullYear() === cy); openInvoiceList({ hideOutstanding: true, title: `Invoiced ${cy}`, subtitle: `${num(invs.length)} invoices`, invoices: invs }) }} />
        <KpiCard label="Outstanding" value={compactMoney(ws.invoices.filter((r) => r.isOutstanding).reduce((s, r) => s + r.outstanding, 0))} sub="Across all customers · live AR" tone="warn"
          info={{ title: 'Outstanding', purpose: 'Total live open balance across all customers right now.', detail: 'Sum of outstanding (invoiced minus paid) on every open invoice in the book - the live AR figure. Example: about $685,000 open across all customers.', source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).' }}
          onClick={() => { const invs = ws.invoices.filter((r) => r.isOutstanding); openInvoiceList({ title: 'Outstanding invoices', subtitle: `${num(invs.length)} open`, invoices: invs }) }} />
        <KpiCard label="Avg collection" value={(() => {
          const inv = rows.reduce((s, r) => s + r.invoicedCY, 0)
          const paid = rows.reduce((s, r) => s + r.paidCY, 0)
          return inv > 0 ? `${((paid / inv) * 100).toFixed(1)}%` : '-'
        })()} sub="Paid ÷ invoiced · this year" tone="good"
          onClick={() => openInvoiceList({ hideOutstanding: true, title: 'Collection detail', subtitle: 'All customer invoices', invoices: ws.financials })} />
      </section>

      <div className="table-card">
        <InfoTip
          title="All customers"
          purpose="The full customer book in one filterable list: who they are, when they last ordered, and any balance."
          detail="One row per customer with this year's invoiced and paid, current outstanding (invoiced minus paid), invoice count, collection %, and last-invoice date; searchable and sortable on any column. Example: Customer X, invoiced $40,000 this year, $4,000 outstanding, last invoice 18 days ago."
          source="Finance sheet (sales & recency) + Invoice Tracker (open balance). Gelato AR sheet on the Gelato page."
        />
        <div className="table-head">
          <h3>{num(rows.length)} customers</h3>
          <div className="table-head-tools">
            <input
              type="search"
              className="table-search"
              placeholder="Search customer…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <ExportButton
              filename={`all-customers-${new Date().toISOString().slice(0,10)}.csv`}
              headers={['Customer', `Invoiced ${cy}`, `Paid ${cy}`, 'Outstanding', 'Invoices', 'Collection %', 'Last invoice', 'Lifetime']}
              rows={exportRows}
            />
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer
                  <ColumnFilter label="Customer" options={vendorF.options} excluded={vendorF.excluded} onChange={vendorF.setExcluded} />
                </th>
                <th className="num" onClick={() => toggle('invoicedCY')}>Invoiced ({cy}){arrow('invoicedCY')}</th>
                <th className="num" onClick={() => toggle('paidCY')}>Paid{arrow('paidCY')}</th>
                <th className="num" onClick={() => toggle('outstanding')}>Outstanding{arrow('outstanding')}</th>
                <th className="num" onClick={() => toggle('invoiceCount')}>Invoices{arrow('invoiceCount')}</th>
                <th className="num" onClick={() => toggle('collectionPct')}>Collection %{arrow('collectionPct')}</th>
                <th className="num" onClick={() => toggle('lastInvoice')}>Last invoice{arrow('lastInvoice')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan="7" className="table-empty">No customers match.</td></tr>}
              {shown.slice(pager.start, pager.end).map((r) => (

                <tr key={r.vendor} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                  <td className="vendor-cell">{r.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                  <td className="num">{money(r.invoicedCY)}</td>
                  <td className="num muted">{r.paidCY > 0 ? money(r.paidCY) : ''}</td>
                  <td className={`num ${r.outstanding > 0 ? 'cell-warn' : ''}`}>{r.outstanding > 0 ? money(r.outstanding) : ''}</td>
                  <td className="num">{r.invoiceCount}</td>
                  <td className={`num collect-pct ${pctClass(r.collectionPct)}`}>
                    {r.collectionPct != null ? `${r.collectionPct.toFixed(1)}%` : ''}
                  </td>
                  <td className="muted">{r.lastInvoice ? r.lastInvoice.toLocaleDateString('en-CA') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager {...pager} total={shown.length} />

      </div>
    </>
  )
}

function pctClass(p) {
  if (p == null) return ''
  if (p >= 95) return 'pct-good'
  if (p >= 70) return 'pct-ok'
  if (p >= 30) return 'pct-warn'
  return 'pct-bad'
}

// ============ REORDER CADENCE ============
export function CadenceTab({ ws, noBrand = false }) {
  const { openCustomer } = useNav()
  const [filter, setFilter] = useState('atRisk')

  const rows = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const byVendor = new Map()
    ws.financials.forEach((r) => {
      if (!r.date || !r.vendor) return
      const arr = byVendor.get(r.vendor) || { dates: [], lifetime: 0 }
      arr.dates.push(r.date)
      arr.lifetime += r.invoiceAmount
      byVendor.set(r.vendor, arr)
    })

    return [...byVendor.entries()].map(([vendor, { dates, lifetime }]) => {
      dates.sort((a, b) => a - b)
      const gaps = []
      for (let i = 1; i < dates.length; i++) {
        gaps.push((dates[i] - dates[i-1]) / 86400000)
      }
      let median = null
      if (gaps.length > 0) {
        const sorted = [...gaps].sort((a, b) => a - b)
        median = sorted[Math.floor(sorted.length / 2)]
      }
      const lastOrder = dates[dates.length - 1]
      const daysSinceOrder = Math.floor((today - lastOrder) / 86400000)
      const ratio = median != null && median > 0 ? daysSinceOrder / median : null

      let status = 'one-time'
      if (dates.length >= 2) {
        if (ratio == null) status = 'on-schedule'
        else if (ratio > 5) status = 'lost'
        else if (ratio > 2.5) status = 'at-risk'
        else if (ratio > 1.5) status = 'slowing'
        else status = 'on-schedule'
      }

      return {
        vendor, orderCount: dates.length, median, lastOrder,
        daysSinceOrder, ratio, status, lifetime,
      }
    }).filter((c) => c.lifetime > 500) // ignore noise
      .sort((a, b) => (b.ratio || 0) - (a.ratio || 0))
  }, [ws.financials])

  const vendorBrand = useMemo(() => buildVendorBrandMap(ws.invoices), [ws.invoices])
  // Gelato has no brand concept - each customer is its own unit.
  const brandOf = noBrand ? ((v) => v) : ((v) => vendorBrand.get(v) || 'No brand')
  // Classify each brand by its most-active store: one on-schedule store makes the
  // whole brand on-schedule; a brand is at-risk/lost only if ALL its stores are.
  const rowsBranded = useMemo(
    () => assignBrandStatus(rows, brandOf, 'status', ['on-schedule', 'slowing', 'at-risk', 'lost', 'one-time']),
    [rows, vendorBrand]
  )

  const filtered = useMemo(() => {
    if (filter === 'all') return rowsBranded
    if (filter === 'atRisk') return rowsBranded.filter((r) => r.brandStatus === 'at-risk' || r.brandStatus === 'lost')
    return rowsBranded.filter((r) => r.brandStatus === filter)
  }, [rowsBranded, filter])
  const pager = usePager(filtered.length, 50, filter)

  // Brand-level counts - each brand counted once by its brand status.
  const counts = useMemo(() => {
    const ent = new Map()
    for (const r of rowsBranded) {
      const b = brandOf(r.vendor) || 'No brand'
      const key = b === 'No brand' ? `nb:${r.vendor}` : b
      if (!ent.has(key)) ent.set(key, r.brandStatus)
    }
    const c = { all: ent.size, 'on-schedule': 0, 'slowing': 0, 'at-risk': 0, 'lost': 0, 'one-time': 0 }
    for (const s of ent.values()) if (c[s] != null) c[s] += 1
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsBranded])

  const atRiskValue = rowsBranded
    .filter((r) => r.brandStatus === 'at-risk' || r.brandStatus === 'lost')
    .reduce((s, r) => s + r.lifetime, 0)

  const avgCadence = (() => {
    const valid = rows.filter((r) => r.median != null)
    if (!valid.length) return 0
    return valid.reduce((s, r) => s + r.median, 0) / valid.length
  })()

  const exportRows = filtered.map((r) => [
    r.vendor, r.orderCount,
    r.median != null ? r.median.toFixed(0) : '',
    r.lastOrder ? r.lastOrder.toISOString().slice(0,10) : '',
    r.daysSinceOrder, r.ratio != null ? r.ratio.toFixed(2) : '',
    r.status, r.lifetime.toFixed(2),
  ])

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="At-risk + lost" value={num(counts['at-risk'] + counts['lost'])} sub={`${compactMoney(atRiskValue)} lifetime value`} tone="bad" onClick={() => setFilter('atRisk')}
          info={{ title: 'At-risk + lost', purpose: 'Customers well beyond their normal ordering rhythm.', detail: 'Each customer\'s median gap between past orders is their cycle; the risk ratio = days since last order / cycle. At risk = ratio above 2.5, lost = above 5; this counts both, rolled up to brand, with their lifetime value. Example: a 30-day cycle, last seen 100 days ago = ratio 3.3, at risk.', source: 'Finance sheet (Gelato AR sheet on Gelato pages, order history) + Invoice Tracker (open balance).' }} />
        <KpiCard label="Slowing down" value={num(counts['slowing'])} sub="Cadence drifting" tone="warn" onClick={() => setFilter('slowing')}
          info={{ title: 'Slowing down', purpose: 'Customers ordering less often than before, but not yet at risk.', detail: 'Risk ratio (days since last order / median cycle) between 1.5 and 2.5. Example: a 30-day cycle, last seen 60 days ago = ratio 2.0.', source: 'Finance sheet (Gelato AR sheet on Gelato pages, order history).' }} />
        <KpiCard label="On schedule" value={num(counts['on-schedule'])} sub="Buying regularly" tone="good" onClick={() => setFilter('on-schedule')}
          info={{ title: 'On schedule', purpose: 'Customers still ordering at their normal rhythm.', detail: 'Risk ratio (days since last order / median cycle) at or below 1.5. Example: a 30-day cycle, last seen 25 days ago = ratio 0.8.', source: 'Finance sheet (Gelato AR sheet on Gelato pages, order history).' }} />
        <KpiCard label="Avg reorder cycle" value={`${avgCadence.toFixed(0)}d`} sub="Across all customers" tone="muted" onClick={() => setFilter('all')}
          info={{ title: 'Avg reorder cycle', purpose: 'Typical days between orders across the customer base.', detail: 'For each customer, the median gap between consecutive orders is their cycle; this averages those medians across all customers that have one. Example: medians 28/35/42 average to 35 days.', source: 'Finance sheet (Gelato AR sheet on Gelato pages, order history).' }} />
      </section>

      <div className="ar-tabs-row">
        <div className="ar-tabs">
          <button className={`ar-tab ${filter === 'atRisk' ? 'active' : ''}`} onClick={() => setFilter('atRisk')}>
            At risk <span className="tab-count">{counts['at-risk'] + counts['lost']}</span>
          </button>
          <button className={`ar-tab ${filter === 'slowing' ? 'active' : ''}`} onClick={() => setFilter('slowing')}>
            Slowing <span className="tab-count">{counts['slowing']}</span>
          </button>
          <button className={`ar-tab ${filter === 'on-schedule' ? 'active' : ''}`} onClick={() => setFilter('on-schedule')}>
            On schedule <span className="tab-count">{counts['on-schedule']}</span>
          </button>
          <button className={`ar-tab ${filter === 'one-time' ? 'active' : ''}`} onClick={() => setFilter('one-time')}>
            One-time <span className="tab-count">{counts['one-time']}</span>
          </button>
          <button className={`ar-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            All <span className="tab-count">{counts.all}</span>
          </button>
        </div>
      </div>

      <BrandRollup
        rows={filtered}
        brandOf={brandOf}
        flat={noBrand}
        title={`Brands · ${num(filtered.length)} customers in this filter`}
        columns={[
          { label: 'At-risk + lost', agg: (rs) => { const n = rs.filter((r) => r.status === 'at-risk' || r.status === 'lost').length; return { display: num(n), sortVal: n, cls: n > 0 ? 'cell-warn' : '' } } },
          { label: 'Lifetime value', agg: (rs) => { const s = rs.reduce((a, r) => a + r.lifetime, 0); return { display: compactMoney(s), sortVal: s } } },
        ]}
      >
        {(brandRows) => (
          <div className="table-card">
            <InfoTip title="Reorder cadence" purpose="Ranks customers by how overdue their next order is." detail="Each customer's normal cycle (median gap between past orders) is compared with their current gap (days since last order); the risk ratio = current gap / cycle, and rows sort by that ratio. Status is on schedule (ratio at or below 1.5), slowing (1.5-2.5), at risk (2.5-5), or lost (above 5). Example: a 30-day cycle, last order 150 days ago = ratio 5.0, tagged lost." source="Finance sheet (Gelato AR sheet on Gelato pages, order history) + Invoice Tracker (open balance)." />
            <div className="table-head"><h3>{num(brandRows.length)} customers · sorted by risk ratio</h3></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="num"># Orders</th>
                    <th className="num">Typical cycle</th>
                    <th>Last order</th>
                    <th className="num">Days since</th>
                    <th className="num">Ratio</th>
                    <th>Status</th>
                    <th className="num">Lifetime value</th>
                  </tr>
                </thead>
                <tbody>
                  {[...brandRows].sort((a, b) => (b.ratio || 0) - (a.ratio || 0)).map((r) => (
                    <tr key={r.vendor} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                      <td className="vendor-cell">{r.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                      <td className="num">{r.orderCount}</td>
                      <td className="num">{r.median != null ? `${r.median.toFixed(0)}d` : ''}</td>
                      <td className="muted">{r.lastOrder ? r.lastOrder.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : ''}</td>
                      <td className={`num ${r.daysSinceOrder > 60 ? 'cell-warn' : ''}`}>{r.daysSinceOrder}</td>
                      <td className={`num ${r.ratio > 2 ? 'cell-warn' : ''}`}>{r.ratio != null ? `${r.ratio.toFixed(1)}×` : ''}</td>
                      <td><span className={`cadence-pill cadence-${r.status}`}>{r.status}</span></td>
                      <td className="num">{compactMoney(r.lifetime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </BrandRollup>
    </>
  )
}

export function ReconcileTab({ data }) {
  const [filter, setFilter] = useState('all')

  const issues = useMemo(() => {
    const normInv = (s) => String(s || '').trim().toLowerCase().replace(/\s/g, '')
    const inWindow = (r) => !r.date || r.date.getFullYear() >= RECONCILE_START_YEAR

    // Index both sources by invoice # (filtered to 2023+)
    const trackerMap = new Map()
    data.invoices.forEach((r) => {
      if (!inWindow(r)) return
      const key = normInv(r.invNo)
      if (key) trackerMap.set(key, r)
    })
    const finMap = new Map()
    data.financials.forEach((r) => {
      if (!inWindow(r)) return
      const key = normInv(r.invNo)
      if (key) finMap.set(key, r)
    })

    const list = []
    const seen = new Set()

    // Walk tracker
    trackerMap.forEach((t, key) => {
      seen.add(key)
      const f = finMap.get(key)
      if (!f) {
        // In tracker but not in financials
        if (t.invoiceAmount > 0) {
          list.push({
            type: 'missing-in-fin',
            severity: t.invoiceAmount > 1000 ? 'high' : 'low',
            invNo: t.invNo, vendor: t.vendor,
            trackerAmt: t.invoiceAmount, trackerPaid: t.invoicePaid, trackerStatus: t.status,
            finAmt: null, finPaid: null,
            note: 'In invoice tracker only - not in financials',
          })
        }
        return
      }
      const ampDiff = Math.abs(t.invoiceAmount - f.invoiceAmount)
      const paidDiff = Math.abs(t.invoicePaid - f.invoicePaid)
      const trackerOpen = t.isOutstanding
      const finOpen = (f.invoiceAmount - f.invoicePaid) > 1

      // Underpaid check - status marked Paid but paidAmt < invoiceAmt (>$5 tolerance for rounding)
      const TOL = 5
      const trackerUnderpaid = t.isPaid && (t.invoiceAmount - t.invoicePaid) > TOL
      const finUnderpaid = f.invoiceAmount > 0 && (f.invoiceAmount - f.invoicePaid) > TOL && t.isPaid

      if (trackerUnderpaid || finUnderpaid) {
        const gap = Math.max(
          t.invoiceAmount - t.invoicePaid,
          f.invoiceAmount - f.invoicePaid,
        )
        list.push({
          type: 'underpaid',
          severity: gap > 500 ? 'high' : gap > 50 ? 'medium' : 'low',
          invNo: t.invNo, vendor: t.vendor,
          trackerAmt: t.invoiceAmount, trackerPaid: t.invoicePaid, trackerStatus: t.status,
          finAmt: f.invoiceAmount, finPaid: f.invoicePaid,
          note: `Marked Paid but short by ${gap.toFixed(2)}`,
        })
      } else if (ampDiff > 1) {
        list.push({
          type: 'amount-mismatch',
          severity: ampDiff > 100 ? 'high' : 'medium',
          invNo: t.invNo, vendor: t.vendor,
          trackerAmt: t.invoiceAmount, trackerPaid: t.invoicePaid, trackerStatus: t.status,
          finAmt: f.invoiceAmount, finPaid: f.invoicePaid,
          note: `Amount differs by ${ampDiff.toFixed(2)}`,
        })
      } else if (paidDiff > 1) {
        list.push({
          type: 'paid-mismatch',
          severity: paidDiff > 100 ? 'high' : 'medium',
          invNo: t.invNo, vendor: t.vendor,
          trackerAmt: t.invoiceAmount, trackerPaid: t.invoicePaid, trackerStatus: t.status,
          finAmt: f.invoiceAmount, finPaid: f.invoicePaid,
          note: `Paid amount differs by ${paidDiff.toFixed(2)}`,
        })
      } else if (trackerOpen && !finOpen) {
        list.push({
          type: 'status-stale-tracker',
          severity: 'medium',
          invNo: t.invNo, vendor: t.vendor,
          trackerAmt: t.invoiceAmount, trackerPaid: t.invoicePaid, trackerStatus: t.status,
          finAmt: f.invoiceAmount, finPaid: f.invoicePaid,
          note: 'Tracker shows open but financials shows paid - update tracker status',
        })
      } else if (!trackerOpen && finOpen && !t.isWriteOff) {
        list.push({
          type: 'status-stale-fin',
          severity: 'medium',
          invNo: t.invNo, vendor: t.vendor,
          trackerAmt: t.invoiceAmount, trackerPaid: t.invoicePaid, trackerStatus: t.status,
          finAmt: f.invoiceAmount, finPaid: f.invoicePaid,
          note: 'Tracker shows closed but financials shows balance - update financials',
        })
      }
    })

    // Walk financials, find ones not in tracker
    finMap.forEach((f, key) => {
      if (seen.has(key)) return
      if (f.invoiceAmount <= 0) return
      list.push({
        type: 'missing-in-tracker',
        severity: f.invoiceAmount > 1000 ? 'high' : 'low',
        invNo: f.invNo, vendor: f.vendor,
        trackerAmt: null, trackerPaid: null, trackerStatus: '',
        finAmt: f.invoiceAmount, finPaid: f.invoicePaid,
        note: 'In financials only - not in invoice tracker',
      })
    })

    return list
  }, [data])

  const filtered = filter === 'all' ? issues : issues.filter((i) => i.type === filter)

  // Sort: high severity first, then biggest amount
  const sorted = [...filtered].sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 }
    const s = (sev[a.severity] || 9) - (sev[b.severity] || 9)
    if (s !== 0) return s
    return (b.trackerAmt || b.finAmt || 0) - (a.trackerAmt || a.finAmt || 0)
  })

  const sevF = useColFilter(sorted, (i) => i.severity)
  const shown = useMemo(() => sorted.filter(sevF.pass), [sorted, sevF])
  const pager = usePager(shown.length, 50, `${filter}|${sevF.key}`)

  const counts = {
    all: issues.length,
    'underpaid': issues.filter((i) => i.type === 'underpaid').length,
    'missing-in-fin': issues.filter((i) => i.type === 'missing-in-fin').length,
    'missing-in-tracker': issues.filter((i) => i.type === 'missing-in-tracker').length,
    'amount-mismatch': issues.filter((i) => i.type === 'amount-mismatch').length,
    'paid-mismatch': issues.filter((i) => i.type === 'paid-mismatch').length,
    'status-stale-tracker': issues.filter((i) => i.type === 'status-stale-tracker').length,
    'status-stale-fin': issues.filter((i) => i.type === 'status-stale-fin').length,
  }

  const exportRows = shown.map((i) => [
    i.invNo, i.vendor, i.type, i.severity,
    i.trackerAmt ?? '', i.trackerPaid ?? '', i.trackerStatus,
    i.finAmt ?? '', i.finPaid ?? '', i.note,
  ])

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Total issues" value={num(issues.length)} sub="Across both sheets" tone={issues.length > 0 ? 'warn' : 'good'}
          info={{ title: 'Total issues', purpose: 'Total invoices that do not match between the two sheets.', detail: 'Count of all reconciliation issues found by matching the Invoice Tracker against the finance sheet by invoice number, limited to 2023 and later. Includes missing entries, amount/paid mismatches, underpaid, and stale status. Example: 84 issues.', source: 'Invoice Tracker vs Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard label="High severity" value={num(issues.filter((i) => i.severity === 'high').length)} sub="Action needed" tone="bad"
          info={{ title: 'High severity', purpose: 'Mismatches large enough to act on first.', detail: 'Issues flagged high by type and dollar gap: a missing invoice over $1,000, an underpaid gap over $500, or an amount/paid difference over $100. Example: 12 high-severity issues.', source: 'Invoice Tracker vs Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard label="Missing entries" value={num(counts['missing-in-fin'] + counts['missing-in-tracker'])} sub="In one sheet not other" tone="warn"
          info={{ title: 'Missing entries', purpose: 'Invoices present in one sheet but not the other.', detail: 'Count of invoices in the tracker but missing from the finance sheet, plus those in the finance sheet but missing from the tracker (only counting amounts above zero). Example: 30 invoices in one sheet only.', source: 'Invoice Tracker vs Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard label="Status mismatches" value={num(counts['status-stale-tracker'] + counts['status-stale-fin'])} sub="Update needed" tone="muted"
          info={{ title: 'Status mismatches', purpose: 'Invoices whose open/paid status disagrees between sheets.', detail: 'Counts where the tracker shows open but finance shows paid, or the tracker shows closed but finance still shows a balance (write-offs excluded). Example: 18 invoices need a status fix.', source: 'Invoice Tracker vs Finance sheet (Gelato AR sheet on Gelato pages).' }} />
      </section>

      <div className="ar-tabs-row">
        <div className="ar-tabs">
          <button className={`ar-tab ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>All <span className="tab-count">{counts.all}</span></button>
          <button className={`ar-tab ${filter === 'underpaid' ? 'active' : ''}`} onClick={() => setFilter('underpaid')}>Underpaid <span className="tab-count">{counts['underpaid']}</span></button>
          <button className={`ar-tab ${filter === 'missing-in-fin' ? 'active' : ''}`} onClick={() => setFilter('missing-in-fin')}>Missing in financials <span className="tab-count">{counts['missing-in-fin']}</span></button>
          <button className={`ar-tab ${filter === 'missing-in-tracker' ? 'active' : ''}`} onClick={() => setFilter('missing-in-tracker')}>Missing in tracker <span className="tab-count">{counts['missing-in-tracker']}</span></button>
          <button className={`ar-tab ${filter === 'amount-mismatch' ? 'active' : ''}`} onClick={() => setFilter('amount-mismatch')}>Amount mismatch <span className="tab-count">{counts['amount-mismatch']}</span></button>
          <button className={`ar-tab ${filter === 'paid-mismatch' ? 'active' : ''}`} onClick={() => setFilter('paid-mismatch')}>Paid mismatch <span className="tab-count">{counts['paid-mismatch']}</span></button>
          <button className={`ar-tab ${filter === 'status-stale-tracker' ? 'active' : ''}`} onClick={() => setFilter('status-stale-tracker')}>Tracker stale <span className="tab-count">{counts['status-stale-tracker']}</span></button>
        </div>
      </div>

      <div className="table-card">
        <InfoTip title="Reconciliation detail" purpose="Lists every mismatch so you can clear them one by one." detail="Each issue shows its type (missing in one sheet, underpaid, amount mismatch, paid mismatch, or stale status), a severity, and the tracker vs finance figures side by side, sorted high severity first then biggest amount. Tolerances: amounts/paid must differ by more than $1, and a Paid invoice counts as underpaid only when short by more than $5. Example: invoice 1198 marked Paid but short by $240, tagged medium (a gap over $500 would be high)." source="Invoice Tracker vs Finance sheet (Gelato AR sheet on Gelato pages)." />
        <div className="table-head">
          <h3>{num(shown.length)} reconciliation issues</h3>
          <ExportButton
            filename={`reconciliation-${new Date().toISOString().slice(0,10)}.csv`}
            headers={['Invoice #', 'Vendor', 'Type', 'Severity', 'Tracker amt', 'Tracker paid', 'Tracker status', 'Fin amt', 'Fin paid', 'Note']}
            rows={exportRows}
          />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Inv #</th>
                <th>Vendor</th>
                <th>
                  Severity
                  <ColumnFilter label="Severity" options={sevF.options} excluded={sevF.excluded} onChange={sevF.setExcluded} />
                </th>
                <th className="num">Tracker amt</th>
                <th className="num">Tracker paid</th>
                <th className="num">Fin amt</th>
                <th className="num">Fin paid</th>
                <th>Issue</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan="8" className="table-empty">No issues - both sheets in sync 🎉</td></tr>}
              {shown.slice(pager.start, pager.end).map((i, idx) => (
                <tr key={`${i.invNo}-${idx}`}>
                  <td className="mono">{i.invNo}</td>
                  <td className="vendor-cell">{i.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                  <td><span className={`sev-pill sev-${i.severity}`}>{i.severity}</span></td>
                  <td className="num">{i.trackerAmt != null ? money(i.trackerAmt, true) : <span className="muted">-</span>}</td>
                  <td className="num">{i.trackerPaid != null ? money(i.trackerPaid, true) : ''}</td>
                  <td className="num">{i.finAmt != null ? money(i.finAmt, true) : <span className="muted">-</span>}</td>
                  <td className="num">{i.finPaid != null ? money(i.finPaid, true) : ''}</td>
                  <td className="muted">{i.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager {...pager} total={shown.length} />
      </div>
    </>
  )
}

// ============ BRAND MIX TREND ============
export function BrandMixTab({ ws }) {
  const { openInvoiceList } = useNav()
  const showBrand = (brand, month, comparison) => {
    const invs = ws.invoices.filter((r) => r.brand === brand && (!month || monthKey(r.date) === month))
    if (!invs.length) return
    openInvoiceList({ hideOutstanding: true, title: month ? `${brand} · ${monthLabel(month)}` : `${brand} · all sales`, subtitle: `${invs.length} invoices`, invoices: invs, comparison })
  }
  const { data: monthData, brands } = useMemo(() => {
    const byMonth = new Map()
    const brandSet = new Set()
    ws.invoices.forEach((r) => {
      if (!r.date || !r.brand) return
      const brand = r.brand
      brandSet.add(brand)
      const k = monthKey(r.date)
      if (!k) return
      const cur = byMonth.get(k) || { key: k }
      cur[brand] = (cur[brand] || 0) + r.invoiceAmount
      byMonth.set(k, cur)
    })
    return {
      data: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-18).map(([k, v]) => v),
      brands: [...brandSet].sort(),
    }
  }, [ws.invoices])

  // Brand totals + latest month share
  const totals = useMemo(() => {
    const map = new Map()
    ws.invoices.forEach((r) => {
      if (!r.brand) return
      map.set(r.brand, (map.get(r.brand) || 0) + r.invoiceAmount)
    })
    const arr = [...map.entries()].map(([brand, total]) => ({ brand, total })).sort((a, b) => b.total - a.total)
    const grand = arr.reduce((s, x) => s + x.total, 0)
    return arr.map((x) => ({ ...x, pct: grand > 0 ? (x.total / grand) * 100 : 0 }))
  }, [ws.invoices])

  const top6 = totals.slice(0, 6).map((b) => b.brand)
  const palette = ['#15803d', '#0891b2', '#65a30d', '#d97706', '#dc2626', '#7c3aed']

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Brands tracked" value={num(totals.length)} sub="With invoice activity"
          onClick={() => { const invs = ws.invoices.filter((r) => r.brand); openInvoiceList({ hideOutstanding: true, title: 'All brands', subtitle: `${num(totals.length)} brands · ${invs.length} invoices`, invoices: invs }) }}
          info={{ title: 'Brands tracked', purpose: 'How many brands make up revenue.', detail: 'Count of distinct brands with any invoice (sales) activity in the tracker. Example: 5 brands.', source: 'Invoice Tracker.' }} />
        <KpiCard label="Top brand" value={totals[0]?.brand || ''} sub={totals[0] ? `${totals[0].pct.toFixed(1)}% of sales` : ''}
          onClick={totals[0] ? () => showBrand(totals[0].brand) : undefined}
          info={{ title: 'Top brand', purpose: 'The single best-selling brand.', detail: 'Brands are ranked by total invoiced sales; this is the highest one and its share of all brand sales. Example: Gelato leads with 43% of sales.', source: 'Invoice Tracker.' }} />
        <KpiCard label="Top 3 share" value={`${totals.slice(0, 3).reduce((s, x) => s + x.pct, 0).toFixed(0)}%`} sub="Of total revenue" tone={totals.slice(0, 3).reduce((s, x) => s + x.pct, 0) > 70 ? 'warn' : 'good'}
          info={{ title: 'Top 3 share', purpose: 'How concentrated revenue is in the 3 biggest brands.', detail: 'Combined sales of the top 3 brands divided by total brand sales, flagged when above 70%. Example: $3.4M of $4.2M = 81%.', source: 'Invoice Tracker.' }}
          onClick={totals.length ? () => { const set = new Set(totals.slice(0, 3).map((b) => b.brand)); const invs = ws.invoices.filter((r) => set.has(r.brand)); openInvoiceList({ hideOutstanding: true, title: 'Top 3 brands', subtitle: `${[...set].join(', ')} · ${invs.length} invoices`, invoices: invs }) } : undefined} />
        <KpiCard label="Top 3 lifetime" value={compactMoney(totals.slice(0, 3).reduce((s, x) => s + x.total, 0))} sub="Combined"
          onClick={totals.length ? () => { const set = new Set(totals.slice(0, 3).map((b) => b.brand)); const invs = ws.invoices.filter((r) => set.has(r.brand)); openInvoiceList({ hideOutstanding: true, title: 'Top 3 brands · lifetime', subtitle: `${compactMoney(totals.slice(0, 3).reduce((s, x) => s + x.total, 0))} · ${invs.length} invoices`, invoices: invs }) } : undefined}
          info={{ title: 'Top 3 lifetime', purpose: 'Combined sales value of the 3 leading brands.', detail: 'Sum of total invoiced sales for the top 3 brands by lifetime sales. Example: $1.8M + $0.9M + $0.7M = $3.4M.', source: 'Invoice Tracker.' }} />
      </section>

      <div className="chart-card">
        <InfoTip title="Top brands monthly sales (last 18 months)" purpose="Shows how the leading brands trended month to month." detail="Invoiced sales are grouped by month for the last 18 months, with the top 6 brands (by lifetime sales) drawn as stacked bars, one segment per brand; click a segment to drill into that brand and month. Example: Gelato climbing while FunkdUp flattens." source="Invoice Tracker." />
        <div className="chart-head">
          <h3>Top brands · monthly sales (last 18 months)</h3>
          <span className="chart-sub">Stacked bars - each segment is a brand · click to drill in</span>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={monthData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="key" tickFormatter={(k) => monthLabel(k, { short: true })} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }} formatter={(v) => money(v)} labelFormatter={(k) => monthLabel(k)} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {top6.map((b, i) => <Bar key={b} dataKey={b} stackId="brand" fill={palette[i]} name={b} cursor="pointer" onClick={(p) => p?.key && showBrand(b, p.key, flowComparison(monthData, p, b, { upIsBad: false, labelFn: (q) => monthLabel(q.key) }))} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="table-card">
        <InfoTip title="Brand share by lifetime sales" purpose="Shows each brand's slice of total sales." detail="Total invoiced sales are summed per brand and shown with each brand's percentage of the grand total, ranked largest first; click a brand to see its invoices. Example: Gelato 43%, Alien Brainz 21%, Yacht Fuel 17%." source="Invoice Tracker." />
        <div className="table-head">
          <h3>Brand share by lifetime sales</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
            <span style={{ fontSize: 12.5, color: '#64748b' }}>Click a brand to see its invoices →</span>
            <ExportButton filename={`brand-share-${new Date().toISOString().slice(0, 10)}.csv`} title="Brand share by lifetime sales" headers={['Brand', 'Lifetime sales', '% of total']} rows={totals.map((b) => [b.brand, b.total, `${b.pct.toFixed(1)}%`])} />
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Brand</th>
                <th className="num">Lifetime sales</th>
                <th className="num">% of total</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((b) => (
                <tr key={b.brand} className="clickable-row" onClick={() => showBrand(b.brand)} title={`See ${b.brand} invoices`}>
                  <td className="vendor-cell"><span style={{ color: '#15803d', fontWeight: 600 }}>{b.brand}</span></td>
                  <td className="num">{money(b.total)}</td>
                  <td className="num">{b.pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ============ REP SCORECARD ============
export function RepScorecardTab({ ws }) {
  const { openInvoiceList } = useNav()
  const rows = useMemo(() => {
    const map = new Map()
    ws.invoices.forEach((r) => {
      const rep = r.salesRep || 'Unassigned'
      const cur = map.get(rep) || {
        rep, customers: new Set(), invoiced: 0, paid: 0, outstanding: 0,
        invoiceCount: 0, paidCount: 0, openCount: 0, writeOff: 0,
        daysWeighted: 0, paidAmt: 0, onTimeCount: 0, lateCount: 0,
      }
      cur.customers.add(r.vendor)
      cur.invoiced += r.invoiceAmount
      cur.paid += r.invoicePaid
      cur.invoiceCount += 1
      if (r.isPaid) cur.paidCount += 1
      if (r.isOutstanding) {
        cur.openCount += 1
        cur.outstanding += r.outstanding
      }
      if (r.isWriteOff) cur.writeOff += (r.invoiceAmount - r.invoicePaid)
      if (r.isPaid && r.paidDate && r.date) {
        const days = (r.paidDate - r.date) / 86400000
        if (days >= 0 && days <= 1825) {
          cur.daysWeighted += days * r.invoicePaid
          cur.paidAmt += r.invoicePaid
          if (r.dueDate && r.paidDate <= r.dueDate) cur.onTimeCount += 1
          else cur.lateCount += 1
        }
      }
      map.set(rep, cur)
    })

    return [...map.values()].map((c) => ({
      ...c,
      customerCount: c.customers.size,
      avgDso: c.paidAmt > 0 ? c.daysWeighted / c.paidAmt : 0,
      collectionRate: c.invoiced > 0 ? (c.paid / c.invoiced) * 100 : 0,
      onTimePct: (c.onTimeCount + c.lateCount) > 0 ? (c.onTimeCount / (c.onTimeCount + c.lateCount)) * 100 : 0,
    })).sort((a, b) => b.invoiced - a.invoiced)
  }, [ws.invoices])

  const repF = useColFilter(rows, (r) => r.rep)
  const shown = useMemo(() => rows.filter(repF.pass), [rows, repF])

  const [repList, setRepList] = useState(null)
  const openRep = (rep) => {
    const invs = ws.invoices.filter((r) => (r.salesRep || 'Unassigned') === rep)
    openInvoiceList({ title: `Rep · ${rep}`, subtitle: `${invs.length} invoices`, invoices: invs })
  }

  const topRep = rows[0]
  const bestColl = rows.slice().sort((a, b) => b.collectionRate - a.collectionRate)[0]


  const exportRows = shown.map((r) => [
    r.rep, r.customerCount, r.invoiceCount, r.invoiced.toFixed(2), r.paid.toFixed(2),
    r.outstanding.toFixed(2), r.openCount, r.writeOff.toFixed(2),
    r.collectionRate.toFixed(1), r.avgDso.toFixed(0), r.onTimePct.toFixed(0),
  ])

  return (
    <>
      {repList && (
        <RepListModal
          {...repList}
          onPick={(rep) => { setRepList(null); openRep(rep) }}
          onClose={() => setRepList(null)}
        />
      )}
      <section className="kpi-grid">
        <KpiCard label="Active reps" value={num(rows.length)} sub="With at least one invoice"
          onClick={() => setRepList({ title: 'Active reps', subtitle: `${rows.length} reps`, items: [...rows].sort((a, b) => a.rep.localeCompare(b.rep)).map((r) => ({ rep: r.rep })) })} />
        <KpiCard label="Top rep (revenue)" value={topRep?.rep || ''} sub={topRep ? compactMoney(topRep.invoiced) : ''}
          onClick={() => setRepList({ title: 'Reps by revenue', subtitle: 'Highest to lowest', valueLabel: 'Invoiced', items: rows.map((r) => ({ rep: r.rep, display: money(r.invoiced) })) })} />
        <KpiCard label="Best collection rate" value={`${bestColl?.collectionRate.toFixed(1) || 0}%`} sub={bestColl?.rep || ''} tone="good"
          onClick={() => setRepList({ title: 'Reps by collection rate', subtitle: 'Highest to lowest', valueLabel: 'Collection %', items: rows.slice().sort((a, b) => b.collectionRate - a.collectionRate).map((r) => ({ rep: r.rep, display: `${r.collectionRate.toFixed(1)}%` })) })} />
        <KpiCard label="Total writes-off" value={money(rows.reduce((s, r) => s + r.writeOff, 0))} sub="Across all reps" tone="bad"
          onClick={() => { const invs = ws.invoices.filter((r) => r.isWriteOff); openInvoiceList({ title: 'Write-offs · all reps', subtitle: `${invs.length} invoices`, invoices: invs }) }} />
      </section>

      <div className="table-card">
        <div className="table-head">
          <h3>Sales rep performance</h3>
          <ExportButton
            filename={`rep-scorecard-${new Date().toISOString().slice(0,10)}.csv`}
            headers={['Rep', 'Customers', 'Invoices', 'Invoiced', 'Paid', 'Outstanding', 'Open #', 'Write-off', 'Collection %', 'Avg days-to-pay (paid)', 'On-time %']}
            rows={exportRows}
          />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>
                  Rep
                  <ColumnFilter label="Rep" options={repF.options} excluded={repF.excluded} onChange={repF.setExcluded} />
                </th>
                <th className="num"># Customers</th>
                <th className="num"># Invoices</th>
                <th className="num">Invoiced</th>
                <th className="num">Paid</th>
                <th className="num">Outstanding</th>
                <th className="num">Write-off</th>
                <th className="num">Collection %</th>
                <th className="num" title="Average days to pay - PAID invoices only (collection speed), not the AR DSO">Avg days-to-pay</th>
                <th className="num">On-time %</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.rep} className="clickable-row" onClick={() => openRep(r.rep)}>
                  <td className="vendor-cell">{r.rep}</td>
                  <td className="num">{r.customerCount}</td>
                  <td className="num">{r.invoiceCount}</td>
                  <td className="num">{money(r.invoiced)}</td>
                  <td className="num">{money(r.paid)}</td>
                  <td className={`num ${r.outstanding > 0 ? 'cell-warn' : ''}`}>{r.outstanding > 0 ? money(r.outstanding) : ''}</td>
                  <td className="num">{r.writeOff > 0 ? money(r.writeOff) : ''}</td>
                  <td className="num">{r.collectionRate.toFixed(1)}%</td>
                  <td className="num">{r.avgDso > 0 ? `${r.avgDso.toFixed(0)}d` : ''}</td>
                  <td className="num">{r.paidAmt > 0 ? `${r.onTimePct.toFixed(0)}%` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function RepListModal({ title, subtitle, items, valueLabel, onPick, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-head-inner"><div>
            <div className="modal-eyebrow">{subtitle}</div>
            <h3 className="modal-title">{title}</h3>
          </div></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </header>
        <div className="modal-body">
          <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Rep</th>
                  {valueLabel && <th className="num">{valueLabel}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={it.rep} className="clickable-row" onClick={() => onPick(it.rep)}>
                    <td className="muted">{i + 1}</td>
                    <td className="vendor-cell">{it.rep}</td>
                    {valueLabel && <td className="num">{it.display}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============ CONCENTRATION ============
export function ConcentrationTab({ ws }) {

  const { openCustomer, openInvoiceList } = useNav()
  // Concentration excludes 2023 (being written off) from all figures.
  const rows = useMemo(() => {
    const map = new Map()
    ws.financials.forEach((r) => {
      if (r.date && r.date.getFullYear() === 2023) return
      const cur = map.get(r.vendor) || { vendor: r.vendor, sales: 0, paid: 0, count: 0, outstanding: 0 }
      cur.sales += r.invoiceAmount
      cur.paid += r.invoicePaid
      cur.count += 1
      map.set(r.vendor, cur)
    })
    ws.invoices.filter((r) => r.isOutstanding).forEach((r) => {
      if (r.date && r.date.getFullYear() === 2023) return
      const cur = map.get(r.vendor) || { vendor: r.vendor, sales: 0, paid: 0, count: 0, outstanding: 0 }
      cur.outstanding += r.outstanding
      map.set(r.vendor, cur)
    })
    return [...map.values()].filter((r) => r.sales > 0).sort((a, b) => b.sales - a.sales)
  }, [ws])

  const vendorBrand = useMemo(() => buildVendorBrandMap(ws.invoices), [ws.invoices])

  const totalSales = rows.reduce((s, r) => s + r.sales, 0)
  // Year span of the data (earliest to latest invoice year) for the info tips.
  const cYears = ws.financials.map((r) => r.date && r.date.getFullYear()).filter(Boolean)
  const cSpan = cYears.length
    ? (Math.min(...cYears) === Math.max(...cYears) ? `${Math.min(...cYears)}` : `${Math.min(...cYears)}-${Math.max(...cYears)}`)
    : ''
  const top5 = rows.slice(0, 5)
  const top10 = rows.slice(0, 10)
  const top5Sales = top5.reduce((s, r) => s + r.sales, 0)
  const top10Sales = top10.reduce((s, r) => s + r.sales, 0)

  // Cumulative % for Pareto chart - aggregated by BRAND (top 15 brands).
  // Excludes the "No brand" / uncategorised bucket so concentration is brand-only.
  const isNoBrand = (b) => {
    const s = String(b ?? '').trim().toLowerCase()
    return !s || s === 'no brand' || s === 'nobrand' || s === 'none' || s === 'n/a' || s === 'na'
      || s === '-' || s === '–' || s === 'unknown' || s === 'unbranded' || s.startsWith('uncategor')
  }
  const brandTotals = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const b = vendorBrand.get(r.vendor) || 'No brand'
      if (isNoBrand(b)) continue
      m.set(b, (m.get(b) || 0) + r.sales)
    }
    return [...m.entries()]
      .map(([brand, sales]) => ({ brand, sales }))
      .sort((a, b) => b.sales - a.sales)
  }, [rows, vendorBrand])
  const brandTotalSales = brandTotals.reduce((s, b) => s + b.sales, 0)
  const top5Brands = brandTotals.slice(0, 5)
  const top10Brands = brandTotals.slice(0, 10)
  const top5BrandSales = top5Brands.reduce((s, r) => s + r.sales, 0)
  const top10BrandSales = top10Brands.reduce((s, r) => s + r.sales, 0)
  const brandInvs = (brandSet) => ws.financials
    .filter((r) => (!r.date || r.date.getFullYear() !== 2023) && brandSet.has(vendorBrand.get(r.vendor) || 'No brand'))
    .map((r) => ({ ...r, masterBrand: vendorBrand.get(r.vendor) || r.masterBrand || r.brand }))

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Top 5 brands" value={`${brandTotalSales > 0 ? ((top5BrandSales / brandTotalSales) * 100).toFixed(0) : 0}%`} sub={`${compactMoney(top5BrandSales)} of ${compactMoney(brandTotalSales)}`} tone={top5BrandSales / brandTotalSales > 0.6 ? 'warn' : 'good'}
          onClick={() => { const set = new Set(top5Brands.map((b) => b.brand)); const invs = brandInvs(set); openInvoiceList({ hideOutstanding: true, title: 'Top 5 brands', subtitle: `${invs.length} invoices · ${compactMoney(top5BrandSales)}`, invoices: invs }) }}
          info={{ title: 'Top 5 brands', purpose: 'Share of revenue resting on the 5 biggest brands (all their stores combined).', detail: `Brands ranked by lifetime sales${cSpan ? ` (${cSpan})` : ''}, excluding 2023 and the no-brand/uncategorised bucket; the top five combined sales divided by total branded sales, flagged above 60%. Example: top five $2.5M of $5M = 50%.`, source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />

        <KpiCard label="Top 10 brands" value={`${brandTotalSales > 0 ? ((top10BrandSales / brandTotalSales) * 100).toFixed(0) : 0}%`} sub={`${compactMoney(top10BrandSales)} of ${compactMoney(brandTotalSales)}`} tone={top10BrandSales / brandTotalSales > 0.8 ? 'warn' : 'good'}
          onClick={() => { const set = new Set(top10Brands.map((b) => b.brand)); const invs = brandInvs(set); openInvoiceList({ hideOutstanding: true, title: 'Top 10 brands', subtitle: `${invs.length} invoices · ${compactMoney(top10BrandSales)}`, invoices: invs }) }}
          info={{ title: 'Top 10 brands', purpose: 'Share of revenue from the 10 biggest brands.', detail: `Top ten brands' combined lifetime sales${cSpan ? ` (${cSpan})` : ''} divided by total branded sales (2023 and no-brand excluded), flagged above 80%. Example: $3.6M of $5M = 72%.`, source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard label="Total customers" value={num(rows.length)} sub="With any sales activity"
          info={{ title: 'Total customers', purpose: 'How many distinct customers there are.', detail: 'Count of unique customers with any sales activity in the finance sheet. Example: 214.', source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
      </section>

      <BrandRollup
        rows={rows.filter((r) => !isNoBrand(vendorBrand.get(r.vendor) || 'No brand'))}
        brandOf={(v) => vendorBrand.get(v) || 'No brand'}
        title="Brands by lifetime sales"
        columns={[
          { label: 'Lifetime sales', agg: (rs) => { const s = rs.reduce((a, r) => a + r.sales, 0); return { display: money(s), sortVal: s } } },
          { label: 'Outstanding', agg: (rs) => { const s = rs.reduce((a, r) => a + r.outstanding, 0); return { display: s > 0 ? money(s) : '', sortVal: s, cls: s > 0 ? 'cell-warn' : '' } } },
        ]}
      >
        {(brandRows) => (
          <div className="table-card">
            <InfoTip title="Brands by lifetime sales" purpose="Shows lifetime sales and current open balance per brand." detail="Each brand's lifetime invoiced sales (from the finance sheet) and its percent of total are shown, with current open balance overlaid from the tracker's outstanding invoices. Example: Gelato $1.8M, 43%, $120,000 open." source="Finance sheet (Gelato AR sheet on Gelato pages, sales) + Invoice Tracker (open balance)." />
            <div className="table-head"><h3>{num(brandRows.length)} customers · by lifetime sales</h3></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="num">Lifetime sales</th>
                    <th className="num">% of total</th>
                    <th className="num">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {[...brandRows].sort((a, b) => b.sales - a.sales).map((r) => {
                    const pct = totalSales > 0 ? (r.sales / totalSales) * 100 : 0
                    return (
                      <tr key={r.vendor} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                        <td className="vendor-cell">{r.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                        <td className="num">{money(r.sales)}</td>
                        <td className="num">{pct.toFixed(1)}%</td>
                        <td className={`num ${r.outstanding > 0 ? 'cell-warn' : ''}`}>{r.outstanding > 0 ? money(r.outstanding) : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </BrandRollup>
    </>
  )
}

// ============ PAYMENT BEHAVIOR ============
// Payment grade from weighted avg days-to-pay + on-time %. Shared so a single
// store and a whole brand (aggregate) are graded the same way.
function payGrade(avgDays, onTimePct) {
  if (avgDays == null) return ''
  if (avgDays < 30 && onTimePct >= 80) return 'A'
  if (avgDays < 45) return 'B'
  if (avgDays < 75) return 'C'
  return 'D'
}
export function BehaviorTab({ ws, noBrand = false }) {
  const { openCustomer } = useNav()
  const [q, setQ] = useState('')

  const customers = useMemo(() => {
    const map = new Map()
    ws.invoices.forEach((r) => {
      if (r.isWriteOff || r.isCollection) return
      const cur = map.get(r.vendor) || {
        vendor: r.vendor, paidCount: 0, paidSum: 0, daysSum: 0, daysWeighted: 0,
        onTimeCount: 0, lateCount: 0, openCount: 0, openAmt: 0, openOldest: 0,
      }
      if (r.isPaid && r.paidDate && r.date) {
        const days = (r.paidDate - r.date) / 86400000
        if (days >= 0 && days <= 1825) {
          cur.paidCount += 1
          cur.paidSum += r.invoicePaid
          cur.daysSum += days
          cur.daysWeighted += days * r.invoicePaid
          if (r.dueDate && r.paidDate <= r.dueDate) cur.onTimeCount += 1
          else cur.lateCount += 1
        }
      }
      if (r.isOutstanding) {
        cur.openCount += 1
        cur.openAmt += r.outstanding
        if ((r.daysOverdue || 0) > cur.openOldest) cur.openOldest = r.daysOverdue || 0
      }
      map.set(r.vendor, cur)
    })

    let list = [...map.values()]
      .filter((c) => c.paidCount > 0 || c.openCount > 0)
      .map((c) => {
        const avgDso = c.paidSum > 0 ? c.daysWeighted / c.paidSum : null
        const onTimePct = (c.paidCount > 0) ? (c.onTimeCount / c.paidCount) * 100 : null
        return { ...c, avgDso, onTimePct, grade: payGrade(avgDso, onTimePct ?? 0) }
      })

    const needle = q.trim().toLowerCase()
    if (needle) list = list.filter((c) => c.vendor.toLowerCase().includes(needle))
    list.sort((a, b) => (a.avgDso ?? 9999) - (b.avgDso ?? 9999))
    return list
  }, [ws.invoices, q])

  const vendorBrand = useMemo(() => buildVendorBrandMap(ws.invoices), [ws.invoices])
  // Gelato has no brand concept - grade each customer individually.
  const brandOf = noBrand ? ((v) => v) : ((v) => vendorBrand.get(v) || 'No brand')
  // Grade each BRAND by its aggregate payment behaviour (weighted days-to-pay +
  // on-time across all its stores), then tag every store with its brand grade.
  const customersBranded = useMemo(() => {
    const agg = new Map()
    for (const c of customers) {
      const b = brandOf(c.vendor) || 'No brand'
      if (b === 'No brand') continue
      const a = agg.get(b) || { dw: 0, ps: 0, onTime: 0, paid: 0 }
      a.dw += c.daysWeighted; a.ps += c.paidSum; a.onTime += c.onTimeCount; a.paid += c.paidCount
      agg.set(b, a)
    }
    const gradeOf = new Map()
    for (const [b, a] of agg) {
      const avgDso = a.ps > 0 ? a.dw / a.ps : null
      const onTimePct = a.paid > 0 ? (a.onTime / a.paid) * 100 : 0
      gradeOf.set(b, payGrade(avgDso, onTimePct))
    }
    return customers.map((c) => {
      const b = brandOf(c.vendor) || 'No brand'
      return { ...c, brandGrade: b === 'No brand' ? c.grade : gradeOf.get(b) }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customers, vendorBrand])

  // Brand-level grade counts - each brand counted once.
  const grades = useMemo(() => {
    const g = { A: 0, B: 0, C: 0, D: 0 }
    const ent = new Map()
    for (const c of customersBranded) {
      const b = brandOf(c.vendor) || 'No brand'
      const key = b === 'No brand' ? `nb:${c.vendor}` : b
      if (!ent.has(key)) ent.set(key, c.brandGrade)
    }
    for (const gr of ent.values()) if (g[gr] != null) g[gr] += 1
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customersBranded])

  const gradeF = useColFilter(customersBranded, (r) => r.brandGrade || '(ungraded)')
  const shown = useMemo(() => customersBranded.filter(gradeF.pass), [customersBranded, gradeF])
  const pager = usePager(shown.length, 50, `${q}|${gradeF.key}`)
  const onlyGrade = (g) => gradeF.setExcluded(new Set(gradeF.options.filter((o) => o !== g)))

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Grade A" value={num(grades.A)} sub="< 30d avg · on-time ≥ 80%" tone="good" onClick={() => onlyGrade('A')}
          info={{ title: 'Grade A', purpose: 'Fastest, most reliable payers.', detail: 'On paid invoices only, average days-to-pay is value-weighted (with each pay time capped at 5 years to drop outliers); Grade A means under 30 days AND on-time at least 80%. Brands are graded on all their stores combined. Example: 22 days at 90% on time = A.', source: 'Invoice Tracker.' }} />
        <KpiCard label="Grade B" value={num(grades.B)} sub="30–45 days" onClick={() => onlyGrade('B')}
          info={{ title: 'Grade B', purpose: 'Customers who pay on reasonable terms.', detail: 'Same value-weighted basis; Grade B is an average days-to-pay under 45 (and not meeting the stricter A test). Example: 38 days = B.', source: 'Invoice Tracker.' }} />
        <KpiCard label="Grade C" value={num(grades.C)} sub="45–75 days" tone="warn" onClick={() => onlyGrade('C')}
          info={{ title: 'Grade C', purpose: 'Slow payers to watch.', detail: 'Same value-weighted basis; Grade C is an average days-to-pay of 45 to under 75. Example: 60 days = C.', source: 'Invoice Tracker.' }} />
        <KpiCard label="Grade D" value={num(grades.D)} sub="75d+ slow payer" tone="bad" onClick={() => onlyGrade('D')}
          info={{ title: 'Grade D', purpose: 'Slowest payers, the heaviest collection effort.', detail: 'Same value-weighted basis; Grade D is an average days-to-pay of 75 or more. Example: 95 days = D.', source: 'Invoice Tracker.' }} />
      </section>

      <BrandRollup
        rows={shown}
        brandOf={brandOf}
        flat={noBrand}
        title="Brands · payment behavior"
        columns={[
          { label: 'Open amount', agg: (rs) => { const s = rs.reduce((a, r) => a + (r.openAmt || 0), 0); return { display: s > 0 ? money(s) : '', sortVal: s, cls: s > 0 ? 'cell-warn' : '' } } },
          { label: 'Avg days-to-pay', agg: (rs) => { const dw = rs.reduce((a, r) => a + (r.daysWeighted || 0), 0); const ps = rs.reduce((a, r) => a + (r.paidSum || 0), 0); const d = ps > 0 ? dw / ps : 0; return { display: ps > 0 ? `${d.toFixed(0)}d` : '', sortVal: d } } },
        ]}
      >
        {(brandRows) => (
          <div className="table-card">
            <InfoTip title="Payment behavior" purpose="Grades every customer A-D by their actual pay speed." detail="Per customer, average days-to-pay is computed on paid invoices only (collection speed, not AR DSO), value-weighted with each pay time capped at 5 years. Grades: A under 30 days (with on-time at least 80%), B under 45, C 45 to under 75, D 75+. Example: 60 days = C." source="Invoice Tracker." />
            <div className="table-head"><h3>{num(brandRows.length)} customers · payment behavior</h3></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="num">Grade</th>
                    <th className="num">Paid invoices</th>
                    <th className="num" title="Average days to pay - PAID invoices only (collection speed), not the AR DSO">Avg days-to-pay</th>
                    <th className="num">On-time %</th>
                    <th className="num">Open</th>
                    <th className="num">Open amount</th>
                  </tr>
                </thead>
                <tbody>
                  {[...brandRows].sort((a, b) => (a.avgDso ?? 9999) - (b.avgDso ?? 9999)).map((c) => (
                    <tr key={c.vendor} className="clickable-row" onClick={() => openCustomer(c.vendor)}>
                      <td className="vendor-cell">{c.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                      <td className="num"><span className={`grade-pill grade-${c.grade}`}>{c.grade}</span></td>
                      <td className="num">{c.paidCount}</td>
                      <td className="num">{c.avgDso != null ? `${c.avgDso.toFixed(0)}d` : ''}</td>
                      <td className="num">{c.onTimePct != null ? `${c.onTimePct.toFixed(0)}%` : ''}</td>
                      <td className="num">{c.openCount || ''}</td>
                      <td className={`num ${c.openAmt > 0 ? 'cell-warn' : ''}`}>{c.openAmt > 0 ? money(c.openAmt) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </BrandRollup>
    </>
  )
}

// ============ AT-RISK CUSTOMERS ============
export function RiskTab({ ws, noBrand = false }) {
  const { openCustomer } = useNav()
  const today = new Date(); today.setHours(0, 0, 0, 0)

  const rows = useMemo(() => {
    const map = new Map()
    ws.financials.forEach((r) => {
      if (!r.date) return
      const cur = map.get(r.vendor) || { vendor: r.vendor, lastOrder: null, count: 0, lifetime: 0 }
      cur.count += 1
      cur.lifetime += r.invoiceAmount
      if (!cur.lastOrder || r.date > cur.lastOrder) cur.lastOrder = r.date
      map.set(r.vendor, cur)
    })
    ws.invoices.filter((r) => r.isOutstanding).forEach((r) => {
      const cur = map.get(r.vendor)
      if (cur) {
        cur.openAmt = (cur.openAmt || 0) + r.outstanding
      }
    })
    return [...map.values()]
      .filter((c) => c.lastOrder)
      .map((c) => {
        const daysSinceOrder = Math.floor((today - c.lastOrder) / 86400000)
        const bucket = daysSinceOrder >= 180 ? 'churned' : daysSinceOrder >= 90 ? 'high-risk' : 'watch'
        return { ...c, daysSinceOrder, bucket }
      })
      .filter((c) => c.daysSinceOrder >= 60 && c.lifetime > 1000) // skip noise
      .sort((a, b) => b.lifetime - a.lifetime)
  }, [ws])

  const vendorBrand = useMemo(() => buildVendorBrandMap(ws.invoices), [ws.invoices])
  // Gelato has no brand concept - each customer is its own unit.
  const brandOf = noBrand ? ((v) => v) : ((v) => vendorBrand.get(v) || 'No brand')
  const unit = noBrand ? 'customers' : 'brands'

  // A brand with ANY store ordering within 60 days is active - exclude the whole
  // brand from the dormant view (one active store makes the brand active).
  const activeBrands = useMemo(() => {
    const last = new Map()
    ws.financials.forEach((r) => { if (r.date && r.vendor && (!last.has(r.vendor) || r.date > last.get(r.vendor))) last.set(r.vendor, r.date) })
    const s = new Set()
    for (const [v, d] of last) { if (Math.floor((today - d) / 86400000) < 60) s.add(brandOf(v)) }
    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.financials, vendorBrand])

  // Brand's dormancy bucket = its least-dormant (most-active) store; drop brands
  // that still have an active store.
  const rowsBranded = useMemo(() => {
    const branded = assignBrandStatus(rows, brandOf, 'bucket', ['watch', 'high-risk', 'churned'])
    return branded.filter((r) => { const b = brandOf(r.vendor) || 'No brand'; return b === 'No brand' || !activeBrands.has(b) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, vendorBrand, activeBrands])

  // Brand-level bucket counts + value at risk (each brand counted once).
  const brandStat = useMemo(() => {
    const ent = new Map()
    for (const r of rowsBranded) {
      const b = brandOf(r.vendor) || 'No brand'
      const key = b === 'No brand' ? `nb:${r.vendor}` : b
      const e = ent.get(key) || { status: r.brandStatus, lifetime: 0 }
      e.lifetime += r.lifetime
      ent.set(key, e)
    }
    const out = { watch: { n: 0, v: 0 }, 'high-risk': { n: 0, v: 0 }, churned: { n: 0, v: 0 }, total: ent.size }
    for (const e of ent.values()) if (out[e.status]) { out[e.status].n += 1; out[e.status].v += e.lifetime }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsBranded])

  const bucketF = useColFilter(rowsBranded, (r) => r.brandStatus)
  const shown = useMemo(() => rowsBranded.filter(bucketF.pass), [rowsBranded, bucketF])
  const pager = usePager(shown.length, 50, `${rowsBranded.length}|${bucketF.key}`)
  const onlyBucket = (b) => bucketF.setExcluded(b == null ? new Set() : new Set(bucketF.options.filter((o) => o !== b)))

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Dormant 60–90 days" value={num(brandStat.watch.n)} sub={`${compactMoney(brandStat.watch.v)} lifetime value`} onClick={() => onlyBucket('watch')}
          info={{ title: 'Dormant 60-90 days', purpose: 'Customers who quietly stopped ordering 2-3 months ago.', detail: 'Customers with lifetime sales over $1,000 whose last order was 60-90 days ago, rolled up to brand; a brand stays off this list if any of its stores ordered within the last 60 days. Example: 8 brands dormant 60-90 days, $0.3M lifetime.', source: 'Finance sheet (Gelato AR sheet on Gelato pages, order recency) + Invoice Tracker (open balance).' }} />
        <KpiCard label="Dormant 90–180 days" value={num(brandStat['high-risk'].n)} sub={`${compactMoney(brandStat['high-risk'].v)} at risk`} tone="warn" onClick={() => onlyBucket('high-risk')}
          info={{ title: 'Dormant 90-180 days', purpose: 'Customers silent 3-6 months, higher risk.', detail: 'Last order 90-180 days ago, brand rolled up (any store active within 60 days keeps the brand off the list), shown with the lifetime value at risk. Example: 5 brands, $0.4M.', source: 'Finance sheet (Gelato AR sheet on Gelato pages, order recency) + Invoice Tracker (open balance).' }} />
        <KpiCard label="Dormant 180+ days" value={num(brandStat.churned.n)} sub={`${compactMoney(brandStat.churned.v)} likely churned`} tone="bad" onClick={() => onlyBucket('churned')}
          info={{ title: 'Dormant 180+ days', purpose: 'Customers silent over 6 months, likely churned.', detail: 'Last order more than 180 days ago, brand rolled up (any store active within 60 days keeps the brand off the list), shown with lifetime value likely lost. Example: 11 brands, $0.6M.', source: 'Finance sheet (Gelato AR sheet on Gelato pages, order recency) + Invoice Tracker (open balance).' }} />
        <KpiCard label={`Total dormant ${unit}`} value={num(brandStat.total)} sub="Need outreach" tone="muted" onClick={() => onlyBucket(null)}
          info={{ title: `Total dormant ${unit}`, purpose: `The full set of ${unit} needing outreach.`, detail: 'Count of customers dormant 60+ days (with lifetime over $1,000) that have not ordered in the last 60 days.', source: 'Finance sheet (Gelato AR sheet on Gelato pages, order recency).' }} />
      </section>

      <BrandRollup
        rows={shown}
        brandOf={brandOf}
        flat={noBrand}
        title="Brands · dormant customers"
        columns={[
          { label: 'Lifetime value', agg: (rs) => { const s = rs.reduce((a, r) => a + r.lifetime, 0); return { display: money(s), sortVal: s } } },
          { label: 'Open balance', agg: (rs) => { const s = rs.reduce((a, r) => a + (r.openAmt || 0), 0); return { display: s > 0 ? money(s) : '', sortVal: s, cls: s > 0 ? 'cell-warn' : '' } } },
        ]}
      >
        {(brandRows) => (
          <div className="table-card">
            <InfoTip title="Dormant customers" purpose="Lists every dormant customer, biggest first." detail="Each dormant customer (lifetime over $1,000, last order 60+ days ago) is shown with days silent, last order date, past order count, lifetime value, open balance from the tracker, and bucket (60-90 watch, 90-180 high-risk, 180+ churned), sorted by lifetime value. Example: Customer X, 210 days silent, 14 orders, $90,000 lifetime, churned." source="Finance sheet (Gelato AR sheet on Gelato pages, order recency) + Invoice Tracker (open balance)." />
            <div className="table-head"><h3>{num(brandRows.length)} customers · sorted by lifetime value</h3></div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="num">Days silent</th>
                    <th>Last order</th>
                    <th className="num"># Past orders</th>
                    <th className="num">Lifetime value</th>
                    <th className="num">Open balance</th>
                    <th>Bucket</th>
                  </tr>
                </thead>
                <tbody>
                  {[...brandRows].sort((a, b) => b.lifetime - a.lifetime).map((c) => (
                    <tr key={c.vendor} className="clickable-row" onClick={() => openCustomer(c.vendor)}>
                      <td className="vendor-cell">{c.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                      <td className="num">{c.daysSinceOrder}</td>
                      <td>{c.lastOrder.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                      <td className="num">{c.count}</td>
                      <td className="num">{money(c.lifetime)}</td>
                      <td className={`num ${c.openAmt > 0 ? 'cell-warn' : ''}`}>{c.openAmt > 0 ? money(c.openAmt) : ''}</td>
                      <td><span className={`risk-pill risk-${c.bucket}`}>{c.bucket}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </BrandRollup>
    </>
  )
}

// ============ SEASONALITY ============
export function SeasonalityTab({ ws }) {
  const { openInvoiceList } = useNav()
  const showCell = (year, monthIdx, comparison) => {
    const invs = ws.financials.filter((r) => r.date && r.date.getFullYear() === Number(year) && (monthIdx == null || r.date.getMonth() === monthIdx))
    if (!invs.length) return
    const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    openInvoiceList({ hideOutstanding: true, title: monthIdx == null ? `Sales · ${year}` : `Sales · ${mn[monthIdx]} ${year}`, subtitle: `${invs.length} invoices`, invoices: invs, comparison })
  }
  const data = useMemo(() => {
    const byMonth = new Map() // month (1-12) → { 2023: x, 2024: y, ... }
    ws.financials.forEach((r) => {
      if (!r.date) return
      const m = r.date.getMonth()
      const y = r.date.getFullYear()
      const cur = byMonth.get(m) || { month: m }
      cur[y] = (cur[y] || 0) + r.invoiceAmount
      byMonth.set(m, cur)
    })
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const result = []
    for (let m = 0; m < 12; m++) {
      const entry = byMonth.get(m) || { month: m }
      result.push({ ...entry, monthName: monthNames[m] })
    }
    return result
  }, [ws.financials])

  const years = useMemo(() => {
    const set = new Set()
    ws.financials.forEach((r) => { if (r.date) set.add(r.date.getFullYear()) })
    return [...set].sort()
  }, [ws.financials])

  const yearColors = ['#94a3b8', '#a7f3d0', '#6ee7b7', '#22c55e', '#15803d']

  // YoY comparison: latest 2 years
  const yA = years[years.length - 2]
  const yB = years[years.length - 1]
  const yATotal = ws.financials.filter((r) => r.date?.getFullYear() === yA).reduce((s, r) => s + r.invoiceAmount, 0)
  const yBTotal = ws.financials.filter((r) => r.date?.getFullYear() === yB).reduce((s, r) => s + r.invoiceAmount, 0)
  const yoy = yATotal > 0 ? ((yBTotal - yATotal) / yATotal) * 100 : 0

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label={`${yB} total`} value={compactMoney(yBTotal)} sub={`YoY ${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}%`} tone={yoy >= 0 ? 'good' : 'warn'}
          onClick={yB ? () => showCell(yB, null) : undefined}
          info={{ title: 'Latest year total', purpose: 'This year\'s invoiced sales so far, with year-over-year change.', detail: 'Total invoiced in the latest year, with the percent change vs the prior year\'s FULL total; because the latest year is part-complete, this YoY reads low until the year fills in. Example: $1.6M vs $3.0M last year shows a large interim drop because the year is only half done.', source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard label={`${yA} total`} value={compactMoney(yATotal)} sub="Prior year" tone="muted"
          onClick={yA ? () => showCell(yA, null) : undefined}
          info={{ title: 'Prior year total', purpose: 'Last year\'s full invoiced sales, the baseline.', detail: 'Total invoiced across the prior calendar year. Example: $3.0M.', source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
        <KpiCard
          label="Best month (lifetime)"
          value={(() => {
            const totals = data.map((d) => ({ name: d.monthName, total: years.reduce((s, y) => s + (d[y] || 0), 0) }))
            const best = totals.sort((a, b) => b.total - a.total)[0]
            return best ? best.name : ''
          })()}
          sub="By lifetime sales"
          info={{ title: 'Best month (lifetime)', purpose: 'The strongest selling month across all years.', detail: 'Invoiced sales are summed by calendar month across every year tracked; this is the month with the highest combined total. Example: December.', source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }}
        />
        <KpiCard label="Years tracked" value={num(years.length)} sub={`${years[0]} – ${years[years.length - 1]}`} tone="muted"
          info={{ title: 'Years tracked', purpose: 'How many years of data feed this view.', detail: 'Count of distinct calendar years that have any sales data, with the span shown beneath. Example: 2022-2026, 5 years.', source: 'Finance sheet (Gelato AR sheet on Gelato pages).' }} />
      </section>

      <div className="chart-card">
        <InfoTip title="Monthly sales by year" purpose="Compares the same months across years." detail="Invoiced sales are summed by calendar month and year, drawn as grouped bars (one bar per year within each month) so seasonality stands out; click a bar to open that month's invoices. Example: every December tall, February low." source="Finance sheet (Gelato AR sheet on Gelato pages)." />
        <div className="chart-head">
          <h3>Monthly sales by year</h3>
          <span className="chart-sub">Side-by-side YoY comparison</span>
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="monthName" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}
              formatter={(v) => money(v)}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {years.map((y, i) => (
              <Bar key={y} dataKey={String(y)} fill={yearColors[i % yearColors.length]} name={String(y)} radius={[3, 3, 0, 0]} cursor="pointer" onClick={(p) => p && showCell(y, p.month, flowComparison(data, p, String(y), { upIsBad: false, labelFn: (q) => q.monthName }))} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="table-card">
        <InfoTip title="Monthly sales table" purpose="Shows the exact monthly figures behind the chart." detail="Invoiced totals laid out by month (rows) and year (columns); click a cell to open that month and year's invoices. Example: the Dec 2025 cell = $180,000." source="Finance sheet (Gelato AR sheet on Gelato pages)." />
        <div className="table-head">
          <h3>Monthly sales table</h3>
          <ExportButton filename={`monthly-sales-${new Date().toISOString().slice(0, 10)}.csv`} title="Monthly sales table" headers={['Month', ...years.map(String)]} rows={data.map((d) => [d.monthName, ...years.map((y) => d[y] || 0)])} />
        </div>
        <div className="table-wrap">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Month</th>
                {years.map((y) => <th key={y} className="num">{y}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.month}>
                  <td><strong>{d.monthName}</strong></td>
                  {years.map((y) => (
                    <td key={y} className="num" style={d[y] ? { cursor: 'pointer', color: '#15803d', fontWeight: 600 } : undefined} onClick={d[y] ? () => showCell(y, d.month) : undefined} title={d[y] ? `See ${d.monthName} ${y} invoices` : undefined}>{d[y] ? money(d[y]) : ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
