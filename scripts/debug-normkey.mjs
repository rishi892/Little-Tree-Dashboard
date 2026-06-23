// Direct test of vendors.js's normalizeKey — does it strip "LLC"?
// We expose the function via a hook so we can call it standalone.

// Reproduce the exact normalizeKey from vendors.js:
const BUSINESS_SUFFIXES = [
  'llc', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'ltd', 'limited', 'lp', 'llp',
  'med', 'rec', 'medical', 'recreational',
  'dispo', 'dispensary', 'cannabis', 'provisions', 'provisioning',
]

function normalizeKey(name) {
  if (!name) return ''
  let s = String(name).trim()
  s = s.replace(/^little\s*trees?[-\s]+/i, '')
  s = s.replace(/^gelato[-\s]+/i, '')
  s = s.replace(/^the\s+/i, '')
  s = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  let changed = true
  while (changed) {
    changed = false
    for (const suf of BUSINESS_SUFFIXES) {
      const re = new RegExp(`\\b${suf}\\b\\s*$`)
      if (re.test(s)) {
        s = s.replace(re, '').trim()
        changed = true
      }
    }
  }
  return s.replace(/\s+/g, '')
}

const tests = [
  'Little Tree- Allstar Processing LLC',
  'Little Tree- All Star Processing LLC',
  'Little Tree- All Star Processing',
  'Little Tree- Allstars',
]

tests.forEach((t) => {
  // Step-by-step trace
  let s = String(t).trim()
  console.log(`\nINPUT:  "${t}"`)
  s = s.replace(/^little\s*trees?[-\s]+/i, '')
  console.log(`  after prefix strip:    "${s}"`)
  s = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  console.log(`  after lowercase+clean: "${s}"`)
  let changed = true
  let iter = 0
  while (changed && iter < 5) {
    changed = false
    for (const suf of BUSINESS_SUFFIXES) {
      const re = new RegExp(`\\b${suf}\\b\\s*$`)
      if (re.test(s)) {
        s = s.replace(re, '').trim()
        console.log(`    stripped "${suf}" → "${s}"`)
        changed = true
      }
    }
    iter++
  }
  console.log(`  FINAL:                 "${s.replace(/\s+/g, '')}"`)
})
