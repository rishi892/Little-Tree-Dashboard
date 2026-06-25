/**
 * Manual SALES + AR forecast overrides - per-week amounts the user types in the
 * Sales → Edit tab. Display-only: they adjust what the Sales/AR edit view shows,
 * they do NOT feed the 13-week cashflow (mirrors the Expenses → Edit behaviour).
 *
 * Storage: one durable row in qb_cache (never deleted by cache invalidation), so
 * edits persist across restarts.
 *
 * Schema: { sales: { [weekStartYYYYMMDD]: amount }, ar: { [weekStart]: amount } }
 */

import { dbSelectOne, dbUpsert } from './db.js';

export type ForecastOverrides = {
 sales: Record<string, number>; // weekStart -> gross sales for that week
 ar: Record<string, number>;    // weekStart -> AR collections for that week
};

const CACHE_KEY = 'forecast-week-overrides';

let cache: ForecastOverrides | null = null;

const clean = (m: Record<string, number> | undefined): Record<string, number> => {
 const out: Record<string, number> = {};
 for (const [k, v] of Object.entries(m ?? {})) {
  const n = Number(v);
  if (k && Number.isFinite(n) && n !== 0) out[k] = +n.toFixed(2);
 }
 return out;
};

export async function loadForecastOverrides(): Promise<ForecastOverrides> {
 if (cache) return cache;
 try {
  const row = await dbSelectOne<{ data: ForecastOverrides }>('qb_cache', `key=eq.${CACHE_KEY}`);
  cache = { sales: row?.data?.sales ?? {}, ar: row?.data?.ar ?? {} };
 } catch {
  cache = { sales: {}, ar: {} };
 }
 return cache;
}

export async function saveForecastOverrides(next: ForecastOverrides): Promise<void> {
 cache = { sales: clean(next.sales), ar: clean(next.ar) };
 await dbUpsert('qb_cache', { key: CACHE_KEY, data: cache, updated_at: new Date().toISOString() });
}
