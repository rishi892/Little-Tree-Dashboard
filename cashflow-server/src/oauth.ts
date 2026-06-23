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

 // Still well within expiry → return current tokens.
 if (Date.now() < tokens.expiresAt - REFRESH_LEAD_MS) {
 return tokens;
 }

 // Another refresh is already in flight in THIS instance → share its result.
 if (refreshInFlight) return refreshInFlight;

 refreshInFlight = doRefresh(tokens).finally(() => {
 refreshInFlight = null;
 });
 return refreshInFlight;
}

/** Coordinate the refresh across all instances, then perform it. */
async function doRefresh(current: StoredTokens): Promise<StoredTokens> {
 const won = await acquireRefreshLock(current.realmId);
 if (!won) {
 // Another instance is refreshing right now. Wait for it to write a fresh
 // token rather than racing Intuit (which would trip reuse-detection).
 const fresh = await waitForFreshToken(current.expiresAt);
 if (fresh) return fresh;
 // Holder hung/crashed and the lock TTL has elapsed → claim it and do it
 // ourselves as a last resort.
 await acquireRefreshLock(current.realmId);
 }
 return performIntuitRefresh(current);
}

/** Poll the DB until a token newer than `staleExpiry` appears (someone else
 * refreshed) or we give up. */
async function waitForFreshToken(staleExpiry: number): Promise<StoredTokens | null> {
 const deadline = Date.now() + 14_000;
 while (Date.now() < deadline) {
 await sleep(400);
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
