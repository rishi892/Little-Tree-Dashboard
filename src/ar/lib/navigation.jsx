import { createContext, useContext, useState, useCallback } from 'react'

const NavContext = createContext(null)

export function NavProvider({ children, onNavigate }) {
  // Unified detail-view history. Each entry: { type, payload }.
  const [stack, setStack] = useState([])

  const push = useCallback((type, payload) => {
    if (!payload) return
    setStack((s) => [...s, { type, payload }])
  }, [])
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), [])
  const closeAll = useCallback(() => setStack([]), [])

  const openCustomer = useCallback((vendor) => push('customer', vendor || null), [push])
  const openInvoiceList = useCallback((payload) => push('invoiceList', payload || null), [push])
  const openCustomerReview = useCallback((payload) => push('customerReview', payload || null), [push])

  const navigate = useCallback((pageId) => { onNavigate?.(pageId); setStack([]) }, [onNavigate])

  const top = stack[stack.length - 1] || null
  const canGoBack = stack.length > 1

  return (
    <NavContext.Provider
      value={{
        navigate, back, canGoBack, closeAll, stackDepth: stack.length,
        // Top-of-stack accessors - same names the modals already use
        customerVendor: top?.type === 'customer' ? top.payload : null,
        invoiceList: top?.type === 'invoiceList' ? top.payload : null,
        customerReview: top?.type === 'customerReview' ? top.payload : null,
        openCustomer, openInvoiceList, openCustomerReview,
        // X (close) exits all detail views; the Back button pops one
        closeCustomer: closeAll, closeInvoiceList: closeAll, closeCustomerReview: closeAll,
      }}
    >
      {children}
    </NavContext.Provider>
  )
}

export function useNav() {
  const ctx = useContext(NavContext)
  if (!ctx) throw new Error('useNav must be used inside NavProvider')
  return ctx
}
