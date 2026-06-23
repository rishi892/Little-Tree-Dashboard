import { monthKey } from './format.js'

export function computeAgingBuckets(invoices) {
  const buckets = { 'Current': 0, '1–30': 0, '31–60': 0, '61–90': 0, '91–120': 0, '121–180': 0, '180+': 0 }
  const counts = { 'Current': 0, '1–30': 0, '31–60': 0, '61–90': 0, '91–120': 0, '121–180': 0, '180+': 0 }
  invoices
    .filter((r) => r.isOutstanding)
    .forEach((r) => {
      const b = r.agingBucket in buckets ? r.agingBucket : '180+'
      buckets[b] += r.outstanding
      counts[b] += 1
    })
  return Object.keys(buckets).map((label) => ({
    label,
    amount: buckets[label],
    count: counts[label],
  }))
}

export function topVendorsOwed(invoices, limit = 10) {
  const map = new Map()
  invoices.filter((r) => r.isOutstanding).forEach((r) => {
    const key = r.vendor || 'Unknown'
    const cur = map.get(key) || { vendor: key, outstanding: 0, count: 0, oldest: null }
    cur.outstanding += r.outstanding
    cur.count += 1
    if (r.daysOverdue != null && (cur.oldest == null || r.daysOverdue > cur.oldest)) {
      cur.oldest = r.daysOverdue
    }
    map.set(key, cur)
  })
  return [...map.values()].sort((a, b) => b.outstanding - a.outstanding).slice(0, limit)
}

export function topVendorsSales(financials, limit = 10) {
  const map = new Map()
  financials.forEach((r) => {
    const key = r.vendor || 'Unknown'
    const cur = map.get(key) || { vendor: key, sales: 0, paid: 0, count: 0 }
    cur.sales += r.invoiceAmount
    cur.paid += r.invoicePaid
    cur.count += 1
    map.set(key, cur)
  })
  return [...map.values()].sort((a, b) => b.sales - a.sales).slice(0, limit)
}

export function monthlySales(financials, monthsBack = 24) {
  const map = new Map()
  financials.forEach((r) => {
    const k = monthKey(r.date)
    if (!k) return
    const cur = map.get(k) || { key: k, sales: 0, paid: 0, count: 0 }
    cur.sales += r.invoiceAmount
    cur.paid += r.invoicePaid
    cur.count += 1
    map.set(k, cur)
  })
  return [...map.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(-monthsBack)
}
