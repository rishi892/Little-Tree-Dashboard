import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr } from '../src/ar/lib/brands.js'
const data = await loadAll()
const today=new Date(); today.setHours(0,0,0,0)
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const ar=data.invoices.filter(r=>isInAr(r,vb.get(r.vendor)))
// operator method per customer (new dsoByGroup) vs old method — spot check one customer
const vendor='Little Tree- The Patient Station'
const inv=ar.filter(r=>r.vendor===vendor)
// NEW (operator)
let num=0,den=0
inv.forEach(r=>{if(!r.date||r.invoiceAmount<=0)return;const end=r.paidDate||today;const d=(end-r.date)/864e5;if(d<0||d>3650)return;num+=d*r.invoiceAmount;den+=r.invoiceAmount})
console.log(vendor.replace(/^Little Tree- /,''),'→ operator DSO:', den>0?(num/den).toFixed(1)+'d':'-', `(${inv.length} inv)`)
console.log('Build above should show "built in".')
