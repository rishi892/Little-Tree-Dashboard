import { useEffect, useMemo, useState } from 'react';
import {
 fetchMappedExpenses, fetchAccountTransactions, fetchInventoryPurchases, fetchPnlExpenses,
 type MappedExpensesResult, type SheetEntity, type AccountTxn,
 type InventoryPurchasesResult, type InventoryTxn, type PnlExpensesResult,
} from '../api';
import { formatCurrency } from '../format';

// Combined view is now driven by YOUR P&L mapping (QB cash basis), not the sheet:
// each category's qbSources are the exact QB accounts you mapped, so the
// per-account bill drill-down (account-transactions) lines up and works.
function pnlToMapped(pnl: PnlExpensesResult): MappedExpensesResult {
 return {
  cached: false,
  asOf: pnl.asOf,
  entity: 'Combined',
  months: pnl.months,
  monthLabels: pnl.monthLabels,
  rows: pnl.categories
   .filter((c) => c.category !== 'Uncategorized')
   .map((c) => ({
    group: /payroll/i.test(c.category) ? 'Payroll' : 'Non-Payroll',
    category: c.category,
    values: c.monthly,
    qbSources: c.accounts.map((a) => ({ name: a.name, total: a.total })),
   })),
  unmatched: [],
 };
}

type Group = 'all' | 'Payroll' | 'Non-Payroll';

type Props = {
 entity: SheetEntity;
 title: string;
 subtitle: string;
 totalLabel: string;
};

type RowDrill = {
 loading: boolean;
 transactions: AccountTxn[];
 purexTotal: number;
 moyshTotal: number;
 unpaidTotal: number;
 monthlyByPaidBy: Record<string, { purex: number; moysh: number; unpaid: number }>;
};

export function MappedExpensesPage({ entity, title, subtitle, totalLabel }: Props) {
 const [data, setData] = useState<MappedExpensesResult | null>(null);
 const [inventory, setInventory] = useState<InventoryPurchasesResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [group, setGroup] = useState<Group>('all');
 const [showSources, setShowSources] = useState(false);
 const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
 const [drill, setDrill] = useState<Record<string, RowDrill>>({});

 async function loadDrillForCategory(category: string, qbSources: Array<{ name: string }>) {
 // Already cached?
 if (drill[category] && !drill[category].loading) return;
 setDrill((d) => ({
 ...d,
 [category]: { loading: true, transactions: [], purexTotal: 0, moyshTotal: 0, unpaidTotal: 0, monthlyByPaidBy: {} },
 }));
 try {
 // Special path: Inventory & Raw Materials → use the dedicated inventory
 // purchases endpoint so the transactions match the row totals exactly.
 if (inventory && /^inventory\s*&\s*raw materials$/i.test(category)) {
 const filtered: InventoryTxn[] = inventory.transactions.filter((t) => {
 if (entity === 'PureX') return t.paidBy === 'PureX';
 if (entity === 'Moysh') return t.paidBy !== 'PureX'; // Moysh-paid + unpaid bills count here
 return true;
 });
 // Adapt InventoryTxn → AccountTxn shape (memo + sourceBank kept; type narrowed).
 const adapted: AccountTxn[] = filtered.map((t) => ({
 txnId: t.txnId,
 txnType: t.txnType,
 date: t.date,
 vendor: t.vendor,
 memo: t.memo ?? t.inventoryAccount,
 amount: t.amount,
 sourceBank: t.sourceBank,
 paidBy: t.paidBy,
 }));
 // Aggregate filtered totals.
 let pTot = 0, mTot = 0, uTot = 0;
 const mbp: Record<string, { purex: number; moysh: number; unpaid: number }> = {};
 for (const t of adapted) {
 const ym = t.date.slice(0, 7);
 if (!mbp[ym]) mbp[ym] = { purex: 0, moysh: 0, unpaid: 0 };
 if (t.paidBy === 'PureX') { pTot += t.amount; mbp[ym].purex += t.amount; }
 else if (t.paidBy === 'Moysh') { mTot += t.amount; mbp[ym].moysh += t.amount; }
 else { uTot += t.amount; mbp[ym].unpaid += t.amount; }
 }
 setDrill((d) => ({
 ...d,
 [category]: { loading: false, transactions: adapted, purexTotal: pTot, moyshTotal: mTot, unpaidTotal: uTot, monthlyByPaidBy: mbp },
 }));
 return;
 }

 // Default path: fetch per-QB-account transactions in parallel.
 const results = await Promise.all(qbSources.map((s) => fetchAccountTransactions(s.name).catch(() => null)));
 const allTxns: AccountTxn[] = [];
 let pTot = 0, mTot = 0, uTot = 0;
 for (const r of results) {
 if (!r) continue;
 allTxns.push(...r.transactions);
 pTot += r.purexTotal;
 mTot += r.moyshTotal;
 uTot += r.unpaidTotal;
 }
 allTxns.sort((a, b) => b.date.localeCompare(a.date));
 // Build month-by-month, paidBy-split
 const monthlyByPaidBy: Record<string, { purex: number; moysh: number; unpaid: number }> = {};
 for (const t of allTxns) {
 const ym = t.date.slice(0, 7);
 if (!monthlyByPaidBy[ym]) monthlyByPaidBy[ym] = { purex: 0, moysh: 0, unpaid: 0 };
 if (t.paidBy === 'PureX') monthlyByPaidBy[ym].purex += t.amount;
 else if (t.paidBy === 'Moysh') monthlyByPaidBy[ym].moysh += t.amount;
 else monthlyByPaidBy[ym].unpaid += t.amount;
 }
 setDrill((d) => ({
 ...d,
 [category]: {
 loading: false,
 transactions: allTxns,
 purexTotal: pTot, moyshTotal: mTot, unpaidTotal: uTot,
 monthlyByPaidBy,
 },
 }));
 } catch (e) {
 setDrill((d) => ({
 ...d,
 [category]: { loading: false, transactions: [], purexTotal: 0, moyshTotal: 0, unpaidTotal: 0, monthlyByPaidBy: {} },
 }));
 }
 }

 function toggleRow(category: string, qbSources: Array<{ name: string; total: number }>) {
 if (expandedCategory === category) {
 setExpandedCategory(null);
 return;
 }
 setExpandedCategory(category);
 void loadDrillForCategory(category, qbSources);
 }

 async function load(refresh = false, silent = false) {
 if (!silent) setLoading(true);
 if (!silent) setError(null);
 // Fetch the mapped expenses first - render the page as soon as that's
 // ready so we don't block on the (potentially slow) inventory call.
 try {
 const mapped = entity === 'Combined'
 ? pnlToMapped(await fetchPnlExpenses({ method: 'Cash', refresh }))
 : await fetchMappedExpenses(entity, { refresh });
 setData(mapped);
 } catch (e) {
 if (!silent) setError(e instanceof Error ? e.message : 'Failed');
 } finally {
 if (!silent) setLoading(false);
 }
 // Inventory loads in the background - once it arrives, the Inventory &
 // Raw Materials row's values + drill-down get filled in.
 fetchInventoryPurchases({ refresh })
 .then((inv) => setInventory(inv))
 .catch(() => { /* silently ignore - row falls back to mapped data */ });
 }
 useEffect(() => {
 load(false);
 // No focus/interval polling - the P&L is not a live ticker, so repeated
 // background loads just churn. Reload (silently) ONLY when a mapping changes
 // (here or in the P&L Mapping tab) so a newly-categorized head flows in at
 // once. Use Refresh for a fresh QB pull.
 const onMappingChanged = () => load(false, true);
 window.addEventListener('category-overrides-changed', onMappingChanged);
 return () => {
 window.removeEventListener('category-overrides-changed', onMappingChanged);
 };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [entity]);

 // Build the effective row list. Inventory & Raw Materials gets its values
 // OVERRIDDEN with actual inventory-purchase data (filtered to the current
 // entity's paid-by) - because QB's COGS P&L line is accrual recognition,
 // not actual cash spent.
 const visible = useMemo(() => {
 if (!data) return [];
 const overrideRows = data.rows.map((r) => {
 if (!inventory) return r;
 if (!/^inventory\s*&\s*raw materials$/i.test(r.category)) return r;
 // Pick the right monthly series for this entity.
 const monthly =
 entity === 'PureX' ? inventory.monthlyPurex
 : entity === 'Moysh' ? inventory.monthlyMoysh
 : inventory.monthlyTotal; // Combined = all
 // Build qbSources from inventory accounts (filtered to this entity's contribution).
 const sources = inventory.byAccount
 .map((a) => ({
 name: a.name,
 total: entity === 'PureX' ? a.purex : entity === 'Moysh' ? a.moysh : a.total,
 }))
 .filter((s) => s.total > 0);
 return {
 ...r,
 values: monthly.slice(0, r.values.length),
 qbSources: sources,
 };
 });
 const byGroup = group === 'all' ? overrideRows : overrideRows.filter((r) => r.group === group);
 return byGroup.filter((r) => {
 const total = r.values.reduce((s, v) => s + v, 0);
 return total > 0;
 });
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [data, inventory, group, entity]);

 const monthCount = data?.months.length ?? 0;
 const empty = useMemo(() => new Array(monthCount).fill(0), [monthCount]);
 const totalsByMonth = useMemo(() => {
 if (!data) return empty;
 return data.months.map((_, i) => visible.reduce((s, r) => s + (r.values[i] ?? 0), 0));
 }, [data, visible, empty]);
 const payrollByMonth = useMemo(() => {
 if (!data) return empty;
 return data.months.map((_, i) => visible.filter((r) => r.group === 'Payroll').reduce((s, r) => s + (r.values[i] ?? 0), 0));
 }, [data, visible, empty]);
 const nonPayrollByMonth = useMemo(() => {
 if (!data) return empty;
 return data.months.map((_, i) => visible.filter((r) => r.group === 'Non-Payroll').reduce((s, r) => s + (r.values[i] ?? 0), 0));
 }, [data, visible, empty]);

 const last3Avg = (vals: number[]) => {
 const slice = vals.slice(-3).filter((v) => v !== 0);
 if (slice.length === 0) return 0;
 return slice.reduce((s, v) => s + v, 0) / slice.length;
 };
 const weeklyAvg = (vals: number[]) => last3Avg(vals) / 4.33;
 // Seasonality windows: how much actually went out over the trailing 12 / 6 / 3
 // months (totals, not averages), so recent trend vs the full year is obvious.
 const sumLast = (vals: number[], n: number) => vals.slice(-n).reduce((s, v) => s + v, 0);

 if (loading && !data) {
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">{title}</h1><div className="page-sub">Loading…</div></div></div>
 </>
 );
 }
 if (error) {
 const isAuth = /not connected|invalid|authorize/i.test(error);
 return (
 <>
 <div className="page-head"><div><h1 className="page-title">{title}</h1></div></div>
 <div className="error">
 {error}
 {isAuth && (<><br /><strong>Reconnect:</strong> <a href="/auth/connect">/auth/connect</a></>)}
 </div>
 <button className="btn ghost" onClick={() => load(true)}>Retry</button>
 </>
 );
 }
 if (!data) return null;

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">{title}</h1>
 <div className="page-sub">
 {subtitle} · {entity === 'Combined' ? 'Derived from PureX + Moysh' : 'Live from QuickBooks'} · {data.monthLabels[0]} – {data.monthLabels[data.monthLabels.length - 1]}
 {data.cached ? ' · cached' : ''}
 </div>
 </div>
 {entity !== 'Combined' && (
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing…' : 'Refresh from QB'}
 </button>
 )}
 </div>

 <div className="section" style={{ padding: '12px 18px' }}>
 <div className="filter-row" style={{ gap: 10 }}>
 {(['all', 'Payroll', 'Non-Payroll'] as const).map((g) => (
 <button key={g} className={`filter-tab ${group === g ? 'active' : ''}`} onClick={() => setGroup(g)}>
 {g === 'all' ? 'All' : g}
 </button>
 ))}
 <span style={{ flex: 1 }} />
 <button className={`filter-tab ${showSources ? 'active' : ''}`} onClick={() => setShowSources((s) => !s)}>
 {showSources ? 'Hide QB sources' : 'Show QB sources'}
 </button>
 </div>
 </div>

 <div className="section">
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th style={{ minWidth: 260 }}>Category</th>
 <th>Group</th>
 {data.monthLabels.map((m) => (<th key={m} className="num">{m}</th>))}
 <th className="num">Total</th>
 <th className="num" style={{ background: '#eef2ff' }}>Last 12mo</th>
 <th className="num" style={{ background: '#eef2ff' }}>Last 6mo</th>
 <th className="num" style={{ background: '#eef2ff' }}>Last 3mo</th>
 <th className="num">Avg/mo</th>
 <th className="num">Weekly avg</th>
 </tr>
 </thead>
 <tbody>
 {visible.map((r) => {
 const total = r.values.reduce((s, v) => s + v, 0);
 const avg = total / Math.max(1, r.values.filter((v) => v !== 0).length);
 const drillable = r.qbSources.length > 0 && total > 0;
 const isExpanded = expandedCategory === r.category;
 const rowDrill = drill[r.category];
 return (
 <>
 <tr
 key={r.category}
 className={r.qbSources.length === 0 ? 'row-none' : ''}
 onClick={drillable ? () => toggleRow(r.category, r.qbSources) : undefined}
 style={{
 cursor: drillable ? 'pointer' : undefined,
 background: isExpanded ? '#fff3d8' : undefined,
 }}
 title={drillable ? 'Click to see every transaction (with paid-by bank)' : undefined}
 >
 <td>
 <div>
 {drillable && <span style={{ marginRight: 6, color: '#945215' }}>{isExpanded ? '▼' : '▶'}</span>}
 {r.category}
 </div>
 {r.qbSources.length === 0 && <div className="vendor-note">no QB match</div>}
 </td>
 <td><span className={`pill-tag tag-${r.group === 'Payroll' ? 'strong' : 'fuzzy'}`}>{r.group}</span></td>
 {r.values.map((v, i) => (<td key={i} className="num">{v ? formatCurrency(v) : '-'}</td>))}
 <td className="num"><strong>{formatCurrency(total)}</strong></td>
 <td className="num" style={{ background: '#f5f7ff' }}>{formatCurrency(Math.round(sumLast(r.values, 12)))}</td>
 <td className="num" style={{ background: '#f5f7ff' }}>{formatCurrency(Math.round(sumLast(r.values, 6)))}</td>
 <td className="num" style={{ background: '#f5f7ff' }}>{formatCurrency(Math.round(sumLast(r.values, 3)))}</td>
 <td className="num">{formatCurrency(Math.round(avg))}</td>
 <td className="num">{formatCurrency(Math.round(weeklyAvg(r.values)))}</td>
 </tr>
 {isExpanded && (
 <tr key={r.category + '-drill'}>
 <td colSpan={data.monthLabels.length + 6 + (entity === 'Combined' ? 2 : 0)} style={{ background: '#fff8e1', padding: '14px 18px' }}>
 {!rowDrill || rowDrill.loading ? (
 <div style={{ color: '#666' }}>Loading transactions for <strong>{r.category}</strong>…</div>
 ) : (
 <DrillPanel
 category={r.category}
 rowDrill={rowDrill}
 months={data.months}
 monthLabels={data.monthLabels}
 categoryTotal={total}
 qbSources={r.qbSources}
 />
 )}
 </td>
 </tr>
 )}
 {showSources && r.qbSources.length > 0 && !isExpanded && (
 <tr key={r.category + '-sources'}>
 <td colSpan={data.monthLabels.length + 6 + (entity === 'Combined' ? 2 : 0)} style={{ background: '#13182a', paddingLeft: 30, fontSize: 11, color: 'var(--muted)' }}>
 QB sources: {r.qbSources.map((s) => `${s.name} (${formatCurrency(s.total)})`).join(' · ')}
 </td>
 </tr>
 )}
 </>
 );
 })}

 {group === 'all' && (
 <>
 <tr className="total-row">
 <td>Payroll subtotal</td>
 <td></td>
 {payrollByMonth.map((v, i) => (<td key={i} className="num">{formatCurrency(v)}</td>))}
 <td className="num"><strong>{formatCurrency(payrollByMonth.reduce((s, v) => s + v, 0))}</strong></td>
 {entity === 'Combined' && (
 <>
 <td className="num" style={{ background: '#f0faf3', color: '#1a6d3c' }}>
 <strong>{formatCurrency(visible.filter((r) => r.group === 'Payroll').reduce((s, r) => s + (r.purexValues ?? []).reduce((a, b) => a + b, 0), 0))}</strong>
 </td>
 <td className="num" style={{ background: '#fef9ef', color: '#945215' }}>
 <strong>{formatCurrency(visible.filter((r) => r.group === 'Payroll').reduce((s, r) => s + (r.moyshValues ?? []).reduce((a, b) => a + b, 0), 0))}</strong>
 </td>
 </>
 )}
 <td colSpan={3}></td>
 </tr>
 <tr className="total-row">
 <td>Non-Payroll subtotal</td>
 <td></td>
 {nonPayrollByMonth.map((v, i) => (<td key={i} className="num">{formatCurrency(v)}</td>))}
 <td className="num"><strong>{formatCurrency(nonPayrollByMonth.reduce((s, v) => s + v, 0))}</strong></td>
 {entity === 'Combined' && (
 <>
 <td className="num" style={{ background: '#f0faf3', color: '#1a6d3c' }}>
 <strong>{formatCurrency(visible.filter((r) => r.group === 'Non-Payroll').reduce((s, r) => s + (r.purexValues ?? []).reduce((a, b) => a + b, 0), 0))}</strong>
 </td>
 <td className="num" style={{ background: '#fef9ef', color: '#945215' }}>
 <strong>{formatCurrency(visible.filter((r) => r.group === 'Non-Payroll').reduce((s, r) => s + (r.moyshValues ?? []).reduce((a, b) => a + b, 0), 0))}</strong>
 </td>
 </>
 )}
 <td colSpan={3}></td>
 </tr>
 </>
 )}

 <tr className="total-row" style={{ fontSize: 14 }}>
 <td>{totalLabel}</td>
 <td></td>
 {totalsByMonth.map((v, i) => (<td key={i} className="num"><strong>{formatCurrency(v)}</strong></td>))}
 <td className="num"><strong>{formatCurrency(totalsByMonth.reduce((s, v) => s + v, 0))}</strong></td>
 {entity === 'Combined' && (
 <>
 <td className="num" style={{ background: '#f0faf3', color: '#1a6d3c' }}>
 <strong>{formatCurrency(visible.reduce((s, r) => s + (r.purexValues ?? []).reduce((a, b) => a + b, 0), 0))}</strong>
 </td>
 <td className="num" style={{ background: '#fef9ef', color: '#945215' }}>
 <strong>{formatCurrency(visible.reduce((s, r) => s + (r.moyshValues ?? []).reduce((a, b) => a + b, 0), 0))}</strong>
 </td>
 </>
 )}
 <td colSpan={3}></td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>

 </>
 );
}

/** Drill-down panel: month-by-month split + per-transaction list with paid-by. */
function DrillPanel({
 rowDrill, months, monthLabels, categoryTotal, qbSources,
}: {
 category: string;
 rowDrill: RowDrill;
 months: string[];
 monthLabels: string[];
 categoryTotal: number;
 qbSources: Array<{ name: string; total: number }>;
}) {
 const { transactions, purexTotal, moyshTotal, unpaidTotal, monthlyByPaidBy } = rowDrill;
 const drillTotal = purexTotal + moyshTotal + unpaidTotal;

 return (
 <>
 <div style={{ display: 'flex', gap: 24, marginBottom: 10, fontSize: 12, color: '#3a4660', flexWrap: 'wrap', alignItems: 'center' }}>
 <span><strong>{transactions.length}</strong> transactions across {qbSources.length} QB account{qbSources.length === 1 ? '' : 's'}</span>
 <span style={{ color: '#1a6d3c' }}>PureX: <strong>{formatCurrency(purexTotal)}</strong></span>
 <span style={{ color: '#945215' }}>Moysh: <strong>{formatCurrency(moyshTotal)}</strong></span>
 {unpaidTotal > 0 && <span style={{ color: '#a00' }}>Unpaid: <strong>{formatCurrency(unpaidTotal)}</strong></span>}
 <span style={{ marginLeft: 'auto', color: '#888' }}>
 Drilled: {formatCurrency(drillTotal)} vs row total: {formatCurrency(categoryTotal)}
 </span>
 </div>

 {/* Month-by-month split by paid-by */}
 <div style={{ marginBottom: 14, overflowX: 'auto', border: '1px solid #e1d8c2', borderRadius: 4, background: '#fff' }}>
 <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
 <thead>
 <tr style={{ background: '#fff3d8' }}>
 <th style={{ padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid #e1d8c2', whiteSpace: 'nowrap' }}>Paid By</th>
 {monthLabels.map((m) => (
 <th key={m} className="num" style={{ padding: '6px 8px', borderBottom: '1px solid #e1d8c2' }}>{m}</th>
 ))}
 <th className="num" style={{ padding: '6px 10px', borderBottom: '1px solid #e1d8c2', background: '#ffe5b3' }}>Total</th>
 </tr>
 </thead>
 <tbody>
 <tr>
 <td style={{ padding: '5px 10px', color: '#1a6d3c', fontWeight: 700 }}>PureX</td>
 {months.map((ym) => {
 const v = monthlyByPaidBy[ym]?.purex ?? 0;
 return <td key={ym} className="num" style={{ padding: '5px 8px', color: '#1a6d3c' }}>{v > 0 ? formatCurrency(v) : '-'}</td>;
 })}
 <td className="num" style={{ padding: '5px 10px', color: '#1a6d3c', fontWeight: 700, background: '#fff9ef' }}>{formatCurrency(purexTotal)}</td>
 </tr>
 <tr>
 <td style={{ padding: '5px 10px', color: '#945215', fontWeight: 700 }}>Moysh</td>
 {months.map((ym) => {
 const v = monthlyByPaidBy[ym]?.moysh ?? 0;
 return <td key={ym} className="num" style={{ padding: '5px 8px', color: '#945215' }}>{v > 0 ? formatCurrency(v) : '-'}</td>;
 })}
 <td className="num" style={{ padding: '5px 10px', color: '#945215', fontWeight: 700, background: '#fff9ef' }}>{formatCurrency(moyshTotal)}</td>
 </tr>
 {unpaidTotal > 0 && (
 <tr>
 <td style={{ padding: '5px 10px', color: '#a00', fontWeight: 700 }}>Unpaid</td>
 {months.map((ym) => {
 const v = monthlyByPaidBy[ym]?.unpaid ?? 0;
 return <td key={ym} className="num" style={{ padding: '5px 8px', color: '#a00' }}>{v > 0 ? formatCurrency(v) : '-'}</td>;
 })}
 <td className="num" style={{ padding: '5px 10px', color: '#a00', fontWeight: 700, background: '#fff9ef' }}>{formatCurrency(unpaidTotal)}</td>
 </tr>
 )}
 <tr style={{ borderTop: '2px solid #e1d8c2', background: '#fff9ef' }}>
 <td style={{ padding: '5px 10px', fontWeight: 700 }}>Total</td>
 {months.map((ym) => {
 const m = monthlyByPaidBy[ym] ?? { purex: 0, moysh: 0, unpaid: 0 };
 const v = m.purex + m.moysh + m.unpaid;
 return <td key={ym} className="num" style={{ padding: '5px 8px', fontWeight: 700 }}>{v > 0 ? formatCurrency(v) : '-'}</td>;
 })}
 <td className="num" style={{ padding: '5px 10px', fontWeight: 700 }}>{formatCurrency(drillTotal)}</td>
 </tr>
 </tbody>
 </table>
 </div>

 {/* Per-transaction list */}
 <div style={{ fontSize: 12, color: '#5a6478', marginBottom: 6 }}>
 Every transaction (sorted newest first). Click QB sources expand at top of page to see contributing account names.
 </div>
 <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #e1d8c2', borderRadius: 4, background: '#fff' }}>
 <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
 <thead>
 <tr style={{ background: '#fff3d8', position: 'sticky', top: 0 }}>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Date</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Type</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Vendor</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Memo</th>
 <th style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #e1d8c2' }}>Amount</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Paid By</th>
 <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e1d8c2' }}>Source Bank</th>
 </tr>
 </thead>
 <tbody>
 {transactions.length === 0 ? (
 <tr><td colSpan={7} style={{ padding: 14, color: '#888' }}>No transactions found (this row's value may come from inventory-sales auto-COGS or JEs without a clear bank line).</td></tr>
 ) : transactions.map((t, i) => (
 <tr key={i} style={{ borderBottom: '1px solid #f5eee0' }}>
 <td style={{ padding: '5px 8px', whiteSpace: 'nowrap' }}>{t.date}</td>
 <td style={{ padding: '5px 8px', color: '#666' }}>{t.txnType}</td>
 <td style={{ padding: '5px 8px' }}>{t.vendor ?? '-'}</td>
 <td style={{ padding: '5px 8px', color: '#666', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.memo ?? '-'}</td>
 <td style={{ padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatCurrency(t.amount)}</td>
 <td style={{ padding: '5px 8px' }}>
 <span style={{
 padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
 color: t.paidBy === 'PureX' ? '#1a6d3c' : t.paidBy === 'Moysh' ? '#945215' : '#a00',
 background: t.paidBy === 'PureX' ? '#e1f5e9' : t.paidBy === 'Moysh' ? '#fef0d8' : '#fde7e7',
 }}>{t.paidBy}</span>
 </td>
 <td style={{ padding: '5px 8px', color: '#666' }}>{t.sourceBank}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </>
 );
}
