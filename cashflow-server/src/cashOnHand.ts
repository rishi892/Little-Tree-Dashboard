/**
 * Helper for the "PureX" QB bank account — the PureX operating bank that the
 * user counts as cash on hand (alongside the Tiller business banks and the
 * Due From PureX / Gelato receivable). It lives in QB only (no Tiller twin), so
 * its balance comes straight from the QB Chart of Accounts.
 *
 * "PureX" appears twice in QB (an Expense account and a Bank account); we want
 * the Bank one. "Due From PureX (Gelato Net 90)" also contains "purex" so it is
 * excluded explicitly here — that receivable is added separately.
 */
import { queryAllAccounts } from './currentPosition.js';
import { withDurableCache } from './qbCache.js';

export type PureXBank = { name: string; balance: number } | null;

// Durable-cached so a transient QB token blip serves the last-good PureX balance
// instead of throwing - that's what stops the spurious "PureX bank fetch failed
// (Refresh token invalid)" warning from showing while the balance is on screen.
export async function getPureXBank(): Promise<PureXBank> {
  const { data } = await withDurableCache(
    'purex-bank',
    5 * 60 * 1000,
    async (): Promise<PureXBank> => {
      const all = await queryAllAccounts();
      const bank = all.find(
        (a) => a.AccountType === 'Bank' && /purex/i.test(a.Name) && !/due\s+from|gelato|net\s*90/i.test(a.Name),
      );
      return bank ? { name: bank.Name, balance: +(bank.CurrentBalance ?? 0).toFixed(2) } : null;
    },
    (d) => d != null && Number.isFinite(d.balance),
  );
  return data;
}

/** The two QB intercompany Bank accounts that count as cash on hand:
 *  the PureX operating bank + Due From PureX (Gelato Net 90). One QB query, so
 *  every surface (Dashboard / Current Position / 13-week opening) sums the same
 *  four accounts. */
export async function getQbIntercompanyCash(): Promise<{ pureXBank: number; dueFromPurex: number }> {
  const all = await queryAllAccounts();
  const banks = all.filter((a) => a.AccountType === 'Bank');
  const px = banks.find((a) => /purex/i.test(a.Name) && !/due\s+from|gelato|net\s*90/i.test(a.Name));
  const dfp = banks.find((a) => /due\s+from.*purex|gelato\s*net\s*90/i.test(a.Name));
  return {
    pureXBank: +(px?.CurrentBalance ?? 0).toFixed(2),
    dueFromPurex: +(dfp?.CurrentBalance ?? 0).toFixed(2),
  };
}
