/**
 * Manual expense HEADS added on the Expense Edit page - payees/heads that are
 * NOT in the QB-derived breakdown of an outflow line (e.g. a new vendor the
 * owner wants to budget before it shows up in QuickBooks). Each head stores a
 * name + free-text details; its per-week AMOUNTS reuse the per-payee edit store
 * (key `${line}::${name}|${weekStart}`) and roll up into the line total like any
 * other payee.
 *
 * Storage: one durable row in qb_cache, key `cashflow-manual-heads`, shape
 * `Record<lineLabel, ManualHead[]>`.
 */

import { dbSelectOne, dbUpsert } from './db.js';

export type ManualHead = { name: string; details: string; by: string; at: string };
export type ManualHeads = Record<string, ManualHead[]>;

const CACHE_KEY = 'cashflow-manual-heads';

let cache: ManualHeads | null = null;

export async function loadManualHeads(): Promise<ManualHeads> {
 if (cache) return cache;
 try {
  const row = await dbSelectOne<{ data: ManualHeads }>('qb_cache', `key=eq.${CACHE_KEY}`);
  cache = row?.data ?? {};
 } catch {
  cache = {};
 }
 return cache;
}

async function persist(next: ManualHeads): Promise<ManualHeads> {
 cache = next;
 await dbUpsert('qb_cache', { key: CACHE_KEY, data: next, updated_at: new Date().toISOString() });
 return next;
}

/** Add (or update the details of) a manual head on a line. Name is the identity;
 *  re-adding the same name just updates its details. */
export async function addManualHead(line: string, name: string, details: string, by: string): Promise<ManualHeads> {
 const ln = (line || '').trim(); const nm = (name || '').trim();
 if (!ln || !nm) throw new Error('line and name required');
 const cur: ManualHeads = { ...(await loadManualHeads()) };
 const list = [...(cur[ln] ?? [])];
 const at = new Date().toISOString();
 const idx = list.findIndex((h) => h.name.toLowerCase() === nm.toLowerCase());
 const head: ManualHead = { name: nm.slice(0, 80), details: (details || '').slice(0, 280), by: (by || 'Unknown').slice(0, 60), at };
 if (idx >= 0) list[idx] = head; else list.push(head);
 cur[ln] = list;
 return persist(cur);
}

/** Remove a manual head from a line. Its per-week amounts (in the payee-edit
 *  store) should be cleared separately by the caller. */
export async function removeManualHead(line: string, name: string): Promise<ManualHeads> {
 const ln = (line || '').trim(); const nm = (name || '').trim().toLowerCase();
 const cur: ManualHeads = { ...(await loadManualHeads()) };
 if (cur[ln]) {
  cur[ln] = cur[ln].filter((h) => h.name.toLowerCase() !== nm);
  if (cur[ln].length === 0) delete cur[ln];
 }
 return persist(cur);
}
