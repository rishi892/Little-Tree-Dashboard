import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts'
import { compactMoney, money } from '../lib/format.js'
import InfoTip from './components/InfoTip.jsx'

const COLORS = {
  'Current': '#0ea5e9',
  '1–30': '#16a34a',
  '31–60': '#84cc16',
  '61–90': '#eab308',
  '91–120': '#f97316',
  '121–180': '#ea580c',
  '180+': '#dc2626',
}

export default function AgingChart({ buckets, onBucketClick, info, basis = 'days past due' }) {
  const clickable = typeof onBucketClick === 'function'
  const sinceInvoice = basis === 'days since invoice date'
  return (
    <div className="chart-card">
      {info && <InfoTip {...info} />}
      <div className="chart-head">
        <h3>Aging buckets · {basis}</h3>
        <span className="chart-sub">Outstanding by {sinceInvoice ? 'days since the invoice date' : 'days past the due date · Current = not yet due'}{clickable ? ' · click a bar' : ''}</span>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={buckets} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: '#64748b', fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickFormatter={compactMoney} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: 'rgba(15,23,42,0.04)' }}
            contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, boxShadow: '0 4px 12px rgba(15,23,42,0.08)' }}
            labelStyle={{ color: '#0f172a', marginBottom: 4, fontWeight: 600 }}
            itemStyle={{ color: '#15803d' }}
            formatter={(v, _n, p) => [money(v), `${p.payload.count} invoices`]}
          />
          <Bar
            dataKey="amount"
            radius={[6, 6, 0, 0]}
            cursor={clickable ? 'pointer' : undefined}
            onClick={clickable ? (p) => p?.label && onBucketClick(p.label) : undefined}
          >
            {buckets.map((b) => (
              <Cell
                key={b.label}
                fill={COLORS[b.label]}
                onClick={clickable ? () => onBucketClick(b.label) : undefined}
              />
            ))}
          </Bar>

        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
