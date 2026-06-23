import { loadAll } from '../src/ar/lib/sheets.js'
import { wholesaleScope } from '../src/ar/lib/scope.js'
const data = await loadAll()
const ws = wholesaleScope(data)
const money=n=>'$'+Math.round(n).toLocaleString()
// vendors in wholesale financials whose name looks like Gelato/Pure X
const leak = ws.financials.filter(r=>/gelato|pure ?x/i.test(r.vendor))
const byV=new Map()
leak.forEach(r=>{const c=byV.get(r.vendor)||{n:0,amt:0};c.n++;c.amt+=r.invoiceAmount;byV.set(r.vendor,c)})
console.log('Pure X / Gelato-looking vendors leaking into LITTLE TREE Sales (ws.financials):', byV.size)
;[...byV.entries()].sort((a,b)=>b[1].amt-a[1].amt).slice(0,15).forEach(([v,c])=>console.log('  ',money(c.amt).padStart(11), `(${c.n})`, v))
console.log('  total leaked sales:', money(leak.reduce((s,r)=>s+r.invoiceAmount,0)))
// also: is there a "Pure" brand (wholesale customer) distinct from Pure X private label?
const pureBrand = data.invoices.filter(r=>/^pure$/i.test((r.brand||'').trim()))
console.log('\n"Pure" brand (wholesale customer brand, NOT Pure X private label):', pureBrand.length, 'invoices', money(pureBrand.reduce((s,r)=>s+r.invoiceAmount,0)))
console.log('  sample vendors:', [...new Set(pureBrand.map(r=>r.vendor))].slice(0,4).join(' | '))
