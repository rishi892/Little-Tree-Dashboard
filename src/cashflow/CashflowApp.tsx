import { useEffect, useState } from 'react';
import { disconnect, fetchDashboard, fetchStatus, fetchCashflow13, type DashboardData, type Cashflow13, type Status } from './api';
import { formatCurrency, formatMonths, formatSigned } from './format';
import { KpiCard } from './components/KpiCard';
import { Projection13WeekChart } from './components/Projection13WeekChart';
import { Sidebar } from './components/Sidebar';
import { ExpensesHub } from './components/ExpensesHub';
import { CashflowHub } from './components/CashflowHub';
import { ReportsHub } from './components/ReportsHub';
import { SalesHub } from './components/SalesHub';
import { Upflow } from './components/Upflow';
import { CfoCopilot } from './components/CfoCopilot';
import { onCfoNav } from './cfoNav';

// Auth flag the AR-shell sets after a successful Cashflow login. Stored in
// sessionStorage (NOT localStorage) so it expires the moment the browser
// tab is closed - the CFO password is required again on every fresh visit.
const AR_SHELL_AUTH_FLAG = 'lt-cfo-auth';

export type ViewKey = 'cashflow' | 'expenses' | 'sales' | 'reports' | 'upflow';


type AuthState = 'checking' | 'allowed' | 'redirecting';

export default function App() {
 // Single source of truth - the AR-shell owns splash + login for BOTH
 // dashboards. We accept access via either:
 //   1. ?direct=1 in the URL  - set by the AR-shell on a fresh login
 //      redirect. Most reliable signal.
 //   2. sessionStorage flag    - same browser tab session, already authed.
 // Anything else → bounce to '/' so the user goes through the chooser.
 //
 // All decisions live in a useEffect so we don't mutate window state during
 // render (React StrictMode runs the body twice in dev - doing redirects
 // from the body causes infinite loops + blank pages).
 const [authState, setAuthState] = useState<AuthState>('checking');

 useEffect(() => {
   // DEV-ONLY login bypass: on localhost / `vite dev`, skip the gate entirely.
   // import.meta.env.DEV is true only during `npm run dev`; a production
   // `vite build` compiles this branch out, so it can never ship to cfovaani.com.
   if (import.meta.env.DEV) { setAuthState('allowed'); return; }

   const url = new URL(window.location.href);
   const direct = url.searchParams.get('direct') === '1';

   let flagged = false;
   try { flagged = window.sessionStorage.getItem(AR_SHELL_AUTH_FLAG) === '1'; }
   catch { /* private mode - direct flag will still let us through */ }

   if (direct) {
     // Just came from a fresh login. Persist for the rest of this tab
     // session so an in-app refresh doesn't bounce, then strip the
     // query so refreshing the URL stays clean.
     try { window.sessionStorage.setItem(AR_SHELL_AUTH_FLAG, '1'); }
     catch { /* ignore - token-flag path still works for this paint */ }
     url.searchParams.delete('direct');
     window.history.replaceState({}, '', url.toString());
     setAuthState('allowed');
     return;
   }

   if (flagged) {
     setAuthState('allowed');
     return;
   }

   // Not authed - kick to the AR-shell chooser. `replace` so back button
   // doesn't return to this gated URL.
   setAuthState('redirecting');
   window.location.replace('/');
 }, []);

 if (authState !== 'allowed') return null;

 const handleSignOut = () => {
   try { window.sessionStorage.removeItem(AR_SHELL_AUTH_FLAG); }
   catch { /* ignore */ }
   window.location.href = '/';
 };

 return <Dashboard onSignOut={handleSignOut} />;
}

function Dashboard({ onSignOut }: { onSignOut: () => void }) {
 const [status, setStatus] = useState<Status | null>(null);
 const [data, setData] = useState<DashboardData | null>(null);
 const [cf13, setCf13] = useState<Cashflow13 | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [loading, setLoading] = useState(false);
 const [view, setView] = useState<ViewKey>('cashflow');

 async function refreshStatus() {
 try {
 const s = await fetchStatus();
 setStatus(s);
 return s;
 } catch (e) {
 setError(e instanceof Error ? e.message : 'Unknown error');
 return null;
 }
 }

 async function refreshDashboard() {
 setLoading(true);
 setError(null);
 try {
 const s = await refreshStatus();
 if (s?.connected) {
 const d = await fetchDashboard();
 setData(d);
 // 13-week projection for the chart (cached - fetched sequentially after
 // the dashboard so we never fire two QB recomputes at once).
 try { setCf13(await fetchCashflow13()); } catch { /* chart optional */ }
 } else {
 setData(null);
 }
 } catch (e) {
 setError(e instanceof Error ? e.message : 'Unknown error');
 } finally {
 setLoading(false);
 }
 }

 useEffect(() => {
 refreshDashboard();
 }, []);

 // CFO Copilot "show me" - jump to the sidebar view it points at.
 useEffect(() => onCfoNav((d) => { if (d.view) setView(d.view as ViewKey); }), []);

 // After OAuth callback redirects with ?connected=1, kick off auto-refresh so
 // the user lands on already-populated data instead of having to retry. The
 // server is also doing a background prewarm - we re-poll briefly to pick up
 // freshly-cached responses as soon as they're available.
 useEffect(() => {
 const url = new URL(window.location.href);
 if (url.searchParams.get('connected') !== '1') return;
 // Clean the URL so a manual refresh doesn't re-trigger this loop.
 url.searchParams.delete('connected');
 window.history.replaceState({}, '', url.toString());

 let cancelled = false;
 let attempts = 0;
 const MAX_ATTEMPTS = 12; // ~60s total at 5s/attempt - covers a cold prewarm
 async function pollUntilReady(): Promise<void> {
 if (cancelled) return;
 attempts++;
 try {
 const s = await fetchStatus();
 setStatus(s);
 if (s?.connected) {
 const d = await fetchDashboard();
 setData(d);
 // Once dashboard returns substantive data, stop polling.
 if (d && d.currentCash !== undefined && (d.monthly?.length ?? 0) > 0) return;
 }
 } catch {
 // QB might still be throttled during prewarm - keep polling.
 }
 if (attempts >= MAX_ATTEMPTS) return;
 window.setTimeout(() => { void pollUntilReady(); }, 5000);
 }
 void pollUntilReady();
 return () => { cancelled = true; };
 }, []);

 async function handleDisconnect() {
 await disconnect();
 setData(null);
 await refreshStatus();
 }

 // Render the shell immediately - no full-screen "Loading…" flash.
 // The sidebar shows with safe defaults; each panel handles its own
 // empty / loading state internally.
 return (
 <div className="shell">
 <Sidebar
 view={view}
 onChange={setView}
 connected={status?.connected ?? false}
 onDisconnect={handleDisconnect}
 onSignOut={onSignOut}
 identifier={status?.connected && status?.realmId ? status.realmId : undefined}
 />
 <main className="main">
 <div style={{ display: view === 'cashflow' ? 'block' : 'none' }}>
 <CashflowHub
 dashboardSlot={
 <DashboardView
 status={status}
 data={data}
 cf13={cf13}
 loading={loading}
 error={error}
 onRefresh={refreshDashboard}
 />
 }
 />
 </div>
 <div style={{ display: view === 'expenses' ? 'block' : 'none' }}><ExpensesHub /></div>
 <div style={{ display: view === 'sales' ? 'block' : 'none' }}>{view === 'sales' && <SalesHub />}</div>
 <div style={{ display: view === 'reports' ? 'block' : 'none' }}><ReportsHub /></div>
 <div style={{ display: view === 'upflow' ? 'block' : 'none' }}>{view === 'upflow' && <Upflow />}</div>

 </main>
 <CfoCopilot />
 </div>
 );
}

function DashboardView({
 status,
 data,
 cf13,
 loading,
 error,
 onRefresh,
}: {
 status: Status | null;
 data: DashboardData | null;
 cf13: Cashflow13 | null;
 loading: boolean;
 error: string | null;
 onRefresh: () => void;
}) {
 // While the initial /api/status round-trip is in flight, render the
 // page header silently - no "Loading…" text or empty box. The KPI
 // tiles further down handle their own placeholder state.
 if (!status) {
 return (
 <div className="page-head">
 <div>
 <h1 className="page-title">Cash Flow Dashboard</h1>
 <div className="page-sub">&nbsp;</div>
 </div>
 </div>
 );
 }
 if (!status.connected) {
 return (
 <div className="empty">
 <h1 className="page-title">Cash Flow Dashboard</h1>
 <p>Connect your QuickBooks Online company to view live cash position and monthly cash flow.</p>
 {status.credsConfigured ? (
 <a className="btn" href="/auth/connect">Connect QuickBooks</a>
 ) : (
 <div className="error" style={{ maxWidth: 460 }}>
 QBO credentials aren't configured yet. Edit <code>server/.env</code> and set
 <code> QBO_CLIENT_ID</code> + <code>QBO_CLIENT_SECRET</code>, then restart the server.
 </div>
 )}
 </div>
 );
 }

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Cash Flow Dashboard</h1>
 <div className="page-sub">
 Live from QuickBooks · realm {status.realmId}
 {data && <> · as of {new Date(data.asOf).toLocaleString()}</>}
 </div>
 </div>
 <button className="btn ghost" onClick={onRefresh} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh'}
 </button>
 </div>

 {error && <div className="error">{error}</div>}

 {data && (
 <>
 <div className="kpis">
 <KpiCard
 label="Cash on hand"
 period="Live · same as Current Position"
 value={formatCurrency(data.currentCash)}
 sub="Checking + BMM + PureX bank + Due From PureX"
 highlight
 />
 <KpiCard
 label="Net cash last month"
 period={data.netCashThisMonthLabel ?? 'Most recent month'}
 value={formatCurrency(data.netCashThisMonth)}
 sub={`${data.netCashLastMonthLabel ?? 'Prior'}: ${formatCurrency(data.netCashLastMonth)}`}
 trend={data.netCashThisMonth >= 0 ? 'up' : 'down'}
 />
 <KpiCard
 label="Monthly Burn"
 period="Avg total opex"
 value={formatCurrency(data.avgMonthlyBurn)}
 sub="Inv + Payroll + Subs + Other (live)"
 trend="down"
 />
 <KpiCard
 label="Runway"
 period="Cash ÷ monthly burn"
 value={formatMonths(data.runwayMonths)}
 sub={
 data.avgMonthlyBurn > 0
 ? `Burn ${formatCurrency(data.avgMonthlyBurn)}/mo`
 : 'No burn data'
 }
 trend={data.runwayMonths === null ? 'up' : data.runwayMonths < 1 ? 'down' : 'up'}
 />
 </div>

 {cf13 && cf13.weeks.length > 0 && (
 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">13-Week Cash Projection</div>
 <div className="section-sub">
 Weekly inflow vs outflow + closing-cash runway · Wk1 = this week ({cf13.weeks[0]?.label}) · from your 13-week projection
 </div>
 </div>
 </div>
 <Projection13WeekChart data={cf13} />
 </div>
 )}
 </>
 )}
 </>
 );
}

