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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERRIDES_FILE = path.resolve(__dirname, '..', '.category-overrides.json');

export type OverridePaidBy = 'PureX' | 'Moysh' | 'Combined' | 'Other';
export type CategoryOverride = {
 paidBy?: OverridePaidBy;
 lineItem?: string; // free-form so it can match any Moysh / PureX / Combined category label
};

export type AllOverrides = Record<string, CategoryOverride>;

let cache: AllOverrides | null = null;

export async function loadOverrides(): Promise<AllOverrides> {
 if (cache) return cache;
 try {
 const raw = await fs.readFile(OVERRIDES_FILE, 'utf8');
 cache = JSON.parse(raw) as AllOverrides;
 return cache;
 } catch {
 cache = {};
 return cache;
 }
}

export async function setOverride(account: string, value: CategoryOverride): Promise<AllOverrides> {
 const all = await loadOverrides();
 // Merge: missing keys preserved.
 const merged: CategoryOverride = {
 ...(all[account] ?? {}),
 ...value,
 };
 // If both fields cleared, drop the key entirely.
 if (!merged.paidBy && !merged.lineItem) {
 delete all[account];
 } else {
 all[account] = merged;
 }
 cache = { ...all };
 await fs.writeFile(OVERRIDES_FILE, JSON.stringify(cache, null, 2), 'utf8');
 return cache;
}

export async function clearOverride(account: string): Promise<AllOverrides> {
 const all = await loadOverrides();
 if (all[account]) {
 delete all[account];
 cache = { ...all };
 await fs.writeFile(OVERRIDES_FILE, JSON.stringify(cache, null, 2), 'utf8');
 }
 return cache ?? {};
}

export async function clearAllOverrides(): Promise<AllOverrides> {
 cache = {};
 await fs.writeFile(OVERRIDES_FILE, JSON.stringify(cache, null, 2), 'utf8');
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
