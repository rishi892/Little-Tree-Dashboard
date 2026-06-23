import { loadAll } from '../src/ar/lib/sheets.js'
const data = await loadAll()
const money=n=>'$'+Math.round(n).toLocaleString()
const partials = data.invoices.filter(r=>r.isOutstanding && r.invoicePaid>0)
console.log('Partially-paid open invoices (wholesale tracker):', partials.length)
console.log('  total already paid:', money(partials.reduce((s,r)=>s+r.invoicePaid,0)))
console.log('  total still due:', money(partials.reduce((s,r)=>s+r.outstanding,0)))
console.log('  sample:')
partials.slice(0,5).forEach(r=>console.log('   ',r.invNo, money(r.invoicePaid),'paid of',money(r.invoiceAmount),'→',money(r.outstanding),'due', r.vendor.replace(/^Little Tree-\s*/,'')))
