import { loadAll } from '../src/ar/lib/sheets.js';
import { isPrivateLabel, isPureXVendor } from '../src/ar/lib/brands.js';

// Let's load the data
const { invoices } = await loadAll();

// We will inspect the invoices array. 
// When loaded via loadAll(), the vendor property is already canonicalized.
// Since sheets.js does not yet have rawVendor, we can reconstruct the rawVendor 
// by checking the original spreadsheet data, or for this test, we can check 
// what happens if we don't filter out canonicalized 'Gelato-' prefixed vendors 
// unless they were originally 'Gelato-' in the spreadsheet.
//
// In our raw check, we saw that NONE of the 21 target invoices had "Gelato-" 
// in the raw VENDOR column of the invoices sheet. They all started with "Little Tree-".
//
// Let's simulate: we only exclude an invoice as "Pure X" if it actually had "gelato"
// in its raw sheet value. Since we don't have rawVendor in the loaded array yet,
// we can simulate it by comparing with the list of raw vendor names we fetched earlier.

const simulatedInvoices = invoices.map(inv => {
  // If the invoice is in the LT sheet, its original vendor did NOT start with Gelato-
  // (except maybe some actual mis-logged ones, but none of these 21 did).
  // For the simulation, we'll assume any invoice from the invoices sheet 
  // had rawVendor starting with "Little Tree-", except if it is one of the actual 
  // mis-logged gelato ones (which we don't have here, or if we do, we can check).
  // Actually, we can fetch the raw CSV inside this script and match by invNo to get the exact raw VENDOR!

  return inv;
});

const url = 'https://docs.google.com/spreadsheets/d/1hcxz0jxBKIvoMSYrluxOYfBf3hOa4cXEIpqvaRtt-fI/export?format=csv&gid=0';
const res = await fetch(url);
const csvText = await res.text();
const lines = csvText.split('\n');
const rawVendorMap = new Map();
for (let i = 12; i < lines.length; i++) {
  const fields = lines[i].split(',');
  const invNo = fields[0] ? fields[0].trim() : '';
  const rawVendor = fields[2] ? fields[2].trim() : '';
  if (invNo) {
    rawVendorMap.set(invNo.toLowerCase(), rawVendor);
  }
}

// Now let's filter invoices
const filtered = invoices.filter(r => {
  const brand = r.brand;
  const rawVendor = rawVendorMap.get(r.invNo.toLowerCase()) || r.vendor;
  
  // 1. Exclude Private Label
  if (isPrivateLabel(brand)) return false;
  
  // 2. Exclude Pure X (only if raw vendor starts with Gelato-)
  if (/^\s*gelato-/i.test(rawVendor)) {
    return false;
  }
  
  // 3. Exclude < $100 (if we want to see the effect of this filter)
  // Let's test with and without this filter
  return true;
});

const openFiltered = filtered.filter(r => r.isOutstanding);
const sumWithout100Filter = openFiltered.reduce((s, r) => s + r.outstanding, 0);
const sumWith100Filter = openFiltered.filter(r => r.outstanding >= 100).reduce((s, r) => s + r.outstanding, 0);

console.log('Without <$100 filter: count =', openFiltered.length, 'sum =', sumWithout100Filter);
console.log('With <$100 filter: count =', openFiltered.filter(r => r.outstanding >= 100).length, 'sum =', sumWith100Filter);
