import { useEffect, useState } from 'react';
import { onCfoNav } from '../cfoNav';
import { LivePLPage } from './LivePLPage';
import { LiveBSPage } from './LiveBSPage';
import { TillerTransactionsPage } from './TillerTransactionsPage';
import { ReconciliationPage } from './ReconciliationPage';
import { SalesByProductPage } from './SalesByProductPage';

type Tab = 'pl' | 'bs' | 'bank' | 'cc' | 'reco' | 'salesByProduct';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'pl', label: 'LT P&L' },
  { key: 'bs', label: 'Balance Sheet' },
  { key: 'bank', label: 'Bank Transactions' },
  { key: 'cc', label: 'Credit Card Transactions' },
  { key: 'reco', label: 'Reconciliation' },
  { key: 'salesByProduct', label: 'Sales by Product' },
];

export function ReportsHub() {
  const [tab, setTab] = useState<Tab>('pl');

  // CFO Copilot "show me" - switch to the report tab it points at.
  useEffect(() => onCfoNav((d) => {
    if (['pl', 'bs', 'bank', 'cc', 'reco', 'salesByProduct'].includes(d.tab)) setTab(d.tab as Tab);
  }), []);

  return (
    <>
      <div className="expenses-tabs" data-cfo-anchor="reports-tabs">
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

      <div style={{ display: tab === 'pl' ? 'block' : 'none' }}><LivePLPage /></div>
      <div style={{ display: tab === 'bs' ? 'block' : 'none' }}><LiveBSPage /></div>
      <div style={{ display: tab === 'bank' ? 'block' : 'none' }}>
        <TillerTransactionsPage
          entity="Moysh-Business"
          title="Bank Transactions"
          subtitle="Live from Tiller · all business bank accounts"
        />
      </div>
      <div style={{ display: tab === 'cc' ? 'block' : 'none' }}>
        <TillerTransactionsPage
          entity="Moysh-CC"
          title="Credit Card Transactions"
          subtitle="Live from Tiller · all corporate credit cards"
        />
      </div>
      <div style={{ display: tab === 'reco' ? 'block' : 'none' }}><ReconciliationPage /></div>
      <div style={{ display: tab === 'salesByProduct' ? 'block' : 'none' }}>{tab === 'salesByProduct' && <SalesByProductPage />}</div>
    </>
  );
}
