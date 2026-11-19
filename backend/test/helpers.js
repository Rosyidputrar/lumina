/**
 * Test harness: the real app, wired to an in-memory database and a
 * deterministic market provider, listening on an ephemeral port.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { EventBus } from '../src/bus.js';
import { MarketData } from '../src/market/data.js';
import { ExecutionEngine } from '../src/execution/engine.js';
import { Analyst } from '../src/ai/analyst.js';
import { ExpertAgent } from '../src/ai/expert-agent.js';
import { Backtester } from '../src/analysis/backtest.js';
import { createApp } from '../src/app.js';
import { setStrategy } from '../src/analysis/engine.js';
import { Vault } from '../src/vault/vault.js';
import { Memory } from '../src/vault/memory.js';
import { FileStore } from '../src/files/store.js';
import { Licensing } from '../src/licensing/licence.js';

export const SECRET = 'test-signing-secret-that-is-long-enough';
export const OWNER = 'owner-passphrase-for-tests';

/** A seeded random walk with a gentle trend, so indicators have something to read. */
export function makeCandles(n = 400, { start = 100, drift = 0.0006, seed = 7, stepMs = 3_600_000, endTs = Date.now() - 3_600_000 } = {}) {
  let x = seed;
  const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const out = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const move = price * (drift + (rand() - 0.5) * 0.01);
    const close = Math.max(0.01, open + move);
    const high = Math.max(open, close) * (1 + rand() * 0.003);
    const low = Math.min(open, close) * (1 - rand() * 0.003);
    out.push({ ts: endTs - (n - 1 - i) * stepMs, open, high, low, close, volume: 1000 + rand() * 500 });
    price = close;
  }
  return out;
}

export function fakeProvider(series = {}) {
  return {
    id: 'fake',
    async candles({ symbol, limit }) {
      const rows = series[symbol] ?? makeCandles(400);
      return rows.slice(-limit);
    },
    async ticker({ symbol }) {
      const rows = series[symbol] ?? makeCandles(400);
      const last = rows.at(-1).close;
      return { last, bid: last * 0.9999, ask: last * 1.0001, volume24h: 1e6, ts: Date.now() };
    },
  };
}

export async function startApp({ ownerSecret = OWNER, watchlist, broker = null, providers = null, live = false, strategy = 'breakout' } = {}) {
  setStrategy(strategy);
  const filesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-files-'));
  const cfg = loadConfig();
  cfg.dbFile = ':memory:';
  cfg.watchlist = watchlist ?? [
    { symbol: 'TEST', venue: 'fake', label: 'Test market', assetClass: 'crypto' },
    { symbol: 'OTHER', venue: 'fake', label: 'Other market', assetClass: 'fx' },
  ];
  cfg.loop = { ...cfg.loop, enabled: false, timeframe: '1h' };
  cfg.licence = { ...cfg.licence, secret: SECRET, ownerSecret };
  cfg.account = { ...cfg.account, maxRiskPerTrade: 0.005, maxEntriesPerSymbol: 3, cooldownMinutes: 0 };
  cfg.ai = { ...cfg.ai, provider: 'local', apiKey: '' };
  cfg.watcher = { ...cfg.watcher, model: '' };
  cfg.deploy = { ...cfg.deploy, frontendOrigin: '', publicOrigins: '', telegram: { token: '', chat: '' } };
  cfg.news = { feedUrl: '' };
  cfg.mt5 = { ...cfg.mt5, baseUrl: broker?.base ?? '', apiKey: broker?.apiKey ?? '' };
  cfg.live = live;
  cfg.broker = broker ? 'mt5' : 'paper';
  cfg.files = { ...cfg.files, root: filesRoot };

  const store = new Store(':memory:');
  const bus = new EventBus();
  const market = new MarketData({ providersMap: { fake: fakeProvider(), ...(providers ?? {}) } });
  const vault = new Vault(cfg.vault);
  vault.write({ path: 'Concepts/Risk Engine.md', title: 'Risk Engine', content: '# Risk Engine\n\nSizing from the stop.', tags: ['concept'], source: 'system' });
  const memory = new Memory({ vault, maxEpisodes: 200 });
  const quiet = { log() {}, warn() {}, error() {}, info() {} };
  const files = new FileStore({ store, root: filesRoot, maxBytes: 5 * 1024 * 1024, logger: quiet });
  const licensing = new Licensing({ store, secret: SECRET, adminSecret: ownerSecret });
  const analyst = new Analyst({ config: cfg, market, memory, logger: quiet });
  const expert = new ExpertAgent({ config: cfg, vault, logger: quiet });
  const engine = new ExecutionEngine({ store, market, bus, config: cfg, broker, memory, expert, logger: quiet });
  const backtester = new Backtester({ config: cfg });
  const { server } = createApp({ store, market, bus, engine, analyst, expert, watcher: null, config: cfg, backtester, broker, vault, memory, files, licensing, logger: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    engine.stop();
    await new Promise((r) => server.close(r));
    store.close();
    fs.rmSync(filesRoot, { recursive: true, force: true });
  }

  return { base, server, store, engine, licensing, vault, files, cfg, close };
}

/** A tiny client that keeps cookies like a browser would. */
export function client(base) {
  const jar = new Map();
  async function request(method, url, { body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (!v || /Max-Age=0/i.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return {
    jar,
    get: (u, o) => request('GET', u, o),
    post: (u, body, o = {}) => request('POST', u, { ...o, body }),
    patch: (u, body, o = {}) => request('PATCH', u, { ...o, body }),
    del: (u, o) => request('DELETE', u, o),
    raw: request,
  };
}
