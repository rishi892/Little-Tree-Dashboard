import { useEffect, useMemo, useState } from 'react';
import {
 fetchCashflow13, fetchCashflowEdits, saveCashflowEdits,
 type Cashflow13, type CashflowEdits,
} from '../api';
import { formatCurrency } from '../format';

// The two 13-week inflow rows this tab edits. Edits go to the SAME unified
// cashflow-edits store the 13-week grid uses, so a change in either place shows
// in both - and each carries the editor's name.
const SALES_RX = /^sales \(this week/i;   // "Sales (this week, forecast)"
const AR_RX = /past ar/i;                 // "Past AR Collections (lag-curve)"

export function SalesArEditPage() {
 const [data, setData] = useState<Cashflow13 | null>(null);
 const [edits, setEdits] = useState<CashflowEdits>({});           // server store (label|weekStart -> {value,by,at})
 const [buf, setBuf] = useState<Record<string, string>>({});      // pending raw inputs, keyed by full edit-key
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [saving, setSaving] = useState(false);
 const [savedAt, setSavedAt] = useState<number | null>(null);

 async function load() {
 setLoading(true);
 setError(null);
 try {
 const [cf, e] = await Promise.all([fetchCashflow13({ direction: 'future' }), fetchCashflowEdits()]);
 setData(cf);
 setEdits(e ?? {});
 } catch (err) {
 setError(err instanceof Error ? err.message : 'Failed to load');
 } finally {
 setLoading(false);
 }
 }
 useEffect(() => {
 void load();
 const onFocus = () => { if (Object.keys(buf).length === 0) void load(); };
 window.addEventListener('focus', onFocus);
 return () => window.removeEventListener('focus', onFocus);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, []);

 const labels = useMemo(() => {
 const salesRow = data?.inflows.find((l) => SALES_RX.test(l.label));
 const arRow = data?.inflows.find((l) => AR_RX.test(l.label));
 return { sales: salesRow?.label ?? 'Sales (this week, forecast)', ar: arRow?.label ?? 'Past AR Collections (lag-curve)' };
 }, [data]);

 const rows = useMemo(() => {
 if (!data) return [];
 const salesRow = data.inflows.find((l) => SALES_RX.test(l.label));
 const arRow = data.inflows.find((l) => AR_RX.test(l.label));
 return data.weeks.map((w, i) => ({
 week: w.start,
 label: `Wk ${i + 1}`,
 range: `${w.start.slice(5).replace('-', '/')}–${w.end.slice(5).replace('-', '/')}`,
 salesKey: `${labels.sales}|${w.start}`,
 arKey: `${labels.ar}|${w.start}`,
 salesQb: salesRow?.values[i] ?? 0,
 arQb: arRow?.values[i] ?? 0,
 }));
 }, [data, labels]);

 // QB baseline per edit-key, so a save can drop edits that equal the computed
 // number (i.e. the user typed it back to baseline = no override).
 const qbByKey = useMemo(() => {
 const m: Record<string, number> = {};
 for (const r of rows) { m[r.salesKey] = r.salesQb; m[r.arKey] = r.arQb; }
 return m;
 }, [rows]);

 const parse = (raw: string): number | null => {
 const n = Number(raw.replace(/[$,\s]/g, ''));
 return raw.trim() !== '' && Number.isFinite(n) ? n : null;
 };
 const eff = (key: string, qb: number): number => {
 if (key in buf) { const n = parse(buf[key]); return n ?? qb; }
 return edits[key]?.value ?? qb;
 };
 const over = (key: string): boolean => (key in buf ? parse(buf[key]) != null : key in edits);
 const byNote = (key: string): string | null => {
 const e = !(key in buf) ? edits[key] : undefined;
 if (!e) return null;
 const when = (() => { try { return new Date(e.at).toLocaleDateString(); } catch { return ''; } })();
 return `${e.by}${when ? ` · ${when}` : ''}`;
 };

 const dirty = Object.keys(buf).length > 0;

 async function onSave() {
 setSaving(true);
 setError(null);
 try {
 const set: Record<string, number> = {};
 const clear: string[] = [];
 for (const [key, raw] of Object.entries(buf)) {
 if (raw.trim() === '') { clear.push(key); continue; }
 const n = parse(raw);
 if (n == null) continue;
 // Typed back to the computed number → not an override; drop it.
 if (Math.round(n) === Math.round(qbByKey[key] ?? Number.NaN)) clear.push(key);
 else set[key] = n;
 }
 const saved = await saveCashflowEdits(set, clear);
 setEdits(saved);
 setBuf({});
 setSavedAt(Date.now());
 } catch (e) {
 setError(e instanceof Error ? e.message : 'Save failed');
 } finally {
 setSaving(false);
 }
 }

 const cellInput = (key: string, qb: number) => {
 // Highlight only when the effective value actually differs from the computed
 // number (so a focus-fill that's left unchanged doesn't look "overridden").
 const isOver = Math.round(eff(key, qb)) !== Math.round(qb);
 const raw = key in buf ? buf[key] : (edits[key]?.value != null ? String(edits[key].value) : '');
 return (
 <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
 <input
 type="text" inputMode="decimal" value={raw} placeholder={formatCurrency(qb)}
 // Fill the input with the current value on focus, so you can backspace the
 // last digit(s) instead of retyping the whole number.
 onFocus={() => setBuf((p) => (key in p ? p : { ...p, [key]: String(Math.round(edits[key]?.value ?? qb)) }))}
 onChange={(e) => setBuf((p) => ({ ...p, [key]: e.target.value }))}
 style={{
 width: 120, textAlign: 'right', padding: '5px 8px', borderRadius: 6,
 border: `1px solid ${isOver ? 'var(--accent, #059669)' : 'var(--border)'}`,
 background: 'var(--bg)', color: 'var(--text)', fontVariantNumeric: 'tabular-nums',
 }}
 />
 {byNote(key) && <span style={{ fontSize: 9, color: 'var(--muted)' }}>{byNote(key)}</span>}
 </div>
 );
 };

 if (loading && !data) {
 return <div className="page-head"><div><h1 className="page-title">Edit Sales &amp; AR</h1><div className="page-sub">Loading…</div></div></div>;
 }
 if (error && !data) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">Edit Sales &amp; AR</h1></div></div>
 <div className="error">{error}</div>
 <button className="btn ghost" onClick={() => void load()}>Retry</button>
 </>
 );
 }

 const salesQbTot = rows.reduce((s, r) => s + r.salesQb, 0);
 const arQbTot = rows.reduce((s, r) => s + r.arQb, 0);
 const salesEffTot = rows.reduce((s, r) => s + eff(r.salesKey, r.salesQb), 0);
 const arEffTot = rows.reduce((s, r) => s + eff(r.arKey, r.arQb), 0);

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Edit Sales &amp; AR</h1>
 <div className="page-sub">
 The <strong>Sales (this week)</strong> and <strong>Past AR Collections</strong> rows that feed the 13-Week
 cashflow. Override any week — the edit shows in both tabs and is saved with your name. Blank = computed number.
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
 <th style={{ minWidth: 150 }}>Week</th>
 <th className="num">Sales (computed)<div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>gross, this week</div></th>
 <th className="num" style={{ minWidth: 130 }}>Your Sales</th>
 <th className="num">Past AR (computed)<div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>collections</div></th>
 <th className="num" style={{ minWidth: 130 }}>Your AR</th>
 </tr>
 </thead>
 <tbody>
 {rows.map((r) => (
 <tr key={r.week}>
 <td><strong>{r.label}</strong><div style={{ fontSize: 11, color: 'var(--muted)' }}>{r.range}</div></td>
 <td className="num">{formatCurrency(r.salesQb)}</td>
 <td className="num">{cellInput(r.salesKey, r.salesQb)}</td>
 <td className="num">{formatCurrency(r.arQb)}</td>
 <td className="num">{cellInput(r.arKey, r.arQb)}</td>
 </tr>
 ))}
 <tr className="total-row" style={{ fontSize: 14 }}>
 <td><strong>13-week total</strong></td>
 <td className="num"><strong>{formatCurrency(salesQbTot)}</strong></td>
 <td className="num"><strong>{formatCurrency(salesEffTot)}</strong></td>
 <td className="num"><strong>{formatCurrency(arQbTot)}</strong></td>
 <td className="num"><strong>{formatCurrency(arEffTot)}</strong></td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 </>
 );
}
