import { loadAll } from '../src/ar/lib/sheets.js';
import { wholesaleScope } from '../src/ar/lib/scope.js';

const { invoices } = await loadAll();
const ws = wholesaleScope({ invoices, financials: [], gelato: [] });

const ltOpen = ws.invoices.filter((r) => r.isOutstanding);

console.log('Total open count:', ltOpen.length);
let sum = 0;
for (const r of ltOpen) {
  sum += r.outstanding;
  console.log(`Inv: ${r.invNo}, Vendor: ${r.vendor}, Outstanding: ${r.outstanding}, isCollection: ${r.isCollection}`);
}
console.log('Calculated sum:', sum);
