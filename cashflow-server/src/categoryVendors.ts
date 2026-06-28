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
import { dbSelectOne, dbUpsert } from './db.js';
import { waitUntil } from '@vercel/functions';

export type VendorAmount = { label: string; monthly: number };

const TTL_MS = 60 * 60 * 1000; // 1h
const mem = new Map<string, { data: VendorAmount[]; at: number }>();
const inflight = new Set<string>();

/** Run a warm in the background, guaranteed to finish on Vercel (waitUntil) and
 *  best-effort locally, so a cold cache never blocks the caller. */
function bg(p: Promise<unknown>): void {
  const done = p.catch(() => {});
  try { waitUntil(done); } catch { void done; }
}

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

/** Recompute the breakdown and persist it (mem + durable Supabase). Coalesced so
 *  two concurrent callers don't both pull the heavy account transactions. */
async function warm(key: string, names: string[]): Promise<VendorAmount[]> {
 if (inflight.has(key)) return mem.get(key)?.data ?? [];
 inflight.add(key);
 try {
  const data = await aggregate(names);
  if (data.length > 0) {
   mem.set(key, { data, at: Date.now() });
   void dbUpsert('qb_cache', { key, data, updated_at: new Date().toISOString() }).catch(() => {});
  }
  return data;
 } finally {
  inflight.delete(key);
 }
}

/**
 * NON-BLOCKING vendor breakdown. Returns the cached value (in-mem or durable
 * Supabase) instantly, and on a COLD cache returns [] right away while warming
 * in the background. This matters because cashflow13's heavy 13-week recompute
 * calls us inline: a cold blocking call here is two full account-transaction
 * pulls that alone can push the recompute past the serverless 60s limit (504).
 * The Software line falls back to its bare account names until the warm lands,
 * then enriches to real vendors on the next read. The opening cash, inflow and
 * outflow TOTALS never depend on this, so deferring it is purely cosmetic.
 */
export async function getVendorBreakdownForAccounts(accountNames: string[], force = false): Promise<VendorAmount[]> {
 const names = accountNames.filter(Boolean);
 if (names.length === 0) return [];
 const key = 'cat-vendors:v2:' + [...names].sort().join('|');
 const now = Date.now();

 const m = mem.get(key);
 if (!force && m && now - m.at < TTL_MS) return m.data;

 // Durable last-good (one fast single-row read).
 let durable: { data: VendorAmount[]; at: number } | null = null;
 try {
  const row = await dbSelectOne<{ data: VendorAmount[]; updated_at: string }>('qb_cache', `key=eq.${encodeURIComponent(key)}`);
  if (row && Array.isArray(row.data)) durable = { data: row.data, at: Date.parse(row.updated_at) };
 } catch { /* DB blip - fall through */ }

 const best = (m && durable) ? (m.at >= durable.at ? m : durable) : (m ?? durable);
 if (best) mem.set(key, best);

 // Have a good value → serve it now; refresh in the background if forced/stale.
 if (best && best.data.length > 0) {
  if (force || now - best.at >= TTL_MS) bg(warm(key, names));
  return best.data;
 }

 // Cold (no good value) → warm in the background, return [] immediately.
 bg(warm(key, names));
 return [];
}
