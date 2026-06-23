import crypto from 'node:crypto';
import OAuthClient from 'intuit-oauth';
import { loadQbConfig } from './qbConfig.js';
import { loadTokens, loadTokensFresh, saveTokens, acquireRefreshLock, type StoredTokens } from './tokenStore.js';

// The OAuth client is built from the qb_config table (client id/secret/redirect/
// environment). Rebuild only when those values actually change, so an admin edit
// to qb_config is picked up without a restart.
let _client: OAuthClient | null = null;
let _clientSig = '';
async function getOauthClient(): Promise<OAuthClient> {
 const c = await loadQbConfig();
 const sig = `${c.clientId}|${c.clientSecret}|${c.environment}|${c.redirectUri}`;
 if (_client && sig === _clientSig) return _client;
 _client = new OAuthClient({
 clientId: c.clientId,
 clientSecret: c.clientSecret,
 environment: c.environment,
 redirectUri: c.redirectUri,
 });
 _clientSig = sig;
 return _client;
}

export async function buildAuthUrl(): Promise<string> {
 const client = await getOauthClient();
 return client.authorizeUri({
 scope: [OAuthClient.scopes.Accounting],
 state: crypto.randomBytes(16).toString('hex'),
 });
}

type IntuitTokenJson = {
 access_token: string;
 refresh_token: string;
 expires_in: number; // seconds
 x_refresh_token_expires_in?: number;
};

export async function exchangeCodeForTokens(reqUrl: string, realmId: string): Promise<StoredTokens> {
 const client = await getOauthClient();
 const authResponse = await client.createToken(reqUrl);
 const json = authResponse.getJson() as IntuitTokenJson;
 const tokens: StoredTokens = {
 accessToken: json.access_token,
 refreshToken: json.refresh_token,
 realmId,
 expiresAt: Date.now() + json.expires_in * 1000,
 };
 await saveTokens(tokens);
 return tokens;
}

/**
 * Refresh-token rotation guard. Intuit rotates the refresh_token on every
 * /refresh call and runs token-reuse detection: if two callers refresh with the
 * SAME refresh_token, the loser gets "invalid_grant" AND Intuit can revoke the
 * whole token family - which is what kept dropping the connection (the
 * dashboard fires many parallel QB calls, and on serverless they spread across
 * separate function instances).
 *
 * Two layers stop that now:
 *  1. refreshInFlight - dedupes refreshes WITHIN one instance.
 *  2. acquireRefreshLock() - a DB row-lock so exactly ONE instance across the
 *     whole fleet calls Intuit per rotation; everyone else waits for it to
 *     write the new token, then reuses it.
 */
let refreshInFlight: Promise<StoredTokens> | null = null;

/** Refresh this many ms BEFORE expiry. 5 min gives long-running QB queries
 * (some take 10–15s on a cold pull) plenty of headroom. */
const REFRESH_LEAD_MS = 5 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function getValidAccessToken(): Promise<StoredTokens> {
 const tokens = await loadTokens();
 if (!tokens) throw new Error('Not connected to QuickBooks. Visit /auth/connect first.');

 const now = Date.now();
 // Comfortably valid → use as-is.
 if (now < tokens.expiresAt - REFRESH_LEAD_MS) return tokens;

 // We're inside the 5-minute pre-expiry window. Because we refresh EARLY, the
 // current access token is almost always still valid here - so the golden rule
 // is: never block a request waiting on a refresh (that risks the serverless
 // function timeout and makes QB look "disconnected"). Exactly one worker does
 // the refresh; everyone else keeps using the still-valid token.
 const stillUsable = now < tokens.expiresAt - 20_000; // 20s safety margin

 // A refresh is already running in THIS instance.
 if (refreshInFlight) return stillUsable ? tokens : refreshInFlight;

 // Claim the cross-instance lock so only ONE worker calls Intuit per rotation
 // (concurrent refreshes trip Intuit's token-reuse detection and kill the
 // whole connection).
 const won = await acquireRefreshLock(tokens.realmId);
 if (!won) {
 // Another worker holds the lock. Use the still-valid token immediately; only
 // if it's genuinely on the edge of expiry do we briefly wait for the fresh one.
 if (stillUsable) return tokens;
 const fresh = await waitForFreshToken(tokens.expiresAt, 6_000);
 return fresh ?? tokens;
 }

 // We won the lock → perform the single refresh and persist it.
 refreshInFlight = performIntuitRefresh(tokens).finally(() => { refreshInFlight = null; });
 // If our token is still usable we could return it now, but we await here so the
 // new token is guaranteed saved before this serverless invocation freezes.
 return refreshInFlight;
}

/** Poll the DB until a token newer than `staleExpiry` appears (someone else
 * refreshed) or we give up. `maxMs` is kept well under the function timeout. */
async function waitForFreshToken(staleExpiry: number, maxMs = 6_000): Promise<StoredTokens | null> {
 const deadline = Date.now() + maxMs;
 while (Date.now() < deadline) {
 await sleep(350);
 const t = await loadTokensFresh();
 if (t && t.expiresAt > staleExpiry) return t;
 }
 return null;
}

async function performIntuitRefresh(current: StoredTokens): Promise<StoredTokens> {
 try {
 const client = await getOauthClient();
 client.setToken({
 access_token: current.accessToken,
 refresh_token: current.refreshToken,
 realmId: current.realmId,
 token_type: 'bearer',
 expires_in: 0,
 });
 const refreshed = await client.refresh();
 const json = refreshed.getJson() as IntuitTokenJson;
 const updated: StoredTokens = {
 accessToken: json.access_token,
 refreshToken: json.refresh_token,
 realmId: current.realmId,
 expiresAt: Date.now() + json.expires_in * 1000,
 };
 await saveTokens(updated);
 console.log(`[oauth] refreshed QB access token; valid for ${json.expires_in}s`);
 return updated;
 } catch (e) {
 // invalid_grant means another instance already rotated the refresh token.
 // Re-read the DB - the fresh token should be there.
 const msg = e instanceof Error ? e.message : String(e);
 if (/refresh token.*invalid|invalid_grant/i.test(msg)) {
 const fresh = await waitForFreshToken(current.expiresAt) ?? (await loadTokensFresh());
 if (fresh && fresh.refreshToken !== current.refreshToken) {
 console.log('[oauth] picked up fresh tokens from DB after refresh failure');
 return fresh;
 }
 }
 throw e;
 }
}
