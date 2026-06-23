type Props = {
  label: string;
  value: string;
  period?: string;
  sub?: string;
  trend?: 'up' | 'down' | 'neutral';
  highlight?: boolean;
};

export function KpiCard({ label, value, period, sub, trend = 'neutral', highlight }: Props) {
  const subClass = trend === 'up' ? 'kpi-sub up' : trend === 'down' ? 'kpi-sub down' : 'kpi-sub';
  return (
    <div className={`kpi${highlight ? ' highlight' : ''}`}>
      <div className="kpi-label">{label}</div>
      {period && <div className="kpi-period">{period}</div>}
      <div className="kpi-value">{value}</div>
      {sub && <div className={subClass}>{sub}</div>}
    </div>
  );
}
