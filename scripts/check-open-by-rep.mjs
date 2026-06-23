// Verify reps' outstanding: dashboard (AR-scoped) vs full tracker, with totals.
//   run: node scripts/check-open-by-rep.mjs
import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr } from '../src/ar/lib/brands.js'

const data = await loadAll()
const vendorBrand = new Map()
data.invoices.forEach((r) => { if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand) })
const inAr = (r) => isInAr(r, vendorBrand.get(r.vendor))

const money = (n) => '$' + Math.round(n).toLocaleString()
const repName = (r) => (r.salesRep || 'Unassigned')

// dashboard scope: arInvoices.filter(isOutstanding)
const scopedOpen = data.invoices.filter((r) => inAr(r) && r.isOutstanding)
// full tracker: all outstanding
const fullOpen = data.invoices.filter((r) => r.isOutstanding)

function byRep(list) {
  const m = new Map()
  list.forEach((r) => {
    const k = repName(r)
    const c = m.get(k) || { n: 0, amt: 0 }
    c.n += 1; c.amt += r.outstanding; m.set(k, c)
  })
  return m
}
const scoped = byRep(scopedOpen)
const full = byRep(fullOpen)

const reps = [...new Set([...scoped.keys(), ...full.keys()])]
  .map((rep) => ({ rep, s: scoped.get(rep) || { n: 0, amt: 0 }, f: full.get(rep) || { n: 0, amt: 0 } }))
  .sort((a, b) => b.s.amt - a.s.amt)

console.log(`\nfetchedAt: ${data.fetchedAt}\n`)
console.log('rep                | DASHBOARD (AR-scoped)   | full tracker          | diff')
console.log('                   |  #open   outstanding    |  #open   outstanding  |')
console.log('-'.repeat(80))
for (const { rep, s, f } of reps) {
  const diff = f.amt - s.amt
  console.log(
    rep.padEnd(18).slice(0, 18), '|',
    String(s.n).padStart(5), money(s.amt).padStart(13), '   |',
    String(f.n).padStart(5), money(f.amt).padStart(13), '|',
    diff ? money(diff) : '—',
  )
}
const sT = scopedOpen.reduce((a, r) => a + r.outstanding, 0)
const fT = fullOpen.reduce((a, r) => a + r.outstanding, 0)
console.log('-'.repeat(80))
console.log('TOTAL'.padEnd(18), '|', String(scopedOpen.length).padStart(5), money(sT).padStart(13), '   |', String(fullOpen.length).padStart(5), money(fT).padStart(13))
console.log(`\nDashboard "Total outstanding" KPI should read: ${money(sT)} (${scopedOpen.length} invoices)`)
