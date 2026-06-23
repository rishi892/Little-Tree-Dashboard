/**
 * Per-invoice commission overrides.
 *
 * Each invoice can have:
 *   - type: NEW / OLD / WHITELABEL (overrides auto-detection)
 *   - rep:  rep name (when system can't find one)
 *
 * Stored on disk in .commission-overrides.json so they survive restart.
 */

import { dbSelect, dbUpsert, dbDelete } from './db.js';

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

type Row = { invoice_number: string; type: string | null; rep: string | null };

async function load(): Promise<CommissionOverrides> {
 if (_cache) return _cache;
 const rows = await dbSelect<Row>('commission_overrides');
 const overrides: Record<string, InvoiceOverride> = {};
 for (const r of rows) {
   overrides[r.invoice_number] = {
     ...(r.type ? { type: r.type as OverrideType } : {}),
     ...(r.rep ? { rep: r.rep } : {}),
   };
 }
 _cache = { version: 2, overrides };
 return _cache;
}

async function persistRow(k: string, ov: InvoiceOverride): Promise<void> {
 if (!ov.type && !ov.rep) await dbDelete('commission_overrides', `invoice_number=eq.${encodeURIComponent(k)}`);
 else await dbUpsert('commission_overrides', { invoice_number: k, type: ov.type ?? null, rep: ov.rep ?? '' });
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
 if (!existing.type && !existing.rep) delete c.overrides[k];
 else c.overrides[k] = existing;
 await persistRow(k, existing);
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
 if (!existing.type && !existing.rep) delete c.overrides[k];
 else c.overrides[k] = existing;
 await persistRow(k, existing);
 return c;
}
