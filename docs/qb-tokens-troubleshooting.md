# Cashflow Server — Deployment notes (Replit)

## ⚠️ Most important rule

**NEVER commit / push these files:**

- `.tokens.json` — QuickBooks OAuth tokens. Pushing this overwrites whatever
  the live server has rotated to, which forces the operator to re-connect QB
  every time. Already excluded in `.gitignore`.
- `.env` — Intuit `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, etc.
- `.tmp-*.json` / `.invoice-scrape-cache.json` — runtime cache, regenerated
  on demand. Pushing local copies stomps fresher production data.
- `*-overrides.json` — operator's manual category / commission tweaks live
  only on the server.

`.gitignore` in this folder already covers all of the above.

## QuickBooks "please reconnect" recurring bug — root cause + fix

**Symptom:** User has to keep clicking "Connect QuickBooks" and re-authing
every few deploys.

**Cause:** `.tokens.json` was being checked into git. Each `git push`
overwrote the production tokens file with a local (likely stale or empty)
version. Intuit then rejects the next API call with "refresh_token
invalid" → frontend renders the Connect button again.

**Fix already in place:**

1. `.gitignore` now excludes `.tokens.json` so it stays server-local.
2. `tokenStore.ts` validates payload shape before saving — refuses to write
   a half-baked token file that would brick the next refresh.
3. `tokenStore.ts` validates payload shape on load — ignores a corrupted
   file instead of returning broken tokens that would 401.
4. Refresh-in-flight mutex (already there) prevents concurrent rotation
   races within a single process.

**One-time cleanup if you previously committed `.tokens.json`:**

```bash
# Remove from git history without deleting the live file
git rm --cached cashflow-server/.tokens.json
git commit -m "Stop tracking .tokens.json (server-local secret)"
git push
```

## Replit setup checklist

- [ ] `.env` exists on the server with `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
      `QBO_REDIRECT_URI`, `CLIENT_URL`, `PORT` — set via Replit Secrets, NOT
      checked in.
- [ ] `QBO_REDIRECT_URI` matches a Redirect URI registered on the Intuit
      app dashboard (e.g. `https://cfovaani.com/auth/callback`).
- [ ] Always-On is enabled (paid Replit) so the refresh-token rotation
      window doesn't lapse during long idle periods.
- [ ] After the first deploy, sign in to QB once → `.tokens.json` is
      created on the server's persistent disk → all future visits skip
      the OAuth dance.

## Sanity check after deploy

```bash
curl https://<your-replit-url>/api/status
# → { "connected": true, "realmId": "...", "credsConfigured": true }
```

If `connected: false` after a deploy, check that:
1. The `.tokens.json` file still exists on the server disk.
2. The Replit Secrets (`QBO_CLIENT_ID` / `QBO_CLIENT_SECRET`) haven't been
   rotated by Intuit's dev portal.
3. The server logs don't show `Refresh token is invalid` — that means
   either a concurrent process won the rotation race, or someone re-OAuth'd
   from another browser in the last hour.
