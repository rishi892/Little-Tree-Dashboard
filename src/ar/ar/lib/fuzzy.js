// Lightweight Levenshtein (edit-distance) helper for name-matching.
// Limit-aware: bails out early once distance exceeds the threshold so
// it's cheap to run for thousands of pairs.

function lev(a, b, max = 1) {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length
  if (Math.abs(a.length - b.length) > max) return max + 1

  // Two-row DP, O(min(a, b)) memory
  let prev = new Array(b.length + 1)
  let curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

// "Are these two strings 90%+ the same name?" - conservative fuzzy match.
//
// Requires:
//   • Both strings ≥ 10 chars  (so 1 edit = 90% similar minimum)
//   • Edit distance ≤ floor(maxLen × 0.1)  (≥ 90% characters match)
//
// This skips short names entirely (where 1-char diff often means different
// words) and scales tolerance with length.
export function isSimilar(a, b, opts = {}) {
  const minLen = opts.minLen ?? 10           // default: only fuzzy-match long names
  const minRatio = opts.minRatio ?? 0.9      // default: ≥ 90% character match
  if (!a || !b) return false
  if (a === b) return true
  const minStrLen = Math.min(a.length, b.length)
  const maxStrLen = Math.max(a.length, b.length)
  if (minStrLen < minLen) return false
  // Allowed edits = (1 - minRatio) × longer length, rounded down
  const maxEdits = Math.max(1, Math.floor(maxStrLen * (1 - minRatio)))
  return lev(a, b, maxEdits) <= maxEdits
}

// ===================================================================
// Token-aware confidence scoring (for grouping vendor name variants
// like "All-Stars" with "All-Star Processing"). Returns 0..100.
// ===================================================================

// Words we drop from the comparison - generic business/industry noise
// that doesn't help distinguish one customer from another.
const STOPWORDS = new Set([
  'the', 'and', 'of',
  'llc', 'inc', 'incorporated', 'corp', 'corporation',
  'co', 'company', 'ltd', 'limited', 'lp', 'llp',
  'med', 'rec', 'medical', 'recreational',
  'dispo', 'dispensary', 'cannabis', 'provisions', 'provisioning',
])

// Very-light stemmer: strip trailing "s" / "es" so "stars" and "star"
// match. Only kicks in for 4+ char tokens to avoid collapsing genuinely
// short words.
function stem(t) {
  if (t.length >= 5 && t.endsWith('es')) return t.slice(0, -2)
  if (t.length >= 4 && t.endsWith('s'))  return t.slice(0, -1)
  return t
}

// Split a vendor name into normalized content tokens.
// Strips "Little Tree-" / "Gelato-" / "The" prefixes, lowercases, removes
// non-alphanumerics, drops stopwords, and stems plurals.
export function tokenize(name) {
  if (!name) return []
  let s = String(name).trim()
  s = s.replace(/^little\s*trees?[-\s]+/i, '')
  s = s.replace(/^gelato[-\s]+/i, '')
  s = s.replace(/^the\s+/i, '')
  s = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.split(' ')
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem)
}

// Confidence (0..100) that names A and B refer to the same business.
// Two rules, in priority order:
//
//   1. Prefix-token rule - shorter's tokens appear at the START of longer's
//      in the same order. Catches "All Star" ⇒ "All Star Processing" and
//      "Pleasantrees Houghton" ⇒ "Pleasantrees Houghton Lake" while
//      REJECTING "Dispo Hazel Park" vs "Rush Cannaco Hazel Park" (shared
//      location at the END, not the start).
//
//   2. Edit-distance fallback - for long single-blob typos like
//      "Allstart Processing" ⇒ "Allstar Processing".
//
// Tuned conservatively - only ≥ 90 when very confident.
export function nameConfidence(a, b) {
  if (!a || !b) return 0
  if (a === b) return 100

  const ta = tokenize(a)
  const tb = tokenize(b)
  if (!ta.length || !tb.length) return 0

  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]

  // Rule 1: shorter must be a prefix (in order) of longer, ≥ 2 tokens.
  // The 2-token floor avoids merging single-word brands like
  // "Pleasantrees" with their specific stores ("Pleasantrees Detroit").
  const isPrefix = short.length >= 2 && short.every((t, i) => long[i] === t)
  if (isPrefix) {
    const ratio = short.length / long.length
    if (ratio >= 0.6) return 96
    if (ratio >= 0.4) return 92
    return 90
  }

  // Rule 2: edit-distance on the joined token string. Catches single-char
  // typos in long names where token order doesn't help.
  const ja = ta.join(''), jb = tb.join('')
  const minLen = Math.min(ja.length, jb.length)
  const maxLen = Math.max(ja.length, jb.length)
  if (minLen >= 10) {
    const maxEdits = Math.max(1, Math.floor(maxLen * 0.1))
    const d = lev(ja, jb, maxEdits)
    if (d <= maxEdits) return Math.round((1 - d / maxLen) * 100)
  }

  // Otherwise: report a low informational score (under threshold).
  const sa = new Set(ta), sb = new Set(tb)
  const inter = [...sa].filter((t) => sb.has(t)).length
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : Math.round((inter / union) * 70)
}
