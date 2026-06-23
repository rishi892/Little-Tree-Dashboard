import { loadAll } from '../src/ar/lib/sheets.js'
import { isPrivateLabel, isPureXVendor } from '../src/ar/lib/brands.js'
const data = await loadAll()
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
// EXACT new dsoInvoices logic from Collections.jsx
const dsoInv = data.invoices.filter(r=>!isPrivateLabel(vb.get(r.vendor)||r.brand) && !isPureXVendor(r.vendor))
const stillLeaking = dsoInv.filter(r=>isPureXVendor(r.vendor))
console.log('Pure X vendors remaining in NEW dsoInvoices:', stillLeaking.length, '(should be 0)')
console.log('dsoInvoices total invoices:', dsoInv.length)
