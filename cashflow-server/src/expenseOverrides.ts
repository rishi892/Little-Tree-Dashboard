/**
 * Manual EXPENSE overrides - a per-head monthly-amount the user types in the
 * Expenses → Edit tab. Display-only: these adjust what the Expense tab shows,
 * they do NOT feed the 13-week cashflow (per user: "sirf expense tab me").
 *
 * Storage: one durable row in the qb_cache KV table (key below). qb_cache rows
 * are never deleted by cache invalidation (dropDurableMem is in-memory only),
 * so user edits persist across restarts and cache clears.
 *
 * Schema: { [headName]: monthlyAmount }  e.g. { "Payroll": 75000 }
 */

import { dbSelectOne, dbUpsert } from './db.js';

export type ExpenseOverride = { value: number; by: string; at: string };
export type ExpenseOverrides = Record<string, ExpenseOverride>;

const CACHE_KEY = 'expense-value-overrides';

let cache: ExpenseOverrides | null = null;

export async function loadExpenseOverrides(): Promise<ExpenseOverrides> {
 if (cache) return cache;
 try {
  const row = await dbSelectOne<{ data: ExpenseOverrides }>('qb_cache', `key=eq.${CACHE_KEY}`);
  cache = row?.data ?? {};
 } catch {
  cache = {};
 }
 return cache;
}

/** Save the head -> monthly-amount map, stamping each CHANGED head with the
 *  editor (`by`) + time. Unchanged heads keep their existing attribution. Zero
 *  / blank entries are dropped (head falls back to the QB value). */
export async function saveExpenseOverrides(values: Record<string, number>, by: string): Promise<ExpenseOverrides> {
 const at = new Date().toISOString();
 const prev = await loadExpenseOverrides();
 const next: ExpenseOverrides = {};
 for (const [head, v] of Object.entries(values ?? {})) {
  const n = Number(v);
  if (!head || !Number.isFinite(n) || n === 0) continue;
  const val = +n.toFixed(2);
  const existing = prev[head];
  next[head] = existing && existing.value === val
   ? existing                                    // unchanged - keep who set it
   : { value: val, by: (by || 'Unknown').slice(0, 60), at };
 }
 cache = next;
 await dbUpsert('qb_cache', { key: CACHE_KEY, data: next, updated_at: at });
 return next;
}
