/**
 * Bill-date resolver.
 *
 * The TRUE invoice date is the one printed on the actual QuickBooks bill - NOT
 * the date typed into the Invoice Tracker / LT Financials sheets, which is
 * frequently off by 1-3 days (verified: ~50% of sampled invoices differ, some
 * by enough to land in a different week). Each Invoice Tracker row carries a
 * cell-level hyperlink (col J) to the bill's Intuit CommerceNetwork share page;
 * that page embeds the real invoice date as JSON: ...{"Date":"MM-DD-YYYY",
 * "type":"INVOICE",...}.
 *
 * This module fetches those pages once per invoice, extracts the bill date, and
 * caches the {invoiceNumber -> YYYY-MM-DD} map durably in Supabase (bill dates
 * are immutable, so we never re-fetch a known one). Used to bucket sales into
 * the correct week for the 13-week cashflow + sales forecast.
 */

import { getInvoiceTracker } from './invoiceTracker.js';
import { dbSelectOne, dbUpsert } from './db.js';

const CACHE_KEY = 'bill-dates-v1';
const CONCURRENCY = 16;

/** Pull the INVOICE date out of an Intuit CommerceNetwork share page. The page
 *  embeds the transaction as JSON; we prefer the Date tied to type INVOICE. */
export function extractBillDate(html: string): string | null {
 let m = html.match(/"Date"\s*:\s*"(\d{2})-(\d{2})-(\d{4})"\s*,\s*"type"\s*:\s*"INVOICE"/i);
 if (!m) m = html.match(/"type"\s*:\s*"INVOICE"\s*,[^}]*?"Date"\s*:\s*"(\d{2})-(\d{2})-(\d{4})"/i);
 if (!m) m = html.match(/"(?:txnDate|Date)"\s*:\s*"(\d{2})-(\d{2})-(\d{4})"/i);
 if (!m) return null;
 return `${m[3]}-${m[1]}-${m[2]}`; // MM-DD-YYYY -> YYYY-MM-DD
}

const key = (invoiceNumber: string) => invoiceNumber.trim().toLowerCase();

let _mem: { at: number; map: Map<string, string> } | null = null;
const MEM_TTL_MS = 5 * 60 * 1000;

async function loadCache(): Promise<Record<string, string>> {
 try {
  const row = await dbSelectOne<{ data: Record<string, string> }>('qb_cache', `key=eq.${CACHE_KEY}`);
  return row?.data ?? {};
 } catch {
  return {};
 }
}

/**
 * Resolve the {invoiceNumber -> bill date} map. Reads the durable cache, then
 * fetches any linked invoices not yet cached (up to `maxFetch`, default all),
 * extracts their bill date, and persists the enlarged map. Subsequent calls are
 * cache hits. Pass `maxFetch` to bound a single request's fetch budget and let
 * the cache fill incrementally across calls.
 */
export async function getBillDates(opts: { maxFetch?: number; force?: boolean } = {}): Promise<Map<string, string>> {
 if (!opts.force && _mem && Date.now() - _mem.at < MEM_TTL_MS) return _mem.map;

 const [tracker, cached] = await Promise.all([getInvoiceTracker(), loadCache()]);
 const map = new Map<string, string>(Object.entries(cached));

 const todo = tracker.invoices.filter((i) => i.link && !map.has(key(i.invoiceNumber)));
 const batch = opts.maxFetch != null ? todo.slice(0, opts.maxFetch) : todo;

 let idx = 0;
 let fetched = 0;
 async function worker(): Promise<void> {
  while (idx < batch.length) {
   const inv = batch[idx++];
   try {
    const res = await fetch(inv.link, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) continue;
    const html = await res.text();
    const d = extractBillDate(html);
    if (d) { map.set(key(inv.invoiceNumber), d); fetched++; }
   } catch {
    /* skip - leave uncached so a later run retries it */
   }
  }
 }
 await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

 if (fetched > 0) {
  void dbUpsert('qb_cache', { key: CACHE_KEY, data: Object.fromEntries(map), updated_at: new Date().toISOString() }).catch(() => {});
 }
 _mem = { at: Date.now(), map };
 return map;
}

/** Stats for monitoring: how much of the linked-invoice universe is cached. */
export async function getBillDatesCoverage(): Promise<{ cached: number; linked: number; total: number }> {
 const [tracker, cached] = await Promise.all([getInvoiceTracker(), loadCache()]);
 const linked = tracker.invoices.filter((i) => i.link).length;
 return { cached: Object.keys(cached).length, linked, total: tracker.invoices.length };
}
