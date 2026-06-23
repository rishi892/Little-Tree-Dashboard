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

export async function withDurableCache<T>(
  key: string,
  ttlMs: number,
  produce: () => Promise<T>,
  /** Returns true only for a "good" result worth caching (e.g. QB populated, no
   *  auth warning). A non-good result never overwrites the last good value. */
  isGood: (v: T) => boolean,
  force = false,
): Promise<CacheResult<T>> {
  const now = Date.now();
  const m = mem.get(key) as Entry<T> | undefined;
  if (!force && m && now - m.at < ttlMs) return { data: m.data, cached: true };

  // Load the durable last-good value (also our fallback if recompute fails).
  let durable: Entry<T> | null = null;
  try {
    const row = await dbSelectOne<{ data: T; updated_at: string }>('qb_cache', `key=eq.${encodeURIComponent(key)}`);
    if (row) durable = { data: row.data, at: Date.parse(row.updated_at) };
  } catch {
    /* DB blip - fall through to in-memory / recompute */
  }
  if (!force && durable && now - durable.at < ttlMs) {
    mem.set(key, durable);
    return { data: durable.data, cached: true };
  }

  const fallback = m ?? durable; // best last-good we have

  // Coalesce concurrent recomputes for the same key.
  if (inflight.has(key)) {
    try {
      const data = (await inflight.get(key)) as T;
      return { data, cached: false };
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
      // fire-and-forget durable write (don't block the response on it)
      void dbUpsert('qb_cache', { key, data, updated_at: new Date().toISOString() }).catch(() => {});
      return { data, cached: false };
    }
    // Degraded result (e.g. QB momentarily empty) - prefer the last good value.
    if (fallback) return { data: fallback.data, cached: true };
    return { data, cached: false };
  } catch (e) {
    if (fallback) return { data: fallback.data, cached: true };
    throw e;
  } finally {
    inflight.delete(key);
  }
}
