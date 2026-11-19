/**
 * Market data — real venues only. Each provider speaks the venue's public
 * REST API and normalises candles into {ts, open, high, low, close, volume}.
 *
 * Providers:
 *   bybit  — crypto spot klines
 *   okx    — crypto / tokenised-metal spot candles
 *   kraken — crypto + fiat FX pairs + PAXG (tokenised gold)
 *
 * There is no synthetic fallback for prices: if every venue is unreachable the
 * caller gets an explicit error and the UI says "stale/unavailable". Guessing a
 * price is worse than showing nothing.
 */
const TF_MS = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export const TIMEFRAMES = Object.keys(TF_MS);

export function timeframeMs(tf) {
  return TF_MS[tf] ?? TF_MS['1h'];
}

/**
 * MT5 market data, through the self-hosted gateway.
 *
 * This is the path for forex, metals and indices: those instruments exist only
 * inside a MetaTrader terminal, so the gateway is the only source. Symbol names
 * are the broker's own (EURUSD.s, US100.s here), so they are passed through
 * untouched — a wrong name must fail loudly, never quietly read another market.
 */
export function mt5Provider({ broker }) {
  return {
    id: 'mt5',
    async candles({ symbol, timeframe, limit }) {
      const rows = await broker.candles({ symbol, timeframe, limit });
      if (!rows.length) throw new MarketError('mt5: no candles', { symbol });
      return rows;
    },
    async ticker({ symbol }) {
      const t = await broker.tick(symbol);
      const last = toNum(t?.bid ?? t?.last ?? t?.ask);
      if (!Number.isFinite(last)) throw new MarketError('mt5: no tick', { symbol });
      return {
        last,
        bid: toNum(t?.bid),
        ask: toNum(t?.ask),
        volume24h: toNum(t?.volume),
        // mt5-gateway sends epoch seconds (time) and milliseconds (time_msc).
        ts: Number(t?.time_msc) > 0 ? Number(t.time_msc) : Number(t?.time) > 0 ? Number(t.time) * 1000 : Date.now(),
      };
    },
  };
}

export class MarketError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'MarketError';
    this.meta = meta;
  }
}

async function getJson(url, { timeout = 8000, headers = {}, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json', 'user-agent': 'LuminaVantage/1.0', ...headers } });
      if (!res.ok) throw new MarketError(`HTTP ${res.status} from ${new URL(url).host}`, { status: res.status });
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new MarketError(`fetch failed: ${lastErr?.message ?? 'unknown'}`, { url });
}

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/* ------------------------------- providers ------------------------------- */

const bybitInterval = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };

export const providers = {
  bybit: {
    id: 'bybit',
    async candles({ symbol, timeframe, limit }) {
      const interval = bybitInterval[timeframe] ?? '60';
      const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${Math.min(limit, 1000)}`;
      const body = await getJson(url);
      if (body.retCode !== 0) throw new MarketError(`bybit: ${body.retMsg}`, { symbol });
      const list = body.result?.list ?? [];
      return list
        .map((r) => ({ ts: Number(r[0]), open: toNum(r[1]), high: toNum(r[2]), low: toNum(r[3]), close: toNum(r[4]), volume: toNum(r[5]) }))
        .filter(hasOhlc)
        .sort((a, b) => a.ts - b.ts);
    },
    async ticker({ symbol }) {
      const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`;
      const body = await getJson(url);
      const t = body.result?.list?.[0];
      if (!t) throw new MarketError('bybit: no ticker');
      return { last: toNum(t.lastPrice), bid: toNum(t.bid1Price), ask: toNum(t.ask1Price), volume24h: toNum(t.volume24h), ts: Number(body.time) || Date.now() };
    },
  },

  okx: {
    id: 'okx',
    async candles({ symbol, timeframe, limit }) {
      const bar = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1D' }[timeframe] ?? '1H';
      const want = Math.min(Number(limit) || 300, 1500);
      const url = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=${Math.min(want, 300)}`;
      const body = await getJson(url);
      if (body.code !== '0') throw new MarketError(`okx: ${body.msg}`, { symbol });
      const parse = (r) => ({ ts: Number(r[0]), open: toNum(r[1]), high: toNum(r[2]), low: toNum(r[3]), close: toNum(r[4]), volume: toNum(r[5]) });
      const rows = new Map((body.data ?? []).map((r) => [Number(r[0]), parse(r)]));
      // The recent endpoint stops at 300 bars; older bars come from history-candles,
      // 100 at a time, so a 1,000-bar backtest really gets 1,000 bars.
      let oldest = Math.min(...rows.keys());
      for (let page = 0; rows.size < want && page < 15 && Number.isFinite(oldest); page++) {
        const older = await getJson(`https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=100&after=${oldest}`);
        if (older.code !== '0' || !older.data?.length) break;
        for (const r of older.data) rows.set(Number(r[0]), parse(r));
        const next = Math.min(...older.data.map((r) => Number(r[0])));
        if (next >= oldest) break;
        oldest = next;
      }
      return [...rows.values()].filter(hasOhlc).sort((a, b) => a.ts - b.ts).slice(-want);
    },
    async ticker({ symbol }) {
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`;
      const body = await getJson(url);
      const t = body.data?.[0];
      if (!t) throw new MarketError('okx: no ticker');
      return { last: toNum(t.last), bid: toNum(t.bidPx), ask: toNum(t.askPx), volume24h: toNum(t.volCcy24h), ts: Number(t.ts) || Date.now() };
    },
  },

  kraken: {
    id: 'kraken',
    async candles({ symbol, timeframe, limit }) {
      const interval = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 }[timeframe] ?? 60;
      const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(symbol)}&interval=${interval}`;
      const body = await getJson(url);
      if (body.error?.length) throw new MarketError(`kraken: ${body.error.join(', ')}`, { symbol });
      const key = Object.keys(body.result ?? {}).find((k) => k !== 'last');
      if (!key) throw new MarketError('kraken: empty result');
      return (body.result[key] ?? [])
        .map((r) => ({ ts: Number(r[0]) * 1000, open: toNum(r[1]), high: toNum(r[2]), low: toNum(r[3]), close: toNum(r[4]), volume: toNum(r[6]) }))
        .filter(hasOhlc)
        .slice(-Math.min(limit, 720))
        .sort((a, b) => a.ts - b.ts);
    },
    async ticker({ symbol }) {
      const url = `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(symbol)}`;
      const body = await getJson(url);
      if (body.error?.length) throw new MarketError(`kraken: ${body.error.join(', ')}`);
      const key = Object.keys(body.result ?? {})[0];
      const t = body.result?.[key];
      if (!t) throw new MarketError('kraken: no ticker');
      return { last: toNum(t.c?.[0]), bid: toNum(t.b?.[0]), ask: toNum(t.a?.[0]), volume24h: toNum(t.v?.[1]), ts: Date.now() };
    },
  },
};

function hasOhlc(c) {
  return c && [c.open, c.high, c.low, c.close].every((v) => typeof v === 'number' && Number.isFinite(v));
}

/* ------------------------------ market data ------------------------------ */

export class MarketData {
  constructor({ ttlMs = 20_000, providersMap = providers } = {}) {
    this.providers = providersMap;
    this.ttlMs = ttlMs;
    this.candleCache = new Map();
    this.tickerCache = new Map();
    this.health = new Map();
    this.stats = { calls: 0, failures: 0, lastSuccess: null };
  }

  provider(venue) {
    const p = this.providers[venue];
    if (!p) throw new MarketError(`unknown venue: ${venue}`, { venue });
    return p;
  }

  async candles({ venue, symbol, timeframe = '1h', limit = 400, force = false }) {
    const key = `${venue}:${symbol}:${timeframe}:${limit}`;
    const hit = this.candleCache.get(key);
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return hit.rows;
    this.stats.calls++;
    try {
      const rows = await this.provider(venue).candles({ symbol, timeframe, limit });
      if (!rows.length) throw new MarketError('venue returned no candles', { venue, symbol });
      this.candleCache.set(key, { at: Date.now(), rows });
      this.stats.lastSuccess = Date.now();
      this.health.set(venue, { ok: true, at: Date.now(), message: 'ok' });
      return rows;
    } catch (e) {
      this.stats.failures++;
      this.health.set(venue, { ok: false, at: Date.now(), message: e.message });
      // serve stale data rather than nothing, but mark it
      if (hit) return hit.rows.map((r) => ({ ...r, stale: true }));
      throw e;
    }
  }

  async ticker({ venue, symbol, force = false }) {
    const key = `${venue}:${symbol}`;
    const hit = this.tickerCache.get(key);
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return hit.data;
    this.stats.calls++;
    try {
      const data = await this.provider(venue).ticker({ symbol });
      this.tickerCache.set(key, { at: Date.now(), data });
      return data;
    } catch (e) {
      this.stats.failures++;
      if (hit) return { ...hit.data, stale: true };
      throw e;
    }
  }

  /** Fetch a coherent bundle for a watchlist entry. */
  async quote(entry, timeframe = '1h') {
    const { venue, symbol } = entry;
    const candles = await this.candles({ venue, symbol, timeframe, limit: 2 });
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    let ticker = null;
    try {
      ticker = await this.ticker({ venue, symbol });
    } catch {
      ticker = null;
    }
    const price = ticker?.last ?? last.close;
    const changePct = prev ? ((last.close - prev.close) / prev.close) * 100 : 0;
    return {
      symbol,
      venue,
      label: entry.label ?? symbol,
      assetClass: entry.assetClass ?? 'crypto',
      price,
      bid: ticker?.bid ?? null,
      ask: ticker?.ask ?? null,
      changePct,
      high: last.high,
      low: last.low,
      volume: last.volume,
      ts: ticker?.ts ?? last.ts,
      stale: Boolean(last.stale || ticker?.stale),
    };
  }

  healthReport() {
    return {
      ...this.stats,
      venues: Object.fromEntries([...this.health.entries()]),
    };
  }
}
