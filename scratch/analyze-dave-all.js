import { loadAll } from '../src/ar/lib/sheets.js';
import { wholesaleScope } from '../src/ar/lib/scope.js';

const { invoices, gelato } = await loadAll();

// Let's check Dave's invoices across different scopes/channels
console.log('--- Dave Invoices Analysis ---');

// 1. In Little Tree (Wholesale Scope)
const ws = wholesaleScope({ invoices, financials: [], gelato: [] });
const ltOpenDave = ws.invoices.filter(r => r.isOutstanding && r.salesRep === 'Dave');
console.log('1. LT Open Dave (Wholesale Scope):', ltOpenDave.length);

// 2. In Gelato sheet open invoices
const gelOpenDave = gelato.filter(r => r.isOutstanding && r.salesRep === 'Dave');
console.log('2. Gelato Open Dave:', gelOpenDave.length);

// 3. Combined (LT + Gelato)
console.log('3. Combined LT + Gelato Open Dave:', ltOpenDave.length + gelOpenDave.length);

// 4. Raw LT sheet open invoices for Dave (without scope filters, i.e., before Gelato prefix mapping filters)
// Let's filter raw invoices where sales rep is Dave and is outstanding, excluding Private Label
const rawLtOpenDave = invoices.filter(r => r.isOutstanding && r.salesRep === 'Dave' && r.brand !== 'Gelato' && r.brand !== 'Alien Brainz' && r.brand !== 'Yacht Fuel' && r.brand !== 'Funkd Up');
console.log('4. Raw LT sheet Open Dave (excluding Private Label):', rawLtOpenDave.length);

// 5. Raw LT sheet open invoices for Dave, with no brand exclusions at all
const rawLtOpenDaveNoExclusions = invoices.filter(r => r.isOutstanding && r.salesRep === 'Dave');
console.log('5. Raw LT sheet Open Dave (no exclusions):', rawLtOpenDaveNoExclusions.length);

// 6. Let's see if there are any invoices in the raw LT sheet where VENDOR starts with Gelato- and salesRep is Dave
const rawLtOpenDaveGelatoPrefixed = invoices.filter(r => r.isOutstanding && r.salesRep === 'Dave' && r.vendor.toLowerCase().startsWith('gelato-'));
console.log('6. Raw LT Open Dave Gelato-prefixed:', rawLtOpenDaveGelatoPrefixed.length);

// Let's print the vendor names for Dave in raw LT sheet:
console.log('\nDave\'s Raw LT Sheet Outstanding Invoices (excluding PL):');
console.log(rawLtOpenDave.map(r => ({ invNo: r.invNo, vendor: r.vendor, outstanding: r.outstanding, isCollection: r.isCollection })));
