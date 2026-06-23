/**
 * Durable read-through cache for QB-derived data, so the dashboard NEVER shows a
 * broken connection. Layers:
 *   1. in-memory (fast path on a warm serverless instance)
 *   2. Supabase qb_cache table (durable - survives cold starts & redeploys)
 *   3. live recompute (only when both are stale)
 *
 * The golden rule: if we have ANY last-good value, we serve it rather than a
 * degraded/failed result. So a QB hiccup (timeout, 5xx, a refresh moment) is
 * invisible to the user - they keep seeing the last good numbers, and the cache
 * silently refreshes when QB is healthy again.
 */
import { dbSelectOne, dbUpsert } from './db.js';

type Entry<T> = { data: T; at: number };

const mem = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/** Drop the in-memory cache for a key (or all) so the next read re-fetches.
 *  The durable Supabase copy stays as the fallback. */
export function dropDurableMem(key?: string): void {
  if (key) mem.delete(key);
  else mem.clear();
}

export type CacheResult<T> = { data: T; cached: boolean };

function pickNewer<T>(a: Entry<T> | undefined | null, b: Entry<T> | null): Entry<T> | null {
  if (a && b) return a.at >= b.at ? a : b;
  return a ?? b ?? null;
}

/** Recompute (with concurrency coalescing), store on success, fall back to the
 *  last-good value on a degraded/failed result. */
async function recompute<T>(
  key: string,
  produce: () => Promise<T>,
  isGood: (v: T) => boolean,
  fallback: Entry<T> | null,
): Promise<CacheResult<T>> {
  if (inflight.has(key)) {
    try {
      return { data: (await inflight.get(key)) as T, cached: false };
    } catch {
      if (fallback) return { data: fallback.data, cached: true };
      throw new Error(`${key}: recompute failed and no cached value available`);
    }
  }
  const p = produce();
  inflight.set(key, p);
  try {
    const data = await p;
    if (isGood(data)) {
      mem.set(key, { data, at: Date.now() });
      void dbUpsert('qb_cache', { key, data, updated_at: new Date().toISOString() }).catch(() => {});
      return { data, cached: false };
    }
    if (fallback) return { data: fallback.data, cached: true };
    return { data, cached: false };
  } catch (e) {
    if (fallback) return { data: fallback.data, cached: true };
    throw e;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Stale-while-revalidate: serve a cached value INSTANTLY (even if stale) and
 * refresh it in the background, so a request never waits on QuickBooks. Only
 * blocks on a live recompute when there is no cached value at all, when forced
 * (?refresh=1), or when the cache is so old it would be misleading.
 */
export async function withDurableCache<T>(
  key: string,
  ttlMs: number,
  produce: () => Promise<T>,
  /** True only for a "good" result worth caching. A non-good result never
   *  overwrites the last good value. */
  isGood: (v: T) => boolean,
  force = false,
): Promise<CacheResult<T>> {
  const now = Date.now();
  const m = mem.get(key) as Entry<T> | undefined;
  if (!force && m && now - m.at < ttlMs) return { data: m.data, cached: true };

  // Pull the durable last-good (survives cold starts; also the refresh fallback).
  let durable: Entry<T> | null = null;
  try {
    const row = await dbSelectOne<{ data: T; updated_at: string }>('qb_cache', `key=eq.${encodeURIComponent(key)}`);
    if (row) durable = { data: row.data, at: Date.parse(row.updated_at) };
  } catch {
    /* DB blip - fall through */
  }

  const best = pickNewer(m, durable);
  if (best) mem.set(key, best); // keep the warm copy current

  // Fresh enough → serve it.
  if (!force && best && now - best.at < ttlMs) return { data: best.data, cached: true };

  // Stale but present, and not ancient → serve stale NOW, refresh in background.
  const ancient = best ? now - best.at > ttlMs * 4 : true;
  if (!force && best && !ancient) {
    void recompute(key, produce, isGood, best).catch(() => {});
    return { data: best.data, cached: true };
  }

  // No cached value / forced / ancient → block on a live recompute (rare).
  return recompute(key, produce, isGood, best);
}
