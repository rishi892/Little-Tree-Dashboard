import { useEffect, useState } from 'react';
import { onCfoNav } from '../cfoNav';
import { MappedExpensesPage } from './MappedExpensesPage';
import { MonthlySummary } from './MonthlySummary';
import { SubscriptionAudit } from './SubscriptionAudit';
import { SubscriptionProjection } from './SubscriptionProjection';

export type ExpensesTab = 'monthly' | 'combined' | 'purex' | 'moysh' | 'subscriptions';

const TABS: Array<{ key: ExpensesTab; label: string }> = [
 { key: 'monthly', label: 'Monthly LT vs PureX' },
 { key: 'combined', label: 'Combined' },
 { key: 'purex', label: 'PureX' },
 { key: 'moysh', label: 'Moysh' },
 { key: 'subscriptions', label: 'Subscriptions' },
];

type SubsSubTab = 'projection' | 'audit';

export function ExpensesHub() {
 const [tab, setTab] = useState<ExpensesTab>('monthly');
 const [subsTab, setSubsTab] = useState<SubsSubTab>('projection');

 // CFO Copilot "show me" - switch to the expenses sub-tab it points at.
 useEffect(() => onCfoNav((d) => {
 if (['monthly', 'combined', 'purex', 'moysh', 'subscriptions'].includes(d.tab)) setTab(d.tab as ExpensesTab);
 }), []);

 return (
 <>
 <div className="expenses-tabs" data-cfo-anchor="expenses-tabs">
 {TABS.map((t) => (
 <button
 key={t.key}
 className={`expenses-tab ${tab === t.key ? 'active' : ''}`}
 onClick={() => setTab(t.key)}
 >
 {t.label}
 </button>
 ))}
 </div>

 {/* All tabs always mounted (display:none for hidden) so data persists
 across tab switches - no re-fetch / loading flash. */}
 <div style={{ display: tab === 'monthly' ? 'block' : 'none' }}><MonthlySummary /></div>
 <div style={{ display: tab === 'combined' ? 'block' : 'none' }}>
 <MappedExpensesPage
 entity="Combined"
 title="Combined (PureX + Moysh)"
 subtitle="Sheet category layout · combined PureX + Moysh totals"
 totalLabel="COMBINED TOTAL"
 />
 </div>
 <div style={{ display: tab === 'purex' ? 'block' : 'none' }}>
 <MappedExpensesPage
 entity="PureX"
 title="PureX"
 subtitle="QB Live · transactions paid from the PureX bank account"
 totalLabel="PUREX TOTAL"
 />
 </div>
 <div style={{ display: tab === 'moysh' ? 'block' : 'none' }}>
 <MappedExpensesPage
 entity="Moysh"
 title="Moysh (Other)"
 subtitle="Sheet category layout · only Moysh-paid amounts"
 totalLabel="MOYSH (OTHER) TOTAL"
 />
 </div>
 <div style={{ display: tab === 'subscriptions' ? 'block' : 'none' }}>
 <div className="segmented" style={{ marginBottom: 20 }}>
 <button className={subsTab === 'projection' ? 'active' : ''} onClick={() => setSubsTab('projection')}>
 13-Week Projection
 </button>
 <button className={subsTab === 'audit' ? 'active' : ''} onClick={() => setSubsTab('audit')}>
 QB Audit (Jan 2025+)
 </button>
 </div>
 <div style={{ display: subsTab === 'projection' ? 'block' : 'none' }}><SubscriptionProjection /></div>
 <div style={{ display: subsTab === 'audit' ? 'block' : 'none' }}>
 <div className="page-head">
 <div>
 <h1 className="page-title">Subscriptions Audit</h1>
 <div className="page-sub">
 Expected recurring vendors cross-checked against QBO vendors, purchases, and bills - last 16 months (Jan 2025 onwards).
 </div>
 </div>
 </div>
 <SubscriptionAudit />
 </div>
 </div>
 </>
 );
}
