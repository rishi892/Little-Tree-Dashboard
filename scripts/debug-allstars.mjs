// Why are "All Star Processing" variants still separate in top defaulters?
// Dump raw vendor strings, their normalized keys, and the canonical
// mapping the index produces.

import { loadAll } from '../src/lib/sheets.js'
import { buildVendorIndex } from '../src/lib/vendors.js'

const data = await loadAll()

// Find every raw vendor whose name contains "star" or "allstar" (case-insensitive)
const seen = new Map() // raw → count
data.invoices.forEach((r) => {
  if (!r.vendor) return
  if (/star/i.test(r.vendor) || /allstar/i.test(r.vendor)) {
    seen.set(r.vendor, (seen.get(r.vendor) || 0) + 1)
  }
})

console.log('Raw "*star*" vendor strings (post-canonicalization):')
console.log('─'.repeat(80))
;[...seen.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([v, c]) => console.log(`  ${c.toString().padStart(3)}× "${v}"`))

// Now rebuild from raw — but loadAll already canonicalized. Let's
// hit the underlying sheets directly to see the truly raw names.
import Papa from 'papaparse'
const RAW_URL = 'https://docs.google.com/spreadsheets/d/1hcxz0jxBKIvoMSYrluxOYfBf3hOa4cXEIpqvaRtt-fI/export?format=csv&gid=0'
const text = await (await fetch(RAW_URL)).text()
const rows = Papa.parse(text, { skipEmptyLines: 'greedy' }).data
// find header row containing "VENDOR"
let hi = 0
for (let i = 0; i < 10; i++) {
  if (rows[i].some((c) => String(c).trim().toUpperCase() === 'VENDOR')) { hi = i; break }
}
const headers = rows[hi].map((h) => String(h).trim())
const vIdx = headers.indexOf('VENDOR')

const rawStar = new Map()
rows.slice(hi + 1).forEach((row) => {
  const v = String(row[vIdx] || '').trim()
  if (!v) return
  if (/star/i.test(v) || /allstar/i.test(v)) {
    rawStar.set(v, (rawStar.get(v) || 0) + 1)
  }
})

console.log('\nTRULY raw "*star*" vendor strings (from sheet, pre-canonicalization):')
console.log('─'.repeat(80))
;[...rawStar.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([v, c]) => console.log(`  ${c.toString().padStart(3)}× "${v}"  (chars: ${JSON.stringify(v).slice(0, 80)})`))

// Show their normalized keys
import { canonicalVendor } from '../src/lib/vendors.js'
const idx = buildVendorIndex(
  data.invoices.map((r) => r.vendor).filter(Boolean),
  data.financials.map((r) => r.vendor).filter(Boolean),
  (data.gelato || []).map((r) => r.vendor).filter(Boolean),
)
console.log('\nCanonical mapping from index:')
console.log('─'.repeat(80))
;[...rawStar.keys()].forEach((v) => {
  console.log(`  "${v}"\n      → "${canonicalVendor(v, idx)}"`)
})
