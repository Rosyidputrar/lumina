/**
 * Trading costs by asset class, in basis points of notional.
 *
 * One flat 4 bps fee for everything was wrong in both directions: too high for
 * FX at an MT5 broker (about a pip of spread plus a small commission) and too
 * low for crypto spot, where a market order pays a taker fee of roughly 10 bps.
 * Every figure is per side; a round trip pays the spread once and the rest
 * twice. Override per deployment with LUMINA_COSTS (JSON of the same shape).
 */
export const DEFAULT_COSTS = {
  // financeBpsPerDay is the overnight cost of holding (swap or funding) on the
  // position's notional, charged per calendar day and in both directions. It is
  // deliberately conservative: real swaps pay one side on some pairs.
  crypto: { spreadBps: 2, slippageBps: 1, feeBps: 10, financeBpsPerDay: 0 },
  fx: { spreadBps: 1, slippageBps: 0.5, feeBps: 0.35, financeBpsPerDay: 0.6 },
  metal: { spreadBps: 2, slippageBps: 1, feeBps: 0.35, financeBpsPerDay: 1 },
  index: { spreadBps: 1.5, slippageBps: 1, feeBps: 0, financeBpsPerDay: 0.6 },
  other: { spreadBps: 2, slippageBps: 1, feeBps: 4, financeBpsPerDay: 0.5 },
};

/** FX crosses (no USD leg) quote wider than the majors. */
const CROSS_SPREAD_BPS = 2;

const CRYPTO = /BTC|ETH|SOL|XRP|DOGE|ADA|LTC|LINK|DOT|AVAX|BNB|USDT|USDC|MATIC|TRX/i;
const METAL = /XAU|XAG|XPT|XPD|PAXG|GOLD|SILVER/i;
const INDEX = /US30|US100|US500|NAS|SPX|SP500|GER|DAX|UK100|JPN|HK50|NIKKEI/i;

/** The cost class of an instrument: its declared asset class first, then its name. */
export function costClass({ assetClass, symbol, venue } = {}) {
  const a = String(assetClass ?? '').toLowerCase();
  if (a === 'crypto' || a === 'fx' || a === 'metal' || a === 'index') return a;
  if (a === 'commodity') return 'metal';
  const s = String(symbol ?? '');
  if (METAL.test(s)) return 'metal';
  if (INDEX.test(s)) return 'index';
  if (CRYPTO.test(s) || ['okx', 'bybit'].includes(venue)) return 'crypto';
  if (/^[A-Z]{6}/i.test(s)) return 'fx';
  return 'other';
}

export function costsFor(instrument, table = DEFAULT_COSTS) {
  const cls = costClass(instrument);
  const c = { financeBpsPerDay: 0, ...(table[cls] ?? table.other) };
  const sym = String(instrument?.symbol ?? '').toUpperCase();
  if (cls === 'fx' && sym && !sym.includes('USD')) c.spreadBps = Math.max(c.spreadBps, CROSS_SPREAD_BPS);
  return c;
}

/** Round-trip cost as a fraction of price: spread once, slippage and fee on both legs. */
export function roundTripCost(c) {
  return (c.spreadBps + 2 * c.slippageBps + 2 * c.feeBps) / 10000;
}
