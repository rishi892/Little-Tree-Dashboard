import { QBO_API_BASE } from './config.js';
import { getValidAccessToken } from './oauth.js';
import { qboFetch } from './qbHttp.js';

async function qboGet<T>(pathAndQuery: string): Promise<T> {
 const tokens = await getValidAccessToken();
 const url = `${QBO_API_BASE}/v3/company/${tokens.realmId}/${pathAndQuery}`;
 const res = await qboFetch(url, tokens.accessToken);
 return (await res.json()) as T;
}

// --- Accounts ---

type AccountQueryResponse = {
 QueryResponse: {
 Account?: Array<{
 Id: string;
 Name: string;
 AccountType: string;
 AccountSubType?: string;
 CurrentBalance?: number;
 }>;
 };
};

export async function getCashAccountsBalance(): Promise<number> {
 const query = encodeURIComponent("select * from Account where AccountType in ('Bank', 'Other Current Asset')");
 const data = await qboGet<AccountQueryResponse>(`query?query=${query}&minorversion=70`);
 const bankAccounts = (data.QueryResponse.Account ?? []).filter((a) => a.AccountType === 'Bank');
 return bankAccounts.reduce((sum, a) => sum + (a.CurrentBalance ?? 0), 0);
}

// --- Report helpers ---

type ReportColumn = { ColTitle?: string; ColType?: string; MetaData?: Array<{ Name: string; Value: string }> };
type ReportRow = {
 type?: string;
 group?: string;
 Header?: { ColData: Array<{ value: string }> };
 ColData?: Array<{ value: string; id?: string }>;
 Summary?: { ColData: Array<{ value: string }> };
 Rows?: { Row: ReportRow[] };
};
type Report = {
 Header: { Time: string; ReportName: string; StartPeriod: string; EndPeriod: string };
 Columns: { Column: ReportColumn[] };
 Rows: { Row: ReportRow[] };
};

function parseAmount(v: string | undefined): number {
 if (!v) return 0;
 const n = Number(v.replace(/,/g, ''));
 return Number.isFinite(n) ? n : 0;
}

// Walk a report tree and find a row whose group matches one of the candidates.
function findRowByGroup(rows: ReportRow[], group: string): ReportRow | undefined {
 for (const r of rows) {
 if (r.group === group) return r;
 if (r.Rows?.Row) {
 const found = findRowByGroup(r.Rows.Row, group);
 if (found) return found;
 }
 }
 return undefined;
}

export type MonthlyPoint = {
 month: string; // 'YYYY-MM'
 label: string; // 'Jan 2026'
 income: number;
 expenses: number;
 net: number;
};

// --- Profit & Loss, summarized by month ---

export async function getMonthlyProfitAndLoss(startDate: string, endDate: string): Promise<MonthlyPoint[]> {
 const params = new URLSearchParams({
 start_date: startDate,
 end_date: endDate,
 summarize_column_by: 'Month',
 accounting_method: 'Accrual',
 minorversion: '70',
 });
 const report = await qboGet<Report>(`reports/ProfitAndLoss?${params.toString()}`);

 // First column is the row label; remaining columns are months, then a Total.
 const columns = report.Columns.Column;
 // Extract month metadata (StartDate) for each month column.
 const monthCols: Array<{ index: number; month: string; label: string }> = [];
 columns.forEach((col, idx) => {
 if (idx === 0) return; // label column
 const meta = col.MetaData?.find((m) => m.Name === 'StartDate');
 if (!meta) return; // skip Total column
 const d = new Date(meta.Value);
 const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
 const label = d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
 monthCols.push({ index: idx, month, label });
 });

 const incomeRow = findRowByGroup(report.Rows.Row, 'Income');
 const expensesRow = findRowByGroup(report.Rows.Row, 'Expenses');

 const points: MonthlyPoint[] = monthCols.map(({ index, month, label }) => {
 const income = parseAmount(incomeRow?.Summary?.ColData?.[index]?.value);
 const expenses = parseAmount(expensesRow?.Summary?.ColData?.[index]?.value);
 return { month, label, income, expenses, net: income - expenses };
 });

 return points;
}

// --- Dashboard aggregator ---

export type BreakdownItem = { label: string; value: number };

export type DashboardData = {
 asOf: string;
 currentCash: number;
 netCashThisMonth: number;
 netCashLastMonth: number;
 netCashThisMonthLabel?: string;
 netCashLastMonthLabel?: string;
 monthOverMonthChange: number; // signed delta
 avgMonthlyBurn: number; // positive number, average of negative net months
 runwayMonths: number | null; // null when burn <= 0
 monthly: MonthlyPoint[];
 // Per-line composition of the headline KPIs, so the UI can show "how it's
 // calculated" with live numbers that sum exactly to currentCash / avgMonthlyBurn.
 cashBreakdown: BreakdownItem[]; // Checking + BMM + PureX bank + Due From PureX
 burnBreakdown: BreakdownItem[]; // per-category run-rate + active-subscription audit
};

function ymd(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function getDashboardData(monthsBack = 12): Promise<DashboardData> {
 const now = new Date();
 const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // last day of prev month
 const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));

 // All KPIs + chart share the same sources:
 // - Cash on hand: Tiller business accounts (CRB Indirect 7561 + Business MM 0910)
 // - Net cash last month: Tiller balance delta (end-of-month change in business cash)
 // - Monthly burn: Combined view + active subscriptions (same formula as 13-week)
 // - Chart expenses: Combined view per-month (same source)
 // - Chart income: QB P&L (only QB has historical income detail)
 const [tillerBalances, tillerMonthlyDeltas, monthlyBurnTotal, monthly] = await Promise.all([
 (async () => {
 try {
 const { getTillerBalances } = await import('./tiller.js');
 const t = await getTillerBalances();
 const BUSINESS_RE = /crb indirect|7561|business mm|0910/i;
 const accounts = t.cashAccounts.filter((a) => BUSINESS_RE.test(a.name));
 return { total: accounts.reduce((s, a) => s + a.balance, 0), accounts };
 } catch { return null; }
 })(),
 (async () => {
 try {
 const { getBusinessCashMonthly } = await import('./tiller.js');
 return await getBusinessCashMonthly(monthsBack);
 } catch { return []; }
 })(),
 (async () => {
 // SAME formula as 13-week cashflow: Combined non-Payroll rows + active
 // subscription audit (replaces Software & Subs).
 try {
 const { getMappedExpenses } = await import('./mappedExpenses.js');
 const { getCachedSubscriptionAudit, computeActiveSubscriptionsMonthly } = await import('./audit.js');
 const combined = await getMappedExpenses('Combined');
 let monthlyTotal = 0;
 const breakdown: { label: string; value: number }[] = [];
 for (const r of combined.rows ?? []) {
 if (/software\s*&\s*subscriptions/i.test(r.category)) continue; // replaced by audit
 const total = (r.values ?? []).reduce((s, v) => s + v, 0);
 const nonZero = (r.values ?? []).filter((v) => v > 0).length;
 if (nonZero > 0) {
 const runRate = total / nonZero;
 monthlyTotal += runRate;
 breakdown.push({ label: r.category, value: +runRate.toFixed(2) });
 }
 }
 try {
 const audit = await getCachedSubscriptionAudit(16);
 const { activeMonthlySum } = computeActiveSubscriptionsMonthly(audit, 4);
 monthlyTotal += activeMonthlySum;
 if (activeMonthlySum > 0) breakdown.push({ label: 'Subscriptions (active audit)', value: +activeMonthlySum.toFixed(2) });
 } catch { /* audit unavailable - leave subs at zero */ }
 breakdown.sort((a, b) => b.value - a.value);
 return { total: monthlyTotal, breakdown };
 } catch { return { total: 0, breakdown: [] }; }
 })(),
 getMonthlyProfitAndLoss(ymd(start), ymd(end)),
 ]);
 // Cash on Hand = the SAME 4 accounts as Current Position & the 13-week opening
 // (sab jagah ek): Tiller business banks (Checking + BMM) + PureX QB bank +
 // Due From PureX (Gelato). The QB part is fetched SEQUENTIALLY here (after the
 // Promise.all) to avoid a concurrent QB token refresh.
 let currentCash = tillerBalances?.total ?? await getCashAccountsBalance();
 let pureXBank = 0, dueFromPurex = 0;
 try {
 const { getQbIntercompanyCash } = await import('./cashOnHand.js');
 const ic = await getQbIntercompanyCash();
 pureXBank = ic.pureXBank;
 dueFromPurex = ic.dueFromPurex;
 currentCash = +(currentCash + ic.pureXBank + ic.dueFromPurex).toFixed(2);
 } catch { /* QB unavailable - keep bank-only cash */ }

 // Overlay Combined-view per-month expenses onto the chart so the chart's
 // expense bars tie to the burn KPI.
 try {
 const { getMappedExpenses } = await import('./mappedExpenses.js');
 const combined = await getMappedExpenses('Combined');
 const combMonths = combined.months ?? [];
 const combExpenseByMonth: Record<string, number> = {};
 for (let i = 0; i < combMonths.length; i++) {
 const mk = combMonths[i];
 let total = 0;
 for (const r of combined.rows ?? []) total += (r.values?.[i] ?? 0);
 combExpenseByMonth[mk] = total;
 }
 for (const m of monthly) {
 const liveExp = combExpenseByMonth[m.month];
 if (liveExp !== undefined && liveExp > 0) {
 m.expenses = liveExp;
 m.net = m.income - liveExp;
 }
 }
 } catch (e) {
 console.error('[dashboard] combined-view expense overlay failed:', e instanceof Error ? e.message : e);
 }

 // Skip incomplete trailing months - based on QB income freshness.
 const substantive = monthly.filter((m, i, arr) => {
 if (i === 0) return true;
 const prev = arr[i - 1];
 if (prev.income > 0 && m.income < prev.income * 0.25) return false;
 return true;
 });

 // Net cash last/this month from TILLER DELTAS - actual bank balance change.
 // Falls back to QB P&L net if Tiller deltas unavailable.
 function fmtMonthLabel(ym: string): string {
 const [y, m] = ym.split('-').map((n) => parseInt(n, 10));
 return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
 }
 const tillerWithDeltas = tillerMonthlyDeltas.filter((d) => d.delta !== null);
 let netThis = 0, netLast = 0;
 let netThisLabel = 'recent', netLastLabel = 'prior';
 if (tillerWithDeltas.length >= 2) {
 const lastIdx = tillerWithDeltas.length - 1;
 netThis = tillerWithDeltas[lastIdx].delta!;
 netLast = tillerWithDeltas[lastIdx - 1].delta!;
 netThisLabel = fmtMonthLabel(tillerWithDeltas[lastIdx].ym);
 netLastLabel = fmtMonthLabel(tillerWithDeltas[lastIdx - 1].ym);
 } else {
 netThis = substantive.at(-1)?.net ?? 0;
 netLast = substantive.at(-2)?.net ?? 0;
 netThisLabel = substantive.at(-1)?.label ?? 'recent';
 netLastLabel = substantive.at(-2)?.label ?? 'prior';
 }

 const avgMonthlyBurn = monthlyBurnTotal.total;
 const runwayMonths = avgMonthlyBurn > 0 && currentCash > 0 ? currentCash / avgMonthlyBurn : null;

 // Cash-on-hand line items (sum to currentCash): the SAME 4 accounts the KPI uses.
 const cashBreakdown: BreakdownItem[] = [
 ...(tillerBalances?.accounts ?? []).map((a) => ({ label: a.name, value: +a.balance.toFixed(2) })),
 { label: 'PureX bank (QB)', value: pureXBank },
 { label: 'Due From PureX / Gelato', value: dueFromPurex },
 ];

 return {
 asOf: new Date().toISOString(),
 currentCash,
 netCashThisMonth: netThis,
 netCashLastMonth: netLast,
 netCashThisMonthLabel: netThisLabel,
 netCashLastMonthLabel: netLastLabel,
 monthOverMonthChange: netThis - netLast,
 avgMonthlyBurn,
 runwayMonths,
 monthly: substantive,
 cashBreakdown,
 burnBreakdown: monthlyBurnTotal.breakdown,
 };
}
