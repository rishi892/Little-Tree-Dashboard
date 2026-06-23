// List the UNASSIGNED bucket — invoices in the tracker with no Sales Rep.
//   run: node scripts/list-unassigned.mjs
import { loadAll } from '../src/ar/lib/sheets.js'

const data = await loadAll()
const today = new Date(); today.setHours(0, 0, 0, 0)

const unassigned = data.invoices.filter((r) => !r.salesRep)
const open = unassigned.filter((r) => r.isOutstanding)

// group open AR by customer
const byCust = new Map()
open.forEach((r) => {
  const c = byCust.get(r.vendor) || { vendor: r.vendor, n: 0, outstanding: 0, oldest: null }
  c.n += 1; c.outstanding += r.outstanding
  if (r.date && (!c.oldest || r.date < c.oldest)) c.oldest = r.date
  byCust.set(r.vendor, c)
})
const rows = [...byCust.values()].sort((a, b) => b.outstanding - a.outstanding)

const money = (n) => '$' + Math.round(n).toLocaleString()
console.log(`\nUNASSIGNED (no Sales Rep) — ${unassigned.length} invoices total, ${open.length} still open\n`)
console.log(`Total open AR with no rep: ${money(open.reduce((s, r) => s + r.outstanding, 0))}`)
console.log(`Distinct customers with open AR & no rep: ${rows.length}\n`)
console.log('customer                                       | #open | open AR     | oldest invoice')
console.log('-'.repeat(92))
for (const c of rows) {
  const age = c.oldest ? Math.floor((today - c.oldest) / 86400000) + 'd' : '—'
  console.log(
    c.vendor.padEnd(46).slice(0, 46), '|',
    String(c.n).padStart(4), '|',
    money(c.outstanding).padStart(11), '|',
    (c.oldest ? c.oldest.toISOString().slice(0, 10) : '—') + ` (${age})`,
  )
}
