import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr, isPrivateLabel } from '../src/ar/lib/brands.js'
const data = await loadAll()
const money=n=>'$'+Math.round(n).toLocaleString()
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})

// invoices in main tracker whose vendor/brand looks like Gelato / private label
const gelato = data.invoices.filter(r=>/gelato/i.test(r.vendor)||/gelato/i.test(r.brand||''))
console.log('Gelato-looking invoices in MAIN tracker:', gelato.length)
console.log('  Σ invoice amount:', money(gelato.reduce((s,r)=>s+r.invoiceAmount,0)))
console.log('  excluded by isInAr?', gelato.filter(r=>!isInAr(r,vb.get(r.vendor))).length, 'of', gelato.length)
console.log('  sample brands:', [...new Set(gelato.map(r=>r.brand||'(blank)'))].slice(0,8).join(' | '))
console.log('  sample rows:')
gelato.slice(0,6).forEach(r=>console.log('   ',r.invNo.padEnd(7), (r.salesRep||'(no rep)').padEnd(12), 'brand='+(r.brand||'(blank)').padEnd(10), money(r.invoiceAmount).padStart(9), r.vendor.slice(0,40)))

// all private-label invoices (any of the 4 brands)
const pl = data.invoices.filter(r=>isPrivateLabel(vb.get(r.vendor)||r.brand))
console.log('\nALL private-label invoices in tracker:', pl.length, '| Σ', money(pl.reduce((s,r)=>s+r.invoiceAmount,0)))
console.log('by brand:')
const byBrand=new Map()
pl.forEach(r=>{const b=r.brand||vb.get(r.vendor)||'(blank)';const c=byBrand.get(b)||{n:0,amt:0};c.n++;c.amt+=r.invoiceAmount;byBrand.set(b,c)})
;[...byBrand.entries()].sort((a,b)=>b[1].amt-a[1].amt).forEach(([b,v])=>console.log('  ',b.padEnd(14),v.n,money(v.amt)))
