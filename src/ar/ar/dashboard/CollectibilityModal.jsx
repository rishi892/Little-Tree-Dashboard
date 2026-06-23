import { useEffect, useState, useMemo } from 'react'
import { money, shortDate, num } from '../lib/format.js'
import { naturalUncollectable, riskAmt } from '../lib/dso.js'
import { useOverrides, setOverride } from '../lib/arOverrides.js'

// Reclassify individual invoices as Collectible / Uncollectable. The choice is
// persisted and feeds straight back into Operating DSO and the Uncollectable %
// metric (e.g. mark an in-collections invoice "Collectible" and DSO starts
// counting it again).
export default function CollectibilityModal({ rows = [], onClose, title = 'Reclassify collectibility' }) {
  const overrides = useOverrides()
  const [q, setQ] = useState('')

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', h); document.body.style.overflow = prev }
  }, [onClose])

  const reasonOf = (r) => r.isWriteOff ? 'Write-off'
    : r.isCollection ? 'In collections'
    : (r.daysOverdue || 0) > 180 ? `${num(r.daysOverdue)}d past due`
    : 'Open'

  const choose = (r, wantCollectible) => {
    const natural = naturalUncollectable(r) // true = naturally uncollectable
    if (wantCollectible) setOverride(r.invNo, natural ? 'collectible' : undefined)
    else setOverride(r.invNo, natural ? undefined : 'doubtful')
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? rows.filter((r) => (r.vendor || '').toLowerCase().includes(needle) || (r.invNo || '').toLowerCase().includes(needle))
      : rows
    return [...list].sort((a, b) => riskAmt(b) - riskAmt(a))
  }, [rows, q, overrides])

  const reincluded = rows.filter((r) => overrides[r.invNo] === 'collectible')
  const forcedDoubtful = rows.filter((r) => overrides[r.invNo] === 'doubtful')
  const uncollNow = rows.filter((r) => {
    const ov = overrides[r.invNo]
    return ov === 'doubtful' || (ov !== 'collectible' && naturalUncollectable(r))
  })
  const uncollAmt = uncollNow.reduce((s, r) => s + riskAmt(r), 0)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head" style={{ position: 'relative' }}>
          <div className="modal-head-inner">
            <div>
              <div className="modal-eyebrow">Collectibility</div>
              <h3 className="modal-title">{title}</h3>
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                Mark each invoice Collectible or Uncollectable. Collectible invoices are counted again in Operating DSO.
              </div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </header>

        <div className="modal-body">
          <section className="modal-kpis">
            <div className="modal-kpi">
              <div className="modal-kpi-label">Uncollectable now</div>
              <div className="modal-kpi-val is-warn">{money(uncollAmt)}</div>
              <div className="modal-kpi-sub">{num(uncollNow.length)} invoices</div>
            </div>
            <div className="modal-kpi">
              <div className="modal-kpi-label">Marked collectible</div>
              <div className="modal-kpi-val" style={{ color: '#15803d' }}>{num(reincluded.length)}</div>
              <div className="modal-kpi-sub">re-included in DSO</div>
            </div>
            <div className="modal-kpi">
              <div className="modal-kpi-label">Marked doubtful</div>
              <div className="modal-kpi-val" style={{ color: '#dc2626' }}>{num(forcedDoubtful.length)}</div>
              <div className="modal-kpi-sub">forced out of DSO</div>
            </div>
          </section>

          <div className="modal-toolbar" style={{ marginBottom: 12 }}>
            <div />
            <input type="search" className="table-search" placeholder="Search invoice or customer…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <div className="modal-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Inv #</th>
                  <th>Customer</th>
                  <th>Date</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Classify</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={6} className="table-empty">No invoices to reclassify.</td></tr>}
                {shown.map((r) => {
                  const ov = overrides[r.invNo]
                  const uncoll = ov === 'doubtful' || (ov !== 'collectible' && naturalUncollectable(r))
                  return (
                    <tr key={r.invNo}>
                      <td className="mono">{r.invNo}</td>
                      <td className="vendor-cell">{(r.vendor || '').replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                      <td className="muted">{r.date ? shortDate(r.date) : ''}</td>
                      <td className="num">{money(riskAmt(r), true)}</td>
                      <td><span className="muted" style={{ fontSize: 12 }}>{reasonOf(r)}{ov ? ' · overridden' : ''}</span></td>
                      <td>
                        {r.isWriteOff ? (
                          <span style={{ fontSize: 12, fontWeight: 600, color: '#dc2626' }} title="Write-offs are always uncollectable and cannot be reclassified">Uncollectable (write-off)</span>
                        ) : (
                          <div className="seg-filter" role="group" style={{ display: 'inline-flex' }}>
                            <button type="button" className={uncoll ? 'is-active' : ''} onClick={() => choose(r, false)}
                              style={uncoll ? { background: '#dc2626', color: '#fff' } : undefined}>Uncollectable</button>
                            <button type="button" className={!uncoll ? 'is-active' : ''} onClick={() => choose(r, true)}
                              style={!uncoll ? { background: '#15803d', color: '#fff' } : undefined}>Collectible</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
