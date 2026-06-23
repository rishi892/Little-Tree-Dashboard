/**
 * Detect recurring subscriptions directly from QBO transaction history.
 *
 * For each merchant (either a QBO Vendor or a normalized line-item description
 * for credit-card subs), we compute:
 * - txnCount, monthsObserved
 * - median amount (per-charge)
 * - median day-of-month (proxy for "billing day")
 * - cadence (avg gap between charges)
 * - pattern: FIXED / VARIABLE / PERIODIC
 *
 * A bucket is considered "recurring" if it has ≥3 charges across ≥3 distinct
 * months and a median amount above a small threshold. This intentionally
 * excludes one-off spend (Home Depot trips, ad-hoc travel) while keeping
 * monthly / quarterly / annual subs.
 */

import { QBO_API_BASE } from './config.js';
import { qboFetch } from './qbHttp.js';
import { getValidAccessToken } from './oauth.js';

type Vendor = { Id: string; DisplayName: string; CompanyName?: string };
type Purchase = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 EntityRef?: { value: string; name?: string; type?: string };
 AccountRef?: { value: string; name?: string };
 Line?: Array<{ Amount?: number; Description?: string }>;
};
type Bill = {
 Id: string;
 TxnDate: string;
 TotalAmt: number;
 VendorRef?: { value: string; name?: string };
 Line?: Array<{ Amount?: number; Description?: string }>;
};

async function qboQuery<T>(query: string, accessToken: string, realmId: string, key: string): Promise<T[]> {
 const all: T[] = [];
 const pageSize = 1000;
 let start = 1;
 while (true) {
 const q = `${query} STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
 const url = `${QBO_API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(q)}&minorversion=70`;
 const res = await qboFetch(url, accessToken);
 const data = (await res.json()) as { QueryResponse: Record<string, T[]> };
 const batch = data.QueryResponse[key] ?? [];
 all.push(...batch);
 if (batch.length < pageSize) break;
 start += pageSize;
 }
 return all;
}

/**
 * Normalize a free-text line description to a stable "merchant key".
 * Strips card-statement noise (txn IDs, store numbers, city/state, processor
 * prefixes like PAYPAL*, PADDLE.NET*) so that the same merchant shows up under
 * one consistent key.
 */
function normalizeMerchant(desc: string): string {
 let s = ` ${desc.toUpperCase()} `;
 // Strip leading transaction IDs / authorization codes
 s = s.replace(/\s[0-9A-Z]{7,}\s/, ' ');
 // Strip processor prefixes
 s = s.replace(/\s(PAYPAL|SQ|GOOG(LE)?|MSFT|PADDLE\.NET|STRIPE|TST|TST\*)\s*\*\s*/, ' ');
 // Strip card-mask suffixes ("XXXX1234", "XXX1234")
 s = s.replace(/\sX{2,}\d+\s/g, ' ');
 // Strip city + state suffix (e.g., "SAN FRANCISCO CA")
 s = s.replace(/\s[A-Z][A-Z\s]{2,}\s[A-Z]{2}\s$/, ' ');
 // Strip trailing zip codes
 s = s.replace(/\s\d{5}(-\d{4})?\s$/, ' ');
 // Strip date-like patterns
 s = s.replace(/\s\d{1,2}\/\d{1,2}(\/\d{2,4})?\s/g, ' ');
 // Collapse non-alpha-digit + spaces
 s = s.replace(/[^A-Z0-9\s]/g, ' ');
 s = s.replace(/\s+/g, ' ').trim();
 // Cap length so wild outliers don't create separate buckets
 if (s.length > 40) s = s.slice(0, 40).trim();
 return s;
}

export type DetectedSub = {
 source: 'vendor' | 'line';
 vendor: string; // display name
 monthly: number; // median per-charge amount
 billDay: number; // median day-of-month (1–31)
 weekOfMonth: 1 | 2 | 3 | 4 | 5;
 pattern: 'FIXED' | 'VARIABLE' | 'PERIODIC';
 txnCount: number;
 monthsObserved: number;
 lastSeen: string;
 firstSeen: string;
 /** Coefficient-of-variation of amounts (lower = more stable). */
 amountStability: number;
 avgGapDays: number;
 notes: string;
 /** Up to 12 most recent charges, oldest → newest. */
 history: Array<{ date: string; amount: number; description?: string }>;
};

export type RecurringResult = {
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 since: string;
 totals: { vendors: number; purchases: number; bills: number; mergedBuckets: number };
 subs: DetectedSub[];
};

function median(arr: number[]): number {
 if (arr.length === 0) return 0;
 const s = arr.slice().sort((a, b) => a - b);
 const mid = Math.floor(s.length / 2);
 return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function weekOfMonth(day: number): 1 | 2 | 3 | 4 | 5 {
 if (day <= 7) return 1;
 if (day <= 14) return 2;
 if (day <= 21) return 3;
 if (day <= 28) return 4;
 return 5;
}

export async function detectRecurringSubscriptions(lookbackMonths = 12): Promise<RecurringResult> {
 const tok = await getValidAccessToken();

 const since = new Date();
 since.setUTCMonth(since.getUTCMonth() - lookbackMonths);
 const sinceStr = `${since.getUTCFullYear()}-${String(since.getUTCMonth() + 1).padStart(2, '0')}-01`;

 const [vendors, purchases, bills] = await Promise.all([
 qboQuery<Vendor>('select * from Vendor', tok.accessToken, tok.realmId, 'Vendor'),
 qboQuery<Purchase>(`select * from Purchase where TxnDate >= '${sinceStr}'`, tok.accessToken, tok.realmId, 'Purchase'),
 qboQuery<Bill>(`select * from Bill where TxnDate >= '${sinceStr}'`, tok.accessToken, tok.realmId, 'Bill'),
 ]);

 const vendorsById = new Map(vendors.map((v) => [v.Id, v]));

 type Txn = { date: string; amount: number; description?: string };
 const buckets = new Map<string, { vendor: string; source: 'vendor' | 'line'; txns: Txn[]; notes: string }>();

 function add(key: string, vendor: string, source: 'vendor' | 'line', txn: Txn, note?: string) {
 const cur = buckets.get(key);
 if (cur) {
 cur.txns.push(txn);
 } else {
 buckets.set(key, { vendor, source, txns: [txn], notes: note ?? '' });
 }
 }

 for (const p of purchases) {
 // Prefer vendor-attached when available - gives stable grouping
 if (p.EntityRef?.value && p.EntityRef.type === 'Vendor') {
 const v = vendorsById.get(p.EntityRef.value);
 const name = v?.DisplayName ?? p.EntityRef.name ?? `Vendor ${p.EntityRef.value}`;
 add(`v:${p.EntityRef.value}`, name, 'vendor', { date: p.TxnDate, amount: p.TotalAmt });
 continue;
 }
 // Otherwise group by normalized line description
 for (const ln of p.Line ?? []) {
 if (!ln.Description || !ln.Amount) continue;
 const norm = normalizeMerchant(ln.Description);
 if (norm.length < 3) continue;
 add(`l:${norm}`, norm, 'line', { date: p.TxnDate, amount: ln.Amount, description: ln.Description });
 }
 }

 for (const b of bills) {
 if (b.VendorRef?.value) {
 const v = vendorsById.get(b.VendorRef.value);
 const name = v?.DisplayName ?? b.VendorRef.name ?? `Vendor ${b.VendorRef.value}`;
 add(`v:${b.VendorRef.value}`, name, 'vendor', { date: b.TxnDate, amount: b.TotalAmt });
 }
 }

 const subs: DetectedSub[] = [];
 for (const [, bucket] of buckets) {
 const txns = bucket.txns.slice().sort((a, b) => a.date.localeCompare(b.date));
 if (txns.length < 3) continue;

 const monthSet = new Set(txns.map((t) => t.date.slice(0, 7)));
 if (monthSet.size < 3) continue;

 const amounts = txns.map((t) => t.amount);
 const medAmount = median(amounts);
 if (medAmount < 5) continue;

 const mean = amounts.reduce((s, v) => s + v, 0) / amounts.length;
 const variance = amounts.reduce((s, v) => s + (v - mean) ** 2, 0) / amounts.length;
 const stdev = Math.sqrt(variance);
 const cv = mean > 0 ? stdev / mean : 0;

 const days = txns.map((t) => Number(t.date.slice(8, 10)));
 const medDay = Math.max(1, Math.min(31, Math.round(median(days))));

 // Compute average gap (days) between consecutive charges
 let gapSum = 0;
 for (let i = 1; i < txns.length; i++) {
 const diff =
 (Date.UTC(
 Number(txns[i].date.slice(0, 4)),
 Number(txns[i].date.slice(5, 7)) - 1,
 Number(txns[i].date.slice(8, 10)),
 ) -
 Date.UTC(
 Number(txns[i - 1].date.slice(0, 4)),
 Number(txns[i - 1].date.slice(5, 7)) - 1,
 Number(txns[i - 1].date.slice(8, 10)),
 )) /
 (1000 * 60 * 60 * 24);
 gapSum += diff;
 }
 const avgGap = (txns.length - 1) > 0 ? gapSum / (txns.length - 1) : 0;

 let pattern: DetectedSub['pattern'];
 if (avgGap > 45) pattern = 'PERIODIC';
 else if (cv < 0.05) pattern = 'FIXED';
 else pattern = 'VARIABLE';

 // Heuristic skip: if the cadence is wildly irregular (very high gap variance)
 // AND amounts are highly variable, this is probably not a real subscription.
 if (avgGap > 200 && cv > 0.6) continue;

 subs.push({
 source: bucket.source,
 vendor: bucket.vendor,
 monthly: Math.round(medAmount * 100) / 100,
 billDay: medDay,
 weekOfMonth: weekOfMonth(medDay),
 pattern,
 txnCount: txns.length,
 monthsObserved: monthSet.size,
 lastSeen: txns[txns.length - 1].date,
 firstSeen: txns[0].date,
 amountStability: Math.max(0, Math.min(1, 1 - cv)),
 avgGapDays: Math.round(avgGap),
 notes: bucket.notes,
 history: txns.slice(-12),
 });
 }

 // Sort: monthly desc
 subs.sort((a, b) => b.monthly - a.monthly);

 return {
 asOf: new Date().toISOString(),
 realmId: tok.realmId,
 lookbackMonths,
 since: sinceStr,
 totals: {
 vendors: vendors.length,
 purchases: purchases.length,
 bills: bills.length,
 mergedBuckets: buckets.size,
 },
 subs,
 };
}
