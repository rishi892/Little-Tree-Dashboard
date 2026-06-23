/**
 * Empirical AR collection curve - derived purely from the Invoice Tracker's
 * PAID history. Answers, in plain numbers, "for a typical invoice, what share
 * of the money lands in week 1, week 2, ... after it's issued?".
 *
 * This is the transparency layer behind the 13-week AR + sales-forecast rows:
 * those projections distribute open / new invoices across weeks using each
 * customer's / brand's historical pay-day timing; this endpoint surfaces the
 * overall pattern the model is grounded in, so the cashflow has clarity.
 */

import { getInvoiceTracker } from './invoiceTracker.js';

const WEEKS = 13;
const MS_PER_DAY = 86_400_000;

export type CollectionCurveSegment = {
 label: string; // 'All', 'Little Tree (non-Gelato)', 'Gelato'
 sampleCount: number; // paid invoices used
 totalPaid: number; // $ behind the curve
 medianDays: number; // median days-to-pay
 cumPct: number[]; // cumulative % of $ collected by END of each week (len = WEEKS)
 incPct: number[]; // incremental % collected IN each week (len = WEEKS)
 beyondPct: number; // % collected after week 13
};

export type CollectionCurveResult = {
 fetchedAt: string;
 weeks: number;
 segments: CollectionCurveSegment[];
};

function parseAnyDate(s: string): Date | null {
 if (!s) return null;
 const str = String(s).trim();
 let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
 if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
 m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(str);
 if (m) {
 let y = +m[3];
 if (y < 100) y += 2000;
 return new Date(Date.UTC(y, +m[1] - 1, +m[2]));
 }
 const d = new Date(str);
 return Number.isNaN(+d) ? null : d;
}

function buildSegment(
 label: string,
 rows: Array<{ invoiceDate: Date; paidDate: string; paid: number }>,
): CollectionCurveSegment {
 const lags: Array<{ lag: number; amt: number }> = [];
 let totalPaid = 0;
 for (const r of rows) {
 if (!(r.paid > 0)) continue;
 const pd = parseAnyDate(r.paidDate);
 if (!pd || !(r.invoiceDate instanceof Date) || Number.isNaN(+r.invoiceDate)) continue;
 const lag = Math.max(0, Math.round((+pd - +r.invoiceDate) / MS_PER_DAY));
 lags.push({ lag, amt: r.paid });
 totalPaid += r.paid;
 }
 if (lags.length === 0 || totalPaid <= 0) {
 return { label, sampleCount: 0, totalPaid: 0, medianDays: 0, cumPct: new Array(WEEKS).fill(0), incPct: new Array(WEEKS).fill(0), beyondPct: 0 };
 }
 const cumPct: number[] = [];
 for (let w = 1; w <= WEEKS; w++) {
 const cut = w * 7;
 const got = lags.filter((x) => x.lag <= cut).reduce((s, x) => s + x.amt, 0);
 cumPct.push(+((got / totalPaid) * 100).toFixed(1));
 }
 const incPct = cumPct.map((v, i) => (i === 0 ? v : +(v - cumPct[i - 1]).toFixed(1)));
 const beyondPct = +(100 - cumPct[WEEKS - 1]).toFixed(1);
 lags.sort((a, b) => a.lag - b.lag);
 const medianDays = lags[Math.floor(lags.length / 2)].lag;
 return { label, sampleCount: lags.length, totalPaid: +totalPaid.toFixed(2), medianDays, cumPct, incPct, beyondPct };
}

export async function getCollectionCurve(): Promise<CollectionCurveResult> {
 const t = await getInvoiceTracker();
 const all = t.invoices;
 const nonGelato = all.filter((r) => !/gelato/i.test(r.customer));
 const gelato = all.filter((r) => /gelato/i.test(r.customer));
 return {
 fetchedAt: new Date().toISOString(),
 weeks: WEEKS,
 segments: [
 buildSegment('Little Tree (non-Gelato)', nonGelato),
 buildSegment('All invoices', all),
 buildSegment('Gelato', gelato),
 ],
 };
}
