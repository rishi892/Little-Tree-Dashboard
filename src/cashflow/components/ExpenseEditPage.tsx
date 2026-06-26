import { WeeklyRowEdit } from './WeeklyRowEdit';

/**
 * Expenses → Edit. ONLY for the 13-Week projection: the four outflow lines,
 * editable PER WEEK. Each row shows the Computed value (how the 13-week derives
 * it) and lets you override any week, which flows into the 13-Week cashflow +
 * dashboard. Nothing else lives here.
 */
export function ExpenseEditPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Edit Expenses</h1>
          <div className="page-sub">
            The four 13-Week outflow lines, editable per week. Each shows the Computed number; override any week to
            change how the 13-Week cashflow + dashboard project that expense. Blank = the computed number.
          </div>
        </div>
      </div>

      <WeeklyRowEdit rowRx={/^payroll$/i} heading="Payroll" sub="Weekly payroll outflow" />
      <WeeklyRowEdit rowRx={/inventory & raw materials/i} heading="Inventory & Raw Materials" sub="Weekly inventory / raw-material spend" />
      <WeeklyRowEdit rowRx={/software & subscriptions/i} heading="Software & Subscriptions" sub="Weekly software / subscription spend" />
      <WeeklyRowEdit rowRx={/other expenses/i} heading="Other Expenses" sub="All other weekly operating expenses" />
    </>
  );
}
