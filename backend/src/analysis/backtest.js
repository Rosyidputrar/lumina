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
import { buildPlan, channelExit, currentStrategy } from './engine.js';
import { DEFAULT_COSTS, costClass, costsFor } from './costs.js';
import * as I from './indicators.js';
import { RiskEngine } from './risk.js';

const round = (v, d = 4) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export class Backtester {
  constructor({ config, risk = null, costs = null } = {}) {
    this.config = config;
    this.costTable = costs ?? config?.costs ?? DEFAULT_COSTS;
    this.risk = risk ?? new RiskEngine(config?.account ?? {});
  }

  /**
   * Replay the live decision path bar by bar.
   *
   * What it mirrors from the live engine, on purpose:
   *   - the same 400-bar analysis window, closed bars only;
   *   - the same risk gate and position sizing;
   *   - the same stop management: break-even at ~0.9R, then an ATR trail;
   *   - costs for the instrument's asset class on both legs.
   * Conservative where the bar is ambiguous: a stop touched on the entry bar
   * counts, and when one bar touches both stop and target the stop wins.
   */
  run(candles, { warmup = 120, equity = 10000, timeframe = '1h', symbol = 'SIM', venue = 'backtest', assetClass = null, strategy = undefined, trace = false } = {}) {
    if (!Array.isArray(candles) || candles.length < warmup + 30) {
      return { ok: false, reason: 'insufficient_history', bars: candles?.length ?? 0 };
    }
    const costs = costsFor({ assetClass, symbol, venue }, this.costTable);
    const fillPx = (side, mid) => mid * (1 + (side === 'buy' ? 1 : -1) * (costs.spreadBps / 2 + costs.slippageBps) / 10000);
    const feeOf = (px, qty) => (px * qty * costs.feeBps) / 10000;
    const atrSeries = I.atr(candles, 14);
    const window = this.config?.loop?.historyBars ?? 400;

    let balance = equity;
    const trades = [];
    const curve = [];
    let open = null;
    let peak = equity;
    let maxDrawdown = 0;
    let blocked = 0;

    const closeAt = (i, exitMid, reason) => {
      const bar = candles[i];
      const px = fillPx(open.side === 'long' ? 'sell' : 'buy', exitMid);
      const gross = open.side === 'long' ? (px - open.entry) * open.qty : (open.entry - px) * open.qty;
      const raw = open.side === 'long' ? (exitMid - open.mid) * open.qty : (open.mid - exitMid) * open.qty;
      const exitFee = feeOf(px, open.qty);
      // Overnight financing (swap/funding) for every calendar day held.
      const days = Math.max(0, (bar.ts - open.ts) / 86_400_000);
      const finance = ((costs.financeBpsPerDay ?? 0) / 10000) * open.mid * open.qty * days;
      const pnl = gross - exitFee - open.entryFee - finance;
      balance += pnl;
      trades.push({
        side: open.side,
        entryTs: open.ts,
        exitTs: bar.ts,
        entry: round(open.entry, 6),
        exit: round(px, 6),
        qty: round(open.qty, 8),
        pnl: round(pnl, 4),
        fees: round(exitFee + open.entryFee + finance, 4),
        rMultiple: round(pnl / open.riskAmount, 3),
        grossR: round(raw / open.riskAmount, 3),
        reason,
        bars: i - open.index,
        playbook: open.playbook,
        confidence: open.confidence,
      });
      open = null;
    };

    for (let i = warmup; i < candles.length; i++) {
      const bar = candles[i];

      /* ------------------------------ new entry ------------------------------ */
      // Decided on the bars closed before this one, filled at this bar's open.
      if (!open) {
        const plan = buildPlan(candles.slice(Math.max(0, i - window), i), { symbol, venue, timeframe, assetClass, costs, strategy });
        if (plan.ok && (plan.systematic || (plan.confidence >= this.risk.policy.minConfidence && plan.rewardRisk >= this.risk.policy.minRewardRisk))) {
          const sizing = this.risk.size({ equity: balance, entry: plan.entry, stop: plan.stop, price: plan.entry });
          const side = plan.direction === 'long' ? 'buy' : 'sell';
          const entry = fillPx(side, bar.open);
          // A gap through the stop, or through the target, makes the plan stale.
          const hasTarget = plan.target1 !== null && plan.target1 !== undefined;
          const stale = plan.direction === 'long' ? entry <= plan.stop || (hasTarget && entry >= plan.target1) : entry >= plan.stop || (hasTarget && entry <= plan.target1);
          if (!(sizing.qty > 0) || stale) blocked++;
          else {
            open = {
              side: plan.direction,
              mid: bar.open,
              entry,
              qty: sizing.qty,
              stop: plan.stop,
              initialStop: plan.stop,
              target: plan.target1,
              ts: bar.ts,
              index: i,
              entryFee: feeOf(entry, sizing.qty),
              riskAmount: Math.abs(entry - plan.stop) * sizing.qty,
              playbook: plan.playbook,
              confidence: plan.confidence,
              exit: plan.exit ?? null,
            };
          }
        }
      }

      /* --------------------------- manage open trade -------------------------- */
      // A channel exit decided on the previous closed bar fills at this open.
      if (open && open.exitNext && i > open.index) closeAt(i, bar.open, 'channel_exit');
      if (open) {
        const long = open.side === 'long';
        const hitStop = long ? bar.low <= open.stop : bar.high >= open.stop;
        // On the entry bar only the stop is trusted: the order of high and low is unknown.
        const hitTarget = i > open.index && open.target !== null && open.target !== undefined && (long ? bar.high >= open.target : bar.low <= open.target);
        if (hitStop) closeAt(i, long ? Math.min(open.stop, bar.open) : Math.max(open.stop, bar.open), 'stop_loss');
        else if (hitTarget) closeAt(i, long ? Math.max(open.target, bar.open) : Math.min(open.target, bar.open), 'take_profit');
        else if (i === candles.length - 1) closeAt(i, bar.close, 'end_of_test');
        else if (open.exit?.type === 'channel') {
          // Judged on this bar once it has closed; filled at the next open.
          if (channelExit(open.side, candles.slice(Math.max(0, i - window), i + 1), open.exit.bars)) open.exitNext = true;
        } else {
          // The live engine amends the stop on each cycle from the closed bar.
          const next = this.risk.manageStop({ side: open.side, entry: open.mid, stop: open.stop, initialStop: open.initialStop }, bar.close, atrSeries[i]);
          if (next) open.stop = next;
        }
      }

      const mtm = open ? balance + (open.side === 'long' ? (bar.close - open.entry) * open.qty : (open.entry - bar.close) * open.qty) - open.entryFee : balance;
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
    const cagr = years > 0 && balance > 0 ? (1 + ret) ** (1 / years) - 1 : 0;
    const rMultiples = trades.map((t) => t.rMultiple);
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

    return {
      ok: true,
      symbol,
      venue,
      timeframe,
      strategy: strategy ?? currentStrategy(),
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
      profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? null : 0,
      expectancyR: round(mean(rMultiples), 3),
      averageR: round(mean(rMultiples), 3),
      grossR: round(mean(trades.map((t) => t.grossR)), 3),
      feesPaid: round(trades.reduce((a, t) => a + t.fees, 0), 2),
      maxDrawdownPct: round(maxDrawdown, 2),
      avgBarsHeld: trades.length ? round(trades.reduce((a, t) => a + t.bars, 0) / trades.length, 1) : 0,
      byPlaybook: summariseBy(trades),
      curve,
      tradeLog: trace ? trades : trades.slice(-40),
      costs,
      assumptions: [
        'Signals use the same 400 closed bars the live engine reads; entries fill at the next bar open.',
        'A stop touched on the entry bar counts; when a bar touches both stop and target, the stop fills first.',
        'Stops move to break-even near 1R and then trail by ATR, as the live engine does.',
        `Costs for this ${costClass({ assetClass, symbol, venue })} instrument: spread ${costs.spreadBps} bps, slippage ${costs.slippageBps} bps and fee ${costs.feeBps} bps per side.`,
        costs.financeBpsPerDay ? `Overnight financing of ${costs.financeBpsPerDay} bps of notional a day is charged in both directions (about ${(costs.financeBpsPerDay * 3.65).toFixed(1)}% a year).` : 'No overnight financing for this instrument (spot).',
        'Results are not a forecast.',
      ],
    };
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
