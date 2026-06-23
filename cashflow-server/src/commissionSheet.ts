/**
 * Commission Sheet - invoice # -> sales rep mapping.
 *
 * The user's commission workbook has 12 monthly tabs (Jan-May, June, July ...
 * APR 2026), each with the same kind of data: per-invoice rep attribution,
 * QTY, PURE X FEE, etc.  Schema varies tab-to-tab (10 to 28 columns, header
 * row position differs, some tabs have typo'd headers, etc.) - we autodetect
 * the `Inv #` and `Sales reps` columns on each tab.
 *
 * Output: Map<invoiceNumber, repName> with normalized rep names. The
 * Sales-by-Reps view joins LT Financials invoices against this map to
 * attribute each sale to a rep.
 *
 * Sheet:
 *   https://docs.google.com/spreadsheets/d/1LpXXB3skaNoLmC03UVrzFHv6NKEmCzfZYBgFmLR18eE/edit
 */

const SHEET_ID = '18vKzOOOrSIArbr1Enz66RDnjaj6n1ULA';

// Single consolidated "Calculation" tab (all reps, through April 2026). The
// lenient findHeader() below skips the 2 title rows and detects the Owner /
// Inv # columns automatically.
const TABS: Array<{ gid: string; name: string }> = [
 { gid: '1039823948', name: 'Calculation' },
];

export type RepAttribution = {
 rep: string;           // normalized rep name (Manny, Dave, Joe P, Johan, Ken)
 rawRep: string;        // exactly what the sheet had (for transparency)
 sourceTab: string;     // which monthly tab the row came from
 isWhitelabel: boolean; // manually flagged in sheet's "Busienss Type" / "Order type" column
 // Deduction columns (when available in this tab) - used by the commission
 // calculator to derive Net Amount = Invoice - Tax - Shipping - Credit - PureX Fee.
 shipping: number;
 tax: number;
 credit: number;
 pureXFee: number;      // QTY × per-unit fee (goes to PureX, not the rep)
 invoiceUrl: string;
};

export type CommissionSheetResult = {
 fetchedAt: string;
 sheetUrl: string;
 /** Map keyed by invoice number (lowercased, trimmed) for cheap lookup. */
 invoiceToRep: Record<string, RepAttribution>;
 /** Tabs that were successfully parsed. */
 tabsParsed: Array<{ tab: string; gid: string; rowsParsed: number }>;
 tabsFailed: Array<{ tab: string; gid: string; reason: string }>;
 /** Each unique normalized rep + its raw variants seen + counts. */
 reps: Array<{ rep: string; invoiceCount: number; variants: string[] }>;
};

// --- CSV parsing (same shape as other sheet modules) ---
function parseCsv(text: string): string[][] {
 const rows: string[][] = [];
 let cur: string[] = [];
 let field = '';
 let inQ = false;
 for (let i = 0; i < text.length; i++) {
   const c = text[i];
   if (inQ) {
     if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
     else field += c;
   } else {
     if (c === '"') inQ = true;
     else if (c === ',') { cur.push(field); field = ''; }
     else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
     else if (c !== '\r') field += c;
   }
 }
 if (field || cur.length) { cur.push(field); rows.push(cur); }
 return rows;
}

/**
 * Locate the header row + key column indices.  Header detection is lenient -
 * scans up to 10 rows looking for any cell that fuzzy-matches "Inv #" or
 * "Sales rep".  Handles the "Dec" tab which has a typo `zre` instead of
 * `Inv #` (we'll just pick the first column when others match).
 */
function findHeader(rows: string[][]): {
 hdrIdx: number; idxInv: number; idxRep: number; idxWhitelabel: number;
 idxShipping: number; idxTax: number; idxCredit: number; idxPureXFee: number; idxLink: number;
} | null {
 for (let i = 0; i < Math.min(10, rows.length); i++) {
   const r = rows[i];
   const norm = r.map((c) => (c || '').trim().toLowerCase());
   let idxInv = -1, idxRep = -1, idxWhitelabel = -1;
   let idxShipping = -1, idxTax = -1, idxCredit = -1, idxPureXFee = -1, idxLink = -1;
   for (let j = 0; j < norm.length; j++) {
     const h = norm[j];
     if (idxInv < 0 && /^(inv\s*#|invoice\s*#?|invoice\s*number)$/i.test(h)) idxInv = j;
     if (idxRep < 0 && /^(sales\s*reps?|owner|salesperson)$/i.test(h)) idxRep = j;
     if (idxWhitelabel < 0 && /^(busienss\s*type|business\s*type|order\s*type)$/i.test(h)) idxWhitelabel = j;
     if (idxShipping < 0 && /^(shipping\s*(cost|fees)?)$/i.test(h)) idxShipping = j;
     if (idxTax < 0 && /^tax(\s|$|\s*amount)/i.test(h)) idxTax = j;
     if (idxCredit < 0 && /^credit$/i.test(h)) idxCredit = j;
     // PureX Fee column (QTY × per-unit charge that goes to PureX, not rep).
     // Variants: "PURE X FEE", "PUREX FEE", "Pure X Fee".
     if (idxPureXFee < 0 && /^(pure\s*x\s*fee|purex\s*fee)$/i.test(h)) idxPureXFee = j;
     if (idxLink < 0 && /^invoice\s*link$/i.test(h)) idxLink = j;
   }
   if (idxRep >= 0) {
     if (idxInv < 0) {
       for (let j = 0; j < norm.length; j++) if (norm[j] && norm[j] !== 'invoice link') { idxInv = j; break; }
     }
     return { hdrIdx: i, idxInv, idxRep, idxWhitelabel, idxShipping, idxTax, idxCredit, idxPureXFee, idxLink };
   }
 }
 return null;
}

function parseMoney(s: string): number {
 const t = (s ?? '').trim();
 if (!t || t === '-' || t === '$ -') return 0;
 const negative = /\(.*\)/.test(t);
 const cleaned = t.replace(/[$,()\s]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

/**
 * Normalize sheet-raw rep strings to a stable canonical name.  Captures the
 * variants the user actually has:
 *   Manny           -> Manny
 *   DAVE / David    -> Dave
 *   JOE P / Joe     -> Joe P
 *   JOHAN / JOHAN/LITTLE TREE / JOHAN/MANNY / JOHAN- white label -> Johan
 *   KEN             -> Ken
 *   LITTLE TREE / Little Tree -> Little Tree
 *
 * Returns the canonical name; caller keeps the raw value too for transparency.
 */
function normalizeRep(raw: string): string {
 const s = (raw || '').trim();
 if (!s) return '';
 const u = s.toUpperCase();
 // Slash hybrids (JOHAN/LITTLE TREE etc.) - take the first name as primary.
 const head = u.split(/[\/,&]/)[0].trim();
 if (/^MANNY\b/.test(head)) return 'Manny';
 if (/^DAV/.test(head)) return 'Dave';            // matches DAVE and DAVID variants
 if (/^JOE/.test(head)) return 'Joe P';
 if (/^JOHAN/.test(head)) return 'Johan';
 if (/^KEN\b/.test(head)) return 'Ken';
 // "Little Tree" tag in the rep column = house / internal sale, NOT a real
 // rep that earns commission. Return empty so these invoices land in the
 // unmapped bucket and don't show up as a rep row. (User direction:
 // "little tree reps wala chij hata do".)
 if (/^LITTLE\s*TREE/.test(head)) return '';
 // Unknown rep - keep as title-case fallback so it shows up but is flagged.
 return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- Cache (60s TTL - matches LT Financials cache so a single Refresh All
// picks up sheet edits within a minute). ---
let _cache: { at: number; data: CommissionSheetResult } | null = null;
const CACHE_TTL_MS = 60 * 1000;
export function invalidateCommissionSheetCache(): void { _cache = null; }

export async function getCommissionSheet(opts: { force?: boolean } = {}): Promise<CommissionSheetResult> {
 if (!opts.force && _cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;

 const invoiceToRep: Record<string, RepAttribution> = {};
 const tabsParsed: CommissionSheetResult['tabsParsed'] = [];
 const tabsFailed: CommissionSheetResult['tabsFailed'] = [];
 const repVariants = new Map<string, { invoiceCount: number; variants: Set<string> }>();

 // Fetch all tabs in parallel - 12 small CSVs, cheap.
 const fetches = await Promise.all(TABS.map(async (t) => {
   try {
     const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${t.gid}`, { redirect: 'follow' });
     if (!res.ok) return { t, ok: false as const, reason: `HTTP ${res.status}` };
     const csv = await res.text();
     return { t, ok: true as const, csv };
   } catch (e) {
     return { t, ok: false as const, reason: e instanceof Error ? e.message : 'fetch error' };
   }
 }));

 for (const f of fetches) {
   if (!f.ok) { tabsFailed.push({ tab: f.t.name, gid: f.t.gid, reason: f.reason }); continue; }
   const rows = parseCsv(f.csv);
   const hdr = findHeader(rows);
   if (!hdr) { tabsFailed.push({ tab: f.t.name, gid: f.t.gid, reason: 'no Sales-rep header found' }); continue; }

   let rowsParsed = 0;
   for (let i = hdr.hdrIdx + 1; i < rows.length; i++) {
     const r = rows[i];
     const inv = (r[hdr.idxInv] || '').trim();
     if (!inv) continue;
     // Skip obvious non-data rows.
     if (/^(inv\s*#|total|grand|subtotal|sum)/i.test(inv)) continue;
     const rawRep = (r[hdr.idxRep] || '').trim();
     if (!rawRep) continue;
     const rep = normalizeRep(rawRep);
     if (!rep) continue;
     const wlCell = hdr.idxWhitelabel >= 0 ? (r[hdr.idxWhitelabel] || '').trim() : '';
     const isWhitelabel = /whitelabel|white\s*label/i.test(wlCell);
     const shipping = hdr.idxShipping >= 0 ? parseMoney(r[hdr.idxShipping] || '') : 0;
     const tax      = hdr.idxTax      >= 0 ? parseMoney(r[hdr.idxTax]      || '') : 0;
     const credit   = hdr.idxCredit   >= 0 ? parseMoney(r[hdr.idxCredit]   || '') : 0;
     const pureXFee = hdr.idxPureXFee >= 0 ? parseMoney(r[hdr.idxPureXFee] || '') : 0;
     const invoiceUrl = hdr.idxLink   >= 0 ? (r[hdr.idxLink] || '').trim() : '';
     const key = inv.toLowerCase();
     if (!invoiceToRep[key]) {
       invoiceToRep[key] = { rep, rawRep, sourceTab: f.t.name, isWhitelabel, shipping, tax, credit, pureXFee, invoiceUrl };
       const v = repVariants.get(rep) ?? { invoiceCount: 0, variants: new Set<string>() };
       v.invoiceCount += 1;
       v.variants.add(rawRep);
       repVariants.set(rep, v);
       rowsParsed += 1;
     }
   }
   tabsParsed.push({ tab: f.t.name, gid: f.t.gid, rowsParsed });
 }

 const reps = [...repVariants.entries()]
   .map(([rep, v]) => ({ rep, invoiceCount: v.invoiceCount, variants: [...v.variants].sort() }))
   .sort((a, b) => b.invoiceCount - a.invoiceCount);

 const result: CommissionSheetResult = {
   fetchedAt: new Date().toISOString(),
   sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
   invoiceToRep,
   tabsParsed,
   tabsFailed,
   reps,
 };
 _cache = { at: Date.now(), data: result };
 return result;
}
