// Skeleton loader shown while sheets fetch. Mirrors the Overview page layout
// so the transition feels seamless when data arrives.
export default function LoadingSkeleton() {
  return (
    <div className="page skeleton-page">
      {/* Hero KPI row */}
      <section className="exec-hero">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skel-hero-kpi" style={{ animationDelay: `${i * 0.1}s` }}>
            <div className="skel-bar skel-bar-sm" />
            <div className="skel-bar skel-bar-lg" />
            <div className="skel-bar skel-bar-xs" />
          </div>
        ))}
      </section>

      {/* Alerts row */}
      <section>
        <div className="skel-section-head">
          <div className="skel-bar skel-bar-md" />
        </div>
        <div className="alert-grid">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skel-alert" style={{ animationDelay: `${0.15 + i * 0.05}s` }}>
              <div className="skel-bar skel-bar-xs" />
              <div className="skel-bar skel-bar-lg" />
              <div className="skel-bar skel-bar-sm" />
            </div>
          ))}
        </div>
      </section>

      {/* Two-column charts */}
      <section className="grid-2">
        <div className="skel-chart"><div className="skel-bar skel-bar-md" /><div className="skel-chart-body" /></div>
        <div className="skel-chart"><div className="skel-bar skel-bar-md" /><div className="skel-chart-body" /></div>
      </section>
    </div>
  )
}
