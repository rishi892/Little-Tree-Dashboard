import { useState, useMemo } from 'react'
import { money, shortDate } from '../lib/format.js'
import { ExportButton } from '../lib/csv.jsx'
import { usePager, Pager } from '../lib/pagination.jsx'
import { ColumnFilter, useColFilter } from './components/ColumnFilter.jsx'

import { useNav } from '../lib/navigation.jsx'


const BUCKET_CLASS = {
  'Current': 'bucket-upcoming',
  '1–30': 'bucket-current',
  '31–60': 'bucket-1',
  '61–90': 'bucket-2',
  '91–120': 'bucket-3',
  '121–180': 'bucket-4',
  '180+': 'bucket-5',
}

export default function InvoiceTable({ invoices, limit = 100 }) {
  const { openCustomer } = useNav()
  const [q, setQ] = useState('')

  const [sort, setSort] = useState({ key: 'daysOverdue', dir: 'desc' })

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let filtered = invoices
    if (needle) {
      filtered = invoices.filter((r) =>
        r.vendor.toLowerCase().includes(needle) ||
        r.invNo.toLowerCase().includes(needle) ||
        r.salesRep.toLowerCase().includes(needle) ||
        r.brand.toLowerCase().includes(needle)
      )
    }
    const { key, dir } = sort
    const factor = dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (av < bv) return -1 * factor
      if (av > bv) return 1 * factor
      return 0
    })
  }, [invoices, q, sort])

  // Spreadsheet-style column filters.
  const vendorF = useColFilter(rows, (r) => r.vendor)
  const bucketF = useColFilter(rows, (r) => r.agingBucket)
  const statusF = useColFilter(rows, (r) => r.isOutstanding ? (r.invoicePaid > 0 ? 'Partial' : 'Open') : (r.isWriteOff ? 'Write-off' : 'Paid'))
  const followF = useColFilter(rows, (r) => r.followUpStatus)
  const shown = useMemo(
    () => rows.filter(vendorF.pass).filter(bucketF.pass).filter(statusF.pass).filter(followF.pass),
    [rows, vendorF, bucketF, statusF, followF]
  )

  const pager = usePager(shown.length, limit, `${q}|${sort.key}|${sort.dir}|${vendorF.key}|${bucketF.key}|${statusF.key}|${followF.key}`)


  const toggleSort = (key) => {
    setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' })
  }

  const arrow = (key) => sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const today10 = new Date().toISOString().slice(0, 10)
  return (
    <div className="table-card">
      <div className="table-head">
        <h3>Outstanding invoices</h3>
        <div className="table-head-tools">
          <input
            type="search"
            className="table-search"
            placeholder="Search vendor, inv #, rep…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ExportButton
            filename={`outstanding-invoices-${today10}.csv`}
            headers={['Invoice #', 'Date', 'Paid date', 'Vendor', 'Outstanding', 'Days Overdue', 'Bucket', 'Status', 'Follow-up']}
            rows={rows.map((r) => [r.invNo, r.date ? r.date.toISOString().slice(0, 10) : '', r.paidDate ? r.paidDate.toISOString().slice(0, 10) : '', r.vendor, r.outstanding.toFixed(2), r.daysOverdue ?? '', r.agingBucket, r.status, r.followUpStatus])}
          />
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort('invNo')}>Inv #{arrow('invNo')}</th>
              <th onClick={() => toggleSort('date')}>Date{arrow('date')}</th>
              <th onClick={() => toggleSort('paidDate')}>Paid date{arrow('paidDate')}</th>
              <th>Vendor
                <ColumnFilter label="Vendor" options={vendorF.options} excluded={vendorF.excluded} onChange={vendorF.setExcluded} />
              </th>

              <th className="num" onClick={() => toggleSort('outstanding')}>Outstanding{arrow('outstanding')}</th>
              <th className="num" onClick={() => toggleSort('daysOverdue')}>Days past due{arrow('daysOverdue')}</th>
              <th>Bucket <ColumnFilter label="Bucket" options={bucketF.options} excluded={bucketF.excluded} onChange={bucketF.setExcluded} /></th>
              <th>Status <ColumnFilter label="Status" options={statusF.options} excluded={statusF.excluded} onChange={statusF.setExcluded} /></th>
              <th>Follow-up <ColumnFilter label="Follow-up" options={followF.options} excluded={followF.excluded} onChange={followF.setExcluded} /></th>

            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan="9" className="table-empty">No matching invoices.</td></tr>
            )}
            {shown.slice(pager.start, pager.end).map((r, i) => (

              <tr key={`${r.invNo}-${i}`} className="clickable-row" onClick={() => openCustomer(r.vendor)} title={`Open ${r.vendor.replace(/^Little Tree-\s*/i, '')}`}>

                <td className="mono">{r.invNo}</td>
                <td>{shortDate(r.date)}</td>
                <td className={r.paidDate ? '' : 'muted'}>{r.paidDate ? shortDate(r.paidDate) : '-'}</td>
                <td className="vendor-cell">{r.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                <td className="num">{money(r.outstanding, true)}</td>
                <td className="num">{r.daysOverdue != null ? r.daysOverdue : ''}</td>
                <td><span className={`bucket-pill ${BUCKET_CLASS[r.agingBucket] || ''}`}>{r.agingBucket}</span></td>
                <td>
                  <span
                    className={`status-pill ${r.isOutstanding ? (r.invoicePaid > 0 ? 'status-partial' : 'status-open') : 'status-closed'}`}
                    title={r.isOutstanding && r.invoicePaid > 0 ? `${money(r.invoicePaid, true)} paid of ${money(r.invoiceAmount, true)} · ${money(r.outstanding, true)} still due` : undefined}
                  >
                    {r.isOutstanding ? (r.invoicePaid > 0 ? 'Partial' : 'Open') : (r.isWriteOff ? 'Write-off' : 'Paid')}
                  </span>
                </td>
                <td className="muted">{r.followUpStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager {...pager} total={shown.length} />

    </div>
  )
}
