// Vendor name normalization & alias system.
//
// Three layers of merging (most → least specific):
//   1. Explicit aliases (this file)        - for variants that won't auto-merge
//   2. Suffix/prefix stripping + casing    - strips LLC/Inc/Corp/"The"/punctuation
//   3. Confidence (token-aware) fuzzy ≥ 90 - catches typos AND multi-word
//      variants like "All Stars" ↔ "All Star Processing" via token sets
//
// Confidence scorer combines: token-set subset detection, Jaccard overlap,
// and edit-distance fallback for long single-blob typos. Conservative
// thresholds - only auto-merges when ≥ 90% confident.
//
// IMPORTANT: only add to EXPLICIT_ALIASES when the smart matcher *can't*
// figure it out (very different names referring to the same business).

import { nameConfidence } from './fuzzy.js'

const CONFIDENCE_THRESHOLD = 90

const EXPLICIT_ALIASES = {
  // All Star Processing variants that don't auto-normalize together
  'allstarprocessing': 'Little Tree- All Star Processing',
  'allstar': 'Little Tree- All Star Processing',
  'allstar2': 'Little Tree- All Star Processing',
  'allstars': 'Little Tree- All Star Processing', // plural single-token variant
}

// Common business suffixes - stripped before comparing
const BUSINESS_SUFFIXES = [
  'llc', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'ltd', 'limited', 'lp', 'llp',
  // Cannabis-specific noise we want to ignore for grouping
  'med', 'rec', 'medical', 'recreational',
  'dispo', 'dispensary', 'cannabis', 'provisions', 'provisioning',
]

// Strip "Little Tree-", "Gelato-", "The ", and common business suffixes,
// then collapse case & non-alphanumerics.
function normalizeKey(name) {
  if (!name) return ''
  let s = String(name).trim()

  // Remove brand prefixes
  s = s.replace(/^little\s*trees?[-\s]+/i, '')
  s = s.replace(/^gelato[-\s]+/i, '')

  // Drop leading "The "
  s = s.replace(/^the\s+/i, '')

  // Lowercase + strip non-alphanumeric (handles commas, periods, dashes)
  s = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  // Strip trailing business suffixes (repeat in case of stacked "Co LLC")
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

  // Final compaction - alphanumeric only
  return s.replace(/\s+/g, '')
}

// Builds a canonical vendor map from all observed vendor strings.
// - Same-normalized-key variants auto-merge (winner = most frequent original)
// - Near-typo variants (edit distance ≤ 1, both ≥ 5 chars) auto-merge
// - Explicit aliases override everything
export function buildVendorIndex(...vendorLists) {
  const variantCounts = new Map() // normKey → Map(rawString → count)
  vendorLists.forEach((list) => {
    list.forEach((v) => {
      if (!v) return
      const k = normalizeKey(v)
      if (!k) return
      const inner = variantCounts.get(k) || new Map()
      inner.set(v, (inner.get(v) || 0) + 1)
      variantCounts.set(k, inner)
    })
  })

  // Fuzzy-merge using confidence scoring. The scorer needs the original
  // (un-compacted) display name to extract tokens, so we pick the most
  // frequent original raw string as the representative for each group.
  const representative = new Map() // normKey → raw display name (mode)
  variantCounts.forEach((variants, k) => {
    const top = [...variants.entries()].sort((a, b) => b[1] - a[1])[0]
    representative.set(k, top[0])
  })

  // Longest keys first so they "absorb" shorter variants. Exception:
  // when one side has an EXPLICIT_ALIAS and the other doesn't, the
  // aliased key wins (otherwise the alias mapping silently disappears
  // when its key gets folded into an unaliased neighbor).
  const keys = [...variantCounts.keys()].sort((a, b) => b.length - a.length)
  const merged = new Map() // typo-key → canonical-key
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i]
    if (merged.has(a)) continue
    for (let j = i + 1; j < keys.length; j++) {
      const b = keys[j]
      if (merged.has(b)) continue
      if (merged.has(a)) break    // a got consumed earlier in this row
      const score = nameConfidence(representative.get(a), representative.get(b))
      if (score < CONFIDENCE_THRESHOLD) continue
      if (EXPLICIT_ALIASES[b] && !EXPLICIT_ALIASES[a]) {
        merged.set(a, b)          // reverse direction - preserve b's alias
      } else {
        merged.set(b, a)
      }
    }
  }
  // Apply merges
  merged.forEach((target, source) => {
    if (!variantCounts.has(source)) return
    const src = variantCounts.get(source)
    const dst = variantCounts.get(target) || new Map()
    src.forEach((count, raw) => dst.set(raw, (dst.get(raw) || 0) + count))
    variantCounts.set(target, dst)
    variantCounts.delete(source)
  })

  // Pick canonical display per remaining group
  const canonical = new Map() // normKey → canonical display
  variantCounts.forEach((variants, k) => {
    if (EXPLICIT_ALIASES[k]) {
      canonical.set(k, EXPLICIT_ALIASES[k])
      return
    }
    const ranked = [...variants.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1]
      // Prefer Title Case > UPPER > others
      const aTitle = /^[A-Z][a-z]/.test(a[0].replace(/^[a-z]+\s*tree-?\s*/i, ''))
      const bTitle = /^[A-Z][a-z]/.test(b[0].replace(/^[a-z]+\s*tree-?\s*/i, ''))
      if (aTitle !== bTitle) return aTitle ? -1 : 1
      return b[0].length - a[0].length
    })
    canonical.set(k, ranked[0][0].trim())
  })

  // Walk original lists, build raw → canonical lookup
  const lookup = new Map()
  vendorLists.forEach((list) => {
    list.forEach((v) => {
      if (!v) return
      let k = normalizeKey(v)
      // Follow fuzzy merge chain
      while (merged.has(k)) k = merged.get(k)
      const c = canonical.get(k)
      if (c) lookup.set(v, c)
    })
  })

  return lookup
}

// Apply a prebuilt lookup to a single vendor string.
// Falls back to explicit alias or trimmed original if no lookup hit.
export function canonicalVendor(raw, lookup) {
  if (!raw) return ''
  if (lookup && lookup.has(raw)) return lookup.get(raw)
  const k = normalizeKey(raw)
  if (EXPLICIT_ALIASES[k]) return EXPLICIT_ALIASES[k]
  return String(raw).trim()
}
