import { loadAll } from '../src/ar/lib/sheets.js';
import { wholesaleScope } from '../src/ar/lib/scope.js';
import { isPrivateLabel } from '../src/ar/lib/brands.js';

const { invoices } = await loadAll();

// Method A: verify-numbers.mjs logic
const ltAll = invoices.filter((r) => !isPrivateLabel(r.brand));
const ltOutstanding = ltAll.filter((r) => r.isOutstanding);

// Method B: wholesaleScope logic
const ws = wholesaleScope({ invoices, financials: [], gelato: [] });
const ltOpen = ws.invoices.filter((r) => r.isOutstanding);

console.log('Method A Count:', ltOutstanding.length);
console.log('Method A Sum:', ltOutstanding.reduce((s, r) => s + r.outstanding, 0));

console.log('Method B Count:', ltOpen.length);
console.log('Method B Sum:', ltOpen.reduce((s, r) => s + r.outstanding, 0));

// Find what's in Method A but not in Method B
const bKeys = new Set(ltOpen.map(r => r.invNo));
const diff = ltOutstanding.filter(r => !bKeys.has(r.invNo));

console.log('--- In A but not in B ---');
console.log(diff.map(r => ({ invNo: r.invNo, vendor: r.vendor, brand: r.brand, outstanding: r.outstanding })));
