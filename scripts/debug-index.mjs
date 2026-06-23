// Directly call buildVendorIndex on TRULY raw sheet data and inspect
// the resulting lookup for All Star variants.

import Papa from 'papaparse'
import { buildVendorIndex, canonicalVendor } from '../src/lib/vendors.js'

async function rawVendors(url, vendorCol = 'VENDOR') {
  const text = await (await fetch(url)).text()
  const rows = Papa.parse(text, { skipEmptyLines: 'greedy' }).data
  let hi = 0
  for (let i = 0; i < 10; i++) {
    if (rows[i].some((c) => String(c).trim().toUpperCase() === vendorCol)) { hi = i; break }
  }
  const headers = rows[hi].map((h) => String(h).trim())
  const vIdx = headers.indexOf(vendorCol)
  return rows.slice(hi + 1).map((r) => String(r[vIdx] || '').trim()).filter(Boolean)
}

const [invV, finV] = await Promise.all([
  rawVendors('https://docs.google.com/spreadsheets/d/1hcxz0jxBKIvoMSYrluxOYfBf3hOa4cXEIpqvaRtt-fI/export?format=csv&gid=0'),
  rawVendors('https://docs.google.com/spreadsheets/d/1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes/export?format=csv&gid=0'),
])

console.log(`Raw counts — invoices: ${invV.length}, financials: ${finV.length}`)

const idx = buildVendorIndex(invV, finV, [])

// Find every raw "*star*" variant and check what it maps to
const starVariants = new Set()
;[...invV, ...finV].forEach((v) => {
  if (/star/i.test(v)) starVariants.add(v)
})

console.log('\nLookup table for *star* variants:')
console.log('─'.repeat(80))
;[...starVariants].sort().forEach((v) => {
  const c = canonicalVendor(v, idx)
  const arrow = v === c ? '   (no change)' : ` → "${c}"`
  console.log(`  "${v}"${arrow}`)
})
