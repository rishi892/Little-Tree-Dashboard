/**
 * Map (invoice itemName, invoice description) → COGS catalog name.
 *
 * Invoice line items only carry the FLAVOUR ("Cherry") and the high-level
 * category ("Edible:Little Tree Hash Rosin Gummies"). The COGS sheet uses
 * SKU-level names ("Little Tree - Cherry Hash Rosin - 200mg"). This module
 * resolves invoice → COGS so the Sales by Product page can show the same
 * names that appear on the COGS report (revenue and costs reconcile).
 *
 * Strategy:
 *   1. Token-based fuzzy match - score each catalog entry against
 *      (cleanedCategory + flavour) by token overlap, with extra weight for
 *      format keywords (hash rosin, live resin, cbn, cbg, 4x50mg, 10pk,
 *      high chew, fruit cluster, etc.).
 *   2. Optional manual aliases via .product-aliases.json (future: editable
 *      from UI). For now this file just exists as a stub.
 *
 * Output per invoice line:
 *   - mapped: COGS catalog string when score ≥ threshold
 *   - score : 0..1
 *   - candidates: top 3 (debug/inspection)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.resolve(__dirname, '..', 'data', 'cogs-catalog.json');
const ALIASES_FILE = path.resolve(__dirname, '..', '.product-aliases.json');

type Catalog = { version: number; products: string[] };
type Aliases = Record<string, string>;       // "<itemName>||<description>" → COGS name

let _catalog: Catalog | null = null;
let _aliases: Aliases | null = null;
let _normalisedCatalog: Array<{ original: string; tokens: Set<string>; raw: string }> | null = null;

async function loadCatalog(): Promise<Catalog> {
 if (_catalog) return _catalog;
 const raw = await fs.readFile(CATALOG_FILE, 'utf8');
 _catalog = JSON.parse(raw) as Catalog;
 return _catalog;
}

async function loadAliases(): Promise<Aliases> {
 if (_aliases) return _aliases;
 try {
  const raw = await fs.readFile(ALIASES_FILE, 'utf8');
  _aliases = JSON.parse(raw) as Aliases;
  return _aliases;
 } catch {
  _aliases = {};
  return _aliases;
 }
}

export function invalidateCogsMapperCache(): void {
 _catalog = null;
 _aliases = null;
 _normalisedCatalog = null;
}

// --- Tokenisation ---

/**
 * Split a name into normalised tokens. Examples:
 *   "Little Tree - Cherry Hash Rosin - 200mg"
 *   → ["little","tree","cherry","hash","rosin","200mg"]
 *   "Edible:Little Tree Live Resin Gummies"
 *   → ["little","tree","live","resin","gummies"]
 * We deliberately drop the leading category prefix ("Edible:", "Concentrate:")
 * and "gummies" plural - they're noise for matching.
 */
const STOPWORDS = new Set(['the', 'and', 'gummies', 'gummy', '-', '+']);
function tokenise(s: string): Set<string> {
 const cleaned = s
  .toLowerCase()
  .replace(/^[a-z]+:/, '')                 // strip "Edible:" / "Concentrate:" prefix
  .replace(/[(),:–-]/g, ' ')
  .replace(/[-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
 const out = new Set<string>();
 for (const t of cleaned.split(' ')) {
  if (!t || STOPWORDS.has(t)) continue;
  out.add(t);
 }
 return out;
}

async function getNormalisedCatalog(): Promise<Array<{ original: string; tokens: Set<string>; raw: string }>> {
 if (_normalisedCatalog) return _normalisedCatalog;
 const cat = await loadCatalog();
 _normalisedCatalog = cat.products.map((p) => ({
  original: p,
  tokens: tokenise(p),
  raw: p.toLowerCase(),
 }));
 return _normalisedCatalog;
}

// --- Scoring ---

/**
 * Jaccard similarity between two token sets, plus a small bonus for
 * format-keyword overlap (hash rosin, live resin, cbn, cbg, etc.) - these
 * are higher-signal than generic words.
 */
const FORMAT_KEYWORDS = new Set([
 'hash', 'rosin', 'live', 'resin', 'distillate', 'cbn', 'cbg', 'cbd', 'thcv',
 'cookies', 'cream', 'chocolate', 'caramel', 'cone', 'cones', 'bar', 'bite',
 'last', 'bites', 'cluster', 'clusters', 'medallion', 'sour', 'snooze',
 'high', 'chew', 'nerds', 'pack', 'fruit',
]);

function scorePair(a: Set<string>, b: Set<string>): number {
 if (a.size === 0 || b.size === 0) return 0;
 let inter = 0;
 let formatBonus = 0;
 for (const t of a) {
  if (b.has(t)) {
   inter++;
   if (FORMAT_KEYWORDS.has(t)) formatBonus += 0.08;
  }
 }
 const union = a.size + b.size - inter;
 const jaccard = union > 0 ? inter / union : 0;
 return Math.min(1, jaccard + formatBonus);
}

// --- Public API ---

export type MapResult = {
 cogsName: string | null;          // null when no confident match
 score: number;
 candidates: Array<{ name: string; score: number }>;
 reason: 'alias' | 'matched' | 'unmatched';
};

const MATCH_THRESHOLD = 0.35;

/**
 * Map a single invoice line. itemName = category from invoice
 * (e.g. "Edible:Little Tree Hash Rosin Gummies"). description = flavour
 * (e.g. "Cherry"). Both are combined and tokenised, then scored against
 * every catalog entry.
 */
export async function mapInvoiceLineToCogs(itemName: string, description: string): Promise<MapResult> {
 const aliases = await loadAliases();
 const aliasKey = `${itemName}||${description}`;
 if (aliases[aliasKey]) {
  return { cogsName: aliases[aliasKey], score: 1, candidates: [], reason: 'alias' };
 }
 const catalog = await getNormalisedCatalog();
 const queryTokens = tokenise(`${itemName} ${description}`);
 const scored = catalog
  .map((c) => ({ name: c.original, score: scorePair(queryTokens, c.tokens) }))
  .sort((a, b) => b.score - a.score);
 const top = scored[0];
 const top3 = scored.slice(0, 3);
 if (!top || top.score < MATCH_THRESHOLD) {
  return { cogsName: null, score: top?.score ?? 0, candidates: top3, reason: 'unmatched' };
 }
 return { cogsName: top.name, score: top.score, candidates: top3, reason: 'matched' };
}

/** Bulk variant - keeps everything in memory, faster for full scrape pass. */
export async function mapInvoiceLinesToCogs(
 lines: Array<{ itemName: string; description: string }>,
): Promise<MapResult[]> {
 // Ensure catalog + aliases loaded once
 await Promise.all([loadCatalog(), loadAliases(), getNormalisedCatalog()]);
 return Promise.all(lines.map((l) => mapInvoiceLineToCogs(l.itemName, l.description)));
}
