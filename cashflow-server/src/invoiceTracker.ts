/**
 * Invoice Tracker - current AR source of truth (replaces the old gid=0 tab
 * of the Little Tree Financials workbook).
 *
 * Sheet: 1hcxz0jx... gid=0
 *
 * Columns (per row, after header):
 * 0 Inv # 1 Date 2 Customer
 * 3 Amount 4 Paid Amount 5 Paid Date
 * 6 Difference 7 Commission 8 Status
 * (Paid / Overdue / Underpaid / Collection / Write off)
 *
 * Used for: 13-week cashflow non-Gelato AR projection, sales-by-channel,
 * any AR-aging analysis.
 */

import { unzipSync, strFromU8 } from 'fflate';

const SHEET_ID = '1hcxz0jxBKIvoMSYrluxOYfBf3hOa4cXEIpqvaRtt-fI';
const GID = '0';
// We fetch the workbook as XLSX (not CSV) because the sheet's "Link" column
// uses cell-level hyperlinks: the visible text is the invoice number, but the
// actual URL lives in the cell's hyperlink metadata. CSV exports drop those
// hyperlinks; XLSX preserves them in xl/worksheets/_rels/sheet1.xml.rels.
const XLSX_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;

export type InvoiceRow = {
 invoiceNumber: string;
 date: string; // raw date string
 invoiceDate: Date; // parsed
 customer: string;
 amount: number;
 paid: number;
 openBalance: number; // amount − paid
 paidDate: string;
 status: string; // Paid | Overdue | Underpaid | Collection | Write off | ""
 link: string; // col 9 - Intuit CommerceNetwork share URL (when populated)
 brand: string; // col 12 - Brand grouping (e.g. "Stash Ventures LLC", "JARS/ALLSTAR")
 brandSource: 'sheet' | 'derived'; // 'sheet' = brand col was non-empty; 'derived' = fallback from first word of customer name
 email: string; // col 13 - AR contact email (per-invoice fallback)
};

export type InvoiceTrackerResult = {
 fetchedAt: string;
 sheetUrl: string;
 invoices: InvoiceRow[];
};

function decodeXmlEntities(s: string): string {
 return s
 .replace(/&lt;/g, '<')
 .replace(/&gt;/g, '>')
 .replace(/&quot;/g, '"')
 .replace(/&apos;/g, "'")
 .replace(/&amp;/g, '&');
}

/** Parse <sharedStrings.xml> → array of strings, indexed by ref. */
function parseSharedStrings(xml: string): string[] {
 const out: string[] = [];
 // Each <si>...</si> represents one shared string. Content can be either a
 // simple <t>...</t> or a sequence of <r><t>...</t></r> rich-text runs.
 const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
 const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
 let m: RegExpExecArray | null;
 while ((m = siRe.exec(xml)) !== null) {
 const inner = m[1];
 let text = '';
 let tm: RegExpExecArray | null;
 while ((tm = tRe.exec(inner)) !== null) text += tm[1];
 out.push(decodeXmlEntities(text));
 }
 return out;
}

/** Parse the rels file: build { rId → targetUrl } for hyperlink relationships. */
function parseRels(xml: string): Map<string, string> {
 const m = new Map<string, string>();
 // Use [^>]*? so slashes inside attribute values (e.g. https://) don't end
 // the match early. Tags end with "/>", optionally with whitespace.
 const re = /<Relationship\b([^>]*?)\/\s*>/g;
 let r: RegExpExecArray | null;
 while ((r = re.exec(xml)) !== null) {
 const attrs = r[1];
 const id = (attrs.match(/Id="([^"]+)"/) || [])[1];
 const type = (attrs.match(/Type="([^"]+)"/) || [])[1] ?? '';
 const target = (attrs.match(/Target="([^"]+)"/) || [])[1];
 if (id && target && /hyperlink/i.test(type)) m.set(id, decodeXmlEntities(target));
 }
 return m;
}

/** Parse <hyperlink ref="J1020" r:id="rId1"/> entries → { cellRef → rId }. */
function parseHyperlinks(xml: string): Map<string, string> {
 const m = new Map<string, string>();
 const re = /<hyperlink\b([^>]*?)\/\s*>/g;
 let r: RegExpExecArray | null;
 while ((r = re.exec(xml)) !== null) {
 const attrs = r[1];
 const ref = (attrs.match(/\bref="([^"]+)"/) || [])[1];
 const rid = (attrs.match(/r:id="([^"]+)"/) || [])[1];
 if (ref && rid) m.set(ref, rid);
 }
 return m;
}

/** Convert column letter (A=0, B=1, ..., AA=26) → 0-indexed column. */
function colLetterToIndex(letters: string): number {
 let n = 0;
 for (let i = 0; i < letters.length; i++) {
 n = n * 26 + (letters.charCodeAt(i) - 64);
 }
 return n - 1;
}

/**
 * Parse sheet1.xml into a row-major 2D array. Cells reference shared strings
 * by index when t="s"; otherwise the <v> is the literal value (number/date
 * serial/inline string). For our use we only need string values - dates can
 * stay as serial numbers but the sheet stores them as inline strings already
 * via the date pattern, and amounts are numbers.
 */
function parseSheetRows(xml: string, sst: string[]): string[][] {
 const rows: string[][] = [];
 const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
 const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
 let rm: RegExpExecArray | null;
 while ((rm = rowRe.exec(xml)) !== null) {
 const rowAttrs = rm[1];
 const rowNumStr = (rowAttrs.match(/\br="(\d+)"/) || [])[1];
 const rowNum = rowNumStr ? Number(rowNumStr) : rows.length + 1;
 const cells: string[] = [];
 let cm: RegExpExecArray | null;
 const inner = rm[2];
 cellRe.lastIndex = 0;
 while ((cm = cellRe.exec(inner)) !== null) {
 const cAttrs = cm[1];
 const cInner = cm[3] ?? '';
 const cellRef = (cAttrs.match(/\br="([A-Z]+)(\d+)"/) || []);
 const colIdx = cellRef[1] ? colLetterToIndex(cellRef[1]) : cells.length;
 const cellType = (cAttrs.match(/\bt="([^"]+)"/) || [])[1] ?? 'n';
 const vMatch = cInner.match(/<v>([\s\S]*?)<\/v>/);
 const isMatch = cInner.match(/<is>[\s\S]*?<t>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
 let value = '';
 if (vMatch) {
 const raw = vMatch[1];
 if (cellType === 's') {
 const idx = Number(raw);
 value = sst[idx] ?? '';
 } else {
 value = raw;
 }
 } else if (isMatch) {
 value = decodeXmlEntities(isMatch[1]);
 }
 while (cells.length < colIdx) cells.push('');
 cells.push(value);
 }
 while (rows.length < rowNum - 1) rows.push([]);
 rows.push(cells);
 }
 return rows;
}

function parseMoney(s: string): number {
 const t = (s ?? '').trim();
 if (!t || t === '-' || t === '$ -') return 0;
 const negative = /\(.*\)/.test(t);
 const cleaned = t.replace(/[\$,()\s]/g, '');
 if (!cleaned) return 0;
 const n = Number(cleaned);
 return Number.isFinite(n) ? (negative ? -n : n) : 0;
}

/**
 * Resolve brand for an invoice - sheet's Brand column is the primary source.
 * When sheet brand is blank, fall back to extracting the brand keyword from
 * the customer name (e.g. "Little Tree- Puff Bay City" → "Puff").
 *
 * Also normalises minor sheet variations so similar brands cumulate:
 * "Allstar 2" → "Allstar"
 * "Allstar" → "Allstar"
 * "JARS/ALLSTAR" → "JARS/ALLSTAR" (kept raw - multi-brand label)
 * "Stash Ventures" → "Stash Ventures" (kept multi-word)
 *
 * Strategy: trim trailing numeric suffixes ("Brand 2" → "Brand"). Single-word
 * brands stay normalised; multi-word brands stay as-is (sheet authoritative).
 */
function resolveBrand(brandCol: string, customer: string): { brand: string; source: 'sheet' | 'derived' } {
 // 1. Use sheet brand if non-empty.
 const raw = (brandCol ?? '').trim();
 let brand: string;
 let source: 'sheet' | 'derived';
 if (raw && raw !== '-' && raw !== '0') {
   brand = raw;
   source = 'sheet';
 } else {
   // 2. Fallback - first word from "Little Tree- <Store ...>" customer name.
   const stripped = (customer ?? '').replace(/^little tree[--]\s*/i, '').trim();
   const first = stripped.match(/^[A-Za-z][A-Za-z0-9'&-]*/);
   brand = first ? first[0] : (stripped || '(unknown)');
   source = 'derived';
 }
 // 3. Trim trailing numeric suffix so "Allstar 2" collapses to "Allstar".
 const trimmed = brand.replace(/\s*\d+\s*$/, '').trim();
 return { brand: trimmed || brand, source };
}

/**
 * Parse a date cell from XLSX. Supports both string ("M/D/YYYY") and Excel
 * serial number (days since 1899-12-30, with a known leap-year bug skipped).
 */
function parseInvoiceDate(s: string): Date | null {
 const t = (s ?? '').trim();
 if (!t) return null;
 // String form
 const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
 if (m) {
 const yr = m[3].length === 2 ? Number('20' + m[3]) : Number(m[3]);
 return new Date(Date.UTC(yr, Number(m[1]) - 1, Number(m[2])));
 }
 // Excel serial number form
 const n = Number(t);
 if (Number.isFinite(n) && n > 25569) { // 25569 = 1970-01-01 in Excel epoch
 const ms = (n - 25569) * 86400 * 1000;
 const d = new Date(ms);
 if (!isNaN(d.getTime())) return d;
 }
 return null;
}

/**
 * Resolve the `xl/worksheets/sheetN.xml` path for the tab whose name matches
 * `nameRe`, using workbook.xml (tab name → r:id) + workbook.xml.rels (r:id →
 * target file). Returns null if not found. Keeps us pinned to the "Invoice
 * tracker" tab regardless of how many tabs sit before it.
 */
function resolveSheetFile(workbookXml: string, workbookRels: string, nameRe: RegExp): string | null {
 if (!workbookXml || !workbookRels) return null;
 let rid: string | null = null;
 const sheetTagRe = /<sheet\b[^>]*\/?>/g;
 let m: RegExpExecArray | null;
 while ((m = sheetTagRe.exec(workbookXml))) {
 const tag = m[0];
 const name = /name="([^"]+)"/.exec(tag)?.[1] ?? '';
 const id = /r:id="(rId\d+)"/.exec(tag)?.[1] ?? '';
 if (name && id && nameRe.test(name)) { rid = id; break; }
 }
 if (!rid) return null;
 // Find the relationship for this r:id (attributes can be in any order).
 const relRe = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`);
 const relTag = relRe.exec(workbookRels)?.[0];
 const target = relTag ? /Target="([^"]+)"/.exec(relTag)?.[1] : null;
 if (!target) return null;
 const norm = target.replace(/^\/?xl\//, '').replace(/^\//, '');
 return `xl/${norm}`;
}

export async function getInvoiceTracker(): Promise<InvoiceTrackerResult> {
 // Fetch as XLSX so cell-level hyperlinks on the "Link" column are preserved.
 const res = await fetch(XLSX_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`Invoice Tracker fetch failed: ${res.status} ${res.statusText}`);
 const buf = new Uint8Array(await res.arrayBuffer());
 // The workbook has several tabs (Important Notes, Invoice tracker, Repwise…)
 // and the tab ORDER is not stable - inserting a tab before "Invoice tracker"
 // shifts it off sheet1.xml. So resolve the worksheet file by TAB NAME (via
 // workbook.xml + its rels) instead of hardcoding sheet1.xml, which previously
 // made us read the wrong (empty) tab and return zero invoices.
 const files = unzipSync(buf, {
 filter: (f) =>
 f.name === 'xl/workbook.xml' ||
 f.name === 'xl/_rels/workbook.xml.rels' ||
 f.name === 'xl/sharedStrings.xml' ||
 /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name) ||
 /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(f.name),
 });
 const sst = files['xl/sharedStrings.xml']
 ? parseSharedStrings(strFromU8(files['xl/sharedStrings.xml']))
 : [];
 const workbookXml = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
 const workbookRels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
 const sheetFile = resolveSheetFile(workbookXml, workbookRels, /invoice\s*tracker/i) ?? 'xl/worksheets/sheet1.xml';
 const sheetRelsFile = sheetFile.replace('xl/worksheets/', 'xl/worksheets/_rels/') + '.rels';
 const sheetXml = files[sheetFile] ? strFromU8(files[sheetFile]) : '';
 const relsXml = files[sheetRelsFile] ? strFromU8(files[sheetRelsFile]) : '';
 const rels = parseRels(relsXml);
 const cellHyperlinks = parseHyperlinks(sheetXml);
 // Build cellRef → url map. Only retain hyperlinks in column J (the Link col).
 const rowToLink = new Map<number, string>();
 for (const [cellRef, rid] of cellHyperlinks) {
 const m = cellRef.match(/^([A-Z]+)(\d+)$/);
 if (!m) continue;
 if (m[1] !== 'J') continue;
 const target = rels.get(rid);
 if (target) rowToLink.set(Number(m[2]), target);
 }
 const rows = parseSheetRows(sheetXml, sst);

 const invoices: InvoiceRow[] = [];
 // Dedupe by (invoiceNumber, customer) - the sheet sometimes contains
 // duplicate rows (e.g. invoice 13110a / 13081a appear twice with identical
 // amount + customer + date). Keep the first occurrence; drop the rest.
 const seen = new Set<string>();
 for (let i = 0; i < rows.length; i++) {
 const r = rows[i];
 const rowNum = i + 1;       // 1-indexed to match XLSX cell refs
 const inv = (r[0] ?? '').trim();
 if (!inv || inv === 'Inv #') continue;
 const dateStr = (r[1] ?? '').trim();
 const invDate = parseInvoiceDate(dateStr);
 if (!invDate) continue; // skip rows without parseable date
 const customer = (r[2] ?? '').trim();
 if (!customer) continue;
 const amount = parseMoney(r[3] ?? '');
 if (amount === 0) continue;
 const paid = parseMoney(r[4] ?? '');
 // Normalise paidDate: XLSX stores dates as Excel serial numbers (e.g.
 // "44936.4375"). parseInvoiceDate handles both serial + M/D/YYYY strings;
 // downstream consumers expect either "M/D/YYYY" or "YYYY-MM-DD". Convert
 // serial-form values to YYYY-MM-DD so the AR projection's lag-curve math
 // can parse them (otherwise every invoice gets dumped as overdue Wk1).
 const paidDateRaw = (r[5] ?? '').trim();
 const paidDateParsed = paidDateRaw ? parseInvoiceDate(paidDateRaw) : null;
 const paidDate = paidDateParsed
 ? `${paidDateParsed.getUTCFullYear()}-${String(paidDateParsed.getUTCMonth() + 1).padStart(2, '0')}-${String(paidDateParsed.getUTCDate()).padStart(2, '0')}`
 : paidDateRaw;
 const status = (r[8] ?? '').trim();
 // Prefer cell-level hyperlink (Insert Link in Sheets); fall back to whatever
 // visible text the J column has (sometimes the URL is typed directly).
 const cellText = (r[9] ?? '').trim();
 const hyperlinkUrl = rowToLink.get(rowNum) ?? '';
 const link = hyperlinkUrl || (/^https?:\/\//i.test(cellText) ? cellText : '');
 const { brand, source: brandSource } = resolveBrand(r[12] ?? '', customer);
 const email = (r[13] ?? '').trim();
 const openBalance = +(amount - paid).toFixed(2);
 const key = `${inv}|${customer.toLowerCase()}`;
 if (seen.has(key)) continue;
 seen.add(key);
 invoices.push({
 invoiceNumber: inv,
 date: dateStr,
 invoiceDate: invDate,
 customer,
 amount,
 paid,
 openBalance,
 paidDate,
 status,
 link,
 brand,
 brandSource,
 email,
 });
 }

 return {
 fetchedAt: new Date().toISOString(),
 sheetUrl: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${GID}`,
 invoices,
 };
}

/**
 * Returns invoices that still have an open balance (unpaid / partially paid /
 * overdue). Excludes write-offs. Excludes the Gelato channel (its AR is
 * handled separately via the Gelato Sales sheet with Net 90 terms).
 */
export function getOpenNonGelatoInvoices(all: InvoiceRow[]): InvoiceRow[] {
 return all.filter((inv) => {
 if (inv.openBalance <= 0) return false;
 if (/write\s*off/i.test(inv.status)) return false;
 if (/^little tree-\s*gelato$/i.test(inv.customer)) return false;
 return true;
 });
}
