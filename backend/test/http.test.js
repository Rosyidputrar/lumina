import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, client, OWNER } from './helpers.js';

let app;
test.before(async () => { app = await startApp(); });
test.after(async () => { await app.close(); });

async function activated(plan = 'monthly', extra = {}) {
  const c = client(app.base);
  const k = app.licensing.issue({ plan, ...extra });
  const r = await c.post('/api/licence/activate', { key: k.readableKey });
  assert.equal(r.status, 200, r.text);
  return { c, k, login: r.json.login };
}

test('health is public and reports the engine', async () => {
  const r = await client(app.base).get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('unknown API routes are JSON 404s', async () => {
  const r = await client(app.base).get('/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'NOT_FOUND');
});

test('protected routes require an activated device', async () => {
  const c = client(app.base);
  for (const url of ['/api/terminal', '/api/positions', '/api/journal', '/api/vault']) {
    const r = await c.get(url);
    assert.equal(r.status, 401, url);
    assert.equal(r.json.code, 'NOT_ACTIVATED');
  }
  const lic = await c.get('/api/licence');
  assert.deepEqual(lic.json, { active: false, licence: null });
});

test('activation sets an HttpOnly cookie and rejects bad keys', async () => {
  const c = client(app.base);
  const bad = await c.post('/api/licence/activate', { key: 'LV-AAAAA-BBBBB-CCCCC-DDDDD' });
  assert.equal(bad.status, 403);
  assert.equal(bad.json.code, 'LICENCE_UNKNOWN');
  const k = app.licensing.issue({ plan: 'trial', label: 'tablet' });
  const r = await c.post('/api/licence/activate', { key: k.readableKey });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /lumina_licence=.*HttpOnly/);
  assert.match(r.json.login.id, /^LV-[A-F0-9]{16}$/);
  const me = await c.get('/api/licence');
  assert.equal(me.json.active, true);
  assert.equal(me.json.licence.label, 'tablet');
  const out = await c.post('/api/licence/deactivate', {});
  assert.equal(out.status, 200);
  assert.equal((await c.get('/api/licence')).json.active, false);
});

test('a second device signs in with the access ID and code', async () => {
  const { login } = await activated();
  const second = client(app.base);
  const wrong = await second.post('/api/login', { id: login.id, code: '0000000000000000' });
  assert.equal(wrong.status, 401);
  const ok = await second.post('/api/login', { id: login.id, code: login.code });
  assert.equal(ok.status, 200);
  assert.equal((await second.get('/api/licence')).json.active, true);
});

test('revoked and exhausted licences are refused with distinct codes', async () => {
  const { c, k } = await activated('trial', { quota: 3 });
  const bt = await c.post('/api/analysis/run', {});
  assert.equal(bt.status, 200, bt.text);
  const again = await c.post('/api/analysis/run', {});
  assert.equal(again.status, 402);
  assert.equal(again.json.code, 'QUOTA_EXHAUSTED');
  app.licensing.setQuota(k.keyId, 100);
  app.licensing.revoke(k.keyId, true);
  const revoked = await c.get('/api/terminal');
  assert.equal(revoked.status, 403);
  assert.equal(revoked.json.code, 'LICENCE_REVOKED');
});

test('cross-origin writes are blocked (CSRF)', async () => {
  const { c } = await activated();
  const r = await c.raw('POST', '/api/engine/settings', { body: { autoTrade: false }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'CSRF');
  const same = await c.raw('POST', '/api/engine/settings', { body: { autoTrade: false }, headers: { origin: app.base } });
  assert.equal(same.status, 200);
  assert.equal(same.json.autoTrade, false);
});

test('terminal state is assembled from real quotes', async () => {
  const { c } = await activated();
  const r = await c.get('/api/terminal');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.quotes.length, 2);
  assert.ok(r.json.quotes[0].price > 0);
  assert.equal(r.json.account.equity, app.cfg.account.startingEquity);
  assert.equal(r.json.live.mode, 'paper');
  assert.equal(r.json.watchlist.length, 2);
});

test('manual ticket: validation, risk sizing, open, amend and close', async () => {
  const { c } = await activated();
  const t = await c.get('/api/terminal');
  const price = t.json.quotes.find((q) => q.symbol === 'TEST').price;

  const noStop = await c.post('/api/positions', { symbol: 'TEST', side: 'buy', qty: 1 });
  assert.equal(noStop.json.code, 'STOP_REQUIRED');
  const wrongStop = await c.post('/api/positions', { symbol: 'TEST', side: 'buy', qty: 1, stop: price * 1.01 });
  assert.equal(wrongStop.json.code, 'BAD_STOP');
  const wrongTarget = await c.post('/api/positions', { symbol: 'TEST', side: 'buy', qty: 1, stop: price * 0.99, target: price * 0.98 });
  assert.equal(wrongTarget.json.code, 'BAD_TARGET');
  const unknown = await c.post('/api/positions', { symbol: 'NOPE', side: 'buy', qty: 1, stop: 1 });
  assert.equal(unknown.json.code, 'UNKNOWN_SYMBOL');
  const tooBig = await c.post('/api/positions', { symbol: 'TEST', side: 'buy', qty: 1e9, stop: price * 0.99 });
  assert.equal(tooBig.status, 422);
  assert.equal(tooBig.json.code, 'VOLUME_EXCEEDS_RISK');

  const ok = await c.post('/api/positions', { symbol: 'TEST', side: 'buy', qty: 1, stop: price * 0.99, target: price * 1.03 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.live, false);
  const id = ok.json.positionId;

  const book = await c.get('/api/positions');
  const pos = book.json.positions.find((p) => p.id === id);
  assert.ok(pos);
  assert.equal(pos.side, 'long');

  const badAmend = await c.patch(`/api/positions/${id}`, { target: pos.entry * 0.9 });
  assert.equal(badAmend.json.code, 'BAD_TARGET');
  const amend = await c.patch(`/api/positions/${id}`, { stop: pos.entry * 0.995 });
  assert.equal(amend.status, 200);
  assert.ok(Math.abs(amend.json.position.stop - pos.entry * 0.995) < 1e-9);

  const closed = await c.post(`/api/positions/${id}/close`, {});
  assert.equal(closed.status, 200, closed.text);
  assert.ok(Number.isFinite(closed.json.pnl));
  // Both legs' fees are in the result.
  assert.ok(closed.json.pnl < closed.json.gross);

  const journal = await c.get('/api/journal');
  assert.equal(journal.json.stats.trades, 1);
  assert.equal((await c.post(`/api/positions/${id}/close`, {})).status, 404);
});

test('positions are isolated between licences', async () => {
  const a = await activated();
  const b = await activated();
  const price = (await a.c.get('/api/terminal')).json.quotes[0].price;
  const sym = (await a.c.get('/api/terminal')).json.quotes[0].symbol;
  const opened = await a.c.post('/api/positions', { symbol: sym, side: 'sell', qty: 0.5, stop: price * 1.02 });
  assert.equal(opened.status, 200, opened.text);
  const steal = await b.c.post(`/api/positions/${opened.json.positionId}/close`, {});
  assert.equal(steal.status, 404);
  assert.equal((await b.c.get('/api/positions')).json.positions.length, 0);
});

test('pending orders validate, list and cancel', async () => {
  const { c } = await activated();
  const bad = await c.post('/api/pending-orders', { symbol: 'TEST', side: 'buy', qty: 1, triggerPrice: 50, stop: 60 });
  assert.equal(bad.json.code, 'BAD_STOP');
  const unknown = await c.post('/api/pending-orders', { symbol: 'NOPE', side: 'buy', qty: 1, triggerPrice: 50 });
  assert.equal(unknown.json.code, 'UNKNOWN_SYMBOL');
  const ok = await c.post('/api/pending-orders', { symbol: 'TEST', side: 'buy', qty: 1, triggerPrice: 1, stop: 0.5, target: 2 });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await c.get('/api/pending-orders')).json.orders.length, 1);
  assert.equal((await c.post(`/api/pending-orders/${ok.json.order.id}/cancel`, {})).status, 200);
  assert.equal((await c.get('/api/pending-orders')).json.orders.length, 0);
});

test('analysis, sweep, explain and backtest answer with real computations', async () => {
  const { c } = await activated();
  const a = await c.get('/api/analysis?venue=fake&symbol=TEST&tf=1h');
  assert.equal(a.status, 200);
  assert.ok(a.json.candles.length > 100);
  assert.ok(a.json.series.ema21.length > 0);
  const sweep = await c.get('/api/analysis/sweep?tf=1h&profitOnly=0');
  assert.equal(sweep.json.analysed, 2);
  const ex = await c.get('/api/ai/explain?venue=fake&symbol=TEST');
  assert.ok(ex.json.explanation.headline);
  const bt = await c.post('/api/backtest', { venue: 'fake', symbol: 'TEST', tf: '1h', bars: 400 });
  assert.equal(bt.status, 200, bt.text);
  assert.equal(bt.json.ok, true);
  const missing = await c.post('/api/backtest', { symbol: 'TEST' });
  assert.equal(missing.status, 400);
});

test('the local analyst answers and keeps the conversation', async () => {
  const { c } = await activated();
  const r = await c.post('/api/ai/ask', { question: 'What is the best setup right now?' });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.answer.length > 10);
  const h = await c.get('/api/ai/messages');
  assert.equal(h.json.messages.length, 2);
  assert.equal((await c.post('/api/ai/ask', { question: '' })).status, 400);
});

test('vault: authors own their notes; system notes are protected', async () => {
  const a = await activated();
  const b = await activated();
  const created = await a.c.post('/api/vault/note', { title: 'My plan', content: '# My plan\n\nLinks to [[Risk Engine]].', tags: ['plan', 'bad tag!'] });
  assert.equal(created.status, 200, created.text);
  const id = created.json.note.id;
  assert.deepEqual(created.json.note.tags.sort(), ['plan']);

  const read = await b.c.get(`/api/vault/note/${id}`);
  assert.equal(read.json.note.editable, false);
  assert.equal(read.json.note.owner, undefined);
  assert.equal((await b.c.del(`/api/vault/note/${id}`)).status, 403);

  const system = app.vault.resolve('Risk Engine');
  assert.equal((await a.c.del(`/api/vault/note/${system}`)).status, 403);
  const overwrite = await b.c.post('/api/vault/note', { path: 'Concepts/Risk Engine.md', content: 'defaced' });
  assert.equal(overwrite.status, 403);

  assert.equal((await a.c.get(`/api/vault/note/${id}`)).json.note.editable, true);
  assert.equal((await a.c.del(`/api/vault/note/${id}`)).status, 200);
  assert.equal((await a.c.get(`/api/vault/note/${id}`)).status, 404);
  const search = await a.c.get('/api/vault/search?q=sizing');
  assert.ok(search.json.results.length >= 1);
});

test('files: upload, private by default, scoped to the uploader, shareable', async () => {
  const a = await activated();
  const b = await activated();
  const up = await a.c.raw('POST', '/api/files?name=notes.txt&title=Notes', { raw: 'hello lumina', headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(up.status, 200, up.text);
  const f = up.json.file;
  assert.equal(f.visibility, 'private');
  assert.equal((await b.c.get(`/api/files/${f.id}`)).status, 404);
  assert.equal((await b.c.get(`/api/files/${f.id}/download`)).status, 404);
  const dl = await a.c.get(`/api/files/${f.id}/download`);
  assert.equal(dl.text, 'hello lumina');
  assert.equal((await b.c.post(`/api/files/${f.id}/publish`, {})).status, 404);
  assert.equal((await a.c.post(`/api/files/${f.id}/publish`, {})).status, 200);
  const share = await client(app.base).get(`/f/${f.shareToken}/download`);
  assert.equal(share.text, 'hello lumina');
  const bad = await a.c.raw('POST', '/api/files?name=evil.exe', { raw: 'MZ', headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(bad.status, 415);
  assert.equal((await b.c.del(`/api/files/${f.id}`)).status, 404);
  assert.equal((await a.c.del(`/api/files/${f.id}`)).status, 200);
});

test('settings: preferences are validated and live trading stays locked', async () => {
  const { c } = await activated();
  assert.equal((await c.post('/api/settings/preferences', { timeframe: '7m' })).json.code, 'BAD_TIMEFRAME');
  const ok = await c.post('/api/settings/preferences', { timeframe: '15m', style: 'intraday', autoTrade: false });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/settings/preferences')).json.timeframe, '15m');
  const live = await c.patch('/api/account/live', { enabled: true });
  assert.equal(live.status, 409);
  assert.equal(live.json.code, 'BROKER_ACCOUNT_NOT_ASSIGNED');
});

test('owner: passphrase login, licence issuing and gated routes', async () => {
  const c = client(app.base);
  assert.equal((await c.get('/api/owner/licences')).status, 401);
  assert.equal((await c.post('/api/owner/login', { passphrase: 'wrong' })).status, 401);
  const ok = await c.post('/api/owner/login', { passphrase: OWNER });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/owner/session')).json.authenticated, true);
  const issued = await c.post('/api/owner/licences', { plan: 'monthly', label: 'Customer A', quota: 50, days: 10 });
  assert.equal(issued.status, 200, issued.text);
  assert.equal(issued.json.licence.quota, 50);
  const list = await c.get('/api/owner/licences');
  assert.ok(list.json.licences.some((l) => l.keyId === issued.json.licence.keyId));
  const risk = await c.post('/api/owner/risk', { maxRiskPerTradePct: 99, minConfidence: 70 });
  assert.equal(risk.json.limits.maxRiskPerTradePct, 10, 'clamped to the band');
  assert.equal(risk.json.limits.minConfidence, 70);
  // The owner terminal works without a licence key.
  assert.equal((await c.get('/api/terminal')).status, 200);
  await c.post('/api/owner/logout', {});
  assert.equal((await c.get('/api/owner/session')).json.authenticated, false);
});

test('owner cookie with an expired timestamp is rejected', async () => {
  const ts = Date.now() - 31 * 24 * 3600 * 1000;
  const sig = crypto.createHmac('sha256', OWNER).update(`owner.${ts}`).digest('base64url');
  const r = await fetch(app.base + '/api/owner/session', { headers: { cookie: `lumina_owner=owner.${ts}.${sig}` } });
  assert.equal((await r.json()).authenticated, false);
  const fresh = Date.now() - 20 * 24 * 3600 * 1000;
  const sig2 = crypto.createHmac('sha256', OWNER).update(`owner.${fresh}`).digest('base64url');
  const r2 = await fetch(app.base + '/api/owner/session', { headers: { cookie: `lumina_owner=owner.${fresh}.${sig2}` } });
  assert.equal((await r2.json()).authenticated, true, 'a 20-day-old session is still inside the 30-day window');
});
