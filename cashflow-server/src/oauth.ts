import crypto from 'node:crypto';
import OAuthClient from 'intuit-oauth';
import { config } from './config.js';
import { loadTokens, saveTokens, invalidateTokenCache, type StoredTokens } from './tokenStore.js';

let _client: OAuthClient | null = null;
function getOauthClient(): OAuthClient {
 if (_client) return _client;
 _client = new OAuthClient({
 clientId: config.qbo.clientId,
 clientSecret: config.qbo.clientSecret,
 environment: config.qbo.environment,
 redirectUri: config.qbo.redirectUri,
 });
 return _client;
}

export function buildAuthUrl(): string {
 return getOauthClient().authorizeUri({
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
 const authResponse = await getOauthClient().createToken(reqUrl);
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
 * /refresh call: the winning call gets a new one, the losing concurrent calls
 * use the now-invalidated old one and get "Refresh token is invalid" - which
 * killed the session every ~hour when the prefetcher fired multiple QB calls
 * in parallel. This mutex ensures exactly one refresh happens at a time and
 * all concurrent callers share its result.
 */
let refreshInFlight: Promise<StoredTokens> | null = null;

/** Refresh this many ms BEFORE expiry. 5 min gives long-running QB queries
 * (some take 10–15s on a cold pull) plenty of headroom. */
const REFRESH_LEAD_MS = 5 * 60_000;

export async function getValidAccessToken(): Promise<StoredTokens> {
 const tokens = await loadTokens();
 if (!tokens) throw new Error('Not connected to QuickBooks. Visit /auth/connect first.');

 // Still well within expiry → return current tokens.
 if (Date.now() < tokens.expiresAt - REFRESH_LEAD_MS) {
 return tokens;
 }

 // Another refresh is already in flight → wait for it instead of starting a new one.
 if (refreshInFlight) return refreshInFlight;

 refreshInFlight = (async () => {
 try {
 const client = getOauthClient();
 client.setToken({
 access_token: tokens.accessToken,
 refresh_token: tokens.refreshToken,
 realmId: tokens.realmId,
 token_type: 'bearer',
 expires_in: 0,
 });
 const refreshed = await client.refresh();
 const json = refreshed.getJson() as IntuitTokenJson;
 const updated: StoredTokens = {
 accessToken: json.access_token,
 refreshToken: json.refresh_token,
 realmId: tokens.realmId,
 expiresAt: Date.now() + json.expires_in * 1000,
 };
 await saveTokens(updated);
 console.log(`[oauth] refreshed QB access token; valid for ${json.expires_in}s`);
 return updated;
 } catch (e) {
 // "Refresh token invalid" usually means another process (user re-OAuth
 // in browser, another server worker) saved fresh tokens. Invalidate the
 // in-memory cache so the next loadTokens() picks up disk content, then
 // retry once.
 const msg = e instanceof Error ? e.message : String(e);
 if (/refresh token.*invalid/i.test(msg)) {
 invalidateTokenCache();
 const fresh = await loadTokens();
 if (fresh && fresh.refreshToken !== tokens.refreshToken) {
 console.log('[oauth] picked up fresh tokens from disk after refresh failure');
 return fresh;
 }
 }
 throw e;
 } finally {
 refreshInFlight = null;
 }
 })();

 return refreshInFlight;
}
