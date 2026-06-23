import { Fragment, useEffect, useRef, useState } from 'react';
import { assignUpflowDunningPlan, fetchUpflowDashboard, type UpflowDashboardResult } from '../api';
import { onCfoNav } from '../cfoNav';
import { formatCurrency } from '../format';

const cleanCust = (s: string) => s.replace(/^(little tree|au-[a-z]?-?\d+\s*\(|gelato[.\s-]+)/i, '').replace(/\)$/, '').trim();

/** Background poll cadence. Set to 1 hour per user direction - the dashboard
 *  hits a 2-min server cache so most polls are near-free, but Upflow data
 *  doesn't change minute-to-minute and 1h cadence is plenty for a chase
 *  dashboard. "Refresh now" button is always available for immediate pulls. */
const POLL_MS = 60 * 60 * 1000;

type SubTab = 'overview' | 'invoices' | 'customers' | 'reminders' | 'replies' | 'workflows' | 'payments' | 'users';
const SUBTABS: Array<{ key: SubTab; label: string }> = [
 { key: 'overview',  label: 'Overview' },
 { key: 'invoices',  label: 'Invoices' },
 { key: 'customers', label: 'Customers' },
 { key: 'reminders', label: 'Reminders' },
 { key: 'replies',   label: 'Replies' },
 { key: 'workflows', label: 'Workflows' },
 { key: 'payments',  label: 'Payments' },
 { key: 'users',     label: 'Team' },
];

export function Upflow() {
 const [data, setData] = useState<UpflowDashboardResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [silentRefreshing, setSilentRefreshing] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [tab, setTab] = useState<SubTab>('overview');
 const lastFetchedRef = useRef<number>(0);

 // CFO Copilot "show me" - switch to the Upflow sub-tab it points at.
 useEffect(() => onCfoNav((d) => {
 if (['overview', 'invoices', 'customers', 'reminders', 'replies', 'workflows', 'payments', 'users'].includes(d.tab)) setTab(d.tab as SubTab);
 }), []);

 // silent=true → background refresh, no full-screen loader
 // force=true  → bypass server cache (pulls fresh from Upflow upstream)
 async function load(silent = false, force = false) {
   if (silent) setSilentRefreshing(true);
   else setLoading(true);
   setError(null);
   try {
     const result = await fetchUpflowDashboard({ refresh: force });
     setData(result);
     lastFetchedRef.current = Date.now();
   } catch (e) {
     if (!silent) setError(e instanceof Error ? e.message : 'Failed');
   } finally {
     if (silent) setSilentRefreshing(false);
     else setLoading(false);
   }
 }

 useEffect(() => {
   load();
   // Background poll - re-fetch every POLL_MS so the dashboard mirrors Upflow.
   const poll = window.setInterval(() => load(true), POLL_MS);
   // Refresh immediately when the user comes back to the tab (catches longer
   // periods of inactivity faster than waiting for the next poll tick).
   const onFocus = () => {
     if (Date.now() - lastFetchedRef.current > 10_000) load(true);
   };
   const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
   window.addEventListener('focus', onFocus);
   document.addEventListener('visibilitychange', onVisibility);
   return () => {
     window.clearInterval(poll);
     window.removeEventListener('focus', onFocus);
     document.removeEventListener('visibilitychange', onVisibility);
   };
 }, []);

 if (loading && !data) return (
   <div className="page-head">
     <h1 className="page-title"><img src="/Upflow.png" alt="Upflow" style={{ height: 44, width: 'auto', display: 'block', objectFit: 'contain' }} /></h1>
     <div className="page-sub">Loading Upflow data (paginating invoices + customers + actions + payments)…</div>
   </div>
 );
 if (error) return (<>
   <div className="page-head"><h1 className="page-title"><img src="/Upflow.png" alt="Upflow" style={{ height: 44, width: 'auto', display: 'block', objectFit: 'contain' }} /></h1></div>
   <div className="error">{error}</div>
   <button className="btn ghost" onClick={load}>Retry</button>
 </>);
 if (!data) return null;

 if (!data.connected) {
   return (
     <>
       <div className="page-head">
         <div>
           <h1 className="page-title"><img src="/Upflow.png" alt="Upflow" style={{ height: 44, width: 'auto', display: 'block', objectFit: 'contain' }} /></h1>
           <div className="page-sub">AR collection automation - not connected.</div>
         </div>
         <button className="btn ghost" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
       </div>
       <div className="section" style={{ background: 'rgba(99, 102, 241, 0.06)', border: '1px dashed rgba(99, 102, 241, 0.4)', borderRadius: 6, padding: 24 }}>
         <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>API credentials needed</div>
         <div className="section-sub" style={{ marginBottom: 16 }}>{data.lastError || 'Provide Upflow API key + secret to start pulling collection data.'}</div>
         <ol style={{ paddingLeft: 20, fontSize: 13, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 6 }}>
           <li>Sign in to Upflow → Settings → API keys.</li>
           <li>Open <code>server/.env</code> and set <code>UPFLOW_API_KEY=...</code> and <code>UPFLOW_API_SECRET=...</code></li>
           <li>Restart the server.</li>
         </ol>
       </div>
     </>
   );
 }

 return (
   <>
     <div className="page-head">
       <div>
         <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
           <img
             src="/Upflow.png"
             alt="Upflow"
             style={{ height: 44, width: 'auto', display: 'block', objectFit: 'contain' }}
           />
           <span
             title={silentRefreshing ? 'Re-fetching from Upflow…' : `Auto-refreshes every ${POLL_MS / 1000}s`}
             style={{
               display: 'inline-block',
               width: 8,
               height: 8,
               borderRadius: 8,
               background: silentRefreshing ? '#eab308' : '#059669',
               boxShadow: silentRefreshing ? '0 0 6px #eab308' : '0 0 6px #059669',
               transition: 'background 200ms ease',
             }}
           />
         </h1>
         <div className="page-sub">
           Auto-refreshing hourly · click "↻ Refresh now" for an immediate pull · {data.totals.openInvoices.toLocaleString()} open invoices · {data.dunningPlans.length} workflows · {data.users.length} team · last fetch {new Date(data.fetchedAt).toLocaleTimeString()}.
           {silentRefreshing && <span style={{ marginLeft: 8, color: '#eab308' }}>· refreshing…</span>}
         </div>
       </div>
       <button className="btn ghost" onClick={() => load(false, true)} disabled={loading}>{loading ? 'Refreshing…' : '↻ Refresh now'}</button>
     </div>

     <div className="expenses-tabs" data-cfo-anchor="upflow-tabs">
       {SUBTABS.map((t) => (
         <button
           key={t.key}
           className={`expenses-tab ${tab === t.key ? 'active' : ''}`}
           onClick={() => setTab(t.key)}
         >
           {t.label}
         </button>
       ))}
     </div>

     {tab === 'overview'  && <OverviewTab  data={data} />}
     {tab === 'invoices'  && <InvoicesTab  data={data} />}
     {tab === 'customers' && <CustomersTab data={data} onChanged={() => load(false, true)} />}
     {tab === 'reminders' && <RemindersTab data={data} />}
     {tab === 'replies'   && <RepliesTab   data={data} onChanged={() => load(false, true)} />}
     {tab === 'workflows' && <WorkflowsTab data={data} />}
     {tab === 'payments'  && <PaymentsTab  data={data} />}
     {tab === 'users'     && <UsersTab     data={data} />}
   </>
 );
}

// ===================================================================
// Sub-tab components
// ===================================================================

function OverviewTab({ data }: { data: UpflowDashboardResult }) {
 const { totals, aging, priorityChase } = data;
 // Click-to-focus model: tap a KPI to switch the green highlight and
 // surface its detail block below. Tap the same KPI again to collapse.
 const [activeKpi, setActiveKpi] = useState<'sent' | 'queued' | 'replies' | 'overdue' | 'payments' | null>('sent');
 const kpiBtnStyle = { textAlign: 'left' as const, cursor: 'pointer', font: 'inherit' };
 return (
   <>
     <div className="kpis">
       <button
         type="button"
         className={`kpi ${activeKpi === 'sent' ? 'highlight' : ''}`}
         onClick={() => setActiveKpi((k) => (k === 'sent' ? null : 'sent'))}
         style={kpiBtnStyle}
       >
         <div className="kpi-label">Reminders sent TODAY</div>
         <div className="kpi-period">EXECUTED workflow actions</div>
         <div className="kpi-value" style={{ color: activeKpi === 'sent' ? '#fff' : (totals.remindersSentToday > 0 ? '#059669' : 'var(--muted)') }}>{totals.remindersSentToday}</div>
         <div className="kpi-sub">{totals.remindersSentLast7d} last 7d · {totals.remindersSentLast30d} last 30d</div>
       </button>
       <button
         type="button"
         className={`kpi ${activeKpi === 'queued' ? 'highlight' : ''}`}
         onClick={() => setActiveKpi((k) => (k === 'queued' ? null : 'queued'))}
         style={kpiBtnStyle}
       >
         <div className="kpi-label">Reminders queued</div>
         <div className="kpi-period">TODO actions pending</div>
         <div className="kpi-value">{totals.remindersQueued}</div>
         <div className="kpi-sub">scheduled to fire</div>
       </button>
       <button
         type="button"
         className={`kpi ${activeKpi === 'replies' ? 'highlight' : ''}`}
         onClick={() => setActiveKpi((k) => (k === 'replies' ? null : 'replies'))}
         style={kpiBtnStyle}
       >
         <div className="kpi-label">💬 Replies pending</div>
         <div className="kpi-period">Real customer responses</div>
         <div className="kpi-value" style={{ color: activeKpi === 'replies' ? '#fff' : (totals.repliesPending > 0 ? 'var(--danger)' : 'var(--muted)') }}>{totals.repliesPending}</div>
         <div className="kpi-sub">{totals.repliesHandled} handled · {totals.repliesIgnoredNoise} ignored as noise</div>
       </button>
       <button
         type="button"
         className={`kpi ${activeKpi === 'overdue' ? 'highlight' : ''}`}
         onClick={() => setActiveKpi((k) => (k === 'overdue' ? null : 'overdue'))}
         style={kpiBtnStyle}
       >
         <div className="kpi-label">Overdue AR</div>
         <div className="kpi-period">{totals.overdueInvoices.toLocaleString()} invoices</div>
         <div className="kpi-value" style={{ color: activeKpi === 'overdue' ? '#fff' : 'var(--danger)' }}>{formatCurrency(totals.overdueAmount)}</div>
         <div className="kpi-sub">of {formatCurrency(totals.openAmount)} total open</div>
       </button>
       <button
         type="button"
         className={`kpi ${activeKpi === 'payments' ? 'highlight' : ''}`}
         onClick={() => setActiveKpi((k) => (k === 'payments' ? null : 'payments'))}
         style={kpiBtnStyle}
       >
         <div className="kpi-label">Payments last 30d</div>
         <div className="kpi-period">Validated via Upflow</div>
         <div className="kpi-value" style={{ color: activeKpi === 'payments' ? '#fff' : '#059669' }}>{formatCurrency(totals.paymentsLast30dAmount)}</div>
         <div className="kpi-sub">{totals.paymentsLast30dCount} payments</div>
       </button>
     </div>

     {activeKpi && (
       <UpflowKpiDetail which={activeKpi} totals={totals} aging={aging} />
     )}

     {/* Hero: who to chase today */}
     {priorityChase.length > 0 && (
       <div className="section">
         <div className="section-head">
           <div>
             <div className="section-title">Chase these today</div>
             <div className="section-sub">
               Ranked by outstanding × days overdue · de-prioritized if reminded in last 7d · boosted if no dunning plan or whale ($10k+).
               Hover the "why" column for the ranking reasons.
             </div>
           </div>
         </div>
         <div className="table-wrap">
           <table className="data-table" style={{ fontSize: 12 }}>
             <thead>
               <tr>
                 <th className="num">#</th>
                 <th>Invoice</th>
                 <th>Customer</th>
                 <th className="num">Outstanding</th>
                 <th className="num">Days overdue</th>
                 <th className="num">Last reminder</th>
                 <th>Why</th>
                 <th>Action</th>
               </tr>
             </thead>
             <tbody>
               {priorityChase.map((row, i) => {
                 const tone = row.daysOverdue > 90 ? 'var(--danger)' : row.daysOverdue > 60 ? '#f97316' : row.daysOverdue > 30 ? '#eab308' : 'var(--muted)';
                 const reminderTone = row.daysSinceLastReminder === null ? 'var(--danger)' : row.daysSinceLastReminder > 7 ? '#f97316' : '#059669';
                 return (
                   <tr key={row.invoiceNumber}>
                     <td className="num" style={{ color: 'var(--muted)' }}>{i + 1}</td>
                     <td><strong>{row.invoiceNumber}</strong></td>
                     <td>{cleanCust(row.customer)}</td>
                     <td className="num"><strong>{formatCurrency(row.outstanding)}</strong></td>
                     <td className="num" style={{ color: tone }}>{row.daysOverdue}d</td>
                     <td className="num" style={{ color: reminderTone, fontSize: 11 }}>
                       {row.daysSinceLastReminder === null ? 'NEVER' : `${row.daysSinceLastReminder}d ago`}
                     </td>
                     <td style={{ fontSize: 11, color: 'var(--muted)' }} title={row.reasons.join(' · ')}>
                       {row.reasons.slice(1).join(' · ').slice(0, 60) || row.reasons[0]}
                     </td>
                     <td>{row.customerDirectUrl ? <a href={row.customerDirectUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>Upflow ↗</a> : '-'}</td>
                   </tr>
                 );
               })}
             </tbody>
           </table>
         </div>
       </div>
     )}

     <div className="section">
       <div className="section-head"><div><div className="section-title">Aging</div><div className="section-sub">Open AR bucketed by days overdue.</div></div></div>
       <div className="kpis" style={{ marginTop: 0 }}>
         {aging.map((a) => {
           const tone = a.bucket === 'current' ? '#059669' : a.bucket === '90+' ? 'var(--danger)' : a.bucket === '61-90' ? '#f97316' : a.bucket === '31-60' ? '#eab308' : 'var(--muted)';
           return (
             <div className="kpi" key={a.bucket}>
               <div className="kpi-label">{a.bucket === 'current' ? 'Not yet due' : `${a.bucket} days`}</div>
               <div className="kpi-period">{a.invoiceCount} invoices</div>
               <div className="kpi-value" style={{ color: tone }}>{formatCurrency(a.amount)}</div>
               <div className="kpi-sub">{totals.openAmount > 0 ? ((a.amount / totals.openAmount) * 100).toFixed(1) : '0'}% of open</div>
             </div>
           );
         })}
       </div>
     </div>
   </>
 );
}

function InvoicesTab({ data }: { data: UpflowDashboardResult }) {
 const [filter, setFilter] = useState('');
 const filtered = filter
   ? data.invoices.filter((i) => i.customer.toLowerCase().includes(filter.toLowerCase()) || i.invoiceNumber.toLowerCase().includes(filter.toLowerCase()))
   : data.invoices;
 return (
   <div className="section">
     <div className="section-head">
       <div>
         <div className="section-title">Open invoices · top {data.invoices.length} by outstanding $</div>
         <div className="section-sub">Each invoice's Upflow status, days overdue, and dunning plan. Click PDF for the Upflow-signed file.</div>
       </div>
       <input className="btn ghost" placeholder="filter by customer / inv #" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ minWidth: 220 }} />
     </div>
     <div className="table-wrap">
       <table className="data-table" style={{ fontSize: 12 }}>
         <thead>
           <tr>
             <th>Invoice #</th>
             <th>Customer</th>
             <th className="num">Outstanding</th>
             <th className="num">Issued</th>
             <th className="num">Due</th>
             <th>Status</th>
             <th className="num">Days overdue</th>
             <th>Dunning plan</th>
             <th>PDF</th>
           </tr>
         </thead>
         <tbody>
           {filtered.map((inv) => {
             const isOverdue = inv.daysOverdue > 0;
             const tone = inv.daysOverdue > 90 ? 'var(--danger)' : inv.daysOverdue > 60 ? '#f97316' : inv.daysOverdue > 30 ? '#eab308' : 'var(--muted)';
             return (
               <tr key={inv.invoiceNumber + inv.customer}>
                 <td><strong>{inv.invoiceNumber}</strong></td>
                 <td>{cleanCust(inv.customer)}</td>
                 <td className="num"><strong>{formatCurrency(inv.outstanding)}</strong></td>
                 <td className="num vendor-note">{inv.issueDate || '-'}</td>
                 <td className="num vendor-note">{inv.dueDate || '-'}</td>
                 <td><span className={`pill-tag ${inv.status === 'OVERDUE' ? 'tag-danger' : inv.status === 'PARTIAL' ? 'tag-fuzzy' : 'tag-strong'}`} style={{ fontSize: 10 }}>{inv.status}</span></td>
                 <td className="num" style={{ color: tone }}>{isOverdue ? inv.daysOverdue + 'd' : '-'}</td>
                 <td style={{ fontSize: 11, color: inv.dunningPlan ? 'var(--text)' : 'var(--muted)' }}>{inv.dunningPlan ?? <em>no plan</em>}</td>
                 <td>{inv.paymentLink ? <a href={inv.paymentLink} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>PDF ↗</a> : '-'}</td>
               </tr>
             );
           })}
         </tbody>
       </table>
     </div>
   </div>
 );
}

function CustomersTab({ data, onChanged }: { data: UpflowDashboardResult; onChanged: () => void }) {
 const [filter, setFilter] = useState('');
 const [expanded, setExpanded] = useState<string | null>(null);
 const filtered = filter
   ? data.allCustomersWithBalance.filter((c) => c.customer.toLowerCase().includes(filter.toLowerCase()))
   : data.allCustomersWithBalance;

 // Pre-index invoices + reminders by customer for fast lookup on expand.
 const invoicesByCustomer = new Map<string, typeof data.invoices>();
 for (const inv of data.invoices) {
   const arr = invoicesByCustomer.get(inv.customer) ?? [];
   arr.push(inv);
   invoicesByCustomer.set(inv.customer, arr);
 }
 const remindersByCustomer = new Map<string, typeof data.reminders>();
 for (const r of data.reminders) {
   const arr = remindersByCustomer.get(r.customer) ?? [];
   arr.push(r);
   remindersByCustomer.set(r.customer, arr);
 }
 const paymentsByCustomer = new Map<string, typeof data.payments>();
 for (const p of data.payments) {
   const arr = paymentsByCustomer.get(p.customer) ?? [];
   arr.push(p);
   paymentsByCustomer.set(p.customer, arr);
 }

 return (
   <div className="section">
     <div className="section-head">
       <div>
         <div className="section-title">All customers with balance ({data.allCustomersWithBalance.length})</div>
         <div className="section-sub">Sorted by balance descending. Click a row to expand inline (invoices · reminders · payments).</div>
       </div>
       <input className="btn ghost" placeholder="filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ minWidth: 220 }} />
     </div>
     <div className="table-wrap">
       <table className="data-table" style={{ fontSize: 12 }}>
         <thead><tr><th></th><th>Customer</th><th className="num">Balance</th><th className="num">Open inv</th><th>Dunning plan</th><th>Upflow</th></tr></thead>
         <tbody>
           {filtered.map((c) => {
             const isExpanded = expanded === c.customer;
             const invs = invoicesByCustomer.get(c.customer) ?? [];
             const rems = (remindersByCustomer.get(c.customer) ?? []).slice(0, 10);
             const pays = (paymentsByCustomer.get(c.customer) ?? []).slice(0, 10);
             return (
               <Fragment key={c.customer}>
                 <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(isExpanded ? null : c.customer)}>
                   <td style={{ color: 'var(--muted)', width: 20 }}>{isExpanded ? '▼' : '▶'}</td>
                   <td><strong>{cleanCust(c.customer)}</strong></td>
                   <td className="num"><strong>{formatCurrency(c.balance)}</strong></td>
                   <td className="num">{c.openInvoiceCount}</td>
                   <td style={{ fontSize: 11, color: c.dunningPlan ? 'var(--text)' : 'var(--muted)' }}>{c.dunningPlan ?? <em>no plan</em>}</td>
                   <td>{c.directUrl ? <a href={c.directUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }} onClick={(e) => e.stopPropagation()}>open ↗</a> : '-'}</td>
                 </tr>
                 {isExpanded && (
                   <tr>
                     <td colSpan={6} style={{ background: 'var(--accent-soft, #f6faf8)', padding: 12 }}>
                       <div style={{ marginBottom: 12 }}>
                         <WorkflowAssign customerId={c.customerId} currentPlanId={c.dunningPlanId} plans={data.dunningPlans} onChanged={onChanged} />
                       </div>
                       <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 16 }}>
                         <div>
                           <div style={{ fontWeight: 600, marginBottom: 6 }}>Open invoices ({invs.length})</div>
                           {invs.length === 0 ? <div className="vendor-note">none in the top-200 displayed list</div> : (
                             <table className="data-table" style={{ fontSize: 11 }}>
                               <thead><tr><th>Inv #</th><th className="num">Outstanding</th><th className="num">Days</th><th>PDF</th></tr></thead>
                               <tbody>
                                 {invs.slice(0, 10).map((inv) => (
                                   <tr key={inv.invoiceNumber}>
                                     <td><strong>{inv.invoiceNumber}</strong></td>
                                     <td className="num">{formatCurrency(inv.outstanding)}</td>
                                     <td className="num" style={{ color: inv.daysOverdue > 60 ? 'var(--danger)' : 'var(--muted)' }}>{inv.daysOverdue > 0 ? inv.daysOverdue + 'd' : '-'}</td>
                                     <td>{inv.paymentLink ? <a href={inv.paymentLink} target="_blank" rel="noreferrer">↗</a> : '-'}</td>
                                   </tr>
                                 ))}
                               </tbody>
                             </table>
                           )}
                         </div>
                         <div>
                           <div style={{ fontWeight: 600, marginBottom: 6 }}>Recent reminders ({rems.length})</div>
                           {rems.length === 0 ? <div className="vendor-note">none captured</div> : (
                             <table className="data-table" style={{ fontSize: 11 }}>
                               <thead><tr><th>When</th><th>State</th><th>Template</th></tr></thead>
                               <tbody>
                                 {rems.map((r, i) => (
                                   <tr key={i}>
                                     <td className="vendor-note">{r.sentAt ? new Date(r.sentAt).toLocaleDateString() : '-'}</td>
                                     <td><span className={`pill-tag ${r.state === 'EXECUTED' ? 'tag-strong' : 'tag-fuzzy'}`} style={{ fontSize: 9 }}>{r.state}</span></td>
                                     <td style={{ fontSize: 10 }}>{r.template.slice(0, 30)}</td>
                                   </tr>
                                 ))}
                               </tbody>
                             </table>
                           )}
                         </div>
                         <div>
                           <div style={{ fontWeight: 600, marginBottom: 6 }}>Recent payments ({pays.length})</div>
                           {pays.length === 0 ? <div className="vendor-note">none in last 200 payments</div> : (
                             <table className="data-table" style={{ fontSize: 11 }}>
                               <thead><tr><th>Date</th><th className="num">Amount</th></tr></thead>
                               <tbody>
                                 {pays.map((p) => (
                                   <tr key={p.id}>
                                     <td className="vendor-note">{new Date(p.validatedAt).toLocaleDateString()}</td>
                                     <td className="num"><strong>{formatCurrency(p.amount)}</strong></td>
                                   </tr>
                                 ))}
                               </tbody>
                             </table>
                           )}
                         </div>
                       </div>
                     </td>
                   </tr>
                 )}
               </Fragment>
             );
           })}
         </tbody>
       </table>
     </div>
   </div>
 );
}

function RemindersTab({ data }: { data: UpflowDashboardResult }) {
 const [filter, setFilter] = useState<'all' | 'executed' | 'todo'>('all');
 // Reminders tab focuses on OUTBOUND reminders only - replies have their own tab.
 const outbound = data.reminders.filter((r) => r.source !== 'REPLY');
 const filtered = outbound.filter((r) => filter === 'all' || (filter === 'executed' ? r.state === 'EXECUTED' : r.state === 'TODO'));
 return (
   <div className="section">
     <div className="section-head">
       <div>
         <div className="section-title">Outbound reminders ({outbound.length})</div>
         <div className="section-sub">Workflow-driven reminders we sent. EXECUTED = went out · TODO = scheduled. Customer replies are in the Replies tab.</div>
       </div>
       <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
         {(['all', 'executed', 'todo'] as const).map((f) => (
           <button key={f} className={`filter-tab ${filter === f ? 'active' : ''}`} style={{ borderRadius: 0, border: 'none' }} onClick={() => setFilter(f)}>{f.toUpperCase()}</button>
         ))}
       </div>
     </div>
     <div className="table-wrap">
       <table className="data-table" style={{ fontSize: 12 }}>
         <thead><tr><th className="num">When</th><th>State</th><th>Invoice #</th><th>Customer</th><th>Channel</th><th>Action / template</th><th>Dunning plan</th></tr></thead>
         <tbody>
           {filtered.map((r, i) => (
             <tr key={`${r.invoiceNumber}-${r.sentAt}-${i}`}>
               <td className="num vendor-note">{r.sentAt ? new Date(r.sentAt).toLocaleString() : '-'}</td>
               <td><span className={`pill-tag ${r.state === 'EXECUTED' ? 'tag-strong' : r.state === 'TODO' ? 'tag-fuzzy' : 'tag-danger'}`} style={{ fontSize: 10 }}>{r.state}</span></td>
               <td><strong>{r.invoiceNumber}</strong></td>
               <td>{cleanCust(r.customer)}</td>
               <td>{r.channel}</td>
               <td style={{ fontSize: 11 }}>{r.template}</td>
               <td style={{ fontSize: 11, color: 'var(--muted)' }}>{r.dunningPlan ?? '-'}</td>
             </tr>
           ))}
         </tbody>
       </table>
     </div>
   </div>
 );
}

function RepliesTab({ data, onChanged }: { data: UpflowDashboardResult; onChanged: () => void }) {
 const [showNoise, setShowNoise] = useState(false);
 const [expanded, setExpanded] = useState<string | null>(null);
 const realReplies = data.replies.filter((r) => !r.looksLikeNoise);
 const noise = data.replies.filter((r) => r.looksLikeNoise);
 const pending = realReplies.filter((r) => r.state === 'TODO');
 const handled = realReplies.filter((r) => r.state === 'EXECUTED');
 const display = showNoise ? data.replies : realReplies;
 return (
   <>
     <div className="kpis">
       <div className="kpi highlight">
         <div className="kpi-label">💬 Pending replies</div>
         <div className="kpi-period">Real customer responses to handle</div>
         <div className="kpi-value" style={{ color: pending.length > 0 ? 'var(--danger)' : '#059669' }}>{pending.length}</div>
         <div className="kpi-sub">{pending.length === 0 ? 'inbox clear' : 'needs reply'}</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Handled</div>
         <div className="kpi-period">EXECUTED replies</div>
         <div className="kpi-value">{handled.length}</div>
         <div className="kpi-sub">team responded</div>
       </div>
       <div className="kpi">
         <div className="kpi-label">Noise (filtered)</div>
         <div className="kpi-period">Bounces · system emails</div>
         <div className="kpi-value" style={{ color: 'var(--muted)' }}>{noise.length}</div>
         <div className="kpi-sub">auto-ignored</div>
       </div>
     </div>

     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">Inbound replies ({display.length})</div>
           <div className="section-sub">
             Click a row to expand details + actions (open thread in Upflow · assign workflow). Upflow API doesn't expose email body or send-reply,
             so the actual reply text + responding is done in Upflow's web app (link below).
           </div>
         </div>
         <label style={{ fontSize: 12, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
           <input type="checkbox" checked={showNoise} onChange={(e) => setShowNoise(e.target.checked)} />
           show noise ({noise.length})
         </label>
       </div>
       <div className="table-wrap">
         <table className="data-table" style={{ fontSize: 12 }}>
           <thead>
             <tr>
               <th></th>
               <th>State</th>
               <th className="num">Received</th>
               <th className="num">Age</th>
               <th>From</th>
               <th>Customer / sender</th>
               <th>Invoice #</th>
               <th>Current workflow</th>
             </tr>
           </thead>
           <tbody>
             {display.map((r) => {
               const isExp = expanded === r.id;
               const ageTone = r.state === 'TODO' && r.daysSinceReceived > 3 ? 'var(--danger)' : r.daysSinceReceived > 7 ? '#f97316' : 'var(--muted)';
               return (
                 <Fragment key={r.id}>
                   <tr style={{ cursor: 'pointer', opacity: r.looksLikeNoise ? 0.45 : 1 }} onClick={() => setExpanded(isExp ? null : r.id)}>
                     <td style={{ color: 'var(--muted)', width: 20 }}>{isExp ? '▼' : '▶'}</td>
                     <td>
                       <span className={`pill-tag ${r.state === 'EXECUTED' ? 'tag-strong' : r.state === 'TODO' ? 'tag-fuzzy' : 'tag-danger'}`} style={{ fontSize: 10 }}>
                         {r.state}
                       </span>
                     </td>
                     <td className="num vendor-note">{new Date(r.receivedAt).toLocaleString()}</td>
                     <td className="num" style={{ color: ageTone }}>{r.daysSinceReceived}d</td>
                     <td><strong>{r.replyFrom ?? '-'}</strong></td>
                     <td style={{ fontSize: 11 }}>{cleanCust(r.customer)}</td>
                     <td>{r.invoiceNumber === '-' ? <span style={{ color: 'var(--muted)' }}>-</span> : <strong>{r.invoiceNumber}</strong>}</td>
                     <td style={{ fontSize: 11, color: r.dunningPlanId ? 'var(--text)' : 'var(--muted)' }}>
                       {data.dunningPlans.find((p) => p.id === r.dunningPlanId)?.name ?? <em>no plan</em>}
                     </td>
                   </tr>
                   {isExp && (
                     <tr>
                       <td colSpan={8} style={{ background: 'var(--accent-soft, #f6faf8)', padding: 14 }}>
                         <ReplyDetail reply={r} data={data} onChanged={onChanged} />
                       </td>
                     </tr>
                   )}
                 </Fragment>
               );
             })}
           </tbody>
         </table>
       </div>
     </div>
   </>
 );
}

function ReplyDetail({ reply, data, onChanged }: { reply: UpflowDashboardResult['replies'][number]; data: UpflowDashboardResult; onChanged: () => void }) {
 return (
   <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 18 }}>
     <div>
       <div style={{ fontWeight: 600, marginBottom: 6 }}>Reply details</div>
       <div style={{ fontSize: 12, display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 4, columnGap: 8 }}>
         <div style={{ color: 'var(--muted)' }}>From sender</div><div><strong>{reply.replyFrom ?? '-'}</strong></div>
         <div style={{ color: 'var(--muted)' }}>Customer name</div><div>{cleanCust(reply.customer)}</div>
         <div style={{ color: 'var(--muted)' }}>Invoice</div><div>{reply.invoiceNumber === '-' ? <em>not linked to an invoice</em> : <strong>{reply.invoiceNumber}</strong>}</div>
         <div style={{ color: 'var(--muted)' }}>Received</div><div>{new Date(reply.receivedAt).toLocaleString()} <span className="vendor-note">({reply.daysSinceReceived}d ago)</span></div>
         <div style={{ color: 'var(--muted)' }}>State</div><div>{reply.state}</div>
         <div style={{ color: 'var(--muted)' }}>Action ID</div><div style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--muted)' }}>{reply.id}</div>
         <div style={{ color: 'var(--muted)' }}>Assigned to</div>
         <div style={{ fontSize: 11 }}>{reply.assignedTo.length === 0 ? <em style={{ color: 'var(--muted)' }}>none</em> : reply.assignedTo.join(', ')}</div>
       </div>
       <div style={{ marginTop: 12, padding: 10, background: 'rgba(234, 179, 8, 0.06)', border: '1px solid rgba(234, 179, 8, 0.3)', borderRadius: 6, fontSize: 11, color: 'var(--muted)' }}>
         ⚠ Upflow's public API doesn't return the email body or expose a send-reply endpoint - actual message text + responding is done in the Upflow web app.
         Click "Open in Upflow ↗" to open this customer's thread there.
       </div>
       <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
         {reply.upflowUrl
           ? <a className="btn" href={reply.upflowUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Open in Upflow ↗</a>
           : <button className="btn ghost" disabled style={{ fontSize: 12 }}>No Upflow link</button>}
       </div>
     </div>
     <div>
       <WorkflowAssign customerId={reply.customerId} currentPlanId={reply.dunningPlanId} plans={data.dunningPlans} onChanged={onChanged} />
     </div>
   </div>
 );
}

function WorkflowAssign({ customerId, currentPlanId, plans, onChanged }: {
 customerId: string | null;
 currentPlanId: string | null;
 plans: UpflowDashboardResult['dunningPlans'];
 onChanged: () => void;
}) {
 const [selected, setSelected] = useState<string>(currentPlanId ?? '');
 const [saving, setSaving] = useState(false);
 const [msg, setMsg] = useState<string | null>(null);
 const current = plans.find((p) => p.id === currentPlanId);

 async function save() {
   if (!customerId) return;
   setSaving(true);
   setMsg(null);
   try {
     const target = selected === '' ? null : selected;
     await assignUpflowDunningPlan(customerId, target);
     setMsg(target ? 'Workflow assigned ✓' : 'Workflow cleared ✓');
     onChanged();
   } catch (e) {
     setMsg(e instanceof Error ? e.message : 'Failed');
   } finally {
     setSaving(false);
   }
 }

 // Sort plans: currently-used ones first (so the obvious choices float up).
 const sortedPlans = [...plans].sort((a, b) => (b.actionsFired + b.customersOnPlan) - (a.actionsFired + a.customersOnPlan));

 return (
   <div style={{ padding: 12, background: 'rgba(99, 102, 241, 0.06)', border: '1px solid rgba(99, 102, 241, 0.3)', borderRadius: 6 }}>
     <div style={{ fontWeight: 600, marginBottom: 6 }}>Assign / change dunning workflow</div>
     <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
       Currently: <strong style={{ color: current ? 'var(--text)' : 'var(--muted)' }}>{current?.name ?? 'no plan'}</strong>
     </div>
     {customerId ? (
       <>
         <select
           value={selected}
           onChange={(e) => setSelected(e.target.value)}
           style={{ width: '100%', padding: 6, fontSize: 12, marginBottom: 8 }}
         >
           <option value="">(no plan / clear)</option>
           {sortedPlans.map((p) => (
             <option key={p.id} value={p.id}>{p.name}{p.actionsFired > 0 ? ` · ${p.actionsFired} actions fired` : ''}</option>
           ))}
         </select>
         <button
           className="btn"
           onClick={save}
           disabled={saving || selected === (currentPlanId ?? '')}
           style={{ fontSize: 12, width: '100%' }}
         >
           {saving ? 'Saving…' : selected === (currentPlanId ?? '') ? 'No change' : 'Apply workflow change'}
         </button>
         {msg && <div style={{ marginTop: 8, fontSize: 11, color: msg.endsWith('✓') ? '#059669' : 'var(--danger)' }}>{msg}</div>}
       </>
     ) : (
       <div style={{ fontSize: 11, color: 'var(--muted)' }}>No customer linked - can't change workflow here.</div>
     )}
   </div>
 );
}

function WorkflowsTab({ data }: { data: UpflowDashboardResult }) {
 // Sort by actual usage signal: customers on plan first, then actions fired.
 const sorted = [...data.dunningPlans].sort((a, b) => {
   const aScore = a.customersOnPlan * 1000 + a.actionsFired;
   const bScore = b.customersOnPlan * 1000 + b.actionsFired;
   return bScore - aScore;
 });
 const active = sorted.filter((p) => p.customersOnPlan > 0 || p.actionsFired > 0);
 const unused = sorted.filter((p) => p.customersOnPlan === 0 && p.actionsFired === 0);
 return (
   <>
     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">Active workflows ({active.length} of {data.dunningPlans.length})</div>
           <div className="section-sub">
             Upflow attaches plans at CUSTOMER level. "Customers on plan" = customers currently assigned ·
             "Actions fired" = reminders this plan has triggered in the actions log ·
             "Invoices via customer" = open invoices whose customer is on this plan (the real exposure).
           </div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table" style={{ fontSize: 12 }}>
           <thead><tr><th>Plan name</th><th className="num">Customers on plan</th><th className="num">Actions fired</th><th className="num">Invoices via customer</th><th>Mode</th><th>Entity</th></tr></thead>
           <tbody>
             {active.map((p) => (
               <tr key={p.id}>
                 <td><strong>{p.name}</strong></td>
                 <td className="num">{p.customersOnPlan > 0 ? <strong>{p.customersOnPlan}</strong> : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                 <td className="num">{p.actionsFired > 0 ? <strong>{p.actionsFired}</strong> : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                 <td className="num">{p.invoicesOnPlan > 0 ? p.invoicesOnPlan : <span style={{ color: 'var(--muted)' }}>-</span>}</td>
                 <td style={{ color: 'var(--muted)' }}>{p.mode}</td>
                 <td style={{ color: 'var(--muted)' }}>{p.entity}</td>
               </tr>
             ))}
             {active.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)', textAlign: 'center' }}>no plans actively used</td></tr>}
           </tbody>
         </table>
       </div>
     </div>

     <div className="section">
       <div className="section-head">
         <div>
           <div className="section-title">Unused workflows ({unused.length})</div>
           <div className="section-sub">Configured in Upflow but no customers attached + no actions fired. Either delete or assign customers to them.</div>
         </div>
       </div>
       <div className="table-wrap">
         <table className="data-table" style={{ fontSize: 12 }}>
           <thead><tr><th>Plan name</th><th>Mode</th><th>Entity</th></tr></thead>
           <tbody>
             {unused.map((p) => (
               <tr key={p.id} style={{ color: 'var(--muted)' }}>
                 <td>{p.name}</td>
                 <td>{p.mode}</td>
                 <td>{p.entity}</td>
               </tr>
             ))}
           </tbody>
         </table>
       </div>
     </div>
   </>
 );
}

function PaymentsTab({ data }: { data: UpflowDashboardResult }) {
 return (
   <div className="section">
     <div className="section-head">
       <div>
         <div className="section-title">Recent payments ({data.payments.length} shown · {data.totals.paymentsLast30dCount} in last 30d)</div>
         <div className="section-sub">Payments validated through Upflow. Cents converted to dollars.</div>
       </div>
     </div>
     <div className="table-wrap">
       <table className="data-table" style={{ fontSize: 12 }}>
         <thead><tr><th className="num">Validated</th><th>Customer</th><th className="num">Amount</th><th>Instrument</th><th className="num">Linked invoices</th><th>External ref</th></tr></thead>
         <tbody>
           {data.payments.map((p) => (
             <tr key={p.id}>
               <td className="num vendor-note">{new Date(p.validatedAt).toLocaleDateString()}</td>
               <td>{cleanCust(p.customer)}</td>
               <td className="num"><strong>{formatCurrency(p.amount)}</strong></td>
               <td style={{ color: 'var(--muted)', fontSize: 11 }}>{p.instrument}</td>
               <td className="num">{p.linkedInvoiceCount}</td>
               <td style={{ color: 'var(--muted)', fontSize: 11 }}>{p.externalId ?? '-'}</td>
             </tr>
           ))}
         </tbody>
       </table>
     </div>
   </div>
 );
}

function UsersTab({ data }: { data: UpflowDashboardResult }) {
 return (
   <div className="section">
     <div className="section-head">
       <div>
         <div className="section-title">Team ({data.users.length})</div>
         <div className="section-sub">Upflow account members. Used as default assignees on workflow actions.</div>
       </div>
     </div>
     <div className="table-wrap">
       <table className="data-table" style={{ fontSize: 12 }}>
         <thead><tr><th>Name</th><th>Email</th><th>Position</th></tr></thead>
         <tbody>
           {data.users.map((u) => (
             <tr key={u.id}>
               <td><strong>{`${u.firstName} ${u.lastName}`.trim()}</strong></td>
               <td>{u.email}</td>
               <td style={{ color: 'var(--muted)' }}>{u.position}</td>
             </tr>
           ))}
         </tbody>
       </table>
     </div>
   </div>
 );
}

/** Detail panel for the Upflow Overview KPIs. Switches based on which
 *  KPI the user clicked at the top. */
function UpflowKpiDetail({
 which,
 totals,
 aging,
}: {
 which: 'sent' | 'queued' | 'replies' | 'overdue' | 'payments';
 totals: UpflowDashboardResult['totals'];
 aging: UpflowDashboardResult['aging'];
}) {
 const Row = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
   <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
     <div style={{ fontSize: 13, color: 'var(--muted-strong)' }}>{label}{sub && <span style={{ color: 'var(--muted)', marginLeft: 6 }}>{sub}</span>}</div>
     <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
   </div>
 );

 let title = '';
 let body: React.ReactNode = null;

 if (which === 'sent') {
   title = 'Reminders sent - windowed view';
   body = (
     <>
       <Row label="Today" value={totals.remindersSentToday} />
       <Row label="Last 7 days" value={totals.remindersSentLast7d} />
       <Row label="Last 30 days" value={totals.remindersSentLast30d} />
       <Row label="Queued (TODO)" value={totals.remindersQueued} sub="(scheduled to fire)" />
     </>
   );
 } else if (which === 'queued') {
   title = 'Queue health';
   body = (
     <>
       <Row label="Currently queued" value={totals.remindersQueued} sub="(awaiting trigger)" />
       <Row label="Sent today" value={totals.remindersSentToday} />
       <Row label="Sent last 7d" value={totals.remindersSentLast7d} />
       <Row label="Sent last 30d" value={totals.remindersSentLast30d} />
     </>
   );
 } else if (which === 'replies') {
   title = 'Replies - handled vs noise';
   const total = totals.repliesPending + totals.repliesHandled + totals.repliesIgnoredNoise;
   const pct = (n: number) => total > 0 ? `${((n / total) * 100).toFixed(0)}%` : '–';
   body = (
     <>
       <Row label="Pending (needs review)" sub={`(${pct(totals.repliesPending)})`} value={totals.repliesPending} />
       <Row label="Handled" sub={`(${pct(totals.repliesHandled)})`} value={totals.repliesHandled} />
       <Row label="Ignored as noise" sub={`(${pct(totals.repliesIgnoredNoise)})`} value={totals.repliesIgnoredNoise} />
       <Row label="Total replies" value={total} />
     </>
   );
 } else if (which === 'overdue') {
   title = 'Overdue AR - by aging bucket';
   const bucketLabel: Record<string, string> = {
     'current': 'Current (not overdue)',
     '1-30': '1–30 days',
     '31-60': '31–60 days',
     '61-90': '61–90 days',
     '90+': '90+ days',
   };
   body = (
     <>
       {aging.map((b) => (
         <Row
           key={b.bucket}
           label={bucketLabel[b.bucket] ?? b.bucket}
           sub={`(${b.invoiceCount} inv)`}
           value={formatCurrency(b.amount)}
         />
       ))}
       <Row label="Total open" value={formatCurrency(totals.openAmount)} />
       <Row label="Of which overdue" sub={`(${totals.overdueInvoices.toLocaleString()} inv)`} value={formatCurrency(totals.overdueAmount)} />
     </>
   );
 } else if (which === 'payments') {
   title = 'Payments - last 30 days';
   const avg = totals.paymentsLast30dCount > 0 ? totals.paymentsLast30dAmount / totals.paymentsLast30dCount : 0;
   body = (
     <>
       <Row label="Amount collected" value={formatCurrency(totals.paymentsLast30dAmount)} />
       <Row label="Payment count" value={totals.paymentsLast30dCount} />
       <Row label="Avg per payment" value={formatCurrency(avg)} />
       <Row label="Still open" value={formatCurrency(totals.openAmount)} sub="(remaining AR)" />
     </>
   );
 }

 return (
   <div className="section" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
     <div className="section-head" style={{ padding: '12px 16px' }}>
       <div className="section-title" style={{ fontSize: 14 }}>{title}</div>
     </div>
     <div>{body}</div>
   </div>
 );
}
