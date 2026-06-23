import { loadAll } from '../src/ar/lib/sheets.js'
const data = await loadAll()
const today=new Date(); today.setHours(0,0,0,0)
const mk=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`
const cur=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`
const m=new Map()
;(data.gelato||[]).forEach(r=>{
  if(!r.date||r.invoiceAmount<=0)return
  const end=r.paidDate||today
  const days=(end-r.date)/86400000
  if(days<0||days>3650)return
  const k=mk(r.date) // ISSUE month
  if(k===cur)return   // running month excluded (same as Little Tree)
  const c=m.get(k)||{wd:0,amt:0,paid:0,n:0}
  c.wd+=days*r.invoiceAmount; c.amt+=r.invoiceAmount; c.paid+=r.invoicePaid; c.n++; m.set(k,c)
})
const money=n=>'$'+Math.round(n).toLocaleString()
console.log('GELATO monthly DSO (same issue-month operator method, Gelato sheet):\n')
console.log('month   |  DSO   | #inv | billed')
;[...m.keys()].sort().slice(-8).forEach(k=>{const c=m.get(k); console.log(' ',k,'|',(c.wd/c.amt).toFixed(1)+'d','|',String(c.n).padStart(4),'|',money(c.amt))})
