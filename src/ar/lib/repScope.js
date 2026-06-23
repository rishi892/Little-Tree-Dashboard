// Per-rep data scoping. Sales staff (Manny, Dave, Joe, Ken) sign into the full
// Little Tree dashboard but must ONLY ever see their own work - never another
// rep's invoices, customers, sales or scorecard row.
//
// STRICT, invoice-level scope (so nothing of another rep leaks anywhere):
//   • invoices   → only rows where the Sales Rep IS this rep.
//   • financials → the sales sheet has no rep column, so we attribute each row
//                  by its invoice number (mapped from the tracker). Rows whose
//                  invoice belongs to a DIFFERENT rep are excluded; rows we
//                  can't map fall back to "is it one of MY customers?" (a vendor
//                  I have at least one invoice for) so a rep's own sales aren't
//                  dropped just because a row is missing from the AR tracker.
//   • gelato     → always empty (sales reps are Little-Tree-only).
//
// `rep` is the canonical rep name stored at login. Empty → no scoping
// (CEO/CFO/Phil/Ivan see everything).

const normRep = (s) => String(s || '').trim().toLowerCase()
const normInv = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '')

// Fallback map: derive the scoping rep from the signed-in email, for sessions
// that signed in before `lt_rep` was stored (so scoping works without a forced
// re-login). Keep in sync with the rep users in SplashGate.
const REP_BY_EMAIL = {
  'manny.f@littletreeconfections.com': 'Manny',
  'david.d@littletreeconfections.com': 'Dave',
  'joe@littletreeconfections.com': 'Joe Pekin',
  'ken@littletreeconfections.com': 'Ken',
}

export function repForUser(storedRep, email) {
  if (storedRep) return storedRep
  return REP_BY_EMAIL[String(email || '').trim().toLowerCase()] || ''
}

export function scopeDataToRep(data, rep) {
  if (!rep || !data) return data
  const target = normRep(rep)

  // invoice # → rep (from the AR tracker, which has the Sales Rep column)
  const invRep = new Map()
  for (const r of data.invoices) {
    const k = normInv(r.invNo)
    if (k) invRep.set(k, normRep(r.salesRep))
  }

  // My invoices = exactly the ones where I'm the rep.
  const myInvoices = data.invoices.filter((r) => normRep(r.salesRep) === target)
  const myVendors = new Set(myInvoices.map((r) => r.vendor).filter(Boolean))

  // My financials: attributed to me by invoice #, or (if the invoice isn't on
  // the tracker at all) belonging to one of my customers. Never include a row
  // whose invoice is explicitly another rep's.
  const myFinancials = data.financials.filter((r) => {
    const owner = invRep.get(normInv(r.invNo))
    if (owner !== undefined) return owner === target
    return myVendors.has(r.vendor)
  })

  return {
    ...data,
    invoices: myInvoices,
    financials: myFinancials,
    gelato: [],
  }
}
