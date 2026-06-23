/**
 * Collections-agency handoffs - when an old (180+ day) invoice is handed over to
 * a collections agency, it's recorded here so the dashboard can track what's been
 * sent. Stored in our own system (no external sheet).
 *   Storage: cashflow-server/.agency-handoffs.json   (keyed by invoice #)
 */
import { dbSelect, dbUpsert, dbDelete } from './db.js';

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

type Row = { inv_no: string; vendor: string; amount: number; days_overdue: number | null; agency: string; note: string; handed_by: string; handed_at: string };
const toHandoff = (r: Row): Handoff => ({ invNo: r.inv_no, vendor: r.vendor, amount: Number(r.amount), daysOverdue: r.days_overdue == null ? null : Number(r.days_overdue), agency: r.agency, note: r.note, handedBy: r.handed_by, handedAt: r.handed_at });

export async function loadHandoffs(): Promise<Handoff[]> {
  const rows = await dbSelect<Row>('agency_handoffs', 'order=handed_at.desc');
  return rows.map(toHandoff);
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
  await dbUpsert('agency_handoffs', {
    inv_no: handoff.invNo, vendor: handoff.vendor, amount: handoff.amount, days_overdue: handoff.daysOverdue,
    agency: handoff.agency, note: handoff.note, handed_by: handoff.handedBy, handed_at: handoff.handedAt,
  });
  return handoff;
}

export async function removeHandoff(invNo: string): Promise<boolean> {
  const inv = String(invNo).trim();
  await dbDelete('agency_handoffs', `inv_no=eq.${encodeURIComponent(inv)}`);
  return true;
}
