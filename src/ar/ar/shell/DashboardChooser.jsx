// Landing screen - splash visuals + a "which dashboard?" picker. Each card is a
// self-labelled image (Little Tree logo + "Accounts Receivable" / "Cash Flow").
// AR card leads into the AR login; Cashflow into its own login.

import Embers from './Embers.jsx'

export default function DashboardChooser({ onChooseAr, onChooseCashflow }) {
  return (
    <div className="splash">
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

      <main className="splash-content chooser-content">
        <div className="logo-wrap float">
          <img src="/LT%20Logo.png" alt="Little Tree" className="splash-logo" />
        </div>

        <div className="chooser-head">
          <h1 className="chooser-title">Welcome back</h1>
          <p className="chooser-sub">Choose your dashboard</p>
        </div>

        <div className="chooser-grid">
          <button type="button" className="chooser-card" onClick={onChooseAr}>
            <img className="chooser-card-img" src="/AR.png" alt="Accounts Receivable" />
            <span className="chooser-card-cta">Tap to login →</span>
          </button>

          <button type="button" className="chooser-card" onClick={onChooseCashflow}>
            <img className="chooser-card-img" src="/CF.png" alt="Cash Flow" />
            <span className="chooser-card-cta">Tap to login →</span>
          </button>
        </div>

        <p className="chooser-foot-note">
          Each dashboard uses your secure Little Tree login.
        </p>
      </main>

      <footer className="splash-footer">
        <span>© {new Date().getFullYear()} Little Tree™</span>
      </footer>
    </div>
  )
}
