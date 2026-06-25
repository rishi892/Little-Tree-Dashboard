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
 * Weekly AR-collection forecast for the 13-week cashflow, derived from the open
 * AR (so it reflects the real $567k) but spread by the EMPIRICAL collection lag
 * curve - "kab kitna paisa aata hai" - so it stays realistic across the whole
 * window instead of dying after 4 weeks:
 *   - overdue invoices (owed now) collect across the window following the real
 *     lag curve (~16% wk1, ~33% by wk2, long tail to 2+ months) - so old AR
 *     dribbles in for ~10 weeks, not all crammed into the first 4
 *   - not-yet-due invoices collect around their due week, with realistic slip
 *   - a light age haircut (older = less likely to fully collect)
 * `weeks` are the 13-week Mondays in chronological order.
 */
export async function getArWeeklyCollection(weeks: Array<{ start: string; end: string }>): Promise<number[]> {
 const { invoices } = await getLittleTreeOpenAr();
 const { getCollectionLagCurve } = await import('./snapshotActuals.js');
 const lag = await getCollectionLagCurve();               // [wk0..wk12], sums ~1
 const n = weeks.length;
 const arByWeek = new Array<number>(n).fill(0);
 if (n === 0) return arByWeek;
 const now = new Date();
 const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
 const starts = weeks.map((w) => Date.parse(w.start + 'T00:00:00Z'));
 const haircut = (daysPastDue: number) => daysPastDue <= 90 ? 1 : daysPastDue <= 180 ? 0.85 : 0.6;
 // Renormalize the lag curve over the available window so an overdue invoice's
 // full collectible lands inside the window (no leakage past wk N).
 const lagSum = lag.slice(0, n).reduce((s, v) => s + v, 0) || 1;
 const overdueProfile = lag.slice(0, n).map((v) => v / lagSum);
 const notDueSlip = [0.5, 0.22, 0.13, 0.08, 0.05, 0.02];  // around the due week, some slip later
 for (const inv of invoices) {
  const collectible = inv.amount * haircut(inv.daysOut);
  if (inv.daysOut > 0) {
   // Overdue / owed now → spread across the window by the real lag curve.
   for (let w = 0; w < n; w++) arByWeek[w] += collectible * (overdueProfile[w] ?? 0);
  } else {
   // Not yet due → collect around the due week, with realistic slip after.
   const due = today - inv.daysOut * 86400000;            // daysOut <= 0 → due in the future
   let wk = 0;
   if (due < starts[0]) wk = 0;
   else if (due > starts[n - 1] + 7 * 86400000) continue; // due beyond the window → collects later
   else for (let w = n - 1; w >= 0; w--) { if (due >= starts[w]) { wk = w; break; } }
   let placed = 0;
   for (let s = 0; s < notDueSlip.length && wk + s < n; s++) { arByWeek[wk + s] += collectible * notDueSlip[s]; placed += notDueSlip[s]; }
   if (placed < 1 && wk < n) arByWeek[Math.min(wk, n - 1)] += collectible * (1 - placed);  // remainder if near window edge
  }
 }
 return arByWeek.map((v) => +v.toFixed(2));
}

// ---- Empirical collectibility (recovery) by aging band --------------------
export type RecoveryBand = { bucket: string; recovery: number; paid: number; writeOff: number; n: number };
let _recoveryCache: { at: number; byBucket: Record<string, number>; bands: RecoveryBand[] } | null = null;

/**
 * Measured RECOVERY RATE by aging band, from the Invoice Tracker history: of the
 * non-Gelato $ that ever reached a given lateness, what share eventually got PAID
 * (vs written off). "kabka kitna paisa aata hai" — answered from real outcomes,
 * not a guessed haircut. Little Tree's write-off rate is tiny (~0.4%), so recovery
 * is ~100% for fresh AR and ~84% for 180+ — the projection haircuts by THIS.
 */
export async function getRecoveryByBand(): Promise<{ byBucket: Record<string, number>; bands: RecoveryBand[] }> {
 if (_recoveryCache && Date.now() - _recoveryCache.at < 10 * 60 * 1000) return { byBucket: _recoveryCache.byBucket, bands: _recoveryCache.bands };
 const { getInvoiceTracker } = await import('./invoiceTracker.js');
 const tr = await getInvoiceTracker();
 const order = ['Current', '1-30', '31-60', '61-90', '91-120', '121-180', '180+'];
 const band = (d: number) => d <= 0 ? 'Current' : d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : d <= 120 ? '91-120' : d <= 180 ? '121-180' : '180+';
 const agg: Record<string, { paid: number; wo: number; n: number }> = {};
 for (const b of order) agg[b] = { paid: 0, wo: 0, n: 0 };
 const now = Date.now();
 for (const inv of tr.invoices) {
  if (GELATO_RX.test(inv.customer) || !inv.invoiceDate) continue;
  const due = inv.invoiceDate.getTime() + 30 * 86400000;
  const isWO = /write\s*off/i.test(inv.status);
  const isPaid = /^paid$/i.test(inv.status) || (inv.paid >= inv.amount && inv.amount > 0 && inv.moneyOwed === 0);
  if (!isWO && !isPaid) continue;                          // only RESOLVED invoices inform recovery
  const reachMs = (isPaid && inv.paidDate) ? Date.parse(inv.paidDate + 'T00:00:00Z') : now;
  const b = band(Math.floor((reachMs - due) / 86400000));
  agg[b].n++;
  if (isWO) agg[b].wo += inv.amount; else agg[b].paid += inv.paid;
 }
 const bands: RecoveryBand[] = order.map((b) => {
  const a = agg[b]; const denom = a.paid + a.wo;
  return { bucket: b, recovery: denom > 0 ? +(a.paid / denom).toFixed(4) : 1, paid: +a.paid.toFixed(2), writeOff: +a.wo.toFixed(2), n: a.n };
 });
 const byBucket: Record<string, number> = {};
 for (const x of bands) byBucket[x.bucket] = x.recovery;
 _recoveryCache = { at: Date.now(), byBucket, bands };
 return { byBucket, bands };
}

// ---- Per-customer collection trend (from paid history) --------------------
type PayStat = { median: number; std: number; n: number; source: 'customer' | 'global' };
let _payStatsCache: { at: number; map: Map<string, PayStat>; global: PayStat } | null = null;

/**
 * Each non-Gelato customer's historical days-to-pay (invoice → payment) from the
 * Invoice Tracker's paid invoices: median + spread. "kon customer kaise/kitne din
 * me deta hai." Customers with < 5 paid samples fall back to the global pattern.
 * Used to spread each open invoice's collection by ITS customer's real timing.
 */
export async function getCustomerPayStats(): Promise<{ map: Map<string, PayStat>; global: PayStat }> {
 if (_payStatsCache && Date.now() - _payStatsCache.at < 10 * 60 * 1000) return { map: _payStatsCache.map, global: _payStatsCache.global };
 const { getInvoiceTracker } = await import('./invoiceTracker.js');
 const { normCustomer } = await import('./customersMaster.js');
 const tr = await getInvoiceTracker();
 const byCust = new Map<string, number[]>();
 const all: number[] = [];
 for (const inv of tr.invoices) {
  if (inv.paid <= 0 || !inv.paidDate) continue;
  if (GELATO_RX.test(inv.customer)) continue;
  const pd = Date.parse(inv.paidDate + 'T00:00:00Z');
  const id = inv.invoiceDate?.getTime?.();
  if (!id || Number.isNaN(pd)) continue;
  const days = Math.round((pd - id) / 86400000);
  if (days < 0 || days > 365) continue;            // ignore bad/extreme rows
  const c = normCustomer(inv.customer);
  const arr = byCust.get(c) ?? []; arr.push(days); byCust.set(c, arr);
  all.push(days);
 }
 const statsOf = (a: number[], source: 'customer' | 'global'): PayStat => {
  if (!a.length) return { median: 30, std: 18, n: 0, source };
  const s = [...a].sort((x, y) => x - y);
  const median = s[Math.floor(s.length / 2)];
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const std = Math.max(7, Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length));
  return { median, std, n: a.length, source };
 };
 const global = statsOf(all, 'global');
 const map = new Map<string, PayStat>();
 for (const [c, arr] of byCust) map.set(c, arr.length >= 5 ? statsOf(arr, 'customer') : global);
 _payStatsCache = { at: Date.now(), map, global };
 return { map, global };
}

const SQRT2PI = Math.sqrt(2 * Math.PI);
const gaussPdf = (x: number, sigma: number) => Math.exp(-0.5 * (x / sigma) ** 2) / (sigma * SQRT2PI);

/**
 * FUTURE "Little Tree Account Receivable" collection: the FULL open AR ($567k,
 * dashboard-matched, every invoice incl. 180+) spread week-by-week by EACH
 * customer's own pay trend (median days-to-pay ± spread, from paid history).
 * Each invoice's expected pay date = its issue date + that customer's median;
 * already-overdue invoices are owed now → collect over the next couple of weeks.
 * The whole open balance lands inside the window, so the row sums to the full
 * open AR (no "kum 500k"), but the TIMING is customer-specific - not a blanket
 * curve. `weeks` = the 13 Mondays in chronological order.
 */
export async function getCustomerWiseArCollection(weeks: Array<{ start: string; end: string }>): Promise<number[]> {
 const [{ invoices }, { map: stats, global }, { byBucket: recovery }] = await Promise.all([getLittleTreeOpenAr(), getCustomerPayStats(), getRecoveryByBand()]);
 const { normCustomer } = await import('./customersMaster.js');
 const n = weeks.length;
 const out = new Array<number>(n).fill(0);
 if (n === 0) return out;
 const now = new Date();
 const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
 const mids = weeks.map((w) => Date.parse(w.start + 'T00:00:00Z') + 3.5 * 86400000);   // week midpoints
 for (const inv of invoices) {
  // Collectibility haircut from MEASURED recovery for this invoice's aging band
  // (history: ~100% fresh, ~84% for 180+). The non-collectible residual is NOT
  // placed in any week - it's the doubtful-AR reserve (never booked as cash).
  const collectible = inv.amount * (recovery[inv.bucket] ?? 1);
  const st = stats.get(normCustomer(inv.customer)) ?? global;
  const sigma = Math.max(7, st.std);
  const issueMs = Date.parse(inv.issueDate + 'T00:00:00Z');
  let expected = Number.isNaN(issueMs) ? todayMs + st.median * 86400000 : issueMs + st.median * 86400000;
  if (expected < todayMs + 4 * 86400000) expected = todayMs + 7 * 86400000;   // overdue / owed now → ~next week
  // Gaussian weight per week around the expected pay date, normalized over the
  // window so the collectible balance is placed by this customer's real timing.
  let wsum = 0; const w = new Array(n).fill(0);
  for (let k = 0; k < n; k++) { const g = gaussPdf((mids[k] - expected) / 86400000, sigma); w[k] = g; wsum += g; }
  if (wsum <= 0) { out[0] += collectible; continue; }
  for (let k = 0; k < n; k++) out[k] += collectible * (w[k] / wsum);
 }
 return out.map((v) => +v.toFixed(2));
}

/**
 * BUDGETED non-Gelato AR collection per week for the PAST view. getArWeeklyCollection
 * is anchored to TODAY's open AR, so it reads ~0 on elapsed weeks (those invoices
 * are already paid + gone). For the past budget we instead place EVERY non-Gelato,
 * non-write-off invoice (paid AND open) at its DUE DATE (sheet col 17, else
 * invoice + 30) and sum the billed amount into that week - so each elapsed week
 * shows the real "expected to collect that week per terms" figure. This follows
 * the same by-due-date collection trend as the future row, just over the full
 * invoice history. `weeks` = Mon-Sun ranges in chronological order.
 */
export async function getBudgetNonGelatoArByWeek(weeks: Array<{ start: string; end: string }>): Promise<number[]> {
 const n = weeks.length;
 const out = new Array<number>(n).fill(0);
 if (n === 0) return out;
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Invoice Tracker fetch failed: ${res.status}`);
 const rows = (await res.text()).split('\n').map(parseRow);
 const starts = weeks.map((w) => Date.parse(w.start + 'T00:00:00Z'));
 const ends = weeks.map((w) => Date.parse(w.end + 'T23:59:59Z'));
 const idxFor = (t: number): number => {
  for (let i = 0; i < n; i++) if (t >= starts[i] && t <= ends[i]) return i;
  return -1;
 };
 for (let i = 2; i < rows.length; i++) {                  // row 0 = summary, row 1 = header
  const r = rows[i];
  const invn = (r[0] || '').trim();
  if (!invn || /inv\s*#/i.test(invn)) continue;
  const customer = (r[2] || '').trim();
  if (!customer || GELATO_RX.test(customer)) continue;    // Little Tree book = non-Gelato
  if (/write\s*off/i.test((r[8] || '').trim())) continue;
  const amount = money(r[3]);
  if (amount <= 0) continue;
  const invDate = parseDate(r[1]);
  const dueDate = parseDate(r[17]) ?? (invDate ? new Date(invDate.getTime() + 30 * 86400000) : null);
  if (!dueDate) continue;
  const wi = idxFor(dueDate.getTime());
  if (wi >= 0) out[wi] += amount;
 }
 return out.map((v) => +v.toFixed(2));
}
