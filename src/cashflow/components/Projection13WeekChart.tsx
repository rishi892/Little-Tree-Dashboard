import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import type { Cashflow13 } from '../api';
import { formatCurrency } from '../format';

type Props = { data: Cashflow13 };

/**
 * 13-week cash projection chart, starting at the CURRENT week (Wk1 = this week).
 * Inflow bars (green, up) + Outflow bars (red, down) on the left axis; the
 * Closing-cash runway line (blue) on the right axis so both scale cleanly.
 */
export function Projection13WeekChart({ data }: Props) {
  const { weeks, totals } = data;
  const chartData = weeks.map((w, i) => ({
    label: w.label,
    Inflow: Math.round(totals.inflows[i] ?? 0),
    Outflow: -Math.round(Math.abs(totals.outflows[i] ?? 0)), // below axis
    'Closing cash': Math.round(totals.closingCash[i] ?? 0),
  }));
  const currentLabel = weeks[0]?.label;

  return (
    <div style={{ width: '100%', height: 380 }}>
      <ResponsiveContainer>
        <ComposedChart data={chartData} margin={{ top: 18, right: 12, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="label" stroke="#6b7280" tick={{ fontSize: 11 }} />
          <YAxis
            yAxisId="left"
            stroke="#6b7280"
            tick={{ fontSize: 12 }}
            tickFormatter={(v) => formatCurrency(Number(v))}
            width={88}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            stroke="#2563eb"
            tick={{ fontSize: 12 }}
            tickFormatter={(v) => formatCurrency(Number(v))}
            width={88}
          />
          <Tooltip
            contentStyle={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}
            formatter={(value: number, name) => [formatCurrency(Math.abs(Number(value))), name]}
            labelFormatter={(l) => `Week of ${l}`}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine yAxisId="left" y={0} stroke="#9ca3af" />
          {currentLabel && (
            <ReferenceLine
              yAxisId="left"
              x={currentLabel}
              stroke="#2563eb"
              strokeDasharray="4 4"
              label={{ value: 'This week', position: 'top', fontSize: 10, fill: '#2563eb' }}
            />
          )}
          <Bar yAxisId="left" dataKey="Inflow" fill="#15803d" radius={[4, 4, 0, 0]} maxBarSize={26} />
          <Bar yAxisId="left" dataKey="Outflow" fill="#dc2626" radius={[0, 0, 4, 4]} maxBarSize={26} />
          <Line yAxisId="right" type="monotone" dataKey="Closing cash" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
