/**
 * Backtest one instrument from the command line, on real venue candles.
 *
 *   npm run backtest -- --venue okx --symbol BTC-USDT --tf 1h --bars 1000
 */
import { config } from '../config.js';
import { MarketData } from '../market/data.js';
import { Backtester } from '../analysis/backtest.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const venue = arg('venue', 'okx');
const symbol = arg('symbol', 'BTC-USDT');
const timeframe = arg('tf', '1h');
const bars = Math.min(1000, Number(arg('bars', 1000)) || 1000);
const equity = Number(arg('equity', config.account.startingEquity)) || 10000;

const market = new MarketData();
const candles = await market.candles({ venue, symbol, timeframe, limit: bars });
const result = new Backtester({ config }).run(candles, { venue, symbol, timeframe, equity });
if (!result.ok) {
  console.error(`  backtest could not run: ${result.reason}`);
  process.exit(1);
}
console.log(`\n  ${symbol} on ${venue}, ${timeframe}, ${result.bars} bars (${result.from.slice(0, 10)} to ${result.to.slice(0, 10)})`);
for (const k of ['startingEquity', 'endingEquity', 'returnPct', 'trades', 'winRate', 'profitFactor', 'expectancyR', 'maxDrawdownPct', 'avgBarsHeld']) {
  console.log(`  ${k.padEnd(16)} ${result[k]}`);
}
for (const p of result.byPlaybook) console.log(`  · ${p.playbook.padEnd(26)} ${p.trades} trades, ${p.winRate}% win, ${p.avgR}R avg`);
console.log('');
