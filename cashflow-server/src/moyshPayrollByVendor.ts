/**
 * Moysh Payroll - strict 21-person allow-list.
 *
 * QB books each exec / contractor as its own expense account (e.g. "CEO-
 * Joseph Tuchman", "Angus Ritchie", "CMO- Phillip Macko (second starter Inc)").
 * So instead of matching transactions by vendor name, we match by QB ACCOUNT
 * NAME against the user-provided master list.
 *
 * For each matched account we sum only the MOYSH-paid portion (`perEntity.Moysh`
 * from expenseDetail's source-bank classification). PureX-paid payroll is
 * already excluded by that classification.
 *
 * Source: user-provided master list (2026-05-14). Excludes everyone NOT named
 * (Carol Tuchman, Johan Vanblerk, Cash Payroll Expenses, Employer Payroll Taxes,
 * Nishara, Martin Tuchman, the production crew, etc.).
 */

import type { ExpenseDetailRow } from './expenseDetail.js';

export type MoyshPayrollPerson = {
 label: string;
 channel: 'Gusto' | 'Upwork' | 'Wise';
 /** Matches against the QB account name (case-insensitive). */
 match: RegExp;
};

export const MOYSH_PAYROLL_PEOPLE: MoyshPayrollPerson[] = [
 // ---- Gusto ----
 { label: 'Second Starters Inc. / Phillip Macko (CMO)', channel: 'Gusto',
 match: /second\s*starters?|\bcmo[-\s]+phillip\s*macko|^phillip\s*macko/i },
 { label: 'Adam Brogan', channel: 'Gusto',
 match: /^adam\s*brogan/i },
 { label: 'Joseph Tuchman (CEO)', channel: 'Gusto',
 match: /\bceo[-\s]+joseph\s*tuchman|^joseph\s*tuchman/i },
 // ---- Upwork ----
 { label: 'Angus Ritchie', channel: 'Upwork', match: /^angus\s*ritchie/i },
 { label: 'Daria Malovichko', channel: 'Upwork', match: /^daria\s*malovichko/i },
 { label: 'Abdul Basit', channel: 'Upwork', match: /^abdul\s*basit/i },
 { label: 'Mark Keranen', channel: 'Upwork', match: /^mark\s*keranen/i },
 { label: 'Hafiz Muhammad Abubakar', channel: 'Upwork',
 match: /^hafiz(\s+muhammad)?\s+abu\s*bakar/i },
 { label: 'Precious Ilepe', channel: 'Upwork', match: /^precious\s*ilepe/i },
 { label: 'Beata Leyland', channel: 'Upwork', match: /^beata\s*leyland/i },
 { label: 'Rishi Arora (CFO)', channel: 'Upwork',
 match: /\bcfo[-\s]+rishi\s*arora|^rishi\s*arora/i },
 { label: 'Miljan Krcobic', channel: 'Upwork', match: /^miljan\s*krcobic/i },
 { label: 'Bianca Rice', channel: 'Upwork', match: /^bianca\s*rice/i },
 { label: 'Mueen Haider', channel: 'Upwork', match: /^mueen\s*haider/i },
 // ---- Wise ----
 { label: 'Hamza Riaz', channel: 'Wise', match: /^hamza\s*riaz/i },
 { label: 'Syed Rehan Wari', channel: 'Wise', match: /^syed\s*rehan/i },
 { label: 'Junelyn Galan', channel: 'Wise', match: /^junelyn\s*galan/i },
];

export type MoyshPayrollResult = {
 months: string[];
 monthly: number[]; // total Moysh payroll per month
 byPerson: Array<{
 label: string;
 channel: string;
 accounts: string[]; // QB account names that matched
 total: number;
 monthly: number[];
 }>;
};

function matchPerson(accountName: string): MoyshPayrollPerson | null {
 for (const p of MOYSH_PAYROLL_PEOPLE) {
 if (p.match.test(accountName)) return p;
 }
 return null;
}

/**
 * Filter expenseDetail rows to the 21-person allow-list and sum each row's
 * Moysh-paid portion. Pure function - no extra QB calls.
 */
export function computeMoyshPayroll(rows: ExpenseDetailRow[], months: string[]): MoyshPayrollResult {
 const monthly = new Array(months.length).fill(0);
 const byPerson = new Map<string, MoyshPayrollResult['byPerson'][number]>();
 for (const p of MOYSH_PAYROLL_PEOPLE) {
 byPerson.set(p.label, { label: p.label, channel: p.channel, accounts: [], total: 0, monthly: new Array(months.length).fill(0) });
 }

 for (const r of rows) {
 const hit = matchPerson(r.category)
 ?? (r.parentAccountName ? matchPerson(r.parentAccountName) : null);
 if (!hit) continue;
 const dest = byPerson.get(hit.label)!;
 if (!dest.accounts.includes(r.category)) dest.accounts.push(r.category);
 for (let i = 0; i < months.length; i++) {
 const moyshAmt = r.perEntity.Moysh[i] ?? 0;
 monthly[i] += moyshAmt;
 dest.monthly[i] += moyshAmt;
 dest.total += moyshAmt;
 }
 }

 return {
 months,
 monthly: monthly.map((v) => +v.toFixed(2)),
 byPerson: [...byPerson.values()]
 .sort((a, b) => b.total - a.total)
 .map((p) => ({ ...p, total: +p.total.toFixed(2), monthly: p.monthly.map((v) => +v.toFixed(2)) })),
 };
}
