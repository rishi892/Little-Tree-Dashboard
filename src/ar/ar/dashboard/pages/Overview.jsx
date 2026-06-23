import { useMemo, useState, useEffect } from 'react'
import { BarChart, Bar, Cell, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import KpiCard from '../KpiCard.jsx'
import { monthlySales } from '../../lib/metrics.js'
import { wholesaleScope } from '../../lib/scope.js'
import { isPrivateLabel } from '../../lib/brands.js'
import { money, compactMoney, num, monthLabel } from '../../lib/format.js'
import { useNav } from '../../lib/navigation.jsx'
import { ColumnFilter, useColFilter } from '../components/ColumnFilter.jsx'
import InfoTip from '../components/InfoTip.jsx'
import { ExportButton } from '../../lib/csv.jsx'
import { flowComparison } from '../../lib/trends.js'
import { keepInTotal, keepInOperating, isDoubtful, OP_MODES, opModeLabel, opKeepText, opExclText } from '../../lib/dso.js'
import { useOverrides } from '../../lib/arOverrides.js'


const SEG_OPTIONS = [
  { key: 'all', label: 'All' },
  { key: 'lt', label: 'Little Tree' },
 { key: 'pl', label: 'Infused Origin' },
]

export default function Overview({ data }) {
  const { navigate, openCustomer, openInvoiceList, openCustomerReview } = useNav()
  const [seg, setSeg] = useState('all')
   const exec = useMemo(() => computeExec(data, seg), [data, seg])
  const defaultersF = useColFilter(exec.topDefaulters, (r) => r.vendor)
  const shownDefaulters = exec.topDefaulters.filter(defaultersF.pass)

  const [dsoOpen, setDsoOpen] = useState(false)
  const segLabel = SEG_OPTIONS.find((o) => o.key === seg)?.label || 'All'

  const showBucket = (label) => {
    const invs = exec.allOpen.filter((r) => r.agingBucket === label)
    openInvoiceList({
      title: `Aging bucket: ${label}`,
      subtitle: `${invs.length} open invoices`,
      invoices: invs,
      info: {
        title: `Aging bucket: ${label}`,
        purpose: `Open invoices that are ${label === 'Current' ? 'not yet due' : `${label} days past due`}. Outstanding = amount invoiced minus amount paid.`,
        source: 'Invoice tracker - open invoices bucketed by days past due date.',
      },
    })
  }

  const showAllOpen = () => openInvoiceList({
    title: `Cash to collect · ${segLabel}`,
    subtitle: `${exec.openCount} open invoices`,
    // Pass the full set (incl. payment-received) so they're reviewable/editable
    // in the popup; the modal keeps received out of its open total.
    invoices: exec.cashList,
    info: {
      title: 'Cash to collect',
      purpose: 'Amount yet to be received from customers. Outstanding = amount invoiced minus amount paid.',
      source: 'Invoice tracker - every open (unpaid) invoice.',
    },
  })

  const showReceivedPending = () => openInvoiceList({
    title: `Payment received · not applied · ${segLabel}`,
    subtitle: `${exec.received.length} invoices · ${money(exec.receivedPendingSum)}`,
    invoices: exec.cashList,
    initialMarked: 'received',
    info: {
      title: 'Payment received · not applied',
      purpose: 'Open invoices flagged as paid that have not yet been applied in the accounting system. These amounts are removed from Cash to collect.',
      source: 'Operator-entered payment status on the invoice detail view.',
    },
  })

  const showPlanPending = () => openInvoiceList({
    title: `Payment plan active · ${segLabel}`,
    subtitle: `${exec.plan.length} invoices · ${money(exec.planPendingSum)}`,
    invoices: exec.cashList,
    initialMarked: 'plan',
    info: {
      title: 'Payment plan active',
      purpose: 'Open invoices the customer is paying down on an agreed plan. These balances stay in Cash to collect.',
      source: 'Operator-entered payment status on the invoice detail view.',
    },
  })

  const showActionItems = () => {
    const invs = exec.allOpen.filter((r) => (r.daysOverdue || 0) > 0 || !r.followUpStatus)
    openInvoiceList({ title: `Action needed today · ${segLabel}`, subtitle: `${invs.length} invoices`, invoices: invs,
      info: {
        title: 'Action needed today',
        purpose: 'Open invoices that are past due or have no follow-up logged yet - the ones to chase now.',
        source: 'Invoice tracker - open invoices past due date or with a blank follow-up status.',
      },
    })
  }

  const showLatestMonth = () => {
    const k = exec.latestMonthKey
    if (!k) return
    const [y, m] = k.split('-').map(Number)
    const invs = exec.allInvoices.filter((r) => r.date && r.date.getFullYear() === y && r.date.getMonth() === m - 1)
    openInvoiceList({ title: `Sales · ${exec.latestMonthLabel} · ${segLabel}`, subtitle: `${invs.length} invoices`, invoices: invs, hideOutstanding: true,
      info: {
        title: `Sales · ${exec.latestMonthLabel}`,
        purpose: 'Total amount invoiced (billed) to customers in this month.',
        source: 'Finance sheet - invoices dated in this month.',
      },
    })
  }

  // Click a brand → its stores (skip the brand-grouping level).
  const openBrandStores = (brand) => {
    const invs = exec.allInvoices.filter((r) => (r.brand || 'No brand') === brand)
    if (!invs.length) return
    openInvoiceList({
      hideOutstanding: true,
      hideBrandLevel: true,
      title: `${brand} · stores`,
      subtitle: `${invs.length} invoices`,
      invoices: invs,
      info: {
        title: brand,
        purpose: "Every store under this brand, and their invoices.",
        source: 'Finance sheet (sales) + invoice tracker (status).',
      },
    })
  }


  return (
    <div className="page exec-page">
      {dsoOpen && <DsoYearModal invoices={exec.dsoInvoices} onOpenList={openInvoiceList} onClose={() => setDsoOpen(false)} />}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden' }}>
          {SEG_OPTIONS.map((o) => (
            <button key={o.key} onClick={() => setSeg(o.key)}
              style={{
                fontSize: 13, padding: '7px 16px', border: 'none', cursor: 'pointer',
                borderLeft: o.key !== SEG_OPTIONS[0].key ? '1px solid #e2e8f0' : 'none',
                background: seg === o.key ? '#15803d' : '#fff',
                color: seg === o.key ? '#fff' : '#475569',
                fontWeight: seg === o.key ? 600 : 500,
              }}>{o.label}</button>
          ))}
        </div>
      </div>

      <section className="exec-hero">
        <HeroKpi
          eyebrow="Cash to collect"
          value={money(exec.totalOutstanding)}
          sub={seg === 'all' ? `${num(exec.openCount)} open · ${money(exec.plOutstanding)} infused origin` : `${num(exec.openCount)} open invoices`}
          tone="warn"
          onClick={showAllOpen}
          info={{
            title: 'Cash to collect',
            purpose: 'Total your customers still owe you right now.',
            detail: 'Sum of the outstanding amount on every open (unpaid) invoice, where outstanding = amount invoiced minus amount paid. Little Tree wholesale only, and invoices with under $100 still owed are ignored. It is a live snapshot, not tied to any date range. Example: a $5,000 invoice with $2,000 paid contributes $3,000; across the whole book this comes to about $685,000.',
            source: 'Invoice tracker - every open invoice.',
          }}
        />

        {exec.received.length > 0 && (
          <HeroKpi
            eyebrow="Payment received · not applied"
            value={money(exec.receivedPendingSum)}
            sub={`${num(exec.received.length)} invoices · removed from Cash to collect`}
            tone="muted"
            onClick={showReceivedPending}
            info={{
              title: 'Payment received · not applied',
              purpose: 'Money that has come in but is not yet applied in the accounting system.',
              detail: 'Open invoices you flagged as Payment Received in the detail view: the payment arrived but has not been recorded in QuickBooks yet, so it is removed from Cash to collect and parked here until applied. Payment Plan invoices stay in Cash to collect and are not counted in this figure. Click to review, edit, or clear each flag.',
              source: 'Operator-entered payment status on the invoice detail view.',
            }}
          />
        )}

        {exec.plan.length > 0 && (
          <HeroKpi
            eyebrow="Payment plan active"
            value={money(exec.planPendingSum)}
            sub={`${num(exec.plan.length)} invoices · still in Cash to collect`}
            tone="muted"
            onClick={showPlanPending}
            info={{
              title: 'Payment plan active',
              purpose: 'Open invoices the customer is paying down on an agreed payment plan.',
              detail: 'Open invoices you flagged as Payment Plan Active in the detail view. Unlike Payment Received, these balances STAY in Cash to collect (the money is still owed) - this card just tracks which accounts are on a plan and their status. Click to review, edit, or clear each flag.',
              source: 'Operator-entered payment status on the invoice detail view.',
            }}
          />
        )}

        <HeroKpi
          eyebrow="Action needed today"
          value={num(exec.actionCount)}
          sub={`${money(exec.actionAmount)} priority follow-ups`}
          tone="bad"
          onClick={showActionItems}
          info={{
            title: 'Action needed today',
            purpose: 'How many open invoices, and how much money, need a collections touch today.',
            detail: 'Of the open invoices in Cash to collect, this counts (and sums by outstanding) the ones that are either past their due date OR have no follow-up status logged yet. It is a subset of Cash to collect. Example: of 120 open invoices, 38 are past-due or unflagged totalling $210,000.',
            source: 'Invoice tracker - open invoices past their due date or with a blank follow-up status.',
          }}
        />
        <HeroKpi
          eyebrow="Avg days to collect · Operating"
          value={`${exec.dso.toFixed(0)}d`}
          sub={exec.dsoSub}
          tone="muted"
          onClick={() => setDsoOpen(true)}
          info={{
            title: 'Avg days to collect (DSO)',
            purpose: 'Average number of days between invoicing a customer and getting paid.',
            detail: 'Value-weighted: sum of (days-to-pay x invoice amount) / total invoice amount, so larger invoices pull harder. Days-to-pay = (paid date, or today if unpaid) minus invoice date. Two views: Operating DSO (shown) = all years, with write-offs AND in-collections removed plus open invoices more than 180 days past due (the default cutoff); Total DSO (sub-line) = the selected years with only write-offs removed (in-collections kept). Click to change years (affects Total only) and see the excluded list. Example: a $10,000 invoice paid in 20 days and a $5,000 paid in 50 days give (10000*20 + 5000*50)/15000 = 30 days.',
            source: 'Invoice tracker - every billed invoice.',
          }}
        />
        <HeroKpi
          eyebrow={`Sales · ${exec.latestMonthLabel}`}
          value={compactMoney(exec.latestMonthSales)}
          sub={exec.growthLabel}
          tone={exec.growthPositive ? 'good' : 'warn'}
          onClick={showLatestMonth}
          info={{
            title: `Sales · ${exec.latestMonthLabel}`,
            purpose: 'What we invoiced in the most recent month, and how it compares year-on-year.',
            detail: 'The total amount invoiced (billed) to customers in the latest month with data. The change shown beneath is year-on-year versus the same month last year; if last year is missing it falls back to comparing against the previous month. Example: $90,000 this month vs $75,000 the same month last year = +20% YoY.',
            source: 'Finance sheet - invoices dated in this month.',
          }}
        />
      </section>

      {/* ============ ALERTS ============ */}
      <section className="exec-section">
        <div className="exec-section-head">
          <h2>What needs your attention</h2>
          <span className="exec-section-sub">Pulled from across the dashboard</span>
        </div>
        <div className="alert-grid">
          {exec.alerts.map((a, i) => (
            <button
              key={i}
              className={`alert-card alert-${a.tone}`}
              onClick={() => {
                if (a.review) {
                  openCustomerReview(a.review)
                } else if (a.invoices) {
                  openInvoiceList({
                    title: a.modalTitle || a.title,
                    subtitle: a.sub,
                    invoices: a.invoices,
                    info: a.info,
                  })
                } else if (a.target) {
                  navigate(a.target)
                }
              }}
            >
              {a.tip && <InfoTip {...a.tip} />}
              <div className="alert-icon">{a.icon}</div>
              <div className="alert-body">
                <div className="alert-title">{a.title}</div>
                <div className="alert-value">{a.value}</div>
                <div className="alert-sub">{a.sub}</div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* ============ TOP DEFAULTERS + AGING ============ */}
      <section className="grid-2">
        <div className="chart-card">
          <InfoTip
            title="Top defaulters"
            purpose="The eight customers who owe the most right now."
            detail="Open invoices are grouped by customer, their outstanding amounts are summed, and customers are ranked highest first (top 8 shown). Oldest = the days overdue of that customer's single most overdue invoice. Example: a customer with open invoices of $4,000 + $6,000 + $2,000 shows $12,000 outstanding, oldest 140 days."
            source="Invoice tracker - open invoices grouped by customer."
          />
          <div className="chart-head">
            <h3>Top defaulters · biggest open balances</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
              <span className="chart-sub">Sorted by outstanding amount</span>
              <ExportButton
                filename={`top-defaulters-${new Date().toISOString().slice(0, 10)}.csv`}
                title="Top defaulters"
                headers={['#', 'Customer', 'Outstanding', 'Oldest (days)']}
                rows={shownDefaulters.map((r, i) => [i + 1, r.vendor.replace(/^(Little Tree|Gelato)-\s*/i, ''), r.outstanding, r.oldest])}
              />
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Customer <ColumnFilter label="Customer" options={defaultersF.options} excluded={defaultersF.excluded} onChange={defaultersF.setExcluded} /></th>
                  <th className="num">Outstanding</th>
                  <th className="num">Oldest (days)</th>
                </tr>
              </thead>
              <tbody>
                {shownDefaulters.length === 0 && <tr><td colSpan="4" className="table-empty">Nothing outstanding - clean book.</td></tr>}
                {shownDefaulters.map((r, i) => (
                  <tr key={r.vendor} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                    <td className="muted">{i + 1}</td>
                    <td className="vendor-cell">{r.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                    <td className="num cell-warn">{money(r.outstanding)}</td>
                    <td className="num">{r.oldest}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="chart-card">
          <InfoTip
            title="Aging buckets · days past due"
            purpose="Splits what's owed by how far past the due date it is."
            detail="The outstanding amount on open invoices, banded by DAYS PAST DUE (today − due date; due date = the sheet's Due Date, or invoice date + 30 for Net 30 when blank): Current (not yet due), 1-30, 31-60, 61-90, 91-120, 121-180, and 180+. This is days past due, not days since the invoice date. Click a bar to list that band. Example: $200,000 in 1-30, $50,000 in 121-180, $30,000 in 180+."
            source="Invoice tracker - open invoices bucketed by days past due."
          />
          <div className="chart-head">
            <h3>Aging buckets · days past due</h3>
            <span className="chart-sub">Outstanding $ by days past due date</span>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={exec.buckets} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}
                formatter={(v) => money(v)}
              />
              <Bar dataKey="amount" radius={[6, 6, 0, 0]} cursor="pointer" onClick={(p) => p?.label && showBucket(p.label)}>
                {exec.buckets.map((b) => (
                  <Cell key={b.label} fill={BUCKET_COLORS[b.label] || '#94a3b8'} onClick={() => showBucket(b.label)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* ============ SALES TREND ============ */}
      <section className="chart-card">
        <InfoTip
          title="Monthly sales · last 12 months"
          purpose="The sales trend over the past year, compared with what we actually collected."
          detail="For each of the last 12 months it shows the total amount invoiced and the total amount paid. When the paid line sits below the invoiced line, collections are lagging behind sales. Example: in March we invoiced $90,000 but only $70,000 came in as paid."
          source="Finance sheet - invoiced and paid amounts per month."
        />
        <div className="chart-head">
          <h3>Monthly sales · last 12 months</h3>
          <span className="chart-sub">{segLabel} · invoiced vs paid</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={exec.trend} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} style={{ cursor: 'pointer' }}
            onClick={(st) => { const p = st?.activePayload?.[0]?.payload; const k = p?.key; if (!k) return; const [y, m] = k.split('-').map(Number); const invs = exec.allInvoices.filter((r) => r.date && r.date.getFullYear() === y && r.date.getMonth() === m - 1); if (invs.length) openInvoiceList({ hideOutstanding: true, title: `Sales · ${monthLabel(k)} · ${segLabel}`, subtitle: `${invs.length} invoices`, invoices: invs, comparison: flowComparison(exec.trend, p, 'sales', { upIsBad: false, labelFn: (q) => monthLabel(q.key) }) }) }}>
            <defs>
              <linearGradient id="execSales" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#15803d" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#15803d" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="execPaid" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#16a34a" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="key" tickFormatter={(k) => monthLabel(k, { short: true })} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}
              labelFormatter={(k) => monthLabel(k)}
              formatter={(v) => money(v)}
            />
            <Area type="monotone" dataKey="sales" stroke="#15803d" strokeWidth={2} fill="url(#execSales)" name="Invoiced" />
            <Area type="monotone" dataKey="paid" stroke="#16a34a" strokeWidth={2} fill="url(#execPaid)" name="Paid" />
          </AreaChart>
        </ResponsiveContainer>
      </section>

      {/* ============ CUSTOMERS NEEDING ATTENTION ============ */}
      <section className="grid-2">
        <ReviewSnapshot
          title="Recently churned"
          subtitle={`Active in ${exec.prevYear}, $0 this year · by brand`}
          rows={exec.churnedBrands}
          totalCount={exec.churnedBrands.length}
          metricLabel="Prior year"
          metricKey="pySales"
          onOpenCustomer={openBrandStores}
          info={{
            title: 'Recently churned',
            purpose: 'Brands that were buying last year but have ordered nothing this calendar year.',
            detail: `Brands (all their stores combined) with more than $1,000 of sales in ${exec.prevYear} but $0 so far this year, ranked by prior-year revenue. The Prior year column is the revenue now at risk. Example: a brand at $40,000 last year and $0 this year tops the list.`,
            source: 'Finance sheet (Gelato AR sheet on the Gelato page).',
          }}
        />
        <DsoByRepCard invoices={exec.dsoInvoices} onOpenList={openInvoiceList} />
      </section>
    </div>
  )
}

// DSO per sales rep (dollar-weighted), Operating vs Total. Same definitions as
// the AR DSO tab: Operating removes write-offs + in-collections + open >180d
// past due; Total removes only write-offs.
function DsoByRepCard({ invoices, onOpenList }) {
  const [opCutoff, setOpCutoff] = useState('within')
  const [years, setYears] = useState(() => new Set([2024, 2025, 2026]))
  const toggleYear = (y) => setYears((p) => { const n = new Set(p); if (n.has(y)) n.delete(y); else n.add(y); return n })
  const overrides = useOverrides()
  const rows = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const byRep = new Map()
    for (const r of invoices) {
      if (!r.date || r.invoiceAmount <= 0) continue
      const rep = r.salesRep || 'Unassigned'
      if (!byRep.has(rep)) byRep.set(rep, [])
      byRep.get(rep).push(r)
    }
    return [...byRep.entries()]
      .map(([rep, invs]) => {
        const { total, operating, count, opCount } = computeDso(invs, [...years], today, opCutoff)
        const open = invs.filter((r) => !r.paidDate)
        const outstanding = open.reduce((s, r) => s + (r.outstanding || 0), 0)
        return { rep, total, operating, count, opCount, openCount: open.length, outstanding, invoices: invs }
      })
      .filter((r) => r.count > 0 || r.opCount > 0)
      .filter((r) => r.rep !== 'Unassigned')
      .sort((a, b) => b.operating - a.operating)
  }, [invoices, opCutoff, years, overrides])

  const openRep = (r) => {
    if (!onOpenList) return
    const base = r.invoices.filter((x) => !x.isWriteOff && !x.isCollection)
    onOpenList({
      title: r.rep === 'Unassigned' ? 'Unassigned - no sales rep' : `Rep · ${r.rep}`,
      subtitle: `${base.length} invoices · Operating DSO ${r.operating.toFixed(0)}d · ${cutoffText(opCutoff)}`,
      invoices: base,
      cutoffFilter: true,
      initialCutoff: opCutoff,
    })
  }

  return (
    <div className="chart-card">
      <InfoTip
        title="DSO by rep"
        purpose="Average days to collect per sales rep - who collects fast versus slow."
        detail="For each rep, dollar-weighted DSO = Σ(days to pay × amount) ÷ Σ amount over all their invoices (paid + open). Operating DSO always removes write-offs and in-collections, then applies the Operating scope: 'Up to 180 days' (default) keeps invoices up to 180 days past due and drops the whole 180+ tail; 'Over 180 days' keeps the full book (up-to-180 plus the 180+ tail), only dropping 2022 & 2023. Total DSO removes only write-offs. Sorted slowest Operating DSO first. Click a rep to see their invoices."
        source="Invoice tracker."
      />
      <div className="chart-head">
        <div>
          <h3>DSO by rep</h3>
          <span className="chart-sub">Operating ({opModeLabel(opCutoff)}) vs Total (selected years) · slowest first</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 7, overflow: 'hidden' }} title="Years filter Total DSO only (Operating uses the chosen scope over all years)">
            {DSO_PICK_YEARS.map((y) => (
              <button key={y} onClick={() => toggleYear(y)}
                style={{
                  fontSize: 13, padding: '6px 12px', border: 'none', cursor: 'pointer',
                  borderLeft: y !== DSO_PICK_YEARS[0] ? '1px solid #e2e8f0' : 'none',
                  background: years.has(y) ? '#15803d' : '#fff',
                  color: years.has(y) ? '#fff' : '#475569',
                }}>{y}</button>
            ))}
          </div>
          <CutoffSelect value={opCutoff} onChange={setOpCutoff} />
          <ExportButton
            filename={`dso-by-rep-${new Date().toISOString().slice(0, 10)}.csv`}
            headers={['Rep', 'Open invoices', 'Outstanding', 'Operating DSO', 'Total DSO']}
            rows={rows.map((r) => [r.rep, r.openCount, r.outstanding.toFixed(2), r.operating > 0 ? `${r.operating.toFixed(0)}d` : '', r.total > 0 ? `${r.total.toFixed(0)}d` : ''])}
          />
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Rep</th>
              <th className="num">Open</th>
              <th className="num">Outstanding</th>
              <th className="num" title="Write-offs + in-collections removed; uses the chosen Operating scope (default: up to 180 days past due)">Operating DSO</th>
              <th className="num" title="Selected years · write-offs removed (in-collections kept)">Total DSO</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="5" className="table-empty">No rep DSO data.</td></tr>}
            {rows.map((r) => (
              <tr key={r.rep} className="clickable-row" onClick={() => openRep(r)} title={`See ${r.rep}'s invoices`}>
                <td className="vendor-cell">{r.rep}</td>
                <td className="num">{num(r.openCount)}</td>
                <td className="num cell-warn">{r.outstanding > 0 ? money(r.outstanding, true) : ''}</td>
                <td className="num"><strong>{r.operating > 0 ? `${r.operating.toFixed(0)}d` : '-'}</strong></td>
                <td className="num muted">{r.total > 0 ? `${r.total.toFixed(0)}d` : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ReviewSnapshot({ title, subtitle, rows, totalCount, metricLabel, metricKey, metricFormat, onReviewAll, onOpenCustomer, info }) {
  const custF = useColFilter(rows, (r) => r.vendor)
  const shown = rows.filter(custF.pass)
  return (
    <div className="chart-card">
      {info && <InfoTip {...info} />}
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          <span className="chart-sub">{subtitle}</span>
        </div>
        {totalCount > rows.length && (
          <button className="export-btn" onClick={onReviewAll}>
            Review all {totalCount} →
          </button>
        )}
      </div>
      <div className="table-wrap">
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Customer <ColumnFilter label="Customer" options={custF.options} excluded={custF.excluded} onChange={custF.setExcluded} /></th>
              <th className="num">Last invoice</th>
              <th className="num">{metricLabel}</th>

            </tr>
          </thead>
          <tbody>
             {shown.map((r) => {
              const m = r[metricKey]

              let display = '-'
              if (m != null) {
                if (metricFormat === 'pct') display = `${m >= 0 ? '+' : ''}${m.toFixed(0)}%`
                else display = compactMoney(m)
              }
              return (
                <tr key={r.vendor} className="clickable-row" onClick={() => onOpenCustomer(r.vendor)}>
                  <td className="vendor-cell">{r.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                  <td className="num muted">{r.daysSilent != null ? `${r.daysSilent}d ago` : '-'}</td>
                  <td className={`num ${metricFormat === 'pct' ? 'cell-warn' : ''}`}>{display}</td>
                </tr>
              )
            })}
            {shown.length === 0 && (
              <tr><td colSpan="3" className="table-empty">Nothing here - clean book.</td></tr>
            )}

          </tbody>
        </table>
      </div>
    </div>
  )
}

function SegmentChooser({ title, lt, pl, metric, onPick, onClose }) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  const sum = (arr) => arr.reduce((s, r) => s + (metric === 'invoiceAmount' ? r.invoiceAmount : (r.outstanding || 0)), 0)
  const segs = [
    { label: 'All', arr: [...lt, ...pl] },
    { label: 'Little Tree', arr: lt },
    { label: 'Private Label', arr: pl },
  ]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-head-inner"><div>
            <div className="modal-eyebrow">Choose segment</div>
            <h3 className="modal-title">{title}</h3>
          </div></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </header>
        <div className="modal-body">
          <div style={{ display: 'grid', gap: 12 }}>
            {segs.map((s) => (
              <button
                key={s.label}
                className="hero-kpi hero-clickable"
                style={{ textAlign: 'left' }}
                disabled={s.arr.length === 0}
                onClick={() => onPick(s.label, s.arr)}
              >
                <div className="hero-eyebrow">{s.label}</div>
                <div className="hero-value">{money(sum(s.arr))}</div>
                <div className="hero-sub">{num(s.arr.length)} invoices</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============ Helpers ============
// keepInTotal / keepInOperating / isDoubtful and the scope text helpers come from
// ../../lib/dso.js (two-mode Operating model: 'within' = up to 180 days past due,
// 'over' = more than 180 days past due with 2022/2023 excluded).
const cutoffText = opKeepText
const cutoffExclText = opExclText

// Two dollar-weighted DSO views. Total uses the YEAR filter; Operating ignores
// years (it's the clean collectible book) and uses the Operating scope (mode).
function computeDso(invoices, years, today, mode = 'within') {
  let totD = 0, totA = 0, totN = 0, opD = 0, opA = 0, opN = 0
  for (const r of invoices) {
    if (!r.date || r.invoiceAmount <= 0) continue
    const end = r.paidDate || today
    const d = (end - r.date) / 86400000
    if (d < 0 || d > 3650) continue
    const inYear = !years || !years.length || years.includes(r.date.getFullYear())
    if (inYear && keepInTotal(r)) { totD += d * r.invoiceAmount; totA += r.invoiceAmount; totN += 1 }
    if (keepInOperating(r, mode)) { opD += d * r.invoiceAmount; opA += r.invoiceAmount; opN += 1 }
  }
  const operating = opA > 0 ? opD / opA : 0
  return { total: totA > 0 ? totD / totA : 0, operating, dso: operating, count: totN, opCount: opN }
}

// Reusable Operating-scope dropdown.
function CutoffSelect({ value, onChange }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}
      title="Operating DSO scope. 'Up to 180 days' = the healthy book (everything 180+ days past due is excluded - paid, open, in-collections or written-off). 'Over 180 days' = the full book (up-to-180 plus the 180+ tail), with only 2022 & 2023 excluded. Write-offs & in-collections always excluded. Runs over all years.">
      Operating scope:
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ fontSize: 13, padding: '6px 10px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', color: '#475569' }}>
        {OP_MODES.map(([v, label]) => <option key={v} value={v}>{label}{v === 'within' ? ' (default)' : ''}</option>)}
      </select>
    </label>
  )
}

const DSO_PICK_YEARS = [2026, 2025, 2024, 2023]
function DsoYearModal({ invoices, onOpenList, onClose }) {
  const [years, setYears] = useState(() => new Set([2024, 2025, 2026]))
  const [opCutoff, setOpCutoff] = useState('within')
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }, [])
  const toggle = (y) => setYears((p) => { const n = new Set(p); if (n.has(y)) n.delete(y); else n.add(y); return n })

  const segs = [
    { label: 'All', match: () => true },
    { label: 'Little Tree', match: (r) => !r.isPrivateLabelCustomer },
    { label: 'Infused Origin', match: (r) => r.isPrivateLabelCustomer },
  ].map((s) => {
    const set = invoices.filter(s.match) // all years; computeDso year-filters Total only
    const { total, operating, count } = computeDso(set, [...years], today, opCutoff)
    const open = set.filter((r) => !r.paidDate)
    const opBase = set.filter((r) => !r.isWriteOff && !r.isCollection) // pre-cutoff operating set
    return { label: s.label, total, operating, dso: operating, count, open, opBase }
  })
  const overall = segs[0] // "All" = overall DSO across the book
  const doubtful = useMemo(() => invoices.filter((r) => isDoubtful(r, opCutoff)), [invoices, opCutoff])

  const showList = (s) => {
    onOpenList({
      title: `Operating DSO · ${s.label}`,
      subtitle: `${s.opBase.length} invoices · DSO ${s.operating.toFixed(1)}d · ${cutoffText(opCutoff)}`,
      invoices: s.opBase,
      cutoffFilter: true,
      initialCutoff: opCutoff,
    })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <div className="modal-head-inner">
            <div>
              <div className="modal-eyebrow">Avg days to collect</div>
              <h3 className="modal-title">By segment</h3>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>Click a segment to see its open invoices contributing</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <CutoffSelect value={opCutoff} onChange={setOpCutoff} />
            <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 7, overflow: 'hidden' }} title="Years filter Total DSO only">
              {DSO_PICK_YEARS.map((y) => (
                <button key={y} onClick={() => toggle(y)}
                  style={{
                    fontSize: 13, padding: '6px 12px', border: 'none', cursor: 'pointer',
                    borderLeft: y !== DSO_PICK_YEARS[0] ? '1px solid #e2e8f0' : 'none',
                    background: years.has(y) ? '#15803d' : '#fff',
                    color: years.has(y) ? '#fff' : '#475569',
                  }}>{y}</button>
              ))}
            </div>
            <button className="modal-close" onClick={onClose} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </div>
        </header>
        <div className="modal-body">
          <div className="exec-hero" style={{ marginBottom: 14 }}>
            <div className="hero-kpi hero-muted">
              <div className="hero-eyebrow">Overall · Operating DSO ({opModeLabel(opCutoff)})</div>
              <div className="hero-value">{overall.operating.toFixed(1)}d</div>
              <div className="hero-sub">all years · write-offs + collections out · {cutoffText(opCutoff)}</div>
            </div>
            <div className="hero-kpi hero-muted">
              <div className="hero-eyebrow">Overall · Total DSO</div>
              <div className="hero-value">{overall.total.toFixed(1)}d</div>
              <div className="hero-sub">{num(overall.count)} invoices · selected years · write-offs out</div>
            </div>
          </div>
          {doubtful.length > 0 && (
            <button
              className="alert-card alert-warn"
              style={{ cursor: 'pointer', width: '100%', textAlign: 'left', marginBottom: 14 }}
              onClick={() => { onOpenList({ title: 'Excluded from Operating DSO', subtitle: `${doubtful.length} invoices · ${cutoffExclText(opCutoff)}`, invoices: doubtful }); onClose() }}
            >
              <div className="alert-icon">!</div>
              <div className="alert-body">
                <div className="alert-title">{num(doubtful.length)} invoices excluded from Operating DSO</div>
                <div className="alert-sub">{cutoffExclText(opCutoff)} - click to view the list</div>
              </div>
            </button>
          )}
          <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
            Years buttons affect <strong>Total DSO</strong> only. <strong>Operating DSO</strong> uses the chosen scope (default Up to 180 days) over all years.
          </div>
          <div className="muted" style={{ fontSize: 12.5, fontWeight: 600, margin: '0 0 8px' }}>By segment (click for open invoices)</div>
          <div style={{ display: 'grid', gap: 12 }}>
            {segs.map((s) => (
              <button key={s.label} className="hero-kpi hero-clickable" style={{ textAlign: 'left' }} onClick={() => showList(s)}>
                <div className="hero-eyebrow">{s.label}</div>
                <div className="hero-value">{s.operating.toFixed(1)}d <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--d-text-muted)' }}>operating</span></div>
                <div className="hero-sub">Total {s.total.toFixed(1)}d · {num(s.count)} invoices · {num(s.open.length)} open</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}


function HeroKpi({ eyebrow, value, sub, tone, onClick, info }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className={`hero-kpi hero-${tone || ''} ${onClick ? 'hero-clickable' : ''}`} onClick={onClick}>
      {info && <InfoTip {...info} />}
      <div className="hero-eyebrow">{eyebrow}</div>
      <div className="hero-value">{value}</div>
      <div className="hero-sub">{sub}</div>
    </Tag>
  )
}

function normalizeInvKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s/g, '')
}

const BUCKET_COLORS = {
  'Current': '#0ea5e9',
  '1–30': '#16a34a',
  '31–60': '#84cc16',
  '61–90': '#eab308',
  '91–120': '#f97316',
  '121–180': '#ea580c',
  '180+': '#dc2626',
}

const SEG_MATCH = {
  all: () => true,
  lt: (r) => !r.isPrivateLabelCustomer,
  pl: (r) => r.isPrivateLabelCustomer,
}

function computeExec(data, segment = 'all') {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const match = SEG_MATCH[segment] || SEG_MATCH.all
  const ws0 = wholesaleScope(data)
  const ws = {
    ...ws0,
    invoices: ws0.invoices.filter(match),
    financials: ws0.financials.filter(match),
  }
  const dataInvoices = data.invoices.filter(match)
  const dataFinancials = data.financials.filter(match)


  // Outstanding totals - Little Tree wholesale only (Gelato has its own page)
   // Cash to collect = ALL outstanding Little Tree AR, including the "Gelato-"
  // prefixed Pure X records mis-logged in the LT sheet (their Brand is a real
  // LT customer). Keep the private-label + sub-$100 policy filters, but do NOT
  // drop Pure X here - so this matches the source sheet's ~$684,749.
   // Candidates = open LT wholesale invoices with a gross balance ≥ $100. A
   // payment-received amount reduces r.outstanding (see tagPaymentStatus), so a
   // PARTIAL receipt leaves the remainder here and a FULL receipt drops it
   // (remaining 0). Plan invoices stay fully open.
   const ltCand = dataInvoices.filter((r) =>
    (r.isOutstandingOrig ?? r.isOutstanding) &&
    !isPrivateLabel(ws.vendorBrand.get(r.vendor) || r.brand) &&
    (r.outstandingGross ?? r.outstanding ?? 0) >= 100
  )
  // Stays on this card until the invoice tracker marks it paid (then isOutstanding
  // goes false and it drops out automatically). The "in accounting" flag is just
  // a recorded note and does not remove it here.
  // Only count a flag once it's COMPLETE (date + amount filled). An invoice has a
  // single status, so it appears in exactly one of these cards - never both.
  const ltReceived = ltCand.filter((r) => r.paymentStatus === 'received' && r.paymentComplete)
  const ltPlan = ltCand.filter((r) => r.paymentStatus === 'plan' && r.paymentComplete)
  const ltOpen = ltCand.filter((r) => (r.outstanding || 0) > 0)
  // Money received but not applied = original balance minus the remaining one.
  const receivedPendingSum = ltReceived.reduce((s, r) => s + ((r.outstandingGross ?? r.outstanding ?? 0) - (r.outstanding || 0)), 0)
  const planPendingSum = ltPlan.reduce((s, r) => s + (r.payment?.planAmount || r.outstanding || 0), 0)
  const totalOutstanding = ltOpen.reduce((s, r) => s + r.outstanding, 0)
  const openCount = ltOpen.length
  const plOutstanding = ltOpen.filter((r) => r.isPrivateLabelCustomer).reduce((s, r) => s + r.outstanding, 0)

  // Action needed = outstanding invoices with daysOverdue > 0 or no follow-up
  const allOpen = ltOpen
  const actionItems = allOpen.filter((r) => (r.daysOverdue || 0) > 0 || !r.followUpStatus)
  const actionCount = actionItems.length
  const actionAmount = actionItems.reduce((s, r) => s + r.outstanding, 0)

  // DSO - operator method, identical to the By-Rep + DSO-Trend tabs:
  //   DSO = Σ(daysToPay × invoiceAmount) ÷ Σ(invoiceAmount)
  //   daysToPay = (paidDate || today) − invoiceDate. Every billed invoice counts
  //   (collection included, write-off excluded; partially-paid frozen at its paid date).
  // DSO set - full tracker minus private-label (no year/<$100 filter); the
  // breakdown modal re-filters by year. Default headline = 2024–2026.
  const dsoSet = dataInvoices.filter((r) =>
    !isPrivateLabel(ws.vendorBrand.get(r.vendor) || r.brand) && r.date)

  const dsoDefault = computeDso(dsoSet, [2024, 2025, 2026], today)
  const dso = dsoDefault.operating
  const dsoSub = `Total ${dsoDefault.total.toFixed(0)}d · ${num(dsoDefault.count)} invoices`

  // Latest month sales + YoY growth.
  // trend12 = 12-month window for the chart. trendWin = wider 25-month window so
  // the same month LAST YEAR is actually present (a 12-entry window almost never
  // contains it, which silently degraded "YoY" into month-over-month).
  const trend12 = monthlySales(ws.financials, 12)
  const trendWin = monthlySales(ws.financials, 25)
  const last = trendWin[trendWin.length - 1] || { sales: 0, paid: 0, key: '' }
  // Compare same month last year
  const [ly, lm] = last.key ? last.key.split('-').map(Number) : [0, 0]
  const yoyKey = last.key ? `${ly - 1}-${String(lm).padStart(2, '0')}` : null
  const yoyEntry = trendWin.find((m) => m.key === yoyKey)
  let growthPositive = true, growthLabel = ''
  if (yoyEntry && yoyEntry.sales > 0) {
    const pct = ((last.sales - yoyEntry.sales) / yoyEntry.sales) * 100
    growthPositive = pct >= 0
    growthLabel = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% YoY`
  } else if (trendWin.length >= 2) {
    const prev = trendWin[trendWin.length - 2]
    if (prev.sales > 0) {
      const pct = ((last.sales - prev.sales) / prev.sales) * 100
      growthPositive = pct >= 0
      growthLabel = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs prev month`
    }
  }
  const latestMonthLabel = last.key ? monthLabel(last.key, { short: true }) : 'Latest'

  // Aging buckets (Little Tree wholesale only - current snapshot)
  const buckets = { 'Current': 0, '1–30': 0, '31–60': 0, '61–90': 0, '91–120': 0, '121–180': 0, '180+': 0 }
  allOpen.forEach((r) => {
    const b = buckets[r.agingBucket] != null ? r.agingBucket : '180+'
    buckets[b] += r.outstanding
  })
  const bucketArr = Object.entries(buckets).map(([label, amount]) => ({ label, amount }))

  // Top defaulters (Little Tree wholesale only)
  const defMap = new Map()
  allOpen.forEach((r) => {
    const cur = defMap.get(r.vendor) || { vendor: r.vendor, outstanding: 0, oldest: 0 }
    cur.outstanding += r.outstanding
    if ((r.daysOverdue || 0) > cur.oldest) cur.oldest = r.daysOverdue || 0
    defMap.set(r.vendor, cur)
  })
  const topDefaulters = [...defMap.values()].sort((a, b) => b.outstanding - a.outstanding).slice(0, 8)


  // Churned this year + Declining (wholesale only) - customer-level rollup
  // with the fields the review-style modal expects (last activity, email,
  // outstanding, YoY%). The inline tables show a short top-N preview; the
  // full review list lives in CustomerReviewList opened from the alert.
  const cy = today.getFullYear()
  const py = cy - 1
  const custMap = new Map()
  ws.financials.forEach((r) => {
    if (!r.date) return
    const cur = custMap.get(r.vendor) || {
      vendor: r.vendor, cySales: 0, pySales: 0, lifetime: 0, lastOrder: null,
    }
    cur.lifetime += r.invoiceAmount
    const y = r.date.getFullYear()
    if (y === cy) cur.cySales += r.invoiceAmount
    else if (y === py) cur.pySales += r.invoiceAmount
    if (!cur.lastOrder || (r.date && r.date > cur.lastOrder)) cur.lastOrder = r.date
    custMap.set(r.vendor, cur)
  })
  // Per-vendor metadata (outstanding $, email) - pulled from the AR sheet
  const vendorMeta = new Map()
  ws.invoices.forEach((r) => {
    const meta = vendorMeta.get(r.vendor) || { outstanding: 0, email: '' }
    if (r.isOutstanding) meta.outstanding += r.outstanding
    if (!meta.email && r.email) meta.email = r.email
    vendorMeta.set(r.vendor, meta)
  })
  const enrich = (c, status) => {
    const meta = vendorMeta.get(c.vendor) || {}
    const daysSilent = c.lastOrder ? Math.floor((today - c.lastOrder) / 86400000) : null
    const yoyPct = c.pySales > 0 ? ((c.cySales - c.pySales) / c.pySales) * 100 : null
    return { ...c, status, daysSilent, yoyPct, outstanding: meta.outstanding || 0, email: meta.email || '' }
  }
  const customers = [...custMap.values()]
  const churnedAll = customers
    .filter((c) => c.pySales > 1000 && c.cySales === 0)
    .map((c) => enrich(c, 'Churned'))
    .sort((a, b) => b.pySales - a.pySales)
  const decliningAll = customers
    .filter((c) => c.pySales > 1000 && c.cySales > 0 && c.cySales < c.pySales * 0.5)
    .map((c) => enrich({ ...c, pctChange: ((c.cySales - c.pySales) / c.pySales) * 100 }, 'Declining'))
    .sort((a, b) => a.pctChange - b.pctChange)
  // Inline previews - top 6 only (full list shown in review modal)
  const churned = churnedAll.slice(0, 6)
  const declining = decliningAll.slice(0, 6)

  // Brand-level YoY: combine every store under a brand, then flag the brand as
  // declining only if its COMBINED sales fell >50% (one healthy store keeps the
  // whole brand off the list). Used by the brand-wise "Biggest YoY drops" card.
  const brandYoy = new Map()
  ws.financials.forEach((r) => {
    if (!r.date) return
    const b = ws.vendorBrand.get(r.vendor) || r.brand || 'No brand'
    const cur = brandYoy.get(b) || { vendor: b, cySales: 0, pySales: 0, lifetime: 0, lastOrder: null }
    cur.lifetime += r.invoiceAmount
    const y = r.date.getFullYear()
    if (y === cy) cur.cySales += r.invoiceAmount
    else if (y === py) cur.pySales += r.invoiceAmount
    if (!cur.lastOrder || r.date > cur.lastOrder) cur.lastOrder = r.date
    brandYoy.set(b, cur)
  })
  // Outstanding $ per brand (combine every store's open balance) for the churned-brands review.
  const brandOutstanding = new Map()
  ws.invoices.forEach((r) => {
    if (!r.isOutstanding) return
    const b = ws.vendorBrand.get(r.vendor) || r.brand || 'No brand'
    brandOutstanding.set(b, (brandOutstanding.get(b) || 0) + r.outstanding)
  })
  // Every invoice grouped by brand (same brand key as the YoY rollup), so a
  // churned-brand row can drill into its stores + their invoice detail.
  const brandInvoices = new Map()
  dataInvoices.forEach((r) => {
    const b = ws.vendorBrand.get(r.vendor) || r.brand || 'No brand'
    if (!brandInvoices.has(b)) brandInvoices.set(b, [])
    brandInvoices.get(b).push(r)
  })
  const decliningBrands = [...brandYoy.values()]
    .filter((c) => c.vendor !== 'No brand' && c.pySales > 1000 && c.cySales > 0 && c.cySales < c.pySales * 0.5)
    .map((c) => ({
      ...c,
      daysSilent: c.lastOrder ? Math.floor((today - c.lastOrder) / 86400000) : null,
      yoyPct: ((c.cySales - c.pySales) / c.pySales) * 100,
      pctChange: ((c.cySales - c.pySales) / c.pySales) * 100,
    }))
    .sort((a, b) => a.pctChange - b.pctChange)
  // A brand is churned only if NONE of its stores sold this year (combined $0).
  const churnedBrands = [...brandYoy.values()]
    .filter((c) => c.vendor !== 'No brand' && c.pySales > 1000 && c.cySales === 0)
    .map((c) => ({
      ...c,
      status: 'Churned',
      daysSilent: c.lastOrder ? Math.floor((today - c.lastOrder) / 86400000) : null,
      yoyPct: null,
      outstanding: brandOutstanding.get(c.vendor) || 0,
      email: '',
      invoices: brandInvoices.get(c.vendor) || [],
    }))
    .sort((a, b) => b.pySales - a.pySales)
  const churnedBrandsPyTotal = churnedBrands.reduce((s, c) => s + (c.pySales || 0), 0)

  // Reconciliation issues - only 2023+ (2022 too stale to chase).
  // Build the mismatch rows FIRST and count from there, so the card number
  // always matches what shows up in the drill-down popup.
  const reconStart = 2023
  const reconInWindow = (r) => !r.date || r.date.getFullYear() >= reconStart
  const trackerMap = new Map(
    dataInvoices.filter(reconInWindow).map((r) => [normalizeInvKey(r.invNo), r])
  )
  const finMap = new Map(
    dataFinancials.filter(reconInWindow).map((r) => [normalizeInvKey(r.invNo), r])
  )
  const issueRows = []
  trackerMap.forEach((t, k) => {
    if (!k) return
    if (!finMap.has(k) && t.invoiceAmount > 0) {
      issueRows.push({ ...t, _issue: 'In tracker only' })
    }
  })
  finMap.forEach((f, k) => {
    if (!k) return
    if (!trackerMap.has(k) && f.invoiceAmount > 0) {
      issueRows.push({
        invNo: f.invNo, vendor: f.vendor, date: f.date,
        invoiceAmount: f.invoiceAmount, invoicePaid: f.invoicePaid,
        outstanding: Math.max(0, f.invoiceAmount - f.invoicePaid),
        status: 'Financials only', isOutstanding: false,
        _issue: 'In financials only',
      })
    }
  })
  const reconIssues = issueRows.length

  // 180+ days (worst bucket - invoices older than 6 months from invoice date)
  const past90Items = allOpen.filter((r) => r.agingBucket === '180+')
  const past90Sum = past90Items.reduce((s, r) => s + r.outstanding, 0)

  // In collections
    const collForCard = dataInvoices.filter((r) => r.isCollection && !isPrivateLabel(ws.vendorBrand.get(r.vendor) || r.brand))
  const inCollections = collForCard.reduce((s, r) => s + r.outstanding, 0)

   const collectionInvoices = collForCard


  // DSO universe - open invoices contributing to current DSO calc
  const dsoOpen = ws.invoices.filter((r) => r.isOutstanding && !r.isCollection && !r.isWriteOff)

  const churnedPyTotal = churnedAll.reduce((s, r) => s + (r.pySales || 0), 0)

  const alerts = [
    {
      tone: 'bad',
      icon: '!',
      title: '180+ days old (worst bucket)',
      value: money(past90Sum),
      sub: `${num(past90Items.length)} invoices need urgent collection action`,
      invoices: past90Items,
      tip: {
        title: '180+ days old (worst bucket)',
        purpose: 'Money tied up in invoices more than six months overdue - the balance most likely to be written off.',
        detail: 'Total outstanding and count of open invoices in the 180+ aging bucket (more than 180 days past their due date). Click to list them. Example: 34 invoices over 180 days totalling $146,000.',
        source: 'Invoice tracker.',
      },
    },
    {
      tone: 'warn',
      icon: 'x',
      title: `Brands churned (${cy})`,
      value: num(churnedBrands.length),
      sub: `${compactMoney(churnedBrandsPyTotal)} prior-year revenue lost`,
      tip: {
        title: `Brands churned (${cy})`,
        purpose: 'Brands that were buying last year but have ordered nothing this year, and the revenue that left with them.',
        detail: `Brands (all their stores combined) with more than $1,000 of sales last year (${py}) but $0 so far this year (${cy}); a brand stays OFF this list if any one of its stores has ordered this year. The value is the brand's combined prior-year revenue. Caveat: the year is only part complete, so a brand that usually buys later can be flagged early - the Customer Health tab avoids this by using order recency. Example: a brand at $40,000 last year and $0 across all its stores this year is one churned brand, $40,000 lost.`,
        source: 'Finance sheet.',
      },
      // Brand-level review (a brand counts only if every store is silent this year)
      review: {
        drill: 'brand',
        title: `${churnedBrands.length} churned brands · ${cy}`,
        subtitle: `Brands with > $1K in ${py} but $0 across all stores in ${cy} - review for outreach`,
        customers: churnedBrands,
        summary: [
          { label: 'Brands churned', value: num(churnedBrands.length) },
          { label: 'Prior-year revenue lost', value: compactMoney(churnedBrandsPyTotal), tone: 'warn' },
          { label: 'Lifetime exposure', value: compactMoney(churnedBrands.reduce((s, c) => s + (c.lifetime || 0), 0)) },
        ],
      },
    },
    {
      tone: 'bad',
      icon: 'C',
      title: 'In collections agency',
      value: money(inCollections),
      sub: 'Unlikely to recover without intervention',
      invoices: collectionInvoices,
      tip: {
        title: 'In collections agency',
        purpose: 'Money already handed to a collections agency, unlikely to return without intervention.',
        detail: 'Total outstanding on open invoices flagged as in collections (private-label included); the Collection Agency column names who is chasing each one. Click to list them. Example: 4 invoices with the agency totalling $18,000.',
        source: 'Invoice tracker - invoices marked as in collections.',
      },
    },
    {
      tone: reconIssues > 50 ? 'warn' : 'muted',
      icon: 'R',
      title: 'Reconciliation issues',
      value: num(reconIssues),
      sub: 'Tracker vs financials sheet mismatches',
      invoices: issueRows,
      modalTitle: `Reconciliation issues · ${issueRows.length} mismatches`,
      tip: {
        title: 'Reconciliation issues',
        purpose: 'Invoices that do not line up between the two sheets, meaning a number is wrong until fixed.',
        detail: 'Counts invoices present in only one sheet (in the tracker but not the finance sheet, or the reverse), 2023 onward. Click to list them. The full Reconciliation tab adds amount, paid and status mismatches. Example: invoice 1043 is in the tracker only, so it counts as one issue.',
        source: 'Invoice tracker vs finance sheet.',
      },
    },
  ]

    return {
    totalOutstanding, openCount, plOutstanding, actionCount, actionAmount,
      dso, dsoSub, dsoInvoices: dsoSet,
    latestMonthSales: last.sales, latestMonthLabel, latestMonthKey: last.key, growthLabel, growthPositive,
    buckets: bucketArr, topDefaulters,
    churned, declining,
    decliningBrands, churnedBrands,
    churnedTotal: churnedAll.length,
    decliningTotal: decliningAll.length,
    churnedReview: alerts.find((a) => a.title.startsWith('Customers churned'))?.review,
    decliningReview: alerts.find((a) => a.title.startsWith('Declining'))?.review,
    prevYear: py,
    trend: trend12,
    alerts,
    allOpen,
    cashList: ltCand,
    received: ltReceived,
    receivedPendingSum,
    plan: ltPlan,
    planPendingSum,
    allInvoices: dataInvoices,
  }
}

