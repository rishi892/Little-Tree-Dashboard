/**
 * QuickBooks app OAuth config (client id, client secret, redirect uri,
 * environment). Stored in the qb_config table (single row, id=1) so the WHOLE
 * QB connection - not just the tokens - lives durably in the database and never
 * depends on a fragile env var. Per-field fallback to env vars keeps local dev
 * and first-boot (empty table) working.
 *
 * Read with the service_role key, server-side only. Never expose to the browser.
 */
import { dbSelectOne } from './db.js';

export type QbConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  environment: 'production' | 'sandbox';
};

type Row = { client_id: string; client_secret: string; redirect_uri: string; environment: string };

const ENV_FALLBACK: QbConfig = {
  clientId: process.env.QBO_CLIENT_ID ?? '',
  clientSecret: process.env.QBO_CLIENT_SECRET ?? '',
  redirectUri: process.env.QBO_REDIRECT_URI ?? 'http://localhost:4747/auth/callback',
  environment: (process.env.QBO_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production'),
};

// Cache the merged config briefly so we don't hit the DB on every QB call, but
// expire fast so an admin edit to qb_config is picked up within seconds.
let cache: QbConfig | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 30_000;

/** DB row -> config, with per-field env fallback for any empty/missing column. */
export async function loadQbConfig(): Promise<QbConfig> {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  let row: Row | null = null;
  try {
    row = await dbSelectOne<Row>('qb_config', 'id=eq.1');
  } catch {
    row = null; // DB unreachable -> fall back to env entirely
  }
  const merged: QbConfig = {
    clientId: (row?.client_id || ENV_FALLBACK.clientId),
    clientSecret: (row?.client_secret || ENV_FALLBACK.clientSecret),
    redirectUri: (row?.redirect_uri || ENV_FALLBACK.redirectUri),
    environment: ((row?.environment === 'sandbox' || row?.environment === 'production')
      ? row.environment
      : ENV_FALLBACK.environment),
  };
  cache = merged;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return merged;
}

/** True when both client id and secret are present (from DB or env). */
export async function qbCredsConfigured(): Promise<boolean> {
  const c = await loadQbConfig();
  return Boolean(c.clientId && c.clientSecret);
}

/** QB REST API base for the configured environment. */
export async function qbApiBase(): Promise<string> {
  const c = await loadQbConfig();
  return c.environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

export function invalidateQbConfigCache(): void {
  cache = null;
  cacheExpiresAt = 0;
}
