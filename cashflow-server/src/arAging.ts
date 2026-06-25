/**
 * AR Aging - Gelato and Non-Gelato receivables aged by invoice date with
 * collection-probability + DSO calculation.
 *
 * Two groups returned separately so the UI can show summary KPIs and let the
 * user expand each group to see invoice detail:
 * - GELATO (Net 97 terms) - Pending batches from Gelato sheet
 * - NON-GELATO (Net 30 terms) - open invoices from Invoice Tracker
 *
 * DSO (Days Sales Outstanding) - DOLLAR-WEIGHTED average days to pay:
 * DSO = Σ(Invoice Amount × Days to Pay) ÷ Σ(Invoice Amount)
 *
 * Where Days to Pay per invoice:
 * - Paid invoice: paid_date − invoice_date
 * - Open invoice: today − invoice_date (still outstanding)
 *
 * This is the methodology the lender sheet uses - every $1 of revenue is
 * weighted by how long it took to convert to cash. More direct than the
 * textbook (AR/Sales)×365 formula because it doesn't depend on an arbitrary
 * sales window and captures the actual collection experience per invoice.
 */

import { getGelatoAr, type GelatoInvoice } from './gelatoAr.js';
import { getInvoiceTracker, type InvoiceRow } from './invoiceTracker.js';
import { channelOf } from './salesByChannel.js';
import { loadBrandEmails, seedFromSheet } from './brandEmails.js';

const NET_GELATO_DAYS = 97; // Net 90 + 7-day buffer
const NET_NONGELATO_DAYS = 30;
const STALE_MONTHS = 12;

export type ArBucket = '0-14' | '15-30' | '31-60' | '61-90' | '90+';
export type ArStatus = 'Open' | 'Overdue';

export type ArAgingInvoice = {
 invoiceNumber: string;
 customer: string;
 channel: string; // resolved channel/brand (Allstar/Jars/Skymint/...)
 description: string;
 issueDate: string;
 amount: number;
 daysOut: number;
 bucket: ArBucket;
 status: ArStatus;
 collectPct: number;
 expectedCollectionAmount: number;
 predWeek: number;
 notes: string;
};

export type ChannelSummary = {
 channel: string; // fuzzy-resolved brand from invoiceTracker.resolveBrand()
 invoiceCount: number;
 gross: number;
 share: number; // % of group's gross AR
 email: string; // brand's AR contact email (from registry, sheet fallback)
};

export type DsoStat = {
 weightedDays: number; // Σ(amount × days_to_pay)
 totalAmount: number; // Σ(amount)
 invoiceCount: number; // contributing rows
 dso: number; // weightedDays ÷ totalAmount
};

/** Customer concentration metrics - credit-risk diagnostics derived from
 *  per-brand AR distribution. Higher concentration = more vulnerable if any
 *  single customer churns or delays payment.
 *  HHI tiers (US DOJ market-concentration thresholds, adapted):
 *    < 1500   → Low concentration (well-diversified AR base)
 *    1500-2500 → Moderate
 *    > 2500   → High (single-customer-risk exposure) */
export type CustomerConcentration = {
 totalAr: number;
 customerCount: number;             // distinct brands with open AR
 topBrand: { name: string; ar: number; share: number } | null;
 top3Share: number;                 // % of total AR from top 3 brands
 top5Share: number;
 top10Share: number;
 hhi: number;                       // Herfindahl-Hirschman Index, 0-10000
 hhiTier: 'Low' | 'Moderate' | 'High';
 paretoCount: number;               // brands needed to cover ≥ 80% of AR
 topBrands: Array<{ brand: string; ar: number; share: number; cumulativeShare: number }>;
};

export type ArAgingGroup = {
 label: 'Gelato' | 'Little Tree';
 netTermsDays: number;
 invoices: ArAgingInvoice[];
 totals: { grossAr: number; expectedCollectible: number; invoiceCount: number };
 bucketSummary: Record<ArBucket, number>;
 channelSummary: ChannelSummary[]; // per-brand/channel breakdown of open AR
 customerConcentration: CustomerConcentration | null;
 // Three DSO views - sheet methodology distinguishes them:
 // paid = "how long it actually took customers to pay" (historical)
 // open = "how long current outstanding has been sitting" (live)
 // combined = both pools merged (overall)
 dsoPaid: DsoStat;
 dsoOpen: DsoStat;
 dsoCombined: DsoStat;
 // Legacy field for back-compat - points to combined DSO.
 dso: number;
};

export type ArAgingResult = {
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

const BUCKET_ORDER: ArBucket[] = ['0-14', '15-30', '31-60', '61-90', '90+'];

function bucketFor(daysOut: number): ArBucket {
 if (daysOut <= 14) return '0-14';
 if (daysOut <= 30) return '15-30';
 if (daysOut <= 60) return '31-60';
 if (daysOut <= 90) return '61-90';
 return '90+';
}

function statusFor(daysOut: number, terms: number): ArStatus {
 return daysOut > terms ? 'Overdue' : 'Open';
}

function predWeekFor(daysOut: number, terms: number): number {
 const daysUntilDue = Math.max(0, terms - daysOut);
 const weeks = Math.ceil(daysUntilDue / 7) || 1;
 return Math.min(13, Math.max(1, weeks));
}

/**
 * Gelato collection % per bucket - Gelato historically pays close to 100%,
 * with some tail risk. Net 97 terms means 0-90 days is "in cycle".
 */
function gelatoCollectPct(bucket: ArBucket): number {
 switch (bucket) {
 case '0-14': return 0.95;
 case '15-30': return 0.95;
 case '31-60': return 0.95;
 case '61-90': return 0.90;
 case '90+': return 0.80;
 }
}

/**
 * Non-Gelato collection % per bucket - Net 30 terms. 0-30 days is in cycle.
 * Beyond 60 days the write-off risk climbs sharply (historical ~89% global
 * collect rate, with the tail concentrated in 60-90 day window).
 */
function nonGelatoCollectPct(bucket: ArBucket): number {
 switch (bucket) {
 case '0-14': return 0.92;
 case '15-30': return 0.92;
 case '31-60': return 0.80;
 case '61-90': return 0.50;
 case '90+': return 0.25;
 }
}

function notesFor(bucket: ArBucket, isGelato: boolean): string {
 if (isGelato) {
 switch (bucket) {
 case '0-14': return 'New Gelato batch - long tail to collection (Net 97).';
 case '15-30': return 'Brand-new in-cycle batch.';
 case '31-60': return 'Mid-cycle batch; expect mid-forecast collection.';
 case '61-90': return 'Late in-cycle. Apply soft collection pressure.';
 case '90+': return 'Past Gelato Net 97. Apply heavy collection pressure.';
 }
 }
 switch (bucket) {
 case '0-14': return 'Recent invoice - in Net 30 cycle.';
 case '15-30': return 'At/near due date. Expect collection imminent.';
 case '31-60': return 'Just past Net 30. Send first reminder.';
 case '61-90': return 'Overdue 30-60 days. Active collection effort needed.';
 case '90+': return 'Severely overdue. High write-off risk.';
 }
}

function ymd(d: Date): string {
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Parse "M/D/YYYY" or "M/D/YY" → Date (UTC). Returns null on parse fail. */
function parseMDYToDate(s: string | null | undefined): Date | null {
 const t = (s ?? '').trim();
 // ISO YYYY-MM-DD (invoiceTracker now normalises XLSX serial dates to this).
 // Without this branch, every paid invoice fails to parse → Paid DSO = 0.
 const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
 // Legacy M/D/YY or M/D/YYYY string form
 const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
 if (!m) return null;
 const yr = m[3].length === 2 ? Number('20' + m[3]) : Number(m[3]);
 return new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2])));
}

function deriveGelatoId(inv: GelatoInvoice): string {
 const m = inv.description.match(/INV\s*#?(\d+)/i);
 if (m) return `GEL-INV-${m[1].padStart(2, '0')}`;
 const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
 const pm = (inv.period ?? '').toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
 if (pm) {
 const monthIdx = monthNames.indexOf(pm[1]);
 const year = Number(pm[2]);
 if (monthIdx >= 0 && year === 2026) {
 return `GEL-INV-${String(monthIdx + 6).padStart(2, '0')}`;
 }
 }
 if (inv.invoiceNumber) return inv.invoiceNumber;
 const p = inv.period.trim().replace(/\s+/g, '-').toUpperCase();
 return `GEL-${p || 'UNK'}`;
}

function parseGelatoIssueDate(inv: GelatoInvoice): Date | null {
 const t = (inv.period ?? '').trim();
 if (!t) return null;
 if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return new Date(t + 'T00:00:00Z');
 const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
 const m = t.toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
 if (m) {
 const batchMonthIdx = monthNames.indexOf(m[1]);
 if (batchMonthIdx >= 0) {
 const year = Number(m[2]);
 const issueMonth = batchMonthIdx + 1;
 if (issueMonth > 11) return new Date(Date.UTC(year + 1, 0, 1));
 return new Date(Date.UTC(year, issueMonth, 1));
 }
 }
 return null;
}

function dueLabel(issue: Date, terms: number): string {
 const due = new Date(issue);
 due.setUTCDate(issue.getUTCDate() + terms);
 const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
 return `${monthNames[due.getUTCMonth()]} ${due.getUTCFullYear()}`;
}

const emptyDso = (): DsoStat => ({ weightedDays: 0, totalAmount: 0, invoiceCount: 0, dso: 0 });

function emptyGroup(label: 'Gelato' | 'Little Tree', terms: number): ArAgingGroup {
 return {
 label,
 netTermsDays: terms,
 invoices: [],
 totals: { grossAr: 0, expectedCollectible: 0, invoiceCount: 0 },
 bucketSummary: { '0-14': 0, '15-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
 channelSummary: [],
 customerConcentration: null,
 dsoPaid: emptyDso(),
 dsoOpen: emptyDso(),
 dsoCombined: emptyDso(),
 dso: 0,
 };
}

function finalizeDso(s: DsoStat): void {
 s.dso = s.totalAmount > 0 ? +(s.weightedDays / s.totalAmount).toFixed(1) : 0;
 s.weightedDays = +s.weightedDays.toFixed(2);
 s.totalAmount = +s.totalAmount.toFixed(2);
}

function finalizeGroup(group: ArAgingGroup): void {
 group.invoices.sort((a, b) => b.daysOut - a.daysOut);
 group.totals.grossAr = +group.invoices.reduce((s, i) => s + i.amount, 0).toFixed(2);
 group.totals.expectedCollectible = +group.invoices.reduce((s, i) => s + i.expectedCollectionAmount, 0).toFixed(2);
 group.totals.invoiceCount = group.invoices.length;
 for (const i of group.invoices) {
 group.bucketSummary[i.bucket] = +(group.bucketSummary[i.bucket] + i.amount).toFixed(2);
 }
 // Per-channel summary - aggregate gross AR + invoice count by channel/brand.
 const byChan = new Map<string, { gross: number; count: number }>();
 for (const i of group.invoices) {
 const c = byChan.get(i.channel) ?? { gross: 0, count: 0 };
 c.gross += i.amount;
 c.count += 1;
 byChan.set(i.channel, c);
 }
 group.channelSummary = [...byChan.entries()]
 .map(([channel, { gross, count }]) => ({
 channel,
 invoiceCount: count,
 gross: +gross.toFixed(2),
 share: group.totals.grossAr > 0 ? +((gross / group.totals.grossAr) * 100).toFixed(1) : 0,
 email: '', // populated in getArAging() from brand-email registry
 }))
 .sort((a, b) => b.gross - a.gross);

 // Customer concentration metrics - only meaningful for Non-Gelato (Gelato is
 // a single-customer pool by definition). For Non-Gelato we compute HHI, top-N
 // shares, and Pareto count from the per-brand channelSummary.
 if (group.label === 'Little Tree' && group.channelSummary.length > 0 && group.totals.grossAr > 0) {
 const total = group.totals.grossAr;
 const ranked = group.channelSummary;
 const shareOfTop = (n: number) => ranked.slice(0, n).reduce((s, c) => s + c.gross, 0) / total * 100;
 // HHI = Σ(share_i²) where share_i is in percent (0-100). Range: 0 - 10000.
 const hhi = ranked.reduce((s, c) => {
 const pct = (c.gross / total) * 100;
 return s + pct * pct;
 }, 0);
 const hhiTier: CustomerConcentration['hhiTier'] = hhi < 1500 ? 'Low' : hhi < 2500 ? 'Moderate' : 'High';
 // Pareto: how many brands needed to reach 80% of AR?
 let cum = 0;
 let paretoCount = ranked.length;
 for (let i = 0; i < ranked.length; i++) {
 cum += ranked[i].gross;
 if (cum / total >= 0.8) { paretoCount = i + 1; break; }
 }
 // Top-10 with cumulative share for display
 let runCum = 0;
 const topBrands = ranked.slice(0, 10).map((c) => {
 runCum += c.gross;
 return {
 brand: c.channel,
 ar: +c.gross.toFixed(2),
 share: +((c.gross / total) * 100).toFixed(1),
 cumulativeShare: +((runCum / total) * 100).toFixed(1),
 };
 });
 group.customerConcentration = {
 totalAr: +total.toFixed(2),
 customerCount: ranked.length,
 topBrand: ranked.length > 0
 ? { name: ranked[0].channel, ar: +ranked[0].gross.toFixed(2), share: +((ranked[0].gross / total) * 100).toFixed(1) }
 : null,
 top3Share: +shareOfTop(3).toFixed(1),
 top5Share: +shareOfTop(5).toFixed(1),
 top10Share: +shareOfTop(10).toFixed(1),
 hhi: +hhi.toFixed(0),
 hhiTier,
 paretoCount,
 topBrands,
 };
 } else {
 group.customerConcentration = null;
 }
 // Combined = paid + open accumulators
 group.dsoCombined.weightedDays = group.dsoPaid.weightedDays + group.dsoOpen.weightedDays;
 group.dsoCombined.totalAmount = group.dsoPaid.totalAmount + group.dsoOpen.totalAmount;
 group.dsoCombined.invoiceCount = group.dsoPaid.invoiceCount + group.dsoOpen.invoiceCount;
 finalizeDso(group.dsoPaid);
 finalizeDso(group.dsoOpen);
 finalizeDso(group.dsoCombined);
 group.dso = group.dsoCombined.dso; // back-compat
}

export async function getArAging(): Promise<ArAgingResult> {
 const warnings: string[] = [];
 const today = new Date();
 const asOfDate = ymd(today);
 const staleCutoff = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - STALE_MONTHS, 1));

 const gelato = emptyGroup('Gelato', NET_GELATO_DAYS);
 const nonGelato = emptyGroup('Little Tree', NET_NONGELATO_DAYS);

 // 1. GELATO - from Gelato AR sheet.
 let sheetUrl = '';
 try {
 const gel = await getGelatoAr();
 sheetUrl = gel.sheetUrl;
 for (const inv of gel.pendingInvoices) {
 const issue = parseGelatoIssueDate(inv);
 if (!issue) {
 warnings.push(`Could not parse Gelato issue date for "${inv.period}" - skipped`);
 continue;
 }
 const daysOut = Math.floor((today.getTime() - issue.getTime()) / (1000 * 60 * 60 * 24));
 const bucket = bucketFor(daysOut);
 const collectPct = gelatoCollectPct(bucket);
 gelato.invoices.push({
 invoiceNumber: deriveGelatoId(inv),
 customer: 'Gelato Innovations',
 channel: 'Gelato',
 description: `${inv.description} (Net ${NET_GELATO_DAYS}, due ~${dueLabel(issue, NET_GELATO_DAYS)})`,
 issueDate: ymd(issue),
 amount: inv.amount,
 daysOut,
 bucket,
 status: statusFor(daysOut, NET_GELATO_DAYS),
 collectPct,
 expectedCollectionAmount: +(inv.amount * collectPct).toFixed(2),
 predWeek: predWeekFor(daysOut, NET_GELATO_DAYS),
 notes: notesFor(bucket, true),
 });
 }
 } catch (e) {
 warnings.push(`Gelato AR fetch failed (${e instanceof Error ? e.message : '?'}).`);
 }

 // 2. NON-GELATO - from Invoice Tracker.
 try {
 const tracker = await getInvoiceTracker();
 for (const inv of tracker.invoices) {
 const open = inv.openBalance;   // = "Money Owed" (AR dashboard source of truth)
 if (open <= 0.01) continue;
 if (open < 200) continue; // skip sub-$200 noise (per user)
 if (/write\s*off/i.test(inv.status)) continue;
 if (channelOf(inv.customer) === 'Gelato') continue;
 if (inv.invoiceDate < staleCutoff) continue;

 const daysOut = Math.floor((today.getTime() - inv.invoiceDate.getTime()) / (1000 * 60 * 60 * 24));
 if (daysOut < 0) continue;
 const bucket = bucketFor(daysOut);
 const collectPct = nonGelatoCollectPct(bucket);
 nonGelato.invoices.push({
 invoiceNumber: inv.invoiceNumber,
 customer: inv.customer,
 channel: inv.brand || '(no brand)',
 description: `${inv.customer} · Inv ${inv.invoiceNumber} (Net ${NET_NONGELATO_DAYS}, due ~${dueLabel(inv.invoiceDate, NET_NONGELATO_DAYS)})`,
 issueDate: ymd(inv.invoiceDate),
 amount: open,
 daysOut,
 bucket,
 status: statusFor(daysOut, NET_NONGELATO_DAYS),
 collectPct,
 expectedCollectionAmount: +(open * collectPct).toFixed(2),
 predWeek: predWeekFor(daysOut, NET_NONGELATO_DAYS),
 notes: notesFor(bucket, false),
 });
 }
 // Dollar-weighted DSO accumulator - separate PAID vs OPEN per sheet
 // methodology. Same formula in both cases, but the population is split
 // so the UI can show both numbers explicitly:
 // Paid DSO = how long customers actually took to pay (historical)
 // Open DSO = how long currently-outstanding AR has been sitting (live)
 // Combined = both pools merged
 for (const inv of tracker.invoices) {
 if (channelOf(inv.customer) === 'Gelato') continue;
 if (inv.invoiceDate < staleCutoff) continue;
 if (inv.amount <= 0) continue;
 if (/write\s*off/i.test(inv.status)) continue;
 const open = +(inv.amount - inv.paid).toFixed(2);
 const paid = parseMDYToDate(inv.paidDate);
 if (open <= 0.01 && paid) {
 // Fully paid - historical days-to-pay
 const days = Math.max(0, Math.floor((paid.getTime() - inv.invoiceDate.getTime()) / (1000 * 60 * 60 * 24)));
 nonGelato.dsoPaid.weightedDays += inv.amount * days;
 nonGelato.dsoPaid.totalAmount += inv.amount;
 nonGelato.dsoPaid.invoiceCount += 1;
 } else if (open > 0.01) {
 // Still open - days outstanding through today, weight by open balance
 const days = Math.max(0, Math.floor((today.getTime() - inv.invoiceDate.getTime()) / (1000 * 60 * 60 * 24)));
 nonGelato.dsoOpen.weightedDays += open * days;
 nonGelato.dsoOpen.totalAmount += open;
 nonGelato.dsoOpen.invoiceCount += 1;
 }
 }
 } catch (e) {
 warnings.push(`Invoice Tracker fetch failed (${e instanceof Error ? e.message : '?'}).`);
 }

 // 3. Gelato - only open Pending batches available. Goes into Open bucket.
 for (const inv of gelato.invoices) {
 gelato.dsoOpen.weightedDays += inv.amount * inv.daysOut;
 gelato.dsoOpen.totalAmount += inv.amount;
 gelato.dsoOpen.invoiceCount += 1;
 }

 finalizeGroup(gelato);
 finalizeGroup(nonGelato);

 // ----- Brand-email registry -----
 // 1. Discover per-brand emails from invoice tracker rows (col 13 fallback).
 // First non-empty email seen for a brand wins.
 // 2. Seed the on-disk registry with discoveries (never overwrites manual edits).
 // 3. Stamp each ChannelSummary entry with the resolved email.
 try {
 const discovered: Record<string, string> = {};
 const tracker = await getInvoiceTracker();
 for (const inv of tracker.invoices) {
 const brand = inv.brand?.trim();
 if (!brand) continue;
 const email = inv.email?.trim();
 if (!email) continue;
 if (!discovered[brand]) discovered[brand] = email;
 }
 if (Object.keys(discovered).length > 0) await seedFromSheet(discovered);
 const registry = await loadBrandEmails();
 for (const group of [gelato, nonGelato]) {
 for (const cs of group.channelSummary) {
 cs.email = registry[cs.channel] ?? '';
 }
 }
 } catch (e) {
 warnings.push(`Brand email registry load failed (${e instanceof Error ? e.message : '?'}).`);
 }

 // Combined across both groups (Gelato + Non-Gelato), paid + open
 const cPaidW = gelato.dsoPaid.weightedDays + nonGelato.dsoPaid.weightedDays;
 const cPaidA = gelato.dsoPaid.totalAmount + nonGelato.dsoPaid.totalAmount;
 const cPaidN = gelato.dsoPaid.invoiceCount + nonGelato.dsoPaid.invoiceCount;
 const cOpenW = gelato.dsoOpen.weightedDays + nonGelato.dsoOpen.weightedDays;
 const cOpenA = gelato.dsoOpen.totalAmount + nonGelato.dsoOpen.totalAmount;
 const cOpenN = gelato.dsoOpen.invoiceCount + nonGelato.dsoOpen.invoiceCount;
 const cAllW = cPaidW + cOpenW;
 const cAllA = cPaidA + cOpenA;
 const cAllN = cPaidN + cOpenN;
 const combined = {
 grossAr: +(gelato.totals.grossAr + nonGelato.totals.grossAr).toFixed(2),
 expectedCollectible: +(gelato.totals.expectedCollectible + nonGelato.totals.expectedCollectible).toFixed(2),
 invoiceCount: gelato.totals.invoiceCount + nonGelato.totals.invoiceCount,
 dsoPaid: {
 weightedDays: +cPaidW.toFixed(2), totalAmount: +cPaidA.toFixed(2), invoiceCount: cPaidN,
 dso: cPaidA > 0 ? +(cPaidW / cPaidA).toFixed(1) : 0,
 },
 dsoOpen: {
 weightedDays: +cOpenW.toFixed(2), totalAmount: +cOpenA.toFixed(2), invoiceCount: cOpenN,
 dso: cOpenA > 0 ? +(cOpenW / cOpenA).toFixed(1) : 0,
 },
 dsoCombined: {
 weightedDays: +cAllW.toFixed(2), totalAmount: +cAllA.toFixed(2), invoiceCount: cAllN,
 dso: cAllA > 0 ? +(cAllW / cAllA).toFixed(1) : 0,
 },
 dso: cAllA > 0 ? +(cAllW / cAllA).toFixed(1) : 0,
 };

 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl,
 asOfDate,
 gelato,
 nonGelato,
 combined,
 warnings,
 };
}

export const AR_BUCKET_ORDER = BUCKET_ORDER;
