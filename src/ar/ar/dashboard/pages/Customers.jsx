import { useMemo, useState, useEffect } from 'react'
import { money, num, shortDate, monthKey, monthLabel } from '../../lib/format.js'
import { isPrivateLabel } from '../../lib/brands.js'
import { wholesaleScope, gelatoScope } from '../../lib/scope.js'
import { RiskTab, DecliningTab, BehaviorTab, CadenceTab, AllCustomersTab } from './Insights.jsx'
import { ColumnFilter, useColFilter } from '../components/ColumnFilter.jsx'
import InfoTip from '../components/InfoTip.jsx'
import { ExportButton } from '../../lib/csv.jsx'
import GelatoCustomerListTab from './GelatoCustomerList.jsx'



// 'brands' is wholesale-only - Gelato is a single brand, so the sub-tab is
// hidden for that book.
const TABS = [
  { id: 'all', label: 'All Customers' },
  { id: 'brands', label: 'Brands', ltOnly: true },
  { id: 'cadence', label: 'Reorder Cadence' },
  { id: 'risk', label: 'At-Risk' },
  { id: 'declining', label: 'Customer Health' },
   { id: 'behavior', label: 'Payment Behavior' },
  { id: 'customers', label: 'Customer Master List', ltOnly: true },
  { id: 'gelatoCustomers', label: 'Customer Master List', gelatoOnly: true },

]



const BUCKET_CLASS = {
  'Current': 'bucket-upcoming',
  '1–30': 'bucket-current',
  '31–60': 'bucket-1',
  '61–90': 'bucket-2',
  '91–120': 'bucket-3',
  '121–180': 'bucket-4',
  '180+': 'bucket-5',
}

// `book` is set per sidebar page: 'lt' (Little Tree wholesale) or 'gelato'.
// The two books are fully separate pages, not tabs inside one view.
export default function Customers({ data, book = 'lt', gelatoGroup = 'customer', setGelatoGroup }) {
  const [tab, setTab] = useState('all')
  const [modalBrand, setModalBrand] = useState(null)
  const ws = useMemo(() => (book === 'gelato' ? gelatoScope(data) : wholesaleScope(data)), [data, book])

  // Tabs available for this book (Brands is wholesale-only)
  const visibleTabs = book === 'gelato' ? TABS.filter((t) => !t.ltOnly) : TABS.filter((t) => !t.gelatoOnly)
  const activeTab = visibleTabs.some((t) => t.id === tab) ? tab : 'all'

  // Normalize brand keys so casing/punctuation variants (e.g. "Yacht Fuel" vs "YACHT FUEL") merge
  const normalizeKey = (b) => String(b || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')

  const { vendorToBrand, canonicalBrand } = useMemo(() => {
    const vendorMap = new Map()
    const display = new Map() // normalized key → preferred display name
    const counts = new Map() // normalized key → display variant counts
    const sorted = [...data.invoices].sort((a, b) => {
      const ad = a.date ? a.date.getTime() : 0
      const bd = b.date ? b.date.getTime() : 0
      return bd - ad
    })
    sorted.forEach((r) => {
      if (!r.brand) return
      const key = normalizeKey(r.brand)
      if (!key) return
      const variant = r.brand.trim()
      const c = counts.get(key) || new Map()
      c.set(variant, (c.get(variant) || 0) + 1)
      counts.set(key, c)
      if (r.vendor && !vendorMap.has(r.vendor)) vendorMap.set(r.vendor, key)
    })
    counts.forEach((variants, key) => {
      // pick the most common, then prefer Title Case > UPPER > others on tie
      const ranked = [...variants.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1]
        const aTitle = /^[A-Z][a-z]/.test(a[0])
        const bTitle = /^[A-Z][a-z]/.test(b[0])
        if (aTitle !== bTitle) return aTitle ? -1 : 1
        return a[0].length - b[0].length
      })
      display.set(key, ranked[0][0])
    })
    return { vendorToBrand: vendorMap, canonicalBrand: display }
  }, [data.invoices])

  // Returns canonical brand display name for a vendor
  const brandOf = (vendor) => {
    const key = vendorToBrand.get(vendor)
    return key ? (canonicalBrand.get(key) || 'Unbranded') : 'Unbranded'
  }

  return (
    <div className="page">
      <div className="ar-tabs-row">
        <div className="ar-tabs">
          {visibleTabs.map((t) => (
            <button key={t.id} className={`ar-tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {book === 'gelato' && setGelatoGroup && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 0 12px' }}>
          <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 7, overflow: 'hidden' }}>
            {[['customer', 'By Customer'], ['brand', 'By Brand']].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setGelatoGroup(id)}
                style={{
                  fontSize: 13.5, padding: '7px 16px', border: 'none', cursor: 'pointer', fontWeight: 500,
                  borderLeft: id !== 'customer' ? '1px solid #e2e8f0' : 'none',
                  background: gelatoGroup === id ? '#15803d' : '#fff',
                  color: gelatoGroup === id ? '#fff' : '#475569',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}



      {activeTab === 'all' && <AllCustomersTab ws={ws} />}
      {activeTab === 'brands' && <BrandsView data={data} brandOf={brandOf} onSelect={(brand) => setModalBrand(brand)} />}
      {activeTab === 'cadence' && <CadenceTab ws={ws} noBrand={book === 'gelato' && gelatoGroup !== 'brand'} />}
      {activeTab === 'risk' && <RiskTab ws={ws} noBrand={book === 'gelato' && gelatoGroup !== 'brand'} />}
      {activeTab === 'declining' && <DecliningTab ws={ws} noBrand={book === 'gelato' && gelatoGroup !== 'brand'} />}
            {activeTab === 'behavior' && <BehaviorTab ws={ws} noBrand={book === 'gelato' && gelatoGroup !== 'brand'} />}
      {activeTab === 'customers' && <CustomerListTab data={data} />}
      {activeTab === 'gelatoCustomers' && <GelatoCustomerListTab data={data} />}



      {modalBrand && (
        <BrandModal
          data={data}
          brand={modalBrand}
          brandOf={brandOf}
          onClose={() => setModalBrand(null)}
        />
      )}
    </div>
  )
}

// ============ CUSTOMERS LIST VIEW ============
// Editable mirror of the shared customer-list sheet (name + Private Label).
// Toggling a checkbox writes back to the sheet via an Apps Script web app; the
// dashboard's private-label bifurcation reflects it on the next data refresh.
const CUSTOMER_PL_WEBHOOK = 'https://script.google.com/macros/s/AKfycbxFFBW_dL2dg5goaPAeefpb4fQXiIHAJ_I-evJJFT68ACYGCZv0ZeJBEDySG-4-qcUBoA/exec'



// Pull the order year out of a "Last Order Date" string (handles 2024-..,
// 12/3/2024, and MM/DD/YY). Returns null if no year can be read.
function lastOrderYear(s) {
  const str = String(s || '')
  const full = str.match(/(20\d\d)/)
  if (full) return Number(full[1])
  const yy = str.match(/[\/\-](\d{2})\s*$/)
  if (yy) return 2000 + Number(yy[1])
  return null
}

function CustomerListTab({ data }) {
  const [q, setQ] = useState('')
  const [plOnly, setPlOnly] = useState(false)
  const [seg, setSeg] = useState('all') // all | active | old  (old = no orders in 2025+)
  // Local copy so checkboxes flip instantly; re-synced whenever data reloads.
  const [list, setList] = useState(() => (data.customers || []).map((c) => ({ ...c })))
  useEffect(() => { setList((data.customers || []).map((c) => ({ ...c }))) }, [data.customers])

  // Write one cell back to the sheet (any column, by header name).
  const save = (name, field, value) => {
    fetch(CUSTOMER_PL_WEBHOOK, {
      method: 'POST',
      mode: 'no-cors', // Apps Script web app - fire-and-forget, opaque response
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ name, field, value }),
    }).catch(() => {})
  }
  const toggle = (name, next) => {
    setList((prev) => prev.map((c) => (c.name === name ? { ...c, privateLabel: next } : c)))
    save(name, 'Private Label', next)
  }
  // Update a text field locally as you type; persist on blur.
  const editLocal = (name, key, value) => setList((prev) => prev.map((c) => (c.name === name ? { ...c, [key]: value } : c)))


  const isOld = (c) => { const y = lastOrderYear(c.lastOrder); return y != null && y <= 2024 }
  const rows = useMemo(() => {
    let l = list
    const needle = q.trim().toLowerCase()
    if (needle) l = l.filter((c) => c.name.toLowerCase().includes(needle))
    if (plOnly) l = l.filter((c) => c.privateLabel)
    if (seg === 'old') l = l.filter(isOld)
    else if (seg === 'active') l = l.filter((c) => !isOld(c))
    return [...l].sort((a, b) => a.name.localeCompare(b.name))
  }, [list, q, plOnly, seg])
  const plCount = list.filter((c) => c.privateLabel).length
  const oldCount = list.filter(isOld).length

  const custF = useColFilter(rows, (c) => c.name)
  const plF = useColFilter(rows, (c) => (c.privateLabel ? 'Yes' : 'No'))
  const brandF = useColFilter(rows, (c) => c.brand)
  const repF = useColFilter(rows, (c) => c.salesRep)
  const firstF = useColFilter(rows, (c) => c.firstOrder)
  const lastF = useColFilter(rows, (c) => c.lastOrder)
  const ownerF = useColFilter(rows, (c) => c.arOwner)
  const shown = rows
    .filter(custF.pass).filter(plF.pass).filter(brandF.pass).filter(repF.pass)
    .filter(firstF.pass).filter(lastF.pass).filter(ownerF.pass)


  return (
    <div className="table-card">
      <InfoTip
        title="Customer master list"
        purpose="The raw reference record for every customer."
        detail="The full master list of customers and their attributes as held in the master sheet: name, infused-origin flag, brand, sales rep, first and last order date, and total revenue. Editable inline here (brand, rep, infused-origin) and written back to the sheet; filter by recency (All / Active / Old), brand, rep, search, or infused-origin only. Example: one row per customer with name, brand, rep, first/last order and total revenue."
        source="Customer Master List."
      />
      <div className="table-head">
          <h3>{num(rows.length)} of {num(list.length)} customers · {num(plCount)} infused origin</h3>
        <div className="table-head-tools">
          <div className="seg-filter" role="tablist" aria-label="Filter by recency" style={{ flex: '0 0 auto' }}>
            <button role="tab" aria-selected={seg === 'all'} className={seg === 'all' ? 'is-active' : ''} onClick={() => setSeg('all')}>All</button>
            <button role="tab" aria-selected={seg === 'active'} className={seg === 'active' ? 'is-active' : ''} onClick={() => setSeg('active')} title="Ordered in 2025 or later">Active</button>
            <button role="tab" aria-selected={seg === 'old'} className={seg === 'old' ? 'is-active' : ''} onClick={() => setSeg('old')} title="Last order in 2024 or earlier - none in 2025+">Old ({num(oldCount)})</button>
          </div>
          <input type="search" className="table-search" placeholder="Search customer…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className={`ar-tab ${plOnly ? 'active' : ''}`} style={{ flex: '0 0 auto' }} onClick={() => setPlOnly((v) => !v)}>
               Infused Origin only
          </button>
          <ExportButton
            filename={`customer-master-list-${new Date().toISOString().slice(0, 10)}.csv`}
            title="Customer master list"
            headers={['Customer', 'Infused Origin', 'Brand', 'Sales rep', 'First order', 'Last order', 'Total revenue', 'AR Owner']}
            rows={shown.map((c) => [c.name, c.privateLabel ? 'Yes' : 'No', c.brand || '', c.salesRep || '', c.firstOrder || '', c.lastOrder || '', c.totalRevenue || 0, c.arOwner || ''])}

          />
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Customer <ColumnFilter label="Customer" options={custF.options} excluded={custF.excluded} onChange={custF.setExcluded} /></th><th>Infused Origin <ColumnFilter label="Infused Origin" options={plF.options} excluded={plF.excluded} onChange={plF.setExcluded} /></th><th>Brand <ColumnFilter label="Brand" options={brandF.options} excluded={brandF.excluded} onChange={brandF.setExcluded} /></th><th>Sales rep <ColumnFilter label="Sales rep" options={repF.options} excluded={repF.excluded} onChange={repF.setExcluded} /></th><th>First order <ColumnFilter label="First order" options={firstF.options} excluded={firstF.excluded} onChange={firstF.setExcluded} /></th><th>Last order <ColumnFilter label="Last order" options={lastF.options} excluded={lastF.excluded} onChange={lastF.setExcluded} /></th><th className="num">Total revenue</th><th>AR Owner <ColumnFilter label="AR Owner" options={ownerF.options} excluded={ownerF.excluded} onChange={ownerF.setExcluded} /></th></tr>


          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan="8" className="table-empty">No customers match.</td></tr>}

            {shown.map((c) => (

              <tr key={c.name}>
                <td className="vendor-cell">{c.name}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={c.privateLabel}
                    onChange={(e) => toggle(c.name, e.target.checked)}
                    style={{ width: 16, height: 16, cursor: 'pointer' }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={c.brand || ''}
                    onChange={(e) => editLocal(c.name, 'brand', e.target.value)}
                    onBlur={(e) => save(c.name, 'Brand', e.target.value)}
                    style={{ width: '100%', border: '1px solid transparent', background: 'transparent', padding: '2px 4px', borderRadius: 4 }}
                    onFocus={(e) => { e.target.style.border = '1px solid #cbd5e1'; e.target.style.background = '#fff' }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={c.salesRep || ''}
                    onChange={(e) => editLocal(c.name, 'salesRep', e.target.value)}
                    onBlur={(e) => save(c.name, 'Sales Rep', e.target.value)}
                    style={{ width: '100%', border: '1px solid transparent', background: 'transparent', padding: '2px 4px', borderRadius: 4 }}
                    onFocus={(e) => { e.target.style.border = '1px solid #cbd5e1'; e.target.style.background = '#fff' }}
                  />
                </td>
                <td className="muted">{c.firstOrder || ''}</td>
                <td className="muted">{c.lastOrder || ''}</td>

                <td className="num">{c.totalRevenue ? money(c.totalRevenue) : ''}</td>
                               <td>
                  <input
                    type="text"
                    value={c.arOwner || ''}
                    onChange={(e) => editLocal(c.name, 'arOwner', e.target.value)}
                    onBlur={(e) => save(c.name, 'AR Owner', e.target.value)}
                    style={{ width: '100%', border: '1px solid transparent', background: 'transparent', padding: '2px 4px', borderRadius: 4 }}
                    onFocus={(e) => { e.target.style.border = '1px solid #cbd5e1'; e.target.style.background = '#fff' }}
                  />
                </td>
 
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============ BRANDS VIEW ============

function BrandsView({ data, brandOf, onSelect }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: 'sales', dir: 'desc' })

  const brands = useMemo(() => {
    const map = new Map()
    const ensure = (b) => {
      if (!map.has(b)) map.set(b, { brand: b, customers: new Set(), sales: 0, paid: 0, invoiceCount: 0, outstanding: 0, openCount: 0 })
      return map.get(b)
    }
    data.financials.forEach((r) => {
      const b = brandOf(r.vendor)
      const c = ensure(b)
      c.customers.add(r.vendor)
      c.sales += r.invoiceAmount
      c.paid += r.invoicePaid
      c.invoiceCount += 1
    })
    data.invoices.forEach((r) => {
      const b = brandOf(r.vendor)
      const c = ensure(b)
      if (r.vendor) c.customers.add(r.vendor)
      if (r.isOutstanding) {
        c.outstanding += r.outstanding
        c.openCount += 1
      }
    })
    return [...map.values()].map((c) => ({
      ...c,
      customerCount: c.customers.size,
      collectionPct: c.sales > 0 ? (c.paid / c.sales) * 100 : null,
    }))
  }, [data, brandOf])

  const wholesaleBrands = useMemo(() => {
    let list = brands.filter((b) => !isPrivateLabel(b.brand))
    const needle = q.trim().toLowerCase()
    if (needle) list = list.filter((b) => b.brand.toLowerCase().includes(needle))
    const { key, dir } = sort
    const f = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'string') return av.localeCompare(bv) * f
      return (av - bv) * f
    })
    return list
  }, [brands, q, sort])

  const toggle = (k) => setSort((s) => s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' })
  const arrow = (k) => sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const brandF = useColFilter(wholesaleBrands, (b) => b.brand)
  const shownBrands = wholesaleBrands.filter(brandF.pass)

  return (
    <div className="table-card">
      <InfoTip
        title="Brands"
        purpose="The customer book rolled up to brand level."
        detail="Each customer's vendor is mapped to its brand, then sales, paid, invoice count and customer count are summed from the finance records and the open balance is summed from outstanding invoices; collection % is paid divided by sales. Click a row to drill into its customers. Example: Gelato with $1.8M sales and $120,000 open."
        source="Finance sheet (sales and paid) + Invoice Tracker (open balance)."
      />
      <div className="table-head">
        <h3>{num(shownBrands.length)} brands</h3>

        <input
          type="search"
          className="table-search"
          placeholder="Search brand…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ExportButton
          filename={`brands-${new Date().toISOString().slice(0, 10)}.csv`}
          title="Brands"
          headers={['Brand', 'Customers', 'Invoices', 'Total sales', 'Paid', 'Outstanding', 'Collection %']}
          rows={shownBrands.map((b) => [b.brand, b.customerCount, b.invoiceCount, b.sales, b.paid, b.outstanding, b.collectionPct == null ? '' : `${b.collectionPct.toFixed(0)}%`])}
        />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Brand
                <ColumnFilter label="Brand" options={brandF.options} excluded={brandF.excluded} onChange={brandF.setExcluded} />
              </th>


              <th className="num" onClick={() => toggle('customerCount')}>Customers{arrow('customerCount')}</th>
              <th className="num" onClick={() => toggle('invoiceCount')}>Invoices{arrow('invoiceCount')}</th>
              <th className="num" onClick={() => toggle('sales')}>Total sales{arrow('sales')}</th>
              <th className="num" onClick={() => toggle('paid')}>Paid{arrow('paid')}</th>
              <th className="num" onClick={() => toggle('outstanding')}>Outstanding{arrow('outstanding')}</th>
              <th className="num" onClick={() => toggle('collectionPct')}>Collection %{arrow('collectionPct')}</th>
            </tr>
          </thead>
          <tbody>
            {shownBrands.length === 0 && <tr><td colSpan="8" className="table-empty">No brands match.</td></tr>}
            {shownBrands.map((b) => (

              <tr key={b.brand} className="clickable-row" onClick={() => onSelect(b.brand)}>
                <td className="vendor-cell"><strong>{b.brand}</strong></td>
                <td className="num">{b.customerCount}</td>
                <td className="num">{b.invoiceCount}</td>
                <td className="num">{money(b.sales)}</td>
                <td className="num muted">{money(b.paid)}</td>
                <td className={`num ${b.outstanding > 0 ? 'cell-warn' : ''}`}>{b.outstanding > 0 ? money(b.outstanding) : ''}</td>
                <td className={`num collect-pct ${pctClass(b.collectionPct)}`}>
                  {b.collectionPct != null ? `${b.collectionPct.toFixed(1)}%` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function pctClass(p) {
  if (p == null) return ''
  if (p >= 95) return 'pct-good'
  if (p >= 70) return 'pct-ok'
  if (p >= 30) return 'pct-warn'
  return 'pct-bad'
}

// ============ BRAND MODAL (drills brand → customer list → invoices, all in one modal) ============

function BrandModal({ data, brand, brandOf, onClose }) {
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const isPrivate = isPrivateLabel(brand)

  // ESC to close + lock body scroll
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (selectedCustomer) setSelectedCustomer(null)
        else onClose()
      }
    }
    document.addEventListener('keydown', handler)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = prev
    }
  }, [onClose, selectedCustomer])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-head-inner">
            {selectedCustomer && (
              <button className="modal-back" onClick={() => setSelectedCustomer(null)} aria-label="Back">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
            <div>
              <div className={`modal-eyebrow ${isPrivate ? 'eyebrow-private' : ''}`}>
              {isPrivate ? 'Infused Origin brand' : 'Customer brand'}
              </div>
              <h3 className="modal-title">
                {selectedCustomer
                  ? selectedCustomer.replace(/^Little Tree-\s*/i, '')
                  : brand}
              </h3>
              {!selectedCustomer && (
                <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                  Customers buying under this brand
                </div>
              )}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </header>

        <div className="modal-body">
          {selectedCustomer
            ? <InvoicesPanel data={data} customer={selectedCustomer} />
            : <CustomersPanel data={data} brand={brand} brandOf={brandOf} onSelect={setSelectedCustomer} />
          }
        </div>
      </div>
    </div>
  )
}

// ============ CUSTOMERS PANEL (inside modal) ============

function CustomersPanel({ data, brand, brandOf, onSelect }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: 'sales', dir: 'desc' })

  const customers = useMemo(() => {
    const map = new Map()
    const ensure = (vendor) => {
      if (!map.has(vendor)) {
        map.set(vendor, { vendor, sales: 0, paid: 0, salesCount: 0, outstanding: 0, openCount: 0, salesRep: '', email: '' })
      }
      return map.get(vendor)
    }
    data.financials.forEach((r) => {
      if (brandOf(r.vendor) !== brand) return
      const c = ensure(r.vendor)
      c.sales += r.invoiceAmount
      c.paid += r.invoicePaid
      c.salesCount += 1
    })

    const invoicesByDate = [...data.invoices].sort((a, b) => {
      const ad = a.date ? a.date.getTime() : 0
      const bd = b.date ? b.date.getTime() : 0
      return bd - ad
    })
    invoicesByDate.forEach((r) => {
      if (brandOf(r.vendor) !== brand) return
      const c = ensure(r.vendor)
      if (r.isOutstanding) {
        c.outstanding += r.outstanding
        c.openCount += 1
      }
      if (!c.salesRep && r.salesRep) c.salesRep = r.salesRep
      if (!c.email && r.email) c.email = r.email
    })

    const needle = q.trim().toLowerCase()
    let list = [...map.values()]
    if (needle) {
      list = list.filter((c) =>
        c.vendor.toLowerCase().includes(needle) ||
        c.salesRep.toLowerCase().includes(needle) ||
        c.email.toLowerCase().includes(needle)
      )
    }

    const { key, dir } = sort
    const factor = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null || av === '') return 1
      if (bv == null || bv === '') return -1
      if (typeof av === 'string') return av.localeCompare(bv) * factor
      if (av < bv) return -1 * factor
      if (av > bv) return 1 * factor
      return 0
    })
    return list
  }, [data, brand, brandOf, q, sort])

  const toggleSort = (key) => setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  const arrow = (key) => sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const repF = useColFilter(customers, (c) => c.salesRep || '(no rep)')
  const shownCustomers = customers.filter(repF.pass)

  const totals = useMemo(() => {

    const sales = customers.reduce((s, c) => s + c.sales, 0)
    const paid = customers.reduce((s, c) => s + c.paid, 0)
    const outstanding = customers.reduce((s, c) => s + c.outstanding, 0)
    return { sales, paid, outstanding }
  }, [customers])

  return (
    <>
      <section className="modal-kpis">
        <div className="modal-kpi">
          <div className="modal-kpi-label">Total invoiced</div>
          <div className="modal-kpi-val">{money(totals.sales)}</div>
          <div className="modal-kpi-sub">{num(customers.length)} customers</div>
        </div>
        <div className="modal-kpi">
          <div className="modal-kpi-label">Total paid</div>
          <div className="modal-kpi-val is-good">{money(totals.paid)}</div>
        </div>
        <div className="modal-kpi">
          <div className="modal-kpi-label">Outstanding</div>
          <div className={`modal-kpi-val ${totals.outstanding > 0 ? 'is-warn' : ''}`}>
            {totals.outstanding > 0 ? money(totals.outstanding) : '$0'}
          </div>
        </div>
      </section>

      <div className="modal-toolbar">
        <input type="search" className="table-search" placeholder="Search customer, rep, email…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="modal-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort('vendor')}>Customer{arrow('vendor')}</th>
              <th>Sales Rep
                <ColumnFilter label="Sales Rep" options={repF.options} excluded={repF.excluded} onChange={repF.setExcluded} />
              </th>


              <th onClick={() => toggleSort('email')}>Email{arrow('email')}</th>
              <th className="num" onClick={() => toggleSort('sales')}>Total sales{arrow('sales')}</th>
              <th className="num" onClick={() => toggleSort('paid')}>Paid{arrow('paid')}</th>
              <th className="num" onClick={() => toggleSort('outstanding')}>Outstanding{arrow('outstanding')}</th>
              <th className="num" onClick={() => toggleSort('openCount')}>Open{arrow('openCount')}</th>
              <th className="action-col"></th>
            </tr>
          </thead>
          <tbody>
            {shownCustomers.length === 0 && <tr><td colSpan="8" className="table-empty">No customers in this brand.</td></tr>}
            {shownCustomers.map((c) => (

              <tr key={c.vendor} className="clickable-row" onClick={() => onSelect(c.vendor)}>
                <td className="vendor-cell">{c.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                <td>{c.salesRep}</td>
                <td className="email-cell">
                  {c.email ? c.email.split(/[,\n]/)[0].trim() : ''}
                </td>
                <td className="num">{money(c.sales)}</td>
                <td className="num">{money(c.paid)}</td>
                <td className={`num ${c.outstanding > 0 ? 'cell-warn' : ''}`}>{c.outstanding > 0 ? money(c.outstanding, true) : ''}</td>
                <td className="num">{c.openCount || ''}</td>
                <td className="action-col">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ============ INVOICES PANEL (inside modal) ============

function InvoicesPanel({ data, customer }) {
  const [filter, setFilter] = useState('all')
  const [month, setMonth] = useState('all') // 'all' | YYYY-MM key
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' })

  const allRows = useMemo(() => data.invoices.filter((r) => r.vendor === customer), [data, customer])

  // Distinct months present in this customer's invoices (newest first)
  const months = useMemo(() => {
    const set = new Set()
    allRows.forEach((r) => {
      const k = monthKey(r.date)
      if (k) set.add(k)
    })
    return [...set].sort((a, b) => b.localeCompare(a))
  }, [allRows])

  // Apply month filter first so KPIs reflect it
  const scoped = useMemo(() => {
    if (month === 'all') return allRows
    return allRows.filter((r) => monthKey(r.date) === month)
  }, [allRows, month])

  const stats = useMemo(() => {
    const totalSales = scoped.reduce((s, r) => s + r.invoiceAmount, 0)
    const totalPaid = scoped.reduce((s, r) => s + r.invoicePaid, 0)
    const totalOpen = scoped.filter((r) => r.isOutstanding).reduce((s, r) => s + r.outstanding, 0)
    const openCount = scoped.filter((r) => r.isOutstanding).length
    const closedCount = scoped.length - openCount
    return { totalSales, totalPaid, totalOpen, openCount, closedCount, total: scoped.length }
  }, [scoped])

  const filtered = useMemo(() => {
    let list = scoped
    if (filter === 'open') list = list.filter((r) => r.isOutstanding)
    else if (filter === 'closed') list = list.filter((r) => !r.isOutstanding)

    const { key, dir } = sort
    const factor = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null) return 1
      if (bv == null) return -1
      if (av instanceof Date && bv instanceof Date) return (av - bv) * factor
      if (av < bv) return -1 * factor
      if (av > bv) return 1 * factor
      return 0
    })
  }, [scoped, filter, sort])

  const toggleSort = (key) => setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  const arrow = (key) => sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const statusF = useColFilter(filtered, (r) => r.isOutstanding ? (r.invoicePaid > 0 ? 'Partial' : 'Open') : (r.isWriteOff ? 'Write-off' : 'Paid'))
  const bucketF = useColFilter(filtered, (r) => r.isOutstanding ? r.agingBucket : '(closed)')
  const shownInv = filtered.filter(statusF.pass).filter(bucketF.pass)

  return (
    <>
      <section className="modal-kpis">
        <div className="modal-kpi">
          <div className="modal-kpi-label">Total invoiced</div>
          <div className="modal-kpi-val">{money(stats.totalSales)}</div>

          <div className="modal-kpi-sub">{num(stats.total)} invoices</div>
        </div>
        <div className="modal-kpi">
          <div className="modal-kpi-label">Total paid</div>
          <div className="modal-kpi-val is-good">{money(stats.totalPaid)}</div>
          <div className="modal-kpi-sub">{num(stats.closedCount)} closed</div>
        </div>
        <div className="modal-kpi">
          <div className="modal-kpi-label">Outstanding</div>
          <div className={`modal-kpi-val ${stats.totalOpen > 0 ? 'is-warn' : ''}`}>
            {stats.totalOpen > 0 ? money(stats.totalOpen) : '$0'}
          </div>
          <div className="modal-kpi-sub">{num(stats.openCount)} open</div>
        </div>
      </section>

      <div className="modal-toolbar">
        <div className="tab-filter">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All <span className="tab-count">{stats.total}</span>
          </button>
          <button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>
            Open <span className="tab-count">{stats.openCount}</span>
          </button>
          <button className={filter === 'closed' ? 'active' : ''} onClick={() => setFilter('closed')}>
            Closed <span className="tab-count">{stats.closedCount}</span>
          </button>
        </div>

        <label className="select-filter">
          <span className="select-label">Month</span>
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">All months</option>
            {months.map((k) => <option key={k} value={k}>{monthLabel(k)}</option>)}
          </select>
        </label>
      </div>

      <div className="modal-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort('invNo')}>Inv #{arrow('invNo')}</th>
              <th onClick={() => toggleSort('date')}>Date{arrow('date')}</th>
              <th className="num" onClick={() => toggleSort('invoiceAmount')}>Amount{arrow('invoiceAmount')}</th>
              <th className="num" onClick={() => toggleSort('invoicePaid')}>Paid{arrow('invoicePaid')}</th>
              <th className="num" onClick={() => toggleSort('outstanding')}>Outstanding{arrow('outstanding')}</th>
              <th>Status <ColumnFilter label="Status" options={statusF.options} excluded={statusF.excluded} onChange={statusF.setExcluded} /></th>
              <th>Bucket <ColumnFilter label="Bucket" options={bucketF.options} excluded={bucketF.excluded} onChange={bucketF.setExcluded} /></th>

              <th onClick={() => toggleSort('dueDate')}>Due{arrow('dueDate')}</th>
              <th onClick={() => toggleSort('paidDate')}>Paid date{arrow('paidDate')}</th>
            </tr>
          </thead>
          <tbody>
            {shownInv.length === 0 && <tr><td colSpan="9" className="table-empty">No invoices match this filter.</td></tr>}
            {shownInv.map((r, i) => (

              <tr key={`${r.invNo}-${i}`}>
                <td className="mono">{r.invNo}</td>
                <td>{shortDate(r.date)}</td>
                <td className="num">{money(r.invoiceAmount, true)}</td>
                <td className="num">{money(r.invoicePaid, true)}</td>
                <td className={`num ${r.outstanding > 0 ? 'cell-warn' : ''}`}>{r.outstanding > 0 ? money(r.outstanding, true) : ''}</td>
                <td>
                  <span
                    className={`status-pill ${r.isOutstanding ? (r.invoicePaid > 0 ? 'status-partial' : 'status-open') : 'status-closed'}`}
                    title={r.isOutstanding && r.invoicePaid > 0 ? `${money(r.invoicePaid, true)} paid of ${money(r.invoiceAmount, true)}${r.paidDate ? ' · ' + shortDate(r.paidDate) : ''} · ${money(r.outstanding, true)} still due` : undefined}
                  >
                    {r.isOutstanding ? (r.invoicePaid > 0 ? 'Partial' : 'Open') : (r.isWriteOff ? 'Write-off' : 'Paid')}
                  </span>
                </td>
                <td>{r.isOutstanding ? <span className={`bucket-pill ${BUCKET_CLASS[r.agingBucket] || ''}`}>{r.agingBucket}</span> : ''}</td>
                <td className="muted">{shortDate(r.dueDate)}</td>
                <td className={r.paidDate ? '' : 'muted'}>{r.paidDate ? shortDate(r.paidDate) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
