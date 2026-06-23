# Cashflow Server

Express + TypeScript backend powering the Cashflow Dashboard. Pulls
live data from QuickBooks Online, Tiller (bank), Upflow (AR chase),
and several Google Sheets, then exposes a `/api/*` surface the
frontend at `cfovaani.com/cashflow.html` consumes.

## Folder layout

```
cashflow-server/
├── package.json                npm scripts (dev, build, start)
├── tsconfig.json
├── .env / .env.example         QBO + integration credentials (gitignored)
├── .gitignore                  excludes secrets, caches, tokens, tmp files
├── README.md                   ← this file
│
├── src/                        56 TypeScript modules, flat layout
│   ├── index.ts                Express entry — wires every API route
│   ├── config.ts               env-driven runtime config
│   ├── oauth.ts                Intuit OAuth flow + token refresh
│   ├── tokenStore.ts           atomic-write persistence for QB tokens
│   │
│   ├── (QuickBooks integration)
│   ├── qbo.ts                  raw QBO REST client (with bearer refresh)
│   ├── qbPlReport.ts           P&L report fetch
│   ├── qbBalanceSheet.ts       Balance Sheet report fetch
│   │
│   ├── (Tiller bank data)
│   ├── tiller.ts               Tiller balances
│   ├── tillerQbReco.ts         reconciliation against QB
│   ├── tillerTransactions.ts   raw transactions feed
│   ├── linkedAccounts.ts       per-account aggregates
│   ├── accountTransactions.ts  per-account txn feed
│   ├── ccSchedule.ts           credit-card payment schedule
│   ├── ccTillerSchedule.ts     same but Tiller-aware
│   │
│   ├── (Accounts Receivable)
│   ├── ar.ts                   open invoices
│   ├── arAging.ts              aging buckets + Net 97 model
│   ├── arProjection.ts         expected-collection projection
│   ├── arStatus.ts             per-customer status summary
│   ├── gelatoAr.ts             Gelato-channel AR
│   ├── gelatoArStatus.ts       Gelato per-customer status
│   ├── invoiceScraper.ts       sheet → invoice parse
│   ├── invoiceTracker.ts       master sheet ingest
│   │
│   ├── (Cashflow 13-week + overrides)
│   ├── cashflow13.ts           rolling 13-week forecast
│   ├── cfOverrides.ts          per-cell what-if overrides
│   ├── currentPosition.ts      cash on hand right now
│   ├── inflowSchedule.ts       collection cadence by source
│   ├── snapshotActuals.ts      Monday snapshot for past-weeks view
│   ├── weeklySnapshots.ts      historical snapshot storage
│   ├── settlementHistory.ts    payment settlements
│   │
│   ├── (Expenses)
│   ├── expenseDetail.ts        line-item drill-down
│   ├── expenseProjection.ts    forward expense model
│   ├── sheetExpenses.ts        sheet → expense parse
│   ├── sheetPayroll.ts         sheet → payroll parse
│   ├── monthlyOpex.ts          L3M opex avg per category
│   ├── inventoryPurchases.ts   inventory purchase feed
│   ├── cogsMapper.ts           QB COGS → category map
│   ├── mappedExpenses.ts       per-entity expense map (PureX/Moysh)
│   ├── categoryOverrides.ts    operator-set category remaps
│   ├── recurring.ts            subscription detection
│   ├── purexClearing.ts        PureX clearing account logic
│   ├── purexPayrollSheet.ts    PureX payroll sheet ingest
│   ├── moyshPayrollByVendor.ts Moysh payroll-by-vendor breakdown
│   ├── audit.ts                subscription audit
│   │
│   ├── (Commission)
│   ├── commissionCalc.ts       per-rep commission calc
│   ├── commissionOverrides.ts  manual commission tweaks
│   ├── commissionSheet.ts      sheet ingest
│   ├── brandEmails.ts          brand → contact email map
│   ├── perRepCommissionWorkbooks.ts per-rep workbook exports
│   │
│   ├── (Sales)
│   ├── salesByChannel.ts       channel rollup
│   ├── salesByProduct.ts       SKU rollup
│   ├── salesByReps.ts          rep rollup
│   ├── salesCohortForecast.ts  cohort-based projection
│   ├── salesForecast.ts        forward sales forecast (3 scenarios)
│   ├── salesStatus.ts          per-customer sales status
│   ├── ltFinancialsSales.ts    Little Tree financials sheet ingest
│   │
│   └── (External)
│   └── upflow.ts               Upflow API client
│
├── data/                       static reference data
│   └── cogs-catalog.json       product → COGS category lookup
│
├── references/                 sheet schemas / sample exports for ref
│   ├── sheet_v4_tabs.md
│   └── tiller_current_balances.json
│
├── scripts/                    operationally-useful CLI scripts
│   ├── audit-subscriptions.ts          CLI of the /api/subscription-audit
│   │                                    endpoint — writes a human-readable
│   │                                    markdown report (referenced from
│   │                                    src/audit.ts).
│   └── sales-assumption-analysis.mjs   methodology dump for the sales
│                                        forecast (referenced from
│                                        src/salesForecast.ts).
│
└── (project docs live at ../docs/ — single source for both apps:
     deployment.md, qb-tokens-troubleshooting.md, cashflow-audit.md)

(runtime state — DO NOT commit, see .gitignore)
   .tokens.json                 QB OAuth tokens (atomic-write managed)
   .cashflow-overrides.json     cashflow scenario overrides
   .category-overrides.json     expense category remaps
   .commission-overrides.json   commission tweaks
   .brand-emails.json           brand-email mappings
   .weekly-snapshots.json       Monday cashflow snapshots
   .invoice-scrape-cache.json   cached invoice scrape (~780 KB)
   .tmp-*.json, .tmp-*.csv      hot caches regenerated on demand
```

## Why src/ stays flat

Every TS file imports siblings, and Node ESM requires `.js` suffixes
in imports. Moving the 56 files into per-domain subfolders would mean
rewriting ~150 import statements across the codebase. Risk vs reward
isn't worth it — the per-domain grouping above is the **mental model**;
the README is the **index**. The actual file tree stays flat to keep
imports short and to minimise the risk of breaking the running
production server during a refactor.

If you DO need to find something, the README headings (QBO, Tiller,
AR, Cashflow, Expenses, Commission, Sales, External) match how the
business thinks about the data.

## Run locally

```bash
npm install
npm run dev          # tsx watch — auto-reloads on src/* changes
```

Server boots on `http://localhost:4747`. The Vite frontend (port 5173)
proxies `/api` and `/auth` to it via `vite.config.js`.

For full-stack local dev (frontend + backend on your laptop):

```bash
# Terminal 1
cd cashflow-server && npm run dev

# Terminal 2 (project root)
VITE_CASHFLOW_API=http://localhost:4747 npm run dev
```

## Deploy

See [../docs/deployment.md](../docs/deployment.md).
