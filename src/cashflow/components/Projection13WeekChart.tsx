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

// Inflow categories: green / teal family (money coming in).
const INFLOW_COLORS: Record<string, string> = {
  'Gelato AR Collections (Net 97)': '#15803d',  // forest green
  'Past AR Collections (lag-curve)': '#22c55e', // green
  'Collected from sales (this week)': '#14b8a6', // teal
};
// Outflow categories: warm / distinct family (money going out).
const OUTFLOW_COLORS: Record<string, string> = {
  'Payroll': '#dc2626',                   // red (usually the largest)
  'Inventory & Raw Materials': '#16a34a', // green
  'COGS': '#f59e0b',                       // amber
  'Rent': '#0891b2',                       // cyan
  'Other Expenses': '#64748b',            // slate
  'Credit Card Payments': '#ec4899',      // pink
  'Software & Subscriptions': '#8b5cf6',  // violet
};
const INFLOW_FALLBACK = ['#15803d', '#22c55e', '#14b8a6', '#0891b2', '#65a30d'];
const OUTFLOW_FALLBACK = ['#dc2626', '#f59e0b', '#64748b', '#ec4899', '#8b5cf6', '#0891b2'];
const inColorFor = (label: string, i: number) => INFLOW_COLORS[label] ?? INFLOW_FALLBACK[i % INFLOW_FALLBACK.length];
const outColorFor = (label: string, i: number) => OUTFLOW_COLORS[label] ?? OUTFLOW_FALLBACK[i % OUTFLOW_FALLBACK.length];

/**
 * 13-week cash projection chart, starting at the CURRENT week (Wk1 = this week).
 * Per week: an Inflow stack and an Outflow stack side by side (both up), each
 * split by category colour. The Closing-cash runway line (blue) is on the
 * right axis so both scale cleanly.
 */
export function Projection13WeekChart({ data }: Props) {
  const { weeks, totals } = data;
  const inLines = data.inflows.filter((o) => !o.displayOnly);
  const outLines = data.outflows.filter((o) => !o.displayOnly);

  const chartData = weeks.map((w, i) => {
    const row: Record<string, number | string> = {
      label: w.label,
      'Closing cash': Math.round(totals.closingCash[i] ?? 0),
    };
    for (const o of inLines) row[o.label] = Math.round(Math.abs(o.values[i] ?? 0));
    for (const o of outLines) row[o.label] = Math.round(Math.abs(o.values[i] ?? 0));
    return row;
  });
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
          {inLines.map((o, i) => (
            <Bar
              key={o.label}
              yAxisId="left"
              dataKey={o.label}
              stackId="inflow"
              fill={inColorFor(o.label, i)}
              maxBarSize={22}
            />
          ))}
          {outLines.map((o, i) => (
            <Bar
              key={o.label}
              yAxisId="left"
              dataKey={o.label}
              stackId="outflow"
              fill={outColorFor(o.label, i)}
              maxBarSize={22}
            />
          ))}
          <Line yAxisId="right" type="monotone" dataKey="Closing cash" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
