import { useMemo, useState, useEffect } from 'react'
import { money, num } from '../../lib/format.js'
import { ColumnFilter, useColFilter } from '../components/ColumnFilter.jsx'
import InfoTip from '../components/InfoTip.jsx'
import { ExportButton } from '../../lib/csv.jsx'

// Editable mirror of the Gelato customer-master sheet. Brand + Sales Rep write
// back via the Apps Script web app; reflected on the next data refresh.
const GELATO_CUST_WEBHOOK = 'https://script.google.com/macros/s/AKfycbwHIMZFGotYIIG1AJrlaTrrlRRhHZUEAt3KdKIJusw9I2OBWg0OaL-UUoOFPTTig8NOXw/exec'

function lastOrderYear(s) {
  const str = String(s || '')
  const full = str.match(/(20\d\d)/)
  if (full) return Number(full[1])
  const yy = str.match(/[\/\-](\d{2})\s*$/)
  if (yy) return 2000 + Number(yy[1])
  return null
}

export default function GelatoCustomerListTab({ data }) {
  const [q, setQ] = useState('')
  const [seg, setSeg] = useState('all') // all | active | old
  const [list, setList] = useState(() => (data.gelatoCustomers || []).map((c) => ({ ...c })))
  useEffect(() => { setList((data.gelatoCustomers || []).map((c) => ({ ...c }))) }, [data.gelatoCustomers])

  // Write one cell back to the sheet (any column, by header name).
  const save = (name, field, value) => {
    fetch(GELATO_CUST_WEBHOOK, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ name, field, value }),
    }).catch(() => {})
  }
  const editLocal = (name, key, value) => setList((prev) => prev.map((c) => (c.name === name ? { ...c, [key]: value } : c)))

  const isOld = (c) => { const y = lastOrderYear(c.lastOrder); return y != null && y <= 2024 }
  const rows = useMemo(() => {
    let l = list
    const needle = q.trim().toLowerCase()
    if (needle) l = l.filter((c) => c.name.toLowerCase().includes(needle))
    if (seg === 'old') l = l.filter(isOld)
    else if (seg === 'active') l = l.filter((c) => !isOld(c))
    return [...l].sort((a, b) => a.name.localeCompare(b.name))
  }, [list, q, seg])
  const oldCount = list.filter(isOld).length

  const brandF = useColFilter(rows, (c) => c.brand)
  const repF = useColFilter(rows, (c) => c.salesRep)
  const shown = rows.filter(brandF.pass).filter(repF.pass)

  return (
    <div className="table-card">
      <InfoTip
        title="Gelato customer master list"
        purpose="The raw reference record for every Gelato customer."
        detail="The full master list of Gelato customers as held in the Gelato master sheet: name, brand, sales rep, first and last order date, and total revenue. Brand and sales rep are editable inline here and written back to the sheet; filter by recency (All / Active / Old), brand, rep, or search."
        source="Gelato Customer Master List."
      />
      <div className="table-head">
        <h3>{num(rows.length)} of {num(list.length)} customers</h3>
        <div className="table-head-tools">
          <div className="seg-filter" role="tablist" aria-label="Filter by recency" style={{ flex: '0 0 auto' }}>
            <button role="tab" aria-selected={seg === 'all'} className={seg === 'all' ? 'is-active' : ''} onClick={() => setSeg('all')}>All</button>
            <button role="tab" aria-selected={seg === 'active'} className={seg === 'active' ? 'is-active' : ''} onClick={() => setSeg('active')} title="Ordered in 2025 or later">Active</button>
            <button role="tab" aria-selected={seg === 'old'} className={seg === 'old' ? 'is-active' : ''} onClick={() => setSeg('old')} title="Last order in 2024 or earlier">Old ({num(oldCount)})</button>
          </div>
          <input type="search" className="table-search" placeholder="Search customer…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ExportButton
            filename={`gelato-customer-master-list-${new Date().toISOString().slice(0, 10)}.csv`}
            title="Gelato customer master list"
            headers={['Customer', 'Brand', 'Sales rep', 'First order', 'Last order', 'Total revenue']}
            rows={shown.map((c) => [c.name, c.brand || '', c.salesRep || '', c.firstOrder || '', c.lastOrder || '', c.totalRevenue || 0])}
          />
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Customer</th><th>Brand <ColumnFilter label="Brand" options={brandF.options} excluded={brandF.excluded} onChange={brandF.setExcluded} /></th><th>Sales rep <ColumnFilter label="Sales rep" options={repF.options} excluded={repF.excluded} onChange={repF.setExcluded} /></th><th>First order</th><th>Last order</th><th className="num">Total revenue</th></tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan="6" className="table-empty">No customers match.</td></tr>}
            {shown.map((c) => (
              <tr key={c.name}>
                <td className="vendor-cell">{c.name}</td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
