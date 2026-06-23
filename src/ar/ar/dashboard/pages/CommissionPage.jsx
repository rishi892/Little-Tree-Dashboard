// Commission lives in the cashflow codebase (it's QuickBooks-backed). We embed
// the same component here. /api is proxied to the cashflow backend (see
// vite.config.js), so its data fetch works unchanged. cashflow.css is
// palette-matched to the AR dashboard, so importing it is safe.
import { Commission } from '../../../cashflow/components/Commission'
import '../../../cashflow/cashflow.css'

export default function CommissionPage() {
  return <Commission />
}
