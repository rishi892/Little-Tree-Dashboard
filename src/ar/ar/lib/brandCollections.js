// Infused Origin (special category) - monthly COLLECTIONS per brand.
//
// "Collections" = the dated "Amount received" entries on each brand's tracking
// sheet, grouped by the month the money actually came in. Each brand/year reads
// from a specific tab; 2025 comes from the 2025 workbook and 2026 from the 2026
// workbook, and we keep only that year's receipts from each tab so the two never
// double-count (e.g. a 2025 production paid in March 2026 lands in the 2026
// series). Off-cycle adjustments are intentionally excluded for now.
//
// The tabs are NOT uniform: Gelato 2025 keeps receipts in a right-hand block
// (date col 8, amount col 10); the other tabs are flat DATE/VENDOR/AMOUNT
// ledgers; Funkd Up is an invoice tracker (Invoice Paid dated by Date Paid).

import Papa from 'papaparse'

const WB_2025 = '1e6WDubpi3An55Y0wkkVV8v0v3n43XaNkbFldod1qHks'
const WB_2026 = '1SZ4pi6w_xzS-NvOwq11VTy7MQKDgfZMUqH8vWErdUbA'

export const COLLECTION_BRANDS = [
  { key: 'gelato', label: 'Gelato', color: '#15803d' },
  { key: 'alien', label: 'Alien Brainz', color: '#7c3aed' },
  { key: 'yacht', label: 'Yacht Fuel', color: '#0ea5e9' },
  { key: 'funkd', label: 'Funkd Up', color: '#f97316' },
]

// brand + which tab feeds which year. 2025 from the 2025 workbook, 2026 from the
// 2026 workbook. Yacht Fuel + Funkd Up have no 2026 data.
const SOURCES = [
  { brand: 'gelato', wb: WB_2025, gid: '328498135',  year: 2025 },
  { brand: 'gelato', wb: WB_2026, gid: '2018342224', year: 2026 },
  { brand: 'alien',  wb: WB_2025, gid: '1617505078', year: 2025 },
  { brand: 'alien',  wb: WB_2026, gid: '966704225',  year: 2026 },
  { brand: 'yacht',  wb: WB_2025, gid: '99579024',   year: 2025 },
  { brand: 'funkd',  wb: WB_2025, gid: '1764972174', year: 2025 },
]

function csvUrl(wb, gid) {
  return `https://docs.google.com/spreadsheets/d/${wb}/export?format=csv&gid=${gid}`
}

async function fetchRows(wb, gid) {
  const res = await fetch(csvUrl(wb, gid), { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return new Promise((resolve, reject) => {
    Papa.parse(text, { header: false, skipEmptyLines: false, complete: (r) => resolve(r.data), error: reject })
  })
}

function parseMoney(s) {
  let t = String(s ?? '').trim()
  if (!t || t === '-') return 0
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-\s*\$/.test(t)
  t = t.replace(/[$,()\s]/g, '').replace(/-/g, '')
  const n = Number(t)
  return Number.isFinite(n) ? (neg ? -n : n) : 0
}

// Every brand tab carries a monthly summary box: a "Jan Feb ... Dec" header row
// followed a few rows later by an "Amount received till date" row holding the 12
// monthly figures. That row (NOT the raw receipt ledger) is the source of truth -
// it already isolates real collections from misc ledger entries (Motas checks,
// bank fees, transfers, etc.). We read those 12 cells for the sheet's year.
function parseAmountReceivedBox(rows, year) {
  // 1. Find the month-header row (so we skip any stray single-cell totals above).
  let hdr = -1
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map((c) => String(c).trim().toLowerCase())
    if (cells.includes('jan') && cells.includes('feb') && cells.includes('dec')) { hdr = i; break }
  }
  if (hdr < 0) return []
  // 2. Find the "Amount received till date" row just below it; values follow the label.
  let labelRow = -1, L = -1
  for (let i = hdr + 1; i < Math.min(rows.length, hdr + 10); i++) {
    const idx = (rows[i] || []).findIndex((c) => /amount\s*received\s*till\s*date/i.test(String(c)))
    if (idx >= 0) { labelRow = i; L = idx; break }
  }
  if (labelRow < 0) return []
  // 3. Read the 12 monthly cells immediately after the label (Jan..Dec).
  const out = []
  for (let m = 1; m <= 12; m++) {
    const amt = parseMoney(rows[labelRow][L + m])
    if (amt) out.push({ y: year, key: `${year}-${String(m).padStart(2, '0')}`, amt })
  }
  return out
}

// Latest "Closing Balance" from the same box = amount still owed (yet to be
// received). Returns the last non-empty of the 12 monthly cells, or null.
function parseClosingBalance(rows) {
  let hdr = -1
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map((c) => String(c).trim().toLowerCase())
    if (cells.includes('jan') && cells.includes('feb') && cells.includes('dec')) { hdr = i; break }
  }
  if (hdr < 0) return null
  let labelRow = -1, L = -1
  for (let i = hdr + 1; i < Math.min(rows.length, hdr + 12); i++) {
    const idx = (rows[i] || []).findIndex((c) => /closing\s*balance/i.test(String(c)))
    if (idx >= 0) { labelRow = i; L = idx; break }
  }
  if (labelRow < 0) return null
  let last = null
  for (let m = 1; m <= 12; m++) {
    const cell = String(rows[labelRow][L + m] ?? '').trim()
    if (cell !== '') last = parseMoney(cell)
  }
  return last
}

// Continuous list of 'YYYY-MM' keys spanning the earliest..latest month seen.
function monthRange(keys) {
  if (!keys.length) return []
  const sorted = [...keys].sort()
  let [y, m] = sorted[0].split('-').map(Number)
  const [ey, em] = sorted[sorted.length - 1].split('-').map(Number)
  const out = []
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  return out
}

// Fetches every brand tab, returns { chartData, brands, totals }.
// chartData: [{ key:'YYYY-MM', gelato, alien, yacht, funkd }], null where no data.
export async function loadBrandCollections() {
  const results = await Promise.all(SOURCES.map(async (s) => {
    try {
      const rows = await fetchRows(s.wb, s.gid)
      return { brand: s.brand, year: s.year, recs: parseAmountReceivedBox(rows, s.year), closing: parseClosingBalance(rows) }
    } catch (e) {
      console.error('[brandCollections]', s.brand, s.year, e && e.message)
      return { brand: s.brand, year: s.year, recs: [], closing: null, failed: true }
    }
  }))

  const byBrand = {}
  const seen = new Set()
  for (const r of results) {
    const bucket = byBrand[r.brand] || (byBrand[r.brand] = {})
    for (const rec of r.recs) {
      bucket[rec.key] = (bucket[rec.key] || 0) + rec.amt
      seen.add(rec.key)
    }
  }

  const months = monthRange([...seen])
  const chartData = months.map((key) => {
    const row = { key }
    for (const b of COLLECTION_BRANDS) row[b.key] = byBrand[b.key]?.[key] ?? null
    return row
  })
  const totals = {}
  // Amount yet to be received = latest closing balance: pick each brand's
  // highest-year source that has a closing balance.
  const yetToReceive = {}
  for (const b of COLLECTION_BRANDS) {
    totals[b.key] = Object.values(byBrand[b.key] || {}).reduce((s, v) => s + v, 0)
    const latest = results
      .filter((r) => r.brand === b.key && r.closing != null)
      .sort((a, c) => c.year - a.year)[0]
    yetToReceive[b.key] = latest ? latest.closing : null
  }
  return { chartData, brands: COLLECTION_BRANDS, totals, yetToReceive }
}
