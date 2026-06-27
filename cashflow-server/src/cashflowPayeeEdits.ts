/**
 * Per-PAYEE cashflow cell edits - the breakdown-level overrides behind an
 * outflow line on the Expense Edit page. Each outflow line (Payroll, Inventory,
 * Software, Other) explodes into the QB accounts / payees that feed it; this
 * store keeps a per-payee, per-week override with attribution (who + when).
 *
 * Key format: `${lineLabel}::${payeeLabel}|${weekStart}` (weekStart = YYYY-MM-DD
 * Monday). Keying by DATE (not index) makes an edit stick to its week as the
 * 13-week window rolls forward. The line-level roll-up (sum of payees) is still
 * written to the shared cashflow-cell-edits store so the 13-Week grid + dashboard
 * reflect it without the engine needing to know about payees.
 *
 * Storage: one durable row in qb_cache (never deleted by cache invalidation),
 * mirroring cashflowEdits.ts.
 */

import { dbSelectOne, dbUpsert } from './db.js';

export type CellEdit = { value: number; by: string; at: string; reason?: string };
export type PayeeEdits = Record<string, CellEdit>;

const CACHE_KEY = 'cashflow-payee-edits';

let cache: PayeeEdits | null = null;

export async function loadPayeeEdits(): Promise<PayeeEdits> {
 if (cache) return cache;
 try {
  const row = await dbSelectOne<{ data: PayeeEdits }>('qb_cache', `key=eq.${CACHE_KEY}`);
  cache = row?.data ?? {};
 } catch {
  cache = {};
 }
 return cache;
}

export async function applyPayeeEdits(
 set: Record<string, number>,
 clear: string[],
 by: string,
 reasons: Record<string, string> = {},
): Promise<PayeeEdits> {
 const at = new Date().toISOString();
 const cur: PayeeEdits = { ...(await loadPayeeEdits()) };
 for (const [k, v] of Object.entries(set ?? {})) {
  const n = Number(v);
  if (k && Number.isFinite(n)) {
   const reason = typeof reasons[k] === 'string' ? reasons[k].slice(0, 280) : undefined;
   cur[k] = { value: +n.toFixed(2), by: (by || 'Unknown').slice(0, 60), at, ...(reason ? { reason } : {}) };
  }
 }
 for (const [k, r] of Object.entries(reasons ?? {})) {
  if (k in (set ?? {})) continue;
  if (cur[k]) cur[k] = { ...cur[k], reason: typeof r === 'string' && r.trim() ? r.slice(0, 280) : undefined, by: (by || cur[k].by), at };
 }
 for (const k of clear ?? []) delete cur[k];
 cache = cur;
 await dbUpsert('qb_cache', { key: CACHE_KEY, data: cur, updated_at: at });
 return cur;
}
