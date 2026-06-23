/**
 * CLI: run the subscription audit and write a markdown report.
 * Same data as the /api/subscription-audit endpoint, just formatted for humans.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSubscriptionAudit } from '../src/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = path.resolve(__dirname, '..', '..', 'audit-report.md');

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main() {
  console.log('Running subscription audit…');
  const result = await runSubscriptionAudit();
  console.log(`Loaded ${result.totals.vendors} vendors, ${result.totals.purchases} purchases, ${result.totals.bills} bills.`);

  const lines: string[] = [];
  lines.push('# Subscription audit vs. QuickBooks');
  lines.push('');
  lines.push(`- Realm: \`${result.realmId}\``);
  lines.push(`- Lookback window: ${result.lookbackMonths} months (since ${result.since})`);
  lines.push(`- QBO totals: ${result.totals.vendors} vendors, ${result.totals.purchases} purchases, ${result.totals.bills} bills`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`- **Strong vendor match:** ${result.counts.strong}`);
  lines.push(`- **Fuzzy / probable match:** ${result.counts.fuzzy}`);
  lines.push(`- **Line-item match only:** ${result.counts.line}`);
  lines.push(`- **Not found in lookback window:** ${result.counts.missing}`);
  lines.push('');
  lines.push('## Detail');
  lines.push('');
  lines.push('| Expected | $/mo | Match | Type | Score | Last seen | Txns | Avg amt | Notes |');
  lines.push('|---|---:|---|---|---:|---|---:|---:|---|');
  for (const r of result.rows) {
    const e = r.expected;
    const matchLabel = r.bestMatchName ?? (r.lineHits[0]?.description.slice(0, 40) ?? '-');
    const score = r.bestMatchScore ? r.bestMatchScore.toFixed(2) : (r.matchType === 'line' ? 'line' : '-');
    const last = r.activity?.lastDate ?? '-';
    const txns = r.activity?.txnCount ?? 0;
    const avg = r.activity?.avgAmount;
    let flag = e.notes ?? '';
    if (r.activity) {
      const diff = r.activity.avgAmount - e.monthly;
      if (Math.abs(diff) > Math.max(5, e.monthly * 0.15)) {
        flag = `${flag}${flag ? ' · ' : ''}⚠ avg ${diff > 0 ? '+' : ''}${fmtMoney(diff)} vs expected`;
      }
    } else if (r.matchType === 'none') {
      flag = `${flag}${flag ? ' · ' : ''}❌ no QBO record`;
    }
    lines.push(`| ${e.name} | ${fmtMoney(e.monthly)} | ${matchLabel} | ${r.matchType} | ${score} | ${last} | ${txns} | ${avg !== undefined ? fmtMoney(avg) : '-'} | ${flag} |`);
  }
  lines.push('');

  const borderline = result.rows.filter((r) => r.matchType === 'fuzzy');
  if (borderline.length) {
    lines.push('## Borderline matches (review)');
    lines.push('');
    for (const r of borderline) {
      lines.push(`- **${r.expected.name}** → best: \`${r.bestMatchName}\` (score ${r.bestMatchScore.toFixed(2)})`);
      for (const alt of r.alternates) {
        lines.push(`    - alt: \`${alt.name}\` (score ${alt.score.toFixed(2)})`);
      }
    }
    lines.push('');
  }

  lines.push(`## Recurring QBO vendor activity not on the expected list (top ${Math.min(25, result.unexpectedVendors.length)})`);
  lines.push('');
  lines.push('Only vendors with **2+ transactions** in the lookback window.');
  lines.push('');
  lines.push('| Vendor | Txns | Total | Avg | Last seen |');
  lines.push('|---|---:|---:|---:|---|');
  for (const u of result.unexpectedVendors.slice(0, 25)) {
    lines.push(`| ${u.displayName} | ${u.txnCount} | ${fmtMoney(u.totalAmount)} | ${fmtMoney(u.avgAmount)} | ${u.lastDate} |`);
  }
  lines.push('');

  await fs.writeFile(REPORT_PATH, lines.join('\n'), 'utf8');
  console.log(`Wrote ${REPORT_PATH}`);
  console.log(`Summary: strong=${result.counts.strong} fuzzy=${result.counts.fuzzy} line=${result.counts.line} missing=${result.counts.missing}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
