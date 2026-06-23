import { loadAll } from '../src/ar/lib/sheets.js';
import { wholesaleScope, gelatoScope } from '../src/ar/lib/scope.js';

const { invoices, gelato } = await loadAll();

// Configuration 1: Pure Little Tree Wholesale (excluding Gelato- prefixed and < $100)
const ws = wholesaleScope({ invoices, financials: [], gelato: [] });
const ltInQueue = ws.invoices.filter(r => r.isOutstanding && r.agingBucket === 'In Queue');

// Configuration 2: Little Tree Wholesale + Gelato- prefixed vendors (Method A / Raw LT sheet)
const ltRawInQueue = invoices.filter(r => r.isOutstanding && r.agingBucket === 'In Queue' && r.brand !== 'Gelato' && r.brand !== 'Alien Brainz' && r.brand !== 'Yacht Fuel' && r.brand !== 'Funkd Up');

console.log('LT Dashboard (Wholesale Scope) "In Queue" count:', ltInQueue.length);
console.log('LT Dashboard (Wholesale Scope) "In Queue" list:');
console.log(ltInQueue.map(r => ({ invNo: r.invNo, vendor: r.vendor, outstanding: r.outstanding })));

console.log('\nRaw LT Sheet (Method A) "In Queue" count:', ltRawInQueue.length);
console.log('Raw LT Sheet (Method A) "In Queue" list:');
console.log(ltRawInQueue.map(r => ({ invNo: r.invNo, vendor: r.vendor, outstanding: r.outstanding })));
