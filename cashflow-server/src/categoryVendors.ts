/**
 * Per-VENDOR breakdown of one or more QB expense accounts - used to explode an
 * outflow line (e.g. Software & Subscriptions) into the actual vendors that hit
 * its accounts (HubSpot, Notion, Slack, ...) instead of the bare account names.
 *
 * Vendor weights are RELATIVE (sum of each vendor's transaction amounts in the
 * account's lookback). The caller scales them to the line's run-rate, so the
 * breakdown reconciles to the line and never double-counts spend booked under a
 * different head.
 *
 * Durable-cached (Supabase) per account-set so cashflow13 reads it cheaply and
 * the heavy per-account transaction pulls happen at most once per hour.
 */
import { getAccountTransactions } from './accountTransactions.js';
import { withDurableCache } from './qbCache.js';

export type VendorAmount = { label: string; monthly: number };

/**
 * Many subscriptions are paid by card and have NO QB VendorRef - only a messy
 * bank-descriptor memo like "NOTION LABS, INC. SAN FRANCISCO CA XXXX1025" or
 * "8230509H1EHM6A418 CANVA* AUSTIN TX". Pull a readable name out of the memo so
 * the breakdown shows the real subscription instead of one big "uncategorized".
 */
function nameFromMemo(memo: string): string {
 let s = (memo || '').toUpperCase().trim();
 if (!s) return 'Other / uncategorized';
 s = s.split(/\s+X{3,}\d+/)[0];          // drop "XXXX1025" card tail
 s = s.replace(/#\d.*$/, '');             // drop "#0234 ..." tail
 s = s.replace(/^\d{5,}\s+/, '');         // leading transaction ref code
 s = s.replace(/^(SQ|TST|BT|PY|PP|POS|TLF|IN)\s*\*\s*/i, ''); // SQ* BT* etc.
 s = s.replace(/^PAYPAL\s*\*\s*/i, '');
 s = s.replace(/^PADDLE\.NET\s*\*\s*/i, 'PADDLE ');
 s = s.replace(/[*]/g, ' ');
 const tokens = s.split(/[\s,.]+/).filter(Boolean);
 if (tokens.length === 0) return 'Other / uncategorized';
 let name = tokens[0];
 if (name.length <= 3 && tokens[1]) name = `${name} ${tokens[1]}`; // e.g. "BT DIALPAD" already stripped
 return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

async function aggregate(accountNames: string[]): Promise<VendorAmount[]> {
 const byVendor = new Map<string, number>();
 for (const acct of accountNames) {
  let r;
  try { r = await getAccountTransactions(acct); } catch { continue; }
  for (const t of r.transactions ?? []) {
   const amt = Number(t.amount) || 0;
   if (!amt) continue;
   const v = (t.vendor || '').trim() || nameFromMemo(t.memo || '');
   byVendor.set(v, (byVendor.get(v) ?? 0) + amt);
  }
 }
 return [...byVendor.entries()]
  .map(([label, total]) => ({ label, monthly: total }))
  .filter((v) => v.monthly > 0)
  .sort((a, b) => b.monthly - a.monthly);
}

export function getVendorBreakdownForAccounts(accountNames: string[], force = false): Promise<VendorAmount[]> {
 const names = accountNames.filter(Boolean);
 if (names.length === 0) return Promise.resolve([]);
 const key = 'cat-vendors:v2:' + [...names].sort().join('|');
 return withDurableCache(key, 60 * 60 * 1000, () => aggregate(names), (d) => Array.isArray(d) && d.length > 0, force).then((r) => r.data);
}
