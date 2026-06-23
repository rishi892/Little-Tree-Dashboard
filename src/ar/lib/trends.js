// Month-over-month comparison helpers for trend-chart drill-downs.
//
// Stock charts (point-in-time balances, e.g. open AR / 180+ stuck): diff WHICH
// invoices entered/left between the clicked month and the one before it, plus
// the dollar delta. The result is passed to InvoiceListModal as `comparison`.
export function stockComparison(series, point, listKey, totalKey, { addedLabel, removedLabel, upIsBad = true, labelFn } = {}) {
  const idx = series.indexOf(point)
  const prev = idx > 0 ? series[idx - 1] : null
  if (!prev) return null
  const keyOf = (x) => x.invNo || `${x.vendor}|${x.date ? x.date.getTime() : ''}`
  const amtOf = (x) => x.outstanding > 0 ? x.outstanding : Math.max(0, x.invoiceAmount - x.invoicePaid)
  const prevKeys = new Set((prev[listKey] || []).map(keyOf))
  const curKeys = new Set((point[listKey] || []).map(keyOf))
  const added = (point[listKey] || []).filter((x) => !prevKeys.has(keyOf(x)))
  const removed = (prev[listKey] || []).filter((x) => !curKeys.has(keyOf(x)))
  return {
    prevLabel: labelFn ? labelFn(prev) : prev.label, prevTotal: prev[totalKey], curTotal: point[totalKey],
    delta: point[totalKey] - prev[totalKey], added, removed,
    addedAmt: added.reduce((s, x) => s + amtOf(x), 0),
    removedAmt: removed.reduce((s, x) => s + amtOf(x), 0),
    addedLabel, removedLabel, upIsBad,
  }
}

// Flow charts (a separate cohort of invoices each month, e.g. billed / collected
// / sales / DSO-by-issue-month): only the dollar (or days) delta vs last month -
// the entered/left framing does not apply because the months don't share rows.
export function flowComparison(series, point, totalKey, { upIsBad = false, unit, labelFn } = {}) {
  const idx = series.indexOf(point)
  const prev = idx > 0 ? series[idx - 1] : null
  if (!prev) return null
  return { flow: true, unit, prevLabel: labelFn ? labelFn(prev) : prev.label, prevTotal: prev[totalKey], curTotal: point[totalKey], delta: point[totalKey] - prev[totalKey], upIsBad }
}
