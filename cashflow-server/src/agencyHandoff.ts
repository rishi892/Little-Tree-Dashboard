/**
 * Collections-agency handoffs - when an old (180+ day) invoice is handed over to
 * a collections agency, it's recorded here so the dashboard can track what's been
 * sent. Stored in our own system (no external sheet).
 *   Storage: cashflow-server/.agency-handoffs.json   (keyed by invoice #)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '..', '.agency-handoffs.json');

export type Handoff = {
  invNo: string;
  vendor: string;
  amount: number;
  daysOverdue: number | null;
  agency: string;
  note: string;
  handedBy: string;
  handedAt: string;
};

let cache: Handoff[] | null = null;

async function read(): Promise<Handoff[]> {
  if (cache) return cache;
  try { cache = JSON.parse(await fs.readFile(FILE, 'utf8')) as Handoff[]; }
  catch { cache = []; }
  return cache;
}
async function write(list: Handoff[]): Promise<void> {
  cache = list;
  await fs.writeFile(FILE, JSON.stringify(list, null, 2), 'utf8');
}

export async function loadHandoffs(): Promise<Handoff[]> {
  const list = await read();
  return [...list].sort((a, b) => (b.handedAt || '').localeCompare(a.handedAt || ''));
}

export async function addHandoff(p: Record<string, unknown>): Promise<Handoff> {
  const invNo = String(p.invNo || '').trim();
  if (!invNo) throw new Error('invNo required');
  const handoff: Handoff = {
    invNo,
    vendor: String(p.vendor || ''),
    amount: Number(p.amount) || 0,
    daysOverdue: p.daysOverdue == null ? null : Number(p.daysOverdue),
    agency: String(p.agency || ''),
    note: String(p.note || ''),
    handedBy: String(p.handedBy || ''),
    handedAt: String(p.handedAt || new Date().toISOString()),
  };
  const list = await read();
  const i = list.findIndex((x) => x.invNo === invNo);
  if (i >= 0) list[i] = handoff; else list.push(handoff); // upsert
  await write(list);
  return handoff;
}

export async function removeHandoff(invNo: string): Promise<boolean> {
  const list = await read();
  const next = list.filter((x) => x.invNo !== String(invNo).trim());
  if (next.length === list.length) return false;
  await write(next);
  return true;
}
