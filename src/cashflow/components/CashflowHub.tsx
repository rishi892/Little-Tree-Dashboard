import { useEffect, useState } from 'react';
import { CashFlow13Week } from './CashFlow13Week';
import { CurrentPosition } from './CurrentPosition';
import { onCfoNav } from '../cfoNav';

type Props = {
  /** Renders the parent's existing dashboard view in the "Cash Flow" tab. */
  dashboardSlot: React.ReactNode;
};

type Tab = 'position' | 'dashboard' | 'cashflow13';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'position', label: 'Current Position' },
  { key: 'dashboard', label: 'Cash Flow' },
  { key: 'cashflow13', label: '13-Week Plan' },
];

export function CashflowHub({ dashboardSlot }: Props) {
  const [tab, setTab] = useState<Tab>('position');

  // CFO Copilot "show me" - switch to the tab it points at.
  useEffect(() => onCfoNav((d) => {
    if (d.tab === 'position' || d.tab === 'dashboard' || d.tab === 'cashflow13') setTab(d.tab);
  }), []);

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

      <div style={{ display: tab === 'position' ? 'block' : 'none' }}><CurrentPosition /></div>
      <div style={{ display: tab === 'dashboard' ? 'block' : 'none' }}>{dashboardSlot}</div>
      <div style={{ display: tab === 'cashflow13' ? 'block' : 'none' }}><CashFlow13Week /></div>
    </>
  );
}
