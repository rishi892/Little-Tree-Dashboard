const NAV = [
  { id: 'overview', label: 'Overview' },
  { id: 'collections', label: 'Little Tree Accounts receivable' },
  { id: 'sales', label: 'Little Tree Sales' },
  { id: 'private-label-1', label: 'Infused Origin ( Special Category)' },
  { id: 'customers', label: 'Little Tree Customers' },
  { id: 'commission', label: 'Commission' },
  { id: 'gelato', label: 'Gelato Accounts receivable (under progress)' },
  { id: 'gelato-customers', label: 'Gelato Customers (under progress)' },
  { id: 'reviews', label: 'Review & Audit (under progress)' },
]

// Known profile photos, keyed by lowercase name / email username. Used as a
// fallback so the avatar shows even for sessions that signed in before the
// photo was wired into login (no re-login needed).
const PHOTOS = {
  rishi: '/Rishi.png',
  phil: '/Phill.jpg',
  phill: '/Phill.jpg',
  manny: '/manny.png',
}

// Title fallback (keyed by lowercase name) so the role line is correct even for
// sessions that signed in before a title was added - no re-login needed.
const TITLES = {
  joey: 'CEO',
  rishi: 'CFO',
  phil: 'CMO',
  phill: 'CMO',
}

// Friendly display name + a one-line role/scope sub, from what login stored.
function readIdentity(role) {
  const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : null
  const get = (k) => (ss && ss.getItem(k)) || ''
  const email = get('lt_user')
  const name = get('lt_name') || (email ? email.split('@')[0].split(/[._]/)[0] : 'User')
  const title = get('lt_title') || TITLES[name.toLowerCase()] || ''
  const emailUser = email ? email.split('@')[0].toLowerCase() : ''
  const photo = get('lt_photo') || PHOTOS[name.toLowerCase()] || PHOTOS[emailUser] || ''
  const rep = get('lt_rep')
  const sub = title
    ? title
    : rep
      ? 'Sales Rep'
      : role === 'gelato-only'
        ? 'Gelato team'
        : role === 'little-tree-only'
          ? 'Little Tree team'
          : 'Full access'
  const initial = (name || 'U').trim().charAt(0).toUpperCase()
  return { name, sub, initial, photo }
}

export default function Sidebar({ active, onChange, onLogout, allowedIds, role }) {
  const items = allowedIds ? NAV.filter((i) => allowedIds.includes(i.id)) : NAV
  const me = readIdentity(role)
  // Only 'full' role users (CEO / CFO) can hop directly into the Cashflow
  // dashboard without re-entering credentials. Scoped users (gelato-only)
  // never see this option since they have no Cashflow access.
  const canSwitch = role === 'full'
  const switchToCashflow = () => {
    try { sessionStorage.setItem('lt-cfo-auth', '1') } catch { /* ignore */ }
    window.location.href = '/cashflow.html?direct=1'
  }
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/LT Logo.png" alt="Little Tree" />
        <div>
          <div className="sidebar-brand-name">Accounts Receivable Dashboard</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {items.map((item) => (
          <button
            key={item.id}
            data-nav-id={item.id}
            className={`sidebar-link ${active === item.id ? 'active' : ''}`}
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        {canSwitch && (
          <button className="sidebar-switch" onClick={switchToCashflow} title="Switch to Cashflow Dashboard">
            <span>Switch to Cashflow</span>
            <span className="sidebar-switch-arrow">→</span>
          </button>
        )}
        <div className="sidebar-user">
          <span className="sidebar-user-avatar">
            {me.initial}
            {me.photo && (
              <img src={me.photo} alt="" onError={(e) => { e.currentTarget.style.display = 'none' }} />
            )}
          </span>
          <span className="sidebar-user-text">
            <span className="sidebar-user-name">{me.name}</span>
            <span className="sidebar-user-sub">{me.sub}</span>
          </span>
        </div>
        <button className="sidebar-logout" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </aside>
  )
}
