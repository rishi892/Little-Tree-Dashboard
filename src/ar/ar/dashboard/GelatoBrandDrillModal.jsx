import { useMemo, useState, useEffect } from 'react'
import { money, num, shortDate } from '../lib/format.js'

const stripPfx = (v) => String(v || '').replace(/^(Little Tree|Gelato)-\s*/i, '')

const BUCKET_CLASS = {
  'Current': 'bucket-upcoming', '1–30': 'bucket-current', '31–60': 'bucket-1',
  '61–90': 'bucket-2', '91–120': 'bucket-3', '121–180': 'bucket-4', '180+': 'bucket-5',
}

// Brand → Store → Invoices drill for Gelato "By Brand" mode. Opens when a brand
// row is clicked on any Gelato page; lists the brand's stores, then a store's
// invoices. Reads the ORIGINAL (un-collapsed) gelato rows so store identity is
// preserved even though the page tables are grouped by brand.
export default function GelatoBrandDrillModal({ brand, gelato, onClose }) {
  const [store, setStore] = useState(null)

  const rows = useMemo(
    () => (gelato || []).filter((r) => (r.gelatoBrand || 'No brand') === brand),
    [gelato, brand]
  )

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') { if (store) setStore(null); else onClose() } }
    document.addEventListener('keydown', h)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', h); document.body.style.overflow = prev }
  }, [onClose, store])

  const stores = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const v = r.vendor || '—'
      const c = m.get(v) || { vendor: v, invoiced: 0, paid: 0, outstanding: 0, openCount: 0, count: 0 }
      c.invoiced += r.invoiceAmount || 0
      c.paid += r.invoicePaid || 0
      if (r.isOutstanding) { c.outstanding += r.outstanding || 0; c.openCount += 1 }
      c.count += 1
      m.set(v, c)
    }
    return [...m.values()].sort((a, b) => (b.outstanding - a.outstanding) || (b.invoiced - a.invoiced))
  }, [rows])

  const storeInvoices = useMemo(
    () => store ? [...rows].filter((r) => r.vendor === store).sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0)) : [],
    [rows, store]
  )

  const totals = useMemo(() => {
    const invoiced = rows.reduce((s, r) => s + (r.invoiceAmount || 0), 0)
    const paid = rows.reduce((s, r) => s + (r.invoicePaid || 0), 0)
    const outstanding = rows.filter((r) => r.isOutstanding).reduce((s, r) => s + (r.outstanding || 0), 0)
    return { invoiced, paid, outstanding }
  }, [rows])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-head-inner">
            {store && (
              <button className="modal-back" onClick={() => setStore(null)} aria-label="Back">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            )}
            <div>
              <div className="modal-eyebrow">{store ? 'Store' : 'Brand'}</div>
              <h3 className="modal-title">{store ? stripPfx(store) : brand}</h3>
              {!store && <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{num(stores.length)} stores · {num(rows.length)} invoices</div>}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </header>

        <div className="modal-body">
          {!store ? (
            <>
              <section className="modal-kpis">
                <div className="modal-kpi"><div className="modal-kpi-label">Total invoiced</div><div className="modal-kpi-val">{money(totals.invoiced)}</div><div className="modal-kpi-sub">{num(stores.length)} stores</div></div>
                <div className="modal-kpi"><div className="modal-kpi-label">Total paid</div><div className="modal-kpi-val is-good">{money(totals.paid)}</div></div>
                <div className="modal-kpi"><div className="modal-kpi-label">Outstanding</div><div className={`modal-kpi-val ${totals.outstanding > 0 ? 'is-warn' : ''}`}>{totals.outstanding > 0 ? money(totals.outstanding) : '$0'}</div></div>
              </section>
              <div className="modal-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr><th>Store</th><th className="num">Invoices</th><th className="num">Invoiced</th><th className="num">Paid</th><th className="num">Outstanding</th><th className="num">Open</th><th className="action-col"></th></tr>
                  </thead>
                  <tbody>
                    {stores.length === 0 && <tr><td colSpan="7" className="table-empty">No stores in this brand.</td></tr>}
                    {stores.map((s) => (
                      <tr key={s.vendor} className="clickable-row" onClick={() => setStore(s.vendor)}>
                        <td className="vendor-cell">{stripPfx(s.vendor)}</td>
                        <td className="num">{num(s.count)}</td>
                        <td className="num">{money(s.invoiced)}</td>
                        <td className="num muted">{money(s.paid)}</td>
                        <td className={`num ${s.outstanding > 0 ? 'cell-warn' : ''}`}>{s.outstanding > 0 ? money(s.outstanding) : ''}</td>
                        <td className="num">{s.openCount || ''}</td>
                        <td className="action-col"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="modal-table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Inv #</th><th>Date</th><th className="num">Amount</th><th className="num">Paid</th><th className="num">Outstanding</th><th>Status</th><th>Bucket</th><th>Due</th><th>Paid date</th></tr>
                </thead>
                <tbody>
                  {storeInvoices.length === 0 && <tr><td colSpan="9" className="table-empty">No invoices.</td></tr>}
                  {storeInvoices.map((r, i) => (
                    <tr key={`${r.invNo}-${i}`}>
                      <td className="mono">{r.invNo}</td>
                      <td>{shortDate(r.date)}</td>
                      <td className="num">{money(r.invoiceAmount, true)}</td>
                      <td className="num">{money(r.invoicePaid, true)}</td>
                      <td className={`num ${r.outstanding > 0 ? 'cell-warn' : ''}`}>{r.outstanding > 0 ? money(r.outstanding, true) : ''}</td>
                      <td><span className={`status-pill ${r.isOutstanding ? (r.invoicePaid > 0 ? 'status-partial' : 'status-open') : 'status-closed'}`}>{r.isOutstanding ? (r.invoicePaid > 0 ? 'Partial' : 'Open') : (r.isWriteOff ? 'Write-off' : 'Paid')}</span></td>
                      <td>{r.isOutstanding ? <span className={`bucket-pill ${BUCKET_CLASS[r.agingBucket] || ''}`}>{r.agingBucket}</span> : ''}</td>
                      <td className="muted">{shortDate(r.dueDate)}</td>
                      <td className={r.paidDate ? '' : 'muted'}>{r.paidDate ? shortDate(r.paidDate) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
