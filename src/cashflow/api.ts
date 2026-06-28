export type MonthlyPoint = {
 month: string;
 label: string;
 income: number;
 expenses: number;
 net: number;
};

export type DashboardData = {
 netCashThisMonthLabel?: string;
 netCashLastMonthLabel?: string;
 asOf: string;
 currentCash: number;
 netCashThisMonth: number;
 netCashLastMonth: number;
 monthOverMonthChange: number;
 avgMonthlyBurn: number;
 runwayMonths: number | null;
 monthly: MonthlyPoint[];
 // Per-line KPI composition (optional: only present once the backend ships it).
 cashBreakdown?: { label: string; value: number }[];
 burnBreakdown?: { label: string; value: number }[];
};

export type Status = { connected: boolean; realmId: string | null; credsConfigured: boolean };

export async function fetchStatus(): Promise<Status> {
 const res = await fetch('/api/status');
 if (!res.ok) throw new Error('Failed to load status');
 return res.json();
}

export async function fetchDashboard(): Promise<DashboardData> {
 const res = await fetch('/api/dashboard');
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed to load dashboard' }));
 throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export async function disconnect(): Promise<void> {
 await fetch('/api/disconnect', { method: 'POST' });
}

export type MatchType = 'strong' | 'fuzzy' | 'line' | 'none';

export type SubPattern = 'FIXED' | 'PERIODIC' | 'VARIABLE';

export type AuditRow = {
 expected: {
 name: string;
 monthly: number;
 billDay: number;
 pattern: SubPattern;
 notes?: string;
 };
 matchType: MatchType;
 bestMatchName: string | null;
 bestMatchScore: number;
 alternates: Array<{ name: string; score: number }>;
 activity: {
 txnCount: number;
 totalAmount: number;
 avgAmount: number;
 lastDate: string;
 } | null;
 lineHits: Array<{ date: string; amount: number; description: string }>;
 monthlyAmounts: number[];
 derivedMonthly: number;
 derivedBillDay: number;
 derivedPattern: SubPattern;
 hasQbData: boolean;
 usedMonthly: number;
 usedBillDay: number;
 usedPattern: SubPattern;
 usedSource: 'qb' | 'expected' | 'expected_outlier';
 outlierReason?: string;
 sampleDates: string[];
};

export type UnexpectedVendor = {
 displayName: string;
 txnCount: number;
 totalAmount: number;
 avgAmount: number;
 lastDate: string;
};

export type SubscriptionAudit = {
 cached: boolean;
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 since: string;
 totals: { vendors: number; purchases: number; bills: number };
 counts: { strong: number; fuzzy: number; line: number; missing: number };
 months: string[];
 monthLabels: string[];
 rows: AuditRow[];
 unexpectedVendors: UnexpectedVendor[];
};

// --- Tiller Transactions ---
export type TillerEntity = 'Moysh-Business' | 'Moysh-CC' | 'Personal' | 'Other';
export type TillerTxn = {
 date: string;
 amount: number;
 payee: string;
 category: string;
 txnId: string;
 account: string;
 status: string;
 entity: TillerEntity;
};
export type TxnsByAccountMonth = {
 account: string;
 entity: TillerEntity;
 inQb: boolean;
 monthlyOutflow: Record<string, number>;
 monthlyInflow: Record<string, number>;
 txnCount: number;
};
export type TillerTransactionsResult = {
 fetchedAt: string;
 rowCount: number;
 accounts: TxnsByAccountMonth[];
 months: string[];
 transactions: TillerTxn[];
};
export async function fetchTillerTransactions(opts: { refresh?: boolean } = {}): Promise<TillerTransactionsResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/tiller-transactions${qs}`);
 if (!res.ok) throw new Error(`Tiller transactions fetch failed: ${res.status}`);
 return res.json();
}

// --- Tiller ↔ QB Reconciliation ---
export type ReconciledRow = {
 date: string;
 amount: number;
 sourceBank: string;
 sourceKind?: 'bank' | 'cc' | 'other';
 payee: string;
 qbCategory?: string;
 qbTxnId?: string;
 tillerTxnId?: string;
 daysDiff?: number;
 qbCategoryGroup?: 'journal' | 'capex' | 'bill-payment' | 'real-expense';
};
export type CategoryAttribution = {
 category: string;
 bankPaid: number;
 ccPaid: number;
 total: number;
 txnCount: number;
 monthly: Record<string, { bank: number; cc: number; total: number }>;
};
export type ReconciliationResult = {
 asOf: string;
 windowStart: string;
 matchDays: number;
 counts: { matched: number; bankOnly: number; transfers: number; qbOnly: number; tillerTotal: number; tillerDuplicatesDropped: number; qbTotal: number };
 totals: { matched: number; bankOnly: number; transfers: number; qbOnly: number };
 matched: ReconciledRow[];
 bankOnly: ReconciledRow[];
 transfers: ReconciledRow[];
 qbOnly: ReconciledRow[];
 categoryAttribution: CategoryAttribution[];
 attributionMonths: string[];
 warnings: string[];
};
export async function fetchReconciliation(opts: { refresh?: boolean } = {}): Promise<ReconciliationResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/reconciliation${qs}`);
 if (!res.ok) throw new Error(`Reconciliation fetch failed: ${res.status}`);
 return res.json();
}

// --- Sales by Product (scraped from Intuit share-page line items) ---
export type ProductCustomerBreakdown = {
 customer: string;
 customerAu: string;
 customerName: string;
 qty: number;
 revenue: number;
 invoiceCount: number;
};
export type ProductMonthlyPoint = { ym: string; qty: number; revenue: number };
export type ProductRow = {
 product: string;
 itemCategory: string;
 totalQty: number;
 totalRevenue: number;
 invoiceCount: number;
 avgUnitPrice: number;
 firstSold: string;
 lastSold: string;
 uniqueCustomers: number;
 topCustomer: { name: string; au: string; share: number } | null;
 customers: ProductCustomerBreakdown[];
 monthly: ProductMonthlyPoint[];
};
export type SalesByProductResult = {
 asOf: string;
 windowStart: string;
 windowEnd: string;
 status: {
 inWindowWithLink: number;
 scraped: number;
 missingLinks: number;
 failed: number;
 failures: Array<{ token: string; error: string; lastTriedAt: string }>;
 };
 cogsMapping: {
 mappedLines: number;
 unmappedLines: number;
 unmappedLabels: string[];
 };
 totals: {
 invoiceCount: number;
 lineItemCount: number;
 totalRevenue: number;
 uniqueProducts: number;
 uniqueCustomers: number;
 };
 products: ProductRow[];
 warnings: string[];
};
export async function fetchSalesByProduct(opts: { refresh?: boolean } = {}): Promise<SalesByProductResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/sales-by-product${qs}`);
 if (!res.ok) throw new Error(`Sales by Product fetch failed: ${res.status}`);
 return res.json();
}

export async function fetchSubscriptionAudit(opts: { months?: number; refresh?: boolean } = {}): Promise<SubscriptionAudit> {
 const params = new URLSearchParams();
 if (opts.months) params.set('months', String(opts.months));
 if (opts.refresh) params.set('refresh', '1');
 const qs = params.toString();
 const res = await fetch(`/api/subscription-audit${qs ? `?${qs}` : ''}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed to load audit' }));
 throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type LivePaidBy = 'PureX' | 'Moysh' | 'Combined' | 'Other';
export type LiveExpenseRow = {
 category: string;
 group: 'Payroll' | 'Non-Payroll';
 accountType: string;
 paidBy: LivePaidBy;
 monthly: number[];
 perEntity: { PureX: number[]; Moysh: number[]; Other: number[] };
 total: number;
};
export type LiveExpenseDetail = {
 cached: boolean;
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 months: string[];
 monthLabels: string[];
 rows: LiveExpenseRow[];
 totals: {
 txnsScanned: number;
 accountsScanned: number;
 paidByDetected: { PureX: number; Moysh: number; Other: number };
 };
 paymentSources: Array<{ name: string; accountType: string }>;
 classes: string[];
};

export type DetectedSub = {
 source: 'vendor' | 'line';
 vendor: string;
 monthly: number;
 billDay: number;
 weekOfMonth: 1 | 2 | 3 | 4 | 5;
 pattern: 'FIXED' | 'VARIABLE' | 'PERIODIC';
 txnCount: number;
 monthsObserved: number;
 lastSeen: string;
 firstSeen: string;
 amountStability: number;
 avgGapDays: number;
 notes: string;
 history: Array<{ date: string; amount: number; description?: string }>;
};

export type RecurringSubs = {
 cached: boolean;
 asOf: string;
 realmId: string;
 lookbackMonths: number;
 since: string;
 totals: { vendors: number; purchases: number; bills: number; mergedBuckets: number };
 subs: DetectedSub[];
};

export async function fetchRecurringSubs(opts: { months?: number; refresh?: boolean } = {}): Promise<RecurringSubs> {
 const params = new URLSearchParams();
 if (opts.months) params.set('months', String(opts.months));
 if (opts.refresh) params.set('refresh', '1');
 const qs = params.toString();
 const res = await fetch(`/api/recurring-subscriptions${qs ? `?${qs}` : ''}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed to load recurring subs' }));
 throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export async function fetchExpenseDetail(opts: { months?: number; refresh?: boolean } = {}): Promise<LiveExpenseDetail> {
 const params = new URLSearchParams();
 if (opts.months) params.set('months', String(opts.months));
 if (opts.refresh) params.set('refresh', '1');
 const qs = params.toString();
 const res = await fetch(`/api/expense-detail${qs ? `?${qs}` : ''}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed to load expense detail' }));
 throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type CashflowSource = 'live' | 'computed' | 'none';
export type CashflowStatus = 'HEALTHY' | 'TIGHT' | 'CRITICAL';
export type CashflowWeek = { label: string; start: string; end: string };
export type CashflowBreakdownItem = { label: string; amount: number; sub?: string };
export type CashflowLine = { label: string; source: CashflowSource; note?: string; values: number[]; breakdown?: CashflowBreakdownItem[]; displayOnly?: boolean };

export type ActivityTier = 'active' | 'cooling' | 'dormant' | 'churned';
export type SalesForecastBrand = {
 brand: string;
 brandSource: 'sheet' | 'derived' | 'mixed';
 monthsObserved: number;
 invoiceCount: number;
 invoicesPerActiveMonth: number;
 momentum90d: { recent: number; prior: number; deltaPct: number | null };
 paidRatio: number;
 baselineMonthly: number;
 trendSlope: number;
 r2: number;
 bounds: { lower: number; upper: number };
 clamped: boolean;
 daysSinceLastInvoice: number;
 activityTier: ActivityTier;
 recencyWeight: number;
 history: Array<{ ym: string; amount: number }>;
 forecast: Array<{ ym: string; amount: number }>;
 lagCurve: number[];
 lagSource: 'brand' | 'global';
 weeklyInflow: number[];
 totalProjectedCash: number;
 lastInvoiceDate: string;
 // Depth-analysis fields (cadence-driven model)
 cadenceDays: number;
 avgInvoiceAmount: number;
 nextExpectedDate: string;
 growthMultiplier: number;
 seasonalIndices: number[];
 hasSeasonality: boolean;
 projectedInvoices: Array<{ date: string; amount: number; ym: string; monthOfYear: number }>;
 recentInvoices: Array<{ date: string; amount: number }>;
 gapDays: number[];
};
export type SalesForecastWeek = { index: number; start: string; end: string; label: string };
export type SalesForecastTier = { name: ActivityTier; maxDays: number; weight: number };
export type YearlyHistoryPoint = {
 year: string;
 total: number;
 invoiceCount: number;
 isPartial: boolean;
 monthsObserved: number;
};
export type MonthlyHistoryPoint = { ym: string; total: number; invoiceCount: number };
export type SeasonalityPoint = { monthOfYear: number; index: number; basisYear: string };
export type ForecastMonthRow = {
 ym: string;
 forecastedSales: number;
 method: 'prior-year-x-yoy' | 'baseline-x-seasonal' | 'recent-3m-mean';
 priorYearValue: number | null;
 yoyMultiplier: number | null;
 seasonalIndex: number | null;
 clamped: 'low' | 'high' | null;
};
export type WeeklySeriesPoint = {
 weekStart: string;
 weekOfYear: number;
 total: number;
 invoiceCount: number;
 isForecast: boolean;
};
export type WeeklyAnalysis = {
 history: WeeklySeriesPoint[];
 trend: { slope: number; intercept: number; r2: number; basisWeeks: number };
 weekOfYearSeasonality: Array<{ weekOfYear: number; index: number; samples: number }>;
 forecast: WeeklySeriesPoint[];
};
export type SalesForecastResult = {
 asOf: string;
 driver: { lookbackMonths: number; forecastHorizonMonths: number; maxLagMonths: number; tiers: SalesForecastTier[] };
 // v2 multi-level total forecast
 yearlyHistory: YearlyHistoryPoint[];
 monthlyHistory: MonthlyHistoryPoint[];
 seasonality: SeasonalityPoint[];
 yoy: {
 rate: number;
 rawRate: number;
 currYearLabel: string;
 prevYearLabel: string;
 monthsCompared: number;
 currYTD: number;
 prevYTD: number;
 };
 yoyChain: Array<{
 fromYear: string;
 toYear: string;
 fromValue: number;
 toValue: number;
 monthsCompared: number;
 aligned: boolean;
 rate: number;
 }>;
 weeklyAnalysis: WeeklyAnalysis;
 monthlyForecastV2: ForecastMonthRow[];
 monthlyForecastBest: ForecastMonthRow[];
 monthlyForecastWorst: ForecastMonthRow[];
 weeklyInflowV2: number[];
 weeklyInflowBest: number[];
 weeklyInflowWorst: number[];
 totalForecastedInvoiceV2: number;
 totalProjectedCashV2: number;
 scenarioTotals: {
   base: { invoiced: number; cash: number };
   best: { invoiced: number; cash: number };
   worst: { invoiced: number; cash: number };
 };
 approvedAssumptions: {
   deseasonalizedBase: number;
   bestMultiplier: number;
   worstMultiplier: number;
   growthTrend: number;
   excisetaxNote: string;
   calibration: {
     windowMonths: number;
     contributors: Array<{ ym: string; actual: number; seasonality: number; deseasonalized: number; kept: boolean }>;
     deseasonalizedBase: number;
   };
 };
 // v1 per-brand details (drilldown)
 lookbackWindow: string[];
 horizonMonths: string[];
 weeks: SalesForecastWeek[];
 globalLagCurve: number[];
 brands: SalesForecastBrand[];
 churnedBrands: Array<{ brand: string; lastInvoiceDate: string; daysSinceLastInvoice: number }>;
 weeklyInflow: number[];
 monthlyForecast: Array<{ ym: string; amount: number }>;
 totalForecastedSales: number;
 totalProjectedCash: number;
 /** Share of non-Gelato sales $ collected the same week invoiced (2024+ history). */
 sameWeekRate: number;
 // 3-bucket projection (each bucket runs the same model on its own slice)
 buckets: {
  wholesale: BucketForecast;
  privateLabel: BucketForecast;
  gelato: BucketForecast;
 };
 warnings: string[];
};

export type SalesBucket = 'wholesale' | 'privateLabel' | 'gelato';

export type BucketForecast = {
 bucket: SalesBucket;
 label: string;
 customerCount: number;
 yearlyHistory: YearlyHistoryPoint[];
 monthlyHistory: MonthlyHistoryPoint[];
 seasonality: SeasonalityPoint[];
 yoy: SalesForecastResult['yoy'];
 yoyChain: SalesForecastResult['yoyChain'];
 weeklyAnalysis: WeeklyAnalysis;
 monthlyForecast: ForecastMonthRow[];
 monthlyForecastBest: ForecastMonthRow[];
 monthlyForecastWorst: ForecastMonthRow[];
 weeklyInflow: number[];
 weeklyInflowBest: number[];
 weeklyInflowWorst: number[];
 weeklyGross: number[];
 scenarioTotals: {
  base: { invoiced: number; cash: number };
  best: { invoiced: number; cash: number };
  worst: { invoiced: number; cash: number };
 };
 deseasonalizedBase: number;
 baseCalibration: {
  windowMonths: number;
  contributors: Array<{ ym: string; actual: number; seasonality: number; deseasonalized: number; kept: boolean }>;
  deseasonalizedBase: number;
 };
};

export type CurrentMonthOverview = {
 month: { ym: string; label: string; start: string; end: string; daysInMonth: number; dayOfMonth: number; progressPct: number };
 sales: {
  projected: { base: number; best: number; worst: number };
  invoicedMtd: { gelato: number; nonGelato: number; total: number; invoiceCount: number };
 };
 ar: {
  gelato:    { projected: number; collected: number; invoiceCount: number };
  nonGelato: { projected: number; collected: number; invoiceCount: number };
 };
 openArAsOfToday: { amount: number; invoiceCount: number };
};

export type SalesWeekInvoice = {
 invoiceNumber: string;
 date: string;
 customer: string;
 amount: number;
 paid: number;
 paidDate: string;
 channel: string;
};
export type SalesWeekInvoicesResponse = {
 weekStart: string;
 weekEnd: string;
 invoiceCount: number;
 total: number;
 invoices: SalesWeekInvoice[];
};

/**
 * Clear every module-level cache on the server (Tiller, QB, sheets, etc.)
 * so the next request rebuilds from source. Used by the global "Refresh All"
 * button so the user doesn't have to open each tab and refresh individually.
 */
export async function invalidateAllCaches(): Promise<{ ok: boolean; cachesCleared: number }> {
 const res = await fetch('/api/cache/invalidate-all', { method: 'POST' });
 if (!res.ok) {
  const body = await res.json().catch(() => ({ error: 'Failed' }));
  throw new Error(body.error || 'Failed to invalidate caches');
 }
 return res.json();
}

export async function fetchSalesWeekInvoices(weekStart: string, bucket: SalesBucket = 'wholesale'): Promise<SalesWeekInvoicesResponse> {
 const res = await fetch(`/api/sales-week-invoices?weekStart=${encodeURIComponent(weekStart)}&bucket=${encodeURIComponent(bucket)}`);
 if (!res.ok) {
  const body = await res.json().catch(() => ({ error: 'Failed' }));
  throw new Error(body.error || 'Failed to fetch week invoices');
 }
 return res.json();
}

export async function fetchCurrentMonthOverview(): Promise<CurrentMonthOverview> {
 const res = await fetch('/api/current-month-overview');
 if (!res.ok) {
  const body = await res.json().catch(() => ({ error: 'Failed' }));
  throw new Error(body.error || 'Failed to fetch current-month overview');
 }
 return res.json();
}

export async function fetchSalesForecast(): Promise<SalesForecastResult> {
 const res = await fetch('/api/sales-forecast');
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

export type Cashflow13 = {
 cached: boolean;
 asOf: string;
 anchor: string;
 weeks: CashflowWeek[];
 openingCashWk1: number;
 openingCashSource: CashflowSource;
 bankCashWk1?: number;
 openingCashNote?: string;
 openingCashBreakdown?: CashflowBreakdownItem[];
 inflows: CashflowLine[];
 outflows: CashflowLine[];
 salesForecast: SalesForecastResult | null;
 totals: {
 inflows: number[];
 outflows: number[];
 netChange: number[];
 openingCash: number[];
 closingCash: number[];
 status: CashflowStatus[];
 };
 assumptions: {
 ccPayoffWk1: number;
 payrollPerWeek: number;
 inventoryPerWeek: number;
 otherPerWeek: number;
 };
 warnings: string[];
};

// --- Weekly forecast snapshots (Past Weeks variance view) ---
export type SnapshotLineItem = { label: string; wk1Value: number; total13w: number };
export type WeeklySnapshot = {
 monday: string;
 capturedAt: string;
 openingCash: number;
 inflows: SnapshotLineItem[];
 outflows: SnapshotLineItem[];
 totalInflowWk1: number;
 totalOutflowWk1: number;
 netChangeWk1: number;
 closingCashWk1: number;
 arProjection13wTotal: number;
 salesForecastWk1: number;
 salesForecast13wTotal: number;
};
export type InvoiceDetail = {
 invoiceNumber: string;
 customer: string;
 channel: 'Gelato' | string;
 invoiceDate: string;
 paidDate: string;
 amount: number;
 paid: number;
};
export type ForecastInvoiceRow = InvoiceDetail & {
 openAtWeekStart: number;
 projectedAmountThisWeek: number;
 status: 'paid' | 'partial' | 'unpaid';
 paidThisWeek: boolean;
};
export type WeekActuals = {
 weekStart: string;
 weekEnd: string;
 inflow: number;
 outflow: number;
 netChange: number;
 byCategory: Array<{ category: string; inflow: number; outflow: number }>;
 txnCount: number;
 arActuals: {
 gelato: { amount: number; invoiceCount: number };
 // sameWeek = invoiced & paid same week (immediate -> Projected AR);
 // lagged = paid now but invoiced earlier (lag -> Little Tree AR).
 nonGelato: { amount: number; invoiceCount: number; sameWeek?: number; lagged?: number };
 total: number;
 };
 salesInvoiced: {
 gelato: { amount: number; invoiceCount: number };
 nonGelato: { amount: number; invoiceCount: number };
 total: number;
 };
 arOpenAtEnd: { amount: number; invoiceCount: number };
 paidInvoices: InvoiceDetail[];
 invoicedInvoices: InvoiceDetail[];
 forecastBasisInvoices: ForecastInvoiceRow[];
};
export type WeeklySnapshotItem = {
 snapshot: WeeklySnapshot;
 actuals: WeekActuals | null;
 /** True only when Sunday of the snapshot's Wk1 has already passed. Mid-week
  *  snapshots return running-total actuals capped at today. */
 weekClosed?: boolean;
};
export type WeeklySnapshotsResponse = { count: number; items: WeeklySnapshotItem[] };
export type WeeklySnapshotsResult = WeeklySnapshotsResponse;

/** Calendar-based past weeks grid: returns last N Mondays (default 13), each
 *  with its actuals and snapshot (if captured). Used by Past Weeks view so
 *  every closed week shows up even without a snapshot. */
/** Actual QB expenses for a week, bucketed into the budget outflow lines. */
export type WeekExpenseLines = {
 weekStart: string;
 weekEnd: string;
 byLine: {
  'Payroll': number;
  'Inventory & Raw Materials': number;
  'Software & Subscriptions': number;
  'Other Expenses': number;
 };
 total: number;
};
/** Live-computed expected AR collections for a week (by invoice terms). */
export type ExpectedInflowWeek = { gelato: number; other: number; total: number };

export type PastWeeksGridItem = {
 monday: string;
 weekEnd: string;
 weekClosed: boolean;
 snapshot: WeeklySnapshot | null;
 actuals: WeekActuals | null;
 /** Actual expenses pulled from QB P&L (Cash) for the week, per budget line. */
 qbExpenses: WeekExpenseLines | null;
 /** Expected AR collections for the week, computed live from invoice terms. */
 expectedInflow: ExpectedInflowWeek | null;
};
export type PastWeeksGridResponse = { count: number; items: PastWeeksGridItem[] };
export async function fetchPastWeeksGrid(weeks = 13): Promise<PastWeeksGridResponse> {
 const res = await fetch(`/api/past-weeks-grid?weeks=${weeks}`);
 if (!res.ok) throw new Error(`Status ${res.status}`);
 return res.json();
}

export async function fetchWeeklySnapshots(): Promise<WeeklySnapshotsResponse> {
 const res = await fetch('/api/weekly-snapshots');
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

export type CpAccountLine = { name: string; balance: number; notes?: string; source: 'qb' | 'sheet' };
export type CpCreditCardLine = CpAccountLine & { minPayment: number; isPersonal: boolean };
export type CpInvoice = {
 customer: string;
 description: string;
 invoiceNumber?: string;
 issueDate: string;
 amount: number;
 dueDate?: string;
 daysOpen: number;
 bucket: '0-14' | '15-30' | '31-60' | '61-90' | '90+';
};
export type CurrentPosition = {
 cached: boolean;
 asOf: string;
 realmId: string | null;
 cash: { accounts: CpAccountLine[]; total: number; totalSource: 'qb' | 'sheet' };
 creditCards: {
 business: CpCreditCardLine[];
 personal: CpCreditCardLine[];
 businessTotal: number;
 businessMinTotal: number;
 source: 'qb' | 'sheet';
 };
 intercompany: {
 clearingBalance: number;
 clearingSource: 'qb' | 'sheet';
 expectedRemittanceWk1: number;
 accounts: CpAccountLine[];
 notes: string;
 };
 receivables: {
 external: CpInvoice[];
 intercompany: CpInvoice[];
 grossExternal: number;
 grossIntercompany: number;
 bufferPct: number;
 netCollectibleAr: number;
 arSource: 'qb' | 'sheet';
 };
 netLiquidity: {
 totalCash: number;
 creditCardDebt: number;
 purexClearing: number;
 netCollectibleAr: number;
 netWorkingCapital: number;
 };
 warnings: string[];
};

// --- Tiller live balances (from public Google Sheet) ---
export type TillerAccount = {
 accountId: string;
 name: string;
 type: string;
 balance: number;
 balanceAvailable: number | null;
 balanceLimit: number | null;
 usePct: number | null;
 currency: string;
 lastUpdated: string;
};
export type TillerBalances = {
 cached: boolean;
 fetchedAt: string;
 latestDate: string;
 sheetUrl: string;
 cashAccounts: TillerAccount[];
 creditCards: TillerAccount[];
 loans: TillerAccount[];
 investments: TillerAccount[];
 other: TillerAccount[];
 staleAccounts: TillerAccount[];
 totals: { cash: number; creditCardDebt: number; loans: number; investments: number };
};

export async function fetchTillerBalances(opts: { refresh?: boolean } = {}): Promise<TillerBalances> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/tiller/balances${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- Side-by-side QB vs Tiller ---
export type QbLine = { name: string; accountType: string; subType: string | null; masks: string[]; balance: number };
export type TillerLine = {
 name: string;
 type: string;
 masks: string[];
 balance: number;
 lastUpdated: string;
 balanceAvailable: number | null;
 balanceLimit: number | null;
 usePct: number | null;
 lastStatementClose: string | null;
 lastStatementPayment: string | null;
 lastStatementStatus: string | null;
 nextPayment: string | null;
 nextClosing: string | null;
 freezeWindow: string | null;
 scheduleNotes: string | null;
};
export type LinkedBalances = {
 cached: boolean;
 fetchedAt: string;
 tillerLatestDate: string;
 sheetUrl: string;
 realmId: string | null;
 qb: {
 cashAccounts: QbLine[];
 creditCards: QbLine[];
 cashTotal: number;
 creditTotal: number;
 intercompanyExcluded: QbLine[];
 };
 tiller: {
 cashAccounts: TillerLine[];
 creditCards: TillerLine[];
 loans: TillerLine[];
 investments: TillerLine[];
 cashTotal: number;
 creditTotal: number;
 };
 warnings: string[];
};

// --- PureX expense detail from sheet (Expenses tab) ---
export type SheetExpenseCategory = string;
export type SheetCategoryMonthly = {
 months: string[];
 monthLabels: string[];
 monthlyTotals: number[];
 total: number;
 weeklyAvgL3M: number;
 entryCount: number;
};
export type SheetExpenseEntry = {
 date: string;
 description: string;
 amount: number;
 category: string;
 group: 'Payroll' | 'Non-Payroll' | 'Settlement';
};
export type SheetExpensesResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 months: string[];
 monthLabels: string[];
 byCategory: Record<string, SheetCategoryMonthly>;
 payroll: SheetCategoryMonthly;
 inventory: SheetCategoryMonthly;
 other: SheetCategoryMonthly;
 settlement: SheetCategoryMonthly;
 totalOpex: SheetCategoryMonthly;
 entries: SheetExpenseEntry[];
 categoryOrder: string[];
 groupOf: Record<string, 'Payroll' | 'Non-Payroll' | 'Settlement'>;
 warnings: string[];
};

export async function fetchSheetExpenses(opts: { refresh?: boolean } = {}): Promise<SheetExpensesResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/sheet-expenses${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- Mapped expenses (sheet categories with QB-live values) ---
export type SheetEntity = 'PureX' | 'Moysh' | 'Combined';
export type MappedExpenseRow = {
 group: 'Payroll' | 'Non-Payroll';
 category: string;
 values: number[];
 /** Per-month PureX-paid portion (always populated). */
 purexValues?: number[];
 /** Per-month Moysh-paid portion (always populated). */
 moyshValues?: number[];
 qbSources: Array<{ name: string; total: number }>;
};
export type MappedExpensesResult = {
 cached: boolean;
 asOf: string;
 entity: SheetEntity;
 months: string[];
 monthLabels: string[];
 rows: MappedExpenseRow[];
 unmatched: Array<{ category: string; group: string; total: number }>;
};

// --- Raw QB P&L Report (live pass-through) ---
export type QbPlRow = {
 depth: number;
 name: string;
 monthly: number[];
 total: number;
 kind: 'section' | 'summary' | 'detail' | 'header';
 hasChildren: boolean;
};
export type QbPlReport = {
 asOf: string;
 realmId: string;
 startDate: string;
 endDate: string;
 months: string[];
 monthLabels: string[];
 rows: QbPlRow[];
 cached?: boolean;
};

export async function fetchQbPlReport(opts: { refresh?: boolean; method?: 'Accrual' | 'Cash' } = {}): Promise<QbPlReport & { accountingMethod?: 'Accrual' | 'Cash' }> {
 const qs = new URLSearchParams();
 if (opts.method) qs.set('method', opts.method);
 if (opts.refresh) qs.set('refresh', '1');
 const res = await fetch(`/api/qb-pl-report${qs.toString() ? '?' + qs.toString() : ''}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// Balance Sheet
export type QbBsTotals = {
 totalAssets: number; totalLiabilities: number; totalEquity: number;
 inventory: number; accountsReceivable: number; accountsPayable: number; cashAndBank: number;
};
export type QbBalanceSheetReport = {
 asOf: string; reportAsOf: string; realmId: string;
 accountingMethod: 'Accrual' | 'Cash';
 months: string[];
 monthLabels: string[];
 totals: QbBsTotals;
 rows: Array<{
 depth: number;
 name: string;
 monthly: number[];
 amount: number;
 kind: string;
 hasChildren: boolean;
 accountName: string;
 }>;
 cached?: boolean;
};
export async function fetchQbBalanceSheet(opts: { refresh?: boolean; method?: 'Accrual' | 'Cash' } = {}): Promise<QbBalanceSheetReport> {
 const params = new URLSearchParams();
 if (opts.method) params.set('method', opts.method);
 if (opts.refresh) params.set('refresh', '1');
 const qs = params.toString();
 const res = await fetch(`/api/qb-balance-sheet${qs ? '?' + qs : ''}`);
 if (!res.ok) throw new Error(`Status ${res.status}`);
 return res.json();
}

// Per-account transaction drill-down (Live P&L)
export type AccountTxn = {
 txnId: string;
 txnType: 'Purchase' | 'Bill' | 'JournalEntry' | 'Expense' | 'Check' | 'CreditCardExpense' | 'Other';
 date: string;
 vendor?: string;
 memo?: string;
 amount: number;
 sourceBank: string;
 paidBy: 'PureX' | 'Moysh' | 'Unpaid';
};
export type AccountTransactionsResult = {
 account: string;
 asOf: string;
 total: number;
 purexTotal: number;
 moyshTotal: number;
 unpaidTotal: number;
 transactions: AccountTxn[];
 cached?: boolean;
};

// Inventory purchases (actual cash spent on inventory items, Cash basis)
export type InventoryTxn = {
 txnId: string;
 txnType: 'Purchase' | 'Bill' | 'JournalEntry' | 'Expense' | 'Check' | 'CreditCardExpense' | 'Other';
 date: string;
 vendor?: string;
 memo?: string;
 amount: number;
 inventoryAccount: string;
 splitAccount: string;
 sourceBank: string;
 paidBy: 'PureX' | 'Moysh';
};
export type InventoryPurchasesResult = {
 asOf: string;
 months: string[];
 monthLabels: string[];
 total: number;
 purexTotal: number;
 moyshTotal: number;
 /** Deprecated - kept optional so the UI doesn't break during rollout. */
 unpaidTotal?: number;
 monthlyByPaidBy: Record<string, { purex: number; moysh: number; unpaid?: number }>;
 monthlyTotal: number[];
 monthlyPurex: number[];
 monthlyMoysh: number[];
 byAccount: Array<{ name: string; total: number; purex: number; moysh: number }>;
 byVendor: Array<{ vendor: string; total: number; purex: number; moysh: number; count: number }>;
 transactions: InventoryTxn[];
 cached?: boolean;
};
export async function fetchInventoryPurchases(opts: { refresh?: boolean } = {}): Promise<InventoryPurchasesResult> {
 const url = opts.refresh ? '/api/inventory-purchases?refresh=1' : '/api/inventory-purchases';
 const res = await fetch(url);
 if (!res.ok) throw new Error(`Status ${res.status}`);
 return res.json();
}

export async function fetchAccountTransactions(account: string, opts: { refresh?: boolean } = {}): Promise<AccountTransactionsResult> {
 const qs = new URLSearchParams({ account });
 if (opts.refresh) qs.set('refresh', '1');
 const res = await fetch(`/api/account-transactions?${qs.toString()}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

export async function fetchMappedExpenses(entity: SheetEntity, opts: { months?: number; refresh?: boolean } = {}): Promise<MappedExpensesResult> {
 const params = new URLSearchParams({ entity });
 if (opts.months) params.set('months', String(opts.months));
 if (opts.refresh) params.set('refresh', '1');
 const res = await fetch(`/api/expenses-mapped?${params.toString()}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- Category overrides ---
export type CategoryOverride = {
 paidBy?: 'PureX' | 'Moysh' | 'Combined' | 'Other';
 lineItem?: string;
};
export type AllCategoryOverrides = Record<string, CategoryOverride>;

export async function fetchCategoryOverrides(): Promise<AllCategoryOverrides> {
 const res = await fetch('/api/category-overrides');
 if (!res.ok) throw new Error(`Status ${res.status}`);
 return res.json();
}

// Tell every open page that a mapping changed, so they reload immediately
// (instead of waiting on a poll). Drives auto-propagation to Combined + 13-week.
function notifyOverridesChanged() {
 try { window.dispatchEvent(new Event('category-overrides-changed')); } catch { /* SSR */ }
}

export async function setCategoryOverride(account: string, override: CategoryOverride): Promise<AllCategoryOverrides> {
 const res = await fetch(`/api/category-overrides/${encodeURIComponent(account)}`, {
 method: 'PUT',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(override),
 });
 if (!res.ok) throw new Error(`Status ${res.status}`);
 const json = await res.json();
 notifyOverridesChanged();
 return json;
}

export async function clearCategoryOverride(account: string): Promise<AllCategoryOverrides> {
 const res = await fetch(`/api/category-overrides/${encodeURIComponent(account)}`, { method: 'DELETE' });
 if (!res.ok) throw new Error(`Status ${res.status}`);
 const json = await res.json();
 notifyOverridesChanged();
 return json;
}

export async function clearAllCategoryOverrides(): Promise<AllCategoryOverrides> {
 const res = await fetch('/api/category-overrides', { method: 'DELETE' });
 if (!res.ok) throw new Error(`Status ${res.status}`);
 const json = await res.json();
 notifyOverridesChanged();
 return json;
}

// --- Inflow Schedule ---
export type InflowWeek = { label: string; start: string; end: string };
export type InflowRow = {
 source: string;
 category: 'gelato' | 'other-ar' | 'purex';
 gross: number;
 values: number[];
 note?: string;
};
export type InflowScheduleResult = {
 cached: boolean;
 fetchedAt: string;
 anchor: string;
 weeks: InflowWeek[];
 rows: InflowRow[];
 weeklyTotals: number[];
 grandTotal: number;
 warnings: string[];
};

export async function fetchInflowSchedule(opts: { refresh?: boolean } = {}): Promise<InflowScheduleResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/inflow-schedule${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- Monthly OpEx: LT vs PureX ---
export type MonthlyOpexRow = {
 monthKey: string;
 monthLabel: string;
 ltDirect: number;
 purex: number;
 total: number;
 ltPct: number;
 purexPct: number;
 remitted: number;
};
export type MonthlyOpexResult = {
 cached: boolean;
 fetchedAt: string;
 rows: MonthlyOpexRow[];
 totals: { ltDirect: number; purex: number; total: number; ltPct: number; purexPct: number; remitted: number };
 averages: { ltDirect: number; purex: number; total: number; remitted: number };
 findings: string[];
 warnings: string[];
};

export async function fetchMonthlyOpex(opts: { refresh?: boolean } = {}): Promise<MonthlyOpexResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/monthly-opex${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- AR Aging (Gelato + Non-Gelato grouped) ---
export type ArBucket = '0-14' | '15-30' | '31-60' | '61-90' | '90+';
export type ArAgingInvoice = {
 invoiceNumber: string;
 customer: string;
 channel: string;
 description: string;
 issueDate: string;
 amount: number;
 daysOut: number;
 bucket: ArBucket;
 status: 'Open' | 'Overdue';
 collectPct: number;
 expectedCollectionAmount: number;
 predWeek: number;
 notes: string;
};
export type ChannelSummary = {
 channel: string;
 invoiceCount: number;
 gross: number;
 share: number;
 email: string;
};

export async function setBrandEmail(brand: string, email: string): Promise<Record<string, string>> {
 const res = await fetch(`/api/brand-emails/${encodeURIComponent(brand)}`, {
 method: 'PUT',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ email }),
 });
 if (!res.ok) throw new Error(`Failed to set email: ${res.status}`);
 return res.json();
}
export type DsoStat = {
 weightedDays: number;
 totalAmount: number;
 invoiceCount: number;
 dso: number;
};
export type CustomerConcentration = {
 totalAr: number;
 customerCount: number;
 topBrand: { name: string; ar: number; share: number } | null;
 top3Share: number;
 top5Share: number;
 top10Share: number;
 hhi: number;
 hhiTier: 'Low' | 'Moderate' | 'High';
 paretoCount: number;
 topBrands: Array<{ brand: string; ar: number; share: number; cumulativeShare: number }>;
};
export type ArAgingGroup = {
 label: 'Gelato' | 'Little Tree';
 netTermsDays: number;
 invoices: ArAgingInvoice[];
 totals: { grossAr: number; expectedCollectible: number; invoiceCount: number };
 bucketSummary: Record<ArBucket, number>;
 channelSummary: ChannelSummary[];
 customerConcentration: CustomerConcentration | null;
 dsoPaid: DsoStat;
 dsoOpen: DsoStat;
 dsoCombined: DsoStat;
 dso: number;
};
export type ArAgingResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 asOfDate: string;
 gelato: ArAgingGroup;
 nonGelato: ArAgingGroup;
 combined: {
 grossAr: number;
 expectedCollectible: number;
 invoiceCount: number;
 dso: number;
 dsoPaid: DsoStat;
 dsoOpen: DsoStat;
 dsoCombined: DsoStat;
 };
 warnings: string[];
};

export async function fetchArAging(opts: { refresh?: boolean } = {}): Promise<ArAgingResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/ar-aging${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- Settlement History (PureX → LT) ---
export type Settlement = {
 date: string;
 description: string;
 amount: number;
 daysSincePrior: number;
 cumulative: number;
};
export type SettlementHistoryResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 settlements: Settlement[];
 stats: {
 count: number;
 totalAmount: number;
 avg: number;
 median: number;
 smallest: number;
 largest: number;
 avgDaysBetween: number;
 maxGapDays: number;
 };
 derived: {
 avgMonthlySettlement: number;
 monthsCounted: number;
 requiredMonthlyOpex: number;
 cashGapPerMonth: number;
 cashGapOver13Weeks: number;
 annualizedCashDrag: number;
 };
 warnings: string[];
};

export async function fetchSettlementHistory(opts: { refresh?: boolean } = {}): Promise<SettlementHistoryResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/settlement-history${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- PureX clearing (live: (Sales I2 - Sales I1) - Expenses!F2) ---
export type PurexClearingResult = {
 cached: boolean;
 fetchedAt: string;
 sales: { i2: number; i1: number; net: number };
 expense: { total: number };
 clearing: number;
 sheetUrl: string;
 expenseSheetUrl: string;
 warnings: string[];
};

export async function fetchPurexClearing(opts: { refresh?: boolean } = {}): Promise<PurexClearingResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/purex-clearing${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- Gelato AR (live from Gelato Sales / Batches Google Sheet) ---
export type GelatoPaymentStatus = 'paid' | 'underpaid' | 'pending';
export type GelatoInvoice = {
 period: string;
 description: string;
 invoiceNumber: string;
 amount: number;
 status: string;
 comment: string;
 // Cross-referenced from the Invoice Tracker (actual collections).
 receivedAmount?: number;
 paymentStatus?: GelatoPaymentStatus;
 shortfall?: number;
};
export type GelatoArResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 totals: { openCount: number; open: number; paidCount: number; paidAmount: number; receivedOnOpen: number; underpaidCount: number };
 pendingInvoices: GelatoInvoice[];
 paidInvoices: GelatoInvoice[];
};

export async function fetchGelatoAr(opts: { refresh?: boolean } = {}): Promise<GelatoArResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/gelato-ar${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

// --- AR (Accounts Receivable from Google Sheet) ---
export type ArInvoice = { invoiceNumber: string; date: string; customer: string; amount: number; paid: number; openBalance: number; paidDate: string };
export type ArCustomer = { customer: string; openBalance: number; openInvoices: number; oldestDate: string };
export type ArResult = {
 cached: boolean;
 fetchedAt: string;
 sheetUrl: string;
 totals: { invoiced: number; collected: number; open: number; openInvoiceCount: number; uniqueCustomers: number };
 byCustomer: ArCustomer[];
 invoices: ArInvoice[];
};

export async function fetchArOpen(opts: { refresh?: boolean } = {}): Promise<ArResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/ar/open${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

export async function fetchLinkedBalances(opts: { refresh?: boolean } = {}): Promise<LinkedBalances> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/linked-balances${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed' }));
 throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}

export async function fetchCurrentPosition(opts: { refresh?: boolean } = {}): Promise<CurrentPosition> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/current-position${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed to load current position' }));
 throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type CollectionCurveSegment = { label: string; sampleCount: number; totalPaid: number; medianDays: number; cumPct: number[]; incPct: number[]; beyondPct: number };
export type CollectionCurveResult = { cached?: boolean; fetchedAt: string; weeks: number; segments: CollectionCurveSegment[] };
export async function fetchCollectionCurve(): Promise<CollectionCurveResult> {
 const res = await fetch('/api/collection-curve');
 if (!res.ok) throw new Error(`Collection curve fetch failed: ${res.status}`);
 return res.json();
}

export async function fetchCashflow13(opts: { refresh?: boolean; direction?: 'future' | 'past' } = {}): Promise<Cashflow13> {
 const params: string[] = [];
 if (opts.refresh) params.push('refresh=1');
 if (opts.direction === 'past') params.push('direction=past');
 const qs = params.length > 0 ? `?${params.join('&')}` : '';
 const res = await fetch(`/api/cashflow-13week${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed to load 13-week cashflow' }));
 throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type SalesByChannelRow = {
 channel: string;
 group: 'Gelato' | 'Other';
 monthly: number[];
 normalized: number[];
 total: number;
 totalNormalized: number;
 avgPerMonth: number;
 invoiceCount: number;
};

export type TopCustomer = {
 customer: string;
 channel: string;
 total: number;
 invoiceCount: number;
 monthsActive: number;
 lastInvoiceMonth: string | null;
};

export type CoolingCustomer = {
 customer: string;
 channel: string;
 prior3Total: number;
 prior3MonthsActive: number;
 last3Total: number;
 lastInvoiceMonth: string | null;
};

export type SalesByChannelResult = {
 fetchedAt: string;
 sheetUrl: string;
 months: Array<{ key: string; label: string; taxAffected: boolean }>;
 rows: SalesByChannelRow[];
 subtotals: {
 gelatoRaw: number[];
 gelatoNormalized: number[];
 othersRaw: number[];
 othersNormalized: number[];
 grandTotalNormalized: number[];
 };
 topCustomers: TopCustomer[];
 coolingCustomers: CoolingCustomer[];
};

export type ArStatusResult = {
 fetchedAt: string;
 year: number;
 asOfDate: string;
 currentMonth: { ym: string; label: string };
 collectedYtd: number;
 collectedYtdInvoiceCount: number;
 collectedThisMonth: number;
 collectedThisMonthInvoiceCount: number;
 collectedByMonth: Array<{ ym: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 collectedByWeekCurrentMonth: Array<{ weekStart: string; weekEnd: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 ytdFromPriorYearInvoices: number;
 ytdFromPriorYearInvoiceCount: number;
 paidWithMissingDate: number;
 paidWithMissingDateCount: number;
 paidWithMissingDateSamples: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   paidDateRaw: string;
 }>;
 outstandingTotal: number;
 outstandingCount: number;
 outstandingByAge: {
   current: { amount: number; count: number };
   d31_60: { amount: number; count: number };
   d61_90: { amount: number; count: number };
   d91Plus: { amount: number; count: number };
 };
 topOpenInvoices: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   outstanding: number;
   daysOpen: number;
 }>;
};

export async function fetchArStatus(): Promise<ArStatusResult> {
 const res = await fetch('/api/ar-status');
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type SalesStatusResult = {
 fetchedAt: string;
 year: number;
 asOfDate: string;
 currentMonth: { ym: string; label: string };
 invoicedYtd: number;
 invoicedYtdCount: number;
 invoicedThisMonth: number;
 invoicedThisMonthCount: number;
 invoicedByMonth: Array<{ ym: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 invoicedByWeekCurrentMonth: Array<{ weekStart: string; weekEnd: string; label: string; amount: number; invoiceCount: number; isCurrent: boolean }>;
 collectedFromYtd: number;
 collectedFromYtdCount: number;
 outstandingFromYtd: number;
 outstandingFromYtdCount: number;
 topCustomersYtd: Array<{
   customer: string;
   invoicedAmount: number;
   paidAmount: number;
   outstandingAmount: number;
   invoiceCount: number;
   lastInvoiceDate: string | null;
 }>;
};

export async function fetchSalesStatus(): Promise<SalesStatusResult> {
 const res = await fetch('/api/sales-status');
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type GelatoArStatusResult = ArStatusResult & {
 sheetUrl: string;
 topOpenInvoices: Array<{
   invoiceNumber: string;
   customer: string;
   invoiceDate: string;
   amount: number;
   paid: number;
   outstanding: number;
   daysOpen: number;
   status: string;
 }>;
 writeOffStats: { count: number; amount: number };
};

export async function fetchGelatoArStatus(): Promise<GelatoArStatusResult> {
 const res = await fetch('/api/gelato-ar-status');
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type UpflowInvoiceStatus = {
 invoiceNumber: string;
 customer: string;
 invoiceAmount: number;
 outstanding: number;
 issueDate: string;
 dueDate: string;
 status: string;                  // raw Upflow state: OPEN / OVERDUE / PARTIAL etc.
 daysOverdue: number;
 lastReminderAt: string | null;
 reminderCount: number;
 dunningPlan: string | null;
 paymentLink: string | null;
 customerDirectUrl: string | null;
};
export type UpflowReminderEvent = {
 invoiceNumber: string;
 customer: string;
 sentAt: string;
 channel: string;
 template: string;
 dunningPlan: string | null;
 state: string;       // TODO / EXECUTED / IGNORED
 source: string;      // WORKFLOW / REPLY
 replyFrom: string | null;
 assignedTo: string[];
};

export type UpflowReply = {
 id: string;
 customer: string;
 customerId: string | null;
 dunningPlanId: string | null;
 invoiceNumber: string;
 replyFrom: string | null;
 receivedAt: string;
 state: string;
 daysSinceReceived: number;
 assignedTo: string[];
 looksLikeNoise: boolean;
 upflowUrl: string | null;
};

export async function assignUpflowDunningPlan(customerId: string, dunningPlanId: string | null): Promise<{ ok: boolean; customer: { id: string; dunningPlanId: string | null } }> {
 const res = await fetch('/api/upflow/assign-plan', {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ customerId, dunningPlanId }),
 });
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Status ${res.status}`);
 }
 return res.json();
}
export type UpflowAgingBucket = {
 bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
 invoiceCount: number;
 amount: number;
};
export type UpflowTopCustomer = {
 customerId: string;
 customer: string;
 balance: number;
 openInvoiceCount: number;
 dunningPlan: string | null;
 dunningPlanId: string | null;
 directUrl: string | null;
};
export type UpflowPayment = {
 id: string;
 externalId: string | null;
 amount: number;
 currency: string;
 validatedAt: string;
 createdAt: string;
 instrument: string;
 customer: string;
 linkedInvoiceCount: number;
};
export type UpflowUser = {
 id: string;
 firstName: string;
 lastName: string;
 email: string;
 position: string;
};
export type UpflowDashboardResult = {
 fetchedAt: string;
 connected: boolean;
 lastError: string | null;
 totals: {
   openInvoices: number;
   openAmount: number;
   overdueInvoices: number;
   overdueAmount: number;
   remindersSentToday: number;
   remindersSentLast7d: number;
   remindersSentLast30d: number;
   remindersQueued: number;
   paymentsLast30dCount: number;
   paymentsLast30dAmount: number;
   repliesPending: number;
   repliesHandled: number;
   repliesIgnoredNoise: number;
 };
 invoices: UpflowInvoiceStatus[];
 reminders: UpflowReminderEvent[];
 aging: UpflowAgingBucket[];
 topCustomers: UpflowTopCustomer[];
 allCustomersWithBalance: UpflowTopCustomer[];
 dunningPlans: Array<{ id: string; name: string; mode: string; entity: string; invoicesOnPlan: number; customersOnPlan: number; actionsFired: number }>;
 payments: UpflowPayment[];
 users: UpflowUser[];
 priorityChase: UpflowPriorityRow[];
 replies: UpflowReply[];
};

export type UpflowPriorityRow = {
 invoiceNumber: string;
 customer: string;
 customerDirectUrl: string | null;
 outstanding: number;
 daysOverdue: number;
 dunningPlan: string | null;
 lastReminderAt: string | null;
 daysSinceLastReminder: number | null;
 reasons: string[];
 score: number;
};

export async function fetchUpflowDashboard(opts: { refresh?: boolean } = {}): Promise<UpflowDashboardResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/upflow${qs}`);
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export async function fetchSalesByChannel(opts: { refresh?: boolean } = {}): Promise<SalesByChannelResult> {
 const qs = opts.refresh ? '?refresh=1' : '';
 const res = await fetch(`/api/sales-by-channel${qs}`);
 if (!res.ok) {
 const body = await res.json().catch(() => ({ error: 'Failed to load sales by channel' }));
 throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type SalesByRepsYearly = {
 year: string;
 confirmed: number;
 predicted: number;
 total: number;
 invoiceCount: number;
 isPartial: boolean;
 yoyDelta: number | null;
 yoyPct: number | null;
 monthsInYearReported: number;
};
export type SalesByRepsYoyTrend = {
 currYearLabel: string;
 prevYearLabel: string;
 monthsCompared: number;
 currYTD: number;
 prevYTD: number;
 rate: number;
 rawRate: number;
};
export type SalesByRepsMonthlyMatrixRow = {
 year: string;
 monthly: number[];
 total: number;
 isPartial: boolean;
};

export type SalesByRepsRow = {
 rep: string;
 monthly: number[];
 total: number;
 invoiceCount: number;
 avgPerMonth: number;
 monthsActive: number;
 lastInvoiceMonth: string | null;
 topCustomers: Array<{ customer: string; total: number; invoiceCount: number }>;
 rawVariants: string[];
 predictedMonthly: number[];
 predictedTotal: number;
 predictedInvoiceCount: number;
 predictedFromCustomers: Array<{ customer: string; total: number; invoiceCount: number; confidence: number }>;
 yearly: SalesByRepsYearly[];
 shareOfTotalPct: number;
 grandTotal: number;
 combinedMonthly: number[];
 yoyTrend: SalesByRepsYoyTrend | null;
 monthlyMatrix: SalesByRepsMonthlyMatrixRow[];
};
export type SalesByRepsResult = {
 fetchedAt: string;
 sourceLtFinancialsUrl: string;
 sourceCommissionSheetUrl: string;
 months: Array<{ key: string; label: string }>;
 rows: SalesByRepsRow[];
 totals: {
   monthly: number[];
   grandTotal: number;
   invoiceCount: number;
   unmappedInvoiceCount: number;
   unmappedAmount: number;
   predictedInvoiceCount: number;
   predictedAmount: number;
   coveragePct: number;
   coveragePctIncludingPredicted: number;
   yearly: SalesByRepsYearly[];
   yoyTrend: SalesByRepsYoyTrend | null;
   monthlyMatrix: SalesByRepsMonthlyMatrixRow[];
 };
 customerRepLearned: Array<{
   customer: string;
   dominantRep: string;
   confidence: number;
   confirmedInvoiceCount: number;
 }>;
 warnings: string[];
};
export async function fetchSalesByReps(): Promise<SalesByRepsResult> {
 const res = await fetch('/api/sales-by-reps');
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type CommissionType = 'NEW' | 'OLD' | 'WHITELABEL';
export type CommissionInvoice = {
 invoiceNumber: string;
 customer: string;
 rep: string;
 repSource: 'override' | 'workbook' | 'sheet' | 'predicted' | 'unmapped';
 isPredicted: boolean;
 needsReview: boolean;
 reviewReasons: string[];
 invoiceDate: string;
 paidDate: string;
 paidMonth: string;
 invoiceAmount: number;
 shipping: number;
 tax: number;
 credit: number;
 pureXFee: number;
 netAmount: number;
 netSource: 'workbook' | 'sheet' | 'fallback';
 commissionType: CommissionType;
 typeSource: 'override' | 'workbook' | 'auto';
 businessTypeLabel: string;
 rate: number;
 commission: number;
 commissionSource: 'workbook' | 'computed';
 daysSinceLastPaid: number | null;
};
export type CommissionRepStats = {
 rep: string;
 invoiceCount: number;
 confirmedInvoiceCount: number;
 predictedInvoiceCount: number;
 totalCommission: number;
 commissionByType: { NEW: number; OLD: number; WHITELABEL: number };
 invoiceCountByType: { NEW: number; OLD: number; WHITELABEL: number };
 newBusinessAccounts: number;
 oldBusinessAccounts: number;
 monthly: Array<{ ym: string; label: string; commission: number; invoiceCount: number; newAccounts: number; oldAccounts: number }>;
 yearly: Array<{ year: string; commission: number; invoiceCount: number; isPartial: boolean; yoyPct: number | null; yoyDelta: number | null }>;
 yoyTrend: { currYearLabel: string; prevYearLabel: string; monthsCompared: number; currYTD: number; prevYTD: number; rate: number } | null;
 topCustomers: Array<{ customer: string; commission: number; invoiceCount: number }>;
 shareOfTotalPct: number;
};
export type CommissionResult = {
 fetchedAt: string;
 rules: { newRate: number; oldRate: number; whitelabelRate: number; newOldThresholdDays: number };
 months: Array<{ ym: string; label: string }>;
 reps: CommissionRepStats[];
 totals: {
   grandTotalCommission: number;
   grandTotalInvoiceCount: number;
   commissionThisMonth: number;
   commissionLastMonth: number;
   commissionYtd: number;
   confirmedInvoiceCount: number;
   predictedInvoiceCount: number;
   skippedInvoiceCount: number;
   invoicesWithSheetDeductions: number;
   invoicesWithFallbackDeductions: number;
   totalShipping: number;
   totalTax: number;
   totalCredit: number;
   totalPureXFee: number;
   overrideInvoiceCount: number;
   needsReviewCount: number;
   unmappedRepCount: number;
   monthly: number[];
   yearly: Array<{ year: string; commission: number; invoiceCount: number; isPartial: boolean }>;
 };
 invoices: CommissionInvoice[];
 warnings: string[];
};
export async function fetchCommission(): Promise<CommissionResult> {
 const res = await fetch('/api/commission');
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export async function setCommissionOverride(invoiceNumber: string, type: CommissionType | null): Promise<{ ok: boolean }> {
 const res = await fetch('/api/commission/override', {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ invoiceNumber, type }),
 });
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export async function setCommissionRepOverride(invoiceNumber: string, rep: string | null): Promise<{ ok: boolean }> {
 const res = await fetch('/api/commission/rep-override', {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ invoiceNumber, rep }),
 });
 if (!res.ok) {
   const body = await res.json().catch(() => ({ error: 'Failed' }));
   throw new Error(body.error ?? `Request failed: ${res.status}`);
 }
 return res.json();
}

export type CashflowOverrides = {
 mode: 'manual' | 'auto';
 ccUtilisationByWeek: Record<string, number>;
};

export async function fetchCashflowOverrides(): Promise<CashflowOverrides> {
 const res = await fetch('/api/cashflow-overrides');
 if (!res.ok) throw new Error(`Failed to load overrides: ${res.status}`);
 return res.json();
}

export async function saveCashflowOverrides(next: CashflowOverrides): Promise<CashflowOverrides> {
 const res = await fetch('/api/cashflow-overrides', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(next),
 });
 if (!res.ok) throw new Error(`Failed to save overrides: ${res.status}`);
 return res.json();
}

// Expense head overrides (Expenses → Edit tab). head → { monthly amount, who
// edited, when }. Display-only; does not affect the cashflow.
export type ExpenseOverride = { value: number; by: string; at: string };
export type ExpenseOverrides = Record<string, ExpenseOverride>;

export async function fetchExpenseOverrides(): Promise<ExpenseOverrides> {
 const res = await fetch('/api/expense-overrides');
 if (!res.ok) throw new Error(`Failed to load expense overrides: ${res.status}`);
 return res.json();
}

export async function saveExpenseOverrides(values: Record<string, number>): Promise<ExpenseOverrides> {
 const res = await fetch('/api/expense-overrides', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ overrides: values, by: currentUserName() }),
 });
 if (!res.ok) throw new Error(`Failed to save expense overrides: ${res.status}`);
 return res.json();
}

// AR open invoices (Projections → AR tab) - matches the AR dashboard's Little
// Tree open AR (full, no 12-month stale cutoff).
export type ArOpenInvoice = {
 invoiceNumber: string; customer: string; brand: string; issueDate: string;
 amount: number; daysOut: number; bucket: string; status: string; infusedOrigin: boolean;
};
export type ArOpenResult = {
 asOfDate: string; grossAr: number; invoiceCount: number;
 buckets: Record<string, number>; invoices: ArOpenInvoice[];
 segments: { all: number; littleTree: number; infusedOrigin: number };
};
export async function fetchArOpenInvoices(): Promise<ArOpenResult> {
 const res = await fetch('/api/ar-open-invoices');
 if (!res.ok) throw new Error(`Failed to load AR open invoices: ${res.status}`);
 return res.json();
}

// AR collections history — month × year grid + seasonality (the trend behind the projection).
export type ArCollectionsHistory = {
 asOf: string;
 years: number[];
 grid: Array<Record<number, number>>;          // grid[month 0-11][year] = $ collected
 yearTotals: Record<number, number>;
 seasonality: Array<{ month: number; index: number; avg: number }>;
 overallMonthlyAvg: number;
 recentMonthlyAvg: number;
 recentWeeklyAvg: number;
 lagCurve: number[];          // share collected wk0 (same week), +1, … +12
 lagCumulative: number[];     // cumulative collected by week k
 recoveryBands: Array<{ bucket: string; recovery: number; paid: number; writeOff: number; n: number }>;
};
export async function fetchArCollectionsHistory(): Promise<ArCollectionsHistory> {
 const res = await fetch('/api/ar-collections-history');
 if (!res.ok) throw new Error(`Failed to load AR collections history: ${res.status}`);
 return res.json();
}

// Collected detail for a date range (drill-down: which invoices made up the actual).
export type CollectedInvoice = { invoiceNumber: string; customer: string; channel: string; invoiceDate: string; paidDate: string; amount: number; paid: number };
export type CollectedDetail = {
 start: string; end: string;
 nonGelato: { total: number; count: number; invoices: CollectedInvoice[] };
 gelato: { total: number; count: number; invoices: CollectedInvoice[] };
 // Gross sales INVOICED over the full [start, end] window (by bill date) - the
 // Variance "Little Tree Sales" REF actual uses this so it spans the whole
 // month-to-date (incl. the in-progress week), not just the closed weeks.
 salesInvoiced?: { gelato: { amount: number; invoiceCount: number }; nonGelato: { amount: number; invoiceCount: number }; total: number };
};
export async function fetchCollectedDetail(start: string, end: string): Promise<CollectedDetail> {
 const res = await fetch(`/api/collected-detail?start=${start}&end=${end}`);
 if (!res.ok) throw new Error(`Failed to load collected detail: ${res.status}`);
 return res.json();
}

// Outflow drill-down: PureX-paid expense entries (live sheet) grouped by budget line.
export type ExpenseEntry = { date: string; description: string; amount: number; category: string; line: string };
export type ExpenseEntriesRange = {
 start: string; end: string;
 byLine: Record<string, { total: number; entries: ExpenseEntry[] }>;
 total: number;
};
export async function fetchExpenseEntries(start: string, end: string): Promise<ExpenseEntriesRange> {
 const res = await fetch(`/api/expense-entries?start=${start}&end=${end}`);
 if (!res.ok) throw new Error(`Failed to load expense entries: ${res.status}`);
 return res.json();
}

// Combined (PureX + Moysh) actual expense for a calendar month — budget basis.
export type CombinedActual = {
 month: string; isCurrentMonth: boolean; source: string;
 byLine: Record<string, number>;
 entries: ExpenseEntry[];
};
export async function fetchCombinedActual(month: string): Promise<CombinedActual> {
 const res = await fetch(`/api/combined-actual?month=${month}`);
 if (!res.ok) throw new Error(`Failed to load combined actual: ${res.status}`);
 return res.json();
}

// AR projection methodology (Projections → AR tab). Per-customer collection lag,
// collectibility haircut, lag curve, weekly placements.
export type ArLagCurvePoint = { lag: number; pctOfInvoiced: number };
export type ArChannelStat = {
 channel: string; sampleInvoiceCount: number; totalInvoiced: number;
 totalCollected: number; collectionRate: number; curve: ArLagCurvePoint[]; source: string;
};
export type ArPlacementRow = {
 customer: string; channel: string; invoiceNumber: string; invoiceDate: string;
 amount: number; paidAmount: number; openBalance: number; status: string;
 currentLag: number; collectibility: number; projectedCollectible: number;
 placements: Array<{ targetMonth: string; amount: number; weekIndices: number[] }>;
};
export type ArProjectionResult = {
 weeks: Array<{ index: number; start: string; end: string; label: string }>;
 arByWeek: number[];
 buckets: { overdueWk1: number; openInWindow: number; openAfterWindow: number; futureProjected: number };
 channelStats: ArChannelStat[];
 globalCurve: ArLagCurvePoint[];
 globalCollectionRate: number;
 placements: ArPlacementRow[];
 globalAvgCollectionDays: number;
 dailyRunRate: number;
 projectedCollectibilityRate: number;
 warnings: string[];
};

export async function fetchArProjection(): Promise<ArProjectionResult> {
 const res = await fetch('/api/ar-projection');
 if (!res.ok) throw new Error(`Failed to load AR projection: ${res.status}`);
 return res.json();
}

// The signed-in user's display name (set by login in sessionStorage). Used to
// attribute manual edits ("edited by …"). Falls back to the email local-part.
export function currentUserName(): string {
 try {
 const name = sessionStorage.getItem('lt_name');
 if (name && name.trim()) return name.trim();
 const email = sessionStorage.getItem('lt_user') || '';
 if (email) return email.split('@')[0].split(/[._]/)[0];
 } catch { /* SSR / blocked storage */ }
 return 'Unknown';
}

// Unified cashflow cell edits (inflow Sales/AR + outflow expenses), persisted in
// Supabase with attribution. Key = `${rowLabel}|${weekStart}`.
export type CellEdit = { value: number; by: string; at: string; reason?: string };
export type CashflowEdits = Record<string, CellEdit>;

export async function fetchCashflowEdits(): Promise<CashflowEdits> {
 const res = await fetch('/api/cashflow-edits');
 if (!res.ok) throw new Error(`Failed to load cashflow edits: ${res.status}`);
 return res.json();
}

export async function saveCashflowEdits(set: Record<string, number>, clear: string[] = [], reasons: Record<string, string> = {}): Promise<CashflowEdits> {
 const res = await fetch('/api/cashflow-edits', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ set, clear, by: currentUserName(), reasons }),
 });
 if (!res.ok) throw new Error(`Failed to save cashflow edits: ${res.status}`);
 const data = await res.json();
 // Tell every view (monthly edit, weekly edit, 13-Week grid) to refresh so an
 // edit in one place shows in the others instantly.
 try { window.dispatchEvent(new Event('cashflow-edits-changed')); } catch { /* SSR */ }
 return data;
}

// Per-PAYEE edits - breakdown-level overrides behind an outflow line on the
// Expense Edit page. Key: `${line}::${payee}|${weekStart}`. Same shape as the
// line-level cashflow edits.
export type PayeeEdits = Record<string, CellEdit>;

export async function fetchPayeeEdits(): Promise<PayeeEdits> {
 const res = await fetch('/api/cashflow-payee-edits');
 if (!res.ok) throw new Error(`Failed to load payee edits: ${res.status}`);
 return res.json();
}

export async function savePayeeEdits(set: Record<string, number>, clear: string[] = [], reasons: Record<string, string> = {}): Promise<PayeeEdits> {
 const res = await fetch('/api/cashflow-payee-edits', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ set, clear, by: currentUserName(), reasons }),
 });
 if (!res.ok) throw new Error(`Failed to save payee edits: ${res.status}`);
 const data = await res.json();
 try { window.dispatchEvent(new Event('cashflow-edits-changed')); } catch { /* SSR */ }
 return data;
}

// Manual expense heads - owner-added payees on a line (name + details). Per-week
// amounts go through savePayeeEdits like any other payee.
export type ManualHead = { name: string; details: string; by: string; at: string };
export type ManualHeads = Record<string, ManualHead[]>;

export async function fetchManualHeads(): Promise<ManualHeads> {
 const res = await fetch('/api/cashflow-manual-heads');
 if (!res.ok) throw new Error(`Failed to load manual heads: ${res.status}`);
 return res.json();
}

export async function saveManualHead(line: string, name: string, details: string): Promise<ManualHeads> {
 const res = await fetch('/api/cashflow-manual-heads', {
 method: 'POST', headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ line, name, details, by: currentUserName() }),
 });
 if (!res.ok) throw new Error(`Failed to add head: ${res.status}`);
 return res.json();
}

export async function removeManualHead(line: string, name: string): Promise<ManualHeads> {
 const res = await fetch('/api/cashflow-manual-heads', {
 method: 'POST', headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ line, name, remove: true, by: currentUserName() }),
 });
 if (!res.ok) throw new Error(`Failed to remove head: ${res.status}`);
 return res.json();
}

// Sales + AR forecast overrides (Sales → Edit tab). Per-week amounts keyed by
// week-start (YYYY-MM-DD). Display-only; does not affect the cashflow.
export type ForecastOverrides = { sales: Record<string, number>; ar: Record<string, number> };

export async function fetchForecastOverrides(): Promise<ForecastOverrides> {
 const res = await fetch('/api/forecast-overrides');
 if (!res.ok) throw new Error(`Failed to load forecast overrides: ${res.status}`);
 return res.json();
}

export async function saveForecastOverrides(next: ForecastOverrides): Promise<ForecastOverrides> {
 const res = await fetch('/api/forecast-overrides', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify(next),
 });
 if (!res.ok) throw new Error(`Failed to save forecast overrides: ${res.status}`);
 return res.json();
}

export async function deleteWeeklySnapshot(monday: string): Promise<void> {
 const res = await fetch(`/api/weekly-snapshots/${encodeURIComponent(monday)}`, { method: 'DELETE' });
 if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
}

// ── CFO Copilot ──────────────────────────────────────────────────────────────
export type CopilotNav = { view: string; tab: string; anchor: string; where: string };
export type AssistantResponse = {
 intent: string;
 title: string;
 lines: string[];
 note?: string;
 warning?: string;
 nav?: CopilotNav;
 confidence: number;
 suggestions: string[];
 asOf: string;
};

export async function askCopilot(
 question: string,
 user?: { name?: string; title?: string },
 since?: string,
): Promise<AssistantResponse> {
 const res = await fetch('/api/assistant', {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ question, user, since }),
 });
 if (!res.ok) throw new Error(`Copilot failed: ${res.status}`);
 return res.json();
}

export type CopilotChanges = { title: string; lines: string[]; note?: string };
export async function fetchCopilotChanges(since?: string): Promise<CopilotChanges> {
 const qs = since ? `?since=${encodeURIComponent(since)}` : '';
 const res = await fetch(`/api/assistant/changes${qs}`);
 if (!res.ok) throw new Error(`changes failed: ${res.status}`);
 return res.json();
}

// --- Expenses straight from QB P&L, grouped by your category mapping (no sheet) ---
export type PnlExpenseAccount = { name: string; monthly: number[]; total: number };
export type PnlExpenseCategory = { category: string; monthly: number[]; total: number; accounts: PnlExpenseAccount[] };
export type PnlExpensesResult = {
  asOf: string;
  months: string[];
  monthLabels: string[];
  categories: PnlExpenseCategory[];
  mappedTotal: number;
  unmappedTotal: number;
  grandTotal: number;
};
export async function fetchPnlExpenses(opts: { method?: 'Cash' | 'Accrual'; refresh?: boolean } = {}): Promise<PnlExpensesResult> {
  const qs = new URLSearchParams({ method: opts.method ?? 'Cash' });
  if (opts.refresh) qs.set('refresh', '1');
  const res = await fetch(`/api/pnl-expenses?${qs.toString()}`);
  if (!res.ok) throw new Error(`pnl-expenses failed: ${res.status}`);
  return res.json();
}
