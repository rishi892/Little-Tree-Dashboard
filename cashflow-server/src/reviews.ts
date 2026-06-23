/**
 * User reviews / feedback - persisted to disk so the dashboard's Review feature
 * stores data inside our OWN system (no external Google Sheet / Apps Script).
 *
 *   Reviews:     cashflow-server/.reviews.json
 *   Screenshots: cashflow-server/.review-uploads/<id>.<ext>
 *                (served read-only at /api/review-uploads/<file>)
 *
 * Status flow: a new review is "Under process"; the CFO marks it "Resolved"
 * (recording who resolved it + an optional note); then a second person can
 * "Audit" it - verifying the resolution was correct (recording who audited it).
 *   Under process → Resolved (by X) → Audited (by Y)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbSelect, dbSelectOne, dbUpsert } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.resolve(__dirname, '..', '.review-uploads');

export type Review = {
  id: string;
  at: string;
  kind: 'review' | 'audit';
  verdict: string; // audits: 'correct' | 'issue'; reviews: ''
  user: string;
  role: string;
  page: string;
  section: string;
  tab: string;
  subtab: string;
  comment: string;
  screenshot: string; // '' or '/api/review-uploads/<file>'
  status: 'Under process' | 'Resolved' | 'Audited';
  resolvedBy: string;
  resolvedAt: string;
  note: string;
  auditedBy: string;
  auditedAt: string;
  auditNote: string;
};

type Row = Record<string, string>;
function rowToReview(r: Row): Review {
  return {
    id: r.id, at: r.at, kind: r.kind as Review['kind'], verdict: r.verdict, user: r.user_email, role: r.role,
    page: r.page, section: r.section, tab: r.tab, subtab: r.subtab, comment: r.comment,
    screenshot: r.screenshot, status: r.status as Review['status'], resolvedBy: r.resolved_by, resolvedAt: r.resolved_at,
    note: r.note, auditedBy: r.audited_by, auditedAt: r.audited_at, auditNote: r.audit_note,
  };
}
function reviewToRow(v: Review): Record<string, unknown> {
  return {
    id: v.id, at: v.at, kind: v.kind, verdict: v.verdict, user_email: v.user, role: v.role,
    page: v.page, section: v.section, tab: v.tab, subtab: v.subtab, comment: v.comment,
    screenshot: v.screenshot, status: v.status, resolved_by: v.resolvedBy, resolved_at: v.resolvedAt,
    note: v.note, audited_by: v.auditedBy, audited_at: v.auditedAt, audit_note: v.auditNote,
  };
}

/** All reviews, newest first. */
export async function loadReviews(): Promise<Review[]> {
  const rows = await dbSelect<Row>('reviews', 'order=at.desc');
  return rows.map(rowToReview);
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp',
};

export async function addReview(p: Record<string, unknown>): Promise<Review> {
  // Sanitize the id HARD - it becomes a filename, so strip anything that could
  // escape the upload dir (path traversal). Only [A-Za-z0-9_-], capped length.
  const id = (String(p.id ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80))
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  let screenshot = '';
  const dataUrl = typeof p.screenshot === 'string' ? p.screenshot : '';
  if (dataUrl.startsWith('data:image/')) {
    const m = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.*)$/);
    if (m) {
      // Screenshots are written to local disk. On a read-only serverless
      // filesystem this throws - in that case we keep the review text and skip
      // the image rather than failing the whole request.
      try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        const ext = EXT[m[1]] || 'png';
        const file = `${id}.${ext}`;
        await fs.writeFile(path.join(UPLOAD_DIR, file), Buffer.from(m[2], 'base64'));
        screenshot = `/api/review-uploads/${file}`;
      } catch {
        /* serverless: no persistent disk for uploads */
      }
    }
  }

  const review: Review = {
    id,
    at: String(p.at || new Date().toISOString()),
    kind: p.kind === 'audit' ? 'audit' : 'review',
    verdict: String(p.verdict || ''),
    user: String(p.user || ''),
    role: String(p.role || ''),
    page: String(p.page || ''),
    section: String(p.section || ''),
    tab: String(p.tab || ''),
    subtab: String(p.subtab || ''),
    comment: String(p.comment || ''),
    screenshot,
    status: 'Under process',
    resolvedBy: '',
    resolvedAt: '',
    note: '',
    auditedBy: '',
    auditedAt: '',
    auditNote: '',
  };

  await dbUpsert('reviews', reviewToRow(review));
  return review;
}

export async function resolveReview(id: string, resolvedBy: string, note: string): Promise<Review | null> {
  const row = await dbSelectOne<Row>('reviews', `id=eq.${encodeURIComponent(id)}`);
  if (!row) return null;
  const r = rowToReview(row);
  r.status = 'Resolved';
  r.resolvedBy = resolvedBy || '';
  r.resolvedAt = new Date().toISOString();
  r.note = note || '';
  await dbUpsert('reviews', reviewToRow(r));
  return r;
}

/** Second sign-off: a (preferably different) person verifies the resolution. */
export async function auditReview(id: string, auditedBy: string, auditNote: string): Promise<Review | null> {
  const row = await dbSelectOne<Row>('reviews', `id=eq.${encodeURIComponent(id)}`);
  if (!row) return null;
  const r = rowToReview(row);
  r.status = 'Audited';
  r.auditedBy = auditedBy || '';
  r.auditedAt = new Date().toISOString();
  r.auditNote = auditNote || '';
  await dbUpsert('reviews', reviewToRow(r));
  return r;
}
