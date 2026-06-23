/**
 * Per-invoice commission overrides.
 *
 * Each invoice can have:
 *   - type: NEW / OLD / WHITELABEL (overrides auto-detection)
 *   - rep:  rep name (when system can't find one)
 *
 * Stored on disk in .commission-overrides.json so they survive restart.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '.commission-overrides.json');

export type OverrideType = 'NEW' | 'OLD' | 'WHITELABEL';

export type InvoiceOverride = {
 type?: OverrideType;
 rep?: string;
};

export type CommissionOverrides = {
 version: 2;
 overrides: Record<string, InvoiceOverride>;
};

let _cache: CommissionOverrides | null = null;

async function load(): Promise<CommissionOverrides> {
 if (_cache) return _cache;
 try {
   const raw = await fs.readFile(FILE, 'utf8');
   const parsed = JSON.parse(raw);
   // Migrate v1 (overrides: Record<string, OverrideType>) -> v2.
   if (parsed.version === 1 || (parsed.overrides && Object.values(parsed.overrides).some((v) => typeof v === 'string'))) {
     const migrated: Record<string, InvoiceOverride> = {};
     for (const [k, v] of Object.entries(parsed.overrides ?? {})) {
       if (typeof v === 'string') migrated[k] = { type: v as OverrideType };
       else migrated[k] = v as InvoiceOverride;
     }
     _cache = { version: 2, overrides: migrated };
     await save();
   } else {
     _cache = { version: 2, overrides: parsed.overrides ?? {} };
   }
 } catch {
   _cache = { version: 2, overrides: {} };
 }
 return _cache;
}

async function save(): Promise<void> {
 if (!_cache) return;
 await fs.writeFile(FILE, JSON.stringify(_cache, null, 2), 'utf8');
}

export async function getCommissionOverrides(): Promise<CommissionOverrides> {
 return load();
}

/** Set or clear the TYPE override for an invoice. type=null clears. */
export async function setCommissionOverride(invoiceNumber: string, type: OverrideType | null): Promise<CommissionOverrides> {
 const c = await load();
 const k = invoiceNumber.trim().toLowerCase();
 if (!k) return c;
 const existing = c.overrides[k] ?? {};
 if (type === null) delete existing.type;
 else existing.type = type;
 if (Object.keys(existing).length === 0) delete c.overrides[k];
 else c.overrides[k] = existing;
 await save();
 return c;
}

/** Set or clear the REP override for an invoice. rep=null/'' clears. */
export async function setCommissionRepOverride(invoiceNumber: string, rep: string | null): Promise<CommissionOverrides> {
 const c = await load();
 const k = invoiceNumber.trim().toLowerCase();
 if (!k) return c;
 const existing = c.overrides[k] ?? {};
 if (!rep) delete existing.rep;
 else existing.rep = rep.trim();
 if (Object.keys(existing).length === 0) delete c.overrides[k];
 else c.overrides[k] = existing;
 await save();
 return c;
}
