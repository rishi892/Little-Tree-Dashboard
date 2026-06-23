// Centralized "wholesale scope" computation - applied across pages that
// need to exclude private-label entries from sales/AR analyses.
import { isInAr, isPrivateLabel, isPureXVendor } from './brands.js'

export function wholesaleScope(data) {
  const vendorBrand = new Map()
  data.invoices.forEach((r) => {
    if (r.vendor && r.brand && !vendorBrand.has(r.vendor)) vendorBrand.set(r.vendor, r.brand)
  })
  const invoices = data.invoices.filter((r) => isInAr(r, vendorBrand.get(r.vendor)))
  // financials has no AR/bucket fields, so isInAr doesn't apply - filter private
  // label by brand AND Pure X by vendor prefix so Little Tree Sales stays clean.
  const financials = data.financials.filter((r) =>
    !isPrivateLabel(vendorBrand.get(r.vendor) || '') && !isPureXVendor(r.vendor))
  return { invoices, financials, vendorBrand }
}

// Gelato is its own book - a single dedicated sheet that holds both the sales
// history AND the AR position, so it backs both `invoices` and `financials`
// (the wholesale side keeps those as two separate sheets). Same shape as
// wholesaleScope so every customer sub-tab works unchanged.
export function gelatoScope(data) {
  const gelato = data.gelato || []
  const vendorBrand = new Map()
  gelato.forEach((r) => { if (r.vendor) vendorBrand.set(r.vendor, 'Gelato') })
  return { invoices: gelato, financials: gelato, vendorBrand }
}
