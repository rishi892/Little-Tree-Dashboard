import { useState } from 'react'
import Embers from './Embers.jsx'

// Per-dashboard credentials. The AR gate authorises the operator who runs
// receivables; the Cashflow gate authorises the CFO who runs cash planning.
// On Cashflow success we set the same localStorage flag that the embedded
// Cashflow app checks, then redirect into it with a flag that tells it to
// skip its own splash + login (we already showed both).
// Per-dashboard credentials with role-based scope.
//   AR Dashboard
//     role='full'             → all pages (Overview, Little Tree, Gelato, Sales, Customers)
//     role='gelato-only'      → only the Gelato pages (Gelato AR + Gelato Customers)
//     role='little-tree-only' → Little Tree pages only (Overview, LT AR, Sales, LT Customers) - no Gelato, no Cashflow
//   Cashflow Dashboard
//     full access for any whitelisted user (no scoping inside Cashflow)
//
// Credentials now live in Supabase (app_users) and are verified server-side via
// POST /api/login - so passwords are no longer shipped in this bundle. The role
// scope (full / gelato-only / little-tree-only) + rep come back from the API.
const CONFIGS = {
  ar:       { title: 'AR Dashboard · Sign in' },
  cashflow: { title: 'Cashflow Dashboard · Sign in' },
}

export default function SplashGate({ target = 'ar', onEnter, onBack }) {
  const cfg = CONFIGS[target] || CONFIGS.ar
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [exiting, setExiting] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    const u = username.trim()
    if (!u || !password) {
      setError('Please enter both username and password.')
      return
    }

    setSubmitting(true)
    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: u, password, dashboard: target }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!data.ok || !data.user) {
        setError(data.error || 'Invalid credentials. Please try again.')
        setSubmitting(false)
        return
      }
      const m = data.user
      if (target === 'cashflow') {
        // Flag the Cashflow app expects; sessionStorage so it re-asks on a fresh
        // visit. Redirect immediately (no exit animation before a page swap).
        try {
          sessionStorage.setItem('lt-cfo-auth', '1')
          sessionStorage.setItem('lt_user', m.email || u)
          sessionStorage.setItem('lt_name', m.name || '')
          sessionStorage.setItem('lt_title', m.title || '')
          sessionStorage.setItem('lt_photo', m.photo || '')
        } catch { /* ignore */ }
        window.location.href = '/cashflow.html?direct=1'
      } else {
        // Persist role + rep so the Dashboard/Sidebar can scope views and the
        // Review widget can attribute feedback. Always set (empty for non-scoped).
        try {
          sessionStorage.setItem('lt_role', m.role || 'full')
          sessionStorage.setItem('lt_user', m.email || u)
          sessionStorage.setItem('lt_name', m.name || '')
          sessionStorage.setItem('lt_title', m.title || '')
          sessionStorage.setItem('lt_photo', m.photo || '')
          sessionStorage.setItem('lt_rep', m.rep || '')
        } catch { /* ignore */ }
        setExiting(true)
        setTimeout(onEnter, 300)
      }
    } catch {
      setError('Could not reach the server. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <div className={`splash ${exiting ? 'exit' : ''}`}>
      <div className="hero-bg">
        <img
          src="/hero.jpg"
          onError={(e) => { if (!e.target.dataset.fallback) { e.target.dataset.fallback = '1'; e.target.src = '/hero.png' } }}
          alt=""
          aria-hidden="true"
        />
      </div>
      <div className="hero-overlay" />
      <div className="light-shafts" />
      <Embers />
      <div className="vignette" />

      <main className="splash-content">
        <div className="logo-wrap float">
          <img src="/LT%20Logo.png" alt="Little Tree" className="splash-logo" />
        </div>

        <form className="gate-card login-card" onSubmit={handleSubmit} noValidate>
          <header className="login-head">
            {onBack && (
              <button type="button" className="login-back" onClick={onBack} aria-label="Back to dashboard chooser">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span>Back</span>
              </button>
            )}
            <h2 className="login-title">{cfg.title}</h2>
          </header>

          <div className="field">
            <label htmlFor="lt-user">Username</label>
            <input
              id="lt-user"
              type="text"
              autoComplete="username"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck="false"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="field">
            <label htmlFor="lt-pass">Password</label>
            <div className="pass-wrap">
              <input
                id="lt-pass"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
              />
              <button
                type="button"
                className="pass-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M3 3l18 18M10.58 10.58a2 2 0 002.83 2.83M9.88 5.09A10.94 10.94 0 0112 5c7 0 11 7 11 7a17.6 17.6 0 01-3.06 3.94M6.61 6.61A17.7 17.7 0 001 12s4 7 11 7a10.9 10.9 0 005.39-1.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" stroke="currentColor" strokeWidth="1.7"/>
                    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7"/>
                  </svg>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="form-error" role="alert">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/>
                <path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? (
              <span className="spinner" aria-hidden="true" />
            ) : (
              <span>Sign in</span>
            )}
          </button>
        </form>
      </main>

      <footer className="splash-footer">
        <span>© {new Date().getFullYear()} Little Tree™</span>
      </footer>
    </div>
  )
}
