import { loadAll } from '../src/ar/lib/sheets.js'
const data = await loadAll()
const today=new Date(); today.setHours(0,0,0,0)
const list = data.invoices.filter(r=>(r.salesRep||'')==='Joe Pekin')
const money=n=>'$'+Math.round(n).toLocaleString()
let num=0,den=0,n=0, paidN=0,openN=0,paidAmt=0,openAmt=0
const contrib=[]
for(const r of list){
  if(!r.date||r.invoiceAmount<=0) continue
  const end=r.paidDate||today
  const days=(end-r.date)/86400000
  if(days<0) continue
  num+=days*r.invoiceAmount; den+=r.invoiceAmount; n++
  if(r.paidDate){paidN++;paidAmt+=r.invoiceAmount}else{openN++;openAmt+=r.invoiceAmount}
  contrib.push({inv:r.invNo,vendor:r.vendor,amt:r.invoiceAmount,days,paid:!!r.paidDate,owed:r.outstanding,wt:days*r.invoiceAmount})
}
console.log('JOE PEKIN — operator-method DSO')
console.log('total invoices used:',n,'| paid:',paidN,'| unpaid(open):',openN)
console.log('Σ invoiceAmount:',money(den),'| Σ days×amt:',Math.round(num).toLocaleString())
console.log('DSO =',(num/den).toFixed(1),'days')
console.log('\nopen AR (outstanding):',money(list.filter(r=>r.isOutstanding).reduce((s,r)=>s+r.outstanding,0)),'in',list.filter(r=>r.isOutstanding).length,'invoices')
console.log('\nTop 10 DSO drivers (days×amount):')
contrib.sort((a,b)=>b.wt-a.wt).slice(0,10).forEach(c=>console.log(' ',c.inv.padEnd(7),(c.paid?'PAID':'OPEN'),money(c.amt).padStart(9),Math.round(c.days)+'d',c.vendor.slice(0,42)))
