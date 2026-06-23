/**
 * Sales by Product - aggregates line items from the actual Pure X LLC
 * customer invoices (the ones shown to the buyer on the Intuit share URL).
 *
 * Data source: Invoice Tracker sheet's "Link" column. Each populated link
 * points to an Intuit CommerceNetwork share page whose embedded JSON has the
 * full line-item detail (description, qty, rate, amount). We scrape each
 * page once and cache to disk - subsequent reads are essentially free.
 *
 * Window: 2025-01-01 → today (matches the rest of the dashboard's data
 * floor).
 *
 * What we extract per invoice:
 *   - BILL TO  → contact.displayName = "AU-P-000566 (Mitten Distro X LLC)"
 *   - Line items, filtering out Shipping / Freight / Tax / Discount
 *   - Aggregated by description (flavour / SKU-level name on the invoice)
 *
 * Status fields surfaced so the UI can show scrape progress:
 *   - inWindow      : invoices in the sheet 2025+ that have a Link
 *   - scraped       : successfully parsed
 *   - missingLinks  : 2025+ invoices in sheet with NO link populated
 *   - failures      : tokens we tried but couldn't parse
 */

import { getInvoiceTracker } from './invoiceTracker.js';
import { scrapeShareInvoices, getScrapeStats, invalidateScraperCache, type ScrapedInvoice } from './invoiceScraper.js';
import { mapInvoiceLineToCogs, invalidateCogsMapperCache } from './cogsMapper.js';

const WINDOW_START = '2025-01-01';

export type ProductCustomerBreakdown = {
 customer: string;          // "AU-P-000566 (Mitten Distro X LLC)"
 customerAu: string;        // "AU-P-000566"
 customerName: string;      // "Mitten Distro X LLC"
 qty: number;
 revenue: number;
 invoiceCount: number;
};

export type ProductMonthlyPoint = {
 ym: string;
 qty: number;
 revenue: number;
};

export type ProductRow = {
 product: string;                 // description from the invoice line
 itemCategory: string;            // QB item.name (e.g. "Edible:Little Tree Distillate Gummies")
 totalQty: number;
 totalRevenue: number;
 invoiceCount: number;
 avgUnitPrice: number;
 firstSold: string;               // YYYY-MM-DD
 lastSold: string;                // YYYY-MM-DD
 uniqueCustomers: number;
 topCustomer: { name: string; au: string; share: number } | null;
 customers: ProductCustomerBreakdown[];   // desc by revenue
 monthly: ProductMonthlyPoint[];          // asc by ym
};

export type SalesByProductResult = {
 asOf: string;
 windowStart: string;
 windowEnd: string;               // today (YYYY-MM-DD)
 status: {
  /** Sheet rows in window that have a Link populated. */
  inWindowWithLink: number;
  /** Successfully scraped invoices that contributed line items. */
  scraped: number;
  /** Sheet rows in window where the Link column is empty - we have no
   *  way to get their line items. The user fills these in by hand. */
  missingLinks: number;
  /** Tokens we tried to scrape but failed (network error, parse error). */
  failed: number;
  failures: Array<{ token: string; error: string; lastTriedAt: string }>;
 };
 cogsMapping: {
  /** Line items resolved to a catalog entry. */
  mappedLines: number;
  /** Line items that fell back to "<category> - <flavor>" (no catalog match). */
  unmappedLines: number;
  /** Sample of unmapped product labels (so user can spot gaps in catalog). */
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

let _cache: { at: number; data: SalesByProductResult } | null = null;
let _inFlight: Promise<SalesByProductResult> | null = null;
const _TTL_MS = 30 * 60 * 1000;

export function invalidateSalesByProductCache(): void {
 _cache = null;
 invalidateScraperCache();
 invalidateCogsMapperCache();
}

function ym(date: string): string { return date.slice(0, 7); }
function todayYmd(): string {
 const d = new Date();
 return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function getSalesByProduct(opts: { refresh?: boolean } = {}): Promise<SalesByProductResult> {
 if (!opts.refresh && _cache && Date.now() - _cache.at < _TTL_MS) return _cache.data;
 if (_inFlight) return _inFlight;
 _inFlight = (async () => {
  try { return await _compute(opts.refresh ?? false); }
  finally { _inFlight = null; }
 })();
 return _inFlight;
}

async function _compute(refresh: boolean): Promise<SalesByProductResult> {
 const warnings: string[] = [];
 const tracker = await getInvoiceTracker();
 const windowStart = new Date(WINDOW_START + 'T00:00:00Z');
 // Filter sheet rows: 2025+ only, exclude write-offs.
 const inWindow = tracker.invoices.filter((r) =>
  r.invoiceDate >= windowStart && !/write\s*off/i.test(r.status)
 );
 const withLink = inWindow.filter((r) => /^https?:\/\//i.test(r.link));
 const missingLinks = inWindow.length - withLink.length;

 const urls = withLink.map((r) => r.link);
 const scraped = await scrapeShareInvoices(urls, { refresh, concurrency: 6 });

 type Accum = {
  product: string;
  itemCategory: string;
  totalQty: number;
  totalRevenue: number;
  unitPriceSamples: Array<{ price: number; weight: number }>;
  firstSold: string;
  lastSold: string;
  byCustomer: Map<string, { qty: number; revenue: number; invoiceIds: Set<string>; customerAu: string; customerName: string }>;
  byMonth: Map<string, { qty: number; revenue: number }>;
  invoiceTokens: Set<string>;
 };

 const accum = new Map<string, Accum>();
 let lineItemCount = 0;
 let totalRevenue = 0;
 let scrapedCount = 0;
 const allCustomers = new Set<string>();

 // Normalise / display helpers for the fallback (unmatched) case.
 function cleanCategory(itemName: string): string {
  return itemName.replace(/^[A-Za-z]+:/, '').trim();
 }
 function titleCaseFlavor(desc: string): string {
  const trimmed = desc.replace(/\s+/g, ' ').trim();
  if (trimmed.length > 30 || /\d/.test(trimmed) || /-/.test(trimmed)) return trimmed;
  return trimmed.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
 }

 // Map every distinct (itemName, description) tuple to its COGS catalog
 // name in one pass before bucketing - much faster than re-mapping per line.
 const distinctPairs = new Map<string, { itemName: string; description: string }>();
 for (const inv of scraped) {
  if (!inv) continue;
  for (const ln of inv.lines) {
   const k = `${ln.itemName}||${ln.description}`;
   if (!distinctPairs.has(k)) distinctPairs.set(k, { itemName: ln.itemName, description: ln.description });
  }
 }
 const pairToCogs = new Map<string, { cogsName: string | null; score: number }>();
 for (const [k, p] of distinctPairs) {
  const r = await mapInvoiceLineToCogs(p.itemName, p.description);
  pairToCogs.set(k, { cogsName: r.cogsName, score: r.score });
 }

 let mappedLineCount = 0;
 let unmappedLineCount = 0;
 const unmappedLabels = new Set<string>();

 for (const inv of scraped) {
  if (!inv) continue;
  scrapedCount++;
  const customerKey = inv.customerDisplay || inv.customerName || '(unknown)';
  allCustomers.add(customerKey);
  for (const ln of inv.lines) {
   lineItemCount++;
   totalRevenue += ln.amount;
   const pairKey = `${ln.itemName}||${ln.description}`;
   const map = pairToCogs.get(pairKey);
   let productLabel: string;
   if (map && map.cogsName) {
    productLabel = map.cogsName;
    mappedLineCount++;
   } else {
    const cat = cleanCategory(ln.itemName);
    const fl = titleCaseFlavor(ln.description);
    productLabel = cat ? `${cat} - ${fl}` : fl;
    unmappedLineCount++;
    unmappedLabels.add(productLabel);
   }
   const key = productLabel.toLowerCase();
   let row = accum.get(key);
   if (!row) {
    row = {
     product: productLabel,
     itemCategory: cleanCategory(ln.itemName),
     totalQty: 0,
     totalRevenue: 0,
     unitPriceSamples: [],
     firstSold: inv.txnDate,
     lastSold: inv.txnDate,
     byCustomer: new Map(),
     byMonth: new Map(),
     invoiceTokens: new Set(),
    };
    accum.set(key, row);
   }
   row.totalQty += ln.quantity;
   row.totalRevenue += ln.amount;
   row.invoiceTokens.add(inv.token);
   if (ln.quantity > 0) row.unitPriceSamples.push({ price: ln.unitPrice, weight: ln.quantity });
   else if (ln.amount > 0) row.unitPriceSamples.push({ price: ln.amount, weight: 1 });
   if (inv.txnDate < row.firstSold) row.firstSold = inv.txnDate;
   if (inv.txnDate > row.lastSold) row.lastSold = inv.txnDate;
   const c = row.byCustomer.get(customerKey) ?? {
    qty: 0,
    revenue: 0,
    invoiceIds: new Set<string>(),
    customerAu: inv.customerAuNumber,
    customerName: inv.customerName,
   };
   c.qty += ln.quantity;
   c.revenue += ln.amount;
   c.invoiceIds.add(inv.token);
   row.byCustomer.set(customerKey, c);
   const mKey = ym(inv.txnDate);
   const m = row.byMonth.get(mKey) ?? { qty: 0, revenue: 0 };
   m.qty += ln.quantity;
   m.revenue += ln.amount;
   row.byMonth.set(mKey, m);
  }
 }

 const products: ProductRow[] = [];
 for (const row of accum.values()) {
  const sumW = row.unitPriceSamples.reduce((s, x) => s + x.weight, 0);
  const sumPW = row.unitPriceSamples.reduce((s, x) => s + x.price * x.weight, 0);
  const avgUnitPrice = sumW > 0 ? sumPW / sumW : 0;
  const customers: ProductCustomerBreakdown[] = [...row.byCustomer.entries()]
   .map(([customer, v]) => ({
    customer,
    customerAu: v.customerAu,
    customerName: v.customerName,
    qty: +v.qty.toFixed(2),
    revenue: +v.revenue.toFixed(2),
    invoiceCount: v.invoiceIds.size,
   }))
   .sort((a, b) => b.revenue - a.revenue);
  const monthly: ProductMonthlyPoint[] = [...row.byMonth.entries()]
   .map(([k, v]) => ({ ym: k, qty: +v.qty.toFixed(2), revenue: +v.revenue.toFixed(2) }))
   .sort((a, b) => a.ym.localeCompare(b.ym));
  const top = customers[0];
  const topShare = top && row.totalRevenue > 0 ? top.revenue / row.totalRevenue : 0;
  products.push({
   product: row.product,
   itemCategory: row.itemCategory,
   totalQty: +row.totalQty.toFixed(2),
   totalRevenue: +row.totalRevenue.toFixed(2),
   invoiceCount: row.invoiceTokens.size,
   avgUnitPrice: +avgUnitPrice.toFixed(2),
   firstSold: row.firstSold,
   lastSold: row.lastSold,
   uniqueCustomers: row.byCustomer.size,
   topCustomer: top ? { name: top.customerName || top.customer, au: top.customerAu, share: +topShare.toFixed(3) } : null,
   customers,
   monthly,
  });
 }
 products.sort((a, b) => b.totalRevenue - a.totalRevenue);

 const stats = await getScrapeStats();
 const result: SalesByProductResult = {
  asOf: new Date().toISOString(),
  windowStart: WINDOW_START,
  windowEnd: todayYmd(),
  status: {
   inWindowWithLink: withLink.length,
   scraped: scrapedCount,
   missingLinks,
   failed: stats.failed,
   failures: stats.failures,
  },
  cogsMapping: {
   mappedLines: mappedLineCount,
   unmappedLines: unmappedLineCount,
   unmappedLabels: [...unmappedLabels].sort(),
  },
  totals: {
   invoiceCount: scrapedCount,
   lineItemCount,
   totalRevenue: +totalRevenue.toFixed(2),
   uniqueProducts: products.length,
   uniqueCustomers: allCustomers.size,
  },
  products,
  warnings,
 };
 _cache = { at: Date.now(), data: result };
 return result;
}
