// Replicate the OPERATOR's DSO method (from the "Manny DSO" sheet tab) per rep.
//   DSO = Σ(daysToPay × invoiceAmount) ÷ Σ(invoiceAmount)
//   daysToPay = ((paidDate || today) − invoiceDate)   ← unpaid uses current age
//   one unified pool (paid + partial + unpaid), weighted by FULL invoice amount.
//   run: node scripts/diagnose-rep-dso.mjs
import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr } from '../src/ar/lib/brands.js'

const data = await loadAll()
const today = new Date(); today.setHours(0, 0, 0, 0)

const vendorBrand = new Map()
data.invoices.forEach((r) => { if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand) })
const inAr = (r) => isInAr(r, vendorBrand.get(r.vendor))

const repKey = (r) => (r.salesRep || 'Unassigned').toUpperCase()

// operator-style DSO over an invoice list
function operatorDso(list, { excludeCW = false } = {}) {
  let num = 0, den = 0, n = 0
  for (const r of list) {
    if (!r.date || r.invoiceAmount <= 0) continue
    if (excludeCW && (r.isCollection || r.isWriteOff)) continue
    const end = r.paidDate || today
    const days = (end - r.date) / 86400000
    if (days < 0 || days > 3650) continue // guard: drop date-parse errors (>10yr)
    num += days * r.invoiceAmount
    den += r.invoiceAmount
    n += 1
  }
  return { dso: den > 0 ? num / den : 0, amt: den, n }
}

// ---- Validate against the Manny tab (780 rows, $3,120,659, DSO 45.19) ----
const mannyAll = data.invoices.filter((r) => repKey(r) === 'MANNY')
const mannyInAr = mannyAll.filter(inAr)
console.log('=== MANNY validation (target: 780 rows, $3,120,659, DSO 45.19) ===')
const vA = operatorDso(mannyAll)
const vB = operatorDso(mannyInAr)
const vC = operatorDso(mannyAll, { excludeCW: true })
console.log('A) salesRep=Manny, no scope, no excl :', `n=${vA.n}`, `$${Math.round(vA.amt).toLocaleString()}`, `DSO=${vA.dso.toFixed(2)}`)
console.log('B) + isInAr scope filter            :', `n=${vB.n}`, `$${Math.round(vB.amt).toLocaleString()}`, `DSO=${vB.dso.toFixed(2)}`)
console.log('C) no scope, exclude coll/writeoff   :', `n=${vC.n}`, `$${Math.round(vC.amt).toLocaleString()}`, `DSO=${vC.dso.toFixed(2)}`)

// ---- Apply operator method to ALL reps (no scope filter, to match their tabs) ----
const reps = new Map()
data.invoices.forEach((r) => {
  const k = repKey(r)
  if (!reps.has(k)) reps.set(k, [])
  reps.get(k).push(r)
})
const rows = [...reps.entries()].map(([rep, list]) => {
  const open = list.filter((r) => r.isOutstanding)
  return {
    rep,
    invN: list.length,
    openAr: open.reduce((s, r) => s + r.outstanding, 0),
    ...operatorDso(list),
  }
}).filter((r) => r.amt > 0).sort((a, b) => b.openAr - a.openAr)

// ---- Investigate the LITTLE TREE anomaly ----
const lt = data.invoices.filter((r) => repKey(r) === 'LITTLE TREE' && r.date && r.invoiceAmount > 0)
const ltDays = lt.map((r) => ({ inv: r.invNo, date: r.date, amt: r.invoiceAmount, paid: !!r.paidDate, days: ((r.paidDate || today) - r.date) / 86400000, status: r.status }))
  .sort((a, b) => b.days * b.amt - a.days * a.amt)
console.log('\n=== LITTLE TREE top day×amount contributors ===')
ltDays.slice(0, 8).forEach((r) => console.log('  ', r.inv, '| date', r.date.toISOString().slice(0, 10), '| amt $' + Math.round(r.amt).toLocaleString(), '| days', Math.round(r.days), '| paid?', r.paid, '|', r.status))
const ancient = ltDays.filter((r) => r.days > 1000)
console.log(`  invoices with age/days-to-pay > 1000: ${ancient.length} of ${lt.length}, contributing $${Math.round(ancient.reduce((s,r)=>s+r.amt,0)).toLocaleString()} billed`)

console.log('\n=== DSO per rep: FULL invoice tracker  vs  AR-scoped (isInAr) ===')
console.log('rep                | full-tracker DSO (n) | AR-scoped DSO (n)  | same?')
console.log('-'.repeat(74))
const allReps = [...new Set(data.invoices.map(repKey))]
const byRepFull = (rep) => data.invoices.filter((r) => repKey(r) === rep)
const byRepScoped = (rep) => data.invoices.filter((r) => repKey(r) === rep && inAr(r))
const summary = allReps.map((rep) => {
  const f = operatorDso(byRepFull(rep))
  const s = operatorDso(byRepScoped(rep))
  return { rep, f, s, openAr: byRepFull(rep).filter(r=>r.isOutstanding).reduce((a,r)=>a+r.outstanding,0) }
}).filter((x) => x.f.amt > 0).sort((a, b) => b.openAr - a.openAr)
for (const { rep, f, s } of summary) {
  const same = Math.abs(f.dso - s.dso) < 0.05 && f.n === s.n
  console.log(
    rep.padEnd(18).slice(0, 18), '|',
    (f.dso.toFixed(1) + 'd').padStart(8) + ` (${f.n})`.padEnd(7), '|',
    (s.dso.toFixed(1) + 'd').padStart(8) + ` (${s.n})`.padEnd(7), '|',
    same ? 'yes' : 'NO  <-- differs',
  )
}
