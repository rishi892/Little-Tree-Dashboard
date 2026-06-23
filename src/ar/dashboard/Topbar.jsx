import { useEffect, useState } from 'react'
import { relativeTime } from '../lib/format.js'

export default function Topbar({ title, fetchedAt, refreshing, onRefresh }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 30000)
    return () => clearInterval(id)
  }, [])

  const isGelato = /gelato/i.test(title)
  const isLittleTree = /little tree/i.test(title) && !isGelato
  const logoSrc = isGelato ? '/Gelato.png' : isLittleTree ? '/LT Logo.png' : null
  return (
    <header className="topbar">
      <div className="topbar-title-wrap">
        {logoSrc && <img src={logoSrc} alt="" className="topbar-logo" />}
        <div>
          <h1 className="topbar-title">{title}</h1>
          <div className="topbar-sub">
            {fetchedAt ? `Updated ${relativeTime(fetchedAt)}` : 'Fetching latest data…'}
          </div>
        </div>
      </div>
      <button
        className="topbar-refresh"
        onClick={onRefresh}
        disabled={refreshing}
        title="Refresh data from Sheets"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
          style={{ transform: refreshing ? 'rotate(360deg)' : 'rotate(0)', transition: 'transform 1s linear' }}>
          <path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
      </button>
    </header>
  )
}
