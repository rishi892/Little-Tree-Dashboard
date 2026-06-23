import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, '..', '.tokens.json');

export type StoredTokens = {
 accessToken: string;
 refreshToken: string;
 realmId: string;
 expiresAt: number; // epoch ms
};

// Cache token reads briefly so we don't hit disk on every request, but
// expire fast so a re-OAuth (writing fresh tokens to disk from the callback
// handler) is picked up by other in-flight call chains within seconds.
let cache: StoredTokens | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 2_000;

// Validate the shape of whatever we loaded from disk. A partially-written
// or hand-edited token file used to slip through as null fields and tank
// the next QB call with a cryptic 401. Now we reject early and let the
// caller surface "Not connected".
function isValidTokenShape(t: unknown): t is StoredTokens {
 if (!t || typeof t !== 'object') return false;
 const o = t as Record<string, unknown>;
 return typeof o.accessToken === 'string'  && o.accessToken.length > 0
     && typeof o.refreshToken === 'string' && o.refreshToken.length > 0
     && typeof o.realmId === 'string'      && o.realmId.length > 0
     && typeof o.expiresAt === 'number'    && o.expiresAt > 0;
}

export async function loadTokens(): Promise<StoredTokens | null> {
 if (cache && Date.now() < cacheExpiresAt) return cache;
 try {
 const raw = await fs.readFile(TOKEN_FILE, 'utf8');
 const parsed = JSON.parse(raw);
 if (!isValidTokenShape(parsed)) {
   console.warn('[tokenStore] .tokens.json on disk is malformed - ignoring');
   cache = null;
   return null;
 }
 cache = parsed;
 cacheExpiresAt = Date.now() + CACHE_TTL_MS;
 return cache;
 } catch (e) {
   // ENOENT is the normal "not yet connected" path - only log other errors.
   const code = (e as NodeJS.ErrnoException)?.code;
   if (code && code !== 'ENOENT') {
     console.warn('[tokenStore] failed reading .tokens.json:', code);
   }
 cache = null;
 return null;
 }
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
 if (!isValidTokenShape(tokens)) {
   // Refuse to persist garbage - would brick the next refresh cycle.
   throw new Error('[tokenStore] refused to save malformed token payload');
 }
 cache = tokens;
 cacheExpiresAt = Date.now() + CACHE_TTL_MS;
 // ATOMIC WRITE: write to a temp file → fsync → rename. Without this, a
 // process kill mid-write (tsx watch restarts on code edit) can leave the
 // token file empty/corrupted - next refresh fails with "Refresh token
 // invalid" because we've lost the just-rotated token Intuit gave us.
 const data = JSON.stringify(tokens, null, 2);
 const tmp = TOKEN_FILE + '.tmp';
 const fh = await fs.open(tmp, 'w');
 try {
   await fh.writeFile(data, 'utf8');
   await fh.sync();   // force OS buffer → disk so the rename below is safe
 } finally {
   await fh.close();
 }
 await fs.rename(tmp, TOKEN_FILE);   // atomic on POSIX + modern Windows
 console.log(`[tokenStore] saved tokens (expiresAt=${new Date(tokens.expiresAt).toISOString()})`);
}

export async function clearTokens(): Promise<void> {
 cache = null;
 cacheExpiresAt = 0;
 try {
 await fs.unlink(TOKEN_FILE);
 } catch {
 // ignore
 }
}

/** Force the next loadTokens() call to re-read from disk. Used by the OAuth
 * refresh path when a "refresh token invalid" error is observed - the user
 * may have re-OAuth'd in another tab, writing fresh tokens to disk that we
 * haven't picked up yet. */
export function invalidateTokenCache(): void {
 cache = null;
 cacheExpiresAt = 0;
}
