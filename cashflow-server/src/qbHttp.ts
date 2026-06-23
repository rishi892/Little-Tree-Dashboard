/**
 * Single choke point for every QuickBooks Online HTTP call.
 *
 * Just a retry with short backoff for transient throttling (429) / 5xx. We do
 * NOT cap concurrency here: an earlier in-memory semaphore leaked slots when a
 * serverless invocation was killed at the 60s timeout (the `finally` release
 * never ran), which poisoned the instance so every later QB call hung forever.
 * Better to fail a call fast and let the caller's durable cache serve last-good.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a QBO URL with the bearer token, retrying transient throttling (429)
 * and server errors (5xx) with SHORT backoff (so we fail fast under sustained
 * throttling instead of hanging). Returns a guaranteed-OK Response, or throws.
 */
export async function qboFetch(url: string, accessToken: string): Promise<Response> {
  let lastBody = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    } catch (e) {
      lastStatus = 0;
      lastBody = e instanceof Error ? e.message : String(e);
      if (attempt === 2) break;
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (res.ok) return res;
    lastStatus = res.status;
    lastBody = await res.text().catch(() => '');
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 2) break;
      const ra = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 && ra <= 3
        ? ra * 1000
        : 500 * (attempt + 1) + Math.floor(Math.random() * 200); // 0.5s, 1s
      await sleep(waitMs);
      continue;
    }
    // Non-retryable (e.g. 401/403/400) - surface immediately.
    throw new Error(`QBO request failed (${res.status}): ${lastBody}`);
  }
  throw new Error(`QBO throttled (last ${lastStatus || 'network'}) after retries: ${lastBody}`);
}
