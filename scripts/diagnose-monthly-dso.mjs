// Compare monthly DSO trend: CURRENT method vs OPERATOR method.
//   CURRENT  : weight by invoicePaid, cap 730d, AR-scoped (arInvoices)
//   OPERATOR : weight by invoiceAmount, guard 3650d, full tracker
// Grouped by PAID month either way (a monthly trend can only cover paid invoices).
//   run: node scripts/diagnose-monthly-dso.mjs
import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr } from '../src/ar/lib/brands.js'

const data = await loadAll()
const vendorBrand = new Map()
data.invoices.forEach((r) => { if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand) })
const arInvoices = data.invoices.filter((r) => isInAr(r, vendorBrand.get(r.vendor)))
const mkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

function monthly(list, { weight, cap }) {
  const map = new Map()
  list.forEach((r) => {
    if (!r.paidDate || !r.date) return
    const w = weight === 'paid' ? r.invoicePaid : r.invoiceAmount
    if (w <= 0) return
    const days = (r.paidDate - r.date) / 86400000
    if (days < 0 || days > cap) return
    const k = mkey(r.paidDate)
    const cur = map.get(k) || { key: k, wd: 0, amt: 0, n: 0 }
    cur.wd += days * w; cur.amt += w; cur.n += 1
    map.set(k, cur)
  })
  return new Map([...map.values()].map((c) => [c.key, { dso: c.amt > 0 ? c.wd / c.amt : 0, n: c.n, amt: c.amt }]))
}

const cur = monthly(arInvoices, { weight: 'paid', cap: 730 })
const op = monthly(data.invoices, { weight: 'amount', cap: 3650 })

const keys = [...new Set([...cur.keys(), ...op.keys()])].sort().slice(-10)
console.log('\nmonth   | CURRENT (paid-wt, 730, scoped) | OPERATOR (amt-wt, 3650, full tracker)')
console.log('        |   DSO   #inv   $weight         |   DSO   #inv   $weight')
console.log('-'.repeat(82))
for (const k of keys) {
  const c = cur.get(k) || { dso: 0, n: 0, amt: 0 }
  const o = op.get(k) || { dso: 0, n: 0, amt: 0 }
  console.log(
    k, '|',
    (c.dso.toFixed(0) + 'd').padStart(6), String(c.n).padStart(4), ('$' + Math.round(c.amt).toLocaleString()).padStart(12), '   |',
    (o.dso.toFixed(0) + 'd').padStart(6), String(o.n).padStart(4), ('$' + Math.round(o.amt).toLocaleString()).padStart(12),
  )
}
