import { useEffect, useState } from 'react';
import { onCfoNav } from '../cfoNav';
import { SalesForecastPage } from './SalesForecastPage';

// Focused "Sales" section. Starts with the Sales Projection sub-tab; more
// sales sub-tabs (Sales by Channel, Sales by Reps, Sales Status) can be added
// here later without touching the sidebar.
type Tab = 'forecast';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'forecast', label: 'Sales Projection' },
];

export function SalesHub() {
  const [tab, setTab] = useState<Tab>('forecast');

  // CFO Copilot "show me" - switch to the sub-tab it points at.
  useEffect(() => onCfoNav((d) => {
    if (d.tab === 'forecast') setTab('forecast');
  }), []);

  return (
    <>
      <div className="expenses-tabs" data-cfo-anchor="sales-tabs">
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

      <div style={{ display: tab === 'forecast' ? 'block' : 'none' }}>{tab === 'forecast' && <SalesForecastPage />}</div>
    </>
  );
}
