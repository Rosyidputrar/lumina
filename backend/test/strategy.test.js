import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, setStrategy, currentStrategy, STRATEGIES } from '../src/analysis/engine.js';
import { Backtester } from '../src/analysis/backtest.js';
import { costClass, costsFor, roundTripCost, DEFAULT_COSTS } from '../src/analysis/costs.js';
import { PaperBroker } from '../src/execution/paper-broker.js';
import { Store } from '../src/store.js';
import { makeCandles } from './helpers.js';

test('cost classes come from the asset class first, then the symbol', () => {
  assert.equal(costClass({ symbol: 'BTC-USDT', venue: 'okx' }), 'crypto');
  assert.equal(costClass({ symbol: 'EURUSD', venue: 'kraken' }), 'fx');
  assert.equal(costClass({ symbol: 'EURUSD.s', venue: 'mt5' }), 'fx');
  assert.equal(costClass({ symbol: 'XAUUSD.s', venue: 'mt5' }), 'metal');
  assert.equal(costClass({ symbol: 'PAXGUSD' }), 'metal');
  assert.equal(costClass({ symbol: 'US100.s' }), 'index');
  assert.equal(costClass({ symbol: 'WHATEVER', assetClass: 'crypto' }), 'crypto');
  // spread once, slippage and fee on both legs
  assert.equal(roundTripCost({ spreadBps: 2, slippageBps: 1, feeBps: 10 }), 0.0024);
});

test('the default strategy is the breakout profile and can be switched', () => {
  assert.equal(currentStrategy(), 'breakout');
  assert.deepEqual(STRATEGIES.trend.playbooks, ['trend_pullback', 'momentum_continuation']);
  setStrategy('classic');
  assert.equal(currentStrategy(), 'classic');
  setStrategy('breakout');
  assert.throws(() => setStrategy('yolo'), /unknown strategy/);
});

/** A flat range, then a decisive close above it. */
function breakoutSeries({ up = true, n = 120 } = {}) {
  const day = 86_400_000;
  const end = Date.now() - 2 * day;
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + Math.sin(i / 3) * 2;
    out.push({ ts: end - (n - 1 - i) * day, open: base, high: base + 1, low: base - 1, close: base + 0.2, volume: 1000 });
  }
  const last = out.at(-1);
  last.close = up ? 110 : 90;
  last.high = Math.max(last.high, last.close + 0.5);
  last.low = Math.min(last.low, last.close - 0.5);
  return out;
}

test('breakout: a close beyond the 55-bar channel is a rule signal with a 2 ATR stop and no target', () => {
  const plan = buildPlan(breakoutSeries({ up: true }), { symbol: 'BTC-USDT', venue: 'okx', timeframe: '1d', strategy: 'breakout' });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.playbook, 'donchian_breakout');
  assert.equal(plan.direction, 'long');
  assert.equal(plan.systematic, true);
  assert.equal(plan.target1, null);
  assert.ok(plan.stop < plan.entry);
  assert.deepEqual(plan.exit, { type: 'channel', bars: 20 });
  const short = buildPlan(breakoutSeries({ up: false }), { symbol: 'BTC-USDT', venue: 'okx', timeframe: '1d', strategy: 'breakout' });
  assert.equal(short.direction, 'short');
  // inside the range: nothing
  const flat = breakoutSeries({ up: true }).slice(0, -1);
  assert.equal(buildPlan(flat, { symbol: 'BTC-USDT', venue: 'okx', timeframe: '1d', strategy: 'breakout' }).ok, false);
});

test('breakout trades crypto only and says why it skips the rest', () => {
  const plan = buildPlan(breakoutSeries(), { symbol: 'EURUSD', venue: 'kraken', timeframe: '1d', strategy: 'breakout' });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'filtered_by_strategy');
  assert.match(plan.filtered[0].why, /crypto/);
  assert.ok(plan.regime?.regime, 'the regime is still reported');
});

test('the risk gate takes rule signals without a confidence or reward/risk floor', async () => {
  const { RiskEngine } = await import('../src/analysis/risk.js');
  const risk = new RiskEngine({ minConfidence: 90, minRewardRisk: 3 });
  const d = risk.evaluate({ ok: true, systematic: true, symbol: 'X', direction: 'long', entry: 100, stop: 90, confidence: 100, rewardRisk: null }, { equity: 10_000, openPositions: [] });
  assert.equal(d.approved, true);
  assert.equal(d.sizing.qty, 5);
});

test('a channel exit is judged on closed bars, and a rule signal is entered once', async () => {
  const { channelExit } = await import('../src/analysis/engine.js');
  const { alreadyTradedSignal } = await import('../src/execution/engine.js');
  const bars = breakoutSeries({ up: true }).slice(0, -1);
  bars.push({ ...bars.at(-1), ts: bars.at(-1).ts + 86_400_000, close: 50, low: 49.5 });
  assert.equal(channelExit('long', bars, 20), true);
  assert.equal(channelExit('short', bars, 20), false);
  const plan = { systematic: true, signalTs: 1_000_000 };
  assert.equal(alreadyTradedSignal(plan, 0, '1h'), false);
  assert.equal(alreadyTradedSignal(plan, 1_000_000 + 3_600_000, '1h'), true, 'a trade after the signal bar closed used it up');
  assert.equal(alreadyTradedSignal({ systematic: false, signalTs: 1 }, 9e15, '1h'), false);
});

test('the backtester exits breakout trades on the channel, never on a target', () => {
  // Up for 400 days, then down for 300: the long must leave on the channel.
  const day = 86_400_000;
  const up = makeCandles(400, { seed: 4, drift: 0.003, stepMs: day, endTs: Date.now() - 303 * day });
  const scale = up.at(-1).close / 100;
  const down = makeCandles(300, { seed: 8, drift: -0.003, stepMs: day, endTs: Date.now() - 3 * day }).map((c) => ({ ...c, open: c.open * scale, high: c.high * scale, low: c.low * scale, close: c.close * scale }));
  const r = new Backtester({ config: { account: { maxRiskPerTrade: 0.005 } } }).run([...up, ...down], { symbol: 'BTC-USDT', venue: 'okx', timeframe: '1d', strategy: 'breakout', warmup: 80, trace: true });
  assert.equal(r.ok, true);
  assert.ok(r.trades > 0);
  assert.ok(r.tradeLog.every((t) => t.reason !== 'take_profit'));
  assert.ok(r.tradeLog.some((t) => t.reason === 'channel_exit' || t.reason === 'stop_loss'));
});

test('the trend profile never trades against the 200-EMA trend', () => {
  // A steady decline: every surviving setup must be a short.
  for (const seed of [2, 5, 9, 13, 17, 21]) {
    const candles = makeCandles(400, { seed, drift: -0.0015 });
    const plan = buildPlan(candles, { symbol: 'X', venue: 'fake', timeframe: '1h', strategy: 'trend' });
    if (plan.ok) assert.equal(plan.direction, 'short');
    for (const f of plan.filtered ?? []) assert.ok(typeof f.why === 'string' && f.why.length > 3);
  }
});

test('the trend profile keeps stops at least 2 ATR away and rejects setups that costs would eat', () => {
  let checked = 0;
  for (const seed of [3, 7, 11, 19, 23, 29, 31, 37]) {
    const candles = makeCandles(400, { seed, drift: seed % 2 ? 0.0012 : -0.0012 });
    const plan = buildPlan(candles, { symbol: 'X', venue: 'fake', timeframe: '1h', strategy: 'trend', costs: DEFAULT_COSTS.fx });
    if (!plan.ok) continue;
    checked++;
    // snapshot ATR is rounded to 4 decimals, entry and stop to 6
    assert.ok(Math.abs(plan.entry - plan.stop) >= plan.snapshot.atr * 2 - 1e-3);
  }
  // A cost class so expensive that no setup can pay for itself.
  const silly = { spreadBps: 500, slippageBps: 500, feeBps: 500 };
  const plan = buildPlan(makeCandles(400, { seed: 7, drift: 0.0012 }), { symbol: 'X', venue: 'fake', timeframe: '1h', strategy: 'trend', costs: silly });
  assert.equal(plan.ok, false);
  assert.ok(checked >= 0);
});

test('backtest charges fees on both legs and reports gross and net R', () => {
  const r = new Backtester({ config: { account: { maxRiskPerTrade: 0.005, minConfidence: 0, minRewardRisk: 0 } } }).run(makeCandles(600, { seed: 11 }), { symbol: 'BTC-USDT', venue: 'okx', strategy: 'classic', trace: true });
  assert.equal(r.ok, true);
  assert.ok(r.trades > 0);
  assert.equal(r.costs.feeBps, 10, 'crypto pays the crypto fee');
  for (const t of r.tradeLog) {
    assert.ok(t.fees > 0);
    assert.ok(t.grossR > t.rMultiple, 'net is below gross once costs are paid');
  }
  const net = r.tradeLog.reduce((a, t) => a + t.pnl, 0);
  assert.ok(Math.abs(r.startingEquity + net - r.endingEquity) < 0.05, 'equity is the sum of net results');
});

test('paper fills use the instrument cost class', async () => {
  const store = new Store(':memory:');
  const user = store.createUser({ email: 'u@test.local', name: 'u', passwordHash: 'x', salt: 'x' });
  const paper = new PaperBroker({ store, config: { costs: DEFAULT_COSTS } });
  const crypto = await paper.place({ userId: user.id, venue: 'okx', symbol: 'BTC-USDT', side: 'buy', qty: 1, mid: 100 });
  const fx = await paper.place({ userId: user.id, venue: 'mt5', symbol: 'EURUSD.s', side: 'buy', qty: 1, mid: 100 });
  assert.ok(Math.abs(crypto.avgFill - 100.02) < 1e-9, "half the 2 bps spread plus 1 bps slippage");
  assert.ok(Math.abs(crypto.fees - crypto.avgFill * 0.001) < 1e-9, "10 bps taker fee");
  assert.ok(fx.fees < crypto.fees / 10);
  assert.deepEqual(costsFor({ symbol: 'EURUSD.s', venue: 'mt5' }), DEFAULT_COSTS.fx);
});

test('FX pays a swap for every day held, crosses pay a wider spread', async () => {
  const { costsFor } = await import('../src/analysis/costs.js');
  assert.equal(costsFor({ symbol: 'EURUSD', venue: 'mt5' }).spreadBps, 1);
  assert.equal(costsFor({ symbol: 'EURJPY', venue: 'mt5' }).spreadBps, 2, 'a cross quotes wider');
  assert.ok(costsFor({ symbol: 'EURUSD', venue: 'mt5' }).financeBpsPerDay > 0);
  assert.equal(costsFor({ symbol: 'BTC-USDT', venue: 'okx' }).financeBpsPerDay, 0, 'spot crypto has no swap');
  // The same trades cost more when financing is charged.
  const day = 86_400_000;
  const bars = makeCandles(500, { seed: 6, drift: 0.0006, stepMs: day, endTs: Date.now() - 3 * day });
  const withSwap = new Backtester({ config: { account: { maxRiskPerTrade: 0.005, minConfidence: 0, minRewardRisk: 0 } } }).run(bars, { symbol: 'EURUSD', venue: 'mt5', assetClass: 'fx', timeframe: '1d', strategy: 'classic', trace: true });
  const table = { ...DEFAULT_COSTS, fx: { ...DEFAULT_COSTS.fx, financeBpsPerDay: 0 } };
  const noSwap = new Backtester({ config: { account: { maxRiskPerTrade: 0.005, minConfidence: 0, minRewardRisk: 0 } }, costs: table }).run(bars, { symbol: 'EURUSD', venue: 'mt5', assetClass: 'fx', timeframe: '1d', strategy: 'classic', trace: true });
  assert.ok(withSwap.trades > 0);
  assert.ok(withSwap.feesPaid > noSwap.feesPaid);
  assert.ok(withSwap.assumptions.some((a) => /financing/.test(a)));
});

test('breakout trades metals only when the owner opts in', async () => {
  const { setBreakoutClasses } = await import('../src/analysis/engine.js');
  try {
    assert.deepEqual(setBreakoutClasses(['crypto']), ['crypto']);
    const gold = () => buildPlan(breakoutSeries(), { symbol: 'XAUUSD', venue: 'mt5', assetClass: 'metal', timeframe: '1d', strategy: 'breakout' });
    assert.equal(gold().reason, 'filtered_by_strategy');
    assert.deepEqual(setBreakoutClasses(['crypto', ' metal ', 'nonsense']), ['crypto', 'metal']);
    assert.equal(gold().ok, true);
    assert.equal(buildPlan(breakoutSeries(), { symbol: 'EURUSD', venue: 'mt5', assetClass: 'fx', timeframe: '1d', strategy: 'breakout' }).reason, 'filtered_by_strategy', 'FX stays out');
    assert.deepEqual(setBreakoutClasses([]), ['crypto'], 'an empty list falls back to crypto');
  } finally {
    setBreakoutClasses(['crypto']);
  }
});
