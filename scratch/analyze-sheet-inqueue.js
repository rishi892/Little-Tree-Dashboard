import Papa from 'papaparse';

const url = 'https://docs.google.com/spreadsheets/d/1hcxz0jxBKIvoMSYrluxOYfBf3hOa4cXEIpqvaRtt-fI/export?format=csv&gid=0';
const res = await fetch(url);
const csvText = await res.text();

const parseResult = Papa.parse(csvText, {
  header: false,
  skipEmptyLines: 'greedy',
});
const rawRows = parseResult.data;

// Find header row (the one containing "Inv #")
let headerIdx = 0;
for (let i = 0; i < Math.min(rawRows.length, 20); i++) {
  if (rawRows[i].some(c => String(c).trim().toLowerCase() === 'inv #')) {
    headerIdx = i;
    break;
  }
}

const headers = rawRows[headerIdx].map(h => String(h).trim());
const rows = rawRows.slice(headerIdx + 1).map(r => {
  const obj = {};
  headers.forEach((h, idx) => {
    obj[h] = r[idx] ?? '';
  });
  return obj;
}).filter(r => r['Inv #']);

console.log('Total invoices parsed:', rows.length);

// We want to analyze "In Queue" invoices.
// In the spreadsheet, is there a Status column? Let's check what values exist in the "Status" column.
const statusCounts = {};
rows.forEach(r => {
  const s = r['Status'] ? r['Status'].trim() : '(blank)';
  statusCounts[s] = (statusCounts[s] || 0) + 1;
});
console.log('Status column value distribution:', statusCounts);

// Now let's find all rows where:
// 1. Status is explicitly "In Queue"
// 2. Or the due date is in the future and it is outstanding.
// Let's print both.

const explicitInQueue = rows.filter(r => {
  const status = (r['Status'] || '').trim().toLowerCase();
  return status === 'in queue';
});

console.log(`\nFound ${explicitInQueue.length} rows with explicit Status = "In Queue"`);

const today = new Date();
today.setHours(0,0,0,0);

// Helper to parse money
function parseMoney(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[$,\s]/g, '').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Helper to parse date
function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'void') return null;
  const parts = s.split('/');
  if (parts.length === 3) {
    let [m, d, y] = parts.map(p => parseInt(p, 10));
    if (y < 100) y = 2000 + y;
    return new Date(y, m - 1, d);
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}

const calculatedInQueue = rows.filter(r => {
  const amt = parseMoney(r['Invoice Amount']);
  const paid = parseMoney(r['Invoice Paid']);
  const moneyOwed = parseMoney(r['Money Owed']);
  const date = parseDate(r['Date']);
  let dueDate = parseDate(r['Due Date']);
  if (!dueDate && date) {
    dueDate = new Date(date);
    dueDate.setDate(dueDate.getDate() + 30);
  }
  
  const status = (r['Status'] || '').trim().toLowerCase();
  const isPaid = status === 'paid' || (paid >= amt && amt > 0 && moneyOwed === 0);
  const isWriteOff = status.includes('write');
  const outstanding = moneyOwed > 0 ? moneyOwed : (isPaid ? 0 : Math.max(0, amt - paid));
  const isOutstanding = !isPaid && !isWriteOff && outstanding > 0;
  
  const daysOverdue = dueDate ? Math.floor((today - dueDate) / (1000 * 60 * 60 * 24)) : null;
  const isUpcoming = daysOverdue != null && daysOverdue < 0;
  
  return isOutstanding && isUpcoming;
});

console.log(`Found ${calculatedInQueue.length} rows calculated as In Queue (outstanding and due in future)`);

console.log('\n--- Details of Explicit Status "In Queue" Invoices ---');
explicitInQueue.forEach((r, idx) => {
  console.log(`${idx + 1}. Inv=${r['Inv #']}, Vendor="${r['VENDOR']}", Brand="${r['Brand']}", Date=${r['Date']}, Due=${r['Due Date']}, Amount=${r['Invoice Amount']}, MoneyOwed=${r['Money Owed']}`);
});
