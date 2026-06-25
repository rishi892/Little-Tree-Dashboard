import { WeeklyRowEdit } from './WeeklyRowEdit';
import { ExpenseDetailSection } from './ExpenseDetailSection';

/**
 * Expenses → Edit. The four 13-Week OUTFLOW lines, editable PER WEEK with the
 * same rich grid as Sales / AR (Computed · Your value · Remark). Edits go to the
 * shared cashflow-edits store, so an override flows straight into the 13-Week
 * projection + dashboard chart (not display-only like the old monthly version),
 * and is saved with the editor's name + a remark. The derivation detail (how
 * each computed number is built) sits in its own panel at the BOTTOM.
 */
export function ExpenseEditPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Edit Expenses</h1>
          <div className="page-sub">
            The four 13-Week outflow lines, editable per week. Override any week — the edit flows into the
            13-Week cashflow + dashboard, shows in both tabs, and is saved with your name and a remark.
            Blank = the computed number.
          </div>
        </div>
      </div>

      <WeeklyRowEdit rowRx={/^payroll$/i} heading="Payroll" sub="Weekly payroll outflow" />
      <WeeklyRowEdit rowRx={/inventory & raw materials/i} heading="Inventory & Raw Materials" sub="Weekly inventory / raw-material spend" />
      <WeeklyRowEdit rowRx={/software & subscriptions/i} heading="Software & Subscriptions" sub="Weekly software / subscription spend" />
      <WeeklyRowEdit rowRx={/other expenses/i} heading="Other Expenses" sub="All other weekly operating expenses" />

      {/* Derivation detail — separate panel, at the bottom (like AR's trend). */}
      <ExpenseDetailSection />
    </>
  );
}
