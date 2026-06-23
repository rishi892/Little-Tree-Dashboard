# Little Tree Dashboards

Two React dashboards under one roof — **AR** (receivables, customer
analytics, Michigan sales map) and **Cashflow** (live QuickBooks
position, 13-week forecast, expenses, commissions, Upflow chase).
Both ship from the same Vite build and run inside a single Replit
deployment at **cfovaani.com**.

## Project layout

```
ar-joey/
├── README.md                  ← this file
├── package.json, vite.config.js, tsconfig.json, .replit
├── index.html                 → AR Dashboard entry  (mounts at /)
├── cashflow.html              → Cashflow entry      (mounts at /cashflow.html)
│
├── docs/                      single-source documentation
│   ├── deployment.md          Replit + cfovaani.com deploy guide
│   ├── qb-tokens-troubleshooting.md
│   └── cashflow-audit.md
│
├── public/                    static assets (logos, hero images, manifest)
│
├── scripts/                   project-level verification scripts
│   └── verify-numbers.mjs     audit AR + cashflow numbers end-to-end
│
├── src/                       FRONTEND (see src/README.md for details)
│   ├── ar/
│   │   ├── main.jsx, App.jsx, styles.css
│   │   ├── shell/             splash + chooser + login
│   │   ├── dashboard/         AR dashboard tree + pages/
│   │   └── lib/               pure utilities + useSheets hook
│   └── cashflow/
│       ├── main.tsx, CashflowApp.tsx, api.ts, format.ts, cashflow.css
│       ├── components/        ~38 hub + page components
│       └── data/              static reference data
│
└── cashflow-server/           BACKEND  (see cashflow-server/README.md)
    ├── src/                   56 TypeScript modules (flat, README-indexed)
    ├── data/, references/, scripts/
    └── (runtime state files — gitignored)
```

## Quick start

```bash
# One-time
npm install
npm --prefix cashflow-server install

# Dev (frontend only — proxies API to live backend)
npm run dev                    # http://localhost:5173

# Full-stack dev (both frontend + backend on your laptop)
# Terminal 1
cd cashflow-server && npm run dev
# Terminal 2 (project root)
VITE_CASHFLOW_API=http://localhost:4747 npm run dev
```

## Production build

```bash
npm run build:all              # builds both AR + Cashflow + server
npm start                      # node cashflow-server/dist/index.js
                               # serves both dashboards + API on port 4747
```

## Deploy

See [docs/deployment.md](docs/deployment.md). Target is Replit serving
both dashboards + the Express API from a single Node process.

## Credentials

- **AR Dashboard:** `ceo@littletreeconfections.com` / `HelloLT$1`
- **Cashflow Dashboard:** `cfo@littletreeconfections.com` / `Rishi@2026`

Both passwords are bundle-side hardcoded (per operator request). Auth
is enforced via `sessionStorage` so credentials are re-asked every
browser-tab session.

## Architecture overview

```
                  Browser
                     │
                     ▼
           ┌──────────────────┐
           │ cfovaani.com     │   ← single Replit deployment
           │   ↓ (routing)    │
           │ Express server   │   ← cashflow-server/dist/index.js
           ├──────────────────┤
           │ /                → AR Dashboard SPA  (dist/index.html)
           │ /cashflow.html   → Cashflow SPA      (dist/cashflow.html)
           │ /assets/*        → hashed Vite assets
           │ /api/*           → Express handlers  (QBO + Tiller + Upflow)
           │ /auth/*          → Intuit OAuth flow
           │
           │ .tokens.json     → QuickBooks OAuth tokens (persistent disk)
           └──────────────────┘
```

One origin → no CORS, no proxy hops. AR Dashboard's "Send via Upflow"
buttons hit `/api/upflow` on the same domain.
