import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { config } from './config.js';
import { buildAuthUrl, exchangeCodeForTokens } from './oauth.js';
import { qbCredsConfigured } from './qbConfig.js';
import { loadTokens, clearTokens } from './tokenStore.js';
import { getDashboardData } from './qbo.js';
import { getCachedSubscriptionAudit, invalidateSubscriptionAuditCache } from './audit.js';
import { getExpenseDetail, type ExpenseDetailResult } from './expenseDetail.js';
import { detectRecurringSubscriptions, type RecurringResult } from './recurring.js';
import { getCashflow13WeekCached } from './cashflow13Cache.js';
import { getCurrentPosition } from './currentPosition.js';
import { getTillerBalances, type TillerBalances } from './tiller.js';
import { getLinkedBalances, type LinkedBalances } from './linkedAccounts.js';
import { withDurableCache, dropDurableMem } from './qbCache.js';
import { getArOpen, type ArResult } from './ar.js';
import { getGelatoAr, type GelatoArResult } from './gelatoAr.js';
import { getCollectionCurve, type CollectionCurveResult } from './collectionCurve.js';
import { getPurexClearing, type PurexClearingResult } from './purexClearing.js';
import { getSettlementHistory, type SettlementHistoryResult } from './settlementHistory.js';
import { getArAging, type ArAgingResult } from './arAging.js';
import { getMonthlyOpex, type MonthlyOpexResult } from './monthlyOpex.js';
import { getInflowSchedule, type InflowScheduleResult } from './inflowSchedule.js';
import { getSheetExpenses, type SheetExpensesResult } from './sheetExpenses.js';
import { getMappedExpenses, invalidateMappedExpensesCache, type MappedExpensesResult, type SheetEntity } from './mappedExpenses.js';
import { getQbPlReport, type QbPlReport } from './qbPlReport.js';
import { computePnlExpenses } from './pnlExpenses.js';
import { getQbBalanceSheet, type QbBalanceSheetReport } from './qbBalanceSheet.js';
import { getAccountTransactions, type AccountTransactionsResult } from './accountTransactions.js';
import { getInventoryPurchases, type InventoryPurchasesResult } from './inventoryPurchases.js';
import { getSalesByChannel, type SalesByChannelResult } from './salesByChannel.js';
import {
 loadOverrides,
 setOverride,
 clearOverride,
 clearAllOverrides,
 type CategoryOverride,
} from './categoryOverrides.js';
import { loadReviews, addReview, resolveReview, auditReview, UPLOAD_DIR } from './reviews.js';
import { loadHandoffs, addHandoff, removeHandoff } from './agencyHandoff.js';
import { askAssistant, buildSnapshot, getChangesAnswer } from './assistant.js';
import { login } from './auth.js';

const app = express();
// Allow the configured CLIENT_URL plus any extra origins from .env
// (defaults already include cfovaani.com + localhost). Curl /
// server-to-server requests have no Origin header → permit them.
app.use(cors({
 origin: (origin, cb) => {
   if (!origin) return cb(null, true);
   if (config.allowedOrigins.includes(origin)) return cb(null, true);
   return cb(new Error(`CORS: origin ${origin} not allowed`));
 },
 credentials: true,
}));
app.use(express.json({ limit: '8mb' })); // 8mb so review screenshots fit in the body

// Login - verifies email + password against the Supabase app_users table
// (server-side; credentials never reach the browser). Returns the user's
// identity + role/rep scope, or an error.
app.post('/api/login', async (req, res, next) => {
 try {
 const b = req.body ?? {};
 const dashboard = b.dashboard === 'cashflow' ? 'cashflow' : 'ar';
 res.json(await login(String(b.email ?? b.user ?? ''), String(b.password ?? ''), dashboard));
 } catch (err) { next(err); }
});

app.get('/api/health', (_req, res) => {
 res.json({ ok: true });
});

// ===== User reviews / feedback (stored on this server) =====
app.use('/api/review-uploads', express.static(UPLOAD_DIR));

app.get('/api/reviews', async (_req, res, next) => {
 try { res.json(await loadReviews()); } catch (e) { next(e); }
});
app.post('/api/reviews', async (req, res, next) => {
 try { res.json(await addReview(req.body ?? {})); } catch (e) { next(e); }
});
app.post('/api/reviews/:id/resolve', async (req, res, next) => {
 try {
   const r = await resolveReview(req.params.id, req.body?.resolvedBy ?? '', req.body?.note ?? '');
   if (!r) return res.status(404).json({ error: 'review not found' });
   res.json(r);
 } catch (e) { next(e); }
});
app.post('/api/reviews/:id/audit', async (req, res, next) => {
 try {
   const r = await auditReview(req.params.id, req.body?.auditedBy ?? '', req.body?.auditNote ?? '');
   if (!r) return res.status(404).json({ error: 'review not found' });
   res.json(r);
 } catch (e) { next(e); }
});

// ===== Collections-agency handoffs (180+ day invoices sent to an agency) =====
app.get('/api/agency-handoffs', async (_req, res, next) => {
 try { res.json(await loadHandoffs()); } catch (e) { next(e); }
});
app.post('/api/agency-handoffs', async (req, res, next) => {
 try { res.json(await addHandoff(req.body ?? {})); } catch (e) { next(e); }
});
app.delete('/api/agency-handoffs/:invNo', async (req, res, next) => {
 try { res.json({ removed: await removeHandoff(req.params.invNo) }); } catch (e) { next(e); }
});

app.get('/api/status', async (_req, res) => {
 const tokens = await loadTokens();
 res.json({
 connected: !!tokens,
 realmId: tokens?.realmId ?? null,
 credsConfigured: await qbCredsConfigured(),
 });
});

app.post('/api/disconnect', async (_req, res) => {
 await clearTokens();
 res.json({ ok: true });
});

// ---- Manual category overrides ------------------------------------------
// Lets the user say "this QB account should be tagged Moysh AND counted in
// the Executive Salaries line item" - overrides flow into expenseDetail.ts
// (Paid-By split) and mappedExpenses.ts (line-item routing). Cached server
// data is invalidated on every mutation so the next request rebuilds.

function invalidateExpenseCaches() {
 // Drop the durable caches that depend on QB expense detail / sheet mapping so
 // the next read rebuilds them.
 for (const k of ['expense-detail', 'monthly-opex', 'cashflow-13week:v6:future', 'cashflow-13week:v6:past',
   'mapped-expenses:PureX:14', 'mapped-expenses:Moysh:14']) dropDurableMem(k);
}

// Global cache invalidation - clears every known module cache in one call so
// the user doesn't have to open each tab and hit Refresh individually after
// the data source changes (Tiller sync, sheet edit, QB reconnect etc.).
app.post('/api/cache/invalidate-all', async (_req, res, next) => {
 try {
  // In-memory caches local to this file
  invalidateExpenseCaches();
  for (const k of ['current-position', 'linked-balances', 'dashboard', 'ar-aging',
    'inflow-schedule', 'monthly-opex', 'expense-detail',
    'qb-pl-report:Accrual', 'qb-pl-report:Cash',
    'qb-balance-sheet:Accrual', 'qb-balance-sheet:Cash']) dropDurableMem(k);
  // Dynamically import + invalidate every module-level cache.
  const mods = await Promise.all([
   import('./audit.js'),
   import('./mappedExpenses.js'),
   import('./expenseDetail.js'),
   import('./accountTransactions.js'),
   import('./inventoryPurchases.js'),
   import('./purexPayrollSheet.js'),
   import('./tillerTransactions.js'),
   import('./tillerQbReco.js'),
   import('./salesByProduct.js'),
   import('./invoiceScraper.js'),
   import('./cogsMapper.js'),
   import('./ltFinancialsSales.js'),
   import('./weeklySnapshots.js'),
   import('./commissionSheet.js'),
   import('./gelatoArStatus.js'),
   import('./upflow.js'),
   import('./perRepCommissionWorkbooks.js'),
  ]);
  const calls = [
   () => mods[0].invalidateSubscriptionAuditCache?.(),
   () => mods[1].invalidateMappedExpensesCache?.(),
   () => mods[2].invalidateExpenseDetailCache?.(),
   () => mods[3].invalidateAccountTransactionsCache?.(),
   () => mods[4].invalidateInventoryCache?.(),
   () => mods[5].invalidatePurexPayrollCache?.(),
   () => mods[6].invalidateTillerTransactionsCache?.(),
   () => mods[7].invalidateReconciliationCache?.(),
   () => mods[8].invalidateSalesByProductCache?.(),
   () => mods[9].invalidateScraperCache?.(),
   () => mods[10].invalidateCogsMapperCache?.(),
   () => mods[11].invalidateLtFinancialsCache?.(),
   () => mods[12].invalidateSnapshotsCache?.(),
   () => mods[13].invalidateCommissionSheetCache?.(),
   () => mods[14].invalidateGelatoArStatusCache?.(),
   () => mods[15].invalidateUpflowCache?.(),
   () => mods[16].invalidatePerRepCommissionCache?.(),
  ];
  let cleared = 0;
  for (const fn of calls) {
   try { fn(); cleared++; } catch { /* swallow */ }
  }
  res.json({ ok: true, cachesCleared: cleared });
 } catch (err) { next(err); }
});

app.get('/api/category-overrides', async (_req, res, next) => {
 try {
 res.json(await loadOverrides());
 } catch (err) { next(err); }
});

// Brand → email registry (persistent per-brand AR contact).
app.get('/api/brand-emails', async (_req, res, next) => {
 try {
 const { loadBrandEmails } = await import('./brandEmails.js');
 res.json(await loadBrandEmails());
 } catch (err) { next(err); }
});

app.put('/api/brand-emails/:brand', async (req, res, next) => {
 try {
 const { setBrandEmail } = await import('./brandEmails.js');
 const body = req.body as { email?: string };
 const updated = await setBrandEmail(req.params.brand, body.email ?? '');
 res.json(updated);
 } catch (err) { next(err); }
});

app.put('/api/category-overrides/:account', async (req, res, next) => {
 try {
 const account = req.params.account;
 const body = req.body as CategoryOverride;
 const updated = await setOverride(account, body);
 invalidateExpenseCaches();
 res.json(updated);
 } catch (err) { next(err); }
});

app.delete('/api/category-overrides/:account', async (req, res, next) => {
 try {
 const updated = await clearOverride(req.params.account);
 invalidateExpenseCaches();
 res.json(updated);
 } catch (err) { next(err); }
});

app.delete('/api/category-overrides', async (_req, res, next) => {
 try {
 const updated = await clearAllOverrides();
 invalidateExpenseCaches();
 res.json(updated);
 } catch (err) { next(err); }
});

app.get('/auth/connect', async (_req, res, next) => {
 try { res.redirect(await buildAuthUrl()); } catch (e) { next(e); }
});

app.get('/auth/callback', async (req: Request, res: Response, next: NextFunction) => {
 try {
 console.log('[oauth-callback] query params:', JSON.stringify(req.query));
 const realmId = String(req.query.realmId ?? '');
 if (!realmId) {
 const err = String(req.query.error ?? '');
 const errDesc = String(req.query.error_description ?? '');
 throw new Error(`Missing realmId in callback. Intuit returned: error=${err || '(none)'} error_description=${errDesc || '(none)'} full_query=${JSON.stringify(req.query)}`);
 }
 await exchangeCodeForTokens(req.url, realmId);

 // Fresh QB connection → kick off a full prewarm so when the user lands on
 // the dashboard, all caches are already populated. Don't await - we want
 // the redirect to fire immediately; the prewarm runs in the background.
 console.log('[oauth-callback] connection established, kicking off prewarm…');
 void Promise.allSettled([prewarmSheetCaches(), prewarmQbCaches()])
 .then(() => console.log('[oauth-callback] post-connect prewarm complete'))
 .catch((e) => console.error('[oauth-callback] post-connect prewarm failed:', e));

 res.redirect(`${config.clientUrl}/?connected=1`);
 } catch (err) {
 next(err);
 }
});

app.get('/api/dashboard', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data } = await withDurableCache('dashboard', 30 * 60 * 1000, () => getDashboardData(12), () => true, force);
 res.json(data);
 } catch (err) {
 next(err);
 }
});

// Subscription audit - heavy call (queries vendors + 6mo of purchases + bills),
// so cache for 10 minutes and let the client force a refresh with ?refresh=1.
// Subscription audit cache lives in audit.ts (so cashflow13 can use the same one).

app.get('/api/subscription-audit', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const months = Math.min(36, Math.max(1, Number(req.query.months ?? 16)));
 if (force) invalidateSubscriptionAuditCache();
 const { data, cached } = await withDurableCache(`subscription-audit:${months}`, 30 * 60 * 1000, () => getCachedSubscriptionAudit(months), () => true, force);
 res.json({ cached, ...data });
 } catch (err) {
 next(err);
 }
});

// Recurring subscriptions detected from QBO transaction history.
const RECURRING_TTL_MS = 30 * 60 * 1000;

app.get('/api/recurring-subscriptions', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const months = Math.min(36, Math.max(3, Number(req.query.months ?? 12)));
 const { data, cached } = await withDurableCache(`recurring-subscriptions:${months}`, RECURRING_TTL_MS, () => detectRecurringSubscriptions(months), () => true, force);
 res.json({ cached, ...data });
 } catch (err) {
 next(err);
 }
});

// Live expense detail - heavy (Purchase + Bill lines), so cache for 10 min with ?refresh=1 override.
const DETAIL_TTL_MS = 30 * 60 * 1000;

app.get('/api/expense-detail', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 // getExpenseDetail is durable-cached internally (shared with mapped-expenses).
 const data = await getExpenseDetail(14, force);
 res.json({ cached: !force, ...data });
 } catch (err) {
 next(err);
 }
});

// 13-Week Cash Flow - primary lender artifact. Heavy (audit + expense detail),
// so cache for 10 minutes with ?refresh=1 override.
// Cashflow-13week refreshes on the sheet cycle (30s) - AR additions to the
// Invoice Tracker reflect within 30s. The QB-derived inputs (Payroll,
// Inventory, Other Expenses) use their own 60-min cached values inside,
// so we don't re-hit QB on every cashflow refresh.

// 13-week is durable-cached (5 min, stale-while-revalidate): outflows come from
// the shared cached expense source, inflows from the live sheet.
// The durable-cached 13-week accessor lives in cashflow13Cache.ts so the bot's
// snapshot (assistant.ts) reads the SAME last-good result instead of recomputing
// the heavy 13-week from scratch on every cold serverless instance.

app.get('/api/cashflow-13week', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const direction = req.query.direction === 'past' ? 'past' : 'future';
 const { data, cached } = await getCashflow13WeekCached(direction, force);
 res.json({ cached, direction, ...data });
 } catch (err) {
 next(err);
 }
});

// CFO Copilot - data-driven question answerer (no LLM). Reads the live
// financial snapshot and routes the question to a deterministic metric handler.
app.post('/api/assistant', async (req, res, next) => {
 try {
 const question = String(req.body?.question ?? req.body?.q ?? '').slice(0, 500).trim();
 if (!question) { res.status(400).json({ error: 'Missing question' }); return; }
 const u = req.body?.user;
 const user = u && typeof u === 'object'
 ? { name: String(u.name ?? '').slice(0, 60), title: String(u.title ?? '').slice(0, 40) }
 : undefined;
 const sinceISO = typeof req.body?.since === 'string' ? req.body.since : undefined;
 res.json(await askAssistant(question, user, sinceISO));
 } catch (err) { next(err); }
});

// Raw snapshot (handy for debugging / a future richer UI).
app.get('/api/assistant/snapshot', async (req, res, next) => {
 try {
 res.json(await buildSnapshot(req.query.refresh === '1'));
 } catch (err) { next(err); }
});

// AR Copilot - the AR Dashboard's own deterministic (no-LLM) question answerer.
// Separate snapshot (open AR / aging / collections / sales), separate from the
// Cashflow CFO Copilot above. Sheet-based, so no QB-token load.
app.post('/api/ar-assistant', async (req, res, next) => {
 try {
 const { askArAssistant } = await import('./arAssistant.js');
 const question = String(req.body?.question ?? req.body?.q ?? '').slice(0, 500).trim();
 if (!question) { res.status(400).json({ error: 'Missing question' }); return; }
 const u = req.body?.user;
 const user = u && typeof u === 'object'
 ? { name: String(u.name ?? '').slice(0, 60), title: String(u.title ?? '').slice(0, 40) }
 : undefined;
 res.json(await askArAssistant(question, user));
 } catch (err) { next(err); }
});

app.get('/api/ar-assistant/snapshot', async (req, res, next) => {
 try {
 const { buildArSnapshot } = await import('./arAssistant.js');
 res.json(await buildArSnapshot(req.query.refresh === '1'));
 } catch (err) { next(err); }
});

// What changed since `since` (or since ~24h ago). The bot tracks this on its
// own; the UI calls this on open to greet the user with recent movements.
app.get('/api/assistant/changes', async (req, res, next) => {
 try {
 await buildSnapshot(); // make sure a current record exists
 const since = typeof req.query.since === 'string' ? req.query.since : undefined;
 res.json(await getChangesAnswer(since));
 } catch (err) { next(err); }
});

// ── Scheduled cache warmer (Vercel Cron) ─────────────────────────────────────
// On serverless there is no long-running process, so the durable Supabase cache
// is kept hot by an hourly Vercel Cron hit to this endpoint (see vercel.json
// "crons": "0 * * * *"). It force-refreshes every dashboard cache so user
// requests always serve fresh-within-the-hour data instantly from cache - no
// 30-60s live recompute on open. Protected by CRON_SECRET when set: Vercel
// auto-sends `Authorization: Bearer $CRON_SECRET` on cron requests.
app.get('/api/cron/prewarm', async (req, res) => {
 const secret = process.env.CRON_SECRET;
 if (secret && req.headers.authorization !== `Bearer ${secret}`) {
 res.status(401).json({ error: 'unauthorized' });
 return;
 }
 const t0 = Date.now();
 // 0. Keep the QB connection ALIVE: refresh the access token up front (one
 //    coalesced refresh) so the token chain never lapses - this is what keeps
 //    QuickBooks "always connected" even on idle days. AWAIT this (it's the
 //    critical part) - it's fast and finishes well within the function limit, so
 //    the rotating refresh token is always saved (never killed mid-refresh).
 let token = 'ok';
 try { const { getValidAccessToken } = await import('./oauth.js'); await getValidAccessToken(); }
 catch (e) { token = String(e instanceof Error ? e.message : e); }
 // Warm all caches in the BACKGROUND (waitUntil keeps the function alive on
 // Vercel until it settles or the limit). Returning immediately means the cron
 // never 504s (no timeout glitch) and the warm runs best-effort after the reply.
 const warm = Promise.allSettled([prewarmQbCaches(), prewarmSheetCaches()])
   .then(() => console.log(`[cron/prewarm] caches warmed in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
   .catch(() => {});
 try { const { waitUntil } = await import('@vercel/functions'); waitUntil(warm); } catch { void warm; }
 res.json({ ok: true, token, warming: 'background' });
});

// Background watcher: refresh the snapshot every 30 min even with no user
// activity, so the bot's change-history (and "what changed") stays current on
// its own. Seed once shortly after startup.
// Long-running watchers only make sense on a persistent host (local / Node
// server). On serverless (Vercel) there's no background process, so skip them.
if (!process.env.VERCEL) {
 setInterval(() => { void buildSnapshot(true).catch(() => { /* best-effort */ }); }, 30 * 60 * 1000);
 setTimeout(() => { void buildSnapshot(true).catch(() => { /* best-effort */ }); }, 60 * 1000);
}

// Cashflow manual overrides (CC utilisation per week + mode toggle).
app.get('/api/cashflow-overrides', async (_req, res, next) => {
 try {
 const { loadCfOverrides } = await import('./cfOverrides.js');
 res.json(await loadCfOverrides());
 } catch (err) { next(err); }
});

app.post('/api/cashflow-overrides', async (req, res, next) => {
 try {
 const { loadCfOverrides, saveCfOverrides } = await import('./cfOverrides.js');
 const current = await loadCfOverrides();
 const body = req.body ?? {};
 const next = {
 mode: body.mode === 'auto' ? 'auto' as const : 'manual' as const,
 ccUtilisationByWeek: body.ccUtilisationByWeek ?? current.ccUtilisationByWeek,
 };
 await saveCfOverrides(next);
 // invalidate the 13-week durable cache so the next read picks up new overrides
 dropDurableMem('cashflow-13week:v6:future');
 dropDurableMem('cashflow-13week:v6:past');
 res.json(next);
 } catch (err) { next(err); }
});

// Expense head overrides - per-head monthly amount typed in Expenses → Edit.
// Display-only (does not feed the cashflow). Persisted in qb_cache.
app.get('/api/expense-overrides', async (_req, res, next) => {
 try {
 const { loadExpenseOverrides } = await import('./expenseOverrides.js');
 res.json(await loadExpenseOverrides());
 } catch (err) { next(err); }
});

app.post('/api/expense-overrides', async (req, res, next) => {
 try {
 const { saveExpenseOverrides } = await import('./expenseOverrides.js');
 const body = req.body ?? {};
 const rawValues = (body.overrides ?? body) as Record<string, unknown>;
 const clean: Record<string, number> = {};
 for (const [k, v] of Object.entries(rawValues)) {
 const n = Number(v);
 if (k && k !== 'overrides' && k !== 'by' && Number.isFinite(n)) clean[k] = n;
 }
 const by = typeof body.by === 'string' ? body.by : 'Unknown';
 res.json(await saveExpenseOverrides(clean, by));
 } catch (err) { next(err); }
});

// Sales + AR forecast overrides - per-week amounts typed in Sales → Edit.
// Display-only (does not feed the cashflow). Persisted in qb_cache.
app.get('/api/forecast-overrides', async (_req, res, next) => {
 try {
 const { loadForecastOverrides } = await import('./forecastOverrides.js');
 res.json(await loadForecastOverrides());
 } catch (err) { next(err); }
});

app.post('/api/forecast-overrides', async (req, res, next) => {
 try {
 const { loadForecastOverrides, saveForecastOverrides } = await import('./forecastOverrides.js');
 const body = (req.body ?? {}) as { sales?: Record<string, unknown>; ar?: Record<string, unknown> };
 const toNums = (m: Record<string, unknown> | undefined): Record<string, number> => {
 const o: Record<string, number> = {};
 for (const [k, v] of Object.entries(m ?? {})) { const n = Number(v); if (k && Number.isFinite(n)) o[k] = n; }
 return o;
 };
 await saveForecastOverrides({ sales: toNums(body.sales), ar: toNums(body.ar) });
 res.json(await loadForecastOverrides());
 } catch (err) { next(err); }
});

// AR open invoices - Little Tree's open AR computed EXACTLY like the AR
// dashboard (Money Owed column + the dashboard's paid / write-off rules), so the
// number matches the dashboard's Total Outstanding penny-for-penny.
app.get('/api/ar-open-invoices', async (_req, res, next) => {
 try {
 const { getLittleTreeOpenAr } = await import('./arDashboardOpen.js');
 res.json(await getLittleTreeOpenAr());
 } catch (err) { next(err); }
});

// AR collections history - month x year grid + seasonality (LT Financials paid
// history, non-Gelato). The "kitna AR wapas aata hai" trend behind the AR projection.
app.get('/api/ar-collections-history', async (_req, res, next) => {
 try {
 const { getArCollectionsHistory } = await import('./arCollectionsHistory.js');
 res.json(await getArCollectionsHistory());
 } catch (err) { next(err); }
});

// Collected detail for any date range (by paid date) - the invoices behind the
// "actual collected" number. Powers the variance drill-down + calendar-period actual.
app.get('/api/collected-detail', async (req, res, next) => {
 try {
 const start = String(req.query.start ?? '').slice(0, 10);
 const end = String(req.query.end ?? '').slice(0, 10);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
 res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' }); return;
 }
 const { getCollectedDetail } = await import('./snapshotActuals.js');
 res.json(await getCollectedDetail(start, end));
 } catch (err) { next(err); }
});

// Outflow drill-down: PureX-paid expense entries for a date range, grouped by
// budget outflow line. From the live Expenses sheet (no QuickBooks) - powers the
// variance outflow detail + a QB-independent actual.
app.get('/api/expense-entries', async (req, res, next) => {
 try {
 const start = String(req.query.start ?? '').slice(0, 10);
 const end = String(req.query.end ?? '').slice(0, 10);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
 res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' }); return;
 }
 const { getExpenseEntriesForRange } = await import('./sheetExpenses.js');
 res.json(await getExpenseEntriesForRange(start, end));
 } catch (err) { next(err); }
});

// Combined (PureX + Moysh) ACTUAL expense for a calendar month, on the budget's
// basis. Settled month → deduped getMappedExpenses Combined; current month →
// live PureX sheet (Moysh settles in QB later). Powers the variance outflow.
app.get('/api/combined-actual', async (req, res, next) => {
 try {
 const month = String(req.query.month ?? '').slice(0, 7);
 if (!/^\d{4}-\d{2}$/.test(month)) { res.status(400).json({ error: 'month (YYYY-MM) required' }); return; }
 const force = req.query.refresh === '1';
 const { getCombinedActualForMonth } = await import('./combinedActual.js');
 // Durable-cached per month so the Variance tab serves instantly on serverless,
 // but with a short TTL (2 min) so sheet/QB actuals refresh "live" - the cache
 // still serves last-good instantly while it revalidates in the background.
 const { data } = await withDurableCache(`combined-actual:${month}`, 2 * 60 * 1000, () => getCombinedActualForMonth(month), (d) => d != null, force);
 res.json(data);
 } catch (err) { next(err); }
});

// QB Cash P&L (Combined, all entities) per budget line for a date range -
// includes the in-progress month. (Diagnostic / variance Combined actual.)
app.get('/api/qb-expenses-range', async (req, res, next) => {
 try {
 const start = String(req.query.start ?? '').slice(0, 10);
 const end = String(req.query.end ?? '').slice(0, 10);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
 res.status(400).json({ error: 'start and end (YYYY-MM-DD) required' }); return;
 }
 const { getExpensesForRange } = await import('./weeklyActuals.js');
 res.json(await getExpensesForRange(start, end));
 } catch (err) { next(err); }
});


// AR projection methodology - per-customer collection lag, expected pay-day,
// collectibility haircut, lag curve, weekly placements. Powers the AR tab.
app.get('/api/ar-projection', async (_req, res, next) => {
 try {
 const { getArProjection } = await import('./arProjection.js');
 const now = new Date();
 const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
 const dow = t.getUTCDay();
 const monday = new Date(t.getTime() - (dow === 0 ? 6 : dow - 1) * 86400000);
 const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
 const weeks = Array.from({ length: 13 }, (_, i) => {
 const s = new Date(monday.getTime() + i * 7 * 86400000);
 const e = new Date(s.getTime() + 6 * 86400000);
 return { index: i, start: ymd(s), end: ymd(e), label: `${s.getUTCMonth() + 1}/${s.getUTCDate()}` };
 });
 const ar = await getArProjection(weeks.map((w) => ({ start: w.start, end: w.end })));
 res.json({ weeks, ...ar });
 } catch (err) { next(err); }
});

// Unified cashflow cell edits (inflow Sales/AR + outflow expenses), persisted
// to Supabase with attribution (who edited, when). Replaces the localStorage
// what-if store.
app.get('/api/cashflow-edits', async (_req, res, next) => {
 try {
 const { loadCashflowEdits } = await import('./cashflowEdits.js');
 res.json(await loadCashflowEdits());
 } catch (err) { next(err); }
});

app.post('/api/cashflow-edits', async (req, res, next) => {
 try {
 const { applyCashflowEdits } = await import('./cashflowEdits.js');
 const body = (req.body ?? {}) as { set?: Record<string, unknown>; clear?: unknown[]; by?: unknown; reasons?: Record<string, unknown> };
 const set: Record<string, number> = {};
 for (const [k, v] of Object.entries(body.set ?? {})) { const n = Number(v); if (k && Number.isFinite(n)) set[k] = n; }
 const clear = Array.isArray(body.clear) ? body.clear.filter((k): k is string => typeof k === 'string') : [];
 const by = typeof body.by === 'string' ? body.by : 'Unknown';
 const reasons: Record<string, string> = {};
 for (const [k, v] of Object.entries(body.reasons ?? {})) { if (k && typeof v === 'string') reasons[k] = v; }
 res.json(await applyCashflowEdits(set, clear, by, reasons));
 } catch (err) { next(err); }
});

// Per-PAYEE cashflow edits - the breakdown-level overrides behind each outflow
// line on the Expense Edit page (key: `${line}::${payee}|${weekStart}`). The
// line-level roll-up is still written to /api/cashflow-edits by the UI, so the
// 13-Week grid + dashboard reflect it without the engine knowing about payees.
app.get('/api/cashflow-payee-edits', async (_req, res, next) => {
 try {
 const { loadPayeeEdits } = await import('./cashflowPayeeEdits.js');
 res.json(await loadPayeeEdits());
 } catch (err) { next(err); }
});

app.post('/api/cashflow-payee-edits', async (req, res, next) => {
 try {
 const { applyPayeeEdits } = await import('./cashflowPayeeEdits.js');
 const body = (req.body ?? {}) as { set?: Record<string, unknown>; clear?: unknown[]; by?: unknown; reasons?: Record<string, unknown> };
 const set: Record<string, number> = {};
 for (const [k, v] of Object.entries(body.set ?? {})) { const n = Number(v); if (k && Number.isFinite(n)) set[k] = n; }
 const clear = Array.isArray(body.clear) ? body.clear.filter((k): k is string => typeof k === 'string') : [];
 const by = typeof body.by === 'string' ? body.by : 'Unknown';
 const reasons: Record<string, string> = {};
 for (const [k, v] of Object.entries(body.reasons ?? {})) { if (k && typeof v === 'string') reasons[k] = v; }
 res.json(await applyPayeeEdits(set, clear, by, reasons));
 } catch (err) { next(err); }
});

// Manual expense HEADS - payees the owner adds on the Expense Edit page that are
// not in the QB breakdown (name + details). Their per-week amounts live in the
// payee-edit store above and roll up into the line total.
app.get('/api/cashflow-manual-heads', async (_req, res, next) => {
 try {
 const { loadManualHeads } = await import('./cashflowManualHeads.js');
 res.json(await loadManualHeads());
 } catch (err) { next(err); }
});

app.post('/api/cashflow-manual-heads', async (req, res, next) => {
 try {
 const { addManualHead, removeManualHead } = await import('./cashflowManualHeads.js');
 const body = (req.body ?? {}) as { line?: unknown; name?: unknown; details?: unknown; by?: unknown; remove?: unknown };
 const line = typeof body.line === 'string' ? body.line : '';
 const name = typeof body.name === 'string' ? body.name : '';
 const details = typeof body.details === 'string' ? body.details : '';
 const by = typeof body.by === 'string' ? body.by : 'Unknown';
 if (!line || !name) { res.status(400).json({ error: 'line and name required' }); return; }
 res.json(body.remove === true ? await removeManualHead(line, name) : await addManualHead(line, name, details, by));
 } catch (err) { next(err); }
});

// Weekly snapshots + actuals - powers the Past Weeks variance view.
// Each snapshot stores what we forecasted on a given Monday for the next 13
// weeks. Actuals are computed live from Tiller transactions so they reflect
// the latest sync. The UI pairs each snapshot's Wk1 row with its actuals to
// surface variance (forecast vs. what really hit the bank).
app.get('/api/weekly-snapshots', async (_req, res, next) => {
 try {
 const { listSnapshots } = await import('./weeklySnapshots.js');
 const { getWeekActuals } = await import('./snapshotActuals.js');
 const snaps = await listSnapshots();
 const today = new Date().toISOString().slice(0, 10);
 const withActuals = await Promise.all(snaps.map(async (s) => {
  // Week range = the snapshot's Monday → +6 days. Compute actuals whenever
  // the week has STARTED (Monday <= today) - if mid-week, we cap the
  // upper bound at today so running totals come through (Tiller / Invoice
  // Tracker show what's already landed). Weeks that haven't begun yet
  // stay pending.
  const mon = new Date(s.monday + 'T00:00:00Z');
  const sun = new Date(mon.getTime() + 6 * 24 * 60 * 60 * 1000);
  const weekStart = s.monday;
  const sundayYmd = `${sun.getUTCFullYear()}-${String(sun.getUTCMonth() + 1).padStart(2, '0')}-${String(sun.getUTCDate()).padStart(2, '0')}`;
  // Only run actuals if the snapshot's week has actually begun.
  let actuals = null;
  if (weekStart <= today) {
   const effectiveEnd = sundayYmd <= today ? sundayYmd : today;
   try { actuals = await getWeekActuals(weekStart, effectiveEnd); }
   catch { actuals = null; }
  }
  return { snapshot: s, actuals, weekClosed: sundayYmd <= today };
 }));
 res.json({ count: withActuals.length, items: withActuals });
 } catch (err) { next(err); }
});

/**
 * Past-weeks grid - one row per CAPTURED snapshot (newest first). NO
 * pre-fill of historical weeks - past grows organically as each Monday's
 * snapshot rolls in from Future.
 *
 * Today (Tue May 16):
 *   Wk 1 = May 11-17 (snapshot captured this Monday, in-progress)
 *
 * Next Mon May 18 (after snapshot captures):
 *   Wk 1 = May 18-24 (new in-progress)
 *   Wk 2 = May 11-17 (just closed; was last week's Future Wk 1)
 *
 * Week after May 25:
 *   Wk 1 = May 25-31
 *   Wk 2 = May 18-24
 *   Wk 3 = May 11-17
 *
 * Each row has:
 *   - snapshot: forecast frozen that Monday morning (the "fc" projection)
 *   - actuals: live sales + AR from LT Financials in that week's date range
 *     (capped at today for in-progress weeks)
 */
app.get('/api/past-weeks-grid', async (req, res, next) => {
 try {
  const force = req.query.refresh === '1';
  // Durable-cached so the Past + Variance grid serves instantly on serverless,
  // but short TTL (2 min) so the sheet-sourced actuals (AR collected per week)
  // stay "live" - serves last-good instantly while revalidating in the background.
  const { data, cached } = await withDurableCache('past-weeks-grid', 2 * 60 * 1000, async () => {
  const { listSnapshots } = await import('./weeklySnapshots.js');
  const { getWeekActuals } = await import('./snapshotActuals.js');
  const { getWeeklyExpensesForWeeks, getExpectedInflowByWeek } = await import('./weeklyActuals.js');
  const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const addDaysUtc = (d: Date, n: number) => { const r = new Date(d); r.setUTCDate(d.getUTCDate() + n); return r; };
  const todayD = new Date();
  const todayStr = ymd(new Date(Date.UTC(todayD.getUTCFullYear(), todayD.getUTCMonth(), todayD.getUTCDate())));

  // Past view starts at the FIRST MONDAY OF MAY 2026 (per user) and runs to the
  // most recently CLOSED week - not a rolling 13-back window. Grows each week.
  const may1 = new Date(Date.UTC(2026, 4, 1));
  const dow = may1.getUTCDay();
  const START = addDaysUtc(may1, dow === 1 ? 0 : (8 - dow) % 7);
  const mondays: Array<{ monday: string; weekEnd: string }> = [];
  for (let i = 0; i < 30; i++) {
   const mon = addDaysUtc(START, i * 7);
   const sun = addDaysUtc(mon, 6);
   if (ymd(sun) >= todayStr) break;
   mondays.push({ monday: ymd(mon), weekEnd: ymd(sun) });
  }
  mondays.reverse();

  const snaps = await listSnapshots();
  const snapByMon = new Map(snaps.map((s) => [s.monday, s]));
  const expected = await getExpectedInflowByWeek(mondays.map((m) => ({ start: m.monday, end: m.weekEnd })));

  // Snapshot + sheet actuals in parallel (no QB involved).
  const items: Array<Record<string, unknown>> = await Promise.all(mondays.map(async (m, i) => {
   let actuals = null;
   try { actuals = await getWeekActuals(m.monday, m.weekEnd); } catch { actuals = null; }
   return {
    monday: m.monday, weekEnd: m.weekEnd, weekClosed: true,
    snapshot: snapByMon.get(m.monday) ?? null,
    actuals, qbExpenses: null,
    expectedInflow: expected[i] ?? null,
   };
  }));

  // QB per-category expenses: ONE P&L report (summarize_column_by=Week) for the
  // whole window, mapped per week. One token, one call - fast. Cached 6h.
  try {
   const wexp = await getWeeklyExpensesForWeeks(mondays.map((m) => ({ start: m.monday, end: m.weekEnd })));
   const byStart = new Map(wexp.map((w) => [w.weekStart, w]));
   for (const it of items) it.qbExpenses = byStart.get(it.monday as string) ?? null;
  } catch (e) {
   (items[0] ?? {}).qbErr = e instanceof Error ? e.message : String(e);
  }
  return { count: items.length, items };
  }, (d) => d != null && Array.isArray((d as { items?: unknown }).items), force);
  res.json({ cached, ...data });
 } catch (err) { next(err); }
});

app.delete('/api/weekly-snapshots/:monday', async (req, res, next) => {
 try {
 const { deleteSnapshot } = await import('./weeklySnapshots.js');
 const ok = await deleteSnapshot(req.params.monday);
 res.json({ deleted: ok, monday: req.params.monday });
 } catch (err) { next(err); }
});

// Sales Forecast - full transparency endpoint. Same Mon-Sun, 13-week anchor
// as the 13-week cashflow, but returns the full per-brand drilldown (history,
// trend, bounds, lag curve, weekly cash) so the Sales Forecast page can
// explain WHY each number was chosen.
app.get('/api/current-month-overview', async (req, res, next) => {
 try {
  const force = req.query.refresh === '1';
  // Durable-cached so the Actuals tab serves instantly on serverless, but short
  // TTL (2 min) so the sheet-sourced sales + AR actuals stay "live" - serves
  // last-good instantly while revalidating in the background.
  const { data, cached } = await withDurableCache('current-month-overview', 2 * 60 * 1000, async () => {
  const { getArActualsForWeek, getSalesInvoicedForWeek, getOpenArAsOf } = await import('./snapshotActuals.js');
  const { getSalesForecast } = await import('./salesForecast.js');
  const { getArProjection } = await import('./arProjection.js');
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();              // 0-11
  const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const monthStart = ymd(new Date(Date.UTC(year, month, 1)));
  const today = ymd(now);
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const dayOfMonth = now.getUTCDate();
  const monthEnd = ymd(new Date(Date.UTC(year, month + 1, 0)));
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
  // Build the same Monday-anchored 13-week grid used by cashflow
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = todayUtc.getUTCDay();
  const shift = dow === 0 ? 6 : dow - 1;
  const monday = new Date(todayUtc.getTime() - shift * 86400000);
  const weeks: { start: string; end: string; label: string }[] = [];
  for (let i = 0; i < 13; i++) {
   const ws = new Date(monday.getTime() + i * 7 * 86400000);
   const we = new Date(ws.getTime() + 6 * 86400000);
   weeks.push({ start: ymd(ws), end: ymd(we), label: `${String(ws.getUTCMonth() + 1).padStart(2, '0')}/${String(ws.getUTCDate()).padStart(2, '0')}` });
  }
  const { getGelatoAr } = await import('./gelatoAr.js');
  const [arActualsMtd, salesInvoicedMtd, openAr, salesForecast, arProj, gelato] = await Promise.all([
   getArActualsForWeek(monthStart, today),
   getSalesInvoicedForWeek(monthStart, today),
   getOpenArAsOf(today),
   getSalesForecast(weeks),
   getArProjection(weeks),
   getGelatoAr().catch(() => null),
  ]);
  // AR projection for current month:
  //   Non-Gelato = sum of arProj.arByWeek for weeks that start in this calendar month
  //   Gelato = sum of pending Gelato invoices whose Net-97 expected pay date lands in this month
  let arProjNonGelatoMonth = 0;
  for (let i = 0; i < weeks.length; i++) {
   if (weeks[i].start.slice(0, 7) === ym) arProjNonGelatoMonth += arProj?.arByWeek?.[i] ?? 0;
  }
  const MONTH_PREFIX = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  function parseGelatoIssue(s: string): Date | null {
   const t = (s ?? '').trim();
   if (!t) return null;
   // "Month YYYY" (e.g. "January 2026") - billed end-of-month, so use last day.
   const mn = t.match(/^([A-Za-z]{3,})\s+(\d{4})$/);
   if (mn) {
    const monthIdx = MONTH_PREFIX.indexOf(mn[1].toLowerCase().substring(0, 3));
    if (monthIdx >= 0) {
     const yr = +mn[2];
     const lastDay = new Date(Date.UTC(yr, monthIdx + 1, 0)).getUTCDate();
     return new Date(Date.UTC(yr, monthIdx, lastDay));
    }
   }
   // YYYY-MM-DD
   const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
   if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
   // M/D/YY or M/D/YYYY
   const md = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
   if (md) {
    const yr = md[3].length === 2 ? 2000 + +md[3] : +md[3];
    return new Date(Date.UTC(yr, +md[1] - 1, +md[2]));
   }
   return null;
  }
  let arProjGelatoMonth = 0;
  if (gelato) {
   for (const inv of gelato.pendingInvoices) {
    const issue = parseGelatoIssue(inv.period) ?? parseGelatoIssue(inv.comment);
    if (!issue) continue;
    const expected = new Date(issue.getTime() + 97 * 86400000);
    const expYm = `${expected.getUTCFullYear()}-${String(expected.getUTCMonth() + 1).padStart(2, '0')}`;
    if (expYm === ym) arProjGelatoMonth += inv.amount;
   }
  }
  // Sales projection for current month: from approved monthlyForecastV2 (base scenario)
  const salesProjMonth = salesForecast.monthlyForecastV2.find(m => m.ym === ym)?.forecastedSales ?? 0;
  const salesProjBest  = salesForecast.monthlyForecastBest .find(m => m.ym === ym)?.forecastedSales ?? 0;
  const salesProjWorst = salesForecast.monthlyForecastWorst.find(m => m.ym === ym)?.forecastedSales ?? 0;
  return {
   month: { ym, label: monthLabel, start: monthStart, end: monthEnd, daysInMonth, dayOfMonth, progressPct: +(dayOfMonth / daysInMonth * 100).toFixed(1) },
   sales: {
    projected: { base: salesProjMonth, best: salesProjBest, worst: salesProjWorst },
    invoicedMtd: { gelato: salesInvoicedMtd.gelato.amount, nonGelato: salesInvoicedMtd.nonGelato.amount, total: salesInvoicedMtd.gelato.amount + salesInvoicedMtd.nonGelato.amount, invoiceCount: salesInvoicedMtd.gelato.invoiceCount + salesInvoicedMtd.nonGelato.invoiceCount },
   },
   ar: {
    gelato:    { projected: arProjGelatoMonth, collected: arActualsMtd.gelato.amount, invoiceCount: arActualsMtd.gelato.invoiceCount },
    nonGelato: { projected: arProjNonGelatoMonth, collected: arActualsMtd.nonGelato.amount, invoiceCount: arActualsMtd.nonGelato.invoiceCount },
   },
   openArAsOfToday: openAr,
  };
  }, (d) => d != null, force);
  res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Drill-down: invoices that landed in a specific week (LT Financials).
// Used by the Sales Forecast page so the user can click a row in the
// "Weekly trend" table and see exactly which invoices made up the total.
// Excludes the 4 brand-side customers (same regex used by the forecast).
app.get('/api/sales-week-invoices', async (req, res, next) => {
 try {
  const weekStart = String(req.query.weekStart || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
   return res.status(400).json({ error: 'weekStart must be YYYY-MM-DD (Monday)' });
  }
  const start = new Date(weekStart + 'T00:00:00Z');
  const end = new Date(start.getTime() + 7 * 86400000);   // Mon..Sun
  const { getLtFinancialsSales } = await import('./ltFinancialsSales.js');
  const EXCLUDED = /(?:little tree[- ]+)?(gelato|alien\s+(?:brainz|brains|arainz)\b|funk'?d?\s*up\b|(?:yacht|tacht)\s+fuel)/i;
  const GELATO = /(?:little tree[- ]+)?gelato/i;
  const PRIVATE_LABEL = /(alien\s+(?:brainz|brains|arainz)\b|funk'?d?\s*up\b|(?:yacht|tacht)\s+fuel)/i;
  // Filter the drill-down to the SELECTED bucket so it matches the table above
  // (previously hardcoded to wholesale, so Gelato/Private Label showed Little
  // Tree wholesale invoices). Default = wholesale (everything not Gelato/PL).
  const bucket = String(req.query.bucket || 'wholesale');
  const matchBucket = (c: string) =>
   bucket === 'gelato' ? GELATO.test(c)
   : bucket === 'privateLabel' ? PRIVATE_LABEL.test(c)
   : !EXCLUDED.test(c);
  const r = await getLtFinancialsSales();
  const matches = r.invoices
   .filter((inv) => inv.amount > 0
     && inv.invoiceDate >= start && inv.invoiceDate < end
     && matchBucket(inv.customer))
   .map((inv) => ({
    invoiceNumber: inv.invoiceNumber,
    date: inv.date,
    customer: inv.customer,
    amount: inv.amount,
    paid: inv.paid,
    paidDate: inv.paidDateRaw,
    channel: inv.channel,
   }))
   // Chronological within the week - user reads top-to-bottom as Mon → Sun
   .sort((a, b) => {
     // Sort by parsed invoice date (date string is M/D/YY or M/D/YYYY).
     const parse = (s: string) => {
       const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
       if (!m) return 0;
       const yr = m[3].length === 2 ? 2000 + +m[3] : +m[3];
       return Date.UTC(yr, +m[1] - 1, +m[2]);
     };
     return parse(a.date) - parse(b.date);
   });
  res.json({
   weekStart, weekEnd: end.toISOString().slice(0, 10),
   invoiceCount: matches.length,
   total: +matches.reduce((s, m) => s + m.amount, 0).toFixed(2),
   invoices: matches,
  });
 } catch (err) { next(err); }
});

app.get('/api/sales-forecast', async (_req, res, next) => {
 try {
 const { getSalesForecast } = await import('./salesForecast.js');
 // Build the same Monday-anchored 13-week grid that cashflow13 uses.
 const now = new Date();
 const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
 const day = todayUtc.getUTCDay();
 const shift = day === 0 ? 6 : day - 1;
 const monday = new Date(todayUtc.getTime() - shift * 86400000);
 const weeks: { start: string; end: string; label: string }[] = [];
 for (let i = 0; i < 13; i++) {
  const ws = new Date(monday.getTime() + i * 7 * 86400000);
  const we = new Date(ws.getTime() + 6 * 86400000);
  const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  weeks.push({ start: ymd(ws), end: ymd(we), label: `${String(ws.getUTCMonth() + 1).padStart(2, '0')}/${String(ws.getUTCDate()).padStart(2, '0')}` });
 }
 const result = await getSalesForecast(weeks);
 res.json(result);
 } catch (err) { next(err); }
});

// A result computed while QB was throttled/down carries a failure warning -
// never cache it (it would poison the cache with degraded data and the page can
// break on it). Informational warnings (e.g. "excluded intercompany account")
// are fine and still cacheable.
const noBadWarning = (warnings?: unknown): boolean => {
  if (!Array.isArray(warnings)) return true;
  return !warnings.some((w) => typeof w === 'string'
    && /throttl|\b429\b|not connected|invalid_grant|query failed|temporarily unavailable|ThrottleExceeded/i.test(w));
};

// Current Position snapshot - moderate cost (3 QB queries). Cache 30 min.
const CP_TTL_MS = 30 * 60 * 1000;
// Durable-cached: serve the last GOOD position if QB is throttled/down, and
// never cache a throttle-degraded result.
const getCurrentPositionCached = (force = false) =>
  withDurableCache('current-position', CP_TTL_MS, getCurrentPosition, (d) => noBadWarning(d.warnings), force);

app.get('/api/current-position', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data, cached } = await getCurrentPositionCached(force);
 res.json({ cached, ...data });
 } catch (err) {
 next(err);
 }
});

// Tiller live balances - fetches the user's Tiller Money Google Sheet which
// syncs daily from the actual banks. Cache 5 min; background prefetcher keeps
// the value warm so user requests always hit cache. ?refresh=1 to force.
const TILLER_TTL_MS = 10 * 1000;
let tillerCache: { at: number; data: TillerBalances } | null = null;
let tillerInFlight: Promise<TillerBalances> | null = null;

app.get('/api/tiller/balances', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 if (!force && tillerCache && Date.now() - tillerCache.at < TILLER_TTL_MS) {
 res.json({ cached: true, ...tillerCache.data });
 return;
 }
 if (!tillerInFlight) {
 tillerInFlight = getTillerBalances()
 .then((data) => {
 tillerCache = { at: Date.now(), data };
 return data;
 })
 .finally(() => {
 tillerInFlight = null;
 });
 }
 const data = await tillerInFlight;
 res.json({ cached: false, ...data });
 } catch (err) { next(err); }
});

// Linked accounts - QB chart of accounts (what to show) × Tiller balances (the $).
// Served through the durable Supabase cache so a QB hiccup never breaks the page.
// Short TTL (2 min) so the Current Position cash (Tiller-sheet balances) stays
// "live" - it serves last-good instantly and revalidates in the background, and
// the QB account list it pulls is itself coalesced/cached (~60s) so this is cheap.
const LINKED_TTL_MS = 2 * 60 * 1000;
// A result is "good" (worth caching) only when QB actually returned accounts and
// there's no auth warning. A degraded result never overwrites the last good one.
const isGoodLinked = (d: LinkedBalances): boolean =>
  noBadWarning(d.warnings) &&
  d.qb.cashAccounts.length + d.qb.creditCards.length > 0;
const getLinkedBalancesCached = (force = false) =>
  withDurableCache('linked-balances', LINKED_TTL_MS, getLinkedBalances, isGoodLinked, force);

app.get('/api/tiller-transactions', async (req, res, next) => {
 try {
 const { getTillerTransactions, invalidateTillerTransactionsCache } = await import('./tillerTransactions.js');
 if (req.query.refresh === '1') invalidateTillerTransactionsCache();
 const data = await getTillerTransactions();
 res.json(data);
 } catch (err) { next(err); }
});

app.get('/api/reconciliation', async (req, res, next) => {
 try {
 const { getReconciliation } = await import('./tillerQbReco.js');
 const { data } = await withDurableCache('reconciliation', 30 * 60 * 1000, getReconciliation, () => true, req.query.refresh === '1');
 res.json(data);
 } catch (err) { next(err); }
});

// Sales by Product - aggregates every QB Invoice line item to surface
// top-selling SKUs, unit prices, and customer breakdowns.
app.get('/api/sales-by-product', async (req, res, next) => {
 try {
 const { getSalesByProduct } = await import('./salesByProduct.js');
 const { data } = await withDurableCache('sales-by-product', 30 * 60 * 1000, getSalesByProduct, () => true, req.query.refresh === '1');
 res.json(data);
 } catch (err) { next(err); }
});

app.get('/api/linked-balances', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data, cached } = await getLinkedBalancesCached(force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Raw QB Balance Sheet - live pass-through of Reports/BalanceSheet.
// Cached separately for Accrual vs Cash basis (mirrors P&L pattern).
const QBBS_TTL_MS = 30 * 60 * 1000;
type QbBsMethod = 'Accrual' | 'Cash';
const qbbsCacheByMethod: Record<QbBsMethod, { at: number; data: QbBalanceSheetReport } | null> = { Accrual: null, Cash: null };
const qbbsInFlightByMethod: Record<QbBsMethod, Promise<QbBalanceSheetReport> | null> = { Accrual: null, Cash: null };

app.get('/api/qb-balance-sheet', async (req, res, next) => {
 try {
 const method: QbBsMethod = req.query.method === 'Cash' ? 'Cash' : 'Accrual';
 const force = req.query.refresh === '1';
 const { data, cached } = await withDurableCache(`qb-balance-sheet:${method}`, QBBS_TTL_MS, () => getQbBalanceSheet(method), () => true, force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Raw QB P&L Report - live pass-through of Reports/ProfitAndLoss.
// Cached separately for Accrual vs Cash basis.
const QBPL_TTL_MS = 30 * 60 * 1000;
type QbPlMethod = 'Accrual' | 'Cash';
const qbplCacheByMethod: Record<QbPlMethod, { at: number; data: QbPlReport } | null> = { Accrual: null, Cash: null };
const qbplInFlightByMethod: Record<QbPlMethod, Promise<QbPlReport> | null> = { Accrual: null, Cash: null };

app.get('/api/qb-pl-report', async (req, res, next) => {
 try {
 const method: QbPlMethod = req.query.method === 'Cash' ? 'Cash' : 'Accrual';
 const force = req.query.refresh === '1';
 const { data, cached } = await withDurableCache(`qb-pl-report:${method}`, QBPL_TTL_MS, () => getQbPlReport(method, force), () => true, force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Expenses straight from the QB P&L, grouped by YOUR category mapping (no sheet).
// Reuses the cached P&L report + fresh overrides so it reflects mapping edits at once.
app.get('/api/pnl-expenses', async (req, res, next) => {
 try {
 const method: QbPlMethod = req.query.method === 'Cash' ? 'Cash' : 'Accrual';
 const force = req.query.refresh === '1';
 const { data: report } = await withDurableCache(`qb-pl-report:${method}`, QBPL_TTL_MS, () => getQbPlReport(method, force), () => true, force);
 const overrides = await loadOverrides();
 res.json(computePnlExpenses(report, overrides));
 } catch (err) { next(err); }
});

// Per-account transaction drill-down for the Live P&L tab. Cached per account
// for 2 minutes (heavy query: Purchases + Bills + BillPayments + JournalEntries).
const ACCT_TXN_TTL_MS = 30 * 60 * 1000;
const acctTxnCache = new Map<string, { at: number; data: AccountTransactionsResult }>();
const acctTxnInFlight = new Map<string, Promise<AccountTransactionsResult>>();

app.get('/api/account-transactions', async (req, res, next) => {
 try {
 const account = String(req.query.account ?? '').trim();
 if (!account) {
 res.status(400).json({ error: 'Missing ?account=<name>' });
 return;
 }
 const force = req.query.refresh === '1';
 const cached = acctTxnCache.get(account);
 if (!force && cached && Date.now() - cached.at < ACCT_TXN_TTL_MS) {
 res.json({ cached: true, ...cached.data });
 return;
 }
 let p = acctTxnInFlight.get(account);
 if (!p) {
 // include journal entries in the drill-down so it ties out to the P&L
 p = getAccountTransactions(account, true)
 .then((data) => { acctTxnCache.set(account, { at: Date.now(), data }); return data; })
 .finally(() => { acctTxnInFlight.delete(account); });
 acctTxnInFlight.set(account, p);
 }
 res.json({ cached: false, ...(await p) });
 } catch (err) { next(err); }
});

// Inventory purchases - Bills/Purchases posting to inventory ASSET accounts.
// Pulled separately from the P&L flow because inventory accounting in QB
// posts to Balance Sheet, not P&L.
const INV_TTL_MS = 30 * 60 * 1000;

app.get('/api/inventory-purchases', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 // isGood: only cache a non-zero total (a $0 usually means QBO 429 killed the
 // per-account fetches - don't poison the cache with it).
 const { data, cached } = await withDurableCache('inventory-purchases', INV_TTL_MS, getInventoryPurchases, (d) => d.total > 0, force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Historical Sales by Channel - derived from the AR sheet, grouped by channel
// with tax-affected months normalized.
const SBC_TTL_MS = 10 * 1000;
let sbcCache: { at: number; data: SalesByChannelResult } | null = null;
let sbcInFlight: Promise<SalesByChannelResult> | null = null;

app.get('/api/ar-status', async (_req, res, next) => {
 try {
   const { getArStatus } = await import('./arStatus.js');
   res.json(await getArStatus());
 } catch (err) { next(err); }
});

app.get('/api/sales-status', async (_req, res, next) => {
 try {
   const { getSalesStatus } = await import('./salesStatus.js');
   res.json(await getSalesStatus());
 } catch (err) { next(err); }
});

app.get('/api/gelato-ar-status', async (_req, res, next) => {
 try {
   const { getGelatoArStatus } = await import('./gelatoArStatus.js');
   res.json(await getGelatoArStatus());
 } catch (err) { next(err); }
});

app.get('/api/upflow', async (req, res, next) => {
 try {
   const { getUpflowDashboard } = await import('./upflow.js');
   const force = req.query.refresh === '1';
   res.json(await getUpflowDashboard({ force }));
 } catch (err) { next(err); }
});

app.get('/api/sales-by-reps', async (req, res, next) => {
 try {
   const { getSalesByReps } = await import('./salesByReps.js');
   const { data } = await withDurableCache('sales-by-reps', 30 * 60 * 1000, getSalesByReps, () => true, req.query.refresh === '1');
   res.json(data);
 } catch (err) { next(err); }
});

app.get('/api/commission', async (_req, res, next) => {
 try {
   const { getCommissionCalc } = await import('./commissionCalc.js');
   res.json(await getCommissionCalc());
 } catch (err) { next(err); }
});

app.post('/api/commission/override', async (req, res, next) => {
 try {
   const { invoiceNumber, type } = req.body ?? {};
   if (!invoiceNumber || typeof invoiceNumber !== 'string') {
     res.status(400).json({ error: 'invoiceNumber required' });
     return;
   }
   if (type !== null && !['NEW', 'OLD', 'WHITELABEL'].includes(type)) {
     res.status(400).json({ error: 'type must be NEW / OLD / WHITELABEL / null' });
     return;
   }
   const { setCommissionOverride } = await import('./commissionOverrides.js');
   const result = await setCommissionOverride(invoiceNumber, type);
   res.json({ ok: true, overrides: result.overrides });
 } catch (err) { next(err); }
});

app.post('/api/commission/rep-override', async (req, res, next) => {
 try {
   const { invoiceNumber, rep } = req.body ?? {};
   if (!invoiceNumber || typeof invoiceNumber !== 'string') {
     res.status(400).json({ error: 'invoiceNumber required' });
     return;
   }
   if (rep !== null && typeof rep !== 'string') {
     res.status(400).json({ error: 'rep must be a string or null' });
     return;
   }
   const { setCommissionRepOverride } = await import('./commissionOverrides.js');
   const result = await setCommissionRepOverride(invoiceNumber, rep);
   res.json({ ok: true, overrides: result.overrides });
 } catch (err) { next(err); }
});

app.post('/api/upflow/assign-plan', async (req, res, next) => {
 try {
   const { customerId, dunningPlanId } = req.body ?? {};
   if (!customerId || typeof customerId !== 'string') {
     res.status(400).json({ error: 'customerId required' });
     return;
   }
   if (dunningPlanId !== null && typeof dunningPlanId !== 'string') {
     res.status(400).json({ error: 'dunningPlanId must be a string or null' });
     return;
   }
   const { assignCustomerDunningPlan } = await import('./upflow.js');
   const result = await assignCustomerDunningPlan(customerId, dunningPlanId);
   res.json(result);
 } catch (err) { next(err); }
});

app.get('/api/sales-by-channel', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 if (!force && sbcCache && Date.now() - sbcCache.at < SBC_TTL_MS) {
 res.json({ cached: true, ...sbcCache.data });
 return;
 }
 if (!sbcInFlight) {
 sbcInFlight = getSalesByChannel()
 .then((data) => { sbcCache = { at: Date.now(), data }; return data; })
 .finally(() => { sbcInFlight = null; });
 }
 res.json({ cached: false, ...(await sbcInFlight) });
 } catch (err) { next(err); }
});

// AR live ledger - fetched from the user's invoice Google Sheet.
// Little Tree open AR. Durable-cached (Supabase) so a serverless cold start
// serves last-good instantly instead of re-scraping the sheet on every poll.
// Short TTL (60s) so sheet edits (new/paid invoices) show up "live" - the
// stale-while-revalidate cache still serves instantly, this just refreshes sooner.
const AR_TTL_MS = 60 * 1000;
const isGoodAr = (d: ArResult): boolean => d != null && d.totals != null;
const getArOpenCached = (force = false) =>
  withDurableCache('ar-open', AR_TTL_MS, getArOpen, isGoodAr, force);

app.get('/api/ar/open', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data, cached } = await getArOpenCached(force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Mapped expenses - sheet-structured categories with QB-live values.
const MAPPED_TTL_MS = 30 * 60 * 1000;

app.get('/api/expenses-mapped', async (req, res, next) => {
 try {
 const entity = (String(req.query.entity ?? 'Combined')) as SheetEntity;
 if (!['PureX', 'Moysh', 'Combined'].includes(entity)) {
 res.status(400).json({ error: `Invalid entity: ${entity}` });
 return;
 }
 const months = Math.min(36, Math.max(1, Number(req.query.months ?? 14)));
 const force = req.query.refresh === '1';
 if (force) invalidateMappedExpensesCache();
 // getMappedExpenses is durable-cached internally (shared with 13-week + opex).
 const data = await getMappedExpenses(entity, months, force);
 res.json({ cached: !force, ...(entity === 'Combined' ? { derived: 'PureX + Moysh' } : {}), ...data });
 } catch (err) { next(err); }
});

// Gelato AR - live from the Gelato Sales / Batches Google Sheet. Durable-cached
// so a serverless cold start serves last-good instantly (no re-scrape per poll).
// Short TTL (60s) so sheet edits surface "live".
const GELATO_TTL_MS = 60 * 1000;
const isGoodGelato = (d: GelatoArResult): boolean => d != null && d.totals != null;
const getGelatoArCached = (force = false) =>
  withDurableCache('gelato-ar', GELATO_TTL_MS, getGelatoAr, isGoodGelato, force);

app.get('/api/gelato-ar', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data, cached } = await getGelatoArCached(force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Empirical AR collection curve (from Invoice Tracker paid history) - the
// transparency layer behind the 13-week AR + sales projections.
let collCurveCache: { at: number; data: CollectionCurveResult } | null = null;
let collCurveInFlight: Promise<CollectionCurveResult> | null = null;
const COLL_CURVE_TTL_MS = 5 * 60 * 1000;
app.get('/api/collection-curve', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 if (!force && collCurveCache && Date.now() - collCurveCache.at < COLL_CURVE_TTL_MS) {
 res.json({ cached: true, ...collCurveCache.data });
 return;
 }
 if (!collCurveInFlight) {
 collCurveInFlight = getCollectionCurve()
 .then((data) => { collCurveCache = { at: Date.now(), data }; return data; })
 .finally(() => { collCurveInFlight = null; });
 }
 res.json({ cached: false, ...(await collCurveInFlight) });
 } catch (err) { next(err); }
});

// PureX clearing - Sales (tracker sheet) − Expense (QB PureX-paid). Durable-cached
// so a serverless cold start serves last-good instantly (no recompute per poll).
const PUREX_TTL_MS = 5 * 60 * 1000;
const isGoodPurex = (d: PurexClearingResult): boolean => d != null && Number.isFinite(d.clearing);
const getPurexClearingCached = (force = false) =>
  withDurableCache('purex-clearing', PUREX_TTL_MS, getPurexClearing, isGoodPurex, force);

app.get('/api/purex-clearing', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data, cached } = await getPurexClearingCached(force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Settlement History - PureX → LT settlements parsed live from Expenses tab.
const SETTLE_TTL_MS = 10 * 1000;
let settleCache: { at: number; data: SettlementHistoryResult } | null = null;
let settleInFlight: Promise<SettlementHistoryResult> | null = null;

app.get('/api/settlement-history', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 if (!force && settleCache && Date.now() - settleCache.at < SETTLE_TTL_MS) {
 res.json({ cached: true, ...settleCache.data });
 return;
 }
 if (!settleInFlight) {
 settleInFlight = getSettlementHistory()
 .then((data) => { settleCache = { at: Date.now(), data }; return data; })
 .finally(() => { settleInFlight = null; });
 }
 res.json({ cached: false, ...(await settleInFlight) });
 } catch (err) { next(err); }
});

// AR Aging - Gelato Pending invoices aged + collection probability + pred week.
const AGE_TTL_MS = 30 * 60 * 1000;

app.get('/api/ar-aging', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data, cached } = await withDurableCache('ar-aging', AGE_TTL_MS, getArAging, () => true, force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Monthly OpEx - LT vs PureX split, per month, with PureX remitted.
const MOPEX_TTL_MS = 30 * 60 * 1000;

app.get('/api/monthly-opex', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data, cached } = await withDurableCache('monthly-opex', MOPEX_TTL_MS, getMonthlyOpex, () => true, force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Inflow Schedule - weekly receivables forecast per source.
const INFLOW_TTL_MS = 30 * 60 * 1000;

app.get('/api/inflow-schedule', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 const { data, cached } = await withDurableCache('inflow-schedule', INFLOW_TTL_MS, getInflowSchedule, () => true, force);
 res.json({ cached, ...data });
 } catch (err) { next(err); }
});

// Sheet expenses - all PureX expenses categorized (payroll/inventory/other).
const SE_TTL_MS = 10 * 1000;
let seCache: { at: number; data: SheetExpensesResult } | null = null;
let seInFlight: Promise<SheetExpensesResult> | null = null;

app.get('/api/sheet-expenses', async (req, res, next) => {
 try {
 const force = req.query.refresh === '1';
 if (!force && seCache && Date.now() - seCache.at < SE_TTL_MS) {
 res.json({ cached: true, ...seCache.data });
 return;
 }
 if (!seInFlight) {
 seInFlight = getSheetExpenses()
 .then((data) => { seCache = { at: Date.now(), data }; return data; })
 .finally(() => { seInFlight = null; });
 }
 res.json({ cached: false, ...(await seInFlight) });
 } catch (err) { next(err); }
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
 console.error('[error]', err);
 const msg = err.message || 'Internal error';
 const status = msg.includes('Not connected') ? 401 : 500;
 res.status(status).json({ error: msg });
});

// ============================================================================
// Background prefetcher - keeps every cache warm so user-facing tabs never
// wait on upstream (QB / Google Sheets) calls.
//
// Two separate cycles:
// - SHEET cycle (90 s): Tiller, AR, Gelato, settlements, sheet-payroll/expenses,
// inflow - Google Sheets gviz has no real rate limit, so refresh often.
// - QB cycle (60 min): everything that hits QuickBooks Online - P&L, Balance
// Sheet, expense detail, mapped expenses, inventory, cashflow-13week,
// current-position. QBO's "Default" throttle plan caps heavy reports tight
// and we were hitting 429 frequently; once an hour is plenty for a
// financial dashboard. User-facing requests serve from cache (last-good
// value) so the UI stays snappy even while QB is slow.
// ============================================================================
const PREFETCH_SHEET_INTERVAL_MS = 30 * 1000; // 30 seconds - sheets (near-live)
const PREFETCH_QB_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes - QB

async function warm<T>(name: string, fn: () => Promise<T>, set: (data: T, at: number) => void): Promise<void> {
 try {
 const data = await fn();
 set(data, Date.now());
 } catch (e) {
 // Don't crash the prefetch cycle; one upstream being down shouldn't take
 // out the others. Cache keeps last-good value.
 console.error(`[prefetch ${name}]`, e instanceof Error ? e.message : e);
 }
}

async function prewarmSheetCaches(): Promise<void> {
 const t0 = Date.now();
 await Promise.allSettled([
 warm('tiller', () => getTillerBalances(), (data, at) => { tillerCache = { at, data }; }),
 warm('ar', () => getArOpenCached(true), () => {/* durable cache populated inside */}),
 warm('gelato-ar', () => getGelatoArCached(true), () => {/* durable cache populated inside */}),
 warm('settlement', () => getSettlementHistory(), (data, at) => { settleCache = { at, data }; }),
 warm('purex-clearing', () => getPurexClearingCached(true), () => {/* durable cache populated inside */}),
 warm('sheet-expenses', () => getSheetExpenses(), (data, at) => { seCache = { at, data }; }),
 ]);
 // Cashflow-13week reads sheet AR live each call, but its QB-side inputs
 // (mappedExpenses / inventoryPurchases) are served from their own 60-min
 // module caches - so re-warming here is cheap and propagates fresh sheet
 // data to the 13-week table within 30s of an invoice add.
 await warm('cashflow-13week', () => getCashflow13WeekCached('future', true), () => {});
 console.log(`[prefetch sheets] refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function prewarmQbCaches(): Promise<void> {
 const t0 = Date.now();
 // QB calls - run sequentially (not parallel) to spread out throttle pressure.
 // Each call may take 5-15s; total cycle takes ~1-2 min once an hour.
 await warm('linked', () => getLinkedBalancesCached(true), () => {/* durable cache populated inside */});
 const noop = () => {/* durable cache populated inside withDurableCache */};
 await warm('dashboard', () => withDurableCache('dashboard', 30 * 60 * 1000, () => getDashboardData(12), () => true, true), noop);
 await warm('ar-aging', () => withDurableCache('ar-aging', AGE_TTL_MS, getArAging, () => true, true), noop);
 await warm('inflow', () => withDurableCache('inflow-schedule', INFLOW_TTL_MS, getInflowSchedule, () => true, true), noop);
 await warm('inventory-purchases', () => withDurableCache('inventory-purchases', INV_TTL_MS, getInventoryPurchases, (d) => d.total > 0, true), noop);
 await warm('qb-pl-accrual', () => withDurableCache('qb-pl-report:Accrual', QBPL_TTL_MS, () => getQbPlReport('Accrual'), () => true, true), noop);
 await warm('qb-pl-cash', () => withDurableCache('qb-pl-report:Cash', QBPL_TTL_MS, () => getQbPlReport('Cash'), () => true, true), noop);
 await warm('qb-bs-accrual', () => withDurableCache('qb-balance-sheet:Accrual', QBBS_TTL_MS, () => getQbBalanceSheet('Accrual'), () => true, true), noop);
 await warm('qb-bs-cash', () => withDurableCache('qb-balance-sheet:Cash', QBBS_TTL_MS, () => getQbBalanceSheet('Cash'), () => true, true), noop);
 await warm('expense-detail', () => withDurableCache('expense-detail', DETAIL_TTL_MS, getExpenseDetail, () => true, true), noop);
 await warm('monthly-opex', () => withDurableCache('monthly-opex', MOPEX_TTL_MS, getMonthlyOpex, () => true, true), noop);
 await warm('current-position', () => getCurrentPositionCached(true), noop);
 await warm('mapped-PureX', () => getMappedExpenses('PureX', 14, true), noop);
 await warm('mapped-Moysh', () => getMappedExpenses('Moysh', 14, true), noop);
 // Combined is derived (PureX + Moysh) - no separate prewarm needed.
 // cashflow-13week depends on the above, run it last.
 await warm('cashflow-13week', () => getCashflow13WeekCached('future', true), noop);
 console.log(`[prefetch qb] refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ────────────────────────────────────────────────────────────────────
//  Static frontend hosting (single-process deploy)
//  Replit serves both the AR Dashboard + Cashflow Dashboard out of
//  the same Node process. The Vite build drops everything into ../dist
//  (relative to this file's cashflow-server/ folder during runtime).
//  Resolution order per request:
//     /api/*, /auth/*          → handled by the API routes above
//     /cashflow OR /cashflow/* → cashflow.html  (Cashflow SPA entry)
//     real file (assets, png)  → static file from dist/
//     anything else            → index.html     (AR Dashboard SPA entry)
// ────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev (tsx watch) we're at cashflow-server/src/, in prod (compiled)
// at cashflow-server/dist/. The frontend build sits two levels up either
// way: ../../dist. Resolve and only enable static serving if it exists.
const FRONTEND_DIST = path.resolve(__dirname, '..', '..', 'dist');
if (fs.existsSync(FRONTEND_DIST)) {
 console.log(`[static] serving frontend from ${FRONTEND_DIST}`);
 // Hashed asset files are immutable - long cache. HTML must revalidate.
 app.use(express.static(FRONTEND_DIST, {
   index: false,
   setHeaders: (res, filePath) => {
     if (/\.html$/.test(filePath)) {
       res.setHeader('Cache-Control', 'no-cache, must-revalidate');
     } else {
       res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
     }
   },
 }));

 // /cashflow or /cashflow/whatever → Cashflow SPA
 app.get(/^\/cashflow(\/.*)?$/, (_req, res) => {
   res.sendFile(path.join(FRONTEND_DIST, 'cashflow.html'));
 });

 // Everything else (that isn't /api or /auth) → AR Dashboard SPA
 app.get('*', (req, res, next) => {
   if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
   res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
 });
} else {
 console.log('[static] no dist/ found - running API only (frontend served by Vite dev server)');
}

if (!process.env.VERCEL) app.listen(config.port, () => {
 console.log(`Cashflow LT server listening on http://localhost:${config.port}`);
 console.log(`QBO environment: ${config.qbo.environment}`);
 console.log(`Connect at: http://localhost:${config.port}/auth/connect`);

 // Pre-emptive token refresh on startup. If the previous server process died
 // mid-rotation (tsx watch restart, OS reboot) the stored refresh_token may
 // be the OLD one Intuit already invalidated. Doing one clean refresh now -
 // BEFORE the first user request arrives - surfaces that immediately in the
 // server log instead of letting the first 5 parallel API calls all race to
 // refresh and burn the token chain further.
 (async () => {
   try {
     const { getValidAccessToken } = await import('./oauth.js');
     const { loadTokens } = await import('./tokenStore.js');
     const t = await loadTokens();
     if (!t) {
       console.log('[startup] no QB token on disk - skipping refresh check');
       return;
     }
     const minsLeft = (t.expiresAt - Date.now()) / 60_000;
     console.log(`[startup] QB token: ${minsLeft.toFixed(1)} min until expiry`);
     // Force a refresh if <10 min left (well under the 5-min lead time the
     // request-time refresher uses) so a quick startup-then-burst-of-requests
     // doesn't all race to refresh.
     if (minsLeft < 10) {
       console.log('[startup] proactively refreshing QB token...');
       await getValidAccessToken();
     }
   } catch (e) {
     console.error('[startup] QB token preflight failed:', e instanceof Error ? e.message : e);
   }
 })();

 // Sheet cycle: kick off 3s after startup, then every 90s.
 setTimeout(() => {
 void prewarmSheetCaches();
 setInterval(() => { void prewarmSheetCaches(); }, PREFETCH_SHEET_INTERVAL_MS);
 }, 3_000);

 // QB cycle: kick off 10s after startup (let auth settle), then every 60 min.
 setTimeout(() => {
 void prewarmQbCaches();
 setInterval(() => { void prewarmQbCaches(); }, PREFETCH_QB_INTERVAL_MS);
 }, 10_000);
});

// Vercel serverless imports this Express app as the request handler.
export default app;
