/**
 * Thin Supabase PostgREST helper for the proper relational tables (app_users,
 * login_events, bot_conversations). Separate from kvStore (which is for opaque
 * JSON blobs). No SDK - just fetch against the REST endpoint with the
 * service_role key. Disabled (no-op) when Supabase isn't configured.
 */

const SUPA_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export const dbEnabled = Boolean(SUPA_URL && SUPA_KEY);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SUPA_KEY as string, Authorization: `Bearer ${SUPA_KEY}`, ...extra };
}

/** Run a PostgREST select. `query` is the raw query string (filters, select). */
export async function dbSelect<T = Record<string, unknown>>(table: string, query = ''): Promise<T[]> {
  if (!dbEnabled) return [];
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}${query ? '?' + query : ''}`, { headers: headers() });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

/** Insert a row (fire-and-forget; failures are swallowed). */
export async function dbInsert(table: string, row: Record<string, unknown>): Promise<void> {
  if (!dbEnabled) return;
  try {
    await fetch(`${SUPA_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify(row),
    });
  } catch {
    /* best-effort */
  }
}
