import { useState } from 'react';
import { createPortal } from 'react-dom';
import { invalidateAllCaches } from '../api';
import type { ViewKey } from '../CashflowApp';

const ITEMS: Array<{ key: ViewKey; label: string }> = [
  { key: 'cashflow', label: 'Cash Flow' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'reports', label: 'Reports' },
  { key: 'upflow', label: 'Upflow' },
];

// Profile photo + title fallbacks (mirror the AR dashboard) so the signed-in
// user shows correctly even for sessions created before these were wired in.
const PHOTOS: Record<string, string> = {
  rishi: '/Rishi.png',
  phil: '/Phill.jpg',
  phill: '/Phill.jpg',
  manny: '/manny.png',
};
const TITLES: Record<string, string> = {
  joey: 'CEO',
  rishi: 'CFO',
  phil: 'CMO',
  phill: 'CMO',
};

// The signed-in user (name + title + photo), read from what login stored in
// sessionStorage. Same identity the AR dashboard shows in its sidebar.
function readIdentity() {
  const get = (k: string) => (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(k) : '') || '';
  const email = get('lt_user');
  const name = get('lt_name') || (email ? email.split('@')[0].split(/[._]/)[0] : 'User');
  const emailUser = email ? email.split('@')[0].toLowerCase() : '';
  const title = get('lt_title') || TITLES[name.toLowerCase()] || 'Full access';
  const photo = get('lt_photo') || PHOTOS[name.toLowerCase()] || PHOTOS[emailUser] || '';
  const initial = (name || 'U').trim().charAt(0).toUpperCase();
  return { name, title, photo, initial };
}

type Props = {
  view: ViewKey;
  onChange: (v: ViewKey) => void;
  /** Stable identifier (e.g. realm ID) of the connected QB tenant. */
  identifier?: string;
  connected: boolean;
  onDisconnect: () => void;
  onSignOut?: () => void;
};

export function Sidebar({ view, onChange, identifier, connected, onDisconnect, onSignOut }: Props) {
  // Global Refresh All - clears every server cache, then hard-reloads the
  // page so every tab re-fetches fresh data instead of the user having to
  // open each tab and hit Refresh individually.
  const [refreshing, setRefreshing] = useState(false);
  // QuickBooks connection settings live in a popup (opened from one button)
  // rather than as loose reconnect/disconnect buttons in the sidebar.
  const [qbOpen, setQbOpen] = useState(false);
  const me = readIdentity();

  async function handleRefreshAll() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await invalidateAllCaches();
    } catch {
      /* swallow - even if server clear fails, force a hard reload below */
    }
    // Hard reload so all components remount and re-fetch fresh data.
    window.location.reload();
  }
  // Direct hop into the AR dashboard. Cashflow gate already proved the user
  // has CEO/CFO credentials, so we set the AR auth flags and jump straight in
  // instead of bouncing through the chooser + login.
  function handleSwitchToAR() {
    try {
      sessionStorage.setItem('lt_auth_ok', '1');
      sessionStorage.setItem('lt_role', 'full');
    } catch { /* ignore */ }
    window.location.href = '/';
  }
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo" style={{ background: '#fff', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <img
            src="/LT%20Logo.png"
            alt="Little Tree"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>
        <div>
          <div className="brand-name">Cashflow Dashboard</div>
        </div>
      </div>

      {ITEMS.map((item) => (
        <button
          key={item.key}
          className={`nav-item ${view === item.key ? 'active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          <span>{item.label}</span>
        </button>
      ))}

      <div className="sidebar-footer">
        {/* Signed-in user (e.g. CFO · Rishi) - same identity as the AR sidebar. */}
        <div className="user-chip">
          <div
            className="avatar"
            style={{ position: 'relative', overflow: 'hidden' }}
          >
            {me.initial}
            {me.photo && (
              <img
                src={me.photo}
                alt=""
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
              />
            )}
          </div>
          <div className="who">
            <div className="who-name">{me.name}</div>
            <div className="who-role">{me.title}</div>
          </div>
        </div>

        <button
          className="btn"
          onClick={handleRefreshAll}
          disabled={refreshing}
          style={{
            display: 'block',
            width: '100%',
            marginBottom: 8,
            background: refreshing ? 'var(--muted)' : 'var(--accent)',
          }}
          title="Clear all server caches and reload every tab with fresh data"
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh All Data'}
        </button>

        {/* One entry point for QuickBooks - opens a settings popup with the
            connect / reconnect / disconnect actions. */}
        <button
          className="btn ghost"
          onClick={() => setQbOpen(true)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 6 }}
          title="Manage the QuickBooks connection"
        >
          <span
            style={{
              width: 8, height: 8, borderRadius: '50%', flex: 'none',
              background: connected ? '#22c55e' : '#ef4444',
            }}
          />
          <span>QuickBooks Settings</span>
        </button>

        <button
          className="btn"
          onClick={handleSwitchToAR}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            width: '100%',
            marginBottom: 6,
            background: '#15803d',
            color: '#fff',
          }}
          title="Jump to AR Dashboard without re-entering credentials"
        >
          <span>Switch to AR Dashboard</span>
          <span style={{ marginLeft: 'auto' }}>→</span>
        </button>
        {onSignOut && (
          <button className="btn ghost" onClick={onSignOut} style={{ marginTop: 4 }}>Sign out</button>
        )}
      </div>

      {qbOpen && createPortal(
        <div
          className="cm-modal-backdrop"
          style={{ zIndex: 10000 }}
          onClick={() => setQbOpen(false)}
        >
          <div
            className="cm-modal"
            style={{ width: 'min(440px, 100%)', margin: 'auto' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="cm-modal-head">
              <div className="cm-head-left">
                <span className="cm-rep-dot" style={{ background: connected ? '#22c55e' : '#ef4444' }} />
                <div>
                  <div className="cm-title">QuickBooks Settings</div>
                  <div className="cm-sub">
                    {connected ? 'Connected' : 'Not connected'}
                    {connected && identifier ? ` · Realm ${identifier.slice(0, 8)}…` : ''}
                  </div>
                </div>
              </div>
              <button className="cm-modal-close" onClick={() => setQbOpen(false)} aria-label="Close">✕</button>
            </div>

            <div style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--muted)' }}>
                {connected
                  ? 'Your QuickBooks company is connected. Reconnect to refresh the authorization if data looks stale, or disconnect to unlink this company.'
                  : 'Connect your QuickBooks company to pull live financial data into the dashboard.'}
              </p>

              {connected ? (
                <>
                  <a
                    className="btn"
                    href="/auth/connect"
                    style={{ display: 'block', textAlign: 'center', background: 'var(--accent)', color: '#fff' }}
                  >
                    Reconnect QuickBooks
                  </a>
                  <button
                    className="btn"
                    onClick={() => { onDisconnect(); setQbOpen(false); }}
                    style={{ background: '#fff', color: '#dc2626', border: '1px solid #fca5a5' }}
                  >
                    Disconnect QuickBooks
                  </button>
                </>
              ) : (
                <a
                  className="btn"
                  href="/auth/connect"
                  style={{ display: 'block', textAlign: 'center', background: 'var(--accent)', color: '#fff' }}
                >
                  Connect QuickBooks
                </a>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
