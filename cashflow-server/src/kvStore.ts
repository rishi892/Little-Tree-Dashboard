/**
 * Persistence shim. Locally (and on any long-running Node host) it reads/writes
 * JSON files exactly as before. On a serverless/ephemeral host (Vercel) the
 * filesystem is read-only and resets between invocations, so when SUPABASE_URL +
 * SUPABASE_SERVICE_KEY are set it transparently stores the same JSON blobs in a
 * Supabase `kv_store` table instead - keyed by the original filename.
 *
 * Supabase table (run once in the SQL editor):
 *   create table if not exists kv_store (
 *     key text primary key,
 *     value jsonb,
 *     updated_at timestamptz default now()
 *   );
 *   alter table kv_store enable row level security;  -- service key bypasses RLS
 *
 * Uses the PostgREST endpoint directly (fetch) - no SDK dependency, serverless-safe.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPA_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const useSupabase = Boolean(SUPA_URL && SUPA_KEY);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Local fallback: the same place the old code wrote (cashflow-server/<file>).
const DATA_DIR = path.resolve(__dirname, '..');

function supaHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SUPA_KEY as string, Authorization: `Bearer ${SUPA_KEY}`, ...extra };
}

/** Read a JSON blob by its (file)name, or return `fallback` if missing. */
export async function readJson<T>(name: string, fallback: T): Promise<T> {
  if (useSupabase) {
    try {
      const res = await fetch(`${SUPA_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(name)}&select=value`, {
        headers: supaHeaders(),
      });
      if (!res.ok) return fallback;
      const rows = (await res.json()) as Array<{ value: T }>;
      return rows.length ? rows[0].value : fallback;
    } catch {
      return fallback;
    }
  }
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write a JSON blob under its (file)name (upsert on Supabase). */
export async function writeJson(name: string, data: unknown): Promise<void> {
  if (useSupabase) {
    await fetch(`${SUPA_URL}/rest/v1/kv_store`, {
      method: 'POST',
      headers: supaHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify({ key: name, value: data, updated_at: new Date().toISOString() }),
    });
    return;
  }
  await fs.writeFile(path.join(DATA_DIR, name), JSON.stringify(data, null, 2), 'utf8');
}

/** True when running against Supabase (serverless/production). */
export const persistenceIsRemote = useSupabase;

const MISSING = Symbol('missing');

/**
 * Drop-in replacement for the two `fs/promises` calls the JSON stores use
 * (readFile / writeFile). Lets a module switch persistence with a one-line
 * import swap: `import { fileStore as fs } from './kvStore.js'` and a filename
 * key instead of an absolute path. readFile throws an ENOENT-shaped error when
 * absent so existing try/catch "not found" handling keeps working.
 */
export const fileStore = {
  async readFile(key: string, _enc?: BufferEncoding): Promise<string> {
    const obj = await readJson<unknown>(key, MISSING as unknown);
    if (obj === MISSING) {
      const e = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    }
    return JSON.stringify(obj);
  },
  async writeFile(key: string, data: string, _enc?: BufferEncoding): Promise<void> {
    await writeJson(key, JSON.parse(data));
  },
};
