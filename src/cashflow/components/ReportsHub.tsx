import { useEffect, useState } from 'react';
import { onCfoNav } from '../cfoNav';
import { LivePLPage } from './LivePLPage';
import { LiveBSPage } from './LiveBSPage';
import { TillerTransactionsPage } from './TillerTransactionsPage';

type Tab = 'pl' | 'bs' | 'bank' | 'cc';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'pl', label: 'LT P&L' },
  { key: 'bs', label: 'Balance Sheet' },
  { key: 'bank', label: 'Bank Transactions' },
  { key: 'cc', label: 'Credit Card Transactions' },
];

export function ReportsHub() {
  const [tab, setTab] = useState<Tab>('pl');

  // CFO Copilot "show me" - switch to the report tab it points at.
  useEffect(() => onCfoNav((d) => {
    if (['pl', 'bs', 'bank', 'cc'].includes(d.tab)) setTab(d.tab as Tab);
  }), []);

  // Lazy-mount: render ONLY the active tab so opening Reports fetches just one
  // report's data instead of firing every report's API calls at once (each tab
  // hits QB/Tiller on mount). The durable cache makes switching back cheap.
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

      {tab === 'pl' && <LivePLPage />}
      {tab === 'bs' && <LiveBSPage />}
      {tab === 'bank' && (
        <TillerTransactionsPage
          entity="Moysh-Business"
          title="Bank Transactions"
          subtitle="Live from Tiller · all business bank accounts"
        />
      )}
      {tab === 'cc' && (
        <TillerTransactionsPage
          entity="Moysh-CC"
          title="Credit Card Transactions"
          subtitle="Live from Tiller · all corporate credit cards"
        />
      )}
    </>
  );
}
