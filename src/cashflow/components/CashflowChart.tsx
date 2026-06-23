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
} from 'recharts';
import type { MonthlyPoint } from '../api';
import { formatCurrency } from '../format';

type Props = { data: MonthlyPoint[] };

export function CashflowChart({ data }: Props) {
  const chartData = data.map((p) => ({
    label: p.label,
    Income: p.income,
    Expenses: -p.expenses,
    Net: p.net,
  }));

  return (
    <div style={{ width: '100%', height: 360 }}>
      <ResponsiveContainer>
        <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="label" stroke="#6b7280" tick={{ fontSize: 12 }} />
          <YAxis
            stroke="#6b7280"
            tick={{ fontSize: 12 }}
            tickFormatter={(v) => formatCurrency(Number(v))}
            width={90}
          />
          <Tooltip
            contentStyle={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}
            formatter={(value: number, name) => [formatCurrency(value), name]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Income" fill="#15803d" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Expenses" fill="#f59e0b" radius={[4, 4, 0, 0]} />
          <Line type="monotone" dataKey="Net" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
