import { loadAll } from '../src/ar/lib/sheets.js'
import { isPureXVendor, _wlNorm } from '../src/ar/lib/brands.js'
const data = await loadAll()
const money=n=>'$'+Math.round(n).toLocaleString()
// all distinct vendors in wholesale tracker
const allVendors = [...new Set(data.invoices.map(r=>r.vendor).filter(Boolean))]
const matched = allVendors.filter(v=>isPureXVendor(v) && !/^\s*gelato-/i.test(v)) // matched via LIST (not prefix)
console.log('=== Little Tree vendors NOW classified white-label (via the list) ===')
const sumByV = new Map()
data.invoices.forEach(r=>{ if(isPureXVendor(r.vendor) && !/^\s*gelato-/i.test(r.vendor)){ const c=sumByV.get(r.vendor)||0; sumByV.set(r.vendor,c+r.invoiceAmount) } })
;[...sumByV.entries()].sort((a,b)=>b[1]-a[1]).forEach(([v,amt])=>console.log('  ✓', money(amt).padStart(11), v))
const movedAmt = data.invoices.filter(r=>isPureXVendor(r.vendor)&&!/^gelato-/i.test(r.vendor)).reduce((s,r)=>s+r.invoiceAmount,0)
console.log('  TOTAL moved out of Little Tree (list-matched):', money(movedAmt), '·', matched.length, 'vendors')

// which white-label LIST entries did NOT match any vendor in the data?
const LIST = ['4k Processing Inc','4k Processing Return','Alien Brainz','All Star Processing LLC','Apothecare Jackson','Arborside','Berry Green Management','Exclusive Distribution','FLWRPot','FunkdUp','Green Trend','High Society 6','High Society Big Rapids','High Society Birch Run','High Society E Lansing','High Society Lenox','High Society Mt Pleasant','High Society New Buffalo','Nirvana Centerline','Nirvana Processing','Northcoast Provisions Arborside Adrian','Northcoast Provisions Sault St Marie','Pac-Man 222 Companies LLC','Plushco','Skymint','The Flower Pot','Yacht Fuel','Wildfire Investments']
const dataNorms = new Set(allVendors.map(_wlNorm))
console.log('\n=== List entries with NO exact match in data (need attention / typo / different name) ===')
LIST.filter(e=>!dataNorms.has(_wlNorm(e))).forEach(e=>{
  // find close candidates in data containing first word
  const w = _wlNorm(e).slice(0,6)
  const cand = allVendors.filter(v=>_wlNorm(v).includes(w)).slice(0,3)
  console.log('  ✗', e, cand.length?`  →? ${cand.map(c=>c.replace(/^Little Tree-\s*/i,'')).join(' | ')}`:'(no candidate)')
})
