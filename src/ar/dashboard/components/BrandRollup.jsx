import { useMemo, useState } from 'react'
import { num } from '../../lib/format.js'
import { ExportButton } from '../../lib/csv.jsx'
import { catchAllLast } from '../../lib/brands.js'

// Brand-first wrapper for any per-store/per-customer table.
//
// Shows a BRAND rollup first (one row per brand, with caller-defined summary
// columns). Clicking a brand reveals that brand's per-store rows - rendered by
// `children(filteredRows)`, which is the component's existing store table.
//
// Props:
//   rows      - the store/customer rows (each must expose a vendor via `vendorKey`)
//   brandOf   - (vendorName) => brand string  (falls back to "No brand")
//   vendorKey - field on a row holding the vendor name (default 'vendor')
//   columns   - [{ label, agg }] where agg(rows) => { display, sortVal?, cls? }
//   title     - heading for the brand rollup
//   hint      - small grey hint text in the header
//   children  - (rowsForBrand) => JSX  (the existing store table)
export default function BrandRollup({ rows, brandOf, vendorKey = 'vendor', columns = [], title = 'By brand', hint = 'Click a brand to see its customers →', flat = false, children }) {
  const [brand, setBrand] = useState(null)
  const brandFor = (r) => brandOf(r[vendorKey]) || 'No brand'

  // Books with no brand concept (e.g. Gelato) skip the rollup entirely and show
  // the per-customer table directly.
  if (flat) return children(rows)

  const groups = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const b = brandFor(r)
      const g = m.get(b) || { brand: b, rows: [] }
      g.rows.push(r)
      m.set(b, g)
    }
    const list = [...m.values()].map((g) => ({
      brand: g.brand,
      count: g.rows.length,
      cells: columns.map((c) => c.agg(g.rows)),
    }))
    return list.sort(catchAllLast((g) => g.brand, (a, b) => (b.cells[0]?.sortVal ?? b.count) - (a.cells[0]?.sortVal ?? a.count)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns])

  if (brand) {
    const filtered = rows.filter((r) => brandFor(r) === brand)
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <button
            type="button"
            onClick={() => setBrand(null)}
            style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#15803d', fontWeight: 600, fontSize: 13 }}
          >
            ← All brands
          </button>
          <span style={{ fontWeight: 600 }}>{brand}</span>
        </div>
        {children(filtered)}
      </>
    )
  }

  return (
    <div className="table-card">
      <div className="table-head">
        <h3>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
          {hint && <span style={{ fontSize: 12.5, color: '#64748b' }}>{hint}</span>}
          <ExportButton
            filename={`${String(title).replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`}
            title={title}
            headers={['Brand', '# Customers', ...columns.map((c) => c.label)]}
            rows={groups.map((g) => [g.brand, g.count, ...g.cells.map((c) => c.display)])}
          />
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Brand</th>
              <th className="num"># Customers</th>
              {columns.map((c, i) => <th key={i} className="num">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <tr><td colSpan={2 + columns.length} className="table-empty">No data.</td></tr>}
            {groups.map((g) => (
              <tr key={g.brand} className="clickable-row" onClick={() => setBrand(g.brand)}>
                <td className="vendor-cell"><strong>{g.brand}</strong></td>
                <td className="num">{num(g.count)}</td>
                {g.cells.map((cell, i) => <td key={i} className={`num ${cell.cls || ''}`}>{cell.display}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Helper: build a vendor → brand map from invoice rows (uses the customer
// master-list brand `masterBrand`, falling back to the invoice's own brand).
export function buildVendorBrandMap(invoices) {
  const m = new Map()
  for (const r of invoices || []) {
    if (!r.vendor) continue
    if (!m.get(r.vendor)) m.set(r.vendor, r.masterBrand || r.brand || 'No brand')
  }
  return m
}

// Brand-level status. Each brand is classified by its MOST-ACTIVE store, so the
// whole-brand decision is: a brand is (e.g.) churned only when ALL its stores
// are churned - a single active store makes the entire brand active. `priority`
// lists statuses from most-active to least-active. Standalone "No brand"
// customers are each their own entity and keep their own status. Returns the
// rows with an added `brandStatus` field (every store of a brand shares it).
export function assignBrandStatus(rows, brandOf, statusKey, priority) {
  const rank = (s) => { const i = priority.indexOf(s); return i < 0 ? priority.length : i }
  const best = new Map() // brand -> best (lowest = most active) rank seen
  for (const r of rows) {
    const b = brandOf(r.vendor) || 'No brand'
    if (b === 'No brand') continue
    const rk = rank(r[statusKey])
    if (!best.has(b) || rk < best.get(b)) best.set(b, rk)
  }
  return rows.map((r) => {
    const b = brandOf(r.vendor) || 'No brand'
    if (b === 'No brand') return { ...r, brandStatus: r[statusKey] }
    return { ...r, brandStatus: priority[best.get(b)] }
  })
}
