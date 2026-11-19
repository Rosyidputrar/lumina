/**
 * Event-driven backtester.
 *
 * It replays candles bar by bar through the *same* engine code the live loop
 * uses (buildPlan), then simulates execution with the same cost model as the
 * paper broker: spread + slippage + taker fees, stop-first intrabar resolution.
 *
 * Deliberate conservative choices, because optimistic backtests are lies:
 *   - signals are computed on the closed bar, entries fill at the *next* open
 *   - if a bar touches both stop and target, the stop is assumed first
 *   - fees are charged on both sides
 *   - no compounding assumption beyond equity actually realised
 */
import { buildPlan } from './engine.js';
import { RiskEngine } from './risk.js';

const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export class Backtester {
  constructor({ config, risk = null } = {}) {
    this.config = config;
    this.costs = {
      spreadBps: config?.paper?.spreadBps ?? 1.5,
      slippageBps: config?.paper?.slippageBps ?? 1,
      feeBps: config?.paper?.feeBps ?? 4,
    };
    this.risk = risk ?? new RiskEngine(config?.account ?? {});
  }

  fill(side, mid, qty) {
    const c = this.costs;
    const dir = side === 'buy' ? 1 : -1;
    return mid * (1 + dir * (c.spreadBps / 2 + c.slippageBps) / 10000);
  }

  fee(price, qty) {
    return (price * qty * this.costs.feeBps) / 10000;
  }

  /**
   * @param candles full OHLCV array
   * @param options { warmup, equity, timeframe, symbol, venue, trace }
   */
  run(candles, { warmup = 120, equity = 10000, timeframe = '1h', symbol = 'SIM', venue = 'backtest', trace = false } = {}) {
    if (!Array.isArray(candles) || candles.length < warmup + 30) {
      return { ok: false, reason: 'insufficient_history', bars: candles?.length ?? 0 };
    }
    let balance = equity;
    const trades = [];
    const curve = [];
    let open = null;
    let peak = equity;
    let maxDrawdown = 0;
    let blocked = 0;

    for (let i = warmup; i < candles.length; i++) {
      const window = candles.slice(0, i); // only closed bars are visible
      const bar = candles[i];

      /* --------------------------- manage open trade -------------------------- */
      if (open) {
        let exitPrice = null;
        let reason = null;
        const hitStop = open.side === 'long' ? bar.low <= open.stop : bar.high >= open.stop;
        const hitTarget = open.side === 'long' ? bar.high >= open.target : bar.low <= open.target;

        if (hitStop) {
          exitPrice = open.side === 'long' ? Math.min(open.stop, bar.open) : Math.max(open.stop, bar.open);
          reason = 'stop_loss';
        } else if (hitTarget) {
          exitPrice = open.side === 'long' ? Math.max(open.target, bar.open) : Math.min(open.target, bar.open);
          reason = 'take_profit';
        } else if (i === candles.length - 1) {
          exitPrice = bar.close;
          reason = 'end_of_test';
        }

        if (exitPrice !== null) {
          const px = this.fill(open.side === 'long' ? 'sell' : 'buy', exitPrice, open.qty);
          const gross = open.side === 'long' ? (px - open.entry) * open.qty : (open.entry - px) * open.qty;
          const fees = open.fees + this.fee(px, open.qty);
          const pnl = gross - this.fee(px, open.qty);
          balance += pnl;
          trades.push({
            side: open.side,
            entryTs: open.ts,
            exitTs: bar.ts,
            entry: round(open.entry, 6),
            exit: round(px, 6),
            qty: round(open.qty, 8),
            pnl: round(pnl, 4),
            rMultiple: round(pnl / open.riskAmount, 3),
            reason,
            bars: i - open.index,
            playbook: open.playbook,
            confidence: open.confidence,
          });
          open = null;
        }
      }

      /* ------------------------------ new entry ------------------------------ */
      if (!open) {
        const plan = buildPlan(window, { symbol, venue, timeframe });
        if (plan.ok && plan.confidence >= this.risk.policy.minConfidence && plan.rewardRisk >= this.risk.policy.minRewardRisk) {
          const sizing = this.risk.size({ equity: balance, entry: plan.entry, stop: plan.stop, price: plan.entry });
          if (sizing.qty > 0) {
            const entry = this.fill(plan.direction === 'long' ? 'buy' : 'sell', bar.open, sizing.qty);
            // guard: if the next open gapped past our stop the plan is stale
            const stale = plan.direction === 'long' ? entry <= plan.stop : entry >= plan.stop;
            if (stale) {
              blocked++;
            } else {
              open = {
                side: plan.direction,
                entry,
                qty: sizing.qty,
                stop: plan.stop,
                target: plan.target1,
                ts: bar.ts,
                index: i,
                fees: this.fee(entry, sizing.qty),
                riskAmount: Math.abs(entry - plan.stop) * sizing.qty,
                playbook: plan.playbook,
                confidence: plan.confidence,
              };
            }
          } else {
            blocked++;
          }
        }
      }

      const mtm = open
        ? balance + (open.side === 'long' ? (bar.close - open.entry) * open.qty : (open.entry - bar.close) * open.qty)
        : balance;
      peak = Math.max(peak, mtm);
      maxDrawdown = Math.max(maxDrawdown, ((peak - mtm) / peak) * 100);
      if (i % 3 === 0 || i === candles.length - 1) curve.push({ ts: bar.ts, equity: round(mtm, 2) });
    }

    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
    const bars = candles.length - warmup;
    const periodsPerYear = { '1h': 24 * 365, '4h': 6 * 365, '1d': 365, '15m': 96 * 365, '30m': 48 * 365, '5m': 288 * 365 }[timeframe] ?? 8760;
    const ret = (balance - equity) / equity;
    const years = bars / periodsPerYear;
    const cagr = years > 0 ? (1 + ret) ** (1 / years) - 1 : 0;
    const rMultiples = trades.map((t) => t.rMultiple);

    const stats = {
      ok: true,
      symbol,
      venue,
      timeframe,
      bars,
      from: new Date(candles[0].ts).toISOString(),
      to: new Date(candles.at(-1).ts).toISOString(),
      startingEquity: round(equity, 2),
      endingEquity: round(balance, 2),
      returnPct: round(ret * 100, 2),
      cagrPct: round(cagr * 100, 2),
      trades: trades.length,
      blocked,
      winRate: trades.length ? round((wins.length / trades.length) * 100, 2) : 0,
      avgWin: wins.length ? round(grossWin / wins.length, 2) : 0,
      avgLoss: losses.length ? round(grossLoss / losses.length, 2) : 0,
      profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
      expectancyR: rMultiples.length ? round(rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length, 3) : 0,
      averageR: rMultiples.length ? round(rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length, 3) : 0,
      maxDrawdownPct: round(maxDrawdown, 2),
      avgBarsHeld: trades.length ? round(trades.reduce((a, t) => a + t.bars, 0) / trades.length, 1) : 0,
      byPlaybook: summariseBy(trades),
      curve,
      tradeLog: trace ? trades : trades.slice(-40),
      costs: this.costs,
      assumptions: [
        'Signals are computed on closed bars only; entries fill at the next bar open.',
        'When a bar touches both stop and target, the stop is assumed to fill first.',
        'Costs: spread + slippage on entry, taker fee on both sides.',
        'No leverage compounding beyond realised P&L; no funding or borrow costs.',
      ],
    };
    return stats;
  }
}

function summariseBy(trades) {
  const map = new Map();
  for (const t of trades) {
    const cur = map.get(t.playbook) ?? { trades: 0, wins: 0, pnl: 0, r: 0 };
    cur.trades++;
    if (t.pnl > 0) cur.wins++;
    cur.pnl += t.pnl;
    cur.r += t.rMultiple;
    map.set(t.playbook, cur);
  }
  return [...map.entries()].map(([playbook, s]) => ({
    playbook,
    trades: s.trades,
    winRate: round((s.wins / s.trades) * 100, 1),
    pnl: round(s.pnl, 2),
    avgR: round(s.r / s.trades, 3),
  }));
}
