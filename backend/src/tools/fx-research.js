/**
 * FX research: three pre-registered designs on 16 currency pairs and two
 * metals, daily bars since 2000-2006, with Lumina's own cost and swap model.
 *
 *   npm run fx-research                 # download (cached) and evaluate
 *   npm run fx-research -- --refresh
 *
 * Designs, fixed before testing:
 *   A  Donchian 55/20, 2N stop        (the crypto breakout profile)
 *   B  Donchian 100/50, 2N stop       (slower trend following)
 *   R  Bollinger(20,2) mean reversion, exit at the 20-day mean, 2N stop,
 *      20-bar time stop
 * Development: 7 major pairs and gold, first 60% of their history. Holdout:
 * the rest of that history plus 10 pairs and silver never used to choose.
 *
 * Result in Nov 2026: none of A, B or R made money on FX after costs and
 * swaps; B looked positive on development and failed on the holdout; R lost
 * even on development. Metals were the exception (see src/analysis/engine.js,
 * setBreakoutClasses). Daily data comes from Yahoo Finance's public chart
 * endpoint (metals are continuous futures); use it for research only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { costsFor } from '../analysis/costs.js';
import * as I from '../analysis/indicators.js';

const DIR = path.join(ROOT, 'data', 'fx-research');
const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURJPY', 'GBPJPY', 'EURGBP', 'AUDJPY', 'EURCHF', 'EURAUD', 'GBPCHF', 'CADJPY', 'AUDNZD'];
const METALS = { XAUUSD: 'GC=F', XAGUSD: 'SI=F' };
const DEV = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'EURJPY', 'EURGBP', 'XAUUSD'];

async function yahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=946684800&period2=${Math.floor(Date.now() / 1000)}&interval=1d`;
  const j = await (await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })).json();
  const r = j.chart?.result?.[0];
  if (!r) throw new Error('no data');
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ ts: t * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] })).filter((c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0));
}

async function load(refresh) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = [];
  for (const [symbol, ticker] of [...PAIRS.map((p) => [p, `${p}=X`]), ...Object.entries(METALS)]) {
    const file = path.join(DIR, `${symbol}.json`);
    if (refresh || !fs.existsSync(file)) {
      process.stdout.write(`  downloading ${symbol}…\n`);
      fs.writeFileSync(file, JSON.stringify(await yahoo(ticker)));
      await new Promise((r) => setTimeout(r, 400));
    }
    out.push({ symbol, assetClass: symbol in METALS ? 'metal' : 'fx', rows: JSON.parse(fs.readFileSync(file, 'utf8')) });
  }
  return out;
}

/** One position at a time; signals on closed bars, fills at the next open. */
function simulate(c, { symbol, assetClass, design, risk = 0.005, equity = 10000 }) {
  const k = costsFor({ symbol, assetClass, venue: 'mt5' });
  const fill = (side, mid) => mid * (1 + (side === 'buy' ? 1 : -1) * (k.spreadBps / 2 + k.slippageBps) / 1e4);
  const fee = (px, q) => (px * q * k.feeBps) / 1e4;
  const A = I.atr(c, 20);
  const P = { A: [55, 20], B: [100, 50] }[design];
  let bal = equity;
  let pos = null;
  let peak = equity;
  let dd = 0;
  const trades = [];
  const close = (i, mid) => {
    const px = fill(pos.side === 'long' ? 'sell' : 'buy', mid);
    const gross = (pos.side === 'long' ? px - pos.entry : pos.entry - px) * pos.qty;
    const raw = (pos.side === 'long' ? mid - pos.mid : pos.mid - mid) * pos.qty;
    const fin = (k.financeBpsPerDay / 1e4) * pos.mid * pos.qty * Math.max(0, (c[i].ts - c[pos.i].ts) / 864e5);
    const pnl = gross - fee(px, pos.qty) - pos.fee - fin;
    bal += pnl;
    trades.push({ r: pnl / pos.risk, g: raw / pos.risk });
    pos = null;
  };
  const mean20 = (end) => c.slice(end - 19, end + 1).reduce((a, x) => a + x.close, 0) / 20;
  for (let i = (P ? P[0] : 20) + 2; i < c.length; i++) {
    const bar = c[i];
    if (pos?.exitNext) close(i, bar.open);
    if (pos && (pos.side === 'long' ? bar.low <= pos.stop : bar.high >= pos.stop)) close(i, pos.side === 'long' ? Math.min(pos.stop, bar.open) : Math.max(pos.stop, bar.open));
    if (!pos && A[i - 1]) {
      const sig = c[i - 1];
      let side = null;
      if (P) {
        const prior = c.slice(i - 1 - P[0], i - 1);
        if (sig.close > Math.max(...prior.map((x) => x.high))) side = 'long';
        else if (sig.close < Math.min(...prior.map((x) => x.low))) side = 'short';
      } else {
        const win = c.slice(i - 20, i).map((x) => x.close);
        const m = win.reduce((a, b) => a + b, 0) / 20;
        const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
        if (sig.close < m - 2 * sd) side = 'long';
        else if (sig.close > m + 2 * sd) side = 'short';
      }
      if (side) {
        const entry = fill(side === 'long' ? 'buy' : 'sell', bar.open);
        const stop = side === 'long' ? bar.open - 2 * A[i - 1] : bar.open + 2 * A[i - 1];
        const qty = (bal * risk) / Math.abs(entry - stop);
        pos = { side, mid: bar.open, entry, stop, qty, fee: fee(entry, qty), risk: Math.abs(entry - stop) * qty, i };
        if (side === 'long' ? bar.low <= stop : bar.high >= stop) close(i, stop);
      }
    }
    if (pos) {
      if (P) {
        const win = c.slice(i - P[1], i);
        if (pos.side === 'long' ? bar.close < Math.min(...win.map((x) => x.low)) : bar.close > Math.max(...win.map((x) => x.high))) pos.exitNext = true;
      } else if ((pos.side === 'long' ? bar.close >= mean20(i) : bar.close <= mean20(i)) || i - pos.i >= 20) pos.exitNext = true;
      if (i === c.length - 1) close(i, bar.close);
    }
    const mtm = pos ? bal + (pos.side === 'long' ? bar.close - pos.entry : pos.entry - bar.close) * pos.qty - pos.fee : bal;
    peak = Math.max(peak, mtm);
    dd = Math.max(dd, (peak - mtm) / peak);
  }
  const n = trades.length;
  return { n, net: n ? trades.reduce((a, t) => a + t.r, 0) / n : 0, gross: n ? trades.reduce((a, t) => a + t.g, 0) / n : 0, ret: (bal / equity - 1) * 100, dd: dd * 100 };
}

const series = await load(process.argv.includes('--refresh'));
console.log('');
for (const design of ['A', 'B', 'R']) {
  for (const cls of ['fx', 'metal']) {
    const sets = { development: [], holdout: [] };
    for (const { symbol, assetClass, rows } of series) {
      if (assetClass !== cls) continue;
      const cut = Math.floor(rows.length * 0.6);
      const parts = DEV.includes(symbol) ? [['development', rows.slice(0, cut)], ['holdout', rows.slice(cut - 150)]] : [['holdout', rows]];
      for (const [set, data] of parts) sets[set].push(simulate(data, { symbol, assetClass, design }));
    }
    for (const [set, list] of Object.entries(sets)) {
      const n = list.reduce((a, r) => a + r.n, 0);
      if (!n) continue;
      const net = list.reduce((a, r) => a + r.net * r.n, 0) / n;
      const gross = list.reduce((a, r) => a + r.gross * r.n, 0) / n;
      console.log(`  ${design}  ${cls.padEnd(5)} ${set.padEnd(12)} ${String(n).padStart(5)} trades  ${net.toFixed(3).padStart(7)}R net  ${gross.toFixed(3).padStart(7)}R gross  ${list.filter((r) => r.ret > 0).length}/${list.length} profitable  worst DD ${Math.max(...list.map((r) => r.dd)).toFixed(1)}%`);
    }
  }
}
console.log('\n  R = the amount risked on a trade. Swaps are charged both ways, conservatively.\n');
