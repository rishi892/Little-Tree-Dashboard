/**
 * Sales-projection assumption analysis — Non-Gelato only.
 * Pulls live LT Financials data and runs all the calcs needed before
 * we commit to a projection model.
 */
import { getLtFinancialsSales, invalidateLtFinancialsCache } from '../src/ltFinancialsSales.ts';

const EXCLUDED = /(?:little tree[- ]+)?(gelato|alien\s+(?:brainz|brains|arainz)\b|funk'?d?\s*up\b|(?:yacht|tacht)\s+fuel)/i;

invalidateLtFinancialsCache();
const r = await getLtFinancialsSales();
const inv = r.invoices.filter(i => i.amount > 0 && !EXCLUDED.test(i.customer));

// Monthly Non-Gelato totals
const monthly = new Map();
for (const i of inv) {
  const ym = `${i.invoiceDate.getUTCFullYear()}-${String(i.invoiceDate.getUTCMonth()+1).padStart(2,'0')}`;
  monthly.set(ym, (monthly.get(ym) || 0) + i.amount);
}
const keys = [...monthly.keys()].sort();

console.log('=== NON-GELATO MONTHLY TOTALS ===\n');
for (const k of keys) {
  console.log(`  ${k}   $${monthly.get(k).toFixed(0).padStart(8)}`);
}

// --- A. Month-over-Month growth ---
console.log('\n=== A. MONTH-OVER-MONTH GROWTH (every month) ===\n');
const momGrowth = [];
for (let i = 1; i < keys.length; i++) {
  const prev = monthly.get(keys[i-1]);
  const curr = monthly.get(keys[i]);
  const g = (curr - prev) / prev;
  momGrowth.push({ ym: keys[i], from: prev, to: curr, growth: g });
  console.log(`  ${keys[i-1]} → ${keys[i]}: $${prev.toFixed(0).padStart(7)} → $${curr.toFixed(0).padStart(7)}  (${(g*100>=0?'+':'')}${(g*100).toFixed(1)}%)`);
}

// Median MoM excluding outliers (skip top + bottom 1)
const sortedGrowth = [...momGrowth.map(g => g.growth)].sort((a,b)=>a-b);
const trimmed = sortedGrowth.slice(1, sortedGrowth.length - 1);
const medianMoM = trimmed[Math.floor(trimmed.length / 2)];
const meanMoM = trimmed.reduce((s,v)=>s+v,0) / trimmed.length;

console.log(`\n  Total monthly transitions: ${momGrowth.length}`);
console.log(`  Mean (trimmed, ex 1 high+1 low): ${(meanMoM*100).toFixed(2)}%`);
console.log(`  Median (trimmed):                 ${(medianMoM*100).toFixed(2)}%`);

// Note: Non-Gelato is LUMPY at the monthly level - MoM has huge swings.
// MoM growth is not a clean projection driver — better to use trailing or YoY.

// --- B. Quarterly YoY ---
console.log('\n=== B. QUARTERLY YoY ===\n');
function quarterSum(y, q) {
  const months = q === 1 ? ['01','02','03'] : q === 2 ? ['04','05','06'] : q === 3 ? ['07','08','09'] : ['10','11','12'];
  return months.reduce((s, m) => s + (monthly.get(`${y}-${m}`) || 0), 0);
}
const q1_24 = quarterSum(2024, 1), q1_25 = quarterSum(2025, 1), q1_26 = quarterSum(2026, 1);
const q2_24 = quarterSum(2024, 2), q2_25 = quarterSum(2025, 2);
const q3_24 = quarterSum(2024, 3), q3_25 = quarterSum(2025, 3);
const q4_24 = quarterSum(2024, 4), q4_25 = quarterSum(2025, 4);

console.log(`  Q1 2024: $${q1_24.toFixed(0).padStart(7)}   Q1 2025: $${q1_25.toFixed(0).padStart(7)}   YoY: ${((q1_25/q1_24-1)*100).toFixed(1)}%`);
console.log(`  Q1 2025: $${q1_25.toFixed(0).padStart(7)}   Q1 2026: $${q1_26.toFixed(0).padStart(7)}   YoY: ${((q1_26/q1_25-1)*100).toFixed(1)}%  ← post-excise-tax`);
console.log(`  Q2 2024: $${q2_24.toFixed(0).padStart(7)}   Q2 2025: $${q2_25.toFixed(0).padStart(7)}   YoY: ${((q2_25/q2_24-1)*100).toFixed(1)}%`);
console.log(`  Q3 2024: $${q3_24.toFixed(0).padStart(7)}   Q3 2025: $${q3_25.toFixed(0).padStart(7)}   YoY: ${((q3_25/q3_24-1)*100).toFixed(1)}%`);
console.log(`  Q4 2024: $${q4_24.toFixed(0).padStart(7)}   Q4 2025: $${q4_25.toFixed(0).padStart(7)}   YoY: ${((q4_25/q4_24-1)*100).toFixed(1)}%`);

// --- C. Trailing 3-month growth ---
console.log('\n=== C. TRAILING-3-MONTH ROLLING ===\n');
console.log('  Window           Sum         vs Prior 3mo    growth%');
const completed = keys.filter(k => k <= '2026-04');  // exclude partial May 2026
for (let i = 5; i < completed.length; i++) {
  const cur = completed[i-2] + ' → ' + completed[i];
  const sumNow = monthly.get(completed[i-2]) + monthly.get(completed[i-1]) + monthly.get(completed[i]);
  const sumPrev = monthly.get(completed[i-5]) + monthly.get(completed[i-4]) + monthly.get(completed[i-3]);
  const g = (sumNow - sumPrev) / sumPrev;
  if (i >= completed.length - 6) {
    console.log(`  ${cur}   $${sumNow.toFixed(0).padStart(7)}   $${sumPrev.toFixed(0).padStart(7)}    ${(g*100>=0?'+':'')}${(g*100).toFixed(1)}%`);
  }
}

// --- D. Seasonality indices ---
console.log('\n=== D. SEASONALITY INDICES (using complete years 2024+2025) ===\n');
const moTotals = new Array(12).fill(0);
const moCounts = new Array(12).fill(0);
for (const k of keys) {
  const [y, m] = k.split('-').map(Number);
  if (y === 2024 || y === 2025) {
    moTotals[m-1] += monthly.get(k);
    moCounts[m-1] += 1;
  }
}
const moAvg = moTotals.map((t, i) => t / moCounts[i]);
const overallMonthlyAvg = moAvg.reduce((s,v)=>s+v,0) / 12;
console.log(`  Overall avg monthly (2024+2025): $${overallMonthlyAvg.toFixed(0)}\n`);
console.log('  Month   2024-25 avg   Index (avg=100)');
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const seasIdx = [];
for (let m = 0; m < 12; m++) {
  const idx = moAvg[m] / overallMonthlyAvg;
  seasIdx.push(idx);
  console.log(`  ${months[m]}     $${moAvg[m].toFixed(0).padStart(7)}      ${(idx*100).toFixed(1)}%`);
}

// --- E. Baselines ---
console.log('\n=== E. BASELINE VALIDATION ===\n');
const may25 = monthly.get('2025-05');
const apr26 = monthly.get('2026-04');
const apr25 = monthly.get('2025-04');
const q1_2025_avg = q1_25 / 3;
const q4_2024_avg = q4_24 / 3;
const apr26_3mo = (monthly.get('2026-02') + monthly.get('2026-03') + monthly.get('2026-04')) / 3;
console.log(`  May 2025: $${may25.toFixed(0)}   (NEEDED for template baseline)`);
console.log(`  Apr 2026: $${apr26.toFixed(0)}   (latest COMPLETE month — better baseline)`);
console.log(`  Q1 2025 avg: $${q1_2025_avg.toFixed(0)}/mo`);
console.log(`  Q4 2024 avg: $${q4_2024_avg.toFixed(0)}/mo`);
console.log(`  Recent 3mo avg (Feb-Apr 2026): $${apr26_3mo.toFixed(0)}/mo`);

// --- F. Excise-tax impact (OBSERVED, not estimated) ---
console.log('\n=== F. MICHIGAN EXCISE TAX IMPACT (OBSERVED Jan-Apr 2026 vs 2025) ===\n');
const taxYtd_2026 = monthly.get('2026-01') + monthly.get('2026-02') + monthly.get('2026-03') + monthly.get('2026-04');
const sameWindow_2025 = monthly.get('2025-01') + monthly.get('2025-02') + monthly.get('2025-03') + monthly.get('2025-04');
const taxImpact = (taxYtd_2026 - sameWindow_2025) / sameWindow_2025;
console.log(`  Jan-Apr 2025: $${sameWindow_2025.toFixed(0)}`);
console.log(`  Jan-Apr 2026: $${taxYtd_2026.toFixed(0)}`);
console.log(`  Observed Δ:    ${(taxImpact*100).toFixed(1)}%   ← actual post-tax data, not assumption`);

// --- G. Recommended assumption block ---
console.log('\n=== G. RECOMMENDED ASSUMPTIONS ===\n');
console.log('  Baseline:           Apr 2026 ($' + apr26.toFixed(0) + ') — latest COMPLETE month');
console.log('  Growth rate:        use Q1 2026 vs Q1 2025 YoY = ' + ((q1_26/q1_25-1)*100).toFixed(1) + '% as annual run-rate');
console.log('                       (incorporates excise tax — no separate adjustment needed)');
console.log('  Seasonality:        as computed above (2024+2025 avg)');
console.log('  Scenario width:     ±20% (per your template) — std dev of YoY ~14% supports this');
