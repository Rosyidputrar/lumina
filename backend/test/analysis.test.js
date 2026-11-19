import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, closedBars } from '../src/analysis/engine.js';
import { RiskEngine } from '../src/analysis/risk.js';
import { Backtester } from '../src/analysis/backtest.js';
import * as I from '../src/analysis/indicators.js';
import { makeCandles } from './helpers.js';

test('indicators: EMA of a constant is the constant, RSI stays in range', () => {
  const flat = Array(50).fill(10);
  assert.ok(Math.abs(I.ema(flat, 21).at(-1) - 10) < 1e-9);
  const rsi = I.rsi(makeCandles(200).map((c) => c.close), 14).filter((v) => v !== null);
  assert.ok(rsi.every((v) => v >= 0 && v <= 100));
});

test('buildPlan refuses thin history instead of guessing', () => {
  const plan = buildPlan(makeCandles(30), { symbol: 'X', venue: 'fake', timeframe: '1h' });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'insufficient_history');
});

test('buildPlan returns either a complete plan or an explained no-trade', () => {
  for (const seed of [3, 7, 11, 19, 23]) {
    const plan = buildPlan(makeCandles(400, { seed, drift: seed % 2 ? 0.001 : -0.0008 }), { symbol: 'X', venue: 'fake', timeframe: '1h', strategy: 'classic' });
    assert.ok(plan.regime?.regime, 'regime is always reported');
    if (plan.ok) {
      assert.ok(['long', 'short'].includes(plan.direction));
      assert.ok(plan.confidence >= 0 && plan.confidence <= 100);
      if (plan.direction === 'long') assert.ok(plan.stop < plan.entry && plan.target1 > plan.entry);
      else assert.ok(plan.stop > plan.entry && plan.target1 < plan.entry);
      assert.ok(plan.factors.length > 0 && plan.invalidations.length > 0);
    } else {
      assert.ok(['no_setup', 'filtered_by_strategy'].includes(plan.reason), plan.reason);
      if (plan.reason === 'filtered_by_strategy') assert.ok(plan.filtered.every((f) => f.why));
    }
  }
});

test('closedBars drops the still-forming bar only', () => {
  const rows = makeCandles(10, { endTs: Date.now() - 10_000 });
  assert.equal(closedBars(rows, '1h').length, 9);
  for (const tf of ['5m', '15m', '30m', '4h', '1d']) assert.equal(closedBars(makeCandles(10, { endTs: Date.now() - 10_000 }), tf).length, 9, tf);
  const old = makeCandles(10, { endTs: Date.now() - 2 * 3_600_000 });
  assert.equal(closedBars(old, '1h').length, 10);
});

test('risk: size comes from the stop distance, not conviction', () => {
  const risk = new RiskEngine({ maxRiskPerTrade: 0.01 });
  const tight = risk.size({ equity: 10_000, entry: 100, stop: 99 });
  const wide = risk.size({ equity: 10_000, entry: 100, stop: 95 });
  assert.equal(tight.qty, 100);
  assert.equal(wide.qty, 20);
  assert.equal(tight.riskAmount, 100);
  assert.equal(wide.riskAmount, 100);
});

test('risk: the gate explains every rejection', () => {
  const risk = new RiskEngine({ minConfidence: 60, minRewardRisk: 1.5, maxOpenPositions: 1, maxEntriesPerSymbol: 1 });
  const plan = { ok: true, symbol: 'X', direction: 'long', entry: 100, stop: 99, confidence: 50, rewardRisk: 1, snapshot: { price: 100 } };
  const d = risk.evaluate(plan, { equity: 10_000, openPositions: [{ symbol: 'X', side: 'long', entry: 100, stop: 99, qty: 1 }] });
  assert.equal(d.approved, false);
  assert.ok(d.reasons.some((r) => r.includes('confidence')));
  assert.ok(d.reasons.some((r) => r.includes('reward/risk')));
  assert.ok(d.reasons.some((r) => r.includes('max open positions')));
  const manual = risk.evaluate({ ...plan, manual: true }, { equity: 10_000, openPositions: [] });
  assert.equal(manual.approved, true);
});

test('backtest runs on closed bars and reports its assumptions', () => {
  const r = new Backtester({ config: { account: { maxRiskPerTrade: 0.005, minConfidence: 0, minRewardRisk: 0 } } }).run(makeCandles(500), { symbol: 'X', strategy: 'classic' });
  assert.equal(r.ok, true);
  assert.ok(r.bars > 0 && r.bars <= 500);
  assert.ok(Array.isArray(r.curve));
  assert.ok(r.assumptions.length >= 3);
  assert.ok(Number.isFinite(r.endingEquity));
});
