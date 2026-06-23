// Private-label brands - owned product lines, kept separate from wholesale customer brands.
const PRIVATE_LABELS = [
  'Alien Brainz',
  'Yacht Fuel',
  'Gelato',
  'Funkd Up',
]

const NORMALIZED_PL = new Set(PRIVATE_LABELS.map((b) => normalize(b)))

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isPrivateLabel(brand) {
  return NORMALIZED_PL.has(normalize(brand))
}

// Pure X / white-label book. These accounts are NOT Little Tree retail wholesale
// customers - they're B2B processors / distributors / white-label brands. Two
// signals mark a vendor as white-label:
//   1. a "Gelato-" vendor prefix (Pure X records mis-logged in the LT sheet), or
//   2. membership in the operator-maintained WHITE_LABEL list below (matched by
//      store name with the "Little Tree-" / "Gelato-" prefix stripped, normalized).
// NOTE: the "Pure" customer brand ("Little Tree- Pure …") is a real Little Tree
// retail customer - it is NOT in this list, so it stays in Little Tree.
const wlNorm = (s) => String(s || '')
  .replace(/^\s*l+i+t+t+l+e\s*tree-\s*|^\s*gelato-\s*/i, '') // strip prefix (typo-tolerant)
  .trim().toLowerCase().replace(/[^a-z0-9]/g, '')

const WHITE_LABEL = new Set([
  '4k Processing Inc', '4k Processing Return', 'Alien Brainz', 'All Star Processing LLC',
  'All Star Processing', // data has it without the "LLC" suffix
  'Apothecare Jackson', 'Arborside', 'Berry Green Management', 'Exclusive Distribution',
  'FLWRPot', 'FunkdUp', 'Green Trend', 'High Society 6', 'High Society Big Rapids',
  'High Society Birch Run', 'High Society E Lansing', 'High Society Lenox',
  'High Society Mt Pleasant', 'High Society New Buffalo', 'High Society Lennox', // "Lenox" in list = "Lennox" in data
  'Nirvana Centerline',
  'Nirvana Processing', 'Northcoast Provisions Arborside Adrian',
  'Northcoast Provisions Sault St Marie', 'Pac-Man 222 Companies LLC', 'Plushco',
  'Skymint', 'The Flower Pot', 'Yacht Fuel', 'Wildfire Investments',
].map(wlNorm))

// Pure X book = ONLY the "Gelato-" prefixed records. These are excluded from
// Little Tree everywhere (AR, DSO, Sales) per "remove Gelato data from LT".
export function isPureXVendor(vendor) {
  return /^\s*gelato-/i.test(vendor || '')
}

// White-label accounts (Skymint, High Society, Alien Brainz, …). These ARE still
// Little Tree's receivables - Little Tree bills and collects them, so their
// outstanding STAYS in Little Tree AR. This flag only tags them for the white-
// label / Pure X analytics view; it does NOT remove them from Little Tree AR.
export function isWhiteLabelVendor(vendor) {
  if (/^\s*gelato-/i.test(vendor || '')) return true
  return WHITE_LABEL.has(wlNorm(vendor))
}
export const _wlNorm = wlNorm // exported for the coverage diagnostic

// AR policy: outstanding amounts below this threshold are not chased
const AR_MIN_AMOUNT = 100

// True if an invoice should be considered "in AR scope" (wholesale, and
// outstanding amount >= the minimum threshold - small balances are ignored).
export function isInAr(invoice, vendorBrand) {
  if (isPrivateLabel(vendorBrand || invoice.brand)) return false
  if (isPureXVendor(invoice.vendor)) return false
  if (invoice.isOutstanding && invoice.outstanding < AR_MIN_AMOUNT) return false
  return true
}
