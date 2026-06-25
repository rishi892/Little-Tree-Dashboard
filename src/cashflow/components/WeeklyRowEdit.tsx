import { useEffect, useMemo, useState } from 'react';
import {
 fetchCashflow13, fetchCashflowEdits, saveCashflowEdits,
 type Cashflow13, type CashflowEdits,
} from '../api';
import { formatCurrency } from '../format';

/**
 * Editable weekly table for ONE 13-week cashflow row (matched by `rowRx`), laid
 * out like the 13-Week grid: weeks across as columns, a "Computed" row and a
 * "Your value" editable row. Writes to the shared cashflow-edits store
 * (Supabase, attributed) so edits also show on the 13-Week grid and vice versa.
 */
export function WeeklyRowEdit({ rowRx, heading, sub }: { rowRx: RegExp; heading: string; sub: string }) {
 const [data, setData] = useState<Cashflow13 | null>(null);
 const [edits, setEdits] = useState<CashflowEdits>({});
 const [buf, setBuf] = useState<Record<string, string>>({});
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [saving, setSaving] = useState(false);
 const [savedAt, setSavedAt] = useState<number | null>(null);

 async function load() {
 setLoading(true); setError(null);
 try {
 const [cf, e] = await Promise.all([fetchCashflow13({ direction: 'future' }), fetchCashflowEdits()]);
 setData(cf); setEdits(e ?? {});
 } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load'); }
 finally { setLoading(false); }
 }
 useEffect(() => {
 void load();
 const reload = () => void load();
 window.addEventListener('focus', reload);
 window.addEventListener('cashflow-edits-changed', reload);   // linked: another view saved
 return () => { window.removeEventListener('focus', reload); window.removeEventListener('cashflow-edits-changed', reload); };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const label = useMemo(() => data?.inflows.find((l) => rowRx.test(l.label))?.label ?? '', [data, rowRx]);
 const cols = useMemo(() => {
 if (!data) return [];
 const row = data.inflows.find((l) => rowRx.test(l.label));
 return data.weeks.map((w, i) => ({
 wk: `Wk ${i + 1}`,
 range: `${w.start.slice(5).replace('-', '/')}`,
 key: `${label}|${w.start}`,
 qb: row?.values[i] ?? 0,
 }));
 }, [data, label, rowRx]);

 const parse = (raw: string): number | null => {
 const n = Number(raw.replace(/[$,\s]/g, ''));
 return raw.trim() !== '' && Number.isFinite(n) ? n : null;
 };
 const eff = (key: string, qb: number): number => {
 if (key in buf) { const n = parse(buf[key]); return n ?? qb; }
 return edits[key]?.value ?? qb;
 };
 const dirty = Object.keys(buf).length > 0;

 async function onSave() {
 setSaving(true); setError(null);
 try {
 const qbByKey: Record<string, number> = {};
 for (const c of cols) qbByKey[c.key] = c.qb;
 const set: Record<string, number> = {}; const clear: string[] = [];
 for (const [key, raw] of Object.entries(buf)) {
 if (raw.trim() === '') { clear.push(key); continue; }
 const n = parse(raw); if (n == null) continue;
 if (Math.round(n) === Math.round(qbByKey[key] ?? Number.NaN)) clear.push(key); else set[key] = n;
 }
 setEdits(await saveCashflowEdits(set, clear));
 setBuf({}); setSavedAt(Date.now());
 } catch (e) { setError(e instanceof Error ? e.message : 'Save failed'); }
 finally { setSaving(false); }
 }

 if (loading && !data) return <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading {heading}…</div>;

 const qbTot = cols.reduce((s, c) => s + c.qb, 0);
 const effTot = cols.reduce((s, c) => s + eff(c.key, c.qb), 0);
 const fmt0 = (n: number) => formatCurrency(Math.round(n));

 return (
 <div className="section">
 <div className="section-head" style={{ alignItems: 'center' }}>
 <div>
 <div className="section-title">{heading}</div>
 <div className="section-sub">{sub} · saved with your name · also shows on the 13-Week grid.</div>
 </div>
 <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
 {savedAt && !dirty && <span style={{ color: '#059669', fontSize: 13, fontWeight: 600 }}>Saved ✓</span>}
 <button className="btn" onClick={() => void onSave()} disabled={saving || !dirty}>
 {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
 </button>
 </div>
 </div>
 {error && <div className="error" style={{ margin: '0 0 10px' }}>{error}</div>}
 <div className="table-wrap">
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>
 <th style={{ position: 'sticky', left: 0, background: 'var(--surface, #f8fafc)', minWidth: 110 }}></th>
 {cols.map((c) => (
 <th key={c.key} className="num" style={{ minWidth: 92 }}>{c.wk}<div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>{c.range}</div></th>
 ))}
 <th className="num" style={{ minWidth: 100 }}>Total</th>
 </tr>
 </thead>
 <tbody>
 <tr>
 <td style={{ position: 'sticky', left: 0, background: 'var(--surface, #f8fafc)', fontWeight: 600 }}>Computed</td>
 {cols.map((c) => <td key={c.key} className="num" style={{ color: 'var(--muted)' }}>{fmt0(c.qb)}</td>)}
 <td className="num"><strong>{fmt0(qbTot)}</strong></td>
 </tr>
 <tr>
 <td style={{ position: 'sticky', left: 0, background: 'var(--surface, #f8fafc)', fontWeight: 600 }}>Your value</td>
 {cols.map((c) => {
 const over = Math.round(eff(c.key, c.qb)) !== Math.round(c.qb);
 const raw = c.key in buf ? buf[c.key] : (edits[c.key]?.value != null ? String(edits[c.key].value) : '');
 return (
 <td key={c.key} className="num" style={{ padding: '3px 4px' }}>
 <input
 type="text" inputMode="decimal" value={raw} placeholder={fmt0(c.qb)}
 onFocus={() => setBuf((p) => (c.key in p ? p : { ...p, [c.key]: String(Math.round(edits[c.key]?.value ?? c.qb)) }))}
 onChange={(e) => setBuf((p) => ({ ...p, [c.key]: e.target.value }))}
 style={{
 width: 82, textAlign: 'right', padding: '4px 6px', borderRadius: 5,
 border: `1px solid ${over ? 'var(--accent, #059669)' : 'var(--border)'}`,
 background: over ? 'var(--accent-soft, #ecfdf5)' : 'var(--bg)', color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
 }}
 />
 </td>
 );
 })}
 <td className="num"><strong style={{ color: 'var(--accent-hover, #047857)' }}>{fmt0(effTot)}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 );
}
