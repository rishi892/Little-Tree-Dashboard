/**
 * Durable-cached accessor for the 13-week cashflow, SHARED by the API route and
 * the assistant snapshot so neither recomputes the heavy 13-week from scratch.
 *
 * Before this existed the bot's buildSnapshot() called getCashflow13Week()
 * directly - a full live recompute (sequential QB + sheet pulls) on every cold
 * serverless instance, which made the first bot question take 30-60s or time
 * out. Routing the bot through the same durable cache the dashboard uses means
 * it reads the last-good 13-week instantly (and stays in lock-step with the
 * numbers shown on screen).
 *
 * The cache key carries an edits fingerprint (future direction) so a sales /
 * expense edit re-flows the same-week + lagged-AR split immediately instead of
 * waiting out the 5-min TTL.
 */
import { getCashflow13Week } from './cashflow13.js';
import { withDurableCache } from './qbCache.js';

async function cashflowEditsFingerprint(): Promise<string> {
  try {
    const { loadCashflowEdits } = await import('./cashflowEdits.js');
    const edits = await loadCashflowEdits();
    const keys = Object.keys(edits).sort();
    let h = 5381;
    for (const k of keys) {
      const s = `${k}:${edits[k].value}:${edits[k].at ?? ''}`;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return `${keys.length}-${h.toString(36)}`;
  } catch {
    return '0';
  }
}

export async function getCashflow13WeekCached(direction: 'future' | 'past', force = false) {
  // v6: cache key carries an edits fingerprint (future) so a sales edit re-flows
  // the same-week + lagged-AR split immediately instead of after the 5-min TTL.
  const fp = direction === 'future' ? await cashflowEditsFingerprint() : '0';
  return withDurableCache(
    `cashflow-13week:v6:${direction}:${fp}`,
    5 * 60 * 1000,
    () => getCashflow13Week(direction === 'past' ? { direction: 'past' } : undefined),
    (d) => {
      const r = d as { weeks?: unknown[]; warnings?: string[] };
      if (!Array.isArray(r.weeks) || r.weeks.length === 0) return false;
      // Self-heal: never cache a DEGRADED compute - one where a transient sheet
      // or QB hiccup zeroed a major budget component (outflows, Gelato AR, the AR
      // projection, or the sales forecast). Caching it would freeze a wrong budget
      // for the TTL, and because the durable cache is SHARED local<->prod it makes
      // the two show wildly different numbers (e.g. Gelato $0 vs $554k). Reject so
      // the last-GOOD value keeps serving until a fully-healthy recompute lands.
      const degraded = /expense fetch failed|gelato ar fetch failed|ar projection failed|sales forecast failed/i;
      if (r.warnings?.some((w) => degraded.test(w))) return false;
      return true;
    },
    force,
  );
}
