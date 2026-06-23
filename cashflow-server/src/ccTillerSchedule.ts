/**
 * CC Statement Schedule reader - pulls the per-card statement schedule from
 * the Tiller sheet's "CC Schedule" tab (gid=1375314248). Columns:
 * A: Card Name F: Next Payment date
 * B: Last Statement Close G: Next Closing date
 * C: Last Statement Payment H: Freeze Window note
 * D: Last Statement Status I: Notes
 * E: Action Required
 *
 * When the live tab values are blank ("-" or empty), callers fall back to the
 * hardcoded fixed-day-of-month schedule in `ccSchedule.ts`.
 */

const SHEET_ID = '1fKuOmTrZX_DWKzYsDhBfmfHZ0KZg-YxhFKao_j8Vj6E';
const SCHEDULE_GID = '1375314248';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?gid=${SCHEDULE_GID}&tqx=out:csv`;

export type CcStatementRow = {
 cardName: string;
 lastClose: string | null; // MM/DD/YYYY
 lastPayment: string | null;
 lastStatus: string; // Paid / Unpaid / etc.
 actionRequired: string;
 nextPayment: string | null;
 nextClosing: string | null;
 freezeWindow: string;
 notes: string;
};

function parseCsv(text: string): string[][] {
 const rows: string[][] = [];
 let cur: string[] = [];
 let field = '';
 let inQuotes = false;
 for (let i = 0; i < text.length; i++) {
 const c = text[i];
 if (inQuotes) {
 if (c === '"') {
 if (text[i + 1] === '"') { field += '"'; i++; }
 else inQuotes = false;
 } else field += c;
 } else {
 if (c === '"') inQuotes = true;
 else if (c === ',') { cur.push(field); field = ''; }
 else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
 else if (c !== '\r') field += c;
 }
 }
 if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
 return rows;
}

function clean(s: string | undefined): string {
 const t = (s ?? '').trim();
 if (!t || t === '-') return '';
 return t;
}

function cleanDate(s: string | undefined): string | null {
 const t = clean(s);
 return t || null;
}

export async function getCcTillerSchedule(): Promise<CcStatementRow[]> {
 const res = await fetch(CSV_URL, { redirect: 'follow' });
 if (!res.ok) throw new Error(`CC schedule fetch failed: ${res.status}`);
 const rows = parseCsv(await res.text());
 const out: CcStatementRow[] = [];
 for (let i = 1; i < rows.length; i++) {
 const r = rows[i];
 const cardName = (r[0] ?? '').trim();
 if (!cardName) continue;
 out.push({
 cardName,
 lastClose: cleanDate(r[1]),
 lastPayment: cleanDate(r[2]),
 lastStatus: clean(r[3]) || 'Unknown',
 actionRequired: clean(r[4]),
 nextPayment: cleanDate(r[5]),
 nextClosing: cleanDate(r[6]),
 freezeWindow: clean(r[7]),
 notes: clean(r[8]),
 });
 }
 return out;
}

/** Match a Tiller schedule row by partial card-name (e.g. "Blue Business
 * Plus Card" matches "blue business plus"). Returns null if no match. */
export function findScheduleRow(
 rows: CcStatementRow[],
 pattern: RegExp,
): CcStatementRow | null {
 return rows.find((r) => pattern.test(r.cardName)) ?? null;
}

/**
 * Hardcoded payment-cycle schedule per card. Used as fallback when the Tiller
 * CC schedule tab's date columns are blank ("-"). Days are 1-31; we project
 * forward + backward from today to compute Last/Next dates.
 *
 * Source: user-provided snapshot (verified 2026-05-14).
 */
export type CcCycleSpec = {
 match: RegExp; // matches the Tiller account name
 paymentDay: number; // statement payment day-of-month
 closingDay: number; // next statement closing day-of-month
};

export const CC_CYCLES: CcCycleSpec[] = [
 { match: /4362|mc consumer/i, paymentDay: 25, closingDay: 28 },
 { match: /-?0715|· 0715|chase\s*0715/i, paymentDay: 1, closingDay: 4 },
 { match: /-?4158|· 4158|chase\s*4158/i, paymentDay: 1, closingDay: 4 },
 { match: /delta gold|1007/i, paymentDay: 14, closingDay: 19 },
 { match: /blue business plus|1009/i, paymentDay: 14, closingDay: 19 },
 { match: /everyday|1006/i, paymentDay: 14, closingDay: 19 },
 { match: /signature|fnbo|6037/i, paymentDay: 11, closingDay: 14 },
 // Citi cards excluded - user has "No Last Payment Rule" for them in the
 // schedule and we don't have real statement dates.
];

function daysInMonth(y: number, m: number): number {
 return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

function fmtMDY(d: Date): string {
 return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/**
 * Compute the next occurrence of `dayOfMonth` after `from` (or today). If the
 * target day in `from`'s month is already past, roll to next month.
 */
function nextDateOfDay(dayOfMonth: number, from: Date = new Date()): Date {
 const y = from.getUTCFullYear();
 const m = from.getUTCMonth();
 const d = from.getUTCDate();
 let targetY = y;
 let targetM = m;
 if (dayOfMonth <= d) {
 targetM += 1;
 if (targetM > 11) { targetM = 0; targetY += 1; }
 }
 const day = Math.min(dayOfMonth, daysInMonth(targetY, targetM));
 return new Date(Date.UTC(targetY, targetM, day));
}

/** Previous occurrence of `dayOfMonth` before `from`. */
function prevDateOfDay(dayOfMonth: number, from: Date = new Date()): Date {
 const y = from.getUTCFullYear();
 const m = from.getUTCMonth();
 const d = from.getUTCDate();
 let targetY = y;
 let targetM = m;
 if (dayOfMonth > d) {
 targetM -= 1;
 if (targetM < 0) { targetM = 11; targetY -= 1; }
 }
 const day = Math.min(dayOfMonth, daysInMonth(targetY, targetM));
 return new Date(Date.UTC(targetY, targetM, day));
}

/**
 * Returns a CC_CYCLES-derived schedule row for the given account name, with
 * Last/Next dates rolled to the current calendar position. Returns null when
 * the account has no cycle spec.
 */
export function getHardcodedScheduleFor(accountName: string): CcStatementRow | null {
 const spec = CC_CYCLES.find((s) => s.match.test(accountName));
 if (!spec) return null;
 const today = new Date();
 const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
 return {
 cardName: accountName,
 lastClose: fmtMDY(prevDateOfDay(spec.closingDay, todayUtc)),
 lastPayment: fmtMDY(prevDateOfDay(spec.paymentDay, todayUtc)),
 lastStatus: '', // populated separately from Tiller live status
 actionRequired: '',
 nextPayment: fmtMDY(nextDateOfDay(spec.paymentDay, todayUtc)),
 nextClosing: fmtMDY(nextDateOfDay(spec.closingDay, todayUtc)),
 freezeWindow: '',
 notes: '',
 };
}
