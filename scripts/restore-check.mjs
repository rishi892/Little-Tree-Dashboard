import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr, isWhiteLabelVendor } from '../src/ar/lib/brands.js'
const data = await loadAll()
const money=n=>'$'+Math.round(n).toLocaleString()
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const out = data.invoices.filter(r=>isInAr(r,vb.get(r.vendor))&&r.isOutstanding)
console.log('Little Tree AR — Total outstanding NOW:', out.length, 'invoices', money(out.reduce((s,r)=>s+r.outstanding,0)))
// white-label accounts now back in LT AR
const wlOpen = out.filter(r=>isWhiteLabelVendor(r.vendor))
console.log('  of which white-label accounts (back in LT AR):', wlOpen.length, money(wlOpen.reduce((s,r)=>s+r.outstanding,0)))
// gelato- prefix still excluded?
const gel = data.invoices.filter(r=>/^gelato-/i.test(r.vendor)&&r.isOutstanding&&isInAr(r,vb.get(r.vendor)))
console.log('  "Gelato-" prefix still excluded from LT AR?', gel.length===0?'YES (0)':'NO ('+gel.length+')')
