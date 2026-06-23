import { loadAll } from '../src/ar/lib/sheets.js';
import { isPrivateLabel, isPureXVendor } from '../src/ar/lib/brands.js';

const { invoices } = await loadAll();

console.log('Total invoices in sheet:', invoices.length);
console.log('Outstanding count:', invoices.filter(r => r.isOutstanding).length);
console.log('Outstanding sum:', invoices.filter(r => r.isOutstanding).reduce((s, r) => s + r.outstanding, 0));

// Let's check outstanding sum for different categories:
const PL = invoices.filter(r => r.isOutstanding && isPrivateLabel(r.brand));
const PureX = invoices.filter(r => r.isOutstanding && !isPrivateLabel(r.brand) && isPureXVendor(r.vendor));
const Wholesale = invoices.filter(r => r.isOutstanding && !isPrivateLabel(r.brand) && !isPureXVendor(r.vendor));

console.log('Private Label Outstanding Sum:', PL.reduce((s, r) => s + r.outstanding, 0), 'count:', PL.length);
console.log('Pure X Outstanding Sum:', PureX.reduce((s, r) => s + r.outstanding, 0), 'count:', PureX.length);
console.log('Wholesale Outstanding Sum:', Wholesale.reduce((s, r) => s + r.outstanding, 0), 'count:', Wholesale.length);

console.log('--- Wholesale Outstanding List ---');
console.log(Wholesale.map(r => ({ invNo: r.invNo, vendor: r.vendor, brand: r.brand, outstanding: r.outstanding, isCollection: r.isCollection })));
