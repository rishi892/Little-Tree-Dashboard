import { loadAll } from '../src/ar/lib/sheets.js'
import { isInAr } from '../src/ar/lib/brands.js'
const data = await loadAll()
const vb=new Map(); data.invoices.forEach(r=>{if(r.vendor&&r.brand&&!vb.has(r.vendor))vb.set(r.vendor,r.brand)})
const money=n=>'$'+Math.round(n).toLocaleString()
const out = data.invoices.filter(r=>isInAr(r,vb.get(r.vendor))&&r.isOutstanding)
console.log('Total outstanding (isInAr && isOutstanding):', out.length, money(out.reduce((s,r)=>s+r.outstanding,0)))
// by aging bucket
const byB=new Map()
out.forEach(r=>{const b=r.agingBucket||'(none)';const c=byB.get(b)||{n:0,amt:0};c.n++;c.amt+=r.outstanding;byB.set(b,c)})
console.log('\nby aging bucket:')
;['In Queue','0–30','30–60','60–90','90–180','180+','(none)'].forEach(b=>{const c=byB.get(b); if(c)console.log('  ',b.padEnd(9),c.n,money(c.amt))})
const inQueue=byB.get('In Queue')||{n:0,amt:0}
console.log('\nIf "In Queue" (not yet due) excluded → action items:', out.length-inQueue.n, money(out.reduce((s,r)=>s+r.outstanding,0)-inQueue.amt))
