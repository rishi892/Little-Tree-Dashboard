# Deploy Guide — Replit (single Node process @ cfovaani.com)

## 🎯 Architecture

```
                Browser
                  │
                  ▼
       ┌─────────────────────────┐
       │  cfovaani.com           │   ← custom domain
       │     ↓ (Replit routing)  │
       │  Replit deployment      │   ← single Node 20 process
       ├─────────────────────────┤
       │  Express server         │
       │   /              → AR  Dashboard SPA   (dist/index.html)
       │   /cashflow.html → Cashflow SPA        (dist/cashflow.html)
       │   /assets/*      → hashed Vite assets  (dist/assets/)
       │   /api/*         → Express handlers    (QBO + Tiller + Upflow)
       │   /auth/*        → Intuit OAuth flow
       │                                                         │
       │  .tokens.json (persistent on Replit disk)               │
       └─────────────────────────┘
```

One process, one origin. No CORS. No reverse-proxy.

## 📦 First-time deploy

### 1. Push this whole repo to Replit

```bash
git remote add replit https://<your-replit-git-url>
git push replit main
```

(Or import via the Replit UI — `Create Repl → Import from GitHub`.)

### 2. Set Replit Secrets (env vars)

In Replit → **Tools → Secrets**:

| Key | Value |
|---|---|
| `QBO_CLIENT_ID` | (from Intuit Developer portal) |
| `QBO_CLIENT_SECRET` | (from Intuit Developer portal) |
| `QBO_ENVIRONMENT` | `production` |
| `QBO_REDIRECT_URI` | `https://cfovaani.com/auth/callback` |
| `CLIENT_URL` | `https://cfovaani.com` |
| `NODE_ENV` | `production` (already set in `.replit`) |

`ALLOWED_ORIGINS` is optional — cfovaani.com is already in the
default allowlist.

### 3. Update Intuit Developer app

Intuit Developer Portal → your app → **Redirect URIs** → add:

```
https://cfovaani.com/auth/callback
```

### 4. Wire cfovaani.com → Replit

Replit → **Deployments → Custom domains** → add `cfovaani.com` and
`www.cfovaani.com`. Update DNS at your registrar to point CNAME/A
records at the Replit-provided target.

### 5. Hit Deploy

Replit's "Deploy" button runs the build script in `.replit`:

```sh
npm run install:all     # install root + cashflow-server deps
npm run build:all       # vite build + tsc -p cashflow-server
npm start               # node cashflow-server/dist/index.js
```

The server boots, sees `dist/` next to `cashflow-server/`, and starts
serving both frontends + the API on port 4747 (mapped to 80 externally
by Replit, then 443 via Replit's TLS).

### 6. Reconnect QuickBooks once

Open `https://cfovaani.com/cashflow.html` → click **Connect
QuickBooks** → complete OAuth. `.tokens.json` saves to Replit's
persistent disk and auto-refreshes from there forever.

## ✅ Sanity checks

```bash
# AR Dashboard
curl -I https://cfovaani.com/                       # → 200 text/html

# Cashflow Dashboard
curl -I https://cfovaani.com/cashflow.html          # → 200 text/html

# API
curl     https://cfovaani.com/api/status            # → {"connected":true,...}
```

In DevTools Network tab, every request shows `cfovaani.com` — never
any other host, never localhost. This Replit IS the cashflow backend.

## 🔄 Subsequent deploys

After local code changes:

```bash
git add . && git commit -m "..." && git push replit main
```

Replit auto-deploys. **`.tokens.json` stays on the Replit disk and is
never overwritten** because `.gitignore` excludes it (see
`cashflow-server/.gitignore`). No re-OAuth required.

## ⚠️ One-time git history cleanup (do this once before first deploy)

If `.tokens.json` or `.env` was ever committed to git before:

```bash
git rm --cached cashflow-server/.tokens.json    2>/dev/null
git rm --cached cashflow-server/.env            2>/dev/null
git rm --cached cashflow-server/.tmp-*.json     2>/dev/null
git rm --cached cashflow-server/.brand-emails.json 2>/dev/null
git commit -m "Stop tracking server-local secrets/cache"
git push
```

Otherwise every subsequent `git push` overwrites the live server's
rotated tokens, forcing a manual QB reconnect after each deploy. The
`.gitignore` rules already prevent NEW commits — this cleans up any
that snuck in before the rule was added.

## 🧪 Run locally end-to-end (single-process mode)

To test the prod setup before deploying:

```bash
npm run install:all
npm run build:all
npm start
# → AR @ http://localhost:4747/
# → Cashflow @ http://localhost:4747/cashflow.html
# → API @ http://localhost:4747/api/status
```

For day-to-day dev with hot reload, stick with two terminals:

```bash
# Terminal 1: AR + Cashflow client (Vite, port 5173, proxies /api to Replit)
npm run dev

# Terminal 2: Cashflow API only (Express, port 4747)
cd cashflow-server && npm run dev
```

`vite.config.js` proxies `/api` and `/auth` to `https://cfovaani.com`
by default — point it at `http://localhost:4747` (set
`VITE_CASHFLOW_API=http://localhost:4747`) if you want to test against
your local Express server instead.
