// Collections-agency handoffs. Primary store = our backend (/api/agency-handoffs);
// localStorage is a fallback so the feature still works in the Vite-only preview
// (where /api proxies to a backend that may not have these endpoints yet).
const API = '/api/agency-handoffs'
const LS = 'lt_agency_handoffs'

const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]') } catch { return [] } }
const lsSet = (list) => { try { localStorage.setItem(LS, JSON.stringify(list)) } catch { /* ignore */ } }

export async function fetchHandoffs() {
  try {
    const res = await fetch(API, { cache: 'no-store' })
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data)) { lsSet(data); return data } // mirror to LS
    }
  } catch { /* fall through to localStorage */ }
  return lsGet()
}

export async function addHandoff(payload) {
  const entry = { ...payload, handedAt: payload.handedAt || new Date().toISOString() }
  // optimistic local upsert (keyed by invNo)
  const list = lsGet().filter((x) => x.invNo !== entry.invNo)
  list.push(entry); lsSet(list)
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) })
    if (res.ok) return res.json()
  } catch { /* keep local copy */ }
  return entry
}

export async function removeHandoff(invNo) {
  lsSet(lsGet().filter((x) => x.invNo !== invNo))
  try { await fetch(`${API}/${encodeURIComponent(invNo)}`, { method: 'DELETE' }) } catch { /* ignore */ }
}
