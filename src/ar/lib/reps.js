// Sales rep name aliasing with smart fuzzy matching.
//
// Future-proof: if a sheet entry has a typo or extra spacing the matcher
// catches it automatically. Add to REP_ALIASES only for hard cases where
// the names don't look alike (e.g. nicknames pointing to different first names).

import { isSimilar } from './fuzzy.js'

// Explicit aliases for hard cases (nicknames / different-looking names).
// Keys are normalized (lowercase, alphanumeric only). Values = canonical display.
const REP_ALIASES = {
  'joey': 'Joe Pekin',
  'joep': 'Joe Pekin',
  'joepekin': 'Joe Pekin',
  'joepicken': 'Joe Pekin', // sheet typo - same rep (was splitting off his oldest invoice)
}

// Known canonical reps - used for fuzzy matching of typo'd new entries.
// As soon as a new name appears in the sheet that closely resembles one of
// these, it will be auto-merged.
const KNOWN_REPS = [
  'Joe Pekin',
  'Manny',
  'Dave',
  'Ken',
  // Add more known reps here as they become regular contributors
]

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

const KNOWN_NORM = KNOWN_REPS.map((r) => ({ raw: r, key: normalize(r) }))

export function canonicalRep(name) {
  if (!name) return ''
  const key = normalize(name)
  if (!key) return ''

  // 1. Explicit alias
  if (REP_ALIASES[key]) return REP_ALIASES[key]

  // 2. Exact match to a known rep
  const exact = KNOWN_NORM.find((r) => r.key === key)
  if (exact) return exact.raw

  // 3. Fuzzy match - only if 90%+ similar (default isSimilar threshold)
  const fuzzy = KNOWN_NORM.find((r) => isSimilar(r.key, key))
  if (fuzzy) return fuzzy.raw

  // 4. No match - return original trimmed
  return String(name).trim()
}
