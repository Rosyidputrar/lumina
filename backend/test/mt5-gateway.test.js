import test from 'node:test';
import assert from 'node:assert/strict';
import { Mt5Broker, fillingFor } from '../src/execution/mt5-broker.js';
import { mt5Provider } from '../src/market/data.js';
import { startFakeGateway } from './fake-mt5-gateway.js';
import { startApp, client, OWNER } from './helpers.js';

test('talks to mt5-gateway with X-API-Key and reads its bare-array responses', async () => {
  const gw = await startFakeGateway();
  try {
    const broker = new Mt5Broker({ baseUrl: gw.baseUrl, apiKey: gw.apiKey });
    assert.equal((await broker.ready()).ok, true);
    assert.equal((await broker.account()).currency, 'USD');
    assert.deepEqual(await broker.symbols('*'), ['EURUSD', 'XAUUSD']);

    const bars = await broker.candles({ symbol: 'EURUSD', timeframe: '1h', limit: 120 });
    assert.equal(bars.length, 120, 'a bare array of bars is read, not dropped');
    assert.ok(bars.every((b, i) => !i || b.ts > bars[i - 1].ts));
    assert.ok(Math.abs(bars.at(-1).ts - Date.now()) < 3 * 3600_000, 'ISO bar times parse to real time');

    const quote = await mt5Provider({ broker }).ticker({ symbol: 'EURUSD' });
    assert.ok(Math.abs(quote.ts - Date.now()) < 60_000, 'tick time in seconds is not read as milliseconds');

    const wrong = new Mt5Broker({ baseUrl: gw.baseUrl, apiKey: 'nope' });
    await assert.rejects(wrong.account(), (e) => e.code === 'GATEWAY_UNAUTHORIZED');
    assert.equal(gw.state.requests.find((r) => r.path === '/account').headers['x-api-key'], gw.apiKey);
  } finally {
    await gw.close();
  }
});

test('orders use the symbol filling mode, rounded prices and a Lumina magic number', async () => {
  const gw = await startFakeGateway();
  try {
    const broker = new Mt5Broker({ baseUrl: gw.baseUrl, apiKey: gw.apiKey });
    assert.equal(fillingFor({ filling_mode: 1 }), 'FOK');
    assert.equal(fillingFor({ filling_mode: 3 }), 'IOC');
    assert.equal(fillingFor({ filling_mode: 0 }), 'RETURN');

    const size = await broker.sizeForRisk({ symbol: 'EURUSD', side: 'buy', entry: 1.1, stop: 1.095, equity: 10000, riskPct: 0.005 });
    assert.equal(size.qty, 0.1, '50 USD risk over 50 pips on a 100k contract is 0.10 lot');

    const res = await broker.placeProtected({ symbol: 'EURUSD', side: 'buy', qty: 0.1234, stop: 1.0951234567, target: 1.1123456789 });
    assert.equal(res.protected, true);
    const sent = gw.state.requests.find((r) => r.path === '/order').body;
    assert.equal(sent.type_filling, 'FOK', 'EURUSD here only allows FOK');
    assert.equal(sent.volume, 0.12, 'volume floored to the 0.01 step');
    assert.equal(sent.sl, 1.09512, 'stop rounded to 5 digits');
    assert.ok(sent.magic > 0);

    await broker.modifyProtection({ positionId: res.brokerOrderId, symbol: 'EURUSD', stop: 1.0991234 });
    assert.equal((await broker.positions()).positions[0].stop, 1.09912);
    const closed = await broker.close({ positionId: res.brokerOrderId });
    assert.ok(closed.price > 0);
    assert.equal((await broker.positions()).positions.length, 0);
  } finally {
    await gw.close();
  }
});

test('a stop the broker drops is set again, and a position that stays unprotected is closed', async () => {
  const dropped = await startFakeGateway({ quirks: { dropStops: true } });
  try {
    const broker = new Mt5Broker({ baseUrl: dropped.baseUrl, apiKey: dropped.apiKey });
    const px = (await broker.tick('XAUUSD')).bid;
    const stop = Number((px + 50).toFixed(2));
    const r = await broker.placeProtected({ symbol: 'XAUUSD', side: 'sell', qty: 0.05, stop, target: Number((px - 100).toFixed(2)) });
    assert.equal(r.protected, true, 'the second attempt through /modify_sl_tp held');
    assert.equal((await broker.positions()).positions[0].stop, stop);
  } finally {
    await dropped.close();
  }
  const stubborn = await startFakeGateway({ quirks: { dropStops: true, refuseModify: true } });
  try {
    const broker = new Mt5Broker({ baseUrl: stubborn.baseUrl, apiKey: stubborn.apiKey });
    const px = (await broker.tick('XAUUSD')).ask;
    const r = await broker.placeProtected({ symbol: 'XAUUSD', side: 'buy', qty: 0.05, stop: px - 50, target: px + 100 });
    assert.equal(r.protected, false);
    assert.equal(r.flattened, true, 'never left open without a stop');
    assert.equal((await broker.positions()).positions.length, 0);
  } finally {
    await stubborn.close();
  }
});

test('end to end: the owner trades a live MT5 ticket through the app', async () => {
  const gw = await startFakeGateway();
  const broker = new Mt5Broker({ baseUrl: gw.baseUrl, apiKey: gw.apiKey });
  const app = await startApp({ broker, live: true, providers: { mt5: mt5Provider({ broker }) }, watchlist: [{ symbol: 'EURUSD', venue: 'mt5', label: 'EUR / USD', assetClass: 'fx' }] });
  try {
    const c = client(app.base);
    assert.equal((await c.post('/api/owner/login', { passphrase: OWNER })).status, 200);
    const live = await c.patch('/api/account/live', { enabled: true });
    assert.equal(live.status, 200, live.text);
    const t = await c.get('/api/terminal');
    assert.equal(t.json.live.mode, 'live');
    assert.equal(t.json.account.currency, 'USD');
    const price = t.json.quotes[0].price;

    const order = await c.post('/api/positions', { symbol: 'EURUSD', side: 'buy', qty: 0.05, stop: Number((price - 0.004).toFixed(5)), target: Number((price + 0.008).toFixed(5)) });
    assert.equal(order.status, 200, order.text);
    assert.equal(order.json.live, true);
    assert.equal(gw.state.positions.length, 1, 'the order reached the broker');

    const book = await c.get('/api/positions');
    const pos = book.json.positions[0];
    assert.equal(pos.mode, 'live');
    assert.equal(pos.broker_position_id, String(gw.state.positions[0].ticket));

    const amend = await c.patch(`/api/positions/${pos.id}`, { stop: Number((pos.entry - 0.002).toFixed(5)) });
    assert.equal(amend.status, 200, amend.text);
    assert.equal(gw.state.positions[0].sl, Number((pos.entry - 0.002).toFixed(5)), 'the stop moved at the broker, not only here');

    const closed = await c.post(`/api/positions/${pos.id}/close`, {});
    assert.equal(closed.status, 200, closed.text);
    assert.equal(gw.state.positions.length, 0, 'closed at the broker');
  } finally {
    await app.close();
    await gw.close();
  }
});
