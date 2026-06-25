import { useEffect, useMemo, useState } from 'react';
import {
 fetchMappedExpenses, fetchExpenseOverrides, saveExpenseOverrides,
 type MappedExpensesResult, type ExpenseOverrides,
} from '../api';
import { formatCurrency } from '../format';

/** Monthly run-rate baseline = average of the last 3 non-zero months. */
const last3Avg = (vals: number[]): number => {
 const slice = vals.slice(-3).filter((v) => v !== 0);
 if (slice.length === 0) return 0;
 return slice.reduce((s, v) => s + v, 0) / slice.length;
};

/**
 * Expenses → Edit. Lists every expense head with its QB monthly run-rate and a
 * single editable monthly-amount override. Saved to the server; display-only
 * (does not change the cashflow). Empty field = use the QB number.
 */
export function ExpenseEditPage() {
 const [data, setData] = useState<MappedExpensesResult | null>(null);
 const [overrides, setOverrides] = useState<ExpenseOverrides>({});
 const [edits, setEdits] = useState<Record<string, string>>({}); // head -> raw input
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [saving, setSaving] = useState(false);
 const [savedAt, setSavedAt] = useState<number | null>(null);

 async function load() {
 setLoading(true);
 setError(null);
 try {
 const [mapped, ov] = await Promise.all([
 fetchMappedExpenses('Combined', {}),
 fetchExpenseOverrides(),
 ]);
 setData(mapped);
 setOverrides(ov);
 } catch (e) {
 setError(e instanceof Error ? e.message : 'Failed to load');
 } finally {
 setLoading(false);
 }
 }
 useEffect(() => { void load(); }, []);

 // Head list: categories with a positive run-rate, biggest first.
 const heads = useMemo(() => {
 if (!data) return [];
 return data.rows
 .map((r) => ({ head: r.category, group: r.group, qbMonthly: last3Avg(r.values) }))
 .filter((h) => h.qbMonthly > 0)
 .sort((a, b) => b.qbMonthly - a.qbMonthly);
 }, [data]);

 const parse = (raw: string): number | null => {
 const n = Number(raw.replace(/[$,\s]/g, ''));
 return raw.trim() !== '' && Number.isFinite(n) ? n : null;
 };

 // Effective monthly = pending edit > saved override > QB baseline.
 const effective = (head: string, qb: number): number => {
 if (head in edits) { const n = parse(edits[head]); return n ?? qb; }
 return overrides[head]?.value ?? qb;
 };
 const isOverridden = (head: string): boolean =>
 (head in edits ? parse(edits[head]) != null : false) || (!(head in edits) && head in overrides);
 const byNote = (head: string): string | null => {
 if (head in edits) return null;
 const o = overrides[head];
 if (!o) return null;
 const when = (() => { try { return new Date(o.at).toLocaleDateString(); } catch { return ''; } })();
 return `${o.by}${when ? ` · ${when}` : ''}`;
 };

 const dirty = Object.keys(edits).length > 0;

 async function onSave() {
 setSaving(true);
 setError(null);
 try {
 const qb: Record<string, number> = {};
 for (const h of heads) qb[h.head] = h.qbMonthly;
 const values: Record<string, number> = {};
 for (const [head, o] of Object.entries(overrides)) values[head] = o.value;
 for (const [head, raw] of Object.entries(edits)) {
 if (raw.trim() === '') { delete values[head]; continue; }
 const n = parse(raw);
 if (n == null) continue;
 // Typed back to the computed number → not an override; drop it.
 if (Math.round(n) === Math.round(qb[head] ?? Number.NaN)) delete values[head];
 else values[head] = n;
 }
 const saved = await saveExpenseOverrides(values);
 setOverrides(saved);
 setEdits({});
 setSavedAt(Date.now());
 } catch (e) {
 setError(e instanceof Error ? e.message : 'Save failed');
 } finally {
 setSaving(false);
 }
 }

 const grandQb = heads.reduce((s, h) => s + h.qbMonthly, 0);
 const grandEff = heads.reduce((s, h) => s + effective(h.head, h.qbMonthly), 0);

 if (loading && !data) {
 return <div className="page-head"><div><h1 className="page-title">Edit Expenses</h1><div className="page-sub">Loading…</div></div></div>;
 }
 if (error && !data) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Edit Expenses</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => void load()}>Retry</button>
 </>
 );
 }

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Edit Expenses</h1>
 <div className="page-sub">
 Type a monthly amount to override any head. Blank = use the QuickBooks number.
 Edits are saved here only — they do <strong>not</strong> change the cashflow.
 </div>
 </div>
 <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
 {savedAt && !dirty && <span style={{ color: '#059669', fontSize: 13, fontWeight: 600 }}>Saved ✓</span>}
 <button className="btn" onClick={() => void onSave()} disabled={saving || !dirty}>
 {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
 </button>
 </div>
 </div>

 {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}

 <div className="section">
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th style={{ minWidth: 260 }}>Expense head</th>
 <th>Group</th>
 <th className="num">QB monthly<div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>last 3-mo avg</div></th>
 <th className="num" style={{ minWidth: 150 }}>Your monthly</th>
 <th className="num">Effective</th>
 <th></th>
 </tr>
 </thead>
 <tbody>
 {heads.map((h) => {
 const eff = effective(h.head, h.qbMonthly);
 // "Overridden" only when the effective value really differs from QB, so a
 // focus-fill left unchanged doesn't look edited.
 const over = Math.round(eff) !== Math.round(h.qbMonthly);
 const raw = h.head in edits ? edits[h.head] : (overrides[h.head] != null ? String(overrides[h.head].value) : '');
 const note = byNote(h.head);
 return (
 <tr key={h.head} style={over ? { background: 'var(--accent-soft, #ecfdf5)' } : undefined}>
 <td>{h.head}{note && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--muted)' }}>· {note}</span>}</td>
 <td><span className={`pill-tag tag-${h.group === 'Payroll' ? 'strong' : 'fuzzy'}`}>{h.group}</span></td>
 <td className="num">{formatCurrency(h.qbMonthly)}</td>
 <td className="num">
 <input
 type="text"
 inputMode="decimal"
 value={raw}
 placeholder={formatCurrency(h.qbMonthly)}
 // Fill with the current value on focus so you can backspace the last
 // digit(s) instead of retyping the whole number.
 onFocus={() => setEdits((p) => (h.head in p ? p : { ...p, [h.head]: String(Math.round(overrides[h.head]?.value ?? h.qbMonthly)) }))}
 onChange={(e) => setEdits((p) => ({ ...p, [h.head]: e.target.value }))}
 style={{
 width: 130, textAlign: 'right', padding: '5px 8px', borderRadius: 6,
 border: `1px solid ${over ? 'var(--accent, #059669)' : 'var(--border)'}`,
 background: 'var(--bg)', color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
 }}
 />
 </td>
 <td className="num" style={{ fontWeight: over ? 700 : 400, color: over ? 'var(--accent-hover, #047857)' : undefined }}>
 {formatCurrency(eff)}
 </td>
 <td className="num">
 {over && (
 <button
 type="button"
 title="Reset to QB value"
 onClick={() => setEdits((p) => ({ ...p, [h.head]: '' }))}
 style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', textDecoration: 'underline dotted', fontSize: 12 }}
 >
 reset
 </button>
 )}
 </td>
 </tr>
 );
 })}
 <tr className="total-row" style={{ fontSize: 14 }}>
 <td><strong>TOTAL / month</strong></td>
 <td></td>
 <td className="num"><strong>{formatCurrency(grandQb)}</strong></td>
 <td></td>
 <td className="num"><strong>{formatCurrency(grandEff)}</strong></td>
 <td></td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 </>
 );
}
