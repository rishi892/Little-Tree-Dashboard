import { loadAll } from '../src/ar/lib/sheets.js';
import { wholesaleScope } from '../src/ar/lib/scope.js';

const { invoices } = await loadAll();

// 1. Get the wholesale scope invoices (dashboard data)
const ws = wholesaleScope({ invoices, financials: [], gelato: [] });
const wholesaleActionInvoices = ws.invoices.filter(r => r.isOutstanding);

console.log('Total wholesale invoices to action (unfiltered):', wholesaleActionInvoices.length);

// Let's inspect the reps present in this list
const reps = {};
wholesaleActionInvoices.forEach(r => {
  const rep = r.salesRep || '(no rep)';
  reps[rep] = (reps[rep] || 0) + 1;
});
console.log('Rep distribution on the Action List:', reps);

// Let's filter to Dave's invoices
const daveInvoices = wholesaleActionInvoices.filter(r => r.salesRep === 'Dave');
const nonDaveInvoices = wholesaleActionInvoices.filter(r => r.salesRep !== 'Dave');

console.log(`\n--- CASE 1: Filtered to ONLY Dave's invoices ---`);
console.log('Total invoices for Dave:', daveInvoices.length);
console.log('Total outstanding for Dave:', daveInvoices.reduce((s, r) => s + r.outstanding, 0));
console.log('Dave\'s invoices:');
console.log(daveInvoices.map(r => ({ invNo: r.invNo, vendor: r.vendor, outstanding: r.outstanding, agingBucket: r.agingBucket })));

console.log(`\n--- CASE 2: Filtered to EXCLUDE Dave's invoices (Dave filtered out) ---`);
console.log('Total invoices (excluding Dave):', nonDaveInvoices.length);
console.log('Total outstanding (excluding Dave):', nonDaveInvoices.reduce((s, r) => s + r.outstanding, 0));
