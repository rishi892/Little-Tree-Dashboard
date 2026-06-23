import { useEffect, useState, useMemo } from 'react'
import { money, shortDate, num } from '../lib/format.js'
import { useNav } from '../lib/navigation.jsx'
import { ExportButton } from '../lib/csv.jsx'
import { ColumnFilter, useColFilter } from './components/ColumnFilter.jsx'
import { keepInOperating, OP_MODES, opExclText } from '../lib/dso.js'
import { catchAllLast } from '../lib/brands.js'
import { useAgencyOverrides, getAgency, setAgency } from '../lib/arAgencyOverrides.js'
import { usePaymentStatus, getPaymentStatus, setPaymentStatus, isReceivedComplete, isPlanComplete, PAYMENT_OPTIONS } from '../lib/arPaymentStatus.js'

const BUCKET_CLASS = {
  'Current': 'bucket-upcoming',
  '1–30': 'bucket-current',
  '31–60': 'bucket-1',
  '61–90': 'bucket-2',
  '91–120': 'bucket-3',
  '121–180': 'bucket-4',
  '180+': 'bucket-5',
}

export default function InvoiceListModal({ title, subtitle, invoices: allInvoices, onClose, hideOutstanding = false, noYearFilter = false, hideBrandLevel = false, info, cutoffFilter = false, initialCutoff = 'within', comparison = null, initialMarked = false }) {
  const { openCustomer } = useNav()
  // Inline payment-status overrides. 'received' invoices leave the open book and
  // move to the "Payment received · not applied" card; 'plan' invoices stay open
  // but also show there. Read live from the store so edits update instantly.
  const payCache = usePaymentStatus()
  const payStatus = (r) => payCache[r.invNo]?.status || 'none'
  // A "received" flag only counts (leaves the open book, shows in the received
  // KPI) once its date + amount are filled. Until then the row stays Open and the
  // dropdown stays editable - just picking "Payment Received" does nothing yet.
  const isReceived = (r) => isReceivedComplete(payCache[r.invNo])
  const isMarked = (r) => payStatus(r) !== 'none'
  // Remaining-balance model (computed live from the store, so edits in this modal
  // update instantly): a received amount is subtracted from the gross balance, so
  // a PARTIAL receipt leaves the remainder open and a FULL receipt clears it.
  const grossOf = (r) => (r.outstandingGross ?? r.outstanding ?? 0)
  const recvOf = (r) => (isReceived(r) ? Math.min(Math.max(0, Number(payCache[r.invNo]?.receivedAmount) || 0), grossOf(r)) : 0)
  const remainingOf = (r) => Math.max(0, grossOf(r) - recvOf(r))
  // Open if the source sheet has it open AND a balance remains after receipts.
  const isOpenEff = (r) => (r.isOutstandingOrig ?? r.isOutstanding) && remainingOf(r) > 0
  const outOf = (r) => remainingOf(r)
  const payEnabled = !hideOutstanding
  // Which flagged subset the detail table is filtered to: 'received' | 'plan' |
  // 'all' | null (normal list). Pages can open straight into one via initialMarked.
  const [markedView, setMarkedView] = useState(initialMarked === true ? 'all' : (initialMarked || null))
  const agencyOverrides = useAgencyOverrides() // re-render when an agency name is saved
  const [yearSel, setYearSel] = useState(null) // null = all years
  const [cutoffSel, setCutoffSel] = useState(initialCutoff) // Operating scope: 'within' | 'over'
  // Month-over-month comparison view (for trend-point drills): null = this month's
  // full list, 'added' = only invoices that entered since last month, 'removed' =
  // invoices that left the bucket since last month.
  const [compareView, setCompareView] = useState(null)
  const compKey = (r) => r.invNo || `${r.vendor}|${r.date ? r.date.getTime() : ''}`
  const addedKeys = useMemo(() => new Set((comparison?.added || []).map(compKey)), [comparison])
  // Distinct years present (newest first) - drives the year filter.
  const years = useMemo(() => {
    const s = new Set()
    allInvoices.forEach((r) => { if (r.date) s.add(r.date.getFullYear()) })
    return [...s].sort((a, b) => b - a)
  }, [allInvoices])
  // Scoped list every downstream table / rollup / KPI reads from. In cutoff mode
  // (Operating DSO drill-downs) we apply the Operating SCOPE instead of a year:
  // 'within' keeps invoices up to 180 days past due, 'over' keeps the full book
  // (2022/2023 dropped). Write-offs & in-collections are already removed upstream.
  const invoicesAll = useMemo(() => {
    if (cutoffFilter) return allInvoices.filter((r) => keepInOperating(r, cutoffSel))
    return yearSel == null ? allInvoices : allInvoices.filter((r) => r.date && r.date.getFullYear() === yearSel)
  }, [allInvoices, yearSel, cutoffSel, cutoffFilter])
  // When a month-over-month comparison view is active, the whole drill (brand
  // rollup, totals, flat list) narrows to just the invoices that entered/left.
  const invoices = useMemo(() => {
    if (!comparison || !compareView) return invoicesAll
    if (compareView === 'changed') return [...(comparison.added || []), ...(comparison.removed || [])]
    if (compareView === 'removed') return comparison.removed
    return invoicesAll.filter((r) => addedKeys.has(compKey(r)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoicesAll, comparison, compareView, addedKeys])
  const [sort, setSort] = useState({ key: 'outstanding', dir: 'desc' })
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('all') // all | open | closed
  const [brandView, setBrandView] = useState(null) // null = brand list
  const [storeView, setStoreView] = useState(null) // within a brand: null = store list, set = that store's invoices
  // Detail-view grouping: 'brand' = drill Brand → Store → invoices (default);
  // 'customer' = skip the brand level and list customers (stores) directly.
  const [groupMode, setGroupMode] = useState('brand')


  // Debounced search - refilter only ~120 ms after the last keystroke
  // so typing on a long invoice list (300+ rows) stays smooth.
  const [debouncedQ, setDebouncedQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 120)
    return () => clearTimeout(t)
  }, [q])

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

  const rows = useMemo(() => {
    const needle = debouncedQ.trim().toLowerCase()
    let list = invoices
    if (brandView) list = list.filter((r) => (r.masterBrand || 'No brand') === brandView)
    if (storeView) list = list.filter((r) => r.vendor === storeView)


    // All / Open / Closed segmented filter (received counts as closed/collected)
    if (status === 'open') list = list.filter(isOpenEff)
    else if (status === 'closed') list = list.filter((r) => !isOpenEff(r))
    if (needle) {
      list = list.filter((r) =>
        r.vendor.toLowerCase().includes(needle) ||
        r.invNo.toLowerCase().includes(needle) ||
        (r.salesRep || '').toLowerCase().includes(needle)
      )
    }

    const { key, dir } = sort
    const f = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[key], bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (av instanceof Date && bv instanceof Date) return (av - bv) * f
      if (typeof av === 'string') return av.localeCompare(bv) * f
      return (av - bv) * f
    })
     }, [invoices, sort, debouncedQ, status, brandView, storeView, comparison, compareView, addedKeys])

  // Column filters for the invoice table (Vendor / Bucket / Status).
  const vendorF = useColFilter(rows, (r) => r.vendor)
  const bucketF = useColFilter(rows, (r) => r.isOutstanding ? r.agingBucket : '(closed)')
  const statusF = useColFilter(rows, (r) => r.isCollection ? 'Collections' : (r.isOutstanding ? (r.invoicePaid > 0 ? 'Partial' : 'Open') : (r.isWriteOff ? 'Write-off' : 'Paid')))
  const shown = useMemo(() => rows.filter(vendorF.pass).filter(bucketF.pass).filter(statusF.pass), [rows, vendorF, bucketF, statusF])



   // Brand rollup - grouped from the customer master list's brand (r.masterBrand).
  const brandGroups = useMemo(() => {
    const m = new Map()
    for (const r of invoices) {
      const b = r.masterBrand || 'No brand'
      const g = m.get(b) || { brand: b, count: 0, invoiced: 0, outstanding: 0, openCount: 0, agencies: new Set(), hasCollection: false }
      g.count += 1
      g.invoiced += r.invoiceAmount || 0
      g.outstanding += outOf(r)
      if (isOpenEff(r)) g.openCount += 1
      if (r.collectionsAgency) g.agencies.add(r.collectionsAgency)
      if (r.isCollection) g.hasCollection = true
      m.set(b, g)
    }
    return [...m.values()]
      .map((g) => ({ ...g, agency: [...g.agencies].filter(Boolean).join(' / ') }))
      .sort(catchAllLast((g) => g.brand, (a, b) => (hideOutstanding ? b.invoiced - a.invoiced : b.outstanding - a.outstanding)))
  }, [invoices, hideOutstanding, payCache])

  // Gelato (and any list lacking master-list brands) has no masterBrand - skip the
  // brand level so the drill goes store → invoice directly, keeping Gelato fully
  // separate from the Little Tree customer master list.
  // Whether this list could be grouped by brand at all (drives the toggle's
  // visibility). hasBrands then also honours the user's 'By brand'/'By customer'
  // choice - in customer mode we suppress the brand level so the drill is
  // Customer → invoices.
  const brandsAvailable = useMemo(() => !hideBrandLevel && invoices.some((r) => r.masterBrand), [invoices, hideBrandLevel])
  const hasBrands = brandsAvailable && groupMode === 'brand'
  // Show the collections-agency column only for lists that actually carry it
  // (the "In collections" list), pulled from the tracker's Collections Agency col.
  const hasAgency = useMemo(() => invoices.some((r) => r.collectionsAgency), [invoices])
  useEffect(() => { setBrandView(null); setStoreView(null) }, [invoices, groupMode])

  // Stores (vendors) within the selected brand - second drill level.
  const storeGroups = useMemo(() => {
    if (hasBrands && !brandView) return []
    const m = new Map()
    for (const r of invoices) {
      if (hasBrands && (r.masterBrand || 'No brand') !== brandView) continue
      const g = m.get(r.vendor) || { vendor: r.vendor, count: 0, invoiced: 0, outstanding: 0, openCount: 0, agencies: new Set(), hasCollection: false }
      g.count += 1
      g.invoiced += r.invoiceAmount || 0
      g.outstanding += outOf(r)
      if (isOpenEff(r)) g.openCount += 1
      if (r.collectionsAgency) g.agencies.add(r.collectionsAgency)
      if (r.isCollection) g.hasCollection = true
      m.set(r.vendor, g)
    }
    return [...m.values()]
      .map((g) => ({ ...g, agency: [...g.agencies].filter(Boolean).join(' / ') }))
      .sort((a, b) => (hideOutstanding ? b.invoiced - a.invoiced : b.outstanding - a.outstanding))
  }, [invoices, brandView, hideOutstanding, hasBrands, payCache])


  // Make the Brand and Store drill levels searchable + filterable too (the
  // invoice level already is). Reuses the q/debouncedQ search state.
  const drillQ = debouncedQ.trim().toLowerCase()
  const brandColF = useColFilter(brandGroups, (g) => g.brand)
  const storeColF = useColFilter(storeGroups, (g) => g.vendor.replace(/^(Little Tree|Gelato)-\s*/i, ''))
  const shownBrandGroups = useMemo(
    () => (drillQ ? brandGroups.filter((g) => (g.brand || '').toLowerCase().includes(drillQ)) : brandGroups).filter(brandColF.pass),
    [brandGroups, drillQ, brandColF]
  )
  const shownStoreGroups = useMemo(
    () => (drillQ ? storeGroups.filter((g) => (g.vendor || '').toLowerCase().includes(drillQ)) : storeGroups).filter(storeColF.pass),
    [storeGroups, drillQ, storeColF]
  )
  useEffect(() => { setQ('') }, [brandView, storeView])

  const openCount = useMemo(() => invoices.filter(isOpenEff).length, [invoices, payCache])

  const closedCount = invoices.length - openCount

  // Invoices the operator has flagged (received / payment plan). Received money
  // has left the open book; plan invoices stay open but are tracked here too.
  const receivedList = useMemo(() => invoices.filter(isReceived), [invoices, payCache])
  const planList = useMemo(() => invoices.filter((r) => isPlanComplete(payCache[r.invNo])), [invoices, payCache])
  const markedList = useMemo(() => [...receivedList, ...planList], [receivedList, planList])
  // Money pulled out of "open" by a Payment Received flag - use the operator's
  // entered amount when present, else the invoice's outstanding balance.
  // Read the entered amount from the LIVE store (payCache), not the snapshot
  // r.payment, so the cards reflect edits made in this modal immediately.
  const receivedSum = useMemo(() => receivedList.reduce((s, r) => s + recvOf(r), 0), [receivedList, payCache])
  const planSum = useMemo(() => planList.reduce((s, r) => s + (payCache[r.invNo]?.planAmount || grossOf(r)), 0), [planList, payCache])

  // Pagination - replaces the old hard 300-row truncation.
  const PAGE_SIZE = 50
  const [page, setPage] = useState(1)
   useEffect(() => { setPage(1) }, [debouncedQ, status, sort, invoices, brandView, storeView, vendorF.key, bucketF.key, statusF.key])


  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageRows = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const firstShown = shown.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1
  const lastShown = Math.min(safePage * PAGE_SIZE, shown.length)
  // Windowed page numbers: 1 … 4 5 [6] 7 8 … 20
  const pageNums = []
  if (totalPages <= 7) { for (let p = 1; p <= totalPages; p++) pageNums.push(p) }
  else {
    pageNums.push(1)
    if (safePage > 4) pageNums.push('…')
    for (let p = Math.max(2, safePage - 1); p <= Math.min(totalPages - 1, safePage + 1); p++) pageNums.push(p)
    if (safePage < totalPages - 3) pageNums.push('…')
    pageNums.push(totalPages)
  }

  const toggle = (k) => setSort((s) => s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' })
  const arrow = (k) => sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  const totalOpen = invoices.reduce((s, r) => s + outOf(r), 0)
  const totalInv = invoices.reduce((s, r) => s + (r.invoiceAmount || 0), 0)

   const exportHeaders = hideOutstanding
    ? ['Inv #', 'Vendor', 'Rep', 'Brand', 'Date', 'Due', 'Paid date', 'Amount', 'Paid', 'Bucket', 'Status']
    : ['Inv #', 'Vendor', 'Rep', 'Brand', 'Date', 'Due', 'Paid date', 'Amount', 'Paid', 'Outstanding', 'Days past due', 'Aging band', 'Status']
  const exportRows = shown.map((r) => {
    const base = [
      r.invNo, r.vendor, r.salesRep || '', r.brand || '',
      r.date ? r.date.toISOString().slice(0, 10) : '',
      r.dueDate ? r.dueDate.toISOString().slice(0, 10) : '',
      r.paidDate ? r.paidDate.toISOString().slice(0, 10) : '',
      r.invoiceAmount, r.invoicePaid,
    ]
    if (!hideOutstanding) base.push(r.outstanding, r.daysOverdue ?? '')
    base.push(r.agingBucket, r.status)
    return base
  })

  // FULL nested report (Brand -> Store -> every invoice) over the entire scoped
  // list, regardless of which drill level is on screen. One file, hierarchy kept.
  const fmtDate = (d) => (d ? d.toISOString().slice(0, 10) : '')
  const nestedHeaders = ['Level', 'Brand', 'Store', 'Inv #', 'Date', 'Rep', 'Amount', 'Paid', ...(hideOutstanding ? [] : ['Outstanding', 'Days past due']), 'Status']
  const nestedRows = useMemo(() => {
    const sumAmt = (rs) => rs.reduce((s, r) => s + (r.invoiceAmount || 0), 0)
    const sumOut = (rs) => rs.reduce((s, r) => s + (r.outstanding || 0), 0)
    const sumPaid = (rs) => rs.reduce((s, r) => s + (r.invoicePaid || 0), 0)
    const tail = (rs, label) => hideOutstanding ? [label] : ['', '', label]
    const invRow = (lvl, brand, store, r) => [
      lvl, brand, store, r.invNo, fmtDate(r.date), r.salesRep || '',
      r.invoiceAmount, r.invoicePaid,
      ...(hideOutstanding ? [] : [r.outstanding || 0, r.daysOverdue ?? '']),
      r.status,
    ]
    const out = []
    const byVendor = (rs) => {
      const m = new Map()
      for (const r of rs) { if (!m.has(r.vendor)) m.set(r.vendor, []); m.get(r.vendor).push(r) }
      return [...m.entries()].sort((a, b) => sumOut(b[1]) - sumOut(a[1]) || sumAmt(b[1]) - sumAmt(a[1]))
    }
    const emitStores = (brand, rs) => {
      for (const [vendor, vrows] of byVendor(rs)) {
        const vName = (vendor || '').replace(/^(Little Tree|Gelato)-\s*/i, '')
        out.push(['STORE', brand, vName, '', '', '', sumAmt(vrows), sumPaid(vrows), ...tail(vrows, `${vrows.length} inv`)])
        for (const r of [...vrows].sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0))) {
          out.push(invRow('INVOICE', brand, vName, r))
        }
      }
    }
    if (hasBrands) {
      const m = new Map()
      for (const r of invoices) { const b = r.masterBrand || 'No brand'; if (!m.has(b)) m.set(b, []); m.get(b).push(r) }
      for (const [brand, rows] of [...m.entries()].sort((a, b) => sumOut(b[1]) - sumOut(a[1]) || sumAmt(b[1]) - sumAmt(a[1]))) {
        out.push(['BRAND', brand, '', '', '', '', sumAmt(rows), sumPaid(rows), ...tail(rows, `${rows.length} inv`)])
        emitStores(brand, rows)
      }
    } else {
      emitStores('', invoices)
    }
    return out
  }, [invoices, hasBrands, hideOutstanding])


  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head" style={{ position: 'relative' }}>
          <div className="modal-head-inner">
            <div>
              <div className="modal-eyebrow">Detail view</div>
              <h3 className="modal-title">{title}</h3>
              {subtitle && <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{subtitle}</div>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {brandsAvailable && (
              <div className="seg-filter" role="tablist" aria-label="Group detail view by">
                <button role="tab" aria-selected={groupMode === 'brand'} className={groupMode === 'brand' ? 'is-active' : ''} onClick={() => setGroupMode('brand')}>By brand</button>
                <button role="tab" aria-selected={groupMode === 'customer'} className={groupMode === 'customer' ? 'is-active' : ''} onClick={() => setGroupMode('customer')}>By customer</button>
              </div>
            )}
            <ExportButton
              filename={`${title.replace(/\s+/g, '-').toLowerCase()}-full-${new Date().toISOString().slice(0, 10)}.csv`}
              title={title}
              headers={nestedHeaders}
              rows={nestedRows}
            />
            <button className="modal-close" onClick={onClose} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </header>

        <div className="modal-body">
          <section className="modal-kpis">
            <button type="button" className="modal-kpi" onClick={() => { setCompareView(null); setStatus('all') }}
              style={{ cursor: 'pointer', textAlign: 'left', border: (!compareView && status === 'all') ? '2px solid #15803d' : undefined }}
              title="Show all invoices in this view">
              <div className="modal-kpi-label">Total in this view</div>
              <div className="modal-kpi-val">{money(totalInv)}</div>
              <div className="modal-kpi-sub">{num(invoices.length)} invoices</div>
            </button>
            {!hideOutstanding && (
              <button type="button" className="modal-kpi" onClick={() => setStatus((s) => s === 'open' ? 'all' : 'open')}
                style={{ cursor: 'pointer', textAlign: 'left', border: status === 'open' ? '2px solid #dc2626' : undefined }}
                title="Click to show only open (unpaid) invoices">
                <div className="modal-kpi-label">Outstanding</div>
                <div className={`modal-kpi-val ${totalOpen > 0 ? 'is-warn' : ''}`}>{money(totalOpen)}</div>
                <div className="modal-kpi-sub">{num(openCount)} open{status === 'open' ? ' · showing' : ''}</div>
              </button>
            )}
            {payEnabled && receivedList.length > 0 && (
              <button type="button" className="modal-kpi" onClick={() => setMarkedView((v) => v === 'received' ? null : 'received')}
                style={{ cursor: 'pointer', textAlign: 'left', border: markedView === 'received' ? '2px solid #d97706' : undefined }}
                title="Invoices flagged Payment Received - click to review & edit">
                <div className="modal-kpi-label">Payment received · not applied</div>
                <div className="modal-kpi-val" style={{ color: '#d97706' }}>{money(receivedSum)}</div>
                <div className="modal-kpi-sub">{num(receivedList.length)} invoices{markedView === 'received' ? ' · showing' : ''}</div>
              </button>
            )}
            {payEnabled && planList.length > 0 && (
              <button type="button" className="modal-kpi" onClick={() => setMarkedView((v) => v === 'plan' ? null : 'plan')}
                style={{ cursor: 'pointer', textAlign: 'left', border: markedView === 'plan' ? '2px solid #2563eb' : undefined }}
                title="Invoices on a payment plan - click to review & edit">
                <div className="modal-kpi-label">Payment plan active</div>
                <div className="modal-kpi-val" style={{ color: '#2563eb' }}>{money(planSum)}</div>
                <div className="modal-kpi-sub">{num(planList.length)} invoices · still in open{markedView === 'plan' ? ' · showing' : ''}</div>
              </button>
            )}
            {comparison && (() => {
              const fmtV = comparison.unit === 'days' ? (n) => `${Math.round(Math.abs(n))}d` : (n) => money(Math.abs(n))
              const worse = comparison.upIsBad === false ? comparison.delta < 0 : comparison.delta > 0
              const deltaColor = comparison.delta === 0 ? '#475569' : worse ? '#dc2626' : '#15803d'
              const pct = comparison.prevTotal ? `${comparison.delta >= 0 ? '+' : '−'}${Math.abs(comparison.delta / comparison.prevTotal * 100).toFixed(0)}%` : ''
              const changedCount = comparison.flow ? 0 : (comparison.added.length + comparison.removed.length)
              const clickable = changedCount > 0
              const Tag = clickable ? 'button' : 'div'
              return (
                <Tag type={clickable ? 'button' : undefined} className="modal-kpi"
                  onClick={clickable ? () => setCompareView((v) => v === 'changed' ? null : 'changed') : undefined}
                  style={clickable ? { cursor: 'pointer', textAlign: 'left', border: compareView === 'changed' ? '2px solid #6366f1' : undefined } : undefined}
                  title={clickable ? `Click to list the ${changedCount} invoices that changed since ${comparison.prevLabel}` : `This view ${fmtV(comparison.curTotal)} vs ${comparison.prevLabel} ${fmtV(comparison.prevTotal)}`}>
                  <div className="modal-kpi-label">Change vs {comparison.prevLabel}</div>
                  <div className="modal-kpi-val" style={{ color: deltaColor }}>
                    {comparison.delta >= 0 ? '+' : '−'}{fmtV(comparison.delta)}
                  </div>
                  <div className="modal-kpi-sub">{pct ? `${pct} · ` : ''}{clickable ? `${changedCount} changed${compareView === 'changed' ? ' · showing' : ''}` : `${comparison.delta > 0 ? 'up' : comparison.delta < 0 ? 'down' : 'no change'} vs ${comparison.prevLabel}`}</div>
                </Tag>
              )
            })()}
          </section>
          {comparison && compareView && (
            <button type="button" onClick={() => setCompareView(null)}
              style={{ cursor: 'pointer', marginBottom: 12, padding: '6px 12px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#15803d', fontWeight: 600, fontSize: 13 }}>
              ← Show all invoices
            </button>
          )}

          {markedView ? (
            <>
              <button type="button" onClick={() => setMarkedView(null)}
                style={{ cursor: 'pointer', marginBottom: 12, padding: '6px 12px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#15803d', fontWeight: 600, fontSize: 13 }}>
                ← Back to list
              </button>
              <div style={{ fontSize: 12.5, color: '#64748b', marginBottom: 8 }}>
                {markedView === 'plan'
                  ? 'Invoices on a payment plan. These balances stay in the open total above. Edit a row to update or clear its status.'
                  : markedView === 'received'
                    ? 'Invoices flagged Payment Received - money in, not yet applied in accounting. Excluded from the open total above. Edit a row to update or clear its status.'
                    : 'Invoices flagged Payment Received or Payment Plan. Received money is excluded from the open total above; payment-plan balances stay in it.'}
              </div>
              <MarkedInvoicesTable
                invoices={markedView === 'received' ? receivedList : markedView === 'plan' ? planList : markedList}
                payStatus={payStatus}
                remainingOf={remainingOf}
                recvOf={recvOf}
              />
            </>
          ) : (
          <>
          {cutoffFilter ? (
            <div style={{ marginBottom: 12 }}>
              <div className="seg-filter" role="tablist" aria-label="Operating scope">
                {OP_MODES.map(([v, label]) => (
                  <button key={v} role="tab" aria-selected={cutoffSel === v} className={cutoffSel === v ? 'is-active' : ''} onClick={() => setCutoffSel(v)}>{label}</button>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 6 }}>
                Operating scope (default Up to 180 days). {cutoffSel === 'over'
                  ? 'Shows the full book - invoices up to 180 days past due plus the 180+ tail - with 2022 & 2023 excluded.'
                  : 'Shows only invoices up to 180 days past due; the entire 180+ tail is excluded.'} All years; write-offs &amp; in-collections already excluded ({opExclText(cutoffSel)}).
              </div>
            </div>
          ) : !noYearFilter && years.length > 1 ? (
            <div className="seg-filter" role="tablist" aria-label="Filter by year" style={{ marginBottom: 12 }}>
              <button role="tab" aria-selected={yearSel == null} className={yearSel == null ? 'is-active' : ''} onClick={() => setYearSel(null)}>All years</button>
              {years.map((y) => (
                <button key={y} role="tab" aria-selected={yearSel === y} className={yearSel === y ? 'is-active' : ''} onClick={() => setYearSel(y)}>{y}</button>
              ))}
            </div>
          ) : !noYearFilter && years.length === 1 ? (
            <div style={{ marginBottom: 12, fontSize: 13, color: '#64748b', fontWeight: 600 }}>Year: {years[0]}</div>
          ) : null}

          {hasBrands && brandView === null && (
            <>
            <div className="modal-toolbar">
              <input
                type="search"
                className="table-search"
                placeholder="Search brand…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="modal-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Brand <ColumnFilter label="Brand" options={brandColF.options} excluded={brandColF.excluded} onChange={brandColF.setExcluded} /></th>
                    <th className="num"># Invoices</th>
                    <th className="num">Invoiced</th>
                    {!hideOutstanding && <th className="num">Outstanding</th>}
                    {!hideOutstanding && <th className="num">Open</th>}
                    {hasAgency && <th>Collection Agency</th>}
                  </tr>
                </thead>
                <tbody>
                  {shownBrandGroups.length === 0 && <tr><td colSpan={(hideOutstanding ? 3 : 5) + (hasAgency ? 1 : 0)} className="table-empty">No data.</td></tr>}
                  {shownBrandGroups.map((g) => (
                    <tr key={g.brand} className="clickable-row" onClick={() => { setBrandView(g.brand); setStoreView(null) }}>

                      <td className="vendor-cell">{g.brand}</td>
                      <td className="num">{num(g.count)}</td>
                      <td className="num">{money(g.invoiced, true)}</td>
                      {!hideOutstanding && <td className={`num ${g.outstanding > 0 ? 'cell-warn' : ''}`}>{g.outstanding > 0 ? money(g.outstanding, true) : ''}</td>}
                      {!hideOutstanding && <td className="num">{g.openCount || ''}</td>}
                      {hasAgency && <td>{g.agency || (g.hasCollection ? 'Sent to collections' : '')}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}

          {storeView === null && (hasBrands ? brandView !== null : true) && (
            <>
            {hasBrands && (
            <nav className="breadcrumb" style={{ marginBottom: 12 }}>
              <button type="button" className="crumb-link" onClick={() => setBrandView(null)}>All brands</button>
              <span className="crumb-sep">›</span>
              <span className="crumb-current">{brandView}</span>
            </nav>
            )}
            <div className="modal-toolbar">
              <input
                type="search"
                className="table-search"
                placeholder="Search store…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className="modal-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Store <ColumnFilter label="Store" options={storeColF.options} excluded={storeColF.excluded} onChange={storeColF.setExcluded} /></th>
                    <th className="num"># Invoices</th>
                    <th className="num">Invoiced</th>
                    {!hideOutstanding && <th className="num">Outstanding</th>}
                    {!hideOutstanding && <th className="num">Open</th>}
                    {hasAgency && <th>Collection Agency</th>}
                  </tr>
                </thead>
                <tbody>
                  {shownStoreGroups.length === 0 && <tr><td colSpan={(hideOutstanding ? 3 : 5) + (hasAgency ? 1 : 0)} className="table-empty">No stores.</td></tr>}
                  {shownStoreGroups.map((g) => (
                    <tr key={g.vendor} className="clickable-row" onClick={() => setStoreView(g.vendor)}>
                      <td className="vendor-cell">{g.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                      <td className="num">{num(g.count)}</td>
                      <td className="num">{money(g.invoiced, true)}</td>
                      {!hideOutstanding && <td className={`num ${g.outstanding > 0 ? 'cell-warn' : ''}`}>{g.outstanding > 0 ? money(g.outstanding, true) : ''}</td>}
                      {!hideOutstanding && <td className="num">{g.openCount || ''}</td>}
                      {hasAgency && <td>{g.agency || (g.hasCollection ? 'Sent to collections' : '')}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}

          {storeView !== null && (
          <>
          <nav className="breadcrumb" style={{ marginBottom: 12 }}>
            {hasBrands ? (
              <>
                <button type="button" className="crumb-link" onClick={() => { setBrandView(null); setStoreView(null) }}>All brands</button>
                <span className="crumb-sep">›</span>
                <button type="button" className="crumb-link" onClick={() => setStoreView(null)}>{brandView}</button>
              </>
            ) : (
              <button type="button" className="crumb-link" onClick={() => setStoreView(null)}>All stores</button>
            )}
            <span className="crumb-sep">›</span>
            <span className="crumb-current">{storeView.replace(/^(Little Tree|Gelato)-\s*/i, '')}</span>
          </nav>
          <div className="modal-toolbar">


            {!hideOutstanding ? (
              <div className="seg-filter" role="tablist" aria-label="Filter by status">
                <button role="tab" aria-selected={status === 'all'} className={status === 'all' ? 'is-active' : ''} onClick={() => setStatus('all')}>
                  All <span className="seg-count">{num(invoices.length)}</span>
                </button>
                <button role="tab" aria-selected={status === 'open'} className={status === 'open' ? 'is-active' : ''} onClick={() => setStatus('open')}>
                  Open <span className="seg-count">{num(openCount)}</span>
                </button>
                <button role="tab" aria-selected={status === 'closed'} className={status === 'closed' ? 'is-active' : ''} onClick={() => setStatus('closed')}>
                  Closed <span className="seg-count">{num(closedCount)}</span>
                </button>
              </div>
            ) : <div />}
            <input
              type="search"
              className="table-search"
              placeholder="Search invoice, vendor, rep…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <ExportButton
              filename={`${title.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0,10)}.csv`}
              headers={exportHeaders}
              rows={exportRows}
            />
          </div>
          <div className="modal-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th onClick={() => toggle('invNo')}>Inv #{arrow('invNo')}</th>
                  <th onClick={() => toggle('vendor')}>Vendor{arrow('vendor')}
                    <ColumnFilter label="Vendor" options={vendorF.options} excluded={vendorF.excluded} onChange={vendorF.setExcluded} />
                  </th>
                  <th onClick={() => toggle('date')}>Date{arrow('date')}</th>
                  <th className="num" onClick={() => toggle('invoiceAmount')}>Amount{arrow('invoiceAmount')}</th>
                  {!hideOutstanding && <th className="num" onClick={() => toggle('outstanding')}>Outstanding{arrow('outstanding')}</th>}
                  {!hideOutstanding && <th className="num" onClick={() => toggle('daysOverdue')}>Days past due{arrow('daysOverdue')}</th>}
                  <th>Bucket <ColumnFilter label="Bucket" options={bucketF.options} excluded={bucketF.excluded} onChange={bucketF.setExcluded} /></th>
                  <th>Status <ColumnFilter label="Status" options={statusF.options} excluded={statusF.excluded} onChange={statusF.setExcluded} /></th>
                  {payEnabled && <th>Payment status</th>}
                  {hasAgency && <th>Collection Agency</th>}

                  <th onClick={() => toggle('dueDate')}>Due{arrow('dueDate')}</th>
                  <th onClick={() => toggle('paidDate')}>Paid date{arrow('paidDate')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && <tr><td colSpan={(hideOutstanding ? 8 : 10) + (hasAgency ? 1 : 0) + (payEnabled ? 1 : 0)} className="table-empty">No invoices match.</td></tr>}
                {pageRows.map((r, i) => (
                  <tr key={`${r.invNo}-${i}`} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                    <td className="mono">{r.invNo}</td>
                    <td className="vendor-cell">{r.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                    <td>{shortDate(r.date)}</td>
                    <td className="num">{money(r.invoiceAmount, true)}</td>
                    {!hideOutstanding && <td className={`num ${remainingOf(r) > 0 ? 'cell-warn' : ''}`}>{remainingOf(r) > 0 ? money(remainingOf(r), true) : ''}</td>}
                    {!hideOutstanding && <td className="num">{r.daysOverdue != null ? r.daysOverdue : ''}</td>}
                    <td>{r.isOutstanding && r.agingBucket ? <span className={`bucket-pill ${BUCKET_CLASS[r.agingBucket] || ''}`}>{r.agingBucket}</span> : ''}</td>
                    <td>
                      <span
                        className={`status-pill ${isReceived(r) ? 'status-partial' : (r.isCollection ? 'status-open' : (r.isOutstanding ? (r.invoicePaid > 0 ? 'status-partial' : 'status-open') : 'status-closed'))}`}
                        title={isReceived(r) ? `${money(recvOf(r), true)} received - not yet applied${remainingOf(r) > 0 ? ` · ${money(remainingOf(r), true)} still open` : ' · paid in full'}` : (r.isOutstanding && r.invoicePaid > 0 ? `${money(r.invoicePaid, true)} paid of ${money(r.invoiceAmount, true)}${r.paidDate ? ' · ' + shortDate(r.paidDate) : ''} · ${money(r.outstanding, true)} still due` : undefined)}
                      >
                        {isReceived(r) ? (remainingOf(r) > 0 ? 'Part. received' : 'Pmt received') : (r.isCollection ? 'Collections' : (r.isOutstanding ? (r.invoicePaid > 0 ? 'Partial' : 'Open') : (r.isWriteOff ? 'Write-off' : 'Paid')))}
                      </span>
                    </td>
                    {payEnabled && (
                      <td onClick={(e) => e.stopPropagation()}>
                        {(isOpenEff(r) || isMarked(r)) ? <PaymentStatusEditor inv={r} /> : ''}
                      </td>
                    )}
                    {hasAgency && <td>{
                      r.collectionsAgency
                        ? r.collectionsAgency
                        : r.isCollection
                          ? <input
                              type="text"
                              defaultValue={getAgency(r.invNo) || ''}
                              placeholder="Enter agency…"
                              onClick={(e) => e.stopPropagation()}
                              onBlur={(e) => setAgency(r.invNo, e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
                              style={{ width: '100%', minWidth: 120, border: '1px solid transparent', background: 'transparent', padding: '3px 6px', borderRadius: 6, fontSize: 12.5, color: getAgency(r.invNo) ? '#0f172a' : '#94a3b8' }}
                              onFocus={(e) => { e.target.style.border = '1px solid #cbd5e1'; e.target.style.background = '#fff' }}
                            />
                          : ''
                    }</td>}
                    <td className="muted">{shortDate(r.dueDate)}</td>
                    <td className={r.paidDate ? '' : 'muted'}>{r.paidDate ? shortDate(r.paidDate) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="modal-pagination">
            <span className="page-info">
              {shown.length === 0 ? 'No invoices' : `${num(firstShown)}–${num(lastShown)} of ${num(shown.length)}`}
            </span>
            {totalPages > 1 && (
              <div className="pager">
                <button className="pager-step" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹ Prev</button>
                {pageNums.map((p, i) =>
                  p === '…'
                    ? <span key={`e${i}`} className="pager-ellipsis">…</span>
                    : <button key={p} className={`pager-num ${p === safePage ? 'is-active' : ''}`} onClick={() => setPage(p)}>{p}</button>
                )}
                <button className="pager-step" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next ›</button>
              </div>
            )}
          </div>
          </>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  )
}

// Compact table for the "Payment received · not applied" view: the flagged
// invoices with an inline editor to update or clear each one's status.
function MarkedInvoicesTable({ invoices, payStatus, remainingOf, recvOf }) {
  return (
    <div className="modal-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Inv #</th>
            <th>Vendor</th>
            <th>Date</th>
            <th className="num">Invoice</th>
            <th className="num">Received</th>
            <th className="num">Still open</th>
            <th>Flag</th>
            <th>Payment status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.length === 0 && <tr><td colSpan={8} className="table-empty">No invoices flagged yet.</td></tr>}
          {invoices.map((r, i) => (
            <tr key={`${r.invNo}-${i}`}>
              <td className="mono">{r.invNo}</td>
              <td className="vendor-cell">{r.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
              <td>{shortDate(r.date)}</td>
              <td className="num">{money(r.invoiceAmount, true)}</td>
              <td className="num">{payStatus(r) === 'received' && recvOf(r) > 0 ? money(recvOf(r), true) : ''}</td>
              <td className={`num ${remainingOf(r) > 0 ? 'cell-warn' : ''}`}>{remainingOf(r) > 0 ? money(remainingOf(r), true) : ''}</td>
              <td>
                <span className={`status-pill ${payStatus(r) === 'received' ? 'status-partial' : 'status-open'}`}>
                  {payStatus(r) === 'received' ? 'Received' : 'Plan'}
                </span>
              </td>
              <td onClick={(e) => e.stopPropagation()}><PaymentStatusEditor inv={r} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Inline payment-status control for one invoice: the 3-way dropdown plus the
// conditional fields each status needs. Local form state keeps typing smooth;
// changes commit to the shared store (which re-renders the open lists / KPIs).
function PaymentStatusEditor({ inv }) {
  const saved = getPaymentStatus(inv.invNo)
  const [form, setForm] = useState(saved || { status: 'none' })
  // Re-sync if the saved record changes elsewhere (e.g. cleared from another row).
  useEffect(() => { setForm(getPaymentStatus(inv.invNo) || { status: 'none' }) }, [inv.invNo, saved])

  const commit = (next) => {
    setForm(next)
    setPaymentStatus(inv.invNo, next.status === 'none' ? null : next)
  }
  const setField = (patch) => setForm((f) => ({ ...f, ...patch })) // local only; commit on blur
  const flush = () => setPaymentStatus(inv.invNo, form.status === 'none' ? null : form)

  // Cap the amount at the invoice's ORIGINAL balance; default to it. Cap the
  // received date at today (you can't receive money in the future).
  const maxAmt = inv.outstandingGross ?? inv.outstanding ?? 0
  const todayStr = new Date().toISOString().slice(0, 10)
  const clampAmt = (v) => v === '' ? '' : Math.min(maxAmt, Math.max(0, Number(v) || 0))

  const onStatus = (s) => {
    if (s === 'none') { commit({ status: 'none' }); return }
    if (s === 'received') commit({ status: 'received', receivedDate: form.receivedDate || '', receivedAmount: form.receivedAmount ?? maxAmt, markedInAccounting: !!form.markedInAccounting })
    else commit({ status: 'plan', planAmount: form.planAmount ?? maxAmt, nextDueDate: form.nextDueDate || '' })
  }

  return (
    <div className="pay-editor">
      <select className="pay-select" data-status={form.status} value={form.status} onChange={(e) => onStatus(e.target.value)}>
        {PAYMENT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {form.status === 'received' && (
        <div className="pay-fields" data-status="received">
          <label>Received date
            <input className="pay-input" type="date" max={todayStr} value={form.receivedDate || ''} onChange={(e) => setField({ receivedDate: e.target.value > todayStr ? todayStr : e.target.value })} onBlur={flush} />
          </label>
          <label>Received amount <span className="pay-hint">(max {money(maxAmt, true)})</span>
            <div className="pay-amount">
              <span className="pay-cur">$</span>
              <input className="pay-input" type="number" min={0} max={maxAmt} value={form.receivedAmount ?? ''} onChange={(e) => setField({ receivedAmount: clampAmt(e.target.value) })} onBlur={flush} />
            </div>
          </label>
          {!(form.receivedDate && Number(form.receivedAmount) > 0) && (
            <div className="pay-note">Add date &amp; amount to apply</div>
          )}
        </div>
      )}
      {form.status === 'plan' && (
        <div className="pay-fields" data-status="plan">
          <label>Plan amount <span className="pay-hint">(max {money(maxAmt, true)})</span>
            <div className="pay-amount">
              <span className="pay-cur">$</span>
              <input className="pay-input" type="number" min={0} max={maxAmt} value={form.planAmount ?? ''} onChange={(e) => setField({ planAmount: clampAmt(e.target.value) })} onBlur={flush} />
            </div>
          </label>
          <label>Next payment due
            <input className="pay-input" type="date" value={form.nextDueDate || ''} onChange={(e) => setField({ nextDueDate: e.target.value })} onBlur={flush} />
          </label>
          {!(Number(form.planAmount) > 0 && form.nextDueDate) && (
            <div className="pay-note">Add amount &amp; due date to apply</div>
          )}
        </div>
      )}
    </div>
  )
}

