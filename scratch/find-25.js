import { loadAll } from '../src/ar/lib/sheets.js';
import { wholesaleScope } from '../src/ar/lib/scope.js';
import { isPrivateLabel, isPureXVendor } from '../src/ar/lib/brands.js';

const { invoices, gelato } = await loadAll();

// Let's test different filters for 'In Queue'
console.log('--- Test combinations for In Queue ---');

// 1. Raw invoices in LT sheet (no filters at all)
const rawLTInQueue = invoices.filter(r => r.isOutstanding && r.agingBucket === 'In Queue');
console.log('1. Raw invoices in LT sheet (no filters):', rawLTInQueue.length);

// 2. Excluding private label (standard wholesale definition in verify-numbers.mjs)
const ltAll = invoices.filter((r) => !isPrivateLabel(r.brand));
const ltOutstanding = ltAll.filter((r) => r.isOutstanding && r.agingBucket === 'In Queue');
console.log('2. LT wholesale outstanding (excluding Private Label):', ltOutstanding.length);

// 3. Excluding private label and < $100
const ltOutstandingGe100 = ltAll.filter((r) => r.isOutstanding && r.agingBucket === 'In Queue' && r.outstanding >= 100);
console.log('3. LT wholesale outstanding (excluding PL and < $100):', ltOutstandingGe100.length);

// 4. Invoices in wholesaleScope (what the dashboard shows)
const ws = wholesaleScope({ invoices, financials: [], gelato: [] });
const wsInQueue = ws.invoices.filter((r) => r.isOutstanding && r.agingBucket === 'In Queue');
console.log('4. Dashboard wholesaleScope In Queue:', wsInQueue.length);

// 5. Let's see if there is any other place.
// Let's check Gelato In Queue
const gelInQueue = gelato.filter(r => r.isOutstanding && r.agingBucket === 'In Queue');
console.log('5. Gelato In Queue:', gelInQueue.length);
