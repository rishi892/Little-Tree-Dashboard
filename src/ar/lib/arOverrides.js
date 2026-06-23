// Manual collectibility overrides. The user can reclassify an individual invoice
// as 'collectible' or 'doubtful', overriding its natural status. This feeds back
// into Operating DSO and the Uncollectable % metric:
//   'collectible' - force it INTO Operating DSO (e.g. an in-collections invoice
//                   the user still expects to collect) and out of Uncollectable.
//   'doubtful'    - force it OUT of Operating DSO and into Uncollectable (e.g. an
//                   open invoice the user has given up on).
// Persisted in localStorage, keyed by invoice number. A tiny external store so
// every DSO calc re-runs the moment a mark changes.
import { useSyncExternalStore } from 'react'

const KEY = 'ar_collectibility_overrides_v1'
let cache = load()
const listeners = new Set()

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {} } catch { return {} }
}
function emit() { listeners.forEach((l) => l()) }

export function getOverride(invNo) { return invNo ? cache[invNo] : undefined }
export function getOverrides() { return cache }

export function setOverride(invNo, val) {
  if (!invNo) return
  const next = { ...cache }
  if (!val) delete next[invNo]
  else next[invNo] = val
  cache = next
  try { localStorage.setItem(KEY, JSON.stringify(cache)) } catch { /* ignore */ }
  emit()
}

function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) }

// Returns the override map (identity changes on every edit, so memos that depend
// on it recompute). Use this in any component that shows DSO / Uncollectable.
export function useOverrides() {
  return useSyncExternalStore(subscribe, getOverrides, getOverrides)
}
