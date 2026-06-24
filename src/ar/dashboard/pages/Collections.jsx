import { useMemo, useState, useEffect, useCallback } from 'react'
import KpiCard from '../KpiCard.jsx'
import AgingChart from '../AgingChart.jsx'
import InvoiceTable from '../InvoiceTable.jsx'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Legend } from 'recharts'
import { computeAgingBuckets } from '../../lib/metrics.js'
import { isPrivateLabel, catchAllLast } from '../../lib/brands.js'
import { money, num, monthLabel } from '../../lib/format.js'
import { ExportButton } from '../../lib/csv.jsx'
import ActionList from './ActionList.jsx'
import { ReconcileTab } from './Insights.jsx'
import { useNav } from '../../lib/navigation.jsx'
import { fetchHandoffs, addHandoff, removeHandoff } from '../../lib/agency.js'
import { ColumnFilter, useColFilter } from '../components/ColumnFilter.jsx'
import InfoTip from '../components/InfoTip.jsx'
import { stockComparison, flowComparison } from '../../lib/trends.js'
import { keepInTotal, keepInOperating, OP_MODES, opModeLabel, opModeShort, opKeepText, opExclText, isUncollectable, riskAmt, inArBook, isReclassifiable } from '../../lib/dso.js'
import { useOverrides } from '../../lib/arOverrides.js'
import CollectibilityModal from '../CollectibilityModal.jsx'

const today10 = () => new Date().toISOString().slice(0, 10)

// Per-group DSO using the SAME operator method as operatorDsoByGroup / the main
// card: DSO = Σ(daysToPay × invoiceAmount) ÷ Σ(invoiceAmount), daysToPay =
// (paidDate || today) − invoiceDate, guard [0,3650], collection/write-off
// included, weighted by full invoice amount. Used by the By-Customer and
// By-Brand tabs; `combinedDso` is the headline number. (paidDso/openDso are kept
// in the return shape but no longer rendered.)
function dsoByGroup(arInvoices, getKey) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const map = new Map()
    arInvoices.forEach((r) => {
    if (!r.date || r.invoiceAmount <= 0) return
    if (r.isWriteOff) return  // DSO excludes written-off invoices
    const key = getKey(r); if (!key) return

    const end = r.paidDate || today

    const d = (end - r.date) / 86400000
    if (d < 0 || d > 3650) return
    const cur = map.get(key) || { paidDays: 0, paidAmt: 0, paidN: 0, openDays: 0, openAmt: 0, openN: 0 }
    if (r.paidDate) {
      cur.paidDays += d * r.invoiceAmount
      cur.paidAmt += r.invoiceAmount
      cur.paidN += 1
    } else {
      cur.openDays += d * r.invoiceAmount
      cur.openAmt += r.invoiceAmount
      cur.openN += 1
    }
    map.set(key, cur)
  })
  const out = new Map()
  map.forEach((v, k) => {
    out.set(k, {
      paidDso: v.paidAmt > 0 ? v.paidDays / v.paidAmt : 0,
      openDso: v.openAmt > 0 ? v.openDays / v.openAmt : 0,
      combinedDso: (v.paidAmt + v.openAmt) > 0
        ? (v.paidDays + v.openDays) / (v.paidAmt + v.openAmt)
        : 0,
      paidN: v.paidN,
      openN: v.openN,
      paidAmt: v.paidAmt,
      openAmt: v.openAmt,
    })
  })
  return out
}

// Per-group Total + Operating DSO (dollar-weighted). Total drops write-offs
// only; Operating drops write-offs + in-collections + open invoices past `cutoff`
// days. NOTE: keepInTotal / keepInOperating are defined lower in this file but
// hoisting isn't needed since this runs at render time.
function dsoBothByGroup(rows, getKey, cutoff) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const map = new Map()
  rows.forEach((r) => {
    if (!r.date || r.invoiceAmount <= 0) return
    const key = getKey(r); if (!key) return
    const end = r.paidDate || today
    const d = (end - r.date) / 86400000
    if (d < 0 || d > 3650) return
    const cur = map.get(key) || { tD: 0, tA: 0, oD: 0, oA: 0 }
    if (keepInTotal(r)) { cur.tD += d * r.invoiceAmount; cur.tA += r.invoiceAmount }
    if (keepInOperating(r, cutoff)) { cur.oD += d * r.invoiceAmount; cur.oA += r.invoiceAmount }
    map.set(key, cur)
  })
  const out = new Map()
  map.forEach((v, k) => out.set(k, { total: v.tA > 0 ? v.tD / v.tA : 0, operating: v.oA > 0 ? v.oD / v.oA : 0 }))
  return out
}

// Operator's DSO method - matches the per-rep "DSO" tabs in the source sheet
// (e.g. the "Manny DSO" tab computes Σ(DaysToPay × InvoiceAmount) ÷ ΣInvoiceAmount
// = 45.19). One unified pool, weighted by FULL invoice amount:
//   DaysToPay = ((paidDate || today) − invoiceDate)
//     · paid / partially-paid (has a paid date) → frozen at the paid date
//     · fully unpaid (no paid date)             → current age (today − invoiceDate)
//   $0 invoices drop out naturally; Collection + Write-off are INCLUDED (the
//   operator's tabs don't exclude them). Guard drops days <0 or >3650 to kill
//   date-parse errors (a single typo'd paid year once blew a rep up to 5,500d).
// paidDso/openDso are kept as supporting splits of the same unified pool.
function operatorDsoByGroup(arInvoices, getKey) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const map = new Map()
  arInvoices.forEach((r) => {
    if (!r.date || r.invoiceAmount <= 0) return
    if (r.isWriteOff) return  // DSO excludes written-off invoices
    const key = getKey(r); if (!key) return
    const end = r.paidDate || today
    const days = (end - r.date) / 86400000
    if (days < 0 || days > 3650) return
    const cur = map.get(key) || { days: 0, amt: 0, n: 0, paidDays: 0, paidAmt: 0, paidN: 0, openDays: 0, openAmt: 0, openN: 0 }
    cur.days += days * r.invoiceAmount
    cur.amt += r.invoiceAmount
    cur.n += 1
    if (r.paidDate) { cur.paidDays += days * r.invoiceAmount; cur.paidAmt += r.invoiceAmount; cur.paidN += 1 }
    else { cur.openDays += days * r.invoiceAmount; cur.openAmt += r.invoiceAmount; cur.openN += 1 }
    map.set(key, cur)
  })
  const out = new Map()
  map.forEach((v, k) => {
    out.set(k, {
      dso: v.amt > 0 ? v.days / v.amt : 0,
      paidDso: v.paidAmt > 0 ? v.paidDays / v.paidAmt : 0,
      openDso: v.openAmt > 0 ? v.openDays / v.openAmt : 0,
      billed: v.amt, n: v.n, paidN: v.paidN, openN: v.openN,
    })
  })
  return out
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')

// Strip the book prefix ("Little Tree-" / "Gelato-") for display only, tolerating
// common misspellings of the prefix (Gelatto-, Gellato-, Galato-, …) and
// hyphen / en-dash / em-dash separators.
const stripBookPrefix = (v) => String(v || '').replace(/^\s*(little\s*tree+s?|g[ae]l+[ae]t+o*)\s*[-–—]\s*/i, '')

// keepInTotal / keepInOperating now live in ../../lib/dso.js (two-mode model:
// 'within' = up to 180 days past due, 'over' = more than 180 days past due).

// Dollar-weighted DSO over a set of invoices (paid + open):
//   DSO = Σ(daysToPay × invoiceAmount) ÷ Σ(invoiceAmount)
//   daysToPay = (paidDate || today) − invoiceDate
function dsoStats(rows) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  let days = 0, amt = 0, n = 0, openN = 0, openAmt = 0
  for (const r of rows) {
    if (!r.date || r.invoiceAmount <= 0) continue
    const end = r.paidDate || today
    const d = (end - r.date) / 86400000
    if (d < 0 || d > 3650) continue
    days += d * r.invoiceAmount; amt += r.invoiceAmount; n += 1
    if (!r.paidDate) { openN += 1; openAmt += r.outstanding || 0 }
  }
  return { dso: amt > 0 ? days / amt : 0, n, amt, openN, openAmt }
}

// Distinct invoice years present in a set (descending).
const yearsOf = (rows) => [...new Set(rows.filter((r) => r.date).map((r) => r.date.getFullYear()))].sort((a, b) => b - a)

// Aging bands ordered + a bucketer for an arbitrary day count (used for the
// "days since invoice date" view; same thresholds as the due-date bucketing).
const AGING_ORDER = ['Current', '1–30', '31–60', '61–90', '91–120', '121–180', '180+']
function daysBucket(days) {
  if (days == null) return 'Unknown'
  if (days <= 0) return 'Current'
  if (days <= 30) return '1–30'
  if (days <= 60) return '31–60'
  if (days <= 90) return '61–90'
  if (days <= 120) return '91–120'
  if (days <= 180) return '121–180'
  return '180+'
}

const ALL_TABS = [
  { id: 'action', label: 'Action List' },
  { id: 'aging', label: 'Aging' },
  { id: 'waterfall', label: 'Trends' },
  { id: 'dso', label: 'DSO' }, // groups Trend + By Rep + By Customer + By Brand
  { id: 'year', label: 'By Year' },
  { id: 'reconcile', label: 'Reconciliation' },
]
export default function Collections({ data, scope = 'wholesale', gelatoGroup = 'customer', setGelatoGroup }) {
  const { openInvoiceList } = useNav()
  // Gelato: no Rep tab (sheet doesn't have salesRep) and no Reconciliation (no fin sheet to compare)
  // Gelato has no rep/reconcile data; and the whole Gelato book is private label,
  // so a "Private Label" sub-view there would be redundant.
  const TABS = scope === 'gelato'
    ? ALL_TABS.filter((t) => t.id !== 'reconcile' && t.id !== 'privatelabel')
    : ALL_TABS
  const [tab, setTab] = useState('action')
  // Operating DSO scope (shared by the headline card + the DSO tab):
  // 'within' = up to 180 days past due (default), 'over' = more than 180 days
  // past due (2022/2023 excluded).
  const [opCutoff, setOpCutoff] = useState('within')
  // Manual collectibility overrides - any change re-runs every DSO calc below.
  const overrides = useOverrides()
  // Every invoice year present in this book (no year is excluded by default -
  // 2023/2024/2025 all show; the user narrows via the picker).
  const availableYears = useMemo(
    () => yearsOf(scope === 'gelato' ? (data.gelato || []) : data.invoices),
    [data.invoices, data.gelato, scope]
  )
  // Multi-select set of DSO years. Default = all available years EXCEPT 2023
  // (2023 is being written off, so it's off by default - but still selectable).
  const [dsoYears, setDsoYears] = useState(() => new Set(availableYears.filter((y) => y !== 2023)))
  const toggleDsoYear = (y) => setDsoYears((prev) => {
    const next = new Set(prev)
    if (next.has(y)) next.delete(y); else next.add(y)
    return next
  })
  const dsoYearMatch = (r) => !!r.date && dsoYears.has(r.date.getFullYear())
  // Segment toggle - applies to ALL sub-tabs and the KPI cards.
  const [segment, setSegment] = useState('all') // 'all' | 'lt' | 'pl'
  const segMatch = (r) => segment === 'all' ? true : (segment === 'pl' ? !!r.isPrivateLabelCustomer : !r.isPrivateLabelCustomer)

  // AR scope filter:
  //   scope='wholesale' → main invoice tracker, exclude private label, outstanding >= $100
  //   scope='gelato'    → dedicated Gelato sheet, outstanding >= $100
  const arInvoices = useMemo(() => {
    if (scope === 'gelato') {
      return (data.gelato || []).filter((r) => {
        if (r.isOutstanding && r.outstanding < 100) return false
        return true
      })
    }
    const vendorBrand = new Map()
    data.invoices.forEach((r) => {
      if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand)
    })
       return data.invoices.filter((r) => {
      if (isPrivateLabel(vendorBrand.get(r.vendor) || r.brand)) return false
      if (r.isOutstanding && r.outstanding < 100) return false
      return true
    })
  }, [data.invoices, data.gelato, scope])


  // Invoice set the DSO calcs run over (By-Rep + DSO Trend). The operator keeps
  // Little Tree and Gelato as separate books, each with its own DSO:
  //   wholesale → full invoice tracker MINUS private-label brands (Gelato et al.)
  //   gelato    → the dedicated Gelato sheet on its own
  // Note: this is broader than `arInvoices` (no <$100 / aging filtering) because
  // DSO is computed over every billed invoice, paid or open.
  const dsoInvoices = useMemo(() => {
    if (scope === 'gelato') return data.gelato || []
    const vendorBrand = new Map()
    data.invoices.forEach((r) => {
      if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand)
    })
          return data.invoices.filter((r) => {
      if (isPrivateLabel(vendorBrand.get(r.vendor) || r.brand)) return false
      if (!r.date) return false
      const y = r.date.getFullYear()
      return dsoYears.has(y)
    })
  }, [data.invoices, data.gelato, scope, dsoYears])

  // Same DSO scope but with NO year filter. The DSO tab gets this so its
  // Operating DSO (cutoff-based) runs over every year, while the tab's own
  // Years picker still narrows Total DSO and the breakdown tables internally.
  const dsoInvoicesAll = useMemo(() => {
    if (scope === 'gelato') return data.gelato || []
    const vendorBrand = new Map()
    data.invoices.forEach((r) => { if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand) })
    return data.invoices.filter((r) => {
      if (isPrivateLabel(vendorBrand.get(r.vendor) || r.brand)) return false
      if (!r.date) return false
      return true
    })
  }, [data.invoices, data.gelato, scope])


  // Single pass over arInvoices for all top-level aggregates so a tab
  // change (or any in-page setState) doesn't trigger 6 separate filter +
  // reduce passes over the same 2 000-row dataset.
  const aggregates = useMemo(() => {
    const outstanding = []
    let totalOutstanding = 0
    const past90 = []
    let past90Sum = 0
    let inCollections = 0
    let writeOff = 0
    // Split open AR into Little Tree retail vs private-label (white-label) accounts.
    // White-label receivables still belong to Little Tree (LT bills & collects them) -
    // this just surfaces the two slices and a combined total. (Wholesale scope only.)
    const wlOpen = []
    let wlOutstanding = 0
    const retailOpen = []
    let retailOutstanding = 0
    // Open invoices flagged "Payment Received" - money in, not yet applied. They
    // leave the open book (Total outstanding drops) and surface in their own KPI.
    const received = []
    let receivedSum = 0
    // Payment-plan invoices stay in the open book but are tracked in their own KPI.
    const plan = []
    let planSum = 0
    for (const r of arInvoices) {
      const gross = r.outstandingGross ?? r.outstanding ?? 0
      const remaining = r.outstanding || 0 // tag already subtracted any received amount
      // Received card: money in, not yet reconciled in the source sheet. Keyed on
      // the ORIGINAL open status so a fully-received invoice (now booked as paid)
      // still appears here until the tracker itself marks it paid.
      if ((r.isOutstandingOrig ?? r.isOutstanding) && r.paymentStatus === 'received' && r.paymentComplete) {
        received.push(r)
        receivedSum += (gross - remaining)
      }
      // r.isOutstanding is the BOOKED status: a fully-received invoice is paid
      // here, so it drops out of every open total / aging / defaulter rollup.
      if (r.isOutstanding) {
        if (r.paymentStatus === 'plan' && r.paymentComplete) {
          plan.push(r)
          planSum += (r.payment?.planAmount || remaining)
        }
        outstanding.push(r)
        totalOutstanding += remaining
        if (r.agingBucket === '180+') {
          past90.push(r)
          past90Sum += remaining
        }
                       if (scope !== 'gelato' && r.isPrivateLabelCustomer) {
          wlOpen.push(r); wlOutstanding += remaining
        } else {
          retailOpen.push(r); retailOutstanding += remaining
        }
      }
      if (r.isCollection) inCollections += r.outstanding
      if (r.isWriteOff) writeOff += Math.max(0, r.invoiceAmount - r.invoicePaid)
    }
    return { outstanding, totalOutstanding, past90, past90Sum, inCollections, writeOff,
             wlOpen, wlOutstanding, retailOpen, retailOutstanding, received, receivedSum, plan, planSum }
  }, [arInvoices, scope])
  const { outstanding, totalOutstanding, past90, past90Sum, inCollections, writeOff,
          wlOpen, wlOutstanding, retailOpen, retailOutstanding, received, receivedSum, plan, planSum } = aggregates

  // Segment-filtered slices - the top-right toggle now drives the KPI cards too.
  const segOutstanding = useMemo(() => outstanding.filter(segMatch), [outstanding, segment])
  const segTotalOutstanding = useMemo(() => segOutstanding.reduce((s, r) => s + r.outstanding, 0), [segOutstanding])
  const segReceived = useMemo(() => received.filter(segMatch), [received, segment])
  const segReceivedSum = useMemo(() => segReceived.reduce((s, r) => s + (r.payment?.receivedAmount || r.outstanding || 0), 0), [segReceived])
  const segPlan = useMemo(() => plan.filter(segMatch), [plan, segment])
  const segPlanSum = useMemo(() => segPlan.reduce((s, r) => s + (r.payment?.planAmount || r.outstanding || 0), 0), [segPlan])
  const segPast90 = useMemo(() => past90.filter(segMatch), [past90, segment])
  const segPast90Sum = useMemo(() => segPast90.reduce((s, r) => s + r.outstanding, 0), [segPast90])
  const segCollections = useMemo(() => arInvoices.filter((r) => r.isCollection && segMatch(r)), [arInvoices, segment])
  const segCollectionsSum = useMemo(() => segCollections.reduce((s, r) => s + r.outstanding, 0), [segCollections])
  const dsoScoped = useMemo(() => dsoInvoices.filter(segMatch), [dsoInvoices, segment])
  // All-years version (Operating DSO ignores the year filter).
  const dsoScopedAll = useMemo(() => dsoInvoicesAll.filter(segMatch), [dsoInvoicesAll, segment])


  // Two DSO metrics:
  //   Total DSO     = selected YEARS, drops write-offs only (in-collections kept)
  //   Operating DSO = ALL years, drops write-offs + in-collections + open >180d past due
  // Both dollar-weighted: DSO = Σ(daysToPay × amount) ÷ Σ amount.
  const dso = useMemo(() => {
    const totalRows = dsoScoped.filter((r) => r.date && r.invoiceAmount > 0 && keepInTotal(r))
    const opAll = dsoScopedAll.filter((r) => r.date && r.invoiceAmount > 0)
    const operatingRows = opAll.filter((r) => keepInOperating(r, opCutoff))
    const excludedRows = opAll.filter((r) => !keepInOperating(r, opCutoff))
    const total = dsoStats(totalRows)
    const operating = dsoStats(operatingRows)
    // Uncollectable AR (year-filtered, like Total DSO): write-offs + in-collections
    // + open invoices 180+ days past due, as a share of the open book.
    const arBook = dsoScoped.filter(inArBook)
    const arBookAmt = arBook.reduce((s, r) => s + riskAmt(r), 0)
    const uncollRows = arBook.filter(isUncollectable)
    const uncollAmt = uncollRows.reduce((s, r) => s + riskAmt(r), 0)
    // Operating DSO by invoice year (all years present, none hidden).
    const byYear = new Map()
    for (const r of operatingRows) {
      const y = r.date.getFullYear()
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y).push(r)
    }
    const yearRows = [...byYear.entries()]
      .map(([year, rows]) => { const s = dsoStats(rows); return { year, combined: s.dso, combinedN: s.n, combinedAmt: s.amt } })
      .sort((a, b) => b.year - a.year)
    return {
      total: total.dso, totalN: total.n, totalAmt: total.amt,
      operating: operating.dso, operatingN: operating.n, operatingAmt: operating.amt,
      excludedN: excludedRows.length,
      excludedAmt: excludedRows.reduce((s, r) => s + (r.outstanding || (r.invoiceAmount - r.invoicePaid) || 0), 0),
      excludedRows,
      totalRows,
      operatingRows,
      operatingBaseRows: opAll.filter((r) => !r.isWriteOff && !r.isCollection),
      uncollRows, uncollAmt, arBookAmt,
      uncollPct: arBookAmt > 0 ? (uncollAmt / arBookAmt) * 100 : 0,
      reclassRows: dsoScoped.filter((r) => r.isWriteOff || isReclassifiable(r)),
      // legacy aliases used elsewhere
      combined: operating.dso, combinedN: operating.n,
      yearRows,
    }
  }, [dsoScoped, dsoScopedAll, opCutoff, overrides])


  return (
    <div className="page">
      <ARTabs tab={tab} setTab={setTab} tabs={TABS} />

      {scope === 'gelato' && setGelatoGroup && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 0 12px' }}>
          <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 7, overflow: 'hidden' }}>
            {[['customer', 'By Customer'], ['brand', 'By Brand']].map(([id, label]) => (
              <button
                key={id}
                onClick={() => setGelatoGroup(id)}
                style={{
                  fontSize: 13.5, padding: '7px 16px', border: 'none', cursor: 'pointer', fontWeight: 500,
                  borderLeft: id !== 'customer' ? '1px solid #e2e8f0' : 'none',
                  background: gelatoGroup === id ? '#15803d' : '#fff',
                  color: gelatoGroup === id ? '#fff' : '#475569',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {scope !== 'gelato' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 0 12px' }}>
          <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 7, overflow: 'hidden' }}>
             {[['all', 'All'], ['lt', 'Little Tree'], ['pl', 'Infused Origin']].map(([id, label]) => (

              <button
                key={id}
                onClick={() => setSegment(id)}
                style={{
                  fontSize: 13.5, padding: '7px 16px', border: 'none', cursor: 'pointer', fontWeight: 500,
                  borderLeft: id !== 'all' ? '1px solid #e2e8f0' : 'none',
                  background: segment === id ? '#15803d' : '#fff',
                  color: segment === id ? '#fff' : '#475569',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}




      <section className="kpi-grid">
        <KpiCard
          label="Total outstanding"
          value={money(segTotalOutstanding)}
          sub={`${num(segOutstanding.length)} invoices`}
          tone="warn"
          info={{
            title: 'Total outstanding',
            purpose: 'All money customers still owe across open invoices in the selected segment.',
            detail: 'Outstanding (invoiced minus paid) summed over open invoices with at least $100 left, re-scoped by the All / Little Tree / Infused Origin toggle. Example: open invoices $3,000 + $5,000 + $2,000 = $10,000.',
            source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).',
          }}
          onClick={segOutstanding.length > 0 ? () => openInvoiceList({
            title: `${scope === 'gelato' ? 'Gelato' : 'Little Tree'} · Total outstanding`,
            subtitle: `${segOutstanding.length} open invoices · ${money(segTotalOutstanding)}`,
            // Include payment-received invoices so they stay reviewable/editable
            // in the popup; the modal keeps them out of its open total.
            invoices: [...segOutstanding, ...segReceived],
            info: {
              title: 'Total outstanding',
              purpose: 'All money customers still owe across every unpaid invoice. Outstanding = amount invoiced minus amount paid.',
              source: 'Invoice tracker - every open invoice.',
            },
          }) : undefined}
        />
        {segReceived.length > 0 && (
          <KpiCard
            label="Payment received · not applied"
            value={money(segReceivedSum)}
            sub={`${num(segReceived.length)} invoices`}
            info={{
              title: 'Payment received · not applied',
              purpose: 'Money that has come in but is not yet applied in the accounting system.',
              detail: 'Open invoices flagged as Payment Received in the detail view: removed from Total outstanding and parked here until recorded in QuickBooks. Payment Plan invoices stay in Total outstanding and are not counted here. Click to review, edit, or clear each flag.',
              source: 'Operator-entered payment status on the invoice detail view.',
            }}
            onClick={() => openInvoiceList({
              title: `${scope === 'gelato' ? 'Gelato' : 'Little Tree'} · Payment received · not applied`,
              subtitle: `${segReceived.length} invoices · ${money(segReceivedSum)}`,
              invoices: [...segOutstanding, ...segReceived],
              initialMarked: 'received',
              info: {
                title: 'Payment received · not applied',
                purpose: 'Open invoices flagged as paid, not yet applied in the accounting system. Removed from Total outstanding.',
                source: 'Operator-entered payment status on the invoice detail view.',
              },
            })}
          />
        )}
        {segPlan.length > 0 && (
          <KpiCard
            label="Payment plan active"
            value={money(segPlanSum)}
            sub={`${num(segPlan.length)} invoices`}
            info={{
              title: 'Payment plan active',
              purpose: 'Open invoices the customer is paying down on an agreed plan.',
              detail: 'Open invoices flagged as Payment Plan Active in the detail view. Unlike Payment Received, these balances STAY in Total outstanding (still owed) - this card just tracks which accounts are on a plan. Click to review, edit, or clear each flag.',
              source: 'Operator-entered payment status on the invoice detail view.',
            }}
            onClick={() => openInvoiceList({
              title: `${scope === 'gelato' ? 'Gelato' : 'Little Tree'} · Payment plan active`,
              subtitle: `${segPlan.length} invoices · ${money(segPlanSum)}`,
              invoices: [...segOutstanding, ...segReceived],
              initialMarked: 'plan',
              info: {
                title: 'Payment plan active',
                purpose: 'Open invoices on an agreed payment plan. These balances stay in Total outstanding.',
                source: 'Operator-entered payment status on the invoice detail view.',
              },
            })}
          />
        )}
        <KpiCard
          label="180+ days"
          value={money(segPast90Sum)}
          sub={`${num(segPast90.length)} invoices`}
          tone="bad"
          info={{
            title: '180+ days',
            purpose: 'Slice of the book stuck more than 6 months past due, the highest non-payment risk.',
            detail: 'Outstanding of open invoices in the 180+ aging bucket, within the selected segment. Example: 6 invoices past 180 days = $22,000.',
            source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).',
          }}
          onClick={segPast90.length > 0 ? () => openInvoiceList({
            title: '180+ days overdue · chase priority',
            subtitle: `${segPast90.length} invoices · ${money(segPast90Sum)} stuck`,
            invoices: segPast90,
            info: {
              title: '180+ days overdue',
              purpose: 'Open invoices more than 180 days past their due date - the oldest, hardest-to-collect money.',
              source: 'Invoice tracker - open invoices over 180 days past due date.',
            },
          }) : undefined}
        />
        <KpiCard
          label="In collections"
          value={money(segCollectionsSum)}
          sub="With agency"
          info={{
            title: 'In collections',
            purpose: 'Money on invoices escalated to a collections agency.',
            detail: 'Outstanding of invoices flagged as in collections, within the selected segment (the Collections Agency column names who is handling each). Example: 4 invoices with the agency = $18,000.',
            source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).',
          }}
          onClick={segCollections.length > 0 ? () => openInvoiceList({
            title: 'Invoices in collections (with agency)',
            subtitle: `${segCollections.length} invoices · ${money(segCollectionsSum)}`,
            invoices: segCollections,
            info: {
              title: 'In collections',
              purpose: 'Amount handed over to a collections agency to recover. The Collection Agency column shows who is handling each invoice.',
              source: "Invoice tracker - invoices marked as in collections (status) and the Collections Agency column.",
            },
          }) : undefined}
        />
        <DsoCard dso={dso} dsoYears={dsoYears} toggleDsoYear={toggleDsoYear} years={availableYears} invoices={dsoScoped} scope={scope} opCutoff={opCutoff} setOpCutoff={setOpCutoff} />
      </section>

      {tab === 'action' && <ActionList data={data} scope={scope === 'gelato' ? 'gelato' : 'wholesale'} segment={segment} />}

      {tab === 'agency' && <AgencyTab outstanding={outstanding.filter(segMatch)} />}
      {tab === 'reconcile' && scope !== 'gelato' && <ReconcileTab data={data} />}
      {tab === 'waterfall' && <ArTrendTab arInvoices={arInvoices.filter(segMatch)} past90Sum={past90Sum} />}
      {tab === 'aging' && <AgingTab outstanding={outstanding.filter(segMatch)} writeOff={writeOff} />}
      {tab === 'year' && <ByYearTab outstanding={outstanding.filter(segMatch)} />}
              {tab === 'dso' && <DsoTab
        arInvoices={arInvoices.filter(segMatch)}
        outstanding={outstanding.filter(segMatch)}
        dsoInvoices={dsoInvoicesAll.filter(segMatch)}
        scope={scope}
        gelatoGroup={gelatoGroup}
        years={availableYears}
        dsoYears={dsoYears}
        toggleDsoYear={toggleDsoYear}
        opCutoff={opCutoff}
        setOpCutoff={setOpCutoff}
      />}
    </div>
  )
}

function DsoYearPicker({ dsoYears, toggleDsoYear, years = [] }) {
  return (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: '0 0 auto', marginLeft: 12 }}>
      <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>Years:</span>
      {years.map((y) => (
               <button
          key={y}
          type="button"
          className={`ar-tab ${dsoYears.has(y) ? 'active' : ''}`}
          onClick={() => toggleDsoYear(y)}
          style={{ flex: '0 0 auto', width: 'auto', minWidth: 0, padding: '6px 14px', whiteSpace: 'nowrap' }}
        >
          {y}
        </button>
      ))}
    </div>
  )
}

function DsoCard({ dso, dsoYears, toggleDsoYear, years = [], invoices = [], scope = 'wholesale', opCutoff = 'within', setOpCutoff }) {
  const { openInvoiceList } = useNav()
  const dsoSrc = scope === 'gelato' ? 'Gelato AR sheet.' : 'Invoice Tracker.'
  const selStyle = { fontSize: 13, padding: '6px 10px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', color: '#475569' }
  const cutoffLabel = opKeepText(opCutoff)
  const cutoffExcl = opExclText(opCutoff)
  const [open, setOpen] = useState(false)
  const [showReclass, setShowReclass] = useState(false)
  const showYear = (year) => {
    const invs = invoices.filter((r) => r.date && r.date.getFullYear() === year)
    if (!invs.length) return
    setOpen(false)
    openInvoiceList({ title: `DSO · ${year}`, subtitle: `${invs.length} invoices billed in ${year}`, invoices: invs })
  }
  const showExcluded = () => {
    if (!dso.excludedRows?.length) return
    setOpen(false)
    openInvoiceList({
      title: 'Excluded from Operating DSO',
      subtitle: `${dso.excludedN} invoices · ${money(dso.excludedAmt)} · ${cutoffExcl}`,
      invoices: dso.excludedRows,
    })
  }

  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handler)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', handler); document.body.style.overflow = prev }
  }, [open])

  return (
    <>
      <div className="kpi kpi-dso" onClick={() => setOpen(true)} style={{ cursor: 'pointer' }}>
        <InfoTip
          title="Days to collect (DSO)"
          purpose="On average, how many days pass between invoicing a customer and getting paid."
          detail="Dollar-weighted DSO = Sum(days to pay x invoice amount) / Sum(invoice amount). TOTAL DSO = the selected years, write-offs removed (in-collections kept). OPERATING DSO (shown here) = all years, write-offs AND in-collections always removed, then a scope: 'Up to 180 days' (default) keeps only invoices up to 180 days past due and drops the entire 180+ tail (paid, open, in-collections or written-off); 'Over 180 days' keeps the full book (up-to-180 plus the 180+ tail) and only drops 2022 & 2023. Days to pay = (paid date, or today if unpaid) minus invoice date."
          source={dsoSrc}
        />
        <div className="kpi-label">Days to collect · Operating</div>
        <div className="kpi-value">{dso.operating.toFixed(0)}d</div>
        <div className="kpi-sub dso-formula">Total {dso.total.toFixed(0)}d · {num(dso.excludedN)} excluded</div>
      </div>

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <header className="modal-head">
              <div className="modal-head-inner">
                <div>
                  <div className="modal-eyebrow">Days to collect</div>
                  <h3 className="modal-title">{dso.operating.toFixed(1)} days <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--d-text-muted)' }}>operating</span></h3>
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                    Total DSO {dso.total.toFixed(1)}d · Σ(days × amount) ÷ Σ amount
                  </div>
                </div>
              </div>
              <button className="modal-close" onClick={() => setOpen(false)} aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
            </header>
                        <div className="modal-body">
              <section className="kpi-grid" style={{ marginBottom: 14 }}>
                <div className="kpi kpi-clickable" role="button" tabIndex={0} onClick={() => { setOpen(false); openInvoiceList({ title: 'Total DSO · invoices', subtitle: `${num(dso.totalN)} invoices · DSO ${dso.total.toFixed(1)}d · selected years, write-offs excluded`, invoices: dso.totalRows }) }}>
                  <div className="kpi-label">Total DSO</div><div className="kpi-value">{dso.total.toFixed(0)}d</div><div className="kpi-sub">selected years · write-offs out (collections kept) · click to view</div></div>
                <div className="kpi kpi-clickable" role="button" tabIndex={0} onClick={() => { setOpen(false); openInvoiceList({ title: 'Operating DSO · invoices', subtitle: `${num(dso.operatingN)} invoices · DSO ${dso.operating.toFixed(1)}d · all years, write-offs + collections out, ${cutoffLabel}`, invoices: dso.operatingBaseRows, cutoffFilter: true, initialCutoff: opCutoff }) }}>
                  <div className="kpi-label">Operating DSO · {opModeLabel(opCutoff)}</div><div className="kpi-value">{dso.operating.toFixed(0)}d</div><div className="kpi-sub">all years · write-offs + collections out · {cutoffLabel} · click to view</div></div>
                <div className="kpi kpi-clickable" role="button" tabIndex={0} onClick={() => { setOpen(false); setShowReclass(true) }}>
                  <div className="kpi-label">Uncollectable %</div><div className="kpi-value" style={{ color: dso.uncollPct >= 25 ? '#dc2626' : dso.uncollPct >= 10 ? '#d97706' : '#15803d' }}>{dso.uncollPct.toFixed(0)}%</div><div className="kpi-sub">{money(dso.uncollAmt)} of {money(dso.arBookAmt)} open AR · click to review &amp; reclassify</div></div>
              </section>
              {dso.excludedN > 0 && (
                <div className="alert-card alert-warn" style={{ cursor: 'pointer', marginBottom: 14 }} onClick={showExcluded}>
                  <div className="alert-icon">!</div>
                  <div className="alert-body">
                    <div className="alert-title">{num(dso.excludedN)} invoices excluded from Operating DSO</div>
                    <div className="alert-sub">{money(dso.excludedAmt)} - {cutoffExcl} - click to view</div>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginBottom: 6 }}>
                <DsoYearPicker dsoYears={dsoYears} toggleDsoYear={toggleDsoYear} years={years} />
                {setOpCutoff && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}
                    title="Operating DSO scope. 'Up to 180 days' = the healthy book (everything 180+ days past due is excluded - paid, open, in-collections or written-off). 'Over 180 days' = the full book (up-to-180 plus the 180+ tail), with only 2022 & 2023 excluded. Write-offs & in-collections are always excluded. Runs over all years; the Years buttons only affect Total DSO.">
                    Operating scope:
                    <select value={opCutoff} onChange={(e) => setOpCutoff(e.target.value)} style={selStyle}>
                      {OP_MODES.map(([v, label]) => <option key={v} value={v}>{label}{v === 'within' ? ' (default)' : ''}</option>)}
                    </select>
                  </label>
                )}
              </div>
              <div className="muted" style={{ fontSize: 11.5, marginBottom: 12 }}>
                Years buttons affect <strong>Total DSO</strong> only. <strong>Operating DSO</strong> uses the scope above (default Up to 180 days) over all years.
              </div>
              {dso.yearRows && dso.yearRows.length > 0 ? (
                <div className="dso-year-table">
                  <div className="dso-year-title">Operating DSO by invoice year</div>
                  <table className="data-table compact">
                    <thead>
                      <tr>
                        <th>Year</th>
                        <th className="num">DSO</th>
                        <th className="num"># Invoices</th>
                        <th className="num">Total invoiced</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dso.yearRows.map((y) => (
                        <tr key={y.year} className="clickable-row" onClick={() => showYear(y.year)} title={`See the ${num(y.combinedN)} invoices billed in ${y.year}`}>
                          <td><strong>{y.year}</strong></td>
                          <td className="num"><strong>{y.combined.toFixed(1)}d</strong></td>
                          <td className="num">{num(y.combinedN)}</td>
                          <td className="num">{money(y.combinedAmt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="table-empty" style={{ padding: 20 }}>No breakdown available.</div>}
              <div className="dso-formula" style={{ marginTop: 12 }}>Unpaid invoices counted at current age · doubtful AR excluded from Operating DSO</div>
            </div>
          </div>
        </div>
      )}
      {showReclass && <CollectibilityModal rows={dso.reclassRows || []} onClose={() => setShowReclass(false)} title="Review &amp; reclassify uncollectable AR" />}
    </>
  )
}

function ARTabs({ tab, setTab, tabs }) {
  return (
    <div className="ar-tabs-row">
      <div className="ar-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`ar-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ============ TO AGENCY TAB ============
// 180+ day invoices → hand over to a collections agency, and track what's been
// handed (persisted via /api/agency-handoffs, with a localStorage fallback).
function AgencyTab({ outstanding }) {
  const { openInvoiceList } = useNav()
  const user = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('lt_user')) || 'unknown'
  const [handoffs, setHandoffs] = useState([])
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => { setHandoffs(await fetchHandoffs()) }, [])
  useEffect(() => { load() }, [load])

  const handedSet = useMemo(() => new Set(handoffs.map((h) => h.invNo)), [handoffs])
  const over180 = useMemo(() => outstanding.filter((r) => r.agingBucket === '180+'), [outstanding])
  const awaiting = useMemo(() => over180.filter((r) => !handedSet.has(r.invNo)), [over180, handedSet])

  const awaitingSum = awaiting.reduce((s, r) => s + r.outstanding, 0)
  const handedSum = handoffs.reduce((s, h) => s + (h.amount || 0), 0)

  const send = async (r) => {
    setBusy(r.invNo)
    await addHandoff({ invNo: r.invNo, vendor: r.vendor, amount: r.outstanding, daysOverdue: r.daysOverdue ?? null, handedBy: user })
    await load(); setBusy(null)
  }
  const bringBack = async (invNo) => { setBusy(invNo); await removeHandoff(invNo); await load(); setBusy(null) }

  return (
    <>
      <section className="kpi-grid" style={{ marginBottom: 16 }}>
        <KpiCard label="Handed to agency" value={money(handedSum)} sub={`${num(handoffs.length)} invoices`} tone="muted" />
        <KpiCard label="180+ awaiting handoff" value={money(awaitingSum)} sub={`${num(awaiting.length)} invoices`} tone="bad"
          onClick={awaiting.length > 0 ? () => openInvoiceList({ title: '180+ awaiting handoff', subtitle: `${awaiting.length} invoices · ${money(awaitingSum)}`, invoices: awaiting }) : undefined}
        />
      </section>

      <div className="table-card">
        <div className="table-head">
          <h3>{num(awaiting.length)} invoices · 180+ days · ready to send</h3>
          <ExportButton
            filename={`awaiting-handoff-180plus-${new Date().toISOString().slice(0, 10)}.csv`}
            title="180+ awaiting handoff"
            headers={['Inv #', 'Customer', 'Outstanding', 'Days past due']}
            rows={awaiting.map((r) => [r.invNo, r.vendor.replace(/^(Little Tree|Gelato)-\s*/i, ''), r.outstanding, r.daysOverdue ?? ''])}
          />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Inv #</th><th>Customer</th><th className="num">Outstanding</th><th className="num">Days past due</th><th className="action-col"></th></tr>
            </thead>
            <tbody>
              {awaiting.length === 0 && <tr><td colSpan="5" className="table-empty">Nothing 180+ days awaiting handoff. 🎉</td></tr>}
              {awaiting.map((r) => (
                <tr key={r.invNo}>
                  <td className="mono">{r.invNo}</td>
                  <td className="vendor-cell">{r.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                  <td className="num cell-warn">{money(r.outstanding, true)}</td>
                  <td className="num">{r.daysOverdue ?? ''}</td>
                  <td className="action-col">
                    <button className="btn btn-primary btn-sm" disabled={busy === r.invNo} onClick={() => send(r)}>
                      {busy === r.invNo ? '…' : 'Send to agency →'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="table-card" style={{ marginTop: 16 }}>
        <div className="table-head">
          <h3>{num(handoffs.length)} handed to agency</h3>
          <ExportButton
            filename={`handed-to-agency-${new Date().toISOString().slice(0, 10)}.csv`}
            title="Handed to agency"
            headers={['Inv #', 'Customer', 'Amount', 'Handed by', 'When']}
            rows={handoffs.map((h) => [h.invNo, (h.vendor || '').replace(/^(Little Tree|Gelato)-\s*/i, ''), h.amount || 0, h.handedBy, h.handedAt ? new Date(h.handedAt).toLocaleDateString() : ''])}
          />
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Inv #</th><th>Customer</th><th className="num">Amount</th><th>Handed by</th><th>When</th><th className="action-col"></th></tr>
            </thead>
            <tbody>
              {handoffs.length === 0 && <tr><td colSpan="6" className="table-empty">None handed to agency yet.</td></tr>}
              {handoffs.map((h) => (
                <tr key={h.invNo}>
                  <td className="mono">{h.invNo}</td>
                  <td className="vendor-cell">{(h.vendor || '').replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                  <td className="num">{money(h.amount || 0, true)}</td>
                  <td>{h.handedBy}</td>
                  <td className="muted">{h.handedAt ? new Date(h.handedAt).toLocaleDateString() : ''}</td>
                  <td className="action-col">
                    <button className="btn btn-ghost btn-sm" disabled={busy === h.invNo} onClick={() => bringBack(h.invNo)}>↩ Bring back</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ============ AGING TAB ============
function AgingTab({ outstanding, writeOff }) {
  const { openInvoiceList } = useNav()
  // Toggle the aging basis: days PAST DUE (default) vs days SINCE INVOICE date.
  const [mode, setMode] = useState('pastDue') // 'pastDue' | 'sinceInvoice'
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }, [])
  const basisLabel = mode === 'pastDue' ? 'days past due' : 'days since invoice date'
  const bucketOf = (r) => mode === 'sinceInvoice'
    ? daysBucket(r.date ? Math.floor((today - r.date) / 86400000) : null)
    : r.agingBucket

  const buckets = useMemo(() => {
    const amt = Object.fromEntries(AGING_ORDER.map((k) => [k, 0]))
    const cnt = Object.fromEntries(AGING_ORDER.map((k) => [k, 0]))
    for (const r of outstanding) {
      const b = AGING_ORDER.includes(bucketOf(r)) ? bucketOf(r) : '180+'
      amt[b] += r.outstanding; cnt[b] += 1
    }
    return AGING_ORDER.map((label) => ({ label, amount: amt[label], count: cnt[label] }))
  }, [outstanding, mode, today])

  const showBucket = (label) => {
    const invs = outstanding.filter((r) => bucketOf(r) === label)
    if (!invs.length) return
    openInvoiceList({ title: `Aging (${basisLabel}): ${label}`, subtitle: `${invs.length} open invoices`, invoices: invs })
  }

  const modeBtn = (id, label) => (
    <button onClick={() => setMode(id)} style={{
      fontSize: 13, padding: '6px 14px', border: 'none', cursor: 'pointer', fontWeight: 500,
      borderLeft: id !== 'pastDue' ? '1px solid #e2e8f0' : 'none',
      background: mode === id ? '#15803d' : '#fff', color: mode === id ? '#fff' : '#475569',
    }}>{label}</button>
  )

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0 0 12px' }}>
        <div style={{ display: 'inline-flex', border: '1px solid #e2e8f0', borderRadius: 7, overflow: 'hidden' }}>
          {modeBtn('pastDue', 'Days past due')}
          {modeBtn('sinceInvoice', 'Days since invoice date')}
        </div>
      </div>
      <section className="grid-2">
        <AgingChart buckets={buckets} onBucketClick={showBucket} basis={basisLabel} info={{
          title: `Aging buckets · ${basisLabel}`,
          purpose: mode === 'pastDue'
            ? "How much of what's owed is current versus how far past the due date it is."
            : "How much of what's owed banded by how long since the invoice was raised.",
          detail: mode === 'pastDue'
            ? 'Outstanding on open invoices banded by DAYS PAST DUE (today − due date; due date = the sheet Due Date, or invoice date + 30 for Net 30 when blank): Current (not yet due), 1-30, 31-60, 61-90, 91-120, 121-180, 180+. Click a bar to list those invoices.'
            : 'Outstanding on open invoices banded by DAYS SINCE THE INVOICE DATE (today − invoice date), using the same 1-30 / 31-60 / … / 180+ ranges. This ignores due dates - it is age from issue, not lateness. Click a bar to list those invoices.',
          source: 'Invoice Tracker.',
        }} />

        <div className="chart-card">
          <InfoTip
            title={`Aging summary · ${basisLabel}`}
            purpose={`The aging split as exact dollars and invoice counts, by ${basisLabel}.`}
            detail={`For each band (Current, 1-30, 31-60, 61-90, 91-120, 121-180, 180+) the total outstanding and number of open invoices, measured by ${basisLabel}; written-off invoices are shown separately and excluded. Click a row to list its invoices.`}
            source="Invoice Tracker."
          />
          <div className="chart-head">
            <h3>Aging summary · {basisLabel}</h3>
            <ExportButton
              filename={`aging-summary-${today10()}.csv`}
              headers={[mode === 'pastDue' ? 'Days past due' : 'Days since invoice', '# Invoices', 'Outstanding']}
              rows={[...buckets.map((b) => [b.label, b.count, b.amount.toFixed(2)]), ['Written off (excluded)', '', writeOff.toFixed(2)]]}
            />
          </div>
          <table className="data-table compact">
            <thead>
              <tr><th>{mode === 'pastDue' ? 'Days past due' : 'Days since invoice'}</th><th className="num">Invoices</th><th className="num">Outstanding</th></tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.label} className="clickable-row" onClick={() => showBucket(b.label)} title={`See the ${b.count} invoices in ${b.label}`}>
                  <td><span className={`bucket-pill ${bucketCls(b.label)}`}>{b.label}</span></td>
                  <td className="num">{b.count}</td>
                  <td className="num">{money(b.amount)}</td>
                </tr>
              ))}

              <tr>
                <td className="muted">Written off (excluded)</td>
                <td></td>
                <td className="num muted">{money(writeOff)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <OutstandingByBrand invoices={outstanding} />
      </section>
    </>
  )
}

// Brand → Store → Invoice drill for the Aging tab's outstanding list, mirroring
// the InvoiceListModal flow but rendered inline on the page.
function OutstandingByBrand({ invoices }) {
  const [brand, setBrand] = useState(null)
  const [store, setStore] = useState(null)

  const brandGroups = useMemo(() => {
    const m = new Map()
    for (const r of invoices) {
      const b = r.masterBrand || r.brand || 'No brand'
      const g = m.get(b) || { brand: b, count: 0, outstanding: 0, vendors: new Set() }
      g.count += 1; g.outstanding += r.outstanding || 0; g.vendors.add(r.vendor)
      m.set(b, g)
    }
    return [...m.values()].map((g) => ({ ...g, storeCount: g.vendors.size })).sort((a, b) => b.outstanding - a.outstanding)
  }, [invoices])

  const storeGroups = useMemo(() => {
    if (!brand) return []
    const m = new Map()
    for (const r of invoices) {
      if ((r.masterBrand || r.brand || 'No brand') !== brand) continue
      const g = m.get(r.vendor) || { vendor: r.vendor, count: 0, outstanding: 0 }
      g.count += 1; g.outstanding += r.outstanding || 0
      m.set(r.vendor, g)
    }
    return [...m.values()].sort((a, b) => b.outstanding - a.outstanding)
  }, [invoices, brand])

  const storeInvoices = useMemo(
    () => invoices.filter((r) => (r.masterBrand || r.brand || 'No brand') === brand && r.vendor === store),
    [invoices, brand, store],
  )

  // Nested Brand -> Store -> Invoice export (one file, hierarchy preserved).
  const obExport = useMemo(() => {
    const out = []
    for (const bg of brandGroups) {
      out.push([bg.brand, '', '', '', bg.outstanding, ''])
      const byStore = new Map()
      for (const r of invoices) {
        if ((r.masterBrand || r.brand || 'No brand') !== bg.brand) continue
        if (!byStore.has(r.vendor)) byStore.set(r.vendor, [])
        byStore.get(r.vendor).push(r)
      }
      for (const [vendor, rows] of [...byStore.entries()].sort((a, b) => b[1].reduce((s, r) => s + (r.outstanding || 0), 0) - a[1].reduce((s, r) => s + (r.outstanding || 0), 0))) {
        const vName = vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')
        out.push(['', vName, '', '', rows.reduce((s, r) => s + (r.outstanding || 0), 0), ''])
        for (const r of rows.sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0))) {
          out.push(['', vName, r.invNo || '', r.date ? r.date.toISOString().slice(0, 10) : '', r.outstanding || 0, r.daysOverdue || 0])
        }
      }
    }
    return out
  }, [brandGroups, invoices])

  const backBtn = (onClick, label) => (
    <button type="button" onClick={onClick}
      style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#15803d', fontWeight: 600, fontSize: 13, marginBottom: 12 }}>
      {label}
    </button>
  )

  if (brand && store) {
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {backBtn(() => setStore(null), `← ${brand}`)}
          <span style={{ fontWeight: 600 }}>{store.replace(/^(Little Tree|Gelato)-\s*/i, '')}</span>
        </div>
        <InvoiceTable invoices={storeInvoices} limit={150} />
      </>
    )
  }

  if (brand) {
    return (
      <div className="table-card">
        <div className="table-head" style={{ display: 'block' }}>
          {backBtn(() => setStore(null) || setBrand(null), '← All brands')}
          <h3>{brand} · {num(storeGroups.length)} stores</h3>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Store</th><th className="num"># Invoices</th><th className="num">Outstanding</th></tr></thead>
            <tbody>
              {storeGroups.map((g) => (
                <tr key={g.vendor} className="clickable-row" onClick={() => setStore(g.vendor)}>
                  <td className="vendor-cell">{g.vendor.replace(/^(Little Tree|Gelato)-\s*/i, '')}</td>
                  <td className="num">{num(g.count)}</td>
                  <td className="num cell-warn">{money(g.outstanding, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="table-card">
      <InfoTip
        title="Outstanding by brand"
        purpose="Which brands carry the most unpaid balance right now."
        detail="Outstanding of open invoices totalled per master brand, largest first; click a brand to drill into its stores, then into invoices. Example: Gelato $120,000, Alien Brainz $60,000."
        source="Invoice Tracker."
      />
      <div className="table-head">
        <h3>Outstanding by brand · {num(brandGroups.length)} brands</h3>
        <ExportButton
          filename={`outstanding-by-brand-${new Date().toISOString().slice(0, 10)}.csv`}
          title="Outstanding by brand"
          headers={['Brand', 'Store', 'Inv #', 'Date', 'Outstanding', 'Days past due']}
          rows={obExport}
        />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Brand</th><th className="num"># Stores</th><th className="num"># Invoices</th><th className="num">Outstanding</th></tr></thead>
          <tbody>
            {brandGroups.length === 0 && <tr><td colSpan="4" className="table-empty">Nothing outstanding.</td></tr>}
            {brandGroups.map((g) => (
              <tr key={g.brand} className="clickable-row" onClick={() => { setBrand(g.brand); setStore(null) }}>
                <td className="vendor-cell"><strong>{g.brand}</strong></td>
                <td className="num">{num(g.storeCount)}</td>
                <td className="num">{num(g.count)}</td>
                <td className="num cell-warn">{money(g.outstanding, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============ DSO TAB (groups Trend + By Rep + By Customer + By Brand) ============
const brandKeyOf = (r) => r.masterBrand || r.brand || 'No brand'

function DsoTab({ arInvoices, outstanding, dsoInvoices, scope, gelatoGroup = 'customer', years = [], dsoYears, toggleDsoYear, opCutoff, setOpCutoff }) {
  const { openInvoiceList } = useNav()
  // Gelato sheet has no sales rep → no By-Rep sub-tab there.
  const SUBS = scope === 'gelato'
    ? [{ id: 'trend', label: 'Trend' }, { id: 'customer', label: 'Customer' }]
    : [{ id: 'trend', label: 'Trend' }, { id: 'rep', label: 'By Rep' }, { id: 'customer', label: 'By Customer' }, { id: 'brand', label: 'By Brand' }]
  const [sub, setSub] = useState('trend')
  const active = SUBS.some((s) => s.id === sub) ? sub : 'trend'
  const overrides = useOverrides()
  const [showReclass, setShowReclass] = useState(false)

  // Extra filters (on top of the segment + year already applied upstream).
  const [repF, setRepF] = useState('')      // '' = all reps
  const [brandF, setBrandF] = useState('')  // '' = all brands
  const repOptions = useMemo(
    () => [...new Set(dsoInvoices.map((r) => r.salesRep || 'Unassigned'))].sort(),
    [dsoInvoices]
  )
  const brandOptions = useMemo(
    () => [...new Set(dsoInvoices.map(brandKeyOf))].sort(),
    [dsoInvoices]
  )

  const yearMatch = (r) => !!r.date && dsoYears.has(r.date.getFullYear())
  const repMatch = (r) => !repF || (r.salesRep || 'Unassigned') === repF
  const brandMatch = (r) => !brandF || brandKeyOf(r) === brandF
  const base = (r) => yearMatch(r) && repMatch(r) && brandMatch(r)

  // Two DSO metrics:
  //  · Total DSO     = year + rep + brand filtered; drops write-offs only (collections kept).
  //  · Operating DSO = rep + brand filtered over ALL years (no year filter); drops
  //    write-offs AND in-collections, plus open invoices past the chosen days cutoff.
  const metrics = useMemo(() => {
    const totalSet = dsoInvoices.filter((r) => base(r) && r.date && r.invoiceAmount > 0 && keepInTotal(r))
    const opAll = dsoInvoices.filter((r) => repMatch(r) && brandMatch(r) && r.date && r.invoiceAmount > 0)
    const opClean = opAll.filter((r) => keepInOperating(r, opCutoff))
    const opExcluded = opAll.filter((r) => !keepInOperating(r, opCutoff))
    // Uncollectable AR (year + rep + brand filtered): write-offs, in-collections,
    // or open invoices more than 180 days past due, as a share of the open book.
    const arBook = dsoInvoices.filter((r) => base(r) && inArBook(r))
    const arBookAmt = arBook.reduce((s, r) => s + riskAmt(r), 0)
    const uncollRows = arBook.filter(isUncollectable)
    const uncollAmt = uncollRows.reduce((s, r) => s + riskAmt(r), 0)
    return {
      total: dsoStats(totalSet),
      operating: dsoStats(opClean),
      totalRows: totalSet,
      operatingRows: opClean,
      // Pre-cutoff operating set (write-offs + in-collections removed); the modal
      // applies the days cutoff so you can change it in the detail view.
      operatingBaseRows: opAll.filter((r) => !r.isWriteOff && !r.isCollection),
      excludedRows: opExcluded,
      excludedAmt: opExcluded.reduce((s, r) => s + (r.outstanding || (r.invoiceAmount - r.invoicePaid) || 0), 0),
      uncollRows,
      uncollAmt,
      arBookAmt,
      uncollPct: arBookAmt > 0 ? (uncollAmt / arBookAmt) * 100 : 0,
      reclassRows: dsoInvoices.filter((r) => base(r) && (r.isWriteOff || isReclassifiable(r))),
      reincludedN: dsoInvoices.filter((r) => base(r) && overrides[r.invNo] === 'collectible').length,
    }
  }, [dsoInvoices, dsoYears, repF, brandF, opCutoff, overrides])

  // Sets handed to the breakdown sub-tabs (year + rep + brand filtered).
  const dsoSet = useMemo(() => dsoInvoices.filter(base), [dsoInvoices, dsoYears, repF, brandF])
  const arSet = useMemo(() => arInvoices.filter(base), [arInvoices, dsoYears, repF, brandF])
  const outSet = useMemo(() => outstanding.filter(base), [outstanding, dsoYears, repF, brandF])

  const selStyle = { fontSize: 13, padding: '6px 10px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', color: '#475569' }
  const dsoSrc = scope === 'gelato' ? 'Gelato AR sheet.' : 'Invoice Tracker.'
  const cutoffLabel = opKeepText(opCutoff)
  const cutoffExcl = opExclText(opCutoff)
  // Actual year span present in this book (Operating DSO runs over all of it).
  const opYearRange = useMemo(() => {
    const ys = [...new Set(dsoInvoices.filter((r) => r.date).map((r) => r.date.getFullYear()))]
    return ys.length ? `${Math.min(...ys)}-${Math.max(...ys)}` : 'all years'
  }, [dsoInvoices])
  const viewExcluded = () => metrics.excludedRows.length && openInvoiceList({
    title: 'Excluded from Operating DSO',
    subtitle: `${metrics.excludedRows.length} invoices · ${money(metrics.excludedAmt)} · ${cutoffExcl}`,
    invoices: metrics.excludedRows,
  })

  return (
    <>
      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '0 0 14px' }}>
        <DsoYearPicker dsoYears={dsoYears} toggleDsoYear={toggleDsoYear} years={years} />
        {scope !== 'gelato' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>Rep:
            <select value={repF} onChange={(e) => setRepF(e.target.value)} style={selStyle}>
              <option value="">All</option>
              {repOptions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        )}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>Brand:
          <select value={brandF} onChange={(e) => setBrandF(e.target.value)} style={selStyle}>
            <option value="">All</option>
            {brandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}
          title="Operating DSO scope. 'Up to 180 days' = healthy book (everything 180+ days past due excluded - paid, open, in-collections or written-off). 'Over 180 days' = the full book (up-to-180 plus the 180+ tail), with only 2022 & 2023 excluded. Write-offs & in-collections always excluded. Runs over all years - the Years filter only affects Total DSO.">
          Operating scope:
          <select value={opCutoff} onChange={(e) => setOpCutoff(e.target.value)} style={selStyle}>
            {OP_MODES.map(([v, label]) => <option key={v} value={v}>{label}{v === 'within' ? ' (default)' : ''}</option>)}
          </select>
        </label>
      </div>
      <div className="muted" style={{ fontSize: 11.5, margin: '-8px 0 14px' }}>
        <strong>Years</strong> filter Total DSO · <strong>Operating scope</strong> filters Operating DSO (over {opYearRange}; default Up to 180 days, currently {opModeLabel(opCutoff)}). The scope also drives the By Rep / Customer / Brand tables below.
      </div>

      {/* Two DSO metrics */}
      <section className="kpi-grid" style={{ marginBottom: 14 }}>
        <div className="kpi kpi-clickable" role="button" tabIndex={0}
          onClick={() => metrics.totalRows.length && openInvoiceList({ title: 'Total DSO · invoices', subtitle: `${num(metrics.total.n)} invoices · DSO ${metrics.total.dso.toFixed(1)}d · selected years, write-offs excluded`, invoices: metrics.totalRows })}>
          <InfoTip title="Total DSO" purpose="Average days to collect on the year-filtered book (in-collections kept)." detail="Dollar-weighted: Σ(days to pay × invoice amount) ÷ Σ invoice amount over the selected YEARS + rep + brand (paid + open). Write-offs are removed (uncollectible); in-collections invoices are KEPT. Days to pay = (paid date, or today if unpaid) − invoice date. Click to view the invoices behind it." source={dsoSrc} />
          <div className="kpi-label">Total DSO</div>
          <div className="kpi-value">{metrics.total.dso.toFixed(0)}d</div>
          <div className="kpi-sub">{num(metrics.total.n)} invoices · selected years · write-offs out, collections kept · click to view</div>
        </div>
        <div className="kpi kpi-clickable" role="button" tabIndex={0}
          onClick={() => metrics.operatingBaseRows.length && openInvoiceList({ title: 'Operating DSO · invoices', subtitle: `${num(metrics.operating.n)} invoices · DSO ${metrics.operating.dso.toFixed(1)}d · ${cutoffLabel}`, invoices: metrics.operatingBaseRows, cutoffFilter: true, initialCutoff: opCutoff })}>
          <InfoTip title="Operating DSO" purpose="Days to collect on the clean collectible book - the realistic collection speed." detail={`Same dollar-weighted formula as Total DSO, but over ALL years (the Years filter does NOT apply here). It always removes write-offs AND in-collections, then applies the scope: 'Up to 180 days' keeps only invoices up to 180 days past due (the whole 180+ tail is dropped - paid, open, in-collections or written-off); 'Over 180 days' keeps the full book (up-to-180 plus the 180+ tail) and only drops 2022 & 2023. Current scope: ${opModeLabel(opCutoff)} (${cutoffLabel}). Click to view the invoices behind it.`} source={dsoSrc} />
          <div className="kpi-label">Operating DSO · {opModeLabel(opCutoff)}</div>
          <div className="kpi-value">{metrics.operating.dso.toFixed(0)}d</div>
          <div className="kpi-sub">{num(metrics.operating.n)} invoices · all years · {cutoffLabel} · click to view</div>
        </div>
        <div className="kpi kpi-clickable" role="button" tabIndex={0} onClick={() => setShowReclass(true)}>
          <InfoTip title="Uncollectable %" purpose="Share of the open receivables book that is unlikely to ever be collected." detail="Uncollectable = write-offs (already lost), in-collections (handed to an agency), and open invoices more than 180 days past due. The denominator (open AR) is every open invoice's outstanding balance plus the lost amount on write-offs. Both are filtered by the selected years, rep and brand. Paid invoices never count - they were collected. Click to review and reclassify each invoice." source={dsoSrc} />
          <div className="kpi-label">Uncollectable %</div>
          <div className="kpi-value" style={{ color: metrics.uncollPct >= 25 ? '#dc2626' : metrics.uncollPct >= 10 ? '#d97706' : '#15803d' }}>{metrics.uncollPct.toFixed(0)}%</div>
          <div className="kpi-sub">{money(metrics.uncollAmt)} of {money(metrics.arBookAmt)} open AR (selected years/rep/brand) · click to review &amp; reclassify</div>
        </div>
        <div className="kpi kpi-clickable" role="button" tabIndex={0} onClick={() => setShowReclass(true)}>
          <InfoTip title="Reclassify collectibility" purpose="Manually decide which at-risk invoices to count as collectible." detail="Open this to mark individual invoices Collectible or Uncollectable. Marking an in-collections (or 180+ days) invoice 'Collectible' puts it back INTO Operating DSO and removes it from the Uncollectable total; marking an invoice 'Doubtful' takes it out of Operating DSO. Your marks are saved and apply across the whole dashboard." source={dsoSrc} />
          <div className="kpi-label">Reclassified</div>
          <div className="kpi-value" style={{ color: '#15803d' }}>{num(metrics.reincludedN)}</div>
          <div className="kpi-sub">invoices marked collectible (re-included in DSO) · click to manage</div>
        </div>
      </section>
      {showReclass && <CollectibilityModal rows={metrics.reclassRows} onClose={() => setShowReclass(false)} title="Review &amp; reclassify uncollectable AR" />}

      {metrics.excludedRows.length > 0 && (
        <div className="alert-card alert-warn" style={{ cursor: 'pointer', marginBottom: 14 }} onClick={viewExcluded}>
          <div className="alert-icon">!</div>
          <div className="alert-body">
            <div className="alert-title">{num(metrics.excludedRows.length)} invoices excluded from Operating DSO</div>
            <div className="alert-sub">{money(metrics.excludedAmt)} excluded ({cutoffExcl}) - click to view the list</div>
          </div>
        </div>
      )}

            <div className="ar-tabs-row subtabs-row">
        <div className="ar-tabs subtabs">
          {SUBS.map((s) => (
            <button key={s.id} className={`ar-tab ${active === s.id ? 'active' : ''}`} onClick={() => setSub(s.id)}>{s.label}</button>
          ))}
        </div>
      </div>
      {active === 'trend' && <DsoTrendTab allInvoices={dsoSet} scope={scope} />}
      {active === 'rep' && <ByRepTab allInvoices={dsoSet} outstanding={outSet} opCutoff={opCutoff} />}
      {active === 'customer' && (
        scope === 'gelato' && gelatoGroup === 'brand'
          ? <ByBrandTab arInvoices={arSet} outstanding={outSet} opCutoff={opCutoff} />
          : <ByCustomerTab arInvoices={arSet} outstanding={outSet} opCutoff={opCutoff} />
      )}
      {active === 'brand' && <ByBrandTab arInvoices={arSet} outstanding={outSet} opCutoff={opCutoff} />}
    </>
  )
}

// ============ BY CUSTOMER TAB ============
function ByCustomerTab({ arInvoices, outstanding, opCutoff = 'within' }) {
  const overrides = useOverrides()
  const { openCustomer } = useNav()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: 'outstanding', dir: 'desc' })

  // Total + Operating DSO per customer (Operating uses the chosen cutoff).
  const dsoMap = useMemo(() => dsoBothByGroup(arInvoices, (r) => r.vendor || 'Unknown', opCutoff), [arInvoices, opCutoff, overrides])

  const rows = useMemo(() => {
    const map = new Map()
    outstanding.forEach((r) => {
      const key = r.vendor || 'Unknown'
      const cur = map.get(key) || {
        vendor: key, count: 0, outstanding: 0, oldest: 0,
        salesRep: '', past90: 0,
      }
      cur.count += 1
      cur.outstanding += r.outstanding
      if ((r.daysOverdue || 0) > cur.oldest) cur.oldest = r.daysOverdue || 0
      if (r.agingBucket === '180+') cur.past90 += r.outstanding
      if (!cur.salesRep && r.salesRep) cur.salesRep = r.salesRep
      map.set(key, cur)
    })
    let list = [...map.values()].map((c) => {
      const d = dsoMap.get(c.vendor) || {}
      return {
        ...c,
        dso: d.total || 0,
        opDso: d.operating || 0,
      }
    })
    const needle = q.trim().toLowerCase()
    if (needle) list = list.filter((c) =>
      c.vendor.toLowerCase().includes(needle) || c.salesRep.toLowerCase().includes(needle)
    )
    const { key, dir } = sort
    const f = dir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      const av = a[key], bv = b[key]
      if (typeof av === 'string') return av.localeCompare(bv) * f
      return ((av || 0) - (bv || 0)) * f
    })
    return list
  }, [outstanding, q, sort, dsoMap])

  const toggle = (k) => setSort((s) => s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'desc' })
  const arrow = (k) => sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''

  // Rep column filter (spreadsheet-style) - options from the full customer list
  const repF = useColFilter(rows, (r) => r.salesRep || '(no rep)')
  const shown = useMemo(() => rows.filter(repF.pass), [rows, repF])

  return (
    <div className="table-card">
      <InfoTip
        title="Open AR by customer"
        purpose="The open balance sliced by customer, to chase the right accounts."
        detail="Open invoices grouped by customer (vendor), each showing open count, outstanding, 180+ amount, oldest days, and two dollar-weighted DSO columns: Total DSO (write-offs removed, in-collections kept) and Operating DSO (write-offs + in-collections removed, plus open invoices past the chosen cutoff). Searchable and filterable by rep. Click a customer to drill in."
        source="Invoice Tracker."
      />
      <div className="table-head">
        <h3>{num(shown.length)} customers with open balance</h3>
        <div className="table-head-tools">
          <input type="search" className="table-search" placeholder="Search vendor or rep…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ExportButton
            filename={`customers-${today10()}.csv`}
            headers={['Customer', 'Sales Rep', '# Open', 'Outstanding', '180+ days', 'Oldest (days)', 'Total DSO', 'Operating DSO']}
            rows={shown.map((r) => [r.vendor, r.salesRep, r.count, r.outstanding.toFixed(2), r.past90.toFixed(2), r.oldest, r.dso.toFixed(0), r.opDso.toFixed(0)])}
          />
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => toggle('vendor')}>Customer{arrow('vendor')}</th>
              <th>
                Rep
                <ColumnFilter label="Rep" options={repF.options} excluded={repF.excluded} onChange={repF.setExcluded} />
              </th>
              <th className="num" onClick={() => toggle('count')}># Open{arrow('count')}</th>
              <th className="num" onClick={() => toggle('outstanding')}>Outstanding{arrow('outstanding')}</th>
              <th className="num" onClick={() => toggle('past90')}>180+{arrow('past90')}</th>
              <th className="num" onClick={() => toggle('oldest')}>Oldest (days){arrow('oldest')}</th>
              <th className="num" onClick={() => toggle('dso')} title="Total DSO - write-offs removed (in-collections kept)">Total DSO{arrow('dso')}</th>
              <th className="num" onClick={() => toggle('opDso')} title="Operating DSO - write-offs + in-collections removed; uses the chosen Operating scope (default: up to 180 days past due)">Op. DSO{arrow('opDso')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan="8" className="table-empty">No customers with open balances.</td></tr>}
            {shown.map((r) => (
              <tr key={r.vendor} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                <td className="vendor-cell">{stripBookPrefix(r.vendor)}</td>
                <td>{r.salesRep}</td>
                <td className="num">{r.count}</td>
                <td className="num cell-warn">{money(r.outstanding, true)}</td>
                <td className="num">{r.past90 > 0 ? money(r.past90) : ''}</td>
                <td className="num">{r.oldest || ''}</td>
                <td className="num">{r.dso > 0 ? `${r.dso.toFixed(0)}d` : '-'}</td>
                <td className="num"><strong>{r.opDso > 0 ? `${r.opDso.toFixed(0)}d` : '-'}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============ PRIVATE LABEL TAB ============
// Focused view of the white-label accounts (Skymint, High Society, Alien Brainz,
// Yacht Fuel, …). Their AR still belongs to Little Tree - this is just a dedicated
// lens. Reuses the By-Customer table on the white-label-filtered slice.
function PrivateLabelTab({ arInvoices, outstanding }) {
    const wlInvoices = useMemo(() => arInvoices.filter((r) => r.isPrivateLabelCustomer), [arInvoices])
  const wlOutstanding = useMemo(() => outstanding.filter((r) => r.isPrivateLabelCustomer), [outstanding])

  const past90 = wlOutstanding.filter((r) => r.agingBucket === '180+').reduce((s, r) => s + r.outstanding, 0)
  const accounts = new Set(wlOutstanding.map((r) => r.vendor)).size

  return (
    <>
      <section className="kpi-grid" style={{ marginBottom: 16 }}>
        <KpiCard label="Private-label accounts" value={num(accounts)} sub={`${num(wlOutstanding.length)} open invoices`}
          info={{
            title: 'Private-label accounts',
            purpose: 'The Infused Origin (white-label) slice of the open book, by account count.',
            detail: 'Number of distinct private-label customers that still have an open balance (white-label AR is still Little Tree\'s to collect). Example: 9 private-label accounts open.',
            source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).',
          }} />
        <KpiCard label="180+ (private label)" value={money(past90)} sub="Oldest stuck" tone={past90 > 0 ? 'bad' : 'muted'}
          info={{
            title: '180+ (private label)',
            purpose: 'How much of the private-label slice is severely overdue.',
            detail: 'Outstanding on private-label open invoices in the 180+ aging bucket. Example: $12,000 past 180 days.',
            source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).',
          }} />
      </section>
      {wlOutstanding.length === 0
        ? <div className="table-card"><div className="table-empty" style={{ padding: 28 }}>No private-label accounts with an open balance.</div></div>
        : <ByCustomerTab arInvoices={wlInvoices} outstanding={wlOutstanding} />}
    </>
  )
}

// ============ BY BRAND TAB ============
function ByBrandTab({ arInvoices, outstanding, opCutoff = 'within' }) {
  const overrides = useOverrides()
  const { openInvoiceList } = useNav()
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  // Prefer the customer master-list brand (masterBrand) over the invoice's own
  // brand, so Gelato groups by its real brands instead of a single "Gelato".
  const brandRaw = (r) => r.masterBrand || r.brand || ''
  // Build vendor → brand once (used by both DSO computation and aggregation).
  const vendorBrand = useMemo(() => {
    const m = new Map()
    arInvoices.forEach((r) => {
      const b = brandRaw(r)
      if (r.vendor && b && !m.has(r.vendor)) m.set(r.vendor, b)
    })
    return m
  }, [arInvoices])
  // Total + Operating DSO per brand (Operating uses the chosen cutoff).
  const dsoMap = useMemo(() => dsoBothByGroup(arInvoices, (r) => {
    const raw = vendorBrand.get(r.vendor) || brandRaw(r)
    return raw ? norm(raw) : 'unbranded'
  }, opCutoff), [arInvoices, vendorBrand, opCutoff, overrides])

  const rows = useMemo(() => {
    const display = new Map()
    arInvoices.forEach((r) => {
      const b = brandRaw(r)
      if (!b) return
      const k = norm(b)
      if (!display.has(k)) display.set(k, b.trim())
    })

    const map = new Map()
    outstanding.forEach((r) => {
      const raw = vendorBrand.get(r.vendor) || brandRaw(r)
      const key = raw ? norm(raw) : 'unbranded'
      const name = raw ? display.get(key) || raw : 'Unbranded'
      const cur = map.get(key) || {
        brand: name, brandKey: key, customers: new Set(), count: 0, outstanding: 0,
        past90: 0,
      }
      cur.customers.add(r.vendor)
      cur.count += 1
      cur.outstanding += r.outstanding
      if (r.agingBucket === '180+') cur.past90 += r.outstanding
      map.set(key, cur)
    })
    return [...map.values()]
      .map((c) => {
        const d = dsoMap.get(c.brandKey) || {}
        return {
          ...c,
          customerCount: c.customers.size,
          dso: d.total || 0,
          opDso: d.operating || 0,
        }
      })
      .sort(catchAllLast((c) => c.brand, (a, b) => b.outstanding - a.outstanding))
  }, [arInvoices, outstanding, vendorBrand, dsoMap])

  const brandF = useColFilter(rows, (r) => r.brand)
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const f = rows.filter(brandF.pass)
    return needle ? f.filter((b) => b.brand.toLowerCase().includes(needle)) : f
  }, [rows, brandF, q])

  // Grouped export: each Brand row, then its Stores, then each store's invoices,
  // all in one file (Level column marks the row type).
  const hierExport = useMemo(() => {
    const headers = ['Level', 'Brand', 'Store', 'Inv #', 'Invoice date', 'Days past due', 'Aging band', 'Outstanding', '# Open', 'Total DSO', 'Op. DSO']
    const out = []
    const clean = (s) => String(s || '').replace(/^Little Tree-\s*/i, '')
    for (const b of shown) {
      out.push(['Brand', b.brand, '', '', '', '', '', b.outstanding.toFixed(2), b.count, b.dso > 0 ? `${b.dso.toFixed(0)}d` : '', b.opDso > 0 ? `${b.opDso.toFixed(0)}d` : ''])
      const brandInvs = outstanding.filter((r) => {
        const raw = vendorBrand.get(r.vendor) || brandRaw(r)
        return (raw ? norm(raw) : 'unbranded') === b.brandKey
      })
      const byStore = new Map()
      for (const r of brandInvs) {
        const s = r.vendor || 'Unknown'
        if (!byStore.has(s)) byStore.set(s, [])
        byStore.get(s).push(r)
      }
      const stores = [...byStore.entries()].map(([store, invs]) => ({ store, invs, out: invs.reduce((s, r) => s + (r.outstanding || 0), 0) }))
        .sort((a, c) => c.out - a.out)
      for (const st of stores) {
        out.push(['Store', b.brand, clean(st.store), '', '', '', '', st.out.toFixed(2), st.invs.length, '', ''])
        for (const inv of [...st.invs].sort((a, c) => (c.daysOverdue || 0) - (a.daysOverdue || 0))) {
          out.push(['Invoice', b.brand, clean(st.store), inv.invNo, inv.date ? inv.date.toISOString().slice(0, 10) : '', inv.daysOverdue ?? '', inv.agingBucket || '', (inv.outstanding || 0).toFixed(2), '', '', ''])
        }
      }
    }
    return { headers, rows: out }
  }, [shown, outstanding, vendorBrand])

  return (
    <div className="table-card">
      <InfoTip
        title="Open AR by brand"
        purpose="The open balance sliced by brand, to chase the right brands."
        detail="Open invoices grouped by brand, each showing number of customers, open count, outstanding, 180+ amount, and two dollar-weighted DSO columns: Total DSO (write-offs removed, in-collections kept) and Operating DSO (write-offs + in-collections removed, plus open invoices past the chosen cutoff). Largest balance first. Export gives one file with each brand expanded into its stores and their invoices."
        source="Invoice Tracker."
      />
      <div className="table-head">
        <h3>{num(shown.length)} brands with open balance</h3>
        <div className="table-head-tools">
          <input type="search" className="table-search" placeholder="Search brand…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ExportButton filename={`brands-${today10()}.csv`} headers={hierExport.headers} rows={hierExport.rows} />
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>
                Brand
                <ColumnFilter label="Brand" options={brandF.options} excluded={brandF.excluded} onChange={brandF.setExcluded} />
              </th>
              <th className="num" title="Number of distinct customers (stores) in this brand with an open balance"># Customers</th>
              <th className="num" title="Number of open (unpaid) invoices"># Open</th>
              <th className="num" title="Open balance = invoiced minus paid, summed">Outstanding</th>
              <th className="num" title="Outstanding on open invoices more than 180 days past due">180+</th>
              <th className="num" title="Total DSO - write-offs removed (in-collections kept)">Total DSO</th>
              <th className="num" title="Operating DSO - write-offs + in-collections removed; uses the chosen Operating scope (default: up to 180 days past due)">Op. DSO</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan="7" className="table-empty">No open balances.</td></tr>}
            {shown.map((r) => (
              <tr key={r.brand} className="clickable-row" onClick={() => {
                const invs = outstanding.filter((rr) => {
                  const raw = vendorBrand.get(rr.vendor) || brandRaw(rr)
                  return (raw ? norm(raw) : 'unbranded') === r.brandKey
                })
                if (invs.length) openInvoiceList({ title: r.brand, subtitle: `${invs.length} open invoices · ${money(r.outstanding)}`, invoices: invs, hideBrandLevel: true })
              }}>
                <td className="vendor-cell">{r.brand}</td>
                <td className="num">{r.customerCount}</td>
                <td className="num">{r.count}</td>
                <td className="num cell-warn">{money(r.outstanding, true)}</td>
                <td className="num">{r.past90 > 0 ? money(r.past90) : ''}</td>
                <td className="num">{r.dso > 0 ? `${r.dso.toFixed(0)}d` : '-'}</td>
                <td className="num"><strong>{r.opDso > 0 ? `${r.opDso.toFixed(0)}d` : '-'}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============ BY REP TAB ============
function ByRepTab({ allInvoices, outstanding, opCutoff = 'within' }) {
  const { openInvoiceList } = useNav()
  const overrides = useOverrides()
  // Per-rep DSO using the operator's own sheet method (Σ days×amount ÷ Σ amount,
  // unpaid invoices counted at current age). Matches the "<Rep> DSO" sheet tabs.
  // Computed over the FULL invoice tracker (not the AR-scoped subset) - the
  // operator's method takes every tracker row for the rep, with no private-label
  // or small-balance filtering. The open-AR columns below stay AR-scoped.
  // Every invoice (open + closed/paid) per rep, from the full tracker - used by
  // the row drill-down so clicking a rep shows their ENTIRE invoice history,
  // not just current open AR. This is also the exact basis of the DSO numbers.
  const allByRep = useMemo(() => {
    const m = new Map()
    allInvoices.forEach((r) => {
      const k = (r.salesRep || 'Unassigned').toUpperCase()
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(r)
    })
    return m
  }, [allInvoices])

  // Per-rep Total DSO (all valid invoices) and Operating DSO (doubtful removed).
  const dsoMap = useMemo(() => {
    const m = new Map()
    for (const [rep, invs] of allByRep) {
      const valid = invs.filter((r) => r.date && r.invoiceAmount > 0)
      m.set(rep, { dso: dsoStats(valid.filter(keepInTotal)).dso, opDso: dsoStats(valid.filter((r) => keepInOperating(r, opCutoff))).dso })
    }
    return m
  }, [allByRep, opCutoff, overrides])

  const rows = useMemo(() => {
    const now = new Date()
    const curMonth = now.getFullYear() * 12 + now.getMonth()
    const map = new Map()
    outstanding.forEach((r) => {
      // A running-month invoice with no rep yet isn't a real "unassigned" problem -
      // it was just issued and is awaiting rep allotment. Keep it out of the
      // Unassigned bucket; once a rep is set it shows up under that rep normally.
      const noRep = !r.salesRep
      if (noRep && r.date && (r.date.getFullYear() * 12 + r.date.getMonth()) === curMonth) return
      const key = (r.salesRep || 'Unassigned').toUpperCase()
      const cur = map.get(key) || {
        rep: key, customers: new Set(), count: 0, outstanding: 0,
        past90: 0, invoices: [],
      }
      cur.customers.add(r.vendor)
      cur.count += 1
      cur.outstanding += r.outstanding
      cur.invoices.push(r)
      if (r.agingBucket === '180+') cur.past90 += r.outstanding
      map.set(key, cur)
    })
    return [...map.values()]
      .map((c) => {
        const d = dsoMap.get(c.rep) || {}
        return {
          ...c,
          customerCount: c.customers.size,
          dso: d.dso || 0,
          opDso: d.opDso || 0,
        }
      })
      .sort((a, b) => b.outstanding - a.outstanding)
  }, [outstanding, dsoMap])

  const repF = useColFilter(rows, (r) => r.rep)
  const shown = useMemo(() => rows.filter(repF.pass), [rows, repF])

  // Click a rep row → drill into ALL of that rep's invoices, open + closed
  // (the full DSO basis). Modal default-sorts by outstanding, so open AR floats
  // to the top and paid history sits below.
  const openRep = (r) => {
    // Operating-context drill: write-offs + in-collections removed; the modal's
    // cutoff filter (not a year filter) lets you narrow the open invoices.
    const base = (allByRep.get(r.rep) || r.invoices).filter((x) => !x.isWriteOff && !x.isCollection)
    const open = base.filter((x) => x.isOutstanding)
    const openAmt = open.reduce((s, x) => s + (x.outstanding || 0), 0)
    openInvoiceList({
      title: r.rep === 'UNASSIGNED' ? 'Unassigned - no sales rep' : `Rep · ${r.rep}`,
      subtitle: `${base.length} invoices · ${open.length} open (${money(openAmt)})`,
      invoices: base,
      cutoffFilter: true,
      initialCutoff: opCutoff,
    })
  }

  return (
    <div className="table-card">
      <InfoTip
        title="Open AR by rep"
        purpose="The open balance sliced by sales rep, to chase by who owns the account."
        detail="Open invoices grouped by sales rep, showing customers, open count, outstanding and 180+, plus two dollar-weighted DSO columns per rep: Total DSO (write-offs removed, in-collections kept) and Operating DSO (write-offs AND in-collections removed, plus open invoices more than 180 days past due). DSO = Sum(days x amount) / Sum(amount), unpaid counted at current age. This-month invoices with no rep yet are kept out of Unassigned. Click a rep to see all their invoices. Example: a rep at 52d Total / 41d Operating."
        source="Invoice Tracker."
      />
      <div className="table-head">
        <h3>{num(shown.length)} reps with open AR</h3>
        <ExportButton
          filename={`reps-${today10()}.csv`}
          headers={['Sales Rep', '# Customers', '# Open', 'Outstanding', '180+ days', 'Total DSO', 'Operating DSO']}
          rows={shown.map((r) => [r.rep, r.customerCount, r.count, r.outstanding.toFixed(2), r.past90.toFixed(2), r.dso.toFixed(0), r.opDso.toFixed(0)])}
        />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>
                Sales Rep
                <ColumnFilter label="Rep" options={repF.options} excluded={repF.excluded} onChange={repF.setExcluded} />
              </th>
              <th className="num"># Customers</th>
              <th className="num"># Open</th>
              <th className="num">Outstanding</th>
              <th className="num">180+</th>
              <th className="num" title="Total DSO - dollar-weighted; write-offs removed, in-collections kept">Total DSO</th>
              <th className="num" title="Operating DSO - write-offs + in-collections removed; uses the chosen Operating scope (default: up to 180 days past due)">Op. DSO</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan="7" className="table-empty">No open AR by rep.</td></tr>}
            {shown.map((r) => (
              <tr
                key={r.rep}
                onClick={() => openRep(r)}
                style={{ cursor: 'pointer' }}
                className={r.rep === 'UNASSIGNED' ? 'row-unassigned' : undefined}
                title={`Click to see ${r.rep === 'UNASSIGNED' ? 'invoices with no rep' : r.rep + "'s invoices"}`}
              >
                <td className="vendor-cell">
                  {r.rep}
                  {r.rep === 'UNASSIGNED' && <span className="rep-flag">no rep</span>}
                </td>
                <td className="num">{r.customerCount}</td>
                <td className="num">{r.count}</td>
                <td className="num cell-warn">{money(r.outstanding, true)}</td>
                <td className="num">{r.past90 > 0 ? money(r.past90) : ''}</td>
                <td className="num">{r.dso > 0 ? `${r.dso.toFixed(0)}d` : '-'}</td>
                <td className="num"><strong>{r.opDso > 0 ? `${r.opDso.toFixed(0)}d` : '-'}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============ BY YEAR TAB ============
function ByYearTab({ outstanding }) {
  const { openInvoiceList } = useNav()
  const rows = useMemo(() => {
    const map = new Map()
    outstanding.forEach((r) => {
      const y = r.date ? r.date.getFullYear() : 'Unknown'
      const cur = map.get(y) || { year: y, count: 0, outstanding: 0, upcoming: 0, current: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, invoices: [] }
      cur.count += 1
      cur.outstanding += r.outstanding
      cur.invoices.push(r)
      const b = r.agingBucket
      if (b === 'Current') cur.upcoming += r.outstanding
      else if (b === '1–30') cur.current += r.outstanding
      else if (b === '31–60') cur.b1 += r.outstanding
      else if (b === '61–90') cur.b2 += r.outstanding
      else if (b === '91–120') cur.b3 += r.outstanding
      else if (b === '121–180') cur.b4 += r.outstanding
      else cur.b5 += r.outstanding
      map.set(y, cur)
    })
    return [...map.values()].sort((a, b) => String(b.year).localeCompare(String(a.year)))
  }, [outstanding])

  return (
    <div className="table-card">
      <InfoTip
        title="Outstanding by invoice year"
        purpose="How much of the owed balance comes from each year's invoices, exposing how old the unpaid book is."
        detail="Outstanding of open invoices grouped by the year the invoice was raised, with each year also split across the days-past-due bands (Current, 1-30, 31-60, 61-90, 91-120, 121-180, 180+); older years are hardest to collect. Click a year to list its invoices. Example: $400,000 from 2026, $50,000 from 2025, $15,000 from 2024."
        source="Invoice Tracker."
      />
      <div className="table-head">
        <h3>Outstanding by invoice year · bands = days past due</h3>
        <ExportButton
          filename={`by-year-${today10()}.csv`}
          headers={['Year', '# Open', 'Outstanding', 'Current', '1–30', '31–60', '61–90', '91–120', '121–180', '180+']}
          rows={rows.map((r) => [r.year, r.count, r.outstanding.toFixed(2), r.upcoming.toFixed(2), r.current.toFixed(2), r.b1.toFixed(2), r.b2.toFixed(2), r.b3.toFixed(2), r.b4.toFixed(2), r.b5.toFixed(2)])}
        />
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Year</th>
              <th className="num"># Open</th>
              <th className="num">Outstanding</th>
              <th className="num" title="days past due">Current</th>
              <th className="num" title="days past due">1–30</th>
              <th className="num" title="days past due">31–60</th>
              <th className="num" title="days past due">61–90</th>
              <th className="num" title="days past due">91–120</th>
              <th className="num" title="days past due">121–180</th>
              <th className="num" title="days past due">180+</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.year} className="clickable-row" onClick={() => r.invoices.length && openInvoiceList({ title: `Outstanding · ${r.year}`, subtitle: `${r.count} open invoices · ${money(r.outstanding)}`, invoices: r.invoices })} title={`See the ${r.count} open invoices from ${r.year}`}>
                <td><strong>{r.year}</strong></td>
                <td className="num">{r.count}</td>
                <td className="num cell-warn">{money(r.outstanding, true)}</td>
                <td className="num">{r.upcoming > 0 ? money(r.upcoming) : ''}</td>
                <td className="num">{r.current > 0 ? money(r.current) : ''}</td>
                <td className="num">{r.b1 > 0 ? money(r.b1) : ''}</td>
                <td className="num">{r.b2 > 0 ? money(r.b2) : ''}</td>
                <td className="num">{r.b3 > 0 ? money(r.b3) : ''}</td>
                <td className="num">{r.b4 > 0 ? money(r.b4) : ''}</td>
                <td className="num">{r.b5 > 0 ? money(r.b5) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ============ DSO TREND TAB ============
function DsoTrendTab({ allInvoices, scope }) {
  const { openInvoiceList } = useNav()
  // Monthly DSO trend, exactly matching the operator's "<book> DSO" sheet tabs:
  //   DSO = Σ(daysToPay × invoiceAmount) ÷ Σ(invoiceAmount), grouped by the
  //   invoice's ISSUE month (not paid month). Every invoice billed that month
  //   counts - paid ones use (paidDate − issueDate), still-open ones use their
  //   current age (today − issueDate). Scope is wholesale-minus-private-label
  //   for Little Tree; Gelato runs the same math on its own sheet.
  const rows = useMemo(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0)
    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const map = new Map()
    allInvoices.forEach((r) => {
      if (!r.date || r.invoiceAmount <= 0) return
      if (r.isWriteOff) return // exclude write-offs - matches Total DSO + the overall figure below
      const end = r.paidDate || now // open invoice → age to today
      const days = (end - r.date) / 86400000
      if (days < 0 || days > 3650) return // sanity guard (date-parse errors)
      const k = `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, '0')}` // ISSUE month
      if (k === currentKey) return // in-progress issue month - incomplete cohort
      const cur = map.get(k) || { key: k, weightedDays: 0, amount: 0, paid: 0, count: 0, invoices: [] }
      cur.weightedDays += days * r.invoiceAmount
      cur.amount += r.invoiceAmount
      cur.paid += r.invoicePaid
      cur.count += 1
      cur.invoices.push(r)
      map.set(k, cur)
    })
    return [...map.values()]
      .map((c) => ({ ...c, dso: c.amount > 0 ? c.weightedDays / c.amount : 0 }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(-24)
  }, [allInvoices])

  // Overall = the SAME all-time operator DSO as the "Days to collect" card and
  // By-Rep (Σ days×amount ÷ Σ amount over every billed invoice), so the headline
  // number is identical everywhere - not a trailing-window average of the rows.
  const overall = useMemo(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0)
    let n = 0, d = 0
    allInvoices.forEach((r) => {
      if (!r.date || r.invoiceAmount <= 0) return
      if (r.isWriteOff) return  // DSO excludes written-off invoices
      const end = r.paidDate || now

      const days = (end - r.date) / 86400000
      if (days < 0 || days > 3650) return
      n += days * r.invoiceAmount; d += r.invoiceAmount
    })
    return d > 0 ? n / d : 0
  }, [allInvoices])

  const latest = rows[rows.length - 1]

  return (
    <>
      <section className="kpi-grid">
        <KpiCard label="Latest month DSO" value={latest ? `${latest.dso.toFixed(0)} days` : ''} sub={latest ? monthLabel(latest.key) : ''} tone={latest && latest.dso > overall ? 'warn' : 'good'}
          info={{
            title: 'Latest month DSO',
            purpose: "How long collection is taking on the most recent completed issue month's invoices versus the overall average.",
            detail: 'Dollar-weighted DSO = Sum(days to pay x invoice amount) / Sum(invoice amount) for invoices issued in the latest complete month (the in-progress month is skipped); flagged when above the all-time DSO for this book. Example: 42 days vs overall 30 days.',
            source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).',
          }}
          onClick={latest && latest.invoices && latest.invoices.length ? () => openInvoiceList({ title: `DSO · ${monthLabel(latest.key)} (issued)`, subtitle: `${latest.count} invoices · DSO ${latest.dso.toFixed(0)}d`, invoices: latest.invoices }) : undefined}
        />
      </section>
      <div className="chart-card">
        <InfoTip
          title="DSO trend"
          purpose="Whether customers are paying faster or slower over time."
          detail="Monthly DSO grouped by invoice issue month (last 24 months, current month excluded), using the same dollar-weighted Sum(days x amount) / Sum(amount) method as the headline. Click a point to list that month's invoices. Example: 28 days in Jan drifting to 40 by May."
          source="Invoice Tracker."
        />
        <div className="chart-head">
          <h3>DSO trend</h3>
          <span className="chart-sub">Dollar-weighted days-to-pay by invoice issue month</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows} margin={{ top: 10, right: 20, left: 0, bottom: 10 }} style={{ cursor: 'pointer' }}
            onClick={(st) => { const r = st?.activePayload?.[0]?.payload; if (r?.invoices?.length) openInvoiceList({ title: `DSO · ${monthLabel(r.key)} (issued)`, subtitle: `${r.count} invoices · DSO ${r.dso.toFixed(0)}d`, invoices: r.invoices, comparison: flowComparison(rows, r, 'dso', { upIsBad: true, unit: 'days', labelFn: (p) => monthLabel(p.key) }) }) }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="key" tickFormatter={(k) => monthLabel(k, { short: true })} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => `${v}d`} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}
              labelFormatter={(k) => monthLabel(k)}
              formatter={(v) => `${v.toFixed(1)} days`}
            />
            <Line type="monotone" dataKey="dso" stroke="#15803d" strokeWidth={2.5} dot={{ r: 3, fill: '#15803d' }} name="Avg DSO" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="table-card">
        <InfoTip
          title="Monthly detail"
          purpose="The exact figures behind the DSO trend, per issue month."
          detail="For each issue month: number of invoices, amount billed and the dollar-weighted DSO (same method as the trend chart). The by-year DSO breakdown (2024 onward; 2023 hidden as being written off) lives in the Days-to-collect card. Click a row to list that month's invoices. Example: 2025 billed $2.1M across 640 invoices at a 33-day DSO."
          source="Invoice Tracker."
        />
        <div className="table-head">
          <h3>Monthly detail</h3>
          <ExportButton
            filename={`dso-trend-${today10()}.csv`}
            headers={['Month (issued)', '# Invoices', 'Billed', 'Collected', 'Avg DSO (days)']}
            rows={rows.slice().reverse().map((r) => [monthLabel(r.key), r.count, r.amount.toFixed(2), r.paid.toFixed(2), r.dso.toFixed(1)])}
          />
        </div>
        <div className="table-wrap">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Month (issued)</th>
                <th className="num"># Invoices</th>
                <th className="num">Billed</th>
                <th className="num">Avg DSO (days)</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan="4" className="table-empty">No invoices to compute DSO.</td></tr>}
              {rows.slice().reverse().map((r) => (
                <tr
                  key={r.key}
                  onClick={() => openInvoiceList({
                    title: `DSO · ${monthLabel(r.key)} (issued)`,
                    subtitle: `${r.count} invoices billed ${money(r.amount)} · ${money(r.paid)} collected · DSO ${r.dso.toFixed(0)}d (Σ days×amount ÷ Σ amount)`,
                    invoices: r.invoices,
                  })}
                  style={{ cursor: 'pointer' }}
                  title={`See the ${r.count} invoices behind ${monthLabel(r.key)}'s DSO`}
                >
                  <td><strong>{monthLabel(r.key)}</strong></td>
                  <td className="num">{r.count}</td>
                  <td className="num">{money(r.amount)}</td>
                  <td className="num">{r.dso.toFixed(0)}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

// ============ TRENDS ============
// 3 focused over-time views:
//   1. Total AR by month-end (single line - is AR growing or shrinking?)
//   2. Monthly billing vs collections (bars - operational rhythm)
//   3. 180+ stuck over time (single red line - is bad debt growing?)
function ArTrendTab({ arInvoices, past90Sum }) {
  const { openInvoiceList } = useNav()
  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d }, [])


  const oldestUnpaid = useMemo(() => {
    let oldest = null
    arInvoices.forEach((r) => {
      if (r.isOutstanding && r.date && (!oldest || r.date < oldest.date)) oldest = r
    })
    return oldest
  }, [arInvoices])

  const last30Collected = useMemo(() => {
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 30)
    let sum = 0
    const list = []
    arInvoices.forEach((r) => {
      if (r.isPaid && r.paidDate && r.paidDate >= cutoff && r.paidDate <= today) {
        sum += r.invoicePaid || r.invoiceAmount
        list.push(r)
      }
    })
    return { sum, count: list.length, list }
  }, [arInvoices, today])


  // Per-month aggregates: total AR (point-in-time), 180+ stuck (point-in-time),
  // new issued and collected (flow). One pass over the data per month.
  const monthly = useMemo(() => {
    const out = []
    for (let i = 5; i >= 0; i--) {
      const start = new Date(today.getFullYear(), today.getMonth() - i, 1)
      const end = new Date(today.getFullYear(), today.getMonth() - i + 1, 0)
      end.setHours(23, 59, 59, 999)
      let issued = 0, collected = 0, totalAr = 0, stuck180 = 0
      const issuedList = [], collectedList = [], arList = [], stuckList = []
      arInvoices.forEach((r) => {
        // Monthly flow (activity DURING the month)
        if (r.date && r.date >= start && r.date <= end) { issued += r.invoiceAmount; issuedList.push(r) }
        if (r.isPaid && r.paidDate && r.paidDate >= start && r.paidDate <= end) {
          collected += r.invoicePaid || r.invoiceAmount
          collectedList.push(r)
        }
        // OPENING balance as of the 1st of the month: invoices issued BEFORE the
        // month began, valued at what was still unpaid on that date. Payments
        // dated before the 1st are netted out; payments on/after the 1st are not
        // (the invoice was still fully open at the opening instant). This is the
        // true opening AR back then - not today's leftover balance.
        if (!r.date || r.date >= start) return
        if (r.isWriteOff) return
        const paidByOpen = (r.paidDate && r.paidDate < start) ? (r.invoicePaid || (r.isPaid ? r.invoiceAmount : 0)) : 0
        const amt = r.invoiceAmount - paidByOpen
        if (amt <= 0) return
        // Stamp the AS-OF-the-1st opening balance onto the row so the drill-down
        // modal's Outstanding total matches the chart (instead of today's balance).
        const ageDays = Math.floor((start - r.date) / 86400000)
        const rowAsOf = { ...r, outstanding: amt, isOutstanding: true, daysOverdue: ageDays }
        totalAr += amt
        arList.push(rowAsOf)
        // 180+ days past invoice date as of the 1st of this month
        if (ageDays > 180) { stuck180 += amt; stuckList.push(rowAsOf) }
      })
      out.push({
        label: `1 ${start.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}`,
        totalAr,
        stuck180,
        issued,
        collectedNeg: -collected,
        collected,
        net: issued - collected,
        issuedInvoices: issuedList,
        collectedInvoices: collectedList,
        arInvoicesList: arList,
        stuck180Invoices: stuckList,
      })
    }
    return out
  }, [arInvoices, today])

  const oldestDays = oldestUnpaid ? Math.floor((today - oldestUnpaid.date) / 86400000) : 0
  const oldestYears = oldestDays >= 365 ? (oldestDays / 365).toFixed(1) + ' years' : oldestDays + ' days'

  const fmtY = (v) => {
    const a = Math.abs(v)
    return a >= 1e6 ? `$${(v/1e6).toFixed(1)}M` : a >= 1e3 ? `$${(v/1e3).toFixed(0)}K` : `$${v}`
  }

  return (
    <>
      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <KpiCard
          label="Oldest unpaid invoice"
          value={oldestYears}
          sub={oldestUnpaid ? `${oldestUnpaid.vendor} · ${money(oldestUnpaid.outstanding)}` : '-'}
          info={{
            title: 'Oldest unpaid invoice',
            purpose: 'How stale the book is, measured by the single oldest still-open invoice.',
            detail: 'Time since the oldest open invoice was issued; shown in days, or in years once past 365 days. Example: issued 500 days ago = 1.4 years.',
            source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).',
          }}
        />
        <KpiCard
          label="Collected (last 30 days)"
          value={money(last30Collected.sum)}
          sub={`${last30Collected.count} invoice${last30Collected.count === 1 ? '' : 's'} paid`}
          tone={last30Collected.sum > 0 ? 'good' : 'warn'}
          info={{
            title: 'Collected (last 30 days)',
            purpose: 'How much cash actually came in over the past month.',
            detail: 'Payments on invoices whose paid date falls within the last 30 days, with a count of invoices paid. Example: 22 invoices paid = $140,000.',
            source: 'Invoice Tracker (Gelato AR sheet on the Gelato page).',
          }}
          onClick={last30Collected.count > 0 ? () => openInvoiceList({
            title: 'Collected · last 30 days',
            subtitle: `${last30Collected.count} invoices · ${money(last30Collected.sum)} collected`,
            invoices: last30Collected.list,
            hideOutstanding: true,
          }) : undefined}
        />

      </div>

      <div className="chart-card">
        <InfoTip
          title="Total AR over time"
          purpose="Whether overall receivables are building up or being worked down."
          detail="The OPENING receivables balance on the 1st of each of the last 6 months: invoices issued before that month began and still unpaid on that date (payments made before the 1st are netted out, written-offs excluded). It is the AR as it stood back then, not today's leftover balance. A rising line means owed money is accumulating faster than it is collected. Click a point to list the invoices. Example: $204,000 on 1 Jan rising to $250,000 by 1 Apr."
          source="Invoice Tracker."
        />
        <div className="chart-head">
          <h3>Total AR over time</h3>
          <span className="chart-sub">Opening AR on the 1st of each month (what customers owed at the start of the month). Line going up = AR growing.</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={monthly} margin={{ top: 10, right: 20, left: 0, bottom: 10 }} style={{ cursor: 'pointer' }}
            onClick={(st) => { const r = st?.activePayload?.[0]?.payload; if (r?.arInvoicesList?.length) openInvoiceList({ title: `Open AR · as of ${r.label}`, subtitle: `${r.arInvoicesList.length} invoices · ${money(r.totalAr)}`, invoices: r.arInvoicesList, comparison: stockComparison(monthly, r, 'arInvoicesList', 'totalAr', { addedLabel: 'Newly open', removedLabel: 'Paid or cleared' }) }) }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={fmtY} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }} formatter={(v) => money(v)} />
            <Line type="monotone" dataKey="totalAr" stroke="#15803d" strokeWidth={3} dot={{ r: 5, fill: '#15803d' }} name="Total AR" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-card">
        <InfoTip
          title="Monthly billing vs collections"
          purpose="Each month, how much was invoiced versus how much was collected."
          detail="Per month over the last 6 months: new invoices billed (by invoice date) and payments received (by paid date); collections below billing means cash is falling behind sales. Click a bar to list its invoices. Example: April billed $90,000, collected $65,000."
          source="Invoice Tracker."
        />
        <div className="chart-head">
          <h3>Monthly billing vs collections</h3>
          <span className="chart-sub">New invoices billed vs payments received each month. Balanced is healthy.</span>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={monthly} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>

            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={fmtY} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }}
              formatter={(v, name) => [money(Math.abs(v)), name]}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="issued" fill="#6366f1" name="New invoices billed" radius={[4, 4, 0, 0]} cursor="pointer"
              onClick={(p) => p?.issuedInvoices?.length && openInvoiceList({ title: `Billed · ${p.label}`, subtitle: `${p.issuedInvoices.length} invoices · ${money(p.issued)}`, invoices: p.issuedInvoices, hideOutstanding: true, comparison: flowComparison(monthly, p, 'issued', { upIsBad: false }) })} />
            <Bar dataKey="collected" fill="#14b8a6" name="Payments received" radius={[4, 4, 0, 0]} cursor="pointer"
              onClick={(p) => p?.collectedInvoices?.length && openInvoiceList({ title: `Collected · ${p.label}`, subtitle: `${p.collectedInvoices.length} invoices · ${money(p.collected)}`, invoices: p.collectedInvoices, hideOutstanding: true, comparison: flowComparison(monthly, p, 'collected', { upIsBad: false }) })} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="chart-card">
        <InfoTip
          title="180+ days stuck over time"
          purpose="Whether the oldest, riskiest balance is growing."
          detail="On the 1st of each of the last 6 months, the opening balance on invoices more than 180 days past their invoice date as of that date; a rising line means the bad-debt problem is worsening. Click a point to list them. Example: $20,000 on 1 Feb climbing to $35,000 by 1 May."
          source="Invoice Tracker."
        />
        <div className="chart-head">
          <h3>180+ days stuck over time</h3>
          <span className="chart-sub">Old unpaid invoices more than 180 days from invoice date. Line going up = collection problem worsening.</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={monthly} margin={{ top: 10, right: 20, left: 0, bottom: 10 }} style={{ cursor: 'pointer' }}
            onClick={(st) => {
              const r = st?.activePayload?.[0]?.payload
              if (!r?.stuck180Invoices?.length) return
              openInvoiceList({ title: `180+ days stuck · as of ${r.label}`, subtitle: `${r.stuck180Invoices.length} invoices · ${money(r.stuck180)}`, invoices: r.stuck180Invoices, comparison: stockComparison(monthly, r, 'stuck180Invoices', 'stuck180', { addedLabel: 'Newly stuck', removedLabel: 'Cleared' }) })
            }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={fmtY} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }} formatter={(v) => money(v)} />
            <Line type="monotone" dataKey="stuck180" stroke="#dc2626" strokeWidth={3} dot={{ r: 5, fill: '#dc2626' }} name="180+ days stuck" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="muted-note">
        Trends are reconstructed from current data - historical totals are slightly understated for invoices
        that have since been paid. Trend direction is accurate; for exact frozen snapshots, a daily archive would be needed.
      </p>
    </>
  )
}

function bucketCls(label) {
  return ({
    'Current': 'bucket-upcoming',
    '1–30': 'bucket-current',
    '31–60': 'bucket-1',
    '61–90': 'bucket-2',
    '91–120': 'bucket-3',
    '121–180': 'bucket-4',
    '180+': 'bucket-5',
  })[label] || ''
}
