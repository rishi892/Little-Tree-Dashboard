/**
 * Unified cashflow CELL edits - every manual override on the 13-week grid
 * (inflow Sales/AR rows AND outflow expense rows), persisted to Supabase with
 * attribution: who made the edit and when. Replaces the old localStorage
 * what-if store so edits survive reloads, are shared across users, and carry
 * the editor's name.
 *
 * Key format: `${rowLabel}|${weekStart}` (weekStart = YYYY-MM-DD Monday). Keying
 * by DATE (not week index) means an edit sticks to its week even as the 13-week
 * window rolls forward.
 *
 * Storage: one durable row in qb_cache (never deleted by cache invalidation).
 */

import { dbSelectOne, dbUpsert } from './db.js';

export type CellEdit = { value: number; by: string; at: string };
export type CashflowEdits = Record<string, CellEdit>;

const CACHE_KEY = 'cashflow-cell-edits';

let cache: CashflowEdits | null = null;

export async function loadCashflowEdits(): Promise<CashflowEdits> {
 if (cache) return cache;
 try {
  const row = await dbSelectOne<{ data: CashflowEdits }>('qb_cache', `key=eq.${CACHE_KEY}`);
  cache = row?.data ?? {};
 } catch {
  cache = {};
 }
 return cache;
}

/**
 * Apply a batch of set/clear operations. Each `set` entry is stamped with the
 * editor (`by`) and timestamp (`at`) - so the row reflects whoever last touched
 * that specific cell. `clear` removes the override (falls back to computed).
 */
export async function applyCashflowEdits(
 set: Record<string, number>,
 clear: string[],
 by: string,
): Promise<CashflowEdits> {
 const at = new Date().toISOString();
 const cur: CashflowEdits = { ...(await loadCashflowEdits()) };
 for (const [k, v] of Object.entries(set ?? {})) {
  const n = Number(v);
  if (k && Number.isFinite(n)) cur[k] = { value: +n.toFixed(2), by: (by || 'Unknown').slice(0, 60), at };
 }
 for (const k of clear ?? []) delete cur[k];
 cache = cur;
 await dbUpsert('qb_cache', { key: CACHE_KEY, data: cur, updated_at: at });
 return cur;
}
