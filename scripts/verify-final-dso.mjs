import { loadAll } from '../src/ar/lib/sheets.js'
import { isPrivateLabel } from '../src/ar/lib/brands.js'
const data = await loadAll()
const today=new Date(); today.setHours(0,0,0,0)
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const ws = data.invoices.filter(r=>!isPrivateLabel(vb.get(r.vendor)||r.brand)) // wholesale only
const money=n=>'$'+Math.round(n).toLocaleString()
// monthly by ISSUE month
const mk=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
const mm=new Map()
ws.forEach(r=>{ if(!r.date||r.invoiceAmount<=0)return; const end=r.paidDate||today; const days=(end-r.date)/86400000; if(days<0||days>3650)return
  const k=mk(r.date); const c=mm.get(k)||{wd:0,amt:0,n:0}; c.wd+=days*r.invoiceAmount; c.amt+=r.invoiceAmount; c.n++; mm.set(k,c)})
console.log('LITTLE TREE monthly DSO (issue-month, wholesale-only):')
;[...mm.keys()].sort().slice(-8).forEach(k=>{const c=mm.get(k); console.log('  ',k,(c.wd/c.amt).toFixed(2)+'d',money(c.amt),`(${c.n}inv)`)})
// rep DSO wholesale-only
const rk=r=>(r.salesRep||'Unassigned').toUpperCase()
const rm=new Map()
ws.forEach(r=>{ if(!r.date||r.invoiceAmount<=0)return; const end=r.paidDate||today; const days=(end-r.date)/86400000; if(days<0||days>3650)return
  const k=rk(r); const c=rm.get(k)||{wd:0,amt:0,n:0}; c.wd+=days*r.invoiceAmount; c.amt+=r.invoiceAmount; c.n++; rm.set(k,c)})
console.log('\nRep DSO (wholesale-only):')
;[...rm.entries()].sort((a,b)=>b[1].amt-a[1].amt).forEach(([k,c])=>console.log('  ',k.padEnd(13),(c.wd/c.amt).toFixed(1)+'d',`(${c.n}inv, ${money(c.amt)})`))
