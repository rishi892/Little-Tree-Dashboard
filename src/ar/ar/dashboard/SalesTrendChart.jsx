import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { compactMoney, money, monthLabel } from '../lib/format.js'

export default function SalesTrendChart({ data, onPointClick }) {
  const clickable = typeof onPointClick === 'function'

  return (
    <div className="chart-card">
      <div className="chart-head">
        <h3>Monthly sales trend</h3>
        <span className="chart-sub">Last {data.length} months</span>
      </div>
      <ResponsiveContainer width="100%" height={280}>
               <AreaChart
          data={data}
          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
          style={clickable ? { cursor: 'pointer' } : undefined}
          onClick={clickable ? (st) => { const k = st?.activePayload?.[0]?.payload?.key; if (k) onPointClick(k) } : undefined}
        >

          <defs>
            <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#15803d" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#15803d" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="paidGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#16a34a" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="key" tickFormatter={(k) => monthLabel(k, { short: true })} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={compactMoney} tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ stroke: '#cbd5e1' }}
            contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13, boxShadow: '0 4px 12px rgba(15,23,42,0.08)' }}
            labelStyle={{ color: '#0f172a', fontWeight: 600 }}
            labelFormatter={monthLabel}
            formatter={(v) => money(v)}
          />
          <Area type="monotone" dataKey="sales" stroke="#15803d" strokeWidth={2} fill="url(#salesGrad)" name="Invoiced" />
          <Area type="monotone" dataKey="paid" stroke="#16a34a" strokeWidth={2} fill="url(#paidGrad)" name="Paid" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
