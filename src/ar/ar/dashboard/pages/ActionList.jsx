import { useEffect, useMemo, useState } from 'react'
import { ExportButton } from '../../lib/csv.jsx'
import { isPrivateLabel, catchAllLast } from '../../lib/brands.js'
import { money, num, shortDate } from '../../lib/format.js'
import { useNav } from '../../lib/navigation.jsx'
import { usePager, Pager } from '../../lib/pagination.jsx'
import { ColumnFilter } from '../components/ColumnFilter.jsx'
import InfoTip from '../components/InfoTip.jsx'

const BUCKET_CLASS = {
  'Current': 'bucket-upcoming',
  '1–30': 'bucket-current',
  '31–60': 'bucket-1',
  '61–90': 'bucket-2',
  '91–120': 'bucket-3',
  '121–180': 'bucket-4',
  '180+': 'bucket-5',
}

const FILTERS = [
  { id: 'priority', label: 'Priority (worst first)' },
  { id: 'amount', label: 'Largest amount' },
  { id: 'oldest', label: 'Oldest invoices' },
  { id: 'current', label: 'Current (not due)', bucket: 'Current' },
  { id: '1-30', label: '1–30 days past due', bucket: '1–30' },
  { id: '31-60', label: '31–60 days past due', bucket: '31–60' },
  { id: '61-90', label: '61–90 days past due', bucket: '61–90' },
  { id: '91-120', label: '91–120 days past due', bucket: '91–120' },
  { id: '121-180', label: '121–180 days past due', bucket: '121–180' },
  { id: '180plus', label: '180+ days past due', bucket: '180+' },
]

export default function ActionList({ data, scope = 'all', segment = 'all' }) {
  const { openCustomer, openInvoiceList } = useNav()
    const [mode, setMode] = useState('priority')
  const [includeGelato, setIncludeGelato] = useState(scope === 'all' || scope === 'gelato')
  // Date range filter (invoice issue date). Empty strings = no filter.
  // Email draft modal - set to invoice object to open, null to close.
  const [draftInvoice, setDraftInvoice] = useState(null)
  // Spreadsheet-style column filters: Set of EXCLUDED values per column.
  // Empty set = no filter (all values pass).
  const [channelExcluded, setChannelExcluded] = useState(() => new Set())
  const [repExcluded, setRepExcluded] = useState(() => new Set())
  const [vendorExcluded, setVendorExcluded] = useState(() => new Set())
  const [bucketExcluded, setBucketExcluded] = useState(() => new Set())
  // Drill view: brand → store → invoices
  const [brandView, setBrandView] = useState(null)
  const [storeView, setStoreView] = useState(null)
  const [q, setQ] = useState('') // free-text search over the current drill level


  const items = useMemo(() => {
    const vendorBrand = new Map()
    data.invoices.forEach((r) => {
      if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand)
    })

    const wholesale = (scope === 'gelato')
      ? []
            : data.invoices.filter((r) =>
          r.isOutstanding && r.outstanding >= 100 &&
          !isPrivateLabel(vendorBrand.get(r.vendor) || r.brand))
    const gelato = (scope === 'wholesale')
      ? []
      : (includeGelato
          ? (data.gelato || []).filter((r) => r.isOutstanding && r.outstanding >= 100)
          : [])

    let list = [...wholesale.map((r) => ({ ...r, channel: 'Little Tree' })),
                ...gelato.map((r) => ({ ...r, channel: 'Gelato' }))]

    // Column filters (multi-select, excluded values are hidden)
    if (channelExcluded.size > 0) list = list.filter((r) => !channelExcluded.has(r.channel))
    if (repExcluded.size > 0) list = list.filter((r) => !repExcluded.has(r.salesRep || '(no rep)'))
    if (vendorExcluded.size > 0) list = list.filter((r) => !vendorExcluded.has(r.vendor || '(blank)'))
    if (bucketExcluded.size > 0) list = list.filter((r) => !bucketExcluded.has(r.agingBucket || '(no bucket)'))
    if (segment === 'lt') list = list.filter((r) => !r.isPrivateLabelCustomer)
    else if (segment === 'pl') list = list.filter((r) => r.isPrivateLabelCustomer)

    // Priority score: combines days overdue + amount
    list.forEach((r) => {
      const days = r.daysOverdue || 0
      r.priorityScore = (days > 0 ? Math.log10(days + 1) * 30 : 0) + Math.log10(r.outstanding + 1) * 10
    })

    switch (mode) {
      case 'priority':
        list.sort((a, b) => b.priorityScore - a.priorityScore); break
      case 'amount':
        list.sort((a, b) => b.outstanding - a.outstanding); break
      case 'oldest':
        list.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0)); break
      default: {
        // Bucket-specific filters (In Queue / 0–30 / 30–60 / 60–90 / 90–180 / 180+)
        const filter = FILTERS.find((f) => f.id === mode)
        if (filter && filter.bucket) {
          list = list.filter((r) => r.agingBucket === filter.bucket)
                     .sort((a, b) => b.outstanding - a.outstanding)
        }
      }
    }
    return list
  }, [data, mode, includeGelato, scope, channelExcluded, repExcluded, vendorExcluded, bucketExcluded, segment])


  // Unique values for each filterable column (computed from PRE-filter list
  // so dropdown options remain stable as user toggles checkboxes).
  const filterOptions = useMemo(() => {
    const vendorBrand = new Map()
    data.invoices.forEach((r) => {
      if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand)
    })
       const wholesale = (scope === 'gelato') ? [] : data.invoices.filter((r) =>
      r.isOutstanding && r.outstanding >= 100 && !isPrivateLabel(vendorBrand.get(r.vendor) || r.brand))
    const gelato = (scope === 'wholesale') ? [] : (data.gelato || []).filter((r) => r.isOutstanding && r.outstanding >= 100)
    const all = [
      ...wholesale.map((r) => ({ ...r, channel: 'Little Tree' })),
      ...gelato.map((r) => ({ ...r, channel: 'Gelato' })),
    ]
    const channels = [...new Set(all.map((r) => r.channel))].sort()
    const reps = [...new Set(all.map((r) => r.salesRep || '(no rep)'))].sort()
    const vendors = [...new Set(all.map((r) => r.vendor || '(blank)'))].sort()
    const bucketOrder = ['Current', '1–30', '31–60', '61–90', '91–120', '121–180', '180+']
    const bucketsPresent = new Set(all.map((r) => r.agingBucket || '(no bucket)'))
    const buckets = bucketOrder.filter((b) => bucketsPresent.has(b))
      .concat([...bucketsPresent].filter((b) => !bucketOrder.includes(b)).sort())
    return { channels, reps, vendors, buckets }
  }, [data, scope])

  // ── Brand → Store → Invoice drill ──────────────────────────────────────────
  const brandKey = (r) => r.masterBrand || 'No brand'
  // Gelato has no master-list brand - skip the brand level and drill store → invoice.
  const hasBrands = useMemo(() => items.some((r) => r.masterBrand), [items])
  const brandGroups = useMemo(() => {
    const m = new Map()
    for (const r of items) {
      const b = brandKey(r)
      const g = m.get(b) || { brand: b, count: 0, outstanding: 0, oldest: 0 }
      g.count += 1; g.outstanding += r.outstanding || 0
      if ((r.daysOverdue || 0) > g.oldest) g.oldest = r.daysOverdue || 0
      m.set(b, g)
    }
    return [...m.values()].sort(catchAllLast((g) => g.brand, (a, b) => b.outstanding - a.outstanding))
  }, [items])
  const storeGroups = useMemo(() => {
    if (hasBrands && !brandView) return []
    const m = new Map()
    for (const r of items) {
      if (hasBrands && brandKey(r) !== brandView) continue
      const g = m.get(r.vendor) || { vendor: r.vendor, count: 0, outstanding: 0, oldest: 0 }
      g.count += 1; g.outstanding += r.outstanding || 0
      if ((r.daysOverdue || 0) > g.oldest) g.oldest = r.daysOverdue || 0
      m.set(r.vendor, g)
    }
    return [...m.values()].sort((a, b) => b.outstanding - a.outstanding)
  }, [items, brandView, hasBrands])
  const invoiceRows = useMemo(
    () => storeView ? items.filter((r) => r.vendor === storeView && (hasBrands ? brandKey(r) === brandView : true)) : [],
    [items, brandView, storeView, hasBrands])
  useEffect(() => { setBrandView(null); setStoreView(null) }, [mode, includeGelato, scope, segment, data])
  useEffect(() => { setQ('') }, [brandView, storeView, mode])

  const level = !hasBrands
    ? (storeView === null ? 'store' : 'invoice')
    : (brandView === null ? 'brand' : storeView === null ? 'store' : 'invoice')
  const baseRows = level === 'brand' ? brandGroups : level === 'store' ? storeGroups : invoiceRows
  const currentRows = useMemo(() => {
    const n = q.trim().toLowerCase()
    if (!n) return baseRows
    if (level === 'brand') return baseRows.filter((g) => (g.brand || '').toLowerCase().includes(n))
    if (level === 'store') return baseRows.filter((g) => (g.vendor || '').toLowerCase().includes(n))
    return baseRows.filter((r) => `${r.vendor} ${r.invNo} ${r.salesRep || ''}`.toLowerCase().includes(n))
  }, [baseRows, q, level])

  const pager = usePager(currentRows.length, 50,
    JSON.stringify([mode, level, brandView, storeView, includeGelato]))

  const exportRows = items.map((r) => [
    r.channel,
    r.invNo,
    r.date ? r.date.toISOString().slice(0, 10) : '',
    r.masterBrand || r.brand || '',
    r.vendor,
    r.salesRep,
    r.outstanding.toFixed(2),
    r.daysOverdue ?? '',
    r.agingBucket,
    r.dueDate ? r.dueDate.toISOString().slice(0, 10) : '',
    r.email,
  ])

  return (
    <div className="page">

      <div className="ar-tabs-row">
        <div className="ar-tabs" style={{ flexWrap: 'wrap', gap: 6 }}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`ar-tab ${mode === f.id ? 'active' : ''}`}
              onClick={() => setMode(f.id)}
              style={{ flex: '0 0 auto', width: 'auto', minWidth: 0, overflow: 'visible', textOverflow: 'clip' }}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="table-card">
        <InfoTip
          title="Action list"
          purpose="The prioritised chase list, worst invoices first, each with a ready-to-send reminder."
          detail="Open invoices ranked by the selected mode - Priority (worst first) weighs days past due against balance size; or sort by Largest amount / Oldest, or filter to a single aging bucket. Example: a $9,000 invoice 120 days overdue ranks above a $1,000 invoice 10 days overdue."
          source="Invoice Tracker (Gelato AR sheet on the Gelato page)."
        />
        <div className="table-head">
          <h3>{num(items.length)} invoices to action</h3>
          <div className="table-head-tools">
            {scope === 'all' && (
              <label className="toggle-row">
                <input type="checkbox" checked={includeGelato} onChange={(e) => setIncludeGelato(e.target.checked)} />
                <span>Include Gelato</span>
              </label>
            )}
            <input
              type="search"
              className="table-search"
              placeholder={level === 'brand' ? 'Search brand…' : level === 'store' ? 'Search store…' : 'Search invoice, customer, rep…'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <ExportButton
              filename={`action-list-${new Date().toISOString().slice(0,10)}.csv`}
              headers={['Channel', 'Invoice #', 'Date', 'Brand', 'Customer', 'Rep', 'Outstanding', 'Days past due', 'Aging band', 'Due date', 'Email']}
              rows={exportRows}
            />
          </div>
        </div>
        {((hasBrands && brandView !== null) || (!hasBrands && storeView !== null)) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 4px 14px' }}>
            {hasBrands ? (
              <>
                <button type="button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#15803d', fontWeight: 600, fontSize: 13 }} onClick={() => { setBrandView(null); setStoreView(null) }}>← All brands</button>
                <span className="muted">›</span>
                {storeView === null
                  ? <span style={{ fontWeight: 600 }}>{brandView}</span>
                  : <>
                      <button type="button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#15803d', fontWeight: 600, fontSize: 13 }} onClick={() => setStoreView(null)}>{brandView}</button>
                      <span className="muted">›</span>
                      <span style={{ fontWeight: 600 }}>{storeView.replace(/^(Little Tree|Gelato)-\s*/i, '')}</span>
                    </>}
              </>
            ) : (
              <>
                <button type="button" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#15803d', fontWeight: 600, fontSize: 13 }} onClick={() => setStoreView(null)}>← All stores</button>
                <span className="muted">›</span>
                <span style={{ fontWeight: 600 }}>{storeView.replace(/^(Little Tree|Gelato)-\s*/i, '')}</span>
              </>
            )}
          </div>
        )}

        <div className="table-wrap">
          {level === 'brand' && (
            <table className="data-table">
              <thead><tr><th>Brand</th><th className="num"># Invoices</th><th className="num">Outstanding</th><th className="num">Oldest (days)</th></tr></thead>
              <tbody>
                {currentRows.length === 0 && <tr><td colSpan="4" className="table-empty">Nothing to action with current filter.</td></tr>}
                {currentRows.slice(pager.start, pager.end).map((g) => (
                  <tr key={g.brand} className="clickable-row" onClick={() => setBrandView(g.brand)}>
                    <td className="vendor-cell">{g.brand}</td>
                    <td className="num">{num(g.count)}</td>
                    <td className="num cell-warn">{money(g.outstanding, true)}</td>
                    <td className="num">{g.oldest || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {level === 'store' && (
            <table className="data-table">
              <thead><tr><th>Store</th><th className="num"># Invoices</th><th className="num">Outstanding</th><th className="num">Oldest (days)</th></tr></thead>
              <tbody>
                {currentRows.length === 0 && <tr><td colSpan="4" className="table-empty">No stores.</td></tr>}
                {currentRows.slice(pager.start, pager.end).map((g) => (
                  <tr key={g.vendor} className="clickable-row" onClick={() => setStoreView(g.vendor)}>
                    <td className="vendor-cell">{g.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                    <td className="num">{num(g.count)}</td>
                    <td className="num cell-warn">{money(g.outstanding, true)}</td>
                    <td className="num">{g.oldest || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {level === 'invoice' && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Inv #</th>
                  <th>Rep</th>
                  <th className="num">Outstanding</th>
                  <th className="num">Days past due</th>
                  <th>Bucket</th>
                  <th>Due</th>
                  <th>Contact</th>
                </tr>
              </thead>
              <tbody>
                {currentRows.length === 0 && <tr><td colSpan="8" className="table-empty">No invoices.</td></tr>}
                {currentRows.slice(pager.start, pager.end).map((r, i) => (
                  <tr key={`${r.channel}-${r.invNo}-${i}`} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                    <td className="muted">{pager.start + i + 1}</td>
                    <td className="mono">{r.invNo}</td>
                    <td>{r.salesRep}</td>
                    <td className="num cell-warn">{money(r.outstanding, true)}</td>
                    <td className="num">{r.daysOverdue != null ? r.daysOverdue : ''}</td>
                    <td><span className={`bucket-pill ${BUCKET_CLASS[r.agingBucket] || ''}`}>{r.agingBucket}</span></td>
                    <td className="muted">{shortDate(r.dueDate)}</td>
                    <td className="action-cell">
                      {r.email && (
                        <button
                          type="button"
                          className="action-link"
                          title="Compose reminder email. Preview and send via Gmail"
                          onClick={(e) => { e.stopPropagation(); setDraftInvoice(r) }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6"/>
                            <path d="M3 7l9 6 9-6" stroke="currentColor" strokeWidth="1.6"/>
                          </svg>
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Pager {...pager} total={currentRows.length} />

      </div>

      {draftInvoice && (
        <EmailDraftModal invoice={draftInvoice} onClose={() => setDraftInvoice(null)} />
      )}
    </div>
  )
}

// ============ EMAIL DRAFT MODAL ============
// Opens an editable reminder email pre-filled from the invoice. Send button
// opens Gmail compose in a new tab (operator's account picks up automatically);
// "Open in mail app" falls back to mailto: for non-Gmail users.
function EmailDraftModal({ invoice, onClose }) {
  const initialTo = (invoice.email || '').split(/[,\n;]/)[0].trim()
  const customerName = (invoice.vendor || '').replace(/^(Little Tree|Gelato)-\s*/i, '').trim()
  const initialSubject = `Outstanding Invoice ${invoice.invNo} for ${customerName}`
  const initialBody = buildDraftBody(invoice, customerName)

  const [to, setTo] = useState(initialTo)
  const [subject, setSubject] = useState(initialSubject)
  const [body, setBody] = useState(initialBody)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSendGmail = () => {
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  const handleMailto = () => {
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(body)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal email-draft-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>Email reminder · Invoice {invoice.invNo}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="email-draft-meta">
          <span><strong>{customerName}</strong></span>
          <span className="muted">·</span>
          <span>{money(invoice.outstanding, true)} outstanding</span>
          <span className="muted">·</span>
          <span>{invoice.daysOverdue > 0 ? `${invoice.daysOverdue} days overdue` : 'Not yet due'}</span>
        </div>
        <div className="email-draft-body">
          <label className="email-field">
            <span>To</span>
            <input type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@example.com" />
          </label>
          <label className="email-field">
            <span>Subject</span>
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="email-field">
            <span>Message</span>
            <textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        </div>
        <footer className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-ghost" onClick={handleCopy}>
            {copied ? '✓ Copied' : 'Copy message'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleMailto}>Open in mail app</button>
          <button type="button" className="btn btn-primary" onClick={handleSendGmail}>
            Send via Gmail
          </button>
        </footer>
      </div>
    </div>
  )
}

function buildDraftBody(inv, customerName) {
  const dateStr = (d) => d ? d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'N/A'
  const amt = money(inv.outstanding, true)
  // Reminder tone: short, friendly, action-oriented.
  const opener = inv.daysOverdue > 0
    ? 'This is a follow-up regarding the overdue invoice(s) currently pending on the account.'
    : 'This is a courtesy reminder regarding an invoice on the account approaching its due date.'
  const checkInLine = inv.daysOverdue > 0
    ? 'We wanted to check in on the payment status for the overdue balance and ensure nothing has been missed on either side.'
    : 'We wanted to share the upcoming due date so it can be planned for on your end.'
  const statusLine = inv.daysOverdue > 0
    ? `Status              :  ${inv.daysOverdue} days past due`
    : inv.daysOverdue < 0
      ? `Status              :  Due in ${Math.abs(inv.daysOverdue)} days`
      : `Status              :  Due today`
  // Portal Link section appears on EVERY email. Specific QB share URL (from
  // sheet's Link column) wins; otherwise we fall back to Little Tree's
  // customer portal so the line is never empty.
  const portalUrl = inv.qbLink || 'https://littletreeconfections.com/account'
  const portalSection = `Portal Link: ${portalUrl}\n\nPlease review the invoice through the link above and let us know one of the following:`

  return `Hi Team,

${opener}

${checkInLine}

────────────────────────────────────────────────
                  INVOICE DETAILS
────────────────────────────────────────────────
Invoice Number      :  ${inv.invNo}
Invoice Date        :  ${dateStr(inv.date)}
Due Date            :  ${dateStr(inv.dueDate)}
Outstanding Amount  :  ${amt}
${statusLine}
────────────────────────────────────────────────

${portalSection}

1. If payment has already been made, please share the payment details.
2. If payment is scheduled, please share the expected payment date.
3. If there is any issue with the invoice, please let us know so it can be resolved.

We truly value working with you and would like to keep everything aligned and easy on both sides. Your update will help us close the pending items appropriately from our end.

Best regards,
Accounts Receivable Team,
Little Tree Confections
`
}
