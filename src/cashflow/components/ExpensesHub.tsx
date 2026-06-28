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

 {/* Lazy-mount: render ONLY the active tab so opening Expenses fetches just one
 tab's data instead of firing all five (Combined/PureX/Moysh are each a separate
 QB pull). The durable cache makes switching back near-instant. */}
 {tab === 'monthly' && <MonthlySummary />}
 {tab === 'combined' && (
 <MappedExpensesPage
 entity="Combined"
 title="Combined (PureX + Moysh)"
 subtitle="Sheet category layout · combined PureX + Moysh totals"
 totalLabel="COMBINED TOTAL"
 />
 )}
 {tab === 'purex' && (
 <MappedExpensesPage
 entity="PureX"
 title="PureX"
 subtitle="QB Live · transactions paid from the PureX bank account"
 totalLabel="PUREX TOTAL"
 />
 )}
 {tab === 'moysh' && (
 <MappedExpensesPage
 entity="Moysh"
 title="Moysh (Other)"
 subtitle="Sheet category layout · only Moysh-paid amounts"
 totalLabel="MOYSH (OTHER) TOTAL"
 />
 )}
 {tab === 'mapping' && <PnlMappingPage />}
 </>
 );
}
