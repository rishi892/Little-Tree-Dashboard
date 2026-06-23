import { dbSelectOne, dbUpsert, dbDelete } from './db.js';

type TokenRow = { realm_id: string; access_token: string; refresh_token: string; expires_at: number };

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
 const row = await dbSelectOne<TokenRow>('qb_tokens', 'order=updated_at.desc');
 const parsed = row && {
   accessToken: row.access_token,
   refreshToken: row.refresh_token,
   realmId: row.realm_id,
   expiresAt: Number(row.expires_at),
 };
 if (!isValidTokenShape(parsed)) {
   if (parsed) console.warn('[tokenStore] stored tokens are malformed - ignoring');
   cache = null;
   return null;
 }
 cache = parsed;
 cacheExpiresAt = Date.now() + CACHE_TTL_MS;
 return cache;
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
 if (!isValidTokenShape(tokens)) {
   // Refuse to persist garbage - would brick the next refresh cycle.
   throw new Error('[tokenStore] refused to save malformed token payload');
 }
 cache = tokens;
 cacheExpiresAt = Date.now() + CACHE_TTL_MS;
 await dbUpsert('qb_tokens', {
   realm_id: tokens.realmId,
   access_token: tokens.accessToken,
   refresh_token: tokens.refreshToken,
   expires_at: tokens.expiresAt,
   updated_at: new Date().toISOString(),
 });
 console.log(`[tokenStore] saved tokens (expiresAt=${new Date(tokens.expiresAt).toISOString()})`);
}

export async function clearTokens(): Promise<void> {
 cache = null;
 cacheExpiresAt = 0;
 await dbDelete('qb_tokens', 'realm_id=not.is.null');
}

/** Force the next loadTokens() call to re-read from disk. Used by the OAuth
 * refresh path when a "refresh token invalid" error is observed - the user
 * may have re-OAuth'd in another tab, writing fresh tokens to disk that we
 * haven't picked up yet. */
export function invalidateTokenCache(): void {
 cache = null;
 cacheExpiresAt = 0;
}
