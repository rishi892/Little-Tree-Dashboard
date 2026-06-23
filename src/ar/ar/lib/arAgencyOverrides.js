// Manual collection-agency names, entered inline on invoices that are in
// collections but have no agency recorded in the sheet. Persisted in
// localStorage, keyed by invoice number. A tiny external store so the invoice
// list re-renders the moment a name is typed/saved.
import { useSyncExternalStore } from 'react'

const KEY = 'ar_collection_agency_v1'
let cache = load()
const listeners = new Set()

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { return {} }
}

export function getAgency(invNo) { return invNo ? cache[invNo] : undefined }

export function setAgency(invNo, name) {
  if (!invNo) return
  const next = { ...cache }
  const v = (name || '').trim()
  if (!v) delete next[invNo]
  else next[invNo] = v
  cache = next
  try { localStorage.setItem(KEY, JSON.stringify(cache)) } catch { /* ignore */ }
  listeners.forEach((l) => l())
}

function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) }

export function useAgencyOverrides() {
  return useSyncExternalStore(subscribe, () => cache, () => cache)
}
