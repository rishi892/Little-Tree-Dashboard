import { loadAll } from '../src/ar/lib/sheets.js';
import { wholesaleScope } from '../src/ar/lib/scope.js';

const { invoices } = await loadAll();
const ws = wholesaleScope({ invoices, financials: [], gelato: [] });

const ltOpen = ws.invoices.filter((r) => r.isOutstanding);
const ltColl = ws.invoices.filter((r) => r.isCollection);
const ltOpenNoColl = ws.invoices.filter((r) => r.isOutstanding && !r.isCollection);

console.log('LT Open (all): count =', ltOpen.length, 'sum =', ltOpen.reduce((s, r) => s + r.outstanding, 0));
console.log('LT Collections (all): count =', ltColl.length, 'sum =', ltColl.reduce((s, r) => s + r.outstanding, 0));
console.log('LT Open & No Collections: count =', ltOpenNoColl.length, 'sum =', ltOpenNoColl.reduce((s, r) => s + r.outstanding, 0));

// Let's print out all open & no collections invoices
console.log(ltOpenNoColl.map(r => ({ invNo: r.invNo, vendor: r.vendor, outstanding: r.outstanding, status: r.status, isCollection: r.isCollection })));
