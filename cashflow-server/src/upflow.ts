/**
 * Upflow integration - AR collection automation tool.
 *
 * Auth: x-api-key + x-api-secret headers (from Upflow Settings -> API keys).
 *
 * Endpoints available (probed live):
 *   GET /v1/invoices       (paginated, 11k+ rows in this tenant)
 *   GET /v1/customers      (paginated, 2k+ rows)
 *   GET /v1/payments       (paginated)
 *   GET /v1/dunning_plans  (44 plans, single page)
 *   GET /v1/users          (team members)
 * Not available (would 404): /reminders, /events, /activities, /aging,
 * /dashboard, /payment-links, /dunning-plans (with dash). Per-invoice
 * communication history isn't exposed via API in this Upflow version, so
 * the reminder log table in the UI stays empty - we surface dunning-plan
 * NAMES instead (which workflow is governing each invoice).
 *
 * All money values from Upflow are in CENTS - we divide by 100 here so
 * the rest of the app keeps using dollars uniformly.
 */

const BASE_URL = process.env.UPFLOW_API_BASE_URL ?? 'https://api.upflow.io';
const API_KEY = process.env.UPFLOW_API_KEY ?? '';
const API_SECRET = process.env.UPFLOW_API_SECRET ?? '';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 500;       // max page size Upflow seems to accept
const MAX_PAGES = 60;          // safety cap (60 × 500 = 30k invoices ceiling)

// "Open" states - what we surface in the dashboard. Paid + cancelled invoices
// drop off the active list (they're history, not chase candidates).
const OPEN_STATES = new Set(['OPEN', 'OVERDUE', 'PARTIAL']);

export type UpflowInvoiceStatus = {
 invoiceNumber: string;       // customId (matches our internal invoice number)
 customer: string;
 invoiceAmount: number;       // dollars
 outstanding: number;
 issueDate: string;           // YYYY-MM-DD
 dueDate: string;
 status: string;              // raw Upflow state (OPEN / OVERDUE / PARTIAL / PAID...)
 daysOverdue: number;         // 0 if not yet due
 lastReminderAt: string | null;   // always null - API doesn't expose
 reminderCount: number;            // 0 - not exposed
 dunningPlan: string | null;       // resolved plan name
 paymentLink: string | null;       // pdfUrl from Upflow (signed, expiring)
 customerDirectUrl: string | null; // link to Upflow dashboard for this customer
};

export type UpflowReminderEvent = {
 invoiceNumber: string;
 customer: string;
 sentAt: string;                  // updatedAt of the action when it moved to EXECUTED
 channel: string;                 // EMAIL / TASK
 template: string;                // action name (e.g. "2nd reminder : 6 days after due date")
 dunningPlan: string | null;
 state: 'TODO' | 'EXECUTED' | 'IGNORED' | string;
 source: 'WORKFLOW' | 'REPLY' | string;       // WORKFLOW = we sent, REPLY = customer sent back
 replyFrom: string | null;                     // for REPLY rows: "Anna Charles" extracted from name
 assignedTo: string[];                         // emails of LT teammates expected to handle
};

export type UpflowReply = {
 id: string;
 customer: string;
 customerId: string | null;                    // for workflow assign
 dunningPlanId: string | null;                 // current plan on the customer
 invoiceNumber: string;
 replyFrom: string | null;                     // sender name from action.name ("Reply to X")
 receivedAt: string;
 state: 'TODO' | 'EXECUTED' | 'IGNORED' | string;
 daysSinceReceived: number;
 assignedTo: string[];                         // who can respond
 looksLikeNoise: boolean;                      // true for no-reply@/mail-noreply system bounces
 upflowUrl: string | null;                     // direct deeplink to Upflow UI for this customer
};

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
   repliesPending: number;          // TODO REPLY actions, not noise
   repliesHandled: number;          // EXECUTED REPLY actions
   repliesIgnoredNoise: number;     // IGNORED REPLY actions (mostly bounces)
 };
 invoices: UpflowInvoiceStatus[];
 reminders: UpflowReminderEvent[];     // populated from /v1/actions
 aging: UpflowAgingBucket[];
 topCustomers: UpflowTopCustomer[];
 allCustomersWithBalance: UpflowTopCustomer[];
 dunningPlans: Array<{ id: string; name: string; mode: string; entity: string; invoicesOnPlan: number; customersOnPlan: number; actionsFired: number }>;
 payments: UpflowPayment[];
 users: UpflowUser[];
 /** Top 15 invoices ranked by chase priority (outstanding × days overdue,
  *  minus a penalty if a reminder was sent in the last 7 days). The
  *  Overview tab leads with this so the user sees "chase these first"
  *  instead of having to browse 200+ rows. */
 priorityChase: UpflowPriorityRow[];
 /** Inbound replies from customers - separated from outbound reminders so
  *  the team can see "who wrote back" without scrolling through workflow
  *  emails. System bounces (Google / Gmail / Upflow no-reply) tagged as
  *  noise so the UI can dim them. */
 replies: UpflowReply[];
};

export type UpflowPriorityRow = {
 invoiceNumber: string;
 customer: string;
 customerDirectUrl: string | null;
 outstanding: number;
 daysOverdue: number;
 dunningPlan: string | null;
 lastReminderAt: string | null;     // most recent EXECUTED action for this invoice (any)
 daysSinceLastReminder: number | null;
 reasons: string[];                  // why this scored high
 score: number;
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

function isConfigured(): boolean {
 return API_KEY.length > 0 && API_SECRET.length > 0;
}

async function upflowGet<T>(path: string): Promise<T> {
 if (!isConfigured()) throw new Error('UPFLOW_API_KEY / UPFLOW_API_SECRET not set in server/.env');
 const url = `${BASE_URL}${path}`;
 const res = await fetch(url, {
   headers: {
     'x-api-key': API_KEY,
     'x-api-secret': API_SECRET,
     'Content-Type': 'application/json',
   },
 });
 if (!res.ok) {
   const body = await res.text().catch(() => '');
   throw new Error(`Upflow ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
 }
 return res.json() as Promise<T>;
}

async function upflowPut<T>(path: string, body: unknown): Promise<T> {
 if (!isConfigured()) throw new Error('UPFLOW_API_KEY / UPFLOW_API_SECRET not set in server/.env');
 const res = await fetch(`${BASE_URL}${path}`, {
   method: 'PUT',
   headers: {
     'x-api-key': API_KEY,
     'x-api-secret': API_SECRET,
     'Content-Type': 'application/json',
   },
   body: JSON.stringify(body),
 });
 if (!res.ok) {
   const text = await res.text().catch(() => '');
   throw new Error(`Upflow PUT ${path} failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
 }
 return res.json() as Promise<T>;
}

/** Assign (or clear with null) a dunning plan on an Upflow customer. Pulled
 *  via PUT /v1/customers/{id} since Upflow doesn't expose a dedicated
 *  /assign-plan endpoint - we update the customer record with the new
 *  dunningPlanId and Upflow handles workflow attachment. */
export async function assignCustomerDunningPlan(customerId: string, dunningPlanId: string | null): Promise<{ ok: true; customer: { id: string; dunningPlanId: string | null } }> {
 const updated = await upflowPut<{ id: string; dunningPlanId: string | null }>(`/v1/customers/${encodeURIComponent(customerId)}`, { dunningPlanId });
 invalidateUpflowCache();
 return { ok: true, customer: { id: updated.id, dunningPlanId: updated.dunningPlanId } };
}

type UpflowInvoiceRaw = {
 id: string;
 customId: string | null;
 customerId: string;
 externalId: string | null;
 source: string;
 issuedAt: string;
 netAmount: number;          // cents
 amountOutstanding: number;  // cents
 grossAmount: number;        // cents
 dueDate: string | null;
 currency: string;
 dunningPlanId: string | null;
 state: string;
 pdfUrl: string | null;
 payments: unknown[];
};

type UpflowCustomerRaw = {
 id: string;
 name: string;
 balance: number;            // cents
 countInvoicesDue: number;
 dunningPlanId: string | null;
 directUrl: string | null;
};

type UpflowDunningPlanRaw = {
 id: string;
 name: string;
 mode: string;
 entity: string;
};

async function fetchAllInvoices(): Promise<UpflowInvoiceRaw[]> {
 const out: UpflowInvoiceRaw[] = [];
 for (let page = 0; page < MAX_PAGES; page++) {
   const offset = page * PAGE_LIMIT;
   const data = await upflowGet<{ offset: number; limit: number; total: number; invoices: UpflowInvoiceRaw[] }>(
     `/v1/invoices?limit=${PAGE_LIMIT}&offset=${offset}`,
   );
   for (const inv of data.invoices) {
     // Only keep invoices that aren't fully paid / cancelled - the active chase list.
     if (OPEN_STATES.has(inv.state)) out.push(inv);
   }
   if (data.invoices.length < PAGE_LIMIT) break;       // last page
 }
 return out;
}

async function fetchCustomerMap(customerIds: Set<string>): Promise<Map<string, UpflowCustomerRaw>> {
 const m = new Map<string, UpflowCustomerRaw>();
 // Easiest: page through /v1/customers - 2,296 total, ~5 pages at 500/page.
 for (let page = 0; page < MAX_PAGES; page++) {
   const offset = page * PAGE_LIMIT;
   const data = await upflowGet<{ offset: number; limit: number; total: number; customers: UpflowCustomerRaw[] }>(
     `/v1/customers?limit=${PAGE_LIMIT}&offset=${offset}`,
   );
   for (const c of data.customers) {
     if (customerIds.has(c.id)) m.set(c.id, c);
   }
   if (data.customers.length < PAGE_LIMIT) break;
 }
 return m;
}

async function fetchDunningPlans(): Promise<UpflowDunningPlanRaw[]> {
 const data = await upflowGet<{ offset: number; limit: number; total: number; items: UpflowDunningPlanRaw[] }>(
   `/v1/dunning_plans?limit=200`,
 );
 return data.items ?? [];
}

type UpflowActionRaw = {
 id: string;
 name: string;
 type: string;                  // EMAIL / TASK / ...
 state: string;                 // TODO / EXECUTED / IGNORED
 source: string;                // WORKFLOW / MANUAL
 createdAt: string;
 updatedAt: string;
 dueDate: string | null;
 dunningPlan: { id: string; name: string } | null;
 customer: { id: string; companyName: string } | null;
 carryingInvoice: { id: string; customId: string | null; externalId: string | null } | null;
 assignedTo?: any[];
};

async function fetchAllActions(): Promise<UpflowActionRaw[]> {
 const out: UpflowActionRaw[] = [];
 for (let page = 0; page < MAX_PAGES; page++) {
   const offset = page * PAGE_LIMIT;
   const data = await upflowGet<{ offset: number; limit: number; total: number; items: UpflowActionRaw[] }>(
     `/v1/actions?limit=${PAGE_LIMIT}&offset=${offset}`,
   );
   out.push(...data.items);
   if (data.items.length < PAGE_LIMIT) break;
 }
 return out;
}

type UpflowPaymentRaw = {
 id: string;
 externalId: string | null;
 amount: number;            // cents
 currency: string;
 validatedAt: string;
 createdAt: string;
 instrument: string;
 customer: { id: string; companyName: string } | null;
 linkedInvoices: Array<{ linkedAmount: number; invoice: unknown }>;
};

async function fetchRecentPayments(limit = 200): Promise<UpflowPaymentRaw[]> {
 // Just fetch the first page sorted by Upflow's default (newest first - the
 // sample showed validatedAt: 2026-05-12 in the first item).
 const data = await upflowGet<{ offset: number; limit: number; total: number; items: UpflowPaymentRaw[] }>(
   `/v1/payments?limit=${Math.min(limit, PAGE_LIMIT)}`,
 );
 return data.items ?? [];
}

type UpflowUserRaw = {
 id: string;
 firstName: string;
 lastName: string;
 email: string;
 position: string;
};

async function fetchUsers(): Promise<UpflowUserRaw[]> {
 const data = await upflowGet<{ users: UpflowUserRaw[] }>(`/v1/users`);
 return data.users ?? [];
}

// --- Cache (15 min TTL - UI polls hourly, so a fresh fetch on every
// click + 15-min staleness for accidental rapid hits is the right balance.
// "Refresh now" button doesn't bypass the cache; if the user wants a hard
// pull they can wait the TTL out. We could add a ?refresh=1 escape hatch
// later if needed. ---
let _cache: { at: number; data: UpflowDashboardResult } | null = null;
const CACHE_TTL_MS = 15 * 60 * 1000;
export function invalidateUpflowCache(): void { _cache = null; }

export async function getUpflowDashboard(opts: { force?: boolean } = {}): Promise<UpflowDashboardResult> {
 if (!opts.force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;

 const empty: UpflowDashboardResult = {
   fetchedAt: new Date().toISOString(),
   connected: false,
   lastError: null,
   totals: { openInvoices: 0, openAmount: 0, overdueInvoices: 0, overdueAmount: 0, remindersSentToday: 0, remindersSentLast7d: 0, remindersSentLast30d: 0, remindersQueued: 0, paymentsLast30dCount: 0, paymentsLast30dAmount: 0, repliesPending: 0, repliesHandled: 0, repliesIgnoredNoise: 0 },
   invoices: [],
   reminders: [],
   aging: [],
   topCustomers: [],
   allCustomersWithBalance: [],
   dunningPlans: [],
   payments: [],
   users: [],
   priorityChase: [],
   replies: [],
 };

 if (!isConfigured()) {
   empty.lastError = 'UPFLOW_API_KEY / UPFLOW_API_SECRET not set in server/.env - add the credentials and restart the server.';
   _cache = { at: Date.now(), data: empty };
   return empty;
 }

 try {
   const today = new Date();
   const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

   const [invoicesRaw, plansRaw, actionsRaw, paymentsRaw, usersRaw] = await Promise.all([
     fetchAllInvoices(),
     fetchDunningPlans(),
     fetchAllActions(),
     fetchRecentPayments(200),
     fetchUsers(),
   ]);
   // Build customer ID set from both invoice owners AND action senders -
   // replies can come from customers who don't currently have an open invoice
   // (they paid everything but still emailed us back), so we'd lose their
   // directUrl + plan info if we only looked at invoice customers.
   const customerIds = new Set([
     ...invoicesRaw.map((i) => i.customerId),
     ...actionsRaw.map((a) => a.customer?.id).filter((id): id is string => Boolean(id)),
   ]);
   const custMap = await fetchCustomerMap(customerIds);

   const planNameById = new Map(plansRaw.map((p) => [p.id, p.name]));

   // Build invoice list with resolved names + days overdue.
   const invoices: UpflowInvoiceStatus[] = invoicesRaw.map((inv) => {
     const cust = custMap.get(inv.customerId);
     const dueDate = inv.dueDate ? inv.dueDate.slice(0, 10) : '';
     const dueT = inv.dueDate ? new Date(inv.dueDate).getTime() : NaN;
     const daysOverdue = Number.isFinite(dueT)
       ? Math.max(0, Math.floor((todayUtc.getTime() - dueT) / MS_PER_DAY))
       : 0;
     return {
       invoiceNumber: inv.customId ?? inv.externalId ?? inv.id.slice(0, 8),
       customer: cust?.name ?? inv.customerId,
       invoiceAmount: +(inv.grossAmount / 100).toFixed(2),
       outstanding: +(inv.amountOutstanding / 100).toFixed(2),
       issueDate: inv.issuedAt ? inv.issuedAt.slice(0, 10) : '',
       dueDate,
       status: inv.state,
       daysOverdue,
       lastReminderAt: null,           // API doesn't expose per-invoice activity
       reminderCount: 0,
       dunningPlan: inv.dunningPlanId ? planNameById.get(inv.dunningPlanId) ?? '(unknown plan)' : null,
       paymentLink: inv.pdfUrl,
       customerDirectUrl: cust?.directUrl ?? null,
     };
   });

   // Aging buckets from open list (days overdue, not from due date).
   const aging: UpflowAgingBucket[] = [
     { bucket: 'current', invoiceCount: 0, amount: 0 },
     { bucket: '1-30',    invoiceCount: 0, amount: 0 },
     { bucket: '31-60',   invoiceCount: 0, amount: 0 },
     { bucket: '61-90',   invoiceCount: 0, amount: 0 },
     { bucket: '90+',     invoiceCount: 0, amount: 0 },
   ];
   for (const inv of invoices) {
     const d = inv.daysOverdue;
     const b = d === 0 ? aging[0] : d <= 30 ? aging[1] : d <= 60 ? aging[2] : d <= 90 ? aging[3] : aging[4];
     b.invoiceCount += 1;
     b.amount += inv.outstanding;
   }
   for (const b of aging) b.amount = +b.amount.toFixed(2);

   // Customers with balance (use customer.balance directly from Upflow).
   const allCustomersWithBalance: UpflowTopCustomer[] = [...custMap.values()]
     .filter((c) => c.balance > 0)
     .map((c) => ({
       customerId: c.id,
       customer: c.name,
       balance: +(c.balance / 100).toFixed(2),
       openInvoiceCount: c.countInvoicesDue,
       dunningPlan: c.dunningPlanId ? planNameById.get(c.dunningPlanId) ?? '(unknown)' : null,
       dunningPlanId: c.dunningPlanId,
       directUrl: c.directUrl,
     }))
     .sort((a, b) => b.balance - a.balance);
   const topCustomers = allCustomersWithBalance.slice(0, 20);

   // Totals.
   const totalOpenAmount = invoices.reduce((s, i) => s + i.outstanding, 0);
   const overdue = invoices.filter((i) => i.daysOverdue > 0);
   const totalOverdueAmount = overdue.reduce((s, i) => s + i.outstanding, 0);

   // Sort invoices by outstanding desc so the biggest chase candidates surface.
   invoices.sort((a, b) => b.outstanding - a.outstanding);
   // Cap displayed list at 200 (table would otherwise lag with 2000+ rows).
   const displayInvoices = invoices.slice(0, 200);

   // Reminder activity from /v1/actions:
   //   EXECUTED state = the reminder went out (updatedAt = sent time)
   //   TODO state     = queued but not yet fired
   //   IGNORED state  = manually skipped
   const todayStr = todayUtc.toISOString().slice(0, 10);
   const sevenDaysAgoMs = todayUtc.getTime() - 7 * MS_PER_DAY;
   const thirtyDaysAgoMs = todayUtc.getTime() - 30 * MS_PER_DAY;
   let remindersSentToday = 0, remindersSentLast7d = 0, remindersSentLast30d = 0, remindersQueued = 0;
   let repliesPending = 0, repliesHandled = 0, repliesIgnoredNoise = 0;
   const reminderEvents: UpflowReminderEvent[] = [];
   const replies: UpflowReply[] = [];
   // Treat customer rows that look like a system bounce (no-reply@, mail-noreply@,
   // donotreply, etc.) as noise so the UI can de-emphasise them.
   const noiseRx = /^(no[-_]?reply|mail-noreply|donotreply|notifications?)@|@accounts\.google\.com$|@upflow\.io$/i;
   for (const a of actionsRaw) {
     const isReply = a.source === 'REPLY';
     // Workflow-side counters (only count outbound reminders, not replies).
     if (!isReply) {
       if (a.state === 'TODO') remindersQueued += 1;
       if (a.state === 'EXECUTED' && a.updatedAt) {
         const t = new Date(a.updatedAt).getTime();
         if (a.updatedAt.slice(0, 10) === todayStr) remindersSentToday += 1;
         if (t >= sevenDaysAgoMs) remindersSentLast7d += 1;
         if (t >= thirtyDaysAgoMs) remindersSentLast30d += 1;
       }
     } else {
       // Reply-side counters + dedicated list. "noise" = system bounces we
       // never need to respond to (Google / Gmail / Upflow service emails).
       const senderHandle = a.customer?.companyName ?? '';
       const looksLikeNoise = noiseRx.test(senderHandle);
       const replyFrom = a.name?.replace(/^reply to\s+/i, '').trim() || null;
       const receivedAt = a.createdAt;
       const daysSinceReceived = Math.max(0, Math.floor((todayUtc.getTime() - new Date(receivedAt).getTime()) / MS_PER_DAY));
       if (a.state === 'TODO' && !looksLikeNoise) repliesPending += 1;
       if (a.state === 'EXECUTED') repliesHandled += 1;
       if (a.state === 'IGNORED' && looksLikeNoise) repliesIgnoredNoise += 1;
       const cust = a.customer?.id ? custMap.get(a.customer.id) : undefined;
       replies.push({
         id: a.id,
         customer: senderHandle || '-',
         customerId: a.customer?.id ?? null,
         dunningPlanId: cust?.dunningPlanId ?? null,
         invoiceNumber: a.carryingInvoice?.customId ?? a.carryingInvoice?.externalId ?? '-',
         replyFrom,
         receivedAt,
         state: a.state,
         daysSinceReceived,
         assignedTo: (a.assignedTo ?? []).map((u: any) => u.email).filter(Boolean),
         looksLikeNoise,
         upflowUrl: cust?.directUrl ?? null,
       });
     }

     // Combined reminder events list (includes BOTH outbound + inbound for the
     // Reminders tab; client filters by source).
     if (a.state === 'EXECUTED' || a.state === 'TODO') {
       reminderEvents.push({
         invoiceNumber: a.carryingInvoice?.customId ?? a.carryingInvoice?.externalId ?? '-',
         customer: a.customer?.companyName ?? '-',
         sentAt: a.state === 'EXECUTED' ? a.updatedAt : (a.dueDate ?? a.createdAt),
         channel: a.type,
         template: a.name,
         dunningPlan: a.dunningPlan?.name ?? null,
         state: a.state,
         source: isReply ? 'REPLY' : 'WORKFLOW',
         replyFrom: isReply ? (a.name?.replace(/^reply to\s+/i, '').trim() || null) : null,
         assignedTo: (a.assignedTo ?? []).map((u: any) => u.email).filter(Boolean),
       });
     }
   }
   reminderEvents.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
   // Replies: pending first, then by recency.
   replies.sort((a, b) => {
     if (a.state === 'TODO' && b.state !== 'TODO') return -1;
     if (b.state === 'TODO' && a.state !== 'TODO') return 1;
     return b.receivedAt.localeCompare(a.receivedAt);
   });

   // Payments: convert cents → dollars, count last 30 days.
   const payments: UpflowPayment[] = paymentsRaw.map((p) => ({
     id: p.id,
     externalId: p.externalId,
     amount: +(p.amount / 100).toFixed(2),
     currency: p.currency,
     validatedAt: p.validatedAt,
     createdAt: p.createdAt,
     instrument: p.instrument,
     customer: p.customer?.companyName ?? '-',
     linkedInvoiceCount: p.linkedInvoices?.length ?? 0,
   }));
   let paymentsLast30dCount = 0, paymentsLast30dAmount = 0;
   for (const p of payments) {
     const t = new Date(p.validatedAt).getTime();
     if (t >= thirtyDaysAgoMs) { paymentsLast30dCount += 1; paymentsLast30dAmount += p.amount; }
   }

   // Per-plan usage - Upflow attaches plans at CUSTOMER level (not invoice),
   // so invoice.dunningPlanId is null for most rows even when the customer is
   // actively on a plan. We have to look at TWO signals to get an honest count:
   //   1. Customer.dunningPlanId  -> customers currently assigned to this plan
   //   2. Action.dunningPlan.id   -> plans that have actually fired actions
   // We expose both counts so the UI can show "plan X is set on N customers
   // and has fired M actions" - that's the real activity story.
   const planCustomerCount = new Map<string, number>();
   const planActionsCount = new Map<string, number>();
   const planInvoicesViaCustomer = new Map<string, number>();
   for (const c of custMap.values()) {
     if (c.dunningPlanId) {
       planCustomerCount.set(c.dunningPlanId, (planCustomerCount.get(c.dunningPlanId) ?? 0) + 1);
       planInvoicesViaCustomer.set(c.dunningPlanId, (planInvoicesViaCustomer.get(c.dunningPlanId) ?? 0) + c.countInvoicesDue);
     }
   }
   for (const a of actionsRaw) {
     if (a.dunningPlan?.id) planActionsCount.set(a.dunningPlan.id, (planActionsCount.get(a.dunningPlan.id) ?? 0) + 1);
   }
   // Legacy field name kept for compat - now sourced from customer assignment.
   const planUsage = planInvoicesViaCustomer;

   // Users (sales / collection team) - pass through.
   const users: UpflowUser[] = usersRaw.map((u) => ({
     id: u.id,
     firstName: (u.firstName ?? '').trim(),
     lastName: (u.lastName ?? '').trim(),
     email: u.email,
     position: u.position,
   }));

   // === Priority chase list ===
   // For each open invoice we compute a score that captures "this one is
   // bleeding cash the longest with the least recent contact". Components:
   //   base   = outstanding $ × daysOverdue
   //   penalty= if reminded in last 7 days, multiply by 0.4 (don't double-chase)
   //   bonus  = +50% if customer has NO dunning plan set (no automation = needs human)
   //   bonus  = +20% if outstanding >= $10k (whales)
   //
   // Reasons are surfaced so the UI explains why a row ranked high.

   // Build "last EXECUTED reminder per invoice" map for the penalty.
   const lastReminderByInvoice = new Map<string, string>();
   for (const a of actionsRaw) {
     if (a.state !== 'EXECUTED' || !a.updatedAt) continue;
     const invNum = a.carryingInvoice?.customId ?? a.carryingInvoice?.externalId;
     if (!invNum) continue;
     const prev = lastReminderByInvoice.get(invNum);
     if (!prev || a.updatedAt > prev) lastReminderByInvoice.set(invNum, a.updatedAt);
   }

   const sevenDaysMs = 7 * MS_PER_DAY;
   const priorityChase: UpflowPriorityRow[] = invoices
     .filter((inv) => inv.daysOverdue > 0)
     .map((inv) => {
       const lastReminderAt = lastReminderByInvoice.get(inv.invoiceNumber) ?? null;
       const daysSinceLastReminder = lastReminderAt
         ? Math.floor((todayUtc.getTime() - new Date(lastReminderAt).getTime()) / MS_PER_DAY)
         : null;

       let score = inv.outstanding * inv.daysOverdue;
       const reasons: string[] = [];
       reasons.push(`$${Math.round(inv.outstanding).toLocaleString()} × ${inv.daysOverdue}d overdue`);

       if (daysSinceLastReminder !== null && daysSinceLastReminder * MS_PER_DAY <= sevenDaysMs) {
         score *= 0.4;
         reasons.push(`reminded ${daysSinceLastReminder}d ago - lower priority`);
       } else if (daysSinceLastReminder === null) {
         reasons.push('NEVER reminded');
       } else {
         reasons.push(`last reminder ${daysSinceLastReminder}d ago`);
       }

       if (!inv.dunningPlan) {
         score *= 1.5;
         reasons.push('no dunning plan - needs manual chase');
       }
       if (inv.outstanding >= 10000) {
         score *= 1.2;
         reasons.push('whale ($10k+)');
       }

       return {
         invoiceNumber: inv.invoiceNumber,
         customer: inv.customer,
         customerDirectUrl: inv.customerDirectUrl,
         outstanding: inv.outstanding,
         daysOverdue: inv.daysOverdue,
         dunningPlan: inv.dunningPlan,
         lastReminderAt,
         daysSinceLastReminder,
         reasons,
         score: +score.toFixed(0),
       };
     })
     .sort((a, b) => b.score - a.score)
     .slice(0, 15);

   const result: UpflowDashboardResult = {
     fetchedAt: new Date().toISOString(),
     connected: true,
     lastError: null,
     totals: {
       openInvoices: invoices.length,
       openAmount: +totalOpenAmount.toFixed(2),
       overdueInvoices: overdue.length,
       overdueAmount: +totalOverdueAmount.toFixed(2),
       remindersSentToday,
       remindersSentLast7d,
       remindersSentLast30d,
       remindersQueued,
       paymentsLast30dCount,
       paymentsLast30dAmount: +paymentsLast30dAmount.toFixed(2),
       repliesPending,
       repliesHandled,
       repliesIgnoredNoise,
     },
     invoices: displayInvoices,
     reminders: reminderEvents.slice(0, 100),
     aging,
     topCustomers,
     allCustomersWithBalance,
     dunningPlans: plansRaw.map((p) => ({
       id: p.id, name: p.name, mode: p.mode, entity: p.entity,
       invoicesOnPlan: planUsage.get(p.id) ?? 0,
       customersOnPlan: planCustomerCount.get(p.id) ?? 0,
       actionsFired: planActionsCount.get(p.id) ?? 0,
     })),
     payments,
     users,
     priorityChase,
     replies,
   };
   _cache = { at: Date.now(), data: result };
   return result;
 } catch (e) {
   empty.lastError = e instanceof Error ? e.message : 'unknown';
   _cache = { at: Date.now(), data: empty };
   return empty;
 }
}
