import { loadAll } from '../src/ar/lib/sheets.js'
import { isPrivateLabel } from '../src/ar/lib/brands.js'
const data = await loadAll()
const today=new Date(); today.setHours(0,0,0,0)
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const mkey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
function monthly(list){
  const m=new Map()
  list.forEach(r=>{
    if(!r.date||r.invoiceAmount<=0) return
    const end=r.paidDate||today
    const days=(end-r.date)/86400000
    if(days<0) return
    const k=mkey(r.date) // ISSUE month
    const c=m.get(k)||{k,wd:0,amt:0,paid:0,n:0}
    c.wd+=days*r.invoiceAmount; c.amt+=r.invoiceAmount; c.paid+=r.invoicePaid; c.n++
    m.set(k,c)
  })
  return m
}
const full=monthly(data.invoices)
const noPL=monthly(data.invoices.filter(r=>!isPrivateLabel(vb.get(r.vendor)||r.brand)))
const targets={'2026-03':20.63,'2026-04':40.05,'2026-05':22.05}
const money=n=>'$'+Math.round(n).toLocaleString()
console.log('issue-month DSO  (target | FULL tracker | excl private-label)\n')
for(const k of ['2026-03','2026-04','2026-05']){
  const f=full.get(k), n=noPL.get(k)
  console.log(k, '| target', targets[k]+'d',
    '|| FULL:', (f.wd/f.amt).toFixed(2)+'d', money(f.amt), `(${f.n}inv)`,
    '|| noPL:', (n.wd/n.amt).toFixed(2)+'d', money(n.amt))
}
console.log('\n(operator March: Σamt $994,493 · DSO 20.63 | April Σamt $464,328 · 40.05 | May Σamt $292,138 · 22.05)')
