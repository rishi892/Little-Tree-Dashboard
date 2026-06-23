/**
 * Brand → email registry - persistent map of brand name to AR contact email.
 *
 * Stored as a JSON file on disk so emails survive server restarts. Emails
 * don't change often - once set per brand, all that brand's invoices use
 * the same address for reminders. Sheet's per-invoice email column is the
 * INITIAL source (auto-seed), but user can override here without editing
 * the sheet.
 *
 * Used by: AR aging UI (show + edit email per brand), reminder sender
 * (future), audit trail.
 */

import { dbSelect, dbUpsert, dbDelete } from './db.js';

export type BrandEmails = Record<string, string>;

let cache: BrandEmails | null = null;
type Row = { brand: string; email: string };

export async function loadBrandEmails(): Promise<BrandEmails> {
 if (cache) return cache;
 const rows = await dbSelect<Row>('brand_emails');
 const all: BrandEmails = {};
 for (const r of rows) {
 const c = cleanEmail(r.email);
 if (c) all[r.brand] = c;
 }
 cache = all;
 return cache;
}

export async function setBrandEmail(brand: string, email: string): Promise<BrandEmails> {
 const all = await loadBrandEmails();
 const clean = email.trim();
 if (!clean) {
 delete all[brand];
 await dbDelete('brand_emails', `brand=eq.${encodeURIComponent(brand)}`);
 } else {
 all[brand] = clean;
 await dbUpsert('brand_emails', { brand, email: clean });
 }
 cache = { ...all };
 return cache;
}

export async function setBrandEmailsBulk(updates: BrandEmails): Promise<BrandEmails> {
 const all = await loadBrandEmails();
 const ups: Row[] = [];
 const dels: string[] = [];
 for (const [brand, email] of Object.entries(updates)) {
 const clean = (email ?? '').trim();
 if (!clean) { delete all[brand]; dels.push(brand); }
 else { all[brand] = clean; ups.push({ brand, email: clean }); }
 }
 if (ups.length) await dbUpsert('brand_emails', ups);
 for (const b of dels) await dbDelete('brand_emails', `brand=eq.${encodeURIComponent(b)}`);
 cache = { ...all };
 return cache;
}

/** Normalise a raw email cell from the sheet:
 * - Strip leading/trailing whitespace + newlines
 * - Collapse internal whitespace inside multi-email "a@x.com,\n b@y.com" strings
 * - Reject obvious junk: "N/A", "n/a", "-", "DO NOT EMAIL …", "TBD", etc.
 * - Require at least one '@' and one '.' in the local part of any address.
 * Returns '' when the value isn't usable. */
function cleanEmail(raw: string | undefined): string {
 let s = (raw ?? '').trim();
 if (!s) return '';
 // Collapse internal whitespace (newlines + multiple spaces) to single space.
 s = s.replace(/\s+/g, ' ').trim();
 if (s.length < 5) return '';
 if (/^(n\/a|tbd|none|do\s*not\s*email|already\s*in\s*collections|-)$/i.test(s)) return '';
 if (/do\s*not\s*email/i.test(s)) return ''; // mid-string "DO NOT EMAIL ALREDY IN COLLECTIONS"
 // Validate at least one address-looking token.
 const hasAddress = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(s);
 if (!hasAddress) return '';
 return s;
}

/** Seed missing brand emails from the invoice tracker's per-invoice email column.
 * Takes a map of (brand → discovered raw email from sheet). Only fills brands
 * that DON'T already have an email set in the registry - never overwrites
 * manual edits. Junk values ("N/A", "DO NOT EMAIL", etc.) are filtered out. */
export async function seedFromSheet(discovered: BrandEmails): Promise<BrandEmails> {
 const all = await loadBrandEmails();
 const ups: Row[] = [];
 for (const [brand, email] of Object.entries(discovered)) {
 const clean = cleanEmail(email);
 if (!clean) continue;
 if (all[brand]) continue; // never overwrite an existing registry entry
 all[brand] = clean;
 ups.push({ brand, email: clean });
 }
 if (ups.length) { await dbUpsert('brand_emails', ups); cache = { ...all }; }
 else cache = all;
 return cache;
}
