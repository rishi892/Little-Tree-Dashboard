// Reviews are stored in our OWN backend (cashflow-server) at /api/reviews.
// Same-origin in production; in dev the Vite proxy forwards /api to the backend.
const API = '/api/reviews'

export function uid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function submitReview(payload) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'review', ...payload }),
  })
  if (!res.ok) throw new Error(`submit failed (${res.status})`)
  return res.json()
}

// An audit is its own record (kind='audit') - who audited which section/tab,
// with a verdict ('correct' = all good, or 'issue') and an optional note.
export async function submitAudit(payload) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'audit', ...payload }),
  })
  if (!res.ok) throw new Error(`audit submit failed (${res.status})`)
  return res.json()
}

export async function resolveReview(id, resolvedBy, note) {
  const res = await fetch(`${API}/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolvedBy, note }),
  })
  if (!res.ok) throw new Error(`resolve failed (${res.status})`)
  return res.json()
}

export async function auditReview(id, auditedBy, auditNote) {
  const res = await fetch(`${API}/${encodeURIComponent(id)}/audit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auditedBy, auditNote }),
  })
  if (!res.ok) throw new Error(`audit failed (${res.status})`)
  return res.json()
}

export async function fetchReviews() {
  try {
    const res = await fetch(API, { cache: 'no-store' })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export const isAudited = (s) => /audited/i.test(s || '')
// "Resolved" here means "past the under-process stage" - both Resolved and
// Audited count as resolved for open/closed math.
export const isResolved = (s) => isAudited(s) || /resolved|done|fixed|closed/i.test(s || '')
export const statusLabel = (s) => (isAudited(s) ? 'Audited' : isResolved(s) ? 'Resolved' : 'Under process')
