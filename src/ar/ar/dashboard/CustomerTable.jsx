import { money } from '../lib/format.js'
import { useNav } from '../lib/navigation.jsx'
import { ColumnFilter, useColFilter } from './components/ColumnFilter.jsx'

export default function CustomerTable({ rows, mode = 'owed' }) {
  const { openCustomer } = useNav()
  const vendorF = useColFilter(rows, (r) => r.vendor)
  const shown = rows.filter(vendorF.pass)
  return (
    <div className="table-card">
      <div className="table-head">
        <h3>{mode === 'owed' ? 'Top vendors by outstanding' : 'Top vendors by sales'}</h3>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Vendor <ColumnFilter label="Vendor" options={vendorF.options} excluded={vendorF.excluded} onChange={vendorF.setExcluded} /></th>
              <th className="num">Invoices</th>
              {mode === 'owed' ? (
                <>
                  <th className="num">Outstanding</th>
                  <th className="num">Oldest (days)</th>
                </>
              ) : (
                <>
                  <th className="num">Sales</th>
                  <th className="num">Paid</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.vendor} className="clickable-row" onClick={() => openCustomer(r.vendor)}>
                <td className="vendor-cell">{r.vendor.replace(/^Little Tree-\s*/i, '')}</td>
                <td className="num">{r.count}</td>
                {mode === 'owed' ? (
                  <>
                    <td className="num">{money(r.outstanding, true)}</td>
                    <td className="num">{r.oldest ?? ''}</td>
                  </>
                ) : (
                  <>
                    <td className="num">{money(r.sales)}</td>
                    <td className="num">{money(r.paid)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
