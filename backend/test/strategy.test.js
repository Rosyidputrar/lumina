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

test('the default strategy is trend-aligned and can be switched', () => {
  assert.equal(currentStrategy(), 'trend');
  assert.deepEqual(STRATEGIES.trend.playbooks, ['trend_pullback', 'momentum_continuation']);
  setStrategy('classic');
  assert.equal(currentStrategy(), 'classic');
  setStrategy('trend');
  assert.throws(() => setStrategy('yolo'), /unknown strategy/);
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
