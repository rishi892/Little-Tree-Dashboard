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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '.reviews.json');
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

let cache: Review[] | null = null;

async function read(): Promise<Review[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, 'utf8')) as Review[];
  } catch {
    cache = [];
  }
  return cache;
}

async function write(list: Review[]): Promise<void> {
  cache = list;
  await fs.writeFile(FILE, JSON.stringify(list, null, 2), 'utf8');
}

/** All reviews, newest first. */
export async function loadReviews(): Promise<Review[]> {
  const list = await read();
  return [...list].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
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
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      const ext = EXT[m[1]] || 'png';
      const file = `${id}.${ext}`;
      await fs.writeFile(path.join(UPLOAD_DIR, file), Buffer.from(m[2], 'base64'));
      screenshot = `/api/review-uploads/${file}`;
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

  const list = await read();
  list.push(review);
  await write(list);
  return review;
}

export async function resolveReview(id: string, resolvedBy: string, note: string): Promise<Review | null> {
  const list = await read();
  const r = list.find((x) => x.id === id);
  if (!r) return null;
  r.status = 'Resolved';
  r.resolvedBy = resolvedBy || '';
  r.resolvedAt = new Date().toISOString();
  r.note = note || '';
  await write(list);
  return r;
}

/** Second sign-off: a (preferably different) person verifies the resolution. */
export async function auditReview(id: string, auditedBy: string, auditNote: string): Promise<Review | null> {
  const list = await read();
  const r = list.find((x) => x.id === id);
  if (!r) return null;
  r.status = 'Audited';
  r.auditedBy = auditedBy || '';
  r.auditedAt = new Date().toISOString();
  r.auditNote = auditNote || '';
  await write(list);
  return r;
}
