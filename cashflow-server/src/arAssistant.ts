/**
 * AR Copilot - a deterministic (no-LLM) question answerer for the AR Dashboard,
 * the sibling of the Cashflow CFO Copilot (assistant.ts).
 *
 * It assembles a live AR snapshot from the SAME backend functions the AR
 * dashboard's numbers reconcile to - open AR (the $556,687 source of truth),
 * aging/DSO, collections history, sales by customer/rep/channel - then routes an
 * English (or Hinglish) question to a deterministic handler that answers ONLY
 * from that snapshot. Every number traces to a real field; nothing is invented.
 */
import { getLittleTreeOpenAr, type ArOpenResult } from './arDashboardOpen.js';
import { getArAging, type ArAgingResult } from './arAging.js';
import { getArStatus, type ArStatusResult } from './arStatus.js';
import { getArCollectionsHistory, type ArCollectionsHistory } from './arCollectionsHistory.js';
import { getSalesByChannel, type SalesByChannelResult } from './salesByChannel.js';
import { getSalesByReps, type SalesByRepsResult } from './salesByReps.js';

export type User = { name?: string; title?: string };

// ── formatting ──────────────────────────────────────────────────────────────
function money(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
}
function pct(x: number): string { return `${Math.round(x * 100)}%`; }
function firstName(u?: User): string { return (u?.name || '').trim().split(/\s+/)[0] || ''; }
/** Normalise a question: lowercased, punctuation→spaces, padded for word match. */
function norm(s: string): string {
  return ' ' + s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

// ── snapshot ────────────────────────────────────────────────────────────────
export type ArSnapshot = {
  asOf: string;
  open: {
    grossAr: number; invoiceCount: number;
    buckets: Record<string, number>;
    segments: { all: number; littleTree: number; infusedOrigin: number };
    overdueAmount: number; overdueCount: number;
    topCustomers: { customer: string; open: number; count: number; oldestDays: number; infusedOrigin: boolean }[];
    invoices: ArOpenResult['invoices'];
  };
  dso: { nonGelato: number | null; gelato: number | null };
  collectible: { nonGelato: number | null; gelato: number | null };
  agingGrossNonGelato: number | null;
  gelato: { grossAr: number; dso: number | null; collectible: number; invoiceCount: number };
  collected: {
    ytd: number; ytdCount: number; thisMonth: number; thisMonthCount: number;
    byMonth: { label: string; amount: number }[];
    ytdFromPriorYear: number;
  };
  recovery: { bucket: string; recovery: number }[];
  dataQuality: { paidMissingDate: number; paidMissingDateCount: number };
  sales: {
    grandTotal: number;
    topCustomers: { customer: string; total: number; count: number; lastMonth: string | null }[];
    cooling: { customer: string; prior3Total: number; lastMonth: string | null }[];
    byRep: { rep: string; total: number; count: number; top: string }[];
    channels: { channel: string; total: number }[];
    yoy: { currYTD: number; prevYTD: number; rate: number; currYear: string; prevYear: string; monthsCompared: number } | null;
    yearly: { year: string; total: number; yoyPct: number | null }[];
  };
  warnings: string[];
};

let snapCache: { at: number; snap: ArSnapshot } | null = null;
const SNAP_TTL_MS = 30 * 1000;

export async function buildArSnapshot(force = false): Promise<ArSnapshot> {
  if (!force && snapCache && Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache.snap;

  const [open, aging, status, hist, channel, reps] = await Promise.all([
    getLittleTreeOpenAr(),
    getArAging().catch(() => null as ArAgingResult | null),
    getArStatus().catch(() => null as ArStatusResult | null),
    getArCollectionsHistory().catch(() => null as ArCollectionsHistory | null),
    getSalesByChannel().catch(() => null as SalesByChannelResult | null),
    getSalesByReps().catch(() => null as SalesByRepsResult | null),
  ]);

  const warnings: string[] = [];

  // Open AR (source of truth) - aggregate invoices into customer rollups.
  const custMap = new Map<string, { customer: string; open: number; count: number; oldestDays: number; infusedOrigin: boolean }>();
  let overdueAmount = 0, overdueCount = 0;
  for (const iv of open.invoices) {
    const c = custMap.get(iv.customer) ?? { customer: iv.customer, open: 0, count: 0, oldestDays: 0, infusedOrigin: iv.infusedOrigin };
    c.open += iv.amount; c.count += 1; c.oldestDays = Math.max(c.oldestDays, iv.daysOut);
    custMap.set(iv.customer, c);
    if (iv.daysOut > 0) { overdueAmount += iv.amount; overdueCount += 1; }
  }
  const topCustomers = [...custMap.values()].sort((a, b) => b.open - a.open)
    .map((c) => ({ ...c, open: +c.open.toFixed(2) }));

  const ng = aging?.nonGelato ?? null;
  const gel = aging?.gelato ?? null;

  const snap: ArSnapshot = {
    asOf: open.asOfDate,
    open: {
      grossAr: open.grossAr,
      invoiceCount: open.invoiceCount,
      buckets: open.buckets,
      segments: open.segments,
      overdueAmount: +overdueAmount.toFixed(2),
      overdueCount,
      topCustomers: topCustomers.slice(0, 25),
      invoices: open.invoices.slice(0, 120),
    },
    dso: { nonGelato: ng?.dso ?? null, gelato: gel?.dso ?? null },
    collectible: { nonGelato: ng?.totals?.expectedCollectible ?? null, gelato: gel?.totals?.expectedCollectible ?? null },
    agingGrossNonGelato: ng?.totals?.grossAr ?? null,
    gelato: {
      grossAr: gel?.totals?.grossAr ?? 0,
      dso: gel?.dso ?? null,
      collectible: gel?.totals?.expectedCollectible ?? 0,
      invoiceCount: gel?.totals?.invoiceCount ?? 0,
    },
    collected: {
      ytd: status?.collectedYtd ?? 0,
      ytdCount: status?.collectedYtdInvoiceCount ?? 0,
      thisMonth: status?.collectedThisMonth ?? 0,
      thisMonthCount: status?.collectedThisMonthInvoiceCount ?? 0,
      byMonth: (status?.collectedByMonth ?? []).map((m) => ({ label: m.label, amount: m.amount })),
      ytdFromPriorYear: status?.ytdFromPriorYearInvoices ?? 0,
    },
    recovery: (hist?.recoveryBands ?? []).map((r) => ({ bucket: r.bucket, recovery: r.recovery })),
    dataQuality: {
      paidMissingDate: status?.paidWithMissingDate ?? 0,
      paidMissingDateCount: status?.paidWithMissingDateCount ?? 0,
    },
    sales: {
      grandTotal: reps?.totals?.grandTotal ?? 0,
      topCustomers: (channel?.topCustomers ?? []).slice(0, 12).map((c) => ({ customer: c.customer, total: c.total, count: c.invoiceCount, lastMonth: c.lastInvoiceMonth })),
      cooling: (channel?.coolingCustomers ?? []).slice(0, 12).map((c) => ({ customer: c.customer, prior3Total: c.prior3Total, lastMonth: c.lastInvoiceMonth })),
      byRep: (reps?.rows ?? []).slice(0, 12).map((r) => ({ rep: r.rep, total: r.total + (r.predictedTotal ?? 0), count: r.invoiceCount, top: r.topCustomers?.[0]?.customer ?? '' })),
      channels: (channel?.rows ?? []).map((r) => ({ channel: r.channel, total: r.total })).filter((c) => c.total > 0).sort((a, b) => b.total - a.total).slice(0, 10),
      yoy: reps?.totals?.yoyTrend ? { currYTD: reps.totals.yoyTrend.currYTD, prevYTD: reps.totals.yoyTrend.prevYTD, rate: reps.totals.yoyTrend.rawRate, currYear: reps.totals.yoyTrend.currYearLabel, prevYear: reps.totals.yoyTrend.prevYearLabel, monthsCompared: reps.totals.yoyTrend.monthsCompared } : null,
      yearly: (reps?.totals?.yearly ?? []).map((y) => ({ year: y.year, total: y.total, yoyPct: y.yoyPct })),
    },
    warnings,
  };

  snapCache = { at: Date.now(), snap };
  return snap;
}

// ── answer types + intents ──────────────────────────────────────────────────
type Answer = { title: string; lines?: string[]; note?: string };
type Intent = {
  id: string;
  phrases: string[];
  keywords: string[];
  handler: (s: ArSnapshot, n: string, user?: User, raw?: string) => Answer;
};

/** Find a customer the question names, by matching tokens against customer names. */
function findCustomer(s: ArSnapshot, n: string): { customer: string; open: number; count: number; oldestDays: number } | null {
  const tokens = n.trim().split(' ').filter((t) => t.length >= 3 && !/^(the|and|for|how|much|does|owe|owes|what|invoice|customer|account|ar)$/.test(t));
  let best: ArSnapshot['open']['topCustomers'][number] | null = null, score = 0;
  for (const c of s.open.topCustomers) {
    const lc = ' ' + c.customer.toLowerCase() + ' ';
    let sc = 0;
    for (const t of tokens) if (lc.includes(t)) sc += t.length;
    if (sc > score) { score = sc; best = c; }
  }
  return score >= 3 ? best : null;
}

const SUGGESTIONS = [
  'How much AR is outstanding?',
  'Who owes us the most?',
  'What is overdue?',
  'What is our DSO?',
  'How much did we collect this month?',
  'Which customers are going quiet?',
];

const INTENTS: Intent[] = [
  {
    id: 'greeting',
    phrases: ['hello', 'hi', 'hey', 'namaste', 'good morning', 'good afternoon', 'good evening', 'yo', 'hallo'],
    keywords: ['hello', 'hi', 'hey'],
    handler: (_s, _n, user) => {
      const fn = firstName(user);
      const h = new Date().getUTCHours() - 4; // ~America/Detroit
      const hr = ((h % 24) + 24) % 24;
      const part = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
      return { title: `${part}${fn ? ', ' + fn : ''}!`, lines: [`I'm your AR copilot - ask me about outstanding money, who to chase, DSO, collections, sales, or any customer.`] };
    },
  },
  {
    id: 'ar_total',
    phrases: ['how much ar', 'how much outstanding', 'total ar', 'total outstanding', 'outstanding ar', 'how much owed', 'how much do we owe', 'how much is owed', 'how much money owed', 'receivable total', 'kitna outstanding', 'kitna paisa baaki', 'kitna lena', 'kitna receivable', 'cash to collect', 'total receivable'],
    keywords: ['outstanding', 'receivable', 'ar'],
    handler: (s) => ({
      title: `Outstanding AR is ${money(s.open.grossAr)} across ${s.open.invoiceCount} open invoices.`,
      lines: [
        `Little Tree: ${money(s.open.segments.littleTree)} · Infused Origin (private label): ${money(s.open.segments.infusedOrigin)}.`,
        `Of that, ${money(s.open.overdueAmount)} is overdue (${s.open.overdueCount} invoices past their due date).`,
        s.gelato.grossAr > 0 ? `Gelato AR is separate: ${money(s.gelato.grossAr)} (${s.gelato.invoiceCount} batches, Net 97).` : '',
      ].filter(Boolean),
      note: `Straight from the Invoice Tracker (Money Owed), same rules as the AR dashboard's Collections page.`,
    }),
  },
  {
    id: 'overdue',
    phrases: ['overdue', 'past due', 'how much overdue', 'kitna overdue', 'late payments', 'past their due', 'how much late', 'overdue amount', 'overdue invoices'],
    keywords: ['overdue', 'late'],
    handler: (s) => ({
      title: `${money(s.open.overdueAmount)} is overdue across ${s.open.overdueCount} invoices.`,
      lines: [
        `That's ${pct(s.open.grossAr > 0 ? s.open.overdueAmount / s.open.grossAr : 0)} of your ${money(s.open.grossAr)} open AR.`,
        `Worst-aged buckets: ${Object.entries(s.open.buckets).filter(([k]) => /61|91|121|180/.test(k)).map(([k, v]) => `${k}d ${money(v)}`).join(' · ')}.`,
      ],
      note: `Aged by days past the due date (Net 30 default), matching the dashboard.`,
    }),
  },
  {
    id: 'aging',
    phrases: ['aging', 'ageing', 'aging buckets', 'how old', 'days past due', 'net 30', 'net 60', 'net 90', '180 days', 'oldest invoices', 'aging breakdown', 'kitne din purana'],
    keywords: ['aging', 'ageing', 'buckets'],
    handler: (s) => ({
      title: `AR aging (by days past due):`,
      lines: Object.entries(s.open.buckets).filter(([, v]) => v > 0).map(([k, v]) => `• ${k === 'Current' ? 'Not yet due' : k + ' days'}: ${money(v)}`),
      note: `${s.dso.nonGelato != null ? `Little Tree DSO is ${Math.round(s.dso.nonGelato)} days. ` : ''}Total open ${money(s.open.grossAr)}.`,
    }),
  },
  {
    id: 'top_defaulters',
    phrases: ['who owes', 'who owes the most', 'biggest debtor', 'top defaulters', 'largest balance', 'who owes us', 'kaun dega', 'kis pe sabse zyada', 'biggest outstanding', 'who has the most', 'top customers owing', 'who to chase', 'who should i chase', 'collect from', 'chase'],
    keywords: ['owes', 'defaulters', 'chase'],
    handler: (s) => {
      const top = s.open.topCustomers.slice(0, 10);
      if (!top.length) return { title: `Nothing outstanding - it's all collected.`, lines: [] };
      return {
        title: `Top customers by outstanding (${money(top.reduce((a, b) => a + b.open, 0))} of ${money(s.open.grossAr)}):`,
        lines: top.map((c, i) => `• ${i + 1}. ${c.customer}: ${money(c.open)} (${c.count} inv${c.oldestDays > 0 ? `, oldest ${c.oldestDays}d past due` : ''})`),
        note: `Chase the biggest + most overdue first. Ask about any customer by name for their invoices.`,
      };
    },
  },
  {
    id: 'dso',
    phrases: ['dso', 'days sales outstanding', 'how long to get paid', 'how fast paid', 'collection days', 'average days to pay', 'payment speed', 'kitne din me paisa'],
    keywords: ['dso'],
    handler: (s) => ({
      title: s.dso.nonGelato != null ? `Little Tree DSO is ${Math.round(s.dso.nonGelato)} days.` : `DSO isn't available right now.`,
      lines: [
        s.dso.nonGelato != null ? `That's how long, dollar-weighted, your wholesale invoices take to get paid (terms are Net 30).` : '',
        s.gelato.dso != null ? `Gelato runs much longer at ${Math.round(s.gelato.dso)} days (Net 97 terms).` : '',
      ].filter(Boolean),
      note: `DSO over Net-30 terms means money is sticking out longer than agreed - the gap is your collections opportunity.`,
    }),
  },
  {
    id: 'collected',
    phrases: ['how much collected', 'collected this month', 'collected this year', 'collections this month', 'collected ytd', 'how much came in', 'kitna collect', 'kitna aaya', 'received this month', 'money received', 'how much did we collect'],
    keywords: ['collected', 'collections'],
    handler: (s) => ({
      title: `Collected ${money(s.collected.thisMonth)} this month and ${money(s.collected.ytd)} year-to-date.`,
      lines: [
        `${s.collected.thisMonthCount} invoices paid this month, ${s.collected.ytdCount} YTD.`,
        s.collected.ytdFromPriorYear > 0 ? `${money(s.collected.ytdFromPriorYear)} of the YTD total was old invoices from prior years finally paid.` : '',
        s.collected.byMonth.length ? `Recent months: ${s.collected.byMonth.slice(-4).map((m) => `${m.label} ${money(m.amount)}`).join(' · ')}.` : '',
      ].filter(Boolean),
      note: `Collections by paid date from the financials sheet.`,
    }),
  },
  {
    id: 'recovery',
    phrases: ['recovery rate', 'how much gets collected', 'collectibility', 'what percent collected', 'do old invoices get paid', 'recovery by age', 'chance of collecting', 'how likely to collect', 'write off rate'],
    keywords: ['recovery', 'collectibility'],
    handler: (s) => {
      if (!s.recovery.length) return { title: `Recovery data isn't available right now.`, lines: [] };
      return {
        title: `How much actually gets collected, by invoice age:`,
        lines: s.recovery.map((r) => `• ${r.bucket}: ${pct(r.recovery)} recovered`),
        note: `Measured from real paid history. Fresh invoices recover near 100%; the older it gets, the less comes back - chase early.`,
      };
    },
  },
  {
    id: 'customer_lookup',
    phrases: ['how much does', 'does owe', 'balance for', 'what does owe', 'customer balance', 'how much owes', 'tell me about customer', 'invoices for', 'account for', 'kitna deta hai', 'ka kitna baaki'],
    keywords: ['customer', 'owes', 'account'],
    handler: (s, n) => {
      const c = findCustomer(s, n);
      if (!c) return { title: `Which customer? Name them and I'll pull their open invoices.`, lines: [`E.g. "how much does Happy Daze owe?"`] };
      const invs = s.open.invoices.filter((iv) => iv.customer === c.customer).sort((a, b) => b.amount - a.amount);
      return {
        title: `${c.customer} owes ${money(c.open)} across ${c.count} open invoice${c.count > 1 ? 's' : ''}${c.oldestDays > 0 ? ` (oldest ${c.oldestDays}d past due)` : ''}.`,
        lines: invs.slice(0, 8).map((iv) => `• #${iv.invoiceNumber}: ${money(iv.amount)} (${iv.daysOut > 0 ? `${iv.daysOut}d overdue` : 'not yet due'})`),
        note: c.oldestDays > 60 ? `Past 60 days - prioritise this one.` : `Tracked from the Invoice Tracker.`,
      };
    },
  },
  {
    id: 'invoice_lookup',
    phrases: ['invoice status', 'status of invoice', 'invoice number', 'specific invoice', 'invoice #', 'check invoice', 'find invoice'],
    keywords: ['invoice'],
    handler: (s, _n, _u, raw) => {
      const m = (raw ?? '').match(/#?\s*(\d{3,6}[a-z]?)/i);
      if (m) {
        const q = m[1].toLowerCase();
        const hit = s.open.invoices.find((iv) => iv.invoiceNumber.toLowerCase().includes(q));
        if (hit) return {
          title: `Invoice #${hit.invoiceNumber} - ${hit.customer}: ${money(hit.amount)} open.`,
          lines: [`${hit.daysOut > 0 ? `${hit.daysOut} days overdue` : 'Not yet due'} · bucket ${hit.bucket} · ${hit.status}.`],
          note: `From the Invoice Tracker.`,
        };
      }
      const top = s.open.invoices.slice(0, 8);
      return { title: `Biggest open invoices:`, lines: top.map((iv) => `• #${iv.invoiceNumber} ${iv.customer}: ${money(iv.amount)} (${iv.daysOut > 0 ? iv.daysOut + 'd overdue' : 'open'})`), note: `Give me an invoice number for a specific one.` };
    },
  },
  {
    id: 'gelato_ar',
    phrases: ['gelato ar', 'gelato outstanding', 'gelato receivable', 'gelato owes', 'gelato money', 'gelato collection', 'how much gelato'],
    keywords: ['gelato'],
    handler: (s) => ({
      title: `Gelato AR is ${money(s.gelato.grossAr)} across ${s.gelato.invoiceCount} batches.`,
      lines: [
        s.gelato.dso != null ? `DSO is ${Math.round(s.gelato.dso)} days - Gelato is on Net 97, so it always runs long.` : '',
        s.gelato.collectible > 0 ? `Expected collectible: ${money(s.gelato.collectible)}.` : '',
      ].filter(Boolean),
      note: `Gelato is a separate book from Little Tree wholesale.`,
    }),
  },
  {
    id: 'sales_top_customers',
    phrases: ['top customers by sales', 'biggest customers', 'who buys the most', 'top buyers', 'best customers', 'largest accounts', 'who orders most', 'top accounts by sales'],
    keywords: ['buyers'],
    handler: (s) => {
      if (!s.sales.topCustomers.length) return { title: `Sales-by-customer data isn't available right now.`, lines: [] };
      return {
        title: `Top customers by sales:`,
        lines: s.sales.topCustomers.slice(0, 10).map((c, i) => `• ${i + 1}. ${c.customer}: ${money(c.total)} (${c.count} inv${c.lastMonth ? `, last ${c.lastMonth}` : ''})`),
        note: `Gross sales over the recent window, from the Invoice Tracker.`,
      };
    },
  },
  {
    id: 'cooling_customers',
    phrases: ['going quiet', 'going silent', 'stopped ordering', 'at risk customers', 'customers leaving', 'churning', 'who stopped buying', 'lost customers', 'cooling', 'who went quiet', 'declining customers'],
    keywords: ['quiet', 'silent', 'churn', 'cooling'],
    handler: (s) => {
      if (!s.sales.cooling.length) return { title: `No customers have gone quiet recently - good sign.`, lines: [] };
      return {
        title: `Customers who were active but went quiet in the last 3 months:`,
        lines: s.sales.cooling.slice(0, 10).map((c) => `• ${c.customer}: was ${money(c.prior3Total)}/3mo, now $0${c.lastMonth ? ` (last order ${c.lastMonth})` : ''}`),
        note: `Win-back targets - they bought before and stopped. Reach out before they're gone for good.`,
      };
    },
  },
  {
    id: 'sales_by_rep',
    phrases: ['sales by rep', 'which rep', 'top rep', 'rep performance', 'who sells most', 'sales per rep', 'rep sales', 'best salesperson', 'sales team', 'rep ranking'],
    keywords: ['rep', 'salesperson'],
    handler: (s) => {
      if (!s.sales.byRep.length) return { title: `Sales-by-rep data isn't available right now.`, lines: [] };
      return {
        title: `Sales by rep:`,
        lines: s.sales.byRep.filter((r) => r.total > 0).slice(0, 10).map((r) => `• ${r.rep}: ${money(r.total)} (${r.count} inv${r.top ? `, top: ${r.top}` : ''})`),
        note: `Confirmed + predicted attribution from the commission sheet.`,
      };
    },
  },
  {
    id: 'data_quality',
    phrases: ['data quality', 'missing dates', 'missing paid date', 'reconciliation', 'data issues', 'data problems', 'sheet errors', 'whats wrong with the data', 'paid without date'],
    keywords: ['reconciliation'],
    handler: (s) => {
      if (s.dataQuality.paidMissingDateCount === 0) return { title: `Data looks clean - no paid invoices missing a date.`, lines: [] };
      return {
        title: `${money(s.dataQuality.paidMissingDate)} was paid but has no paid-date on the sheet (${s.dataQuality.paidMissingDateCount} invoices).`,
        lines: [`These dollars can't be bucketed into a month until a date is filled in - worth a quick clean-up so collections reporting is exact.`],
        note: `From the financials sheet - rows with a paid amount but a blank/unparseable paid date.`,
      };
    },
  },
  {
    // "ye invoice 60+/90+ ho gaya, paisa lo" - aging alert: the SPECIFIC invoices
    // past a threshold that need chasing now (recovery drops the older they get).
    id: 'invoice_aging_alert',
    phrases: ['crossed 60', 'crossed 90', '60 plus', '90 plus', '60 days', '90 days', '120 days', '180 days', 'past 60', 'past 90', 'past due 60', 'most overdue', 'oldest invoices', 'badly overdue', 'really old', 'urgent collection', 'collect now', 'paisa lo', 'what to collect', 'which invoices to collect', 'invoices over 60', 'invoices over 90', 'long overdue', 'kitne purane'],
    keywords: ['urgent'],
    handler: (s, n, _u, raw) => {
      const m = (raw ?? n).match(/(\d{2,3})\s*(?:\+|plus|day|din)/i) || (n).match(/\b(60|90|120|180)\b/);
      const thresh = m ? Math.max(30, Math.min(365, Number(m[1]))) : 60;
      const hits = s.open.invoices.filter((iv) => iv.daysOut >= thresh).sort((a, b) => b.amount - a.amount);
      if (!hits.length) return { title: `Nothing is past ${thresh} days right now - good.`, lines: [`Your oldest open invoice is ${Math.max(0, ...s.open.invoices.map((iv) => iv.daysOut))} days overdue.`] };
      const tot = hits.reduce((a, b) => a + b.amount, 0);
      return {
        title: `${money(tot)} is more than ${thresh} days overdue (${hits.length} invoices) - chase these now:`,
        lines: hits.slice(0, 10).map((iv) => `• #${iv.invoiceNumber} ${iv.customer}: ${money(iv.amount)} (${iv.daysOut}d overdue)`),
        note: `Past ${thresh} days is real write-off risk - recovery keeps dropping the longer it sits. Biggest first = most cash for the calls.`,
      };
    },
  },
  {
    id: 'concentration',
    phrases: ['concentration', 'how concentrated', 'top customers share', 'how much from top', 'customer concentration', 'risk concentration', 'reliant on', 'how dependent', 'biggest exposure'],
    keywords: ['concentration'],
    handler: (s) => {
      const top = s.open.topCustomers, tot = s.open.grossAr;
      if (!top.length || !tot) return { title: `No outstanding AR to analyse.`, lines: [] };
      const top5 = top.slice(0, 5).reduce((a, b) => a + b.open, 0);
      const top10 = top.slice(0, 10).reduce((a, b) => a + b.open, 0);
      return {
        title: `Top 5 customers are ${pct(top5 / tot)} of your AR, top 10 are ${pct(top10 / tot)}.`,
        lines: top.slice(0, 5).map((c, i) => `• ${i + 1}. ${c.customer}: ${money(c.open)} (${pct(c.open / tot)})`),
        note: `The more concentrated, the more one big account slipping hurts. Watch the top names.`,
      };
    },
  },
  {
    id: 'sales_yoy',
    phrases: ['year over year', 'yoy', 'sales growth', 'are sales growing', 'growth rate', 'vs last year', 'compared to last year', 'this year vs last', 'sales trend', 'up or down vs', 'how is growth'],
    keywords: ['yoy', 'growth'],
    handler: (s) => {
      const y = s.sales.yoy;
      if (!y) return { title: `Year-over-year data isn't available right now.`, lines: [] };
      const dir = y.rate >= 0 ? 'up' : 'down';
      return {
        title: `Sales are ${dir} ${pct(Math.abs(y.rate))} year-over-year.`,
        lines: [
          `${y.currYear} ${money(y.currYTD)} vs ${y.prevYear} ${money(y.prevYTD)} (same ${y.monthsCompared} months, apples-to-apples).`,
          ...s.sales.yearly.slice(-4).map((yr) => `• ${yr.year}: ${money(yr.total)}${yr.yoyPct != null ? ` (${yr.yoyPct >= 0 ? '+' : ''}${Math.round(yr.yoyPct)}%)` : ''}`),
        ],
        note: `Compares only the closed months so the current partial month doesn't distort it.`,
      };
    },
  },
  {
    id: 'sales_by_channel',
    phrases: ['by channel', 'sales by channel', 'which channel', 'channel breakdown', 'channels', 'distribution channel', 'sales by brand', 'brand sales', 'brand mix'],
    keywords: ['channel'],
    handler: (s) => {
      if (!s.sales.channels.length) return { title: `Channel data isn't available right now.`, lines: [] };
      const tot = s.sales.channels.reduce((a, b) => a + b.total, 0);
      return {
        title: `Sales by channel:`,
        lines: s.sales.channels.slice(0, 10).map((c) => `• ${c.channel}: ${money(c.total)}${tot ? ` (${pct(c.total / tot)})` : ''}`),
        note: `Gross sales over the recent window, by distribution channel.`,
      };
    },
  },
  {
    id: 'segment',
    phrases: ['private label', 'infused origin', 'little tree vs', 'by segment', 'wholesale vs', 'segment breakdown', 'private label ar', 'how much private label'],
    keywords: ['segment'],
    handler: (s) => ({
      title: `Open AR by segment:`,
      lines: [
        `• Little Tree (wholesale): ${money(s.open.segments.littleTree)}`,
        `• Infused Origin (private label): ${money(s.open.segments.infusedOrigin)}`,
        `• Total: ${money(s.open.segments.all)}`,
      ],
      note: `Private label = customers ticked as Infused Origin in the customer master list.`,
    }),
  },
];

// ── "show me on the dashboard" navigation ────────────────────────────────────
// Each intent maps to the AR Dashboard page it lives on (PAGES key in
// Dashboard.jsx) plus a human "where" hint for the exact tab.
export type ArNavTarget = { page: string; where: string };
const AR_NAV: Record<string, ArNavTarget> = {
  ar_total: { page: 'collections', where: 'Little Tree Accounts Receivable → Action List' },
  overdue: { page: 'collections', where: 'Little Tree AR → Action List' },
  aging: { page: 'collections', where: 'Little Tree AR → Aging tab' },
  top_defaulters: { page: 'collections', where: 'Little Tree AR → Action List' },
  invoice_aging_alert: { page: 'collections', where: 'Little Tree AR → Action List' },
  dso: { page: 'collections', where: 'Little Tree AR → DSO tab' },
  collected: { page: 'collections', where: 'Little Tree AR → Trends tab' },
  recovery: { page: 'collections', where: 'Little Tree AR → Trends tab' },
  customer_lookup: { page: 'customers', where: 'Little Tree Customers → All Customers' },
  invoice_lookup: { page: 'collections', where: 'Little Tree AR → Action List' },
  concentration: { page: 'sales', where: 'Sales → Concentration tab' },
  gelato_ar: { page: 'gelato', where: 'Gelato Accounts Receivable' },
  sales_top_customers: { page: 'sales', where: 'Sales → Overview' },
  sales_by_channel: { page: 'sales', where: 'Sales → Brand Mix' },
  sales_yoy: { page: 'sales', where: 'Sales → Overview' },
  segment: { page: 'sales', where: 'Sales (toggle Little Tree / Infused Origin)' },
  sales_by_rep: { page: 'commission', where: 'Commission' },
  cooling_customers: { page: 'customers', where: 'Little Tree Customers → At-Risk' },
  data_quality: { page: 'collections', where: 'Little Tree AR → Reconciliation tab' },
  ar_briefing: { page: 'overview', where: 'Overview' },
  fallback_briefing: { page: 'overview', where: 'Overview' },
};

function wantsLocation(n: string): boolean {
  return /\b(show me|dikha|dikhao|kaha|kahan|where|take me|open the|on the dashboard|le chalo|le jao|jaao)\b/.test(n);
}

/** The AR briefing: the whole receivables picture in decision terms, 100% from
 *  the snapshot. Reused by the briefing intent and the fallback (no dead-ends). */
function arBriefing(s: ArSnapshot, user?: User): Answer {
  const fn = firstName(user);
  const top = s.open.topCustomers[0];
  return {
    title: `${fn ? fn + ', ' : ''}you're owed ${money(s.open.grossAr)} across ${s.open.invoiceCount} invoices - ${money(s.open.overdueAmount)} of it overdue.`,
    lines: [
      `Collected ${money(s.collected.thisMonth)} this month, ${money(s.collected.ytd)} YTD.`,
      s.dso.nonGelato != null ? `DSO ${Math.round(s.dso.nonGelato)} days (Net 30 terms - you're carrying it longer than agreed).` : '',
      top ? `Biggest to chase: ${top.customer} at ${money(top.open)}${top.oldestDays > 0 ? ` (${top.oldestDays}d overdue)` : ''}.` : '',
      s.gelato.grossAr > 0 ? `Gelato AR (separate): ${money(s.gelato.grossAr)} at ${s.gelato.dso != null ? Math.round(s.gelato.dso) + 'd DSO' : 'Net 97'}.` : '',
      `DO THIS: chase the overdue first - ask "who owes the most" or a customer by name.`,
    ].filter(Boolean),
    note: `Live from the AR dashboard's data - open AR, aging, collections and sales. Ask anything specific.`,
  };
}

export type ArAssistantAnswer = { intent: string; confidence: number; title: string; lines: string[]; note?: string; nav?: ArNavTarget; suggestions?: string[] };

export function routeArQuestion(snap: ArSnapshot, question: string, user?: User): ArAssistantAnswer {
  const n = norm(question);
  let best: Intent | null = null, bestScore = 0;
  for (const intent of INTENTS) {
    let score = 0;
    for (const p of intent.phrases) if (n.includes(p)) score += 5 + p.length * 0.15;
    for (const k of intent.keywords) if (n.includes(' ' + k + ' ')) score += 2;
    if (score > bestScore) { bestScore = score; best = intent; }
  }

  // Briefing / health questions, and anything unmatched, go to the AR briefing -
  // a grounded answer instead of a dead-end.
  const wantsBriefing = /\b(how are we|how is ar|overall|summary|big picture|bottom line|should i worry|health|whats important|what should i do|brief|sab theek|kaisa)\b/.test(n);
  if (wantsBriefing || !best || bestScore < 2) {
    const id = wantsBriefing ? 'ar_briefing' : 'fallback_briefing';
    const b = arBriefing(snap, user);
    const nav = AR_NAV[id];
    const lines = (wantsLocation(n) && nav) ? [`📍 On the dashboard: ${nav.where}.`, ...(b.lines ?? [])] : (b.lines ?? []);
    return { intent: id, confidence: wantsBriefing ? 0.8 : 0.4, title: b.title, lines, note: b.note, nav, suggestions: SUGGESTIONS.slice(0, 4) };
  }

  let ans: Answer;
  try { ans = best.handler(snap, n, user, question); }
  catch (e) { ans = { title: `I hit a snag reading that.`, lines: [`The data may still be loading - give it a moment and ask again.`], note: e instanceof Error ? e.message : undefined }; }
  const nav = AR_NAV[best.id];
  let lines = ans.lines ?? [];
  if (wantsLocation(n) && nav) lines = [`📍 On the dashboard: ${nav.where}.`, ...lines];
  const suggestions = SUGGESTIONS.filter((x) => norm(x).indexOf(best!.id.split('_')[0]) === -1).slice(0, 4);
  return { intent: best.id, confidence: Math.min(1, bestScore / 10), title: ans.title, lines, note: ans.note, nav, suggestions };
}

export async function askArAssistant(question: string, user?: User): Promise<ArAssistantAnswer & { asOf: string }> {
  const snap = await buildArSnapshot();
  const result = routeArQuestion(snap, question, user);
  return { ...result, asOf: snap.asOf };
}
