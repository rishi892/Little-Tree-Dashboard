import { useState } from 'react';
import SalesByChannelPage from './SalesByChannelPage';
import { SettlementHistory } from './SettlementHistory';
import { ArAging } from './ArAging';
import { SalesForecastPage } from './SalesForecastPage';
import { ArStatus } from './ArStatus';
import { SalesStatus } from './SalesStatus';
import { GelatoArStatus } from './GelatoArStatus';
import { SalesByReps } from './SalesByReps';

type Tab = 'aging' | 'arStatus' | 'gelatoArStatus' | 'salesStatus' | 'sales' | 'reps' | 'forecast' | 'settlements';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'aging', label: 'AR Aging' },
  { key: 'arStatus', label: 'AR Status' },
  { key: 'gelatoArStatus', label: 'Gelato AR Status' },
  { key: 'salesStatus', label: 'Sales Status' },
  { key: 'sales', label: 'Sales by Channel' },
  { key: 'reps', label: 'Sales by Reps' },
  { key: 'forecast', label: 'Sales Projection' },
  { key: 'settlements', label: 'Settlement History' },
];

export function SalesArHub() {
  const [tab, setTab] = useState<Tab>('aging');

  return (
    <>
      <div className="expenses-tabs">
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

      <div style={{ display: tab === 'sales' ? 'block' : 'none' }}><SalesByChannelPage /></div>
      <div style={{ display: tab === 'forecast' ? 'block' : 'none' }}>{tab === 'forecast' && <SalesForecastPage />}</div>
      <div style={{ display: tab === 'settlements' ? 'block' : 'none' }}><SettlementHistory /></div>
      <div style={{ display: tab === 'aging' ? 'block' : 'none' }}><ArAging /></div>
      <div style={{ display: tab === 'arStatus' ? 'block' : 'none' }}>{tab === 'arStatus' && <ArStatus />}</div>
      <div style={{ display: tab === 'salesStatus' ? 'block' : 'none' }}>{tab === 'salesStatus' && <SalesStatus />}</div>
      <div style={{ display: tab === 'gelatoArStatus' ? 'block' : 'none' }}>{tab === 'gelatoArStatus' && <GelatoArStatus />}</div>
      <div style={{ display: tab === 'reps' ? 'block' : 'none' }}>{tab === 'reps' && <SalesByReps />}</div>
    </>
  );
}
