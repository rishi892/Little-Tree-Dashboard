import { loadAll } from '../src/ar/lib/sheets.js'
import { isPureXVendor } from '../src/ar/lib/brands.js'
const data = await loadAll()
const v = 'Little Tree- The Patient Station'
const ltInv = data.invoices.filter(r=>r.vendor===v && !isPureXVendor(r.vendor))
const pxInv = [...(data.gelato||[]).filter(r=>r.vendor===v), ...data.invoices.filter(r=>r.vendor===v && isPureXVendor(r.vendor))]
console.log('LITTLE TREE book → invoices shown:', ltInv.length, '(all from wholesale tracker)')
console.log('  invNos:', ltInv.map(r=>r.invNo).join(', '))
console.log('PURE X book → invoices shown:', pxInv.length, '(from Gelato sheet)')
console.log('  invNos:', pxInv.map(r=>r.invNo).join(', '))
console.log('\nOverlap (same inv# in both)?', ltInv.filter(a=>pxInv.some(b=>b.invNo===a.invNo)).map(r=>r.invNo).join(', ')||'NONE ✓')
