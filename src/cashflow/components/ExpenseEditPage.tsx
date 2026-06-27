import { useEffect, useState } from 'react';
import { fetchCashflow13, type Cashflow13 } from '../api';
import { WeeklyRowEdit } from './WeeklyRowEdit';

/**
 * Expenses → Edit. Mirrors the 13-Week projection's outflow lines EXACTLY (same
 * lines, same order: Inventory, COGS, Payroll, Software, Rent, Other, Credit Card
 * Payments). Each line is broken down per payee and editable per week; overrides
 * flow into the 13-Week cashflow + dashboard. The list is driven by the live
 * 13-week model, so it always matches what shows on the 13-Week grid.
 */
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function ExpenseEditPage() {
  const [outflows, setOutflows] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCashflow13({ direction: 'future' })
      .then((d: Cashflow13) => setOutflows((d.outflows ?? []).filter((o) => !o.displayOnly).map((o) => o.label)))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Edit Expenses</h1>
          <div className="page-sub">
            Every 13-Week outflow line, broken down per payee and editable per week. Override any cell to change how the
            13-Week cashflow + dashboard project that expense. Blank = the computed number.
          </div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {!outflows && !error && <div className="section" style={{ padding: 18, color: 'var(--muted)' }}>Loading expense lines…</div>}

      {outflows?.map((label) => (
        <WeeklyRowEdit
          key={label}
          rowRx={new RegExp('^' + escapeRx(label) + '$', 'i')}
          heading={label}
          sub={`Weekly ${label} outflow`}
        />
      ))}
    </>
  );
}
