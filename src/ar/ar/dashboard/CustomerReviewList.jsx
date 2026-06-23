// Customer-level review modal. Used for "Churned" / "Declining" alerts
// on Overview - replaces the previous invoice-dump drilldown so the user
// sees a tidy account list (status, last activity, YoY revenue, outstanding,
// quick links) instead of hundreds of rows.

import { useMemo, useState, useEffect } from 'react'
import { useNav } from '../lib/navigation.jsx'
import { money, compactMoney, num, shortDate } from '../lib/format.js'
import { ExportButton } from '../lib/csv.jsx'

const STATUS_CLASS = {
  'Churned':    'review-status-churned',
  'Declining':  'review-status-declining',
  'At risk':    'review-status-warn',
  'Dormant':    'review-status-warn',
  'Active':     'review-status-ok',
}

const SORTS = [
  { id: 'priority',  label: 'Priority (worst first)' },
  { id: 'pySales',   label: 'Biggest prior-year' },
  { id: 'lifetime',  label: 'Biggest lifetime' },
  { id: 'silent',    label: 'Most days silent' },
  { id: 'outstanding', label: 'Largest outstanding' },
]

export default function CustomerReviewList() {
  const { customerReview, closeCustomerReview, openCustomer, openInvoiceList } = useNav()
  const [sortBy, setSortBy] = useState('priority')

  // Match the other modals: Escape closes, and lock background scroll while open.
  useEffect(() => {
    if (!customerReview) return
    const handler = (e) => { if (e.key === 'Escape') closeCustomerReview() }
    document.addEventListener('keydown', handler)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = prev
    }
  }, [customerReview, closeCustomerReview])

  if (!customerReview) return null

  const { title, subtitle, customers, summary, drill } = customerReview

  return (
    <div className="modal-overlay" onClick={closeCustomerReview}>
      <div
        className="modal modal-lg customer-review"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <div className="modal-head-inner">
            <div>
              <div className="modal-eyebrow">REVIEW LIST</div>
              <h3 className="modal-title">{title}</h3>
              {subtitle && <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{subtitle}</div>}
            </div>
          </div>
          <button className="modal-close" onClick={closeCustomerReview} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </header>

        <div className="modal-body">
          {summary && summary.length > 0 && (
            <section className="modal-kpis">
              {summary.map((s, i) => (
                <div key={i} className="modal-kpi">
                  <div className="modal-kpi-label">{s.label}</div>
                  <div className={`modal-kpi-val ${s.tone ? `is-${s.tone}` : ''}`}>{s.value}</div>
                  {s.sub && <div className="modal-kpi-sub">{s.sub}</div>}
                </div>
              ))}
            </section>
          )}

          <ReviewBody
            customers={customers}
            sortBy={sortBy}
            setSortBy={setSortBy}
            openCustomer={openCustomer}
            openInvoiceList={openInvoiceList}
            drill={drill}
          />
        </div>
      </div>
    </div>
  )
}

function ReviewBody({ customers, sortBy, setSortBy, openCustomer, openInvoiceList, drill }) {
  const isBrand = drill === 'brand'
  // Brand rows aren't real customers - clicking drills into the brand's stores
  // (and their invoice detail) instead of opening a (nonexistent) profile.
  const onRow = (c) => {
    if (isBrand) {
      const name = c.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')
      openInvoiceList({
        title: `${name} · stores`,
        subtitle: `${(c.invoices || []).length} invoices`,
        invoices: c.invoices || [],
        hideBrandLevel: true,
      })
    } else {
      openCustomer(c.vendor)
    }
  }
  const sorted = useMemo(() => {
    const list = [...customers]
    switch (sortBy) {
      case 'pySales':     list.sort((a, b) => (b.pySales || 0)     - (a.pySales || 0));     break
      case 'lifetime':    list.sort((a, b) => (b.lifetime || 0)    - (a.lifetime || 0));    break
      case 'silent':      list.sort((a, b) => (b.daysSilent || 0)  - (a.daysSilent || 0));  break
      case 'outstanding': list.sort((a, b) => (b.outstanding || 0) - (a.outstanding || 0)); break
      default: {
        // Priority - combine prior-year value (lost revenue) with days silent
        list.sort((a, b) => {
          const sa = (a.pySales || 0) + (a.daysSilent || 0) * 100
          const sb = (b.pySales || 0) + (b.daysSilent || 0) * 100
          return sb - sa
        })
      }
    }
    return list
  }, [customers, sortBy])

  const exportRows = sorted.map((c) => [
    c.vendor,
    c.status || '',
    c.lastOrder ? c.lastOrder.toISOString().slice(0, 10) : '',
    c.daysSilent ?? '',
    (c.pySales || 0).toFixed(2),
    (c.cySales || 0).toFixed(2),
    c.yoyPct != null ? c.yoyPct.toFixed(1) : '',
    (c.lifetime || 0).toFixed(2),
    (c.outstanding || 0).toFixed(2),
    c.email || '',
  ])

  return (
    <>
      <div className="modal-toolbar">
        <div className="select-filter">
          <span className="select-label">Sort by</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <ExportButton
          filename={`customer-review-${new Date().toISOString().slice(0,10)}.csv`}
          headers={['Customer', 'Status', 'Last invoice', 'Days silent', 'Prior year', 'This year', 'YoY %', 'Lifetime', 'Outstanding', 'Email']}
          rows={exportRows}
        />
      </div>

      <div className="modal-table-wrap">
        <table className="data-table compact">
          <thead>
            <tr>
              <th>{isBrand ? 'Brand' : 'Customer'}</th>
              <th>Status</th>
              <th>Last invoice</th>
              <th className="num">Days silent</th>
              <th className="num">Prior year</th>
              <th className="num">This year</th>
              <th className="num">YoY</th>
              <th className="num">Lifetime</th>
              <th className="num">Outstanding</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr><td colSpan="10" className="table-empty">Nothing here - clean book.</td></tr>
            )}
            {sorted.map((c) => {
              const display = c.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')
              return (
                <tr key={c.vendor} className="clickable-row" onClick={() => onRow(c)}>
                  <td className="vendor-cell">{display}</td>
                  <td>
                    {c.status && (
                      <span className={`review-status-pill ${STATUS_CLASS[c.status] || ''}`}>{c.status}</span>
                    )}
                  </td>
                  <td className="muted">{shortDate(c.lastOrder)}</td>
                  <td className="num">{c.daysSilent != null ? num(c.daysSilent) : '-'}</td>
                  <td className="num">{compactMoney(c.pySales || 0)}</td>
                  <td className="num">{compactMoney(c.cySales || 0)}</td>
                  <td className="num">
                    {c.yoyPct != null
                      ? <span className={c.yoyPct < 0 ? 'cell-warn' : ''}>{c.yoyPct >= 0 ? '+' : ''}{c.yoyPct.toFixed(0)}%</span>
                      : '-'}
                  </td>
                  <td className="num muted">{compactMoney(c.lifetime || 0)}</td>
                  <td className={`num ${c.outstanding > 0 ? 'cell-warn' : 'muted'}`}>
                    {c.outstanding > 0 ? money(c.outstanding, true) : '-'}
                  </td>
                  <td className="action-cell">
                    {c.email && (
                      <a
                        href={`mailto:${c.email.split(/[,\n]/)[0].trim()}?subject=Reaching out from Little Tree`}
                        className="action-link"
                        title="Email"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6"/>
                          <path d="M3 7l9 6 9-6" stroke="currentColor" strokeWidth="1.6"/>
                        </svg>
                      </a>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
