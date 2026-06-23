import Papa from 'papaparse'
import { canonicalRep } from './reps.js'
import { buildVendorIndex, canonicalVendor } from './vendors.js'
import { nameConfidence } from './fuzzy.js'

// Open balances of $100 or less are treated as settled - not counted as
// outstanding anywhere in the dashboard (aging, 180+ overdue, defaulters, open
// AR, uncollectable, etc.). Trivial leftover balances aren't worth chasing.
export const MIN_OUTSTANDING = 100


const SHEETS = {
  invoices: 'https://docs.google.com/spreadsheets/d/1hcxz0jxBKIvoMSYrluxOYfBf3hOa4cXEIpqvaRtt-fI/export?format=csv&gid=0',
  financials: 'https://docs.google.com/spreadsheets/d/1FhKkWXxXlsD-YV4JqC817jc6nyrW2bSwmUWkJFc8Wes/export?format=csv&gid=0',
    gelato: 'https://docs.google.com/spreadsheets/d/12Ql1knwLc8BLarffTirH8II_lgSkpuFB0nad82K5JeE/export?format=csv&gid=1025747160',
  customers: 'https://docs.google.com/spreadsheets/d/15XztfUmjiPbfh-ublCPZAVpA6MrCumytbOmhbzfGIUg/export?format=csv&gid=1813610735',
  gelatoSales: 'https://docs.google.com/spreadsheets/d/15XztfUmjiPbfh-ublCPZAVpA6MrCumytbOmhbzfGIUg/export?format=csv&gid=110864354',
  alienSales:  'https://docs.google.com/spreadsheets/d/15XztfUmjiPbfh-ublCPZAVpA6MrCumytbOmhbzfGIUg/export?format=csv&gid=2089690658',
  yachtSales:  'https://docs.google.com/spreadsheets/d/15XztfUmjiPbfh-ublCPZAVpA6MrCumytbOmhbzfGIUg/export?format=csv&gid=2036957944',
  funkdSales:  'https://docs.google.com/spreadsheets/d/15XztfUmjiPbfh-ublCPZAVpA6MrCumytbOmhbzfGIUg/export?format=csv&gid=2009621541',
}

const MONTH_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
const MONTH_LONG  = ['january','february','march','april','may','june','july','august','september','october','november','december']

// ---------- Parsers ----------

function parseMoney(v) {
  if (v == null) return 0
  if (typeof v === 'number') return v
  const s = String(v).trim()
  if (!s || s === '-') return 0
  // strip $, commas, spaces; keep negative sign
  const n = parseFloat(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

// Fuzzy fix for typo'd years in date strings.
// Handles patterns seen in the actual sheet: "0203" → 2023, "0206" → 2026,
// "203" → 2023, "206" → 2026. Falls back to an anchor year (e.g. the paid
// date's year) when the heuristic can't decide.
function fuzzyFixYear(y, anchorYear) {
  if (y >= 2000 && y <= 2100) return y // already valid
  if (y < 100) return 2000 + y         // 2-digit shortcut (e.g. 23 → 2023)

  // 3-digit years like 203, 206 (often from "0203" / "0206" typos in source)
  // Interpretation: the middle "0" is stray, last digit is the year-in-decade
  // for the 2020s. 203 → 2023, 206 → 2026, 209 → 2029.
  if (y >= 200 && y <= 299) {
    const middle = Math.floor(y / 10) % 10
    const last = y % 10
    if (middle === 0) return 2020 + last
    // "2YY" interpreted as 20YY directly (e.g. 213 → 2013)
    return 2000 + (y - 200)
  }

  // Last resort - use the anchor year if we have one
  if (anchorYear && anchorYear >= 2000 && anchorYear <= 2100) return anchorYear
  return y // give up, return as-is (will produce a far-past Date)
}

function parseDate(v, opts = {}) {
  if (!v) return null
  const s = String(v).trim()
  if (!s || s.toUpperCase() === 'VOID') return null

  // "DD MMM YYYY" or "DD Month YYYY" (Gelato sheet format, e.g. "07 May 2026")
  const dmy = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{1,4})$/)
  if (dmy) {
    const day = parseInt(dmy[1], 10)
    const mname = dmy[2].toLowerCase()
    let year = parseInt(dmy[3], 10)
    let monthIdx = MONTH_SHORT.indexOf(mname.slice(0, 3))
    if (monthIdx < 0) monthIdx = MONTH_LONG.indexOf(mname)
    if (monthIdx >= 0 && day >= 1 && day <= 31) {
      year = fuzzyFixYear(year, opts.anchorYear)
      const dt = new Date(year, monthIdx, day)
      return isNaN(dt) ? null : dt
    }
  }

  // M/D/YYYY or M/D/YY (main sheet format, sometimes with stray leading zeros)
  const parts = s.split(/[\/\-]/)
  if (parts.length === 3) {
    let [m, d, y] = parts.map((p) => parseInt(p, 10))
    if (!Number.isFinite(m) || !Number.isFinite(d) || !Number.isFinite(y)) return null
    y = fuzzyFixYear(y, opts.anchorYear)
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const dt = new Date(y, m - 1, d)
      return isNaN(dt) ? null : dt
    }
  }
  const dt = new Date(s)
  return isNaN(dt) ? null : dt
}

function daysBetween(a, b) {
  if (!a || !b) return null
  return Math.floor((b - a) / (1000 * 60 * 60 * 24))
}

// Aging buckets by DAYS PAST DUE (today − due date). Due date = the sheet's Due
// Date, or invoice date + 30 (Net 30) when it's blank. NOT days since invoice.
//   Current  = not yet due (due date is today or in the future)
//   1–30 … 121–180 = that many days PAST the due date
//   180+     = more than 180 days past due (very stale)
function agingBucket(daysOverdue) {
  if (daysOverdue == null) return 'Unknown'
  if (daysOverdue <= 0) return 'Current'
  if (daysOverdue <= 30) return '1–30'
  if (daysOverdue <= 60) return '31–60'
  if (daysOverdue <= 90) return '61–90'
  if (daysOverdue <= 120) return '91–120'
  if (daysOverdue <= 180) return '121–180'
  return '180+'
}

// ---------- Fetch + parse ----------

async function fetchCsv(url, opts = {}) {
  // 30s timeout so a stuck request fails fast instead of hanging forever
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  let text
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
    text = await res.text()
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout (30s) fetching ${url}`)
    throw new Error(`${e.message} (${url})`)
  } finally {
    clearTimeout(timer)
  }
  return new Promise((resolve, reject) => {
    Papa.parse(text, {
      header: opts.header || false,
      skipEmptyLines: 'greedy',
      complete: (r) => resolve(r.data),
      error: reject,
    })
  })
}

// Find the header row (the row that contains "Inv #")
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i].some((c) => String(c).trim().toLowerCase() === 'inv #')) {
      return i
    }
  }
  return 0
}

function rowsToObjects(rows) {
  const headerIdx = findHeader(rows)
  const headers = rows[headerIdx].map((h) => String(h).trim())
  return rows.slice(headerIdx + 1).map((r) => {
    const obj = {}
    headers.forEach((h, i) => { obj[h] = r[i] ?? '' })
    return obj
  })
}

// ---------- Normalizers ----------
// Manual paid-date corrections. The invoice tracker has typo'd "Paid Y/N" dates
// for these invoices; we override with the known-correct date so DSO and aging
// compute correctly. Keyed by Inv #. Format: M/D/YYYY.
const PAID_DATE_OVERRIDES = {
  '11462a': '10/20/2025', // tracker logs 10/20/2022 (wrong year)
  '13205a': '4/16/2026',  // tracker logs 4/15/2026 (day before invoice)
  // Marked "Paid" (Money Owed $0) in the tracker but the paid-date cell was left
  // blank - without a paid date, DSO counts them as still open at current age,
  // inflating it. Paid dates supplied by operator.
  '9064a':  '11/27/2024',
  '10071a': '3/21/2025',
  '11382a': '10/6/2025',
  '11747a': '2/10/2026',
  '12652a': '2/6/2026',
}

// Invoices to drop from the AR dashboard entirely - never counted in any table,
// KPI, chart, or DSO. Use for returned / voided rows the operator wants ignored.
const EXCLUDED_INVOICES = new Set([
  '12687a', // Dank Headquarters - returned, "Don't follow up"
])

// Financials "Invoice Paid" overrides. The sales sheet sometimes lags the AR
// tracker - a fully-paid invoice whose Invoice Paid cell is still blank - which
// overstates that customer's outstanding (invoiced − paid) in the Customers tab.
// 'full' = treat as paid in full; a number = that exact paid amount. Keyed by Inv #.
const FIN_PAID_OVERRIDES = {
  '13340a': 'full', // Rize Iron Mountain - paid 6/4/2026 per AR tracker; financials Invoice Paid cell is blank
  '12959a': 'full', // Happy Daze - treated as paid (matches AR tracker's "Paid" status); sales sheet shows it part-paid
}

// Customer master-list sales-rep overrides - applied when the sheet can't be
// edited directly. Keyed by customer name (case-insensitive).
const CUSTOMER_REP_OVERRIDES = {
  'allstar2': 'Johan', // sheet has a blank Sales Rep for this account
}

function normalizeInvoice(r, today) {
  const invNo = String(r['Inv #'] || '').trim()
  const invoiceAmount = parseMoney(r['Invoice Amount'])
  const invoicePaid = parseMoney(r['Invoice Paid'])
  const moneyOwed = parseMoney(r['Money Owed'])
  // Parse paid date first; its year anchors fuzzy fixes for typo'd invoice/due dates.
  // Apply a manual override when the tracker's paid date is known to be wrong.
  const paidDate = PAID_DATE_OVERRIDES[invNo]
    ? parseDate(PAID_DATE_OVERRIDES[invNo])
    : parseDate(r['Paid Y/N'])

  const anchorYear = paidDate ? paidDate.getFullYear() : null
  const date = parseDate(r['Date'], { anchorYear })
  const parsedDue = parseDate(r['Due Date'], { anchorYear })
  // Net 30 fallback: if operator left Due Date blank in the sheet, assume
  // the default wholesale terms (invoice date + 30 days). Without this,
  // 35+ recent invoices would otherwise land in an 'Unknown' bucket.
  let dueDate = parsedDue
  let dueDateDefaulted = false
  if (!dueDate && date) {
    dueDate = new Date(date)
    dueDate.setDate(dueDate.getDate() + 30)
    dueDateDefaulted = true
  }
  const status = (r['Status'] || '').trim()
  const statusLower = status.toLowerCase()
  const isPaid = statusLower === 'paid' || (invoicePaid >= invoiceAmount && invoiceAmount > 0 && moneyOwed === 0)
  const isWriteOff = statusLower.includes('write')
  const isCollection = statusLower.includes('collection')
  const daysOverdue = dueDate ? daysBetween(dueDate, today) : null
  const outstanding = moneyOwed > 0 ? moneyOwed : (isPaid ? 0 : Math.max(0, invoiceAmount - invoicePaid))

  return {
    invNo,
    date,
    vendor: (r['VENDOR'] || '').trim(),
    invoiceAmount,
    invoicePaid,
    moneyOwed,
    pureFee: parseMoney(r['PURE X FEE']),
    // QB customer portal URL (if operator pasted one into the Link column).
    // Many cells use a HYPERLINK formula whose URL is stripped on CSV export
    // (display text wins); we use only values that look like real URLs.
    qbLink: (() => {
      const v = (r['Link'] || '').trim()
      return /^https?:\/\//i.test(v) ? v : ''
    })(),
    status,
    isPaid,
    isWriteOff,
    isCollection,
    isOutstanding: !isPaid && !isWriteOff && outstanding > MIN_OUTSTANDING,
    qbStatus: (r['Status on QB'] || '').trim(),
      salesRep: (date && date.getFullYear() === 2023) ? '' : canonicalRep(r['Sales Rep']),
    brand: (r['Brand'] || '').trim(),
    email: (r['Email'] || '').trim(),
    contactNumber: (r['Contact Number'] || '').trim(),
    daysOutstanding: parseInt(r['Days Outstanding from Inv Date'], 10) || null,
    agingBucketRaw: (r['Aging Bucket'] || '').trim(),
    dueDate,
    dueDateDefaulted,
    daysOverdue,
    agingBucket: agingBucket(daysOverdue),
    followUpStatus: (r['Follow Up Status'] || '').trim(),
    lastFollowUp: (r['Last Follow Up Email'] || '').trim(),
    arComment: (r['AR Comments'] || '').trim(),
    paidDate,
    outstanding,
    collectionsAgency: (r['Collections Agency'] || '').trim(),
  }
}

function normalizeGelato(r, today) {
  const invoiceAmount = parseMoney(r['Invoice Amount'])
  const invoicePaid = parseMoney(r['Amount Paid'])
  const moneyOwed = parseMoney(r['Money Owed'])
  const paidDate = parseDate(r['Payment Date'])
  const anchorYear = paidDate ? paidDate.getFullYear() : null
  const date = parseDate(r['Date'], { anchorYear })
  const parsedDue = parseDate(r['D'], { anchorYear }) // "D" column is the due date
  // Net 30 fallback (same rule as wholesale): if Due Date blank, assume issue date + 30
  let dueDate = parsedDue
  let dueDateDefaulted = false
  if (!dueDate && date) {
    dueDate = new Date(date)
    dueDate.setDate(dueDate.getDate() + 30)
    dueDateDefaulted = true
  }

  const status = (r['Status'] || '').trim()
  const sLow = status.toLowerCase()
  const isPaid = sLow === 'paid'
  const isWriteOff = sLow.includes('write') || sLow.includes('credit adj')
  const isCollection = sLow.includes('collection')

  const outstanding = moneyOwed > 0
    ? moneyOwed
    : (isPaid ? 0 : Math.max(0, invoiceAmount - invoicePaid))

  const daysOverdue = dueDate ? Math.floor((today - dueDate) / 86400000) : null

  return {
    invNo: String(r['Invoice #'] || '').trim(),
    date,
    vendor: (r['Vendor'] || '').trim(),
    invoiceAmount,
    invoicePaid,
    moneyOwed,
    pureFee: 0,
    status,
    isPaid,
    isWriteOff,
    isCollection,
    isOutstanding: !isPaid && !isWriteOff && outstanding > MIN_OUTSTANDING,
    qbStatus: '',
    salesRep: '', // Gelato sheet has no sales rep column
    brand: 'Gelato',
    email: (r['Email'] || '').trim(),
    contactNumber: (r['Phone Number'] || '').trim(),
    daysOutstanding: date ? Math.floor((today - date) / 86400000) : null,
    agingBucketRaw: (r['Follow up status as on date'] || '').trim(),
    dueDate,
    dueDateDefaulted,
    daysOverdue,
    agingBucket: agingBucket(daysOverdue),
    followUpStatus: (r['Follow up status as on date'] || '').trim(),
    lastFollowUp: (r['Last followup email'] || '').trim(),
    arComment: (r['AR comments'] || r['Comment'] || '').trim(),
    paidDate,
    outstanding,
    collectionsAgency: '',
  }
}

function normalizeFinancial(r) {
  const invNo = String(r['Inv #'] || '').trim()
  const amt = parseMoney(r['Invoice Amount'])
  let paid = parseMoney(r['Invoice Paid'])
  const paidOv = FIN_PAID_OVERRIDES[invNo]
  if (paidOv === 'full') paid = amt
  else if (typeof paidOv === 'number') paid = paidOv
  const paidDate = parseDate(r['Paid Y/N'])
  const anchorYear = paidDate ? paidDate.getFullYear() : null
  return {
    invNo,
    date: parseDate(r['DATE'] || r['Date'], { anchorYear }),
    vendor: (r['VENDOR'] || '').trim(),
    qty: parseMoney(r['QTY']),
    invoiceAmount: amt,
    invoicePaid: paid,
    paidDate,
    pureFee: parseMoney(r['PURE X FEE']),
    balance: amt - paid,
  }
}

// ---------- Customer-list private-label resolver ----------

// Normalize a customer/vendor name for matching: strip "Little Tree-"/"Gelato-"
// prefix, lowercase, alphanumeric only.
const custNorm = (s) => String(s || '')
  .replace(/^\s*l+i+t+t+l+e\s*tree+s?[-\s]*|^\s*gelato[-\s]*/i, '')
  .trim().toLowerCase().replace(/[^a-z0-9]/g, '')
const stripVendorPrefix = (v) => String(v || '')
  .replace(/^\s*l+i+t+t+l+e\s*tree+s?[-\s]*|^\s*gelato[-\s]*/i, '')

// Resolve each distinct vendor → private-label?, by matching its name to the
// operator's customer list: exact normalized match first, then fuzzy (>=90%
// confidence, catches spelling variants like "alien brains"). Unmatched = false.
// Edit distance - lets us tolerate a spelling typo within a single word.
function lev(a, b) {
  const m = a.length, n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[m][n]
}
const sigTokens = (s) => String(s || '')
  .replace(/^\s*(little\s*tree|gelato)[-\s]*/i, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length >= 3)
// Same store despite typos: the shorter name has >=3 real words, each within edit
// distance 1 of a word in the longer name. The >=3 rule stops generic 2-word names
// (e.g. "High Society 6") from matching every store.
function tokenSameStore(v, c) {
  const A = sigTokens(v), B = sigTokens(c)
  const [s, l] = A.length <= B.length ? [A, B] : [B, A]
  if (s.length < 3) return false
  return s.every((t) => l.some((u) => t === u || lev(t, u) <= 1))
}
// Vendors that share words with a private-label customer but are a DIFFERENT business.
const PL_MATCH_EXCLUDE = new Set(['greenberrymanagement'])

function buildVendorPrivateLabel(customers, vendors) {
  const exact = new Map(customers.map((c) => [custNorm(c.name), c.privateLabel]))
  const plCustomers = customers.filter((c) => c.privateLabel)
  const out = new Map()
  for (const v of vendors) {
    const k = custNorm(v)
    if (exact.has(k)) { out.set(v, exact.get(k)); continue }
    const vn = stripVendorPrefix(v)
    let best = 0, bestPL = false
    for (const c of customers) {
      const s = nameConfidence(vn, c.name)
      if (s > best) { best = s; bestPL = c.privateLabel }
    }
    if (best >= 90) { out.set(v, bestPL); continue }
    // Spelling-typo fallback - only ever flags private-label, never for excluded names.
    if (!PL_MATCH_EXCLUDE.has(k) && plCustomers.some((c) => tokenSameStore(vn, c.name))) {
      out.set(v, true); continue
    }
    out.set(v, false)
  }
  return out
}

// Map each vendor → brand from the customer master list (same matching as
// buildVendorPrivateLabel). Returns Map(vendor → brand string).
function buildVendorBrand(customers, vendors) {
  const exact = new Map(customers.map((c) => [custNorm(c.name), c.brand || '']))
  const out = new Map()
  for (const v of vendors) {
    const k = custNorm(v)
    if (exact.has(k) && exact.get(k)) { out.set(v, exact.get(k)); continue }
    const vn = stripVendorPrefix(v)
    let best = 0, bestBrand = ''
    for (const c of customers) {
      if (!c.brand) continue
      const s = nameConfidence(vn, c.name)
      if (s > best) { best = s; bestBrand = c.brand }
    }
    out.set(v, best >= 90 ? bestBrand : '')
  }
  return out
}


// ---------- Private Label 1 brand-sales parsers ----------


const moKey = (v) => { const d = parseDate(v); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : null }
const YACHT_RATES = { 'og gummies': 0.65, 'sunken treasures': 1.75 }
// Source rows that don't name a SKU ("Blank"/empty) are OG Gummies per operator.
const YACHT_DEFAULT_SKU = 'og gummies'
function yachtSku(raw) {
  const s = String(raw || '').trim().toLowerCase()
  return (!s || s === 'blank') ? YACHT_DEFAULT_SKU : s
}

const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
function monthSort(label) {
  const s = String(label || '').trim().toLowerCase()
  const ym = s.match(/^(\d{4})-(\d{2})$/); if (ym) return `${ym[1]}-${ym[2]}`
  const yr = (s.match(/\b(20\d{2})\b/) || [])[1]
  const mo = Object.keys(MON3).find((k) => s.includes(k))
  if (yr && mo) return `${yr}-${String(MON3[mo]).padStart(2, '0')}`
  if (yr) return `${yr}-00`
  return 'zzzz'
}
function brand(monthly) {
  const list = [...monthly]
    .map((m) => ({ ...m, key: monthSort(m.month) }))
    .sort((a, b) => a.key.localeCompare(b.key))
  return { total: list.reduce((s, m) => s + m.sales, 0), monthly: list }
}

// Gelato Sales Final: Year | Month | Amount | Status (amount already computed)
function parseGelatoSales(rows) {
  const out = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || (!r[0] && !r[1])) continue
    out.push({ month: `${String(r[0] || '').trim()} ${String(r[1] || '').trim()}`.trim(), sales: parseMoney(r[2]), units: 0, rows: [] })
  }
  return brand(out)
}
// Alien Brainz: header row has "QTY" (col D); DATE col B; sales = qty × 0.6
function parseAlienSales(rows) {
  const hi = rows.findIndex((r) => r.map((c) => String(c).trim()).includes('QTY'))
  const m = new Map()
  for (let i = (hi < 0 ? 1 : hi + 1); i < rows.length; i++) {
    const r = rows[i]; const qty = parseMoney(r[3]); if (!qty) continue
    const k = moKey(r[1]) || 'Unknown'
    const sales = qty * 0.6
    const cur = m.get(k) || { month: k, units: 0, sales: 0, rows: [] }
    cur.units += qty; cur.sales += sales
    cur.rows.push({ label: String(r[2] || '').trim(), date: String(r[1] || '').trim(), units: qty, sales })
    m.set(k, cur)
  }
  return brand([...m.values()])
}
// Yacht Fuel: month col A; SKU/qty in M+N and Q+R; rate by SKU; ignore Blank/empty
function parseYachtSales(rows) {
  const m = new Map()
  for (const r of rows) {
    const mon = String(r[0] || '').trim(); if (!/\d{4}/.test(mon)) continue
    // Two SKU slots per row: (SKU, units) at 12/13 and (SKU #2, units #2) at 16/17.
    const slots = []
    for (const [si, qi] of [[12, 13], [16, 17]]) {
      const q = parseMoney(r[qi]); if (!q) continue // empty/zero slot adds nothing
      slots.push({ sku: yachtSku(r[si]), units: q })
    }
    // Some rows duplicate the same SKU+units into slot #2 (e.g. Oct 2025 inv
    // 11794a: Sunken Treasures 50194 in BOTH slots) - count it once. Legit
    // two-SKU rows differ between slots, so only drop an exact duplicate.
    if (slots.length === 2 && slots[0].sku === slots[1].sku && slots[0].units === slots[1].units) {
      slots.pop()
    }
    let units = 0, sales = 0
    for (const sl of slots) {
      const rate = YACHT_RATES[sl.sku]; if (!rate) continue
      units += sl.units; sales += sl.units * rate
    }
    if (!units && !sales) continue
    const cur = m.get(mon) || { month: mon, units: 0, sales: 0, rows: [] }
    cur.units += units; cur.sales += sales
    cur.rows.push({ label: String(r[3] || '').trim(), date: String(r[2] || '').trim(), units, sales })
    m.set(mon, cur)
  }
  return brand([...m.values()])
}
// Funkd Up: date col B; qty col D; sales = qty × 0.65
function parseFunkdSales(rows) {
  const m = new Map()
  for (const r of rows) {
    const k = moKey(r[1]); const qty = parseMoney(r[3]); if (!k || !qty) continue
    const sales = qty * 0.65
    const cur = m.get(k) || { month: k, units: 0, sales: 0, rows: [] }
    cur.units += qty; cur.sales += sales
      cur.rows.push({ label: String(r[2] || '').trim(), date: String(r[1] || '').trim(), units: qty, sales })
    m.set(k, cur)
  }
  return brand([...m.values()])
}

// ---------- Public API ----------

// Ignore anything dated before this year across the whole dashboard - 2022 and
// earlier is stale / written off / out of scope. Undated rows are kept (a blank
// date isn't "before 2023").
const MIN_DATA_YEAR = 2023

export async function loadAll() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

    const [invRaw, finRaw, gelRaw, custRaw, gelSalesRaw, alienRaw, yachtRaw, funkdRaw] = await Promise.all([
    fetchCsv(SHEETS.invoices),
    fetchCsv(SHEETS.financials),
    fetchCsv(SHEETS.gelato, { header: true }),
    fetchCsv(SHEETS.customers, { header: true }),
    fetchCsv(SHEETS.gelatoSales),
    fetchCsv(SHEETS.alienSales),
    fetchCsv(SHEETS.yachtSales),
    fetchCsv(SHEETS.funkdSales),
  ])

  const invoices = rowsToObjects(invRaw)
    .map((r) => normalizeInvoice(r, today))
    .filter((r) => r.invNo)
    .filter((r) => r.invoiceAmount !== 0)
    .filter((r) => !EXCLUDED_INVOICES.has(r.invNo))
    .filter((r) => !r.date || r.date.getFullYear() >= MIN_DATA_YEAR)

  const financials = rowsToObjects(finRaw)
    .map(normalizeFinancial)
    .filter((r) => r.invNo)
    .filter((r) => !EXCLUDED_INVOICES.has(r.invNo))
    .filter((r) => !r.date || r.date.getFullYear() >= MIN_DATA_YEAR)

    const gelato = gelRaw
    .map((r) => normalizeGelato(r, today))
    .filter((r) => r.invNo)
    .filter((r) => !r.date || r.date.getFullYear() >= MIN_DATA_YEAR)

  // Operator-maintained customer list (Customer Name + Private Label checkbox).
  const customers = custRaw
    .map((r) => {
      const name = String(r['Customer Name'] || '').trim()
      return {
        name,
        privateLabel: /^\s*(true|yes|1|x|✓)\s*$/i.test(String(r['Private Label'] || '')),
        firstOrder: String(r['First Order Date'] || '').trim(),
        lastOrder: String(r['Last Order Date'] || '').trim(),
        totalRevenue: parseMoney(r['Total Revenue']),
        brand: String(r['Brand'] || '').trim(),
        salesRep: CUSTOMER_REP_OVERRIDES[name.toLowerCase()] || String(r['Sales Rep'] || '').trim(),
      }
    })

    .filter((c) => c.name)

  // Canonicalize Little Tree (invoice tracker + financials) SEPARATELY from the
  // Gelato book. A store that appears in both sheets keeps its Little Tree
  // identity in LT data - the Gelato sheet's "Gelato-" prefix is never injected
  // into invoice/financial vendors. So Pure-X/white-label is no longer assigned
  // from a borrowed prefix; LT records are classified by their Brand column.
  const ltIndex = buildVendorIndex(
    invoices.map((r) => r.vendor),
    financials.map((r) => r.vendor),
  )
  const gelatoIndex = buildVendorIndex(gelato.map((r) => r.vendor))
  invoices.forEach((r) => { r.vendor = canonicalVendor(r.vendor, ltIndex) })
  financials.forEach((r) => { r.vendor = canonicalVendor(r.vendor, ltIndex) })
  gelato.forEach((r) => { r.vendor = canonicalVendor(r.vendor, gelatoIndex) })

     const vendorPrivateLabel = buildVendorPrivateLabel(
    customers,
    [...new Set([...invoices, ...financials].map((r) => r.vendor).filter(Boolean))],
  )
  // Tag invoices AND financials with the customer-list private-label flag so both
  // AR and Sales views can read r.isPrivateLabelCustomer directly.
  invoices.forEach((r) => { r.isPrivateLabelCustomer = vendorPrivateLabel.get(r.vendor) || false })
  financials.forEach((r) => { r.isPrivateLabelCustomer = vendorPrivateLabel.get(r.vendor) || false })

  // Map each vendor → brand from the customer master list, so detail views can
  // group invoices by brand. Falls back to '' (shown as "No brand").
  const vendorBrand = buildVendorBrand(
    customers,
    [...new Set([...invoices, ...financials].map((r) => r.vendor).filter(Boolean))],
  )
  invoices.forEach((r) => { r.masterBrand = vendorBrand.get(r.vendor) || r.brand || '' })
  financials.forEach((r) => { r.masterBrand = vendorBrand.get(r.vendor) || r.brand || '' })



   const pl1 = {
    gelato: parseGelatoSales(gelSalesRaw),
    alien: parseAlienSales(alienRaw),
    yacht: parseYachtSales(yachtRaw),
    funkd: parseFunkdSales(funkdRaw),
  }

  return { invoices, financials, gelato, customers, vendorPrivateLabel, pl1, fetchedAt: new Date() }
}

