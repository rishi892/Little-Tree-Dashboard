import { loadAll } from '../src/ar/lib/sheets.js';
import { wholesaleScope } from '../src/ar/lib/scope.js';

const { invoices } = await loadAll();
const ws = wholesaleScope({ invoices, financials: [], gelato: [] });
const ltOpen = ws.invoices.filter((r) => r.isOutstanding);
const totalOutstanding = ltOpen.reduce((s, r) => s + r.outstanding, 0);

console.log('--- Wholesale Scope Invoices ---');
console.log('Open Invoices Count:', ltOpen.length);
console.log('Total Outstanding (Cash to Collect):', totalOutstanding);

const allOpenLT = invoices.filter(r => r.isOutstanding && (r.brand !== 'Gelato' && r.brand !== 'Alien Brainz' && r.brand !== 'Yacht Fuel' && r.brand !== 'Funkd Up') && !r.vendor.toLowerCase().startsWith('gelato-'));
console.log('--- Without <$100 threshold filter ---');
console.log('Open Invoices Count:', allOpenLT.length);
console.log('Total Outstanding:', allOpenLT.reduce((s, r) => s + r.outstanding, 0));
