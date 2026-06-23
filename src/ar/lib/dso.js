// Operating-DSO filtering model (shared by Collections, Overview, InvoiceListModal).
//
// TOTAL DSO drops only write-offs (in-collections kept), year-filtered.
// OPERATING DSO has TWO modes:
//   'within' (Up to 180 days)  - the healthy book. Excludes write-offs,
//      in-collections, AND every 180+ invoice (paid late, open, in-collections
//      or written-off alike). Only invoices <= 180 days past due count.
//   'over'   (Over 180 days)   - the FULL book: the up-to-180 invoices PLUS the
//      180+ tail. Still excludes write-offs & in-collections, and drops 2022 &
//      2023 (too old).
import { getOverride } from './arOverrides.js'

const DAY = 86400000

// Days the invoice is/was outstanding past its due date.
//   paid invoices -> how late the payment was (paidDate - dueDate)
//   open invoices -> how overdue it is today (today - dueDate)
export function opLateDays(r) {
  const due = r.dueDate instanceof Date
    ? r.dueDate
    : (r.date instanceof Date ? new Date(r.date.getTime() + 30 * DAY) : null)
  if (!due) return r.daysOverdue || 0
  const end = r.paidDate instanceof Date ? r.paidDate : new Date()
  return Math.max(0, Math.floor((end - due) / DAY))
}

export const isOver180 = (r) => opLateDays(r) > 180

// TOTAL DSO: drop only write-offs.
export const keepInTotal = (r) => !r.isWriteOff

// OPERATING DSO: see modes above. mode defaults to 'within'. Write-offs are
// ALWAYS excluded (uncollectable, not reclassifiable). For everything else a
// manual override wins: 'collectible' forces it IN, 'doubtful' forces it OUT.
export function keepInOperating(r, mode = 'within') {
  if (r.isWriteOff) return false
  const ov = getOverride(r.invNo)
  if (ov === 'doubtful') return false
  if (ov === 'collectible') return mode === 'over'
    ? (r.date instanceof Date ? (r.date.getFullYear() !== 2022 && r.date.getFullYear() !== 2023) : true)
    : true
  if (r.isCollection) return false
  if (mode === 'over') {
    // Full book (up-to-180 plus the 180+ tail), only dropping 2022 & 2023.
    const y = r.date instanceof Date ? r.date.getFullYear() : null
    return y !== 2022 && y !== 2023
  }
  // 'within' = only invoices up to 180 days past due (the 180+ tail dropped).
  return !isOver180(r)
}

// Invoices kept in Total DSO but NOT in this Operating view (the "excluded" set).
export const isDoubtful = (r, mode = 'within') => keepInTotal(r) && !keepInOperating(r, mode)

// ---- Uncollectable AR (money unlikely to ever be collected) ----
// NATURAL (pre-override) status: an open receivable is uncollectable when it is
// written-off, in-collections, or more than 180 days past due. Paid invoices are
// collected, so they never count - the 180+ test only applies to open invoices.
export const naturalUncollectable = (r) =>
  r.isWriteOff || (r.isOutstanding && (r.isCollection || (r.daysOverdue || 0) > 180))

// EFFECTIVE status, after a manual override: write-offs are always uncollectable
// (not reclassifiable); otherwise 'collectible' forces NOT uncollectable and
// 'doubtful' forces uncollectable.
export const isUncollectable = (r) => {
  if (r.isWriteOff) return true
  const ov = getOverride(r.invNo)
  if (ov === 'collectible') return false
  if (ov === 'doubtful') return true
  return naturalUncollectable(r)
}

// Whether an invoice can be reclassified by the user. Write-offs are excluded -
// they are uncollectable by definition. Eligible = open & at risk (in-collections
// or 180+ days past due), or already carrying an override.
export const isReclassifiable = (r) =>
  !r.isWriteOff && (!!getOverride(r.invNo) || (r.isOutstanding && (r.isCollection || (r.daysOverdue || 0) > 180)))

// At-risk dollars for an invoice: the written-off loss, or the open balance.
export const riskAmt = (r) =>
  r.isWriteOff ? Math.max(0, (r.invoiceAmount || 0) - (r.invoicePaid || 0)) : (r.outstanding || 0)

// Rows that make up the AR "book" for the uncollectable ratio (open + write-offs).
export const inArBook = (r) => r.isOutstanding || r.isWriteOff

export const OP_MODES = [['within', 'Up to 180 days'], ['over', 'Over 180 days']]
export const opModeLabel = (m) => (m === 'over' ? 'Over 180 days' : 'Up to 180 days')
export const opModeShort = (m) => (m === 'over' ? 'full book (excl. 2022/23)' : '≤180d past due')
// What this mode KEEPS.
export const opKeepText = (m) => (m === 'over'
  ? 'all invoices including the 180+ tail (2022 & 2023 excluded)'
  : 'invoices up to 180 days past due')
// What this mode EXCLUDES.
export const opExclText = (m) => (m === 'over'
  ? 'written-off, in-collections, or from 2022/2023'
  : 'written-off, in-collections, or anything more than 180 days past due')
