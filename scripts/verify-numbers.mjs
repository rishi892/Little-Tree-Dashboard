// Independent verification of every dashboard number.
// Pulls live data from the same Google Sheets the dashboard uses,
// re-applies the same canonicalization, then computes each metric
// from scratch using simple sums so we can sanity-check the
// formulas baked into the React components.

import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr, isPrivateLabel } from '../src/ar/lib/brands.js'

const fmt = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pct = (n) => (n * 100).toFixed(1) + '%'
const hr = () => console.log('─'.repeat(72))

function section(title) {
  console.log('')
  hr()
  console.log(title)
  hr()
}

const { invoices, gelato, fetchedAt } = await loadAll()
console.log('Fetched at:', fetchedAt.toISOString())
console.log('Raw counts: invoices=' + invoices.length + ', gelato=' + gelato.length)

const today = new Date()
today.setHours(0, 0, 0, 0)

// ============================================================
// 1. LITTLE TREE A/R — Cash to Collect
// ============================================================
section('1. LITTLE TREE A/R — Cash to Collect')

// AR scope: wholesale only (excludes Private Label) AND
// (a) all invoices used for DSO/stats, OR
// (b) outstanding >= $100 cutoff for "in AR scope" (isInAr).
// The "Cash to collect" headline in the dashboard sums outstanding
// across ALL wholesale outstanding invoices (no min threshold).
const ltAll = invoices.filter((r) => !isPrivateLabel(r.brand)) // wholesale only
const ltOutstanding = ltAll.filter((r) => r.isOutstanding)

const cashToCollect = ltOutstanding.reduce((s, r) => s + r.outstanding, 0)
console.log('Wholesale outstanding invoices :', ltOutstanding.length)
console.log('Cash to collect (sum)          :', fmt(cashToCollect))

// breakdown of moneyOwed vs computed outstanding (for blank "Money Owed" rows)
const sumMoneyOwed = ltOutstanding.reduce((s, r) => s + (r.moneyOwed || 0), 0)
const sumComputed  = ltOutstanding.reduce((s, r) => s + ((r.moneyOwed > 0) ? 0 : r.outstanding), 0)
const blankMoBlOnly = ltOutstanding.filter((r) => !(r.moneyOwed > 0)).length
console.log('  • Sum where Money Owed > 0   :', fmt(sumMoneyOwed), '(rows with explicit Money Owed)')
console.log('  • Sum from Inv - Paid fallback:', fmt(sumComputed), `(${blankMoBlOnly} rows with blank Money Owed)`)
console.log('  • Total                       :', fmt(sumMoneyOwed + sumComputed))

// ============================================================
// 2. AGING BUCKETS (Little Tree wholesale, outstanding only)
// ============================================================
section('2. AGING BUCKETS (Little Tree wholesale)')

const buckets = { 'Current': 0, '1–30': 0, '31–60': 0, '61–90': 0, '90+': 0, 'Unknown': 0 }
const bucketCounts = { 'Current': 0, '1–30': 0, '31–60': 0, '61–90': 0, '90+': 0, 'Unknown': 0 }
ltOutstanding.forEach((r) => {
  const b = r.agingBucket || 'Unknown'
  buckets[b] = (buckets[b] || 0) + r.outstanding
  bucketCounts[b] = (bucketCounts[b] || 0) + 1
})
Object.entries(buckets).forEach(([k, v]) => {
  console.log(`  ${k.padEnd(10)} ${String(bucketCounts[k]).padStart(4)} inv   ${fmt(v).padStart(15)}`)
})
const sumBuckets = Object.values(buckets).reduce((s, v) => s + v, 0)
console.log('  ' + 'TOTAL'.padEnd(10) + ' '.repeat(4) + String(ltOutstanding.length).padStart(4) + ' inv   ' + fmt(sumBuckets).padStart(15))
console.log('  (Matches Cash to Collect?     :', Math.abs(sumBuckets - cashToCollect) < 0.01 ? 'YES ✓' : 'NO ✗', ')')

const ninetyPlus = buckets['90+']
console.log('\n  90+ days bucket               :', fmt(ninetyPlus), `(${bucketCounts['90+']} inv)`)

// ============================================================
// 3. IN COLLECTIONS
// ============================================================
section('3. IN COLLECTIONS (Little Tree wholesale)')

const collectionsRows = ltAll.filter((r) => r.isCollection)
const collectionsOutstanding = collectionsRows.reduce((s, r) => s + r.outstanding, 0)
const collectionsInvAmt = collectionsRows.reduce((s, r) => s + r.invoiceAmount, 0)
console.log('  In Collections rows           :', collectionsRows.length)
console.log('  Sum of outstanding (Money Owed):', fmt(collectionsOutstanding))
console.log('  Sum of invoice amount         :', fmt(collectionsInvAmt))

// ============================================================
// 4. DSO — Dollar-weighted, weight = invoice amount
// ============================================================
section('4. DSO — dollar-weighted by invoice amount')
console.log('  Formula: DSO = Σ(days × invoiceAmount) ÷ Σ(invoiceAmount)')
console.log('')

// Same logic as Collections.jsx
let paidDays = 0, paidAmt = 0, paidN = 0
let openDays = 0, openAmt = 0, openN = 0
const byYear = new Map()
const ensureYear = (y) => {
  if (!byYear.has(y)) byYear.set(y, { paidDays: 0, paidAmt: 0, paidN: 0, openDays: 0, openAmt: 0, openN: 0 })
  return byYear.get(y)
}
ltAll.forEach((r) => {
  if (r.isCollection || r.isWriteOff) return
  if (!r.date) return
  const year = r.date.getFullYear()
  const yr = ensureYear(year)
  if (r.isPaid && r.paidDate) {
    const d = (r.paidDate - r.date) / 86400000
    if (d >= 0 && d <= 1825) {
      paidDays += d * r.invoiceAmount
      paidAmt  += r.invoiceAmount
      paidN    += 1
      yr.paidDays += d * r.invoiceAmount
      yr.paidAmt  += r.invoiceAmount
      yr.paidN    += 1
    }
  } else if (r.isOutstanding) {
    const d = (today - r.date) / 86400000
    if (d >= 0) {
      openDays += d * r.invoiceAmount
      openAmt  += r.invoiceAmount
      openN    += 1
      yr.openDays += d * r.invoiceAmount
      yr.openAmt  += r.invoiceAmount
      yr.openN    += 1
    }
  }
})
const dsoPaid = paidAmt > 0 ? paidDays / paidAmt : 0
const dsoOpen = openAmt > 0 ? openDays / openAmt : 0
const dsoCombined = (paidAmt + openAmt) > 0 ? (paidDays + openDays) / (paidAmt + openAmt) : 0

console.log(`  Paid     ${dsoPaid.toFixed(1).padStart(6)}d   N=${paidN.toString().padStart(4)}   Σamt=${fmt(paidAmt)}`)
console.log(`  Open     ${dsoOpen.toFixed(1).padStart(6)}d   N=${openN.toString().padStart(4)}   Σamt=${fmt(openAmt)}`)
console.log(`  Combined ${dsoCombined.toFixed(1).padStart(6)}d   N=${(paidN + openN).toString().padStart(4)}   Σamt=${fmt(paidAmt + openAmt)}`)

console.log('\n  By invoice year:')
const yearRows = [...byYear.entries()].map(([year, y]) => ({
  year,
  paid:     y.paidAmt > 0 ? y.paidDays / y.paidAmt : 0,
  open:     y.openAmt > 0 ? y.openDays / y.openAmt : 0,
  combined: (y.paidAmt + y.openAmt) > 0 ? (y.paidDays + y.openDays) / (y.paidAmt + y.openAmt) : 0,
  paidN: y.paidN, openN: y.openN,
})).sort((a, b) => b.year - a.year)
yearRows.forEach((y) => {
  console.log(`    ${y.year}   paid ${y.paid.toFixed(1).padStart(5)}d (n=${y.paidN})   open ${y.open.toFixed(1).padStart(5)}d (n=${y.openN})   combined ${y.combined.toFixed(1).padStart(5)}d`)
})

// ============================================================
// 5. ACTION ITEMS — matches Overview & Action List page filters
// ============================================================
section('5. ACTION ITEMS')

// Same vendor → brand map the dashboard builds
const vendorBrand = new Map()
invoices.forEach((r) => {
  if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand)
})

// Action List page: isInAr (PL excluded + outstanding ≥ $100) && isOutstanding
const actionListItems = invoices.filter((r) => isInAr(r, vendorBrand.get(r.vendor)) && r.isOutstanding)
const actionListTotal = actionListItems.reduce((s, r) => s + r.outstanding, 0)
const actionList90 = actionListItems.filter((r) => r.agingBucket === '90+')
const actionList90Sum = actionList90.reduce((s, r) => s + r.outstanding, 0)
console.log('  ── Action List page KPIs ──')
console.log('  On the list (wholesale, ≥$100):', actionListItems.length, ' = ', fmt(actionListTotal))
console.log('  90+ days                       :', actionList90.length, ' = ', fmt(actionList90Sum))

// Overview "Action needed today": wholesale (isInAr) & isOutstanding & (daysOverdue>0 OR no followUpStatus)
const wsOpen = invoices.filter((r) => isInAr(r, vendorBrand.get(r.vendor)) && r.isOutstanding)
const actionNeeded = wsOpen.filter((r) => (r.daysOverdue || 0) > 0 || !r.followUpStatus)
const actionNeededSum = actionNeeded.reduce((s, r) => s + r.outstanding, 0)
console.log('  ── Overview "Action needed today" ──')
console.log('  Count                          :', actionNeeded.length)
console.log('  Amount                         :', fmt(actionNeededSum))

// breakdown of why each was flagged
const overdueOnly = wsOpen.filter((r) => (r.daysOverdue || 0) > 0)
const missingFuOnly = wsOpen.filter((r) => !r.followUpStatus)
console.log('     • Overdue (daysOverdue>0)   :', overdueOnly.length, ' = ', fmt(overdueOnly.reduce((s, r) => s + r.outstanding, 0)))
console.log('     • Missing follow-up status  :', missingFuOnly.length, ' = ', fmt(missingFuOnly.reduce((s, r) => s + r.outstanding, 0)))

// ============================================================
// 6. TOP DEFAULTERS (by outstanding, Little Tree wholesale)
// ============================================================
section('6. TOP DEFAULTERS')

const byVendor = new Map()
ltOutstanding.forEach((r) => {
  const cur = byVendor.get(r.vendor) || { outstanding: 0, n: 0 }
  cur.outstanding += r.outstanding
  cur.n += 1
  byVendor.set(r.vendor, cur)
})
const topDefaulters = [...byVendor.entries()]
  .sort((a, b) => b[1].outstanding - a[1].outstanding)
  .slice(0, 10)
topDefaulters.forEach(([v, x], i) => {
  console.log(`  ${(i + 1).toString().padStart(2)}. ${v.padEnd(45)}  ${fmt(x.outstanding).padStart(13)}  (${x.n} inv)`)
})

// ============================================================
// 7. SALES (Little Tree wholesale, by year)
// ============================================================
section('7. SALES — Little Tree wholesale')

const ltSales = invoices.filter((r) => !isPrivateLabel(r.brand) && !r.isWriteOff && r.date)
const salesByYear = new Map()
ltSales.forEach((r) => {
  const y = r.date.getFullYear()
  const cur = salesByYear.get(y) || { gross: 0, n: 0 }
  cur.gross += r.invoiceAmount
  cur.n += 1
  salesByYear.set(y, cur)
})
;[...salesByYear.entries()].sort((a, b) => b[0] - a[0]).forEach(([y, x]) => {
  console.log(`  ${y}   ${fmt(x.gross).padStart(15)}   (${x.n} invoices)`)
})

// Latest month sales
const lastDate = ltSales.reduce((max, r) => r.date > max ? r.date : max, new Date(0))
if (lastDate.getTime() > 0) {
  const m = lastDate.getMonth(), y = lastDate.getFullYear()
  const monthSales = ltSales.filter((r) => r.date.getMonth() === m && r.date.getFullYear() === y)
  const monthGross = monthSales.reduce((s, r) => s + r.invoiceAmount, 0)
  const monthName = lastDate.toLocaleString('en-US', { month: 'long' })
  console.log(`  Latest month: ${monthName} ${y} = ${fmt(monthGross)}  (${monthSales.length} invoices)`)
}

// ============================================================
// 8. GELATO A/R
// ============================================================
section('8. GELATO A/R')

const gelOutstanding = gelato.filter((r) => r.isOutstanding)
const gelCash = gelOutstanding.reduce((s, r) => s + r.outstanding, 0)
console.log('  Total Gelato rows             :', gelato.length)
console.log('  Outstanding rows              :', gelOutstanding.length)
console.log('  Cash to collect               :', fmt(gelCash))

const gelBuckets = { 'Current': 0, '1–30': 0, '31–60': 0, '61–90': 0, '90+': 0, 'Unknown': 0 }
const gelBucketCounts = { 'Current': 0, '1–30': 0, '31–60': 0, '61–90': 0, '90+': 0, 'Unknown': 0 }
gelOutstanding.forEach((r) => {
  const b = r.agingBucket || 'Unknown'
  gelBuckets[b] = (gelBuckets[b] || 0) + r.outstanding
  gelBucketCounts[b] = (gelBucketCounts[b] || 0) + 1
})
console.log('  Aging buckets:')
Object.entries(gelBuckets).forEach(([k, v]) => {
  console.log(`    ${k.padEnd(10)} ${String(gelBucketCounts[k]).padStart(4)} inv   ${fmt(v).padStart(15)}`)
})

// ============================================================
// 9. UNIQUE CUSTOMERS & BRANDS
// ============================================================
section('9. CUSTOMERS & BRANDS (Little Tree wholesale)')

const customers = new Set(ltAll.map((r) => r.vendor).filter(Boolean))
const customersWithOpenAr = new Set(ltOutstanding.map((r) => r.vendor))
const brands = new Set(ltAll.map((r) => r.brand).filter(Boolean))
console.log('  Unique customers              :', customers.size)
console.log('  Customers with open A/R       :', customersWithOpenAr.size)
console.log('  Unique brands                 :', brands.size)
console.log('  Brand list                    :', [...brands].sort().join(', '))

// ============================================================
// 10. DATA QUALITY CHECKS
// ============================================================
section('10. DATA QUALITY — anomalies worth flagging')

// (a) Invoices with status=Paid but invoicePaid < invoiceAmount
const underpaid = invoices.filter((r) =>
  (r.status || '').toLowerCase() === 'paid' &&
  r.invoiceAmount > 0 &&
  r.invoicePaid > 0 &&
  r.invoicePaid < r.invoiceAmount - 0.01
)
console.log('  Marked "Paid" but underpaid    :', underpaid.length)
if (underpaid.length > 0 && underpaid.length <= 10) {
  underpaid.forEach((r) => {
    console.log(`    • Inv ${r.invNo}  ${r.vendor.padEnd(35)}  amt=${fmt(r.invoiceAmount)}  paid=${fmt(r.invoicePaid)}  diff=${fmt(r.invoiceAmount - r.invoicePaid)}`)
  })
}

// (b) Outstanding with blank Money Owed
const blankMo = ltOutstanding.filter((r) => !(r.moneyOwed > 0))
const blankMoSum = blankMo.reduce((s, r) => s + r.outstanding, 0)
console.log('  Outstanding rows w/ blank Money Owed:', blankMo.length, ' = ', fmt(blankMoSum))

// (c) Missing dates
const missingDate = invoices.filter((r) => !r.date).length
const missingDue  = invoices.filter((r) => !r.dueDate && r.isOutstanding).length
console.log('  Invoices with no Date         :', missingDate)
console.log('  Outstanding w/ no Due Date    :', missingDue)

// (d) Future dates (potentially typos)
const futureDates = invoices.filter((r) => r.date && r.date > new Date(today.getTime() + 60 * 86400000))
console.log('  Invoices dated > 60 days in future:', futureDates.length)
if (futureDates.length > 0 && futureDates.length <= 5) {
  futureDates.forEach((r) => console.log(`    • Inv ${r.invNo}  ${r.vendor}  date=${r.date.toISOString().slice(0, 10)}`))
}

console.log('')
hr()
console.log('Verification complete.')
hr()
