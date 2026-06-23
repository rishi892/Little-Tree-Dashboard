import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr } from '../src/ar/lib/brands.js'
const data = await loadAll()
const vb = new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const outstanding = data.invoices.filter(r=>isInAr(r,vb.get(r.vendor))&&r.isOutstanding)
const now=new Date(); const cm=now.getFullYear()*12+now.getMonth()
const m=new Map()
outstanding.forEach(r=>{
  const noRep=!r.salesRep
  if(noRep&&r.date&&(r.date.getFullYear()*12+r.date.getMonth())===cm) return // NEW RULE
  const k=(r.salesRep||'Unassigned').toUpperCase()
  const c=m.get(k)||{n:0,amt:0}; c.n++; c.amt+=r.outstanding; m.set(k,c)
})
console.log('rep rows after rule:')
;[...m.entries()].sort((a,b)=>b[1].amt-a[1].amt).forEach(([k,v])=>console.log(' ',k.padEnd(14),v.n,'open','$'+Math.round(v.amt).toLocaleString()))
console.log('UNASSIGNED present?', m.has('UNASSIGNED')?'YES':'NO (excluded — both are current-month)')
