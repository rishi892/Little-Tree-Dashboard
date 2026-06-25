import { useEffect, useState } from 'react';
import { fetchCashflow13, type Cashflow13, type CashflowLine } from '../api';
import { formatCurrency } from '../format';

/**
 * Separate "how the expense numbers are derived" panel — shown at the BOTTOM of
 * the Projections → Expense tab (like the AR collections trend sits below the AR
 * editor). For each of the four outflow lines it shows the run-rate basis (note)
 * + what's included (breakdown), so you can see WHY the computed number is what
 * it is, without cluttering the edit grids above.
 */
const LINES = [
  { rx: /^payroll$/i, label: 'Payroll' },
  { rx: /inventory & raw materials/i, label: 'Inventory & Raw Materials' },
  { rx: /software & subscriptions/i, label: 'Software & Subscriptions' },
  { rx: /other expenses/i, label: 'Other Expenses' },
];
const CAP = 10; // show the top-N breakdown items per line, then "+N more"

export function ExpenseDetailSection() {
  const [data, setData] = useState<Cashflow13 | null>(null);

  useEffect(() => {
    const load = () => fetchCashflow13({ direction: 'future' }).then(setData).catch(() => {});
    void load();
    window.addEventListener('cashflow-edits-changed', load); // re-derive after an edit
    return () => window.removeEventListener('cashflow-edits-changed', load);
  }, []);

  if (!data) return null;
  const rows = LINES
    .map((l) => data.outflows.find((r) => l.rx.test(r.label)))
    .filter((r): r is CashflowLine => !!r);
  if (rows.length === 0) return null;

  return (
    <div className="section">
      <div className="section-head">
        <div>
          <div className="section-title">How these expenses are computed</div>
          <div className="section-sub">
            The basis + what's included for each outflow line — i.e. why the computed number you're editing above is what it is.
          </div>
        </div>
      </div>

      {rows.map((r) => {
        const bd = [...(r.breakdown ?? [])].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
        const shown = bd.slice(0, CAP);
        const more = bd.length - shown.length;
        return (
          <div key={r.label} style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700 }}>{r.label}</div>
            {r.note && (
              <div className="vendor-note" style={{ color: 'var(--text)', margin: '2px 0 6px' }}>{r.note}</div>
            )}
            {shown.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {shown.map((b, i) => (
                  <li key={i} style={{ marginBottom: 2 }}>
                    {b.label} — <strong>{formatCurrency(Math.round(b.amount))}</strong>
                    {b.sub ? <span style={{ color: 'var(--muted)' }}> · {b.sub}</span> : null}
                  </li>
                ))}
                {more > 0 && <li style={{ color: 'var(--muted)', listStyle: 'none', marginLeft: -10 }}>+{more} more…</li>}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
