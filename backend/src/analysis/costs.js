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
  crypto: { spreadBps: 2, slippageBps: 1, feeBps: 10 },
  fx: { spreadBps: 1, slippageBps: 0.5, feeBps: 0.35 },
  metal: { spreadBps: 2, slippageBps: 1, feeBps: 0.35 },
  index: { spreadBps: 1.5, slippageBps: 1, feeBps: 0 },
  other: { spreadBps: 2, slippageBps: 1, feeBps: 4 },
};

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
  return { ...(table[costClass(instrument)] ?? table.other) };
}

/** Round-trip cost as a fraction of price: spread once, slippage and fee on both legs. */
export function roundTripCost(c) {
  return (c.spreadBps + 2 * c.slippageBps + 2 * c.feeBps) / 10000;
}
