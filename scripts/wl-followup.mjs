import { loadAll } from '../src/ar/lib/sheets.js'
import { isPureXVendor } from '../src/ar/lib/brands.js'
const data = await loadAll()
const money=n=>'$'+Math.round(n).toLocaleString()
const sumV=(pred)=>{const m=new Map();data.invoices.forEach(r=>{if(pred(r.vendor)){m.set(r.vendor,(m.get(r.vendor)||0)+r.invoiceAmount)}});return m}
console.log('All Star now matched?', isPureXVendor('Little Tree- All Star Processing'))
console.log('\n"Flower Pot" stores in data (currently Little Tree retail):')
;[...sumV(v=>/flower\s*pot/i.test(v)&&!isPureXVendor(v)).entries()].sort((a,b)=>b[1]-a[1]).forEach(([v,a])=>console.log('  ',money(a).padStart(10),v))
console.log('\nALL "High Society" stores in data + white-label status:')
const hs=new Map();data.invoices.forEach(r=>{if(/high\s*society/i.test(r.vendor)){const k=r.vendor;const c=hs.get(k)||{amt:0,wl:isPureXVendor(k)};c.amt+=r.invoiceAmount;hs.set(k,c)}})
;[...hs.entries()].sort((a,b)=>b[1].amt-a[1].amt).forEach(([v,o])=>console.log('  ',(o.wl?'[WL]':'[LT]'),money(o.amt).padStart(10),v))
