import { useState, useEffect } from 'react'
import { num } from './format.js'

// Reusable client-side pagination for long tables (replaces hard "show top N"
// caps). `resetKey` should change whenever the filtered/sorted set changes so
// the view snaps back to page 1.
export function usePager(total, pageSize = 50, resetKey = '') {
  const [page, setPage] = useState(1)
  useEffect(() => { setPage(1) }, [resetKey])
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * pageSize
  const end = Math.min(start + pageSize, total)
  return { page: safePage, setPage, totalPages, start, end }
}

export function Pager({ page, setPage, totalPages, start, end, total }) {
  if (total === 0) return null
  // Windowed page numbers: 1 … 4 5 [6] 7 8 … 20
  const nums = []
  if (totalPages <= 7) { for (let p = 1; p <= totalPages; p++) nums.push(p) }
  else {
    nums.push(1)
    if (page > 4) nums.push('…')
    for (let p = Math.max(2, page - 1); p <= Math.min(totalPages - 1, page + 1); p++) nums.push(p)
    if (page < totalPages - 3) nums.push('…')
    nums.push(totalPages)
  }
  return (
    <div className="modal-pagination">
      <span className="page-info">{num(start + 1)}–{num(end)} of {num(total)}</span>
      {totalPages > 1 && (
        <div className="pager">
          <button className="pager-step" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
          {nums.map((p, i) =>
            p === '…'
              ? <span key={`e${i}`} className="pager-ellipsis">…</span>
              : <button key={p} className={`pager-num ${p === page ? 'is-active' : ''}`} onClick={() => setPage(p)}>{p}</button>
          )}
          <button className="pager-step" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next ›</button>
        </div>
      )}
    </div>
  )
}
