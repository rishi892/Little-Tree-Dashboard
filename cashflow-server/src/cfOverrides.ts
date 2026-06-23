/**
 * Manual cashflow overrides - persisted to disk so the 13-week projection can
 * reflect user-entered values (CC utilisation, expected new draws, etc.)
 * without recomputing them from live data sources.
 *
 * Storage: server/.cashflow-overrides.json
 *
 * Schema:
 * {
 * ccUtilisationByWeek: { "WK01": 0, "WK02": 4550, ... } // keyed by Wk index 01-13
 * mode: "manual" | "auto" // auto = projected from CC balance trend
 * }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '.cashflow-overrides.json');

export type CfOverrideMode = 'manual' | 'auto';

export type CfOverrides = {
 mode: CfOverrideMode;
 /** Sparse map: weekIndex (0-based "WK01"…"WK13") → manual CC utilisation amount. */
 ccUtilisationByWeek: Record<string, number>;
};

const DEFAULT_OVERRIDES: CfOverrides = {
 mode: 'manual',
 ccUtilisationByWeek: {},
};

let cache: CfOverrides | null = null;

export async function loadCfOverrides(): Promise<CfOverrides> {
 if (cache) return cache;
 try {
 const raw = await fs.readFile(FILE, 'utf8');
 const parsed = JSON.parse(raw) as Partial<CfOverrides>;
 cache = {
 mode: parsed.mode === 'auto' ? 'auto' : 'manual',
 ccUtilisationByWeek: parsed.ccUtilisationByWeek ?? {},
 };
 } catch {
 cache = { ...DEFAULT_OVERRIDES };
 }
 return cache;
}

export async function saveCfOverrides(next: CfOverrides): Promise<void> {
 cache = next;
 await fs.writeFile(FILE, JSON.stringify(next, null, 2), 'utf8');
}

/** Returns the 13-element ccUtilisation array (filled from manual overrides). */
export function buildCcUtilisationArray(overrides: CfOverrides, weekCount: number): number[] {
 const out = new Array(weekCount).fill(0);
 for (let i = 0; i < weekCount; i++) {
 const key = `WK${String(i + 1).padStart(2, '0')}`;
 const v = overrides.ccUtilisationByWeek[key];
 if (typeof v === 'number' && Number.isFinite(v)) out[i] = v;
 }
 return out;
}
