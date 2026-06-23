import { useEffect, useMemo, useState, useRef } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { money, num, shortDate, monthKey, monthLabel, compactMoney } from '../lib/format.js'
import { isPureXVendor } from '../lib/brands.js'
import { usePager, Pager } from '../lib/pagination.jsx'

const BUCKET_CLASS = {
  'Current': 'bucket-upcoming',
  '1–30': 'bucket-current',
  '31–60': 'bucket-1',
  '61–90': 'bucket-2',
  '91–120': 'bucket-3',
  '121–180': 'bucket-4',
  '180+': 'bucket-5',
}

export default function CustomerProfile({ data, vendor, book = 'lt', onClose }) {
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = prev
    }
  }, [onClose])

  const profile = useMemo(() => {
    // Books are kept fully separate - a customer profile shows ONLY the active
    // book's invoices, never both mixed. Pure X = the Gelato sheet (+ any
    // "Gelato-" prefixed tracker rows). Little Tree = the wholesale tracker minus
    // those Pure X rows. (Channel is decided by the SHEET, not the name prefix -
    // the Gelato sheet often still uses a "Little Tree-" vendor prefix.)
    const isPurex = book === 'purex'
    const ltInvoices = data.invoices.filter((r) => r.vendor === vendor && !isPureXVendor(r.vendor))
    const purexInvoices = [
      ...(data.gelato || []).filter((r) => r.vendor === vendor),
      ...data.invoices.filter((r) => r.vendor === vendor && isPureXVendor(r.vendor)),
    ]
    const allInvoices = (isPurex ? purexInvoices : ltInvoices)
      .map((r) => ({ ...r, channel: isPurex ? 'gelato' : 'wholesale' }))

    // Sales record: LT pulls from the financials sheet; Pure X uses its own sheet.
    const finRows = isPurex
      ? purexInvoices
      : data.financials.filter((r) => r.vendor === vendor && !isPureXVendor(r.vendor))

    // Aggregate stats
    const totalSales = finRows.reduce((s, r) => s + r.invoiceAmount, 0)
    const totalPaid = finRows.reduce((s, r) => s + r.invoicePaid, 0)
    const outstanding = allInvoices.filter((r) => r.isOutstanding).reduce((s, r) => s + r.outstanding, 0)
    const openCount = allInvoices.filter((r) => r.isOutstanding).length
    const closedCount = allInvoices.filter((r) => !r.isOutstanding).length

    // Contact info - last non-empty across invoices
    const sorted = [...allInvoices].sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
    let salesRep = '', email = '', contactNumber = '', brand = ''
    sorted.forEach((r) => {
      if (!salesRep && r.salesRep) salesRep = r.salesRep
      if (!email && r.email) email = r.email
      if (!contactNumber && r.contactNumber) contactNumber = r.contactNumber
      if (!brand && r.brand) brand = r.brand
    })

    // Last order
    const lastOrder = sorted[0]?.date || null
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const daysSilent = lastOrder ? Math.floor((today - lastOrder) / 86400000) : null

    // Payment behavior - DSO weighted by INVOICE amount (matches the
    // global DSO formula used on Overview + LT A/R top card):
    //   DSO = Σ(days_to_pay × invoiceAmount) ÷ Σ(invoiceAmount)
    // Excludes collection / write-off invoices.
    let paidDays = 0, paidAmt = 0, paidN = 0, onTime = 0, late = 0
    allInvoices.forEach((r) => {
      if (r.isCollection || r.isWriteOff) return
      if (r.isPaid && r.paidDate && r.date) {
        const d = (r.paidDate - r.date) / 86400000
        if (d >= 0 && d <= 1825) {
          paidDays += d * r.invoiceAmount
          paidAmt += r.invoiceAmount
          paidN += 1
          if (r.dueDate && r.paidDate <= r.dueDate) onTime++
          else late++
        }
      }
    })
    const avgDso = paidAmt > 0 ? paidDays / paidAmt : 0
    const onTimePct = (onTime + late) > 0 ? (onTime / (onTime + late)) * 100 : 0
    const grade = (() => {
      if (avgDso === 0) return ''
      if (avgDso < 30 && onTimePct >= 80) return 'A'
      if (avgDso < 45) return 'B'
      if (avgDso < 75) return 'C'
      return 'D'
    })()

    // Monthly sales trend (last 18 months)
    const monthMap = new Map()
    finRows.forEach((r) => {
      const k = monthKey(r.date)
      if (!k) return
      const cur = monthMap.get(k) || { key: k, sales: 0, paid: 0 }
      cur.sales += r.invoiceAmount
      cur.paid += r.invoicePaid
      monthMap.set(k, cur)
    })
    const trend = [...monthMap.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(-18)

    // YoY
    const cy = today.getFullYear()
    const cySales = finRows.filter((r) => r.date?.getFullYear() === cy).reduce((s, r) => s + r.invoiceAmount, 0)
    const pySales = finRows.filter((r) => r.date?.getFullYear() === cy - 1).reduce((s, r) => s + r.invoiceAmount, 0)
    const yoyPct = pySales > 0 ? ((cySales - pySales) / pySales) * 100 : null

    return {
      allInvoices, finRows, salesRep, email, contactNumber, brand,
      totalSales, totalPaid, outstanding, openCount, closedCount,
      lastOrder, daysSilent, avgDso, onTimePct, grade, paidN,
      trend, cySales, pySales, yoyPct, cy,
    }
  }, [data, vendor, book])

  const filteredInvoices = useMemo(() => {
    const list = profile.allInvoices
    let result
    if (filter === 'open') result = list.filter((r) => r.isOutstanding)
    else if (filter === 'closed') result = list.filter((r) => !r.isOutstanding)
    else if (filter === 'ytd') result = list.filter((r) => r.date && r.date.getFullYear() === profile.cy)
    else result = list
    return [...result].sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))
  }, [profile.allInvoices, filter, profile.cy])

  const pager = usePager(filteredInvoices.length, 50, `${vendor}|${book}|${filter}`)

  // Card → drill: scope the invoice table and scroll it into view.
  const tableRef = useRef(null)
  const showInTable = (f) => {
    setFilter(f)
    requestAnimationFrame(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const displayName = vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg customer-profile" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-head-inner">
            <div className="customer-avatar">{displayName.charAt(0).toUpperCase()}</div>
            <div>
              <div className="modal-eyebrow">
                {profile.brand && <span>{profile.brand}</span>}
                {profile.salesRep && <span> · Rep: {profile.salesRep}</span>}
                {profile.grade && <span className={`grade-pill grade-${profile.grade}`} style={{ marginLeft: 10 }}>{profile.grade}</span>}
              </div>
              <h3 className="modal-title">{displayName}</h3>
              <div className="customer-contact">
                {profile.email && <a href={`mailto:${profile.email.split(/[,\n]/)[0].trim()}`}>{profile.email.split(/[,\n]/)[0].trim()}</a>}
                {profile.contactNumber && <span className="muted"> · {profile.contactNumber}</span>}
                <a
                  className="map-link"
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(displayName + ' Michigan')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Find "${displayName}" on Google Maps`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 21s-7-6.5-7-11a7 7 0 0114 0c0 4.5-7 11-7 11z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
                    <circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="2"/>
                  </svg>
                  Find on map
                </a>
              </div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
        </header>

        <div className="modal-body">
          {/* KPI grid */}
          <section className="modal-kpis profile-kpis">
            <div className="modal-kpi is-clickable" role="button" tabIndex={0} onClick={() => showInTable('all')} title="See all invoices">
              <div className="modal-kpi-label">Lifetime sales</div>
              <div className="modal-kpi-val">{money(profile.totalSales)}</div>
              <div className="modal-kpi-sub">{num(profile.finRows.length)} sales records</div>
            </div>
            <div className="modal-kpi is-clickable" role="button" tabIndex={0} onClick={() => showInTable('closed')} title="See closed (paid) invoices">
              <div className="modal-kpi-label">Total paid</div>
              <div className="modal-kpi-val is-good">{money(profile.totalPaid)}</div>
              <div className="modal-kpi-sub">{num(profile.closedCount)} closed</div>
            </div>
            <div className="modal-kpi is-clickable" role="button" tabIndex={0} onClick={() => showInTable('open')} title="See open invoices">
              <div className="modal-kpi-label">Outstanding</div>
              <div className={`modal-kpi-val ${profile.outstanding > 0 ? 'is-warn' : ''}`}>
                {profile.outstanding > 0 ? money(profile.outstanding) : '$0'}
              </div>
              <div className="modal-kpi-sub">{num(profile.openCount)} open</div>
            </div>
            <div className="modal-kpi is-clickable" role="button" tabIndex={0} onClick={() => showInTable('closed')} title="See the paid invoices behind DSO">
              <div className="modal-kpi-label">Avg DSO</div>
              <div className="modal-kpi-val">{profile.paidN > 0 ? `${profile.avgDso.toFixed(0)}d` : ''}</div>
              <div className="modal-kpi-sub">
                {profile.paidN > 0 ? `${profile.onTimePct.toFixed(0)}% on-time · ${profile.paidN} paid` : 'No payment history'}
              </div>
            </div>
            <div className="modal-kpi is-clickable" role="button" tabIndex={0} onClick={() => showInTable('ytd')} title={`See ${profile.cy} invoices`}>
              <div className="modal-kpi-label">{profile.cy} YTD</div>
              <div className="modal-kpi-val">{compactMoney(profile.cySales)}</div>
              <div className="modal-kpi-sub">
                {profile.yoyPct != null
                  ? `${profile.yoyPct >= 0 ? '+' : ''}${profile.yoyPct.toFixed(0)}% YoY`
                  : profile.pySales === 0 ? 'No prior year' : ''}
              </div>
            </div>
            <div className="modal-kpi is-clickable" role="button" tabIndex={0} onClick={() => showInTable('all')} title="See all invoices (newest first)">
              <div className="modal-kpi-label">Last order</div>
              <div className="modal-kpi-val" style={{ fontSize: 18 }}>
                {profile.lastOrder ? shortDate(profile.lastOrder) : 'Never'}
              </div>
              <div className="modal-kpi-sub">
                {profile.daysSilent != null ? `${profile.daysSilent} days ago` : ''}
              </div>
            </div>
          </section>

          {/* Trend chart */}
          {profile.trend.length > 1 && (
            <div className="chart-card profile-chart">
              <div className="chart-head">
                <h3>Monthly sales trend</h3>
                <span className="chart-sub">Last {profile.trend.length} months</span>
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={profile.trend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="key" tickFormatter={(k) => monthLabel(k, { short: true })} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(k) => monthLabel(k)}
                    formatter={(v) => money(v)}
                  />
                  <Line type="monotone" dataKey="sales" stroke="#15803d" strokeWidth={2} dot={{ r: 2.5 }} name="Invoiced" />
                  <Line type="monotone" dataKey="paid" stroke="#16a34a" strokeWidth={2} dot={{ r: 2.5 }} name="Paid" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Invoice list */}
          <div className="modal-toolbar" ref={tableRef}>
            <div className="tab-filter">
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
                All <span className="tab-count">{profile.allInvoices.length}</span>
              </button>
              <button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>
                Open <span className="tab-count">{profile.openCount}</span>
              </button>
              <button className={filter === 'closed' ? 'active' : ''} onClick={() => setFilter('closed')}>
                Closed <span className="tab-count">{profile.closedCount}</span>
              </button>
              <button className={filter === 'ytd' ? 'active' : ''} onClick={() => setFilter('ytd')}>
                {profile.cy} <span className="tab-count">{profile.allInvoices.filter((r) => r.date && r.date.getFullYear() === profile.cy).length}</span>
              </button>
            </div>
          </div>

          <div className="modal-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Inv #</th>
                  <th>Channel</th>
                  <th>Date</th>
                  <th className="num">Amount</th>
                  <th className="num">Paid</th>
                  <th className="num">Outstanding</th>
                  <th>Status</th>
                  <th>Days past due</th>
                  <th>Due</th>
                  <th>Paid date</th>
                </tr>
              </thead>
              <tbody>
                {filteredInvoices.length === 0 && <tr><td colSpan="10" className="table-empty">No invoices match.</td></tr>}
                {filteredInvoices.slice(pager.start, pager.end).map((r, i) => (
                  <tr key={`${r.channel}-${r.invNo}-${i}`}>
                    <td className="mono">{r.invNo}</td>
                    <td><span className={`channel-pill ${r.channel === 'gelato' ? 'channel-gelato' : 'channel-wholesale'}`}>{r.channel === 'gelato' ? 'Gelato' : 'Little Tree'}</span></td>
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
          <Pager {...pager} total={filteredInvoices.length} />
        </div>
      </div>
    </div>
  )
}
