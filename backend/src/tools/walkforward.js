/**
 * Walk-forward check of the strategy profiles on real history.
 *
 *   npm run walkforward                  # download (cached) and compare
 *   npm run walkforward -- --refresh     # download again
 *
 * Development markets are split in time (first 60% development, last 40%
 * holdout); holdout markets are never used to choose rules. Read the holdout
 * line: it is the closest thing here to how a rule set behaves on data it was
 * not tuned on. Past results do not predict future ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { Backtester } from '../analysis/backtest.js';

const DIR = path.join(ROOT, 'data', 'walkforward');
const DEV = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'EURUSD', 'GBPUSD', 'PAXGUSD'];
const OKX = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'LTC-USDT', 'ADA-USDT', 'LINK-USDT', 'BCH-USDT', 'DOT-USDT', 'TRX-USDT', 'ATOM-USDT'];
const KRAKEN = ['EURUSD', 'GBPUSD', 'USDJPY', 'PAXGUSD', 'AUDUSD'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function okx(inst, bar, total) {
  const out = new Map();
  let after = '';
  while (out.size < total) {
    const j = await (await fetch(`https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=${bar}&limit=100${after ? `&after=${after}` : ''}`)).json();
    if (j.code !== '0' || !j.data?.length) break;
    for (const r of j.data) out.set(Number(r[0]), { ts: Number(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    after = j.data.at(-1)[0];
    await sleep(130);
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

async function kraken(pair, interval) {
  const j = await (await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`)).json();
  const k = Object.keys(j.result ?? {}).find((x) => x !== 'last');
  return (j.result?.[k] ?? []).map((r) => ({ ts: r[0] * 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6] }));
}

async function dataset(refresh) {
  fs.mkdirSync(DIR, { recursive: true });
  const jobs = [
    ...OKX.flatMap((s) => [[`okx_${s}_1h`, () => okx(s, '1H', 5000)], [`okx_${s}_4h`, () => okx(s, '4H', 8000)], [`okx_${s}_1d`, () => okx(s, '1Dutc', 4000)]]),
    ...KRAKEN.flatMap((p) => [[`kraken_${p}_1h`, () => kraken(p, 60)], [`kraken_${p}_4h`, () => kraken(p, 240)], [`kraken_${p}_1d`, () => kraken(p, 1440)]]),
  ];
  const out = [];
  for (const [name, load] of jobs) {
    const file = path.join(DIR, `${name}.json`);
    if (refresh || !fs.existsSync(file)) {
      process.stdout.write(`  downloading ${name}…\n`);
      try {
        fs.writeFileSync(file, JSON.stringify(await load()));
      } catch (e) {
        process.stdout.write(`  ${name} failed: ${e.message}\n`);
        continue;
      }
    }
    const [venue, symbol, tf] = name.split('_');
    out.push({ venue, symbol, tf, rows: JSON.parse(fs.readFileSync(file, 'utf8')) });
  }
  return out;
}

const series = await dataset(process.argv.includes('--refresh'));
const account = { maxRiskPerTrade: 0.005, minConfidence: 62, minRewardRisk: 1.6, maxEntriesPerSymbol: 1 };
console.log('');
// Each profile on the timeframes it is meant for: breakout was designed and
// tested on 4h and daily bars only.
const TIMEFRAMES = { classic: ['1h', '4h', '1d'], trend: ['1h', '4h', '1d'], breakout: ['4h', '1d'] };
const only = process.argv.find((a) => a.startsWith('--strategy='))?.split('=')[1];
for (const strategy of only ? [only] : ['classic', 'trend', 'breakout']) {
  const sets = { development: [], holdout: [] };
  for (const { venue, symbol, tf, rows } of series) {
    if (!TIMEFRAMES[strategy].includes(tf)) continue;
    const assetClass = venue === 'okx' ? 'crypto' : symbol === 'PAXGUSD' ? 'metal' : 'fx';
    const cut = Math.floor(rows.length * 0.6);
    const parts = DEV.includes(symbol) ? [['development', rows.slice(0, cut)], ['holdout', rows.slice(cut - 150)]] : [['holdout', rows]];
    for (const [set, data] of parts) {
      const r = new Backtester({ config: { account } }).run(data, { symbol, venue, timeframe: tf, assetClass, strategy, warmup: strategy === 'breakout' ? 80 : 120 });
      if (r.ok) sets[set].push(r);
    }
  }
  for (const [set, list] of Object.entries(sets)) {
    const n = list.reduce((a, r) => a + r.trades, 0);
    const exp = n ? list.reduce((a, r) => a + r.expectancyR * r.trades, 0) / n : 0;
    const gross = n ? list.reduce((a, r) => a + r.grossR * r.trades, 0) / n : 0;
    const avg = list.reduce((a, r) => a + r.returnPct, 0) / (list.length || 1);
    const crypto = list.filter((r) => r.symbol.includes('-USDT'));
    const cn = crypto.reduce((a, r) => a + r.trades, 0);
    const cexp = cn ? crypto.reduce((a, r) => a + r.expectancyR * r.trades, 0) / cn : 0;
    console.log(`  ${strategy.padEnd(8)} ${set.padEnd(12)} crypto only: ${cexp.toFixed(3)}R over ${cn} trades, ${crypto.filter((r) => r.returnPct > 0).length}/${crypto.length} profitable`);
    console.log(`  ${strategy.padEnd(8)} ${set.padEnd(12)} ${String(n).padStart(5)} trades   ${exp.toFixed(3).padStart(7)}R net   ${gross.toFixed(3).padStart(7)}R gross   ${list.filter((r) => r.returnPct > 0).length}/${list.length} series profitable   avg ${avg.toFixed(2)}%   worst DD ${Math.max(...list.map((r) => r.maxDrawdownPct)).toFixed(1)}%`);
  }
}
console.log('\n  Expectancy is per trade in R (1R = the amount risked). Not a forecast.\n');
