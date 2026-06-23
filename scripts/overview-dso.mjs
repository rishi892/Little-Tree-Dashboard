import { loadAll } from '../src/ar/lib/sheets.js'
import { wholesaleScope } from '../src/ar/lib/scope.js'
import { isPrivateLabel } from '../src/ar/lib/brands.js'
const data = await loadAll()
const today=new Date(); today.setHours(0,0,0,0)
const ws = wholesaleScope(data)
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const dsoInv = data.invoices.filter(r=>!isPrivateLabel(vb.get(r.vendor)||r.brand))

// CURRENT Overview formula (isPaid split, 1825 cap, exclude coll/writeoff, ws.invoices)
function currentOverview(list){
  let pD=0,pA=0,oD=0,oA=0,n=0
  list.forEach(r=>{
    if(r.isCollection||r.isWriteOff)return
    if(!r.date)return
    if(r.isPaid&&r.paidDate){const d=(r.paidDate-r.date)/864e5; if(d>=0&&d<=1825){pD+=d*r.invoiceAmount;pA+=r.invoiceAmount;n++}}
    else if(r.isOutstanding){const d=(today-r.date)/864e5; if(d>=0){oD+=d*r.invoiceAmount;oA+=r.invoiceAmount;n++}}
  })
  return {dso:(pA+oA)>0?(pD+oD)/(pA+oA):0,n}
}
// OPERATOR method (end=paidDate||today, include all, guard 3650)
function operator(list){
  let D=0,A=0,n=0
  list.forEach(r=>{
    if(!r.date||r.invoiceAmount<=0)return
    const end=r.paidDate||today; const d=(end-r.date)/864e5
    if(d<0||d>3650)return
    D+=d*r.invoiceAmount;A+=r.invoiceAmount;n++
  })
  return {dso:A>0?D/A:0,n}
}
const a=currentOverview(ws.invoices)
const b=operator(ws.invoices)
const c=operator(dsoInv)
console.log('Overview Avg DSO:')
console.log('  CURRENT (old formula, ws.invoices) :', a.dso.toFixed(1)+'d', `(${a.n} inv)`)
console.log('  OPERATOR over ws.invoices          :', b.dso.toFixed(1)+'d', `(${b.n} inv)`)
console.log('  OPERATOR over dsoInvoices (By-Rep)  :', c.dso.toFixed(1)+'d', `(${c.n} inv)  <- consistent with By-Rep/DSO-Trend`)
