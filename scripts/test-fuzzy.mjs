// Smoke test for nameConfidence — checks the scorer behaves as intended
// on real vendor variants. Run: node scripts/test-fuzzy.mjs

import { nameConfidence, tokenize } from '../src/lib/fuzzy.js'
import { loadAll } from '../src/lib/sheets.js'
import { canonicalVendor, buildVendorIndex } from '../src/lib/vendors.js'

const cases = [
  // Should merge (≥ 90)
  ['All-Stars',                          'All-Star Processing',                  'MERGE'],
  ['Allstar Processing LLC',             'All Star Processing',                  'MERGE'],
  ['Pleasantrees Houghton',              'Pleasantrees Houghton Lake',           'MERGE'],
  ['Cloud Cannabis Detroit',             'Cloud Cannabis Detroit Hamtramck',     'MERGE'],
  ['Joyology LLC',                       'JOYOLOGY Inc',                         'MERGE'],
  ['Little Tree- Pure Cannabis Outlet',  'Little Tree- Pure Cannabis Outlet LLC','MERGE'],

  // Should NOT merge (different businesses sharing a brand word)
  ['Pure Cannabis Outlet',               'Pure New Baltimore',                   'KEEP SEPARATE'],
  ['Green Pharm Iron River',             'Green Pharm Mt Morris',                'KEEP SEPARATE'],
  ['Pleasantrees',                       'Pleasantrees Detroit',                 'KEEP SEPARATE'], // single token subset
  ['JARS Detroit',                       'JARS Troy',                            'KEEP SEPARATE'],
  ['High Society',                       'High Club',                            'KEEP SEPARATE'],

  // Typo cases (edit distance should catch)
  ['Allstar Procesing',                  'Allstar Processing',                   'MERGE'],
  ['Pleasantrees Hougton',               'Pleasantrees Houghton',                'MERGE'],
]

console.log('Pairwise confidence checks')
console.log('─'.repeat(78))
cases.forEach(([a, b, want]) => {
  const score = nameConfidence(a, b)
  const got = score >= 90 ? 'MERGE' : 'KEEP SEPARATE'
  const pass = got === want ? '✓' : '✗'
  console.log(`${pass} [${score.toString().padStart(3)}] ${want.padEnd(14)} got ${got.padEnd(14)}  "${a}"  ↔  "${b}"`)
})

console.log('\nTokenize spot-checks')
console.log('─'.repeat(78))
const tokSamples = [
  'Little Tree- All Star Processing LLC',
  'Allstars',
  'JARS/ALLSTAR',
  'The Foundry Cannabis Co',
  'Pleasantrees Houghton Lake',
]
tokSamples.forEach((s) => {
  console.log(`  ${s.padEnd(40)} → [${tokenize(s).join(', ')}]`)
})

// Live data — confirm we don't lose customer count drastically
console.log('\nLive sheet — vendor index stats')
console.log('─'.repeat(78))
const data = await loadAll()
const rawVendors = new Set()
data.invoices.forEach((r) => r.vendor && rawVendors.add(r.vendor))
const canonicalSet = new Set()
data.invoices.forEach((r) => r.vendor && canonicalSet.add(r.vendor))
console.log(`  Raw vendor strings  (in-tracker): ${rawVendors.size}`)
console.log(`  Canonical vendors   (after merge): ${canonicalSet.size}`)
console.log(`  Reduction:                         ${rawVendors.size - canonicalSet.size} variants merged`)

// Show top merge groups (canonical → variants)
const vendorIndex = buildVendorIndex(
  data.invoices.map((r) => r.vendor).filter(Boolean),
  data.financials.map((r) => r.vendor).filter(Boolean),
  (data.gelato || []).map((r) => r.vendor).filter(Boolean),
)
const groups = new Map()
vendorIndex.forEach((canonical, raw) => {
  if (canonical !== raw) {
    if (!groups.has(canonical)) groups.set(canonical, [])
    groups.get(canonical).push(raw)
  }
})
console.log(`\nMerge groups (${groups.size} canonical names absorbing variants):`)
;[...groups.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 15)
  .forEach(([canonical, variants]) => {
    console.log(`  • ${canonical}`)
    variants.slice(0, 5).forEach((v) => console.log(`      ← ${v}`))
    if (variants.length > 5) console.log(`      ← ... +${variants.length - 5} more`)
  })
