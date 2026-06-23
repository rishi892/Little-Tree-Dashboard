/**
 * Manual overrides for QB account → (Paid-By entity, Mapped line-item).
 *
 * Stored in a JSON file so they survive server restarts. Applied at TWO points:
 * 1. expenseDetail.ts → forces a QB account's perEntity bucket to the chosen
 * Paid-By value, overriding the auto-detection (class/source-account/etc.).
 * 2. mappedExpenses.ts → routes the QB account directly to the chosen sheet
 * category, bypassing the regex layout.
 *
 * Key = QB account name (exact string from QB; case-sensitive). Both fields
 * are optional - user can override only paidBy, only lineItem, or both.
 */

import { dbSelect, dbUpsert, dbDelete } from './db.js';

export type OverridePaidBy = 'PureX' | 'Moysh' | 'Combined' | 'Other';
export type CategoryOverride = {
 paidBy?: OverridePaidBy;
 lineItem?: string; // free-form so it can match any Moysh / PureX / Combined category label
};

export type AllOverrides = Record<string, CategoryOverride>;

let cache: AllOverrides | null = null;

type Row = { account: string; paid_by: string | null; line_item: string | null };

export async function loadOverrides(): Promise<AllOverrides> {
 if (cache) return cache;
 const rows = await dbSelect<Row>('category_overrides');
 const all: AllOverrides = {};
 for (const r of rows) {
 all[r.account] = {
 ...(r.paid_by ? { paidBy: r.paid_by as OverridePaidBy } : {}),
 ...(r.line_item ? { lineItem: r.line_item } : {}),
 };
 }
 cache = all;
 return cache;
}

export async function setOverride(account: string, value: CategoryOverride): Promise<AllOverrides> {
 const all = await loadOverrides();
 const merged: CategoryOverride = { ...(all[account] ?? {}), ...value };
 if (!merged.paidBy && !merged.lineItem) {
 delete all[account];
 await dbDelete('category_overrides', `account=eq.${encodeURIComponent(account)}`);
 } else {
 all[account] = merged;
 await dbUpsert('category_overrides', { account, paid_by: merged.paidBy ?? null, line_item: merged.lineItem ?? '' });
 }
 cache = { ...all };
 return cache;
}

export async function clearOverride(account: string): Promise<AllOverrides> {
 const all = await loadOverrides();
 if (all[account]) {
 delete all[account];
 await dbDelete('category_overrides', `account=eq.${encodeURIComponent(account)}`);
 cache = { ...all };
 }
 return cache ?? {};
}

export async function clearAllOverrides(): Promise<AllOverrides> {
 cache = {};
 await dbDelete('category_overrides', 'account=not.is.null');
 return cache;
}

/** Synchronous getter for callers in hot paths (after at least one load). */
export function getOverrideSync(account: string): CategoryOverride | undefined {
 return cache?.[account];
}

/** Force the next loadOverrides() to re-read from disk. Used after mutations. */
export function invalidateCache(): void {
 cache = null;
}
