import { useState, useEffect, useMemo } from 'react'
import Sidebar from './Sidebar.jsx'
import Topbar from './Topbar.jsx'
import Overview from './pages/Overview.jsx'
import Collections from './pages/Collections.jsx'
import Sales, { PrivateLabel1 } from './pages/Sales.jsx'
import Customers from './pages/Customers.jsx'
import CommissionPage from './pages/CommissionPage.jsx'

import Reviews from './pages/Reviews.jsx'
import CustomerProfile from './CustomerProfile.jsx'
import InvoiceListModal from './InvoiceListModal.jsx'
import CustomerReviewList from './CustomerReviewList.jsx'
import { ArCopilot } from './ArCopilot.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import LoadingSkeleton from './LoadingSkeleton.jsx'
import { NavProvider, useNav } from '../lib/navigation.jsx'
import useSheets from '../lib/useSheets.js'
import { attachGelatoBrand } from '../lib/sheets.js'
import GelatoBrandDrillModal from './GelatoBrandDrillModal.jsx'
import { scopeDataToRep, repForUser } from '../lib/repScope.js'
import { usePaymentStatus, tagPaymentStatus } from '../lib/arPaymentStatus.js'

const PAGES = {
  overview: { title: 'Overview', component: Overview },
  collections: {
    title: 'Little Tree Accounts Receivable',
    component: (props) => <Collections {...props} scope="wholesale" />,
  },
  gelato: {
    title: 'Gelato Accounts Receivable',
    component: (props) => <Collections {...props} scope="gelato" />,
  },
    sales: { title: 'Sales', component: Sales },
  commission: { title: 'Commission', component: CommissionPage },

    'private-label-1': { title: 'Infused Origin ( Special Category)', component: PrivateLabel1 },


  customers: {
    title: 'Little Tree Customers',
    component: (props) => <Customers {...props} book="lt" />,
  },
  'gelato-customers': {
    title: 'Gelato Customers',
    component: (props) => <Customers {...props} book="gelato" />,
  },
  reviews: { title: 'Review & Audit', component: Reviews },
}

export default function Dashboard({ onLogout }) {
  // Role-based access. 'gelato-only' sees only the Gelato pages; 'little-tree-only'
  // sees Little Tree (no Gelato, no Cashflow); 'full' (CEO/CFO) sees everything.
  const role = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('lt_role')) || 'full'
  // Review & Audit is open to everyone (any role can leave feedback / audit).
  const allowedPages =
    role === 'gelato-only' ? ['gelato', 'gelato-customers', 'reviews'] :
    role === 'little-tree-only' ? ['overview', 'collections', 'sales', 'private-label-1', 'customers', 'reviews'] :

    Object.keys(PAGES)
  const [active, setActive] = useState(allowedPages[0])
  const [gelatoArGroup, setGelatoArGroup] = useState('customer')     // Gelato AR page
  const [gelatoCustGroup, setGelatoCustGroup] = useState('customer') // Gelato Customers page

  const { data, loading, refreshing, error, refresh } = useSheets()

  // Sales-rep scoping: staff like Manny/Dave/Joe/Ken see ONLY their own
  // data across every page. Empty rep → full access (CEO/CFO/Phil/Ivan).
  // repForUser falls back to the signed-in email so a session that predates
  // lt_rep still scopes (no forced re-login).
  const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : null
  const rep = repForUser(ss && ss.getItem('lt_rep'), ss && ss.getItem('lt_user'))
  // Tag every invoice with its inline payment-status override (received / plan)
  // before scoping, so every page + the detail modal sees it live. Re-runs when
  // the operator saves a status (usePaymentStatus subscribes to the store).
  const paymentCache = usePaymentStatus()
  const taggedData = useMemo(() => tagPaymentStatus(data, paymentCache), [data, paymentCache])
  const scopedData = useMemo(() => (rep && taggedData ? scopeDataToRep(taggedData, rep) : taggedData), [taggedData, rep])
  // Gelato By-Brand toggle: when active on a Gelato page, regroup the Gelato book
  // by brand before it reaches the page AND the drill-down modals.
  // Each Gelato page owns its own By-Customer/By-Brand state; the active page's
  // choice drives the regroup that feeds both the page and the drill-down modals.
  // Customers page By-Brand → collapse stores into brand rows (insight tabs group
  // by vendor). AR page By-Brand → keep stores, just attach the brand so the
  // native Brand → Store → Invoice drills (Action List, modal) light up.
  // Both Gelato pages, By-Brand: keep each invoice's real store but attach its
  // brand (masterBrand), so the native Brand → Store drills + brand-status
  // rollups (a brand is only churned when ALL its stores are) light up like LT.
  const customersBrandMode = active === 'gelato-customers' && gelatoCustGroup === 'brand'
  const arBrandMode = active === 'gelato' && gelatoArGroup === 'brand'
  const viewData = useMemo(
    () => ((customersBrandMode || arBrandMode) ? attachGelatoBrand(scopedData) : scopedData),
    [scopedData, customersBrandMode, arBrandMode]
  )


  // Tell the export buttons which book they're on, so reports pick the right
  // logo/accent (Gelato pages → Gelato branding, everything else → Little Tree).
  useEffect(() => {
    const book = (active === 'gelato' || active === 'gelato-customers') ? 'gelato' : 'lt'
    try { sessionStorage.setItem('lt_export_book', book) } catch { /* ignore */ }
  }, [active])

  // Guard against any navigation slipping outside allowed pages.
  const safeNavigate = (id) => {
    if (allowedPages.includes(id)) setActive(id)
  }

  return (
    <NavProvider onNavigate={safeNavigate}>
      <div className="dash">
        <Sidebar active={active} onChange={safeNavigate} onLogout={onLogout} allowedIds={allowedPages} role={role} />
        <div className="dash-main">
          <Topbar
            title={PAGES[active].title}
            fetchedAt={data?.fetchedAt}
            refreshing={refreshing}
            onRefresh={refresh}
          />
          <main className="dash-content">
            {error && (
              <div className="dash-error">
                Could not load data from Sheets: {error}
                <button onClick={refresh}>Retry</button>
              </div>
            )}
            {loading && !data && <LoadingSkeleton />}
            {scopedData && (
              <ErrorBoundary key={active}>
                {rep && (
                  <div className="rep-scope-note">
                    Showing only your accounts - customers where you ({rep}) are the sales rep.
                  </div>
                )}
                {/* page-fade wrapper masks the recompute cost of switching
                    pages - the new page renders fully, then a 160ms fade
                    smooths over any blank frame from heavy useMemos. */}
                <div className="page-fade">
                  <PageRouter active={active} data={viewData}
                    gelatoArGroup={gelatoArGroup} setGelatoArGroup={setGelatoArGroup}
                    gelatoCustGroup={gelatoCustGroup} setGelatoCustGroup={setGelatoCustGroup} />

                </div>
              </ErrorBoundary>
            )}
          </main>
        </div>
        {scopedData && <GlobalModals
          data={viewData}
          book={active === 'gelato' || active === 'gelato-customers' ? 'purex' : 'lt'}
          gelatoBrandMode={false}
          rawGelato={scopedData.gelato}
        />}
      </div>
    </NavProvider>
  )
}

function PageRouter({ active, data, gelatoArGroup, setGelatoArGroup, gelatoCustGroup, setGelatoCustGroup }) {
  const PageComponent = PAGES[active].component
  // Expose each Gelato page's OWN state under the prop names the pages already use.
  const gelatoGroup = active === 'gelato' ? gelatoArGroup : gelatoCustGroup
  const setGelatoGroup = active === 'gelato' ? setGelatoArGroup : setGelatoCustGroup
  return <PageComponent data={data} gelatoGroup={gelatoGroup} setGelatoGroup={setGelatoGroup} />
}


function GlobalModals({ data, book, gelatoBrandMode = false, rawGelato = [] }) {
  const { customerVendor, closeCustomer, invoiceList, closeInvoiceList, canGoBack, back } = useNav()

  // In Gelato By-Brand mode, the detail modal receives brand-collapsed invoices
  // (vendor = brand). Swap them back to their original store-level rows and
  // attach masterBrand so InvoiceListModal drills Brand → Store → Invoice
  // instead of stopping at the brand.
  const rawByInv = useMemo(() => {
    const m = new Map()
    ;(rawGelato || []).forEach((r) => { if (r.invNo) m.set(r.invNo, r) })
    return m
  }, [rawGelato])
  const invoiceListFixed = useMemo(() => {
    if (!invoiceList || !gelatoBrandMode) return invoiceList
    const invoices = (invoiceList.invoices || []).map((r) => {
      const raw = rawByInv.get(r.invNo)
      return raw ? { ...raw, masterBrand: raw.gelatoBrand || 'No brand' } : r
    })
    return { ...invoiceList, invoices }
  }, [invoiceList, gelatoBrandMode, rawByInv])

  // Order matters: list-style modals first, customer-profile last so it
  // renders on top when nested (e.g. region → review → customer).
  return (
    <>
      {canGoBack && (
        <button onClick={back} title="Back to previous view"
          style={{ position: 'fixed', top: 20, left: 20, zIndex: 100000, display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#15803d',
            fontWeight: 600, fontSize: 14, cursor: 'pointer', boxShadow: '0 6px 18px rgba(15,23,42,0.18)' }}>
          ← Back
        </button>
      )}
      {invoiceList && (

        <InvoiceListModal
          title={invoiceList.title}
          subtitle={invoiceList.subtitle}
          invoices={invoiceListFixed.invoices}
          hideOutstanding={invoiceList.hideOutstanding}
          noYearFilter={invoiceList.noYearFilter}
          hideBrandLevel={invoiceList.hideBrandLevel}
          info={invoiceList.info}
          cutoffFilter={invoiceList.cutoffFilter}
          initialCutoff={invoiceList.initialCutoff}
          comparison={invoiceList.comparison}
          initialMarked={invoiceList.initialMarked}
          onClose={closeInvoiceList}
        />
      )}
      <CustomerReviewList />
      {customerVendor && (gelatoBrandMode
        ? <GelatoBrandDrillModal brand={customerVendor} gelato={rawGelato} onClose={closeCustomer} />
        : <CustomerProfile data={data} vendor={customerVendor} book={book} onClose={closeCustomer} />
      )}
      <ArCopilot />
    </>
  )
}
