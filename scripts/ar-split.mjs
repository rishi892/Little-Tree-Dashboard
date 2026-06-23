import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr, isWhiteLabelVendor } from '../src/ar/lib/brands.js'
const data = await loadAll()
const money=n=>'$'+Math.round(n).toLocaleString()
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const open = data.invoices.filter(r=>isInAr(r,vb.get(r.vendor))&&r.isOutstanding)
const wl = open.filter(r=>isWhiteLabelVendor(r.vendor))
const retail = open.filter(r=>!isWhiteLabelVendor(r.vendor))
console.log('Little Tree AR outstanding split:')
console.log('  Little Tree (retail) :', retail.length, 'inv', money(retail.reduce((s,r)=>s+r.outstanding,0)))
console.log('  Private label        :', wl.length, 'inv', money(wl.reduce((s,r)=>s+r.outstanding,0)))
console.log('  Combined             :', open.length, 'inv', money(open.reduce((s,r)=>s+r.outstanding,0)))
