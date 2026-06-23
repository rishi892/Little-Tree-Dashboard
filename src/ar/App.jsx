import { useState, useEffect } from 'react'
import DashboardChooser from './shell/DashboardChooser.jsx'
import SplashGate from './shell/SplashGate.jsx'
import Dashboard from './dashboard/Dashboard.jsx'

// Stages:
//   chooser         → pick AR or Cashflow
//   login-ar        → AR-style login gate, AR creds → AR Dashboard
//   login-cashflow  → SAME login gate, Cashflow creds → redirects to /cashflow.html?direct=1
//   dashboard       → AR Dashboard
// Browser tab title per stage. Keeps the favicon row / recent-tabs list
// readable when the operator has 3 dashboards open at once.
const TITLES = {
  chooser:         'Little Tree Dashboard',
  'login-ar':      'AR Dashboard | Sign in | Little Tree',
  'login-cashflow':'Cashflow Dashboard | Sign in | Little Tree',
  dashboard:       'AR Dashboard | Little Tree',
}

export default function App() {
  const [stage, setStage] = useState('chooser')

  // Restore an in-progress AR session - go straight to the dashboard on reload.
  useEffect(() => {
    // One-time migration: older builds saved the Cashflow auth flag in
    // localStorage, which persisted across browser closes and let the user
    // skip the CFO login. Policy is now "ask every visit" - nuke the
    // lingering key so the stale value doesn't bypass the new flow.
    try { localStorage.removeItem('lt-cfo-auth') } catch { /* ignore */ }
    if (sessionStorage.getItem('lt_auth_ok') === '1') setStage('dashboard')
  }, [])

  // Sync <title> with the current stage so the browser tab + Cmd-Tab list
  // reflect whichever dashboard / sign-in screen the user is looking at.
  useEffect(() => {
    document.title = TITLES[stage] || TITLES.chooser
  }, [stage])

  const handleArEnter = () => {
    sessionStorage.setItem('lt_auth_ok', '1')
    setStage('dashboard')
  }

  const handleLogout = () => {
    sessionStorage.removeItem('lt_auth_ok')
    sessionStorage.removeItem('lt_role')
    sessionStorage.removeItem('lt_user')
    setStage('chooser')
  }

  // "Smart" AR click - if the user has authed in this browser before
  // (sessionStorage flag still set), drop them straight into the dashboard
  // instead of asking for the same credentials again.
  const handleArChosen = () => {
    if (sessionStorage.getItem('lt_auth_ok') === '1') {
      setStage('dashboard')
    } else {
      setStage('login-ar')
    }
  }

  if (stage === 'dashboard') return <Dashboard onLogout={handleLogout} />
  if (stage === 'login-ar')
    return <SplashGate target="ar" onEnter={handleArEnter} onBack={() => setStage('chooser')} />
  if (stage === 'login-cashflow')
    return <SplashGate target="cashflow" onBack={() => setStage('chooser')} />
  return (
    <DashboardChooser
      onChooseAr={handleArChosen}
      onChooseCashflow={() => setStage('login-cashflow')}
    />
  )
}
