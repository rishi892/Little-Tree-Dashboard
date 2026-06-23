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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '.brand-emails.json');

export type BrandEmails = Record<string, string>;

let cache: BrandEmails | null = null;

export async function loadBrandEmails(): Promise<BrandEmails> {
 if (cache) return cache;
 try {
 const raw = await fs.readFile(FILE, 'utf8');
 const parsed = JSON.parse(raw) as BrandEmails;
 // Clean junk values ("N/A", "DO NOT EMAIL …", malformed multi-emails, etc.)
 // before exposing the registry. Preserves the cleaned form back to disk so
 // the file stays tidy.
 const cleaned: BrandEmails = {};
 let needsRewrite = false;
 for (const [brand, raw] of Object.entries(parsed)) {
 const c = cleanEmail(raw);
 if (c) {
 cleaned[brand] = c;
 if (c !== raw) needsRewrite = true;
 } else {
 needsRewrite = true; // dropping this entry
 }
 }
 cache = cleaned;
 if (needsRewrite) {
 await fs.writeFile(FILE, JSON.stringify(cleaned, null, 2), 'utf8').catch(() => {});
 }
 return cache;
 } catch {
 cache = {};
 return cache;
 }
}

export async function setBrandEmail(brand: string, email: string): Promise<BrandEmails> {
 const all = await loadBrandEmails();
 const clean = email.trim();
 if (!clean) {
 delete all[brand];
 } else {
 all[brand] = clean;
 }
 cache = { ...all };
 await fs.writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
 return cache;
}

export async function setBrandEmailsBulk(updates: BrandEmails): Promise<BrandEmails> {
 const all = await loadBrandEmails();
 for (const [brand, email] of Object.entries(updates)) {
 const clean = (email ?? '').trim();
 if (!clean) delete all[brand];
 else all[brand] = clean;
 }
 cache = { ...all };
 await fs.writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
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
 let changed = false;
 for (const [brand, email] of Object.entries(discovered)) {
 const clean = cleanEmail(email);
 if (!clean) continue;
 if (all[brand]) continue; // never overwrite an existing registry entry
 all[brand] = clean;
 changed = true;
 }
 if (changed) {
 cache = { ...all };
 await fs.writeFile(FILE, JSON.stringify(cache, null, 2), 'utf8');
 } else {
 cache = all;
 }
 return cache;
}
