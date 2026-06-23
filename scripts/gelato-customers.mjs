import { loadAll } from '../src/ar/lib/sheets.js'
import { gelatoScope } from '../src/ar/lib/scope.js'
const data = await loadAll()
const g = gelatoScope(data)
const money=n=>'$'+Math.round(n).toLocaleString()
const custs=new Set(g.financials.map(r=>r.vendor).filter(Boolean))
console.log('Gelato sheet rows:', (data.gelato||[]).length)
console.log('distinct gelato customers:', custs.size)
console.log('total billed:', money(g.financials.reduce((s,r)=>s+r.invoiceAmount,0)))
console.log('total paid:', money(g.financials.reduce((s,r)=>s+r.invoicePaid,0)))
console.log('open AR:', money(g.invoices.filter(r=>r.isOutstanding).reduce((s,r)=>s+r.outstanding,0)), 'in', g.invoices.filter(r=>r.isOutstanding).length,'invoices')
console.log('sample customers:', [...custs].slice(0,5).join(' | '))
