const url = 'https://docs.google.com/spreadsheets/d/1hcxz0jxBKIvoMSYrluxOYfBf3hOa4cXEIpqvaRtt-fI/export?format=csv&gid=0';
const res = await fetch(url);
const csvText = await res.text();

const lines = csvText.split('\n');
const headers = lines[11].split(','); // Let's find where the header row is. 

// We'll search for the specific invoice numbers in each line
const targetInvoices = ['5585a', '9189a', '9782a', '9822a', '9866a', '10862a', '12525a', '12863a', '12898a', '12900a', '12925a', '13107a', '13130a', '13198a', '13318a', '13366a', '13410a', '13411a', '13444a', '13492a'];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const fields = line.split(',');
  const invNo = fields[0] ? fields[0].trim() : '';
  if (targetInvoices.includes(invNo)) {
    console.log(`Row ${i}: Inv=${invNo}, rawLine=${line}`);
  }
}
