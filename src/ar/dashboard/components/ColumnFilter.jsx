import { useState, useEffect, useRef, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'

// ============ COLUMN FILTER ============
// Spreadsheet-style filter dropdown attached to a column header. Uses an
// "excluded" Set so the empty state = no filter (all values pass). The menu is
// rendered in a PORTAL with fixed positioning so it is never clipped by a
// table's `overflow: auto` (which previously hid most of the options).
export function ColumnFilter({ label, options, excluded, onChange }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const btnRef = useRef(null)
  const [pos, setPos] = useState(null)
  const hasFilter = excluded.size > 0
  const shownCount = options.length - excluded.size
  const showSearch = options.length > 8
  const q = query.trim().toLowerCase()
  const visible = q ? options.filter((o) => String(o ?? '(blank)').toLowerCase().includes(q)) : options

  // Position the portal menu under the filter button, clamped to the viewport,
  // flipping up when there isn't room below. Tracks scroll/resize.
  useLayoutEffect(() => {
    if (!open) return
    const compute = () => {
      const el = btnRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const W = 220, vw = window.innerWidth, vh = window.innerHeight
      let left = r.left
      if (left + W > vw - 8) left = vw - 8 - W
      if (left < 8) left = 8
      let top = r.bottom + 4
      const estH = 340
      if (top + estH > vh - 8 && r.top - 4 - estH > 8) top = r.top - 4 - estH
      setPos({ top, left, W })
    }
    compute()
    window.addEventListener('scroll', compute, true)
    window.addEventListener('resize', compute)
    return () => { window.removeEventListener('scroll', compute, true); window.removeEventListener('resize', compute) }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const toggle = (val) => {
    const next = new Set(excluded)
    if (next.has(val)) next.delete(val)
    else next.add(val)
    onChange(next)
  }
  const checkAll = () => onChange(new Set())
  const uncheckAll = () => onChange(new Set(options))

  return (
    <span className="col-filter">
      <button
        ref={btnRef}
        type="button"
        className={`col-filter-btn ${hasFilter ? 'active' : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        title={hasFilter ? `Filter active: ${shownCount} of ${options.length} shown` : `Filter ${label}`}
        aria-label={`Filter ${label}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M3 4h18l-7 8.5V21l-4-2.5v-6z" />
        </svg>
        {hasFilter ? <span className="col-filter-badge">{shownCount}</span> : null}
      </button>
      {open && pos && createPortal(
        <>
          <div className="col-filter-backdrop" onClick={() => setOpen(false)} />
          <div
            className="col-filter-menu"
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.W }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="col-filter-head">
              <strong>Filter by {label}</strong>
            </div>
            {showSearch && (
              <div className="col-filter-search">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  autoFocus
                />
              </div>
            )}
            <div className="col-filter-actions">
              <button type="button" onClick={checkAll} disabled={excluded.size === 0}>Select all</button>
              <button type="button" onClick={uncheckAll} disabled={excluded.size === options.length}>Clear</button>
            </div>
            <div className="col-filter-list">
              {visible.length === 0 ? (
                <div className="col-filter-empty">No matches</div>
              ) : (
                visible.map((opt) => (
                  <label key={opt} className="col-filter-row">
                    <input
                      type="checkbox"
                      checked={!excluded.has(opt)}
                      onChange={() => toggle(opt)}
                    />
                    <span>{opt || '(blank)'}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </span>
  )
}

// Hook that bundles the "excluded" Set state + the helpers a column filter
// needs. `rows` is the source list, `accessor` pulls the cell value from a row.
//  - options: sorted unique values (for the dropdown)
//  - excluded / setExcluded: the Set state
//  - pass(row): true if the row survives this filter
//  - key: stable string for pager resetKey deps
export function useColFilter(rows, accessor, { blank = '(blank)' } = {}) {
  const [excluded, setExcluded] = useState(() => new Set())
  const val = (r) => {
    const v = accessor(r)
    return v === undefined || v === null || v === '' ? blank : v
  }
  const options = useMemo(() => {
    const s = new Set(rows.map(val))
    return [...s].sort((a, b) => String(a).localeCompare(String(b)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])
  const pass = (r) => excluded.size === 0 || !excluded.has(val(r))
  const key = [...excluded].join('|')
  return { options, excluded, setExcluded, pass, key }
}
