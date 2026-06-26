import { useEffect, useState } from 'react';
import { onCfoNav } from '../cfoNav';
import { MappedExpensesPage } from './MappedExpensesPage';
import { MonthlySummary } from './MonthlySummary';
import { PnlMappingPage } from './PnlMappingPage';

// Expense editing now lives ONLY in Projections → Expense (per-week, flows into
// the 13-week cashflow), so it isn't duplicated here. This hub is view-only,
// except the Mapping tab which assigns P&L heads to expense categories.
export type ExpensesTab = 'monthly' | 'combined' | 'purex' | 'moysh' | 'mapping';

const TABS: Array<{ key: ExpensesTab; label: string }> = [
 { key: 'monthly', label: 'Monthly LT vs PureX' },
 { key: 'combined', label: 'Combined' },
 { key: 'purex', label: 'PureX' },
 { key: 'moysh', label: 'Moysh' },
 { key: 'mapping', label: 'P&L Mapping' },
];

export function ExpensesHub() {
 const [tab, setTab] = useState<ExpensesTab>('monthly');

 // CFO Copilot "show me" - switch to the expenses sub-tab it points at.
 useEffect(() => onCfoNav((d) => {
 if (['monthly', 'combined', 'purex', 'moysh', 'mapping'].includes(d.tab)) setTab(d.tab as ExpensesTab);
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
 <div style={{ display: tab === 'mapping' ? 'block' : 'none' }}><PnlMappingPage /></div>
 </>
 );
}
