import InfoTip from './components/InfoTip.jsx'

export default function KpiCard({ label, value, sub, tone, onClick, info }) {
  const clickable = typeof onClick === 'function'
  return (
    <div
      className={`kpi ${tone ? `kpi-${tone}` : ''} ${clickable ? 'kpi-clickable' : ''}`}
      onClick={clickable ? onClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } } : undefined}
    >
      {info && <InfoTip {...info} />}
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}
