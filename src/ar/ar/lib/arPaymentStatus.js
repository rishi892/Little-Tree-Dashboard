// Per-invoice payment-status overrides, entered inline in the invoice detail
// view. Lets the operator flag an open invoice as "payment received" (money in,
// not yet applied in the accounting system) or "payment plan active", with the
// extra fields each case needs. Persisted in localStorage, keyed by invoice
// number, behind a tiny external store so every open list / KPI re-renders the
// moment a status is saved. Mirrors arAgencyOverrides.js.
//
// Effect on the dashboard (applied where open AR is summed):
//   • 'received' → the invoice LEAVES the open book (Cash to collect / Total
//                  outstanding drop) and moves to the "Payment received · not
//                  applied" KPI card.
//   • 'plan'     → the invoice STAYS in the open book (still owed) but also
//                  appears in that KPI card so it can be tracked.
import { useSyncExternalStore } from 'react'

const KEY = 'ar_payment_status_v1'
let cache = load()
const listeners = new Set()

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { return {} }
}

// Status options for the inline dropdown (value, label). 'none' is the default
// and is never stored - it just clears any saved record.
export const PAYMENT_OPTIONS = [
  ['none', 'No Payment Received'],
  ['received', 'Payment Received'],
  ['plan', 'Payment Plan Active'],
]
export const PLAN_STATUS_OPTIONS = [
  ['active', 'Active'],
  ['completed', 'Completed'],
  ['defaulted', 'Defaulted'],
]

export function getPaymentStatus(invNo) { return invNo ? cache[invNo] : undefined }
export function paymentStatusOf(invNo) { return (invNo && cache[invNo]?.status) || 'none' }

// Save the full record for an invoice. Pass null (or a record with status
// 'none'/empty) to clear it back to the default "No Payment Received".
export function setPaymentStatus(invNo, record) {
  if (!invNo) return
  const next = { ...cache }
  if (!record || !record.status || record.status === 'none') delete next[invNo]
  else next[invNo] = record
  cache = next
  try { localStorage.setItem(KEY, JSON.stringify(cache)) } catch { /* ignore */ }
  listeners.forEach((l) => l())
}

function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) }

export function usePaymentStatus() {
  return useSyncExternalStore(subscribe, () => cache, () => cache)
}

// Tag every invoice with its current payment status so pages can read it
// directly (r.paymentStatus / r.payment) without importing the store. Pure -
// returns a new data object; never mutates the originals. Re-run whenever the
// store changes so the dashboard reflects edits live.
// Parse the date-input value ('YYYY-MM-DD') into a Date (local midnight).
function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return isNaN(d) ? null : d
}

// A "Payment Received" flag only TAKES EFFECT once the operator has filled in
// the required fields: a valid received date AND a positive received amount.
// Until both are present the invoice stays in the open book and is NOT counted
// in the "Payment received · not applied" KPI - so just picking the dropdown
// option doesn't immediately move money out.
export function isReceivedComplete(rec) {
  return !!rec && rec.status === 'received'
    && !!parseISODate(rec.receivedDate)
    && Number(rec.receivedAmount) > 0
}

// Same idea for a Payment Plan: it only counts (shows in the "Payment plan
// active" KPI) once the operator has filled BOTH a plan amount AND a next
// payment-due date. Until then, picking the option does nothing.
export function isPlanComplete(rec) {
  return !!rec && rec.status === 'plan'
    && Number(rec.planAmount) > 0
    && !!parseISODate(rec.nextDueDate)
}

// Apply each invoice's payment-status override to its core fields so EVERY
// downstream calculation (open totals, aging, defaulters, DSO, customer pages…)
// reflects it - not just Cash to collect. A received amount is booked like a
// real payment:
//   • partial → outstanding drops by the amount, invoice stays open for the rest
//   • full    → invoice is marked PAID (isOutstanding=false, paidDate=received
//               date) so DSO counts days-to-pay and aging/defaulters drop it
// We keep the originals (outstandingGross, isOutstandingOrig) so the editor can
// still cap the amount and the "not applied" cards keep showing the invoice
// until the source tracker itself marks it paid.
export function tagPaymentStatus(data, cacheArg = cache) {
  if (!data || !Array.isArray(data.invoices)) return data
  const tag = (r) => {
    const rec = r.invNo ? cacheArg[r.invNo] : undefined
    const status = rec?.status || 'none'
    const gross = r.outstanding || 0
    const complete = status === 'plan' ? isPlanComplete(rec) : isReceivedComplete(rec)
    const out = { ...r, paymentStatus: status, payment: rec || null, paymentComplete: complete, outstandingGross: gross, isOutstandingOrig: r.isOutstanding }
    if (status === 'received' && r.isOutstanding && complete) {
      const recv = Math.min(Math.max(0, Number(rec.receivedAmount) || 0), gross)
      const remaining = +(gross - recv).toFixed(2)
      out.outstanding = remaining
      out.invoicePaid = (r.invoicePaid || 0) + recv
      if (remaining <= 0) {
        // Fully received - book it as paid everywhere.
        out.outstanding = 0
        out.isOutstanding = false
        out.isPaid = true
        out.paidDate = parseISODate(rec.receivedDate) || r.paidDate || null
      }
    }
    return out
  }
  const out = { ...data, invoices: data.invoices.map(tag) }
  if (Array.isArray(data.gelato)) out.gelato = data.gelato.map(tag)
  return out
}
