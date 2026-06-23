/**
 * Intuit CommerceNetwork share-link scraper.
 *
 * The Invoice Tracker sheet has a "Link" column with URLs like
 *   https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-<token>?...
 *
 * Each of these is a public Pure X LLC invoice view page (no auth needed).
 * The page is a Next.js app whose <script id="__NEXT_DATA__"> embeds the
 * full invoice JSON. We fetch the HTML, parse out __NEXT_DATA__, and pull:
 *   - contact.displayName  → "AU-P-000566 (Mitten Distro X LLC)"  (BILL TO)
 *   - referenceNumber      → "9808a"                              (invoice #)
 *   - txnDate              → "02-14-2025"                         (MM-DD-YYYY)
 *   - amount               → 13250                                (total $)
 *   - lines[]              → SalesItemLineDetail rows
 *      • description       → "Red Razz"        (SKU-level name)
 *      • item.name         → "Edible:Little Tree Distillate Gummies" (category)
 *      • quantity          → 1400
 *      • rate.moneyValue   → 1
 *      • amount            → 1400
 *
 * Shipping & tax are SEPARATE fields on the sale, not in lines[]. We still
 * filter lines whose description matches /shipping|tax/i defensively, since
 * some invoices include shipping as a sales line.
 *
 * Results are persisted to .invoice-scrape-cache.json keyed by share token,
 * so re-scrapes are essentially free.
 */

import { fileStore as fs } from './kvStore.js';

const CACHE_FILE = '.invoice-scrape-cache.json';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

export type ScrapedLine = {
 description: string;
 itemName: string;       // category (e.g. "Edible:Little Tree Distillate Gummies")
 quantity: number;
 unitPrice: number;
 amount: number;
};

export type ScrapedInvoice = {
 token: string;                 // scs-v1-<...>
 url: string;
 referenceNumber: string;       // e.g. "9808a"
 customerDisplay: string;       // e.g. "AU-P-000566 (Mitten Distro X LLC)"
 customerAuNumber: string;      // e.g. "AU-P-000566"
 customerName: string;          // e.g. "Mitten Distro X LLC"
 txnDate: string;               // YYYY-MM-DD (normalised from MM-DD-YYYY)
 amount: number;                // total $
 lines: ScrapedLine[];          // PRODUCT lines only (shipping/tax removed)
 scrapedAt: string;             // ISO
};

type CacheFile = {
 version: 1;
 byToken: Record<string, ScrapedInvoice>;
 failures: Record<string, { lastTriedAt: string; error: string }>;
};

let cache: CacheFile | null = null;

async function loadCache(): Promise<CacheFile> {
 if (cache) return cache;
 try {
  const raw = await fs.readFile(CACHE_FILE, 'utf8');
  cache = JSON.parse(raw) as CacheFile;
  if (!cache.byToken) cache = { version: 1, byToken: {}, failures: {} };
  if (!cache.failures) cache.failures = {};
  return cache;
 } catch {
  cache = { version: 1, byToken: {}, failures: {} };
  return cache;
 }
}

async function saveCache(): Promise<void> {
 if (!cache) return;
 await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

export function invalidateScraperCache(): void { cache = null; }

// --- Helpers ---

function extractToken(url: string): string | null {
 const m = url.match(/scs-v1-[a-z0-9]+/i);
 return m ? m[0] : null;
}

/** Parse "AU-P-000566 (Mitten Distro X LLC)" → { au, name }. */
function splitCustomer(display: string): { au: string; name: string } {
 const m = display.match(/^(AU-[A-Z]-\d+)\s*\(([^)]+)\)\s*$/);
 if (m) return { au: m[1], name: m[2].trim() };
 // Fallback: maybe just AU number, or just name.
 const auOnly = display.match(/^(AU-[A-Z]-\d+)\s*$/);
 if (auOnly) return { au: auOnly[1], name: '' };
 return { au: '', name: display };
}

/** Normalise QB "MM-DD-YYYY" → "YYYY-MM-DD". */
function normaliseDate(s: string): string {
 if (!s) return '';
 const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
 if (m) return `${m[3]}-${m[1]}-${m[2]}`;
 // Already ISO?
 if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
 return s;
}

const SKIP_LINE_RE = /^(shipping|freight|tax|sales\s*tax|discount|subtotal)\b/i;

function parseNextData(html: string): unknown | null {
 const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
 if (!m) return null;
 try { return JSON.parse(m[1]); } catch { return null; }
}

// --- Public API ---

/**
 * Scrape a single share URL. Returns cached value if already fetched
 * (unless `refresh: true`). Returns null on persistent failure (cached).
 */
export async function scrapeShareInvoice(url: string, opts: { refresh?: boolean } = {}): Promise<ScrapedInvoice | null> {
 const token = extractToken(url);
 if (!token) throw new Error(`URL has no scs-v1 token: ${url}`);
 const c = await loadCache();
 if (!opts.refresh && c.byToken[token]) return c.byToken[token];

 try {
  const res = await fetch(url, {
   redirect: 'follow',
   headers: {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
   },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const data = parseNextData(html) as Record<string, unknown> | null;
  if (!data) throw new Error('__NEXT_DATA__ not found');

  // Walk into props.initialReduxState.sale
  const props = (data as { props?: { initialReduxState?: { sale?: unknown } } }).props;
  const sale = props?.initialReduxState?.sale as Record<string, unknown> | undefined;
  if (!sale) throw new Error('sale state missing');

  const contact = sale.contact as { displayName?: string } | undefined;
  const display = contact?.displayName ?? '';
  const { au, name } = splitCustomer(display);
  const referenceNumber = String(sale.referenceNumber ?? '');
  const amount = Number(sale.amount ?? 0);
  const txnDate = normaliseDate(String(sale.txnDate ?? ''));

  const rawLines = (sale.lines as Array<Record<string, unknown>>) ?? [];
  const lines: ScrapedLine[] = [];
  for (const ln of rawLines) {
   if (ln.type !== 'SalesItemLineDetail') continue;
   const description = String(ln.description ?? '').trim();
   if (!description) continue;
   if (SKIP_LINE_RE.test(description)) continue;
   const itemObj = ln.item as { name?: string } | undefined;
   const itemName = String(itemObj?.name ?? '').trim();
   if (SKIP_LINE_RE.test(itemName)) continue;
   const quantity = Number(ln.quantity ?? 0);
   const rateObj = ln.rate as { moneyValue?: number } | undefined;
   const unitPrice = Number(rateObj?.moneyValue ?? (quantity > 0 ? (Number(ln.amount ?? 0) / quantity) : 0));
   const amt = Number(ln.amount ?? 0);
   if (amt <= 0 && quantity <= 0) continue;
   lines.push({ description, itemName, quantity, unitPrice, amount: amt });
  }

  const parsed: ScrapedInvoice = {
   token,
   url,
   referenceNumber,
   customerDisplay: display,
   customerAuNumber: au,
   customerName: name,
   txnDate,
   amount,
   lines,
   scrapedAt: new Date().toISOString(),
  };
  c.byToken[token] = parsed;
  delete c.failures[token];
  await saveCache();
  return parsed;
 } catch (e) {
  c.failures[token] = { lastTriedAt: new Date().toISOString(), error: e instanceof Error ? e.message : String(e) };
  await saveCache();
  return null;
 }
}

/**
 * Scrape multiple URLs with concurrency limit. Uses cached values where
 * available. Returns parsed invoices in input order (with nulls for failures).
 */
export async function scrapeShareInvoices(urls: string[], opts: { refresh?: boolean; concurrency?: number } = {}): Promise<Array<ScrapedInvoice | null>> {
 const concurrency = opts.concurrency ?? 6;
 const results: Array<ScrapedInvoice | null> = new Array(urls.length).fill(null);
 let next = 0;
 async function worker(): Promise<void> {
  while (true) {
   const idx = next++;
   if (idx >= urls.length) return;
   const url = urls[idx];
   try { results[idx] = await scrapeShareInvoice(url, { refresh: opts.refresh }); }
   catch { results[idx] = null; }
  }
 }
 await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
 return results;
}

export async function getScrapeStats(): Promise<{ cached: number; failed: number; failures: Array<{ token: string; error: string; lastTriedAt: string }> }> {
 const c = await loadCache();
 return {
  cached: Object.keys(c.byToken).length,
  failed: Object.keys(c.failures).length,
  failures: Object.entries(c.failures).map(([token, v]) => ({ token, error: v.error, lastTriedAt: v.lastTriedAt })),
 };
}
