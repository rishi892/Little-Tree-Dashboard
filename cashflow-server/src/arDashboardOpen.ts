/**
 * Little Tree open AR computed EXACTLY like the AR dashboard's Collections /
 * Action List, straight from the Invoice Tracker CSV. The dashboard uses the
 * sheet's "Money Owed" column (col 6) as the outstanding - NOT amount - paid -
 * and its own paid / write-off rules. Replicating that here makes the cashflow
 * AR number match the AR dashboard penny-for-penny (no "two places, two
 * amounts").
 *
 * Dashboard rule (src/ar/lib/sheets.js):
 *   outstanding = moneyOwed > 0 ? moneyOwed : (isPaid ? 0 : max(0, amount-paid))
 *   isPaid      = status==='paid' || (paid>=amount && amount>0 && moneyOwed===0)
 *   isOutstanding = !isPaid && !isWriteOff && outstanding > MIN ($100)
 *   Little Tree book = non-Gelato.
 */

const SHEET_ID = '1hcxz0jxBKIvoMSYrluxOYfBf3hOa4cXEIpqvaRtt-fI';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;
const MIN_OUTSTANDING = 100;            // matches the dashboard
const GELATO_RX = /(?:little tree[- ]+)?gelato/i;

export type ArOpenInvoice = {
 invoiceNumber: string; customer: string; brand: string; issueDate: string;
 amount: number; daysOut: number; bucket: string; status: string;
 infusedOrigin: boolean;   // private label (per customer master-list tick)
};
export type ArOpenResult = {
 asOfDate: string; grossAr: number; invoiceCount: number;
 buckets: Record<string, number>; invoices: ArOpenInvoice[];
 // Headline split matching the dashboard's All / Little Tree / Infused Origin.
 segments: { all: number; littleTree: number; infusedOrigin: number };
};

function parseRow(l: string): string[] {
 const o: string[] = []; let c = '', q = false;
 for (let i = 0; i < l.length; i++) {
  const ch = l[i];
  if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
  else { if (ch === '"') q = true; else if (ch === ',') { o.push(c); c = ''; } else c += ch; }
 }
 o.push(c); return o;
}
const money = (x: string) => { const t = String(x || '').replace(/[$,()\s]/g, ''); const n = Number(t); return Number.isFinite(n) ? n : 0; };
function parseDate(s: string): Date | null {
 const t = (s || '').trim();
 const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
 if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return new Date(Date.UTC(y, +m[1] - 1, +m[2])); }
 const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
 if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
 return null;
}
// Aging by DAYS PAST DUE (today − due date), matching the AR dashboard - NOT
// days since invoice. Due date = sheet "Due Date" (col 17), else invoice + 30.
const agingBucket = (overdue: number) =>
 overdue <= 0 ? 'Current' : overdue <= 30 ? '1-30' : overdue <= 60 ? '31-60'
 : overdue <= 90 ? '61-90' : overdue <= 120 ? '91-120' : overdue <= 180 ? '121-180' : '180+';

let cache: { at: number; data: ArOpenResult } | null = null;
const TTL_MS = 60 * 1000;

export async function getLittleTreeOpenAr(): Promise<ArOpenResult> {
 if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
 const { getPrivateLabelCustomers, normCustomer } = await import('./customersMaster.js');
 const [res, plSet] = await Promise.all([
  fetch(CSV_URL, { redirect: 'follow' }),
  getPrivateLabelCustomers().catch(() => new Set<string>()),
 ]);
 if (!res.ok) throw new Error(`Invoice Tracker fetch failed: ${res.status}`);
 const rows = (await res.text()).split('\n').map(parseRow);
 const now = new Date();
 const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
 const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

 const buckets: Record<string, number> = { 'Current': 0, '1-30': 0, '31-60': 0, '61-90': 0, '91-120': 0, '121-180': 0, '180+': 0 };
 const invoices: ArOpenInvoice[] = [];
 let grossAr = 0;
 const segments = { all: 0, littleTree: 0, infusedOrigin: 0 };

 for (let i = 2; i < rows.length; i++) {               // row 0 = summary, row 1 = header
  const r = rows[i];
  const invn = (r[0] || '').trim();
  if (!invn || /inv\s*#/i.test(invn)) continue;
  const customer = (r[2] || '').trim();
  if (!customer) continue;
  const amount = money(r[3]); const paid = money(r[4]); const moneyOwed = money(r[6]);
  const status = (r[8] || '').trim();
  const brand = (r[12] || '').trim();
  if (/write\s*off/i.test(status)) continue;
  if (GELATO_RX.test(customer)) continue;              // Little Tree book = non-Gelato
  const isPaid = status.toLowerCase() === 'paid' || (paid >= amount && amount > 0 && moneyOwed === 0);
  const outstanding = moneyOwed > 0 ? moneyOwed : (isPaid ? 0 : Math.max(0, amount - paid));
  if (isPaid || outstanding <= MIN_OUTSTANDING) continue;

  const invDate = parseDate(r[1]);
  const dueDate = parseDate(r[17]) ?? (invDate ? new Date(invDate.getTime() + 30 * 86400000) : null);  // col 17 Due Date, else Net 30
  const daysOverdue = dueDate ? Math.floor((today.getTime() - dueDate.getTime()) / 86400000) : 0;
  const bucket = agingBucket(daysOverdue);
  buckets[bucket] = +(buckets[bucket] + outstanding).toFixed(2);
  grossAr += outstanding;
  const infusedOrigin = plSet.has(normCustomer(customer));
  segments.all += outstanding;
  if (infusedOrigin) segments.infusedOrigin += outstanding; else segments.littleTree += outstanding;
  invoices.push({
   invoiceNumber: invn, customer, brand, issueDate: invDate ? ymd(invDate) : (r[1] || '').trim(),
   amount: +outstanding.toFixed(2), daysOut: daysOverdue, bucket, status: daysOverdue > 0 ? 'Overdue' : 'Open', infusedOrigin,
  });
 }
 invoices.sort((a, b) => b.amount - a.amount);
 const data: ArOpenResult = {
  asOfDate: ymd(today), grossAr: +grossAr.toFixed(2), invoiceCount: invoices.length, buckets, invoices,
  segments: { all: +segments.all.toFixed(2), littleTree: +segments.littleTree.toFixed(2), infusedOrigin: +segments.infusedOrigin.toFixed(2) },
 };
 cache = { at: Date.now(), data };
 return data;
}

/**
 * Weekly AR-collection forecast for the 13-week cashflow, derived straight from
 * the open AR (so it reflects the $567k, not a separate model):
 *   - not-yet-due invoices collect in the week of their due date
 *   - overdue invoices are owed now → collected over the next 4 weeks
 *   - a light age haircut (older = less likely to fully collect)
 * `weeks` are the 13-week Mondays in chronological order.
 */
export async function getArWeeklyCollection(weeks: Array<{ start: string; end: string }>): Promise<number[]> {
 const { invoices } = await getLittleTreeOpenAr();
 const n = weeks.length;
 const arByWeek = new Array<number>(n).fill(0);
 if (n === 0) return arByWeek;
 const now = new Date();
 const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
 const starts = weeks.map((w) => Date.parse(w.start + 'T00:00:00Z'));
 const haircut = (daysPastDue: number) => daysPastDue <= 90 ? 1 : daysPastDue <= 180 ? 0.85 : 0.6;
 for (const inv of invoices) {
  const collectible = inv.amount * haircut(inv.daysOut);
  if (inv.daysOut > 0) {
   const spread = Math.min(4, n);                         // overdue → next 4 weeks
   for (let w = 0; w < spread; w++) arByWeek[w] += collectible / spread;
  } else {
   const due = today - inv.daysOut * 86400000;            // daysOut <= 0 → due in the future
   if (due < starts[0]) { arByWeek[0] += collectible; continue; }
   if (due > starts[n - 1] + 7 * 86400000) continue;      // due beyond the window → collects later
   let wk = 0;
   for (let w = n - 1; w >= 0; w--) { if (due >= starts[w]) { wk = w; break; } }
   arByWeek[wk] += collectible;
  }
 }
 return arByWeek.map((v) => +v.toFixed(2));
}
