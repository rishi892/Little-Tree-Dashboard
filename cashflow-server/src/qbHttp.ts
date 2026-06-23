/**
 * Single choke point for every QuickBooks Online HTTP call.
 *
 * Two protections against QBO throttling (the 429s that broke pages):
 *   1. Concurrency limit - a dashboard cold-start fires ~15 panels at once;
 *      QBO throttles hard on bursts, so we cap how many QB requests run at a
 *      time per instance and queue the rest.
 *   2. Retry with backoff - a 429 or 5xx is retried (honouring Retry-After)
 *      instead of failing the whole request.
 */

const MAX_CONCURRENT = 4;
let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}
function release(): void {
  active--;
  waiters.shift()?.();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a QBO URL with the bearer token, retrying transient throttling (429)
 * and server errors (5xx) with exponential backoff. Returns a guaranteed-OK
 * Response, or throws after exhausting retries / on a non-retryable error.
 */
export async function qboFetch(url: string, accessToken: string): Promise<Response> {
  await acquire();
  try {
    let lastBody = '';
    let lastStatus = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
      } catch (e) {
        // network blip - back off and retry
        lastStatus = 0;
        lastBody = e instanceof Error ? e.message : String(e);
        await sleep(Math.min(8000, 400 * 2 ** attempt));
        continue;
      }
      if (res.ok) return res;
      lastStatus = res.status;
      lastBody = await res.text().catch(() => '');
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra > 0
          ? ra * 1000
          : Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
        await sleep(waitMs);
        continue;
      }
      // Non-retryable (e.g. 401/403/400) - surface immediately.
      throw new Error(`QBO request failed (${res.status}): ${lastBody}`);
    }
    throw new Error(`QBO throttled (last ${lastStatus || 'network'}) after retries: ${lastBody}`);
  } finally {
    release();
  }
}
