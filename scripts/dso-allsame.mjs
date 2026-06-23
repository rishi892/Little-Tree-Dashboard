import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr, isPrivateLabel } from '../src/ar/lib/brands.js'
const data = await loadAll()
const today=new Date(); today.setHours(0,0,0,0)
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const arInvoices = data.invoices.filter(r=>isInAr(r,vb.get(r.vendor)))           // card + Overview scope
const dsoInvoices = data.invoices.filter(r=>!isPrivateLabel(vb.get(r.vendor)||r.brand)) // By-Rep + DSO-Trend scope

// operator all-time DSO over a set
function opDso(list){let n=0,d=0;list.forEach(r=>{if(!r.date||r.invoiceAmount<=0)return;const end=r.paidDate||today;const days=(end-r.date)/864e5;if(days<0||days>3650)return;n+=days*r.invoiceAmount;d+=r.invoiceAmount});return d>0?n/d:0}

// DSO-Trend "overall" = weighted avg of monthly (issue-month) DSOs, excl running month, last 24
function trendOverall(list){
  const cur=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`
  const m=new Map()
  list.forEach(r=>{if(!r.date||r.invoiceAmount<=0)return;const end=r.paidDate||today;const days=(end-r.date)/864e5;if(days<0||days>3650)return
    const k=`${r.date.getFullYear()}-${String(r.date.getMonth()+1).padStart(2,'0')}`;if(k===cur)return
    const c=m.get(k)||{wd:0,amt:0};c.wd+=days*r.invoiceAmount;c.amt+=r.invoiceAmount;m.set(k,c)})
  const rows=[...m.entries()].sort((a,b)=>a[0].localeCompare(b[0])).slice(-24).map(([k,v])=>({dso:v.amt>0?v.wd/v.amt:0,amt:v.amt}))
  const num=rows.reduce((s,r)=>s+r.dso*r.amt,0), den=rows.reduce((s,r)=>s+r.amt,0)
  return den>0?num/den:0
}

console.log('Card "Days to collect"  (operator, arInvoices, all-time):', opDso(arInvoices).toFixed(1)+'d')
console.log('Overview "Avg days..."  (operator, ws.invoices=arInvoices):', opDso(arInvoices).toFixed(1)+'d')
console.log('By-Rep basis            (operator, dsoInvoices, all-time):', opDso(dsoInvoices).toFixed(1)+'d')
console.log('DSO-Trend "Overall avg" (weighted monthly, dsoInvoices, last24 excl running):', trendOverall(dsoInvoices).toFixed(1)+'d')
console.log('\narInvoices:', arInvoices.length, '| dsoInvoices:', dsoInvoices.length, '| diff (mostly <$100 open + private-label):', dsoInvoices.length-arInvoices.length)
