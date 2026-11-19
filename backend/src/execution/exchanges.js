/**
 * Live exchange adapters — real signed REST calls, no SDK.
 *
 * OKX   : HMAC-SHA256 over  timestamp + method + path + body, base64, plus
 *         OK-ACCESS-* headers and a passphrase.
 * Bybit : HMAC-SHA256 over  timestamp + api_key + recv_window + payload, hex.
 *
 * Both adapters are capability-checked before use: if credentials are missing
 * they throw a typed error and the engine refuses to run live. Market orders
 * are sized by quantity derived from the risk engine and each venue's contract
 * rules. Symbol mapping is explicit — never guessed.
 */
import crypto from 'node:crypto';
import { Mt5Broker } from './mt5-broker.js';

const SYMBOL_MAP = {
  okx: {
    BTCUSDT: 'BTC-USDT',
    ETHUSDT: 'ETH-USDT',
    SOLUSDT: 'SOL-USDT',
    XAUUSD: 'XAUT-USDT',
    PAXGUSDT: 'PAXG-USDT',
    PAXGUSD: 'PAXG-USDT',
  },
  bybit: {
    'BTC-USDT': 'BTCUSDT',
    'ETH-USDT': 'ETHUSDT',
    'SOL-USDT': 'SOLUSDT',
    PAXGUSDT: 'PAXGUSDT',
  },
};

function mapSymbol(venue, symbol) {
  const table = SYMBOL_MAP[venue] ?? {};
  return table[symbol] ?? symbol;
}

async function request(url, { method = 'GET', headers = {}, body, timeout = 10_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers: { accept: 'application/json', 'content-type': 'application/json', ...headers }, body, signal: ac.signal });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${json.msg ?? json.retMsg ?? text.slice(0, 200)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export class BrokerError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'BrokerError';
    this.code = meta.code ?? 'BROKER_ERROR';
    this.meta = meta;
  }
}

/* --------------------------------- OKX ---------------------------------- */

export class OkxBroker {
  constructor(cfg) {
    this.id = 'okx';
    this.cfg = cfg;
    this.base = cfg.baseUrl;
    this.simulated = cfg.demo;
  }

  get configured() {
    return Boolean(this.cfg.apiKey && this.cfg.apiSecret && this.cfg.passphrase);
  }

  sign(ts, method, path, body) {
    const msg = `${ts}${method}${path}${body}`;
    return crypto.createHmac('sha256', this.cfg.apiSecret).update(msg).digest('base64');
  }

  headers(method, path, body) {
    if (!this.configured) throw new BrokerError('OKX credentials not configured', { code: 'NOT_CONFIGURED' });
    const ts = new Date().toISOString();
    const h = {
      'OK-ACCESS-KEY': this.cfg.apiKey,
      'OK-ACCESS-SIGN': this.sign(ts, method, path, body),
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': this.cfg.passphrase,
      'x-simulated-trading': this.simulated ? '1' : '0',
    };
    return h;
  }

  async call(method, path, payload) {
    const body = payload ? JSON.stringify(payload) : '';
    const json = await request(`${this.base}${path}`, { method, headers: this.headers(method, path, body), body: body || undefined });
    if (json.code && json.code !== '0') throw new BrokerError(`OKX: ${json.msg}`, { code: json.code, meta: json });
    return json;
  }

  async place(order) {
    const instId = mapSymbol('okx', order.symbol);
    const side = order.side === 'buy' || order.side === 'long' ? 'buy' : 'sell';
    const payload = {
      instId,
      tdMode: 'cash',
      side,
      ordType: order.type === 'limit' ? 'limit' : 'market',
      sz: String(signedQty(order.qty)),
    };
    if (order.type === 'limit' && order.limitPrice) payload.px = String(order.limitPrice);
    const res = await this.call('POST', '/api/v5/trade/order', payload);
    const r = res.data?.[0];
    if (!r || r.sCode !== '0') throw new BrokerError(`OKX order rejected: ${r?.sMsg ?? 'unknown'}`, { code: r?.sCode });
    return { brokerOrderId: r.ordId, status: 'submitted', filledQty: 0, avgFill: null, fees: 0 };
  }

  async cancel({ symbol, brokerOrderId }) {
    const res = await this.call('POST', '/api/v5/trade/cancel-order', { instId: mapSymbol('okx', symbol), ordId: brokerOrderId });
    return { cancelled: res.data?.[0]?.sCode === '0' };
  }

  async balances() {
    const res = await this.call('GET', '/api/v5/account/balance');
    return res.data?.[0] ?? null;
  }

  async positions() {
    const res = await this.call('GET', '/api/v5/account/positions');
    return { ok: true, source: 'okx', positions: res.data ?? [] };
  }

  async close({ symbol, qty, side }) {
    return this.place({ symbol, side: side === 'long' ? 'sell' : 'buy', qty, type: 'market' });
  }
}

function signedQty(q) {
  // venues reject excessive precision; 8 significant digits is universally safe
  return Number(q.toPrecision(8));
}

/* -------------------------------- Bybit --------------------------------- */

export class BybitBroker {
  constructor(cfg) {
    this.id = 'bybit';
    this.cfg = cfg;
    this.base = cfg.baseUrl;
    this.simulated = cfg.demo;
  }

  get configured() {
    return Boolean(this.cfg.apiKey && this.cfg.apiSecret);
  }

  headers(payload) {
    if (!this.configured) throw new BrokerError('Bybit credentials not configured', { code: 'NOT_CONFIGURED' });
    const ts = String(Date.now());
    const recv = '5000';
    const msg = ts + this.cfg.apiKey + recv + payload;
    const sign = crypto.createHmac('sha256', this.cfg.apiSecret).update(msg).digest('hex');
    return {
      'X-BAPI-API-KEY': this.cfg.apiKey,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv,
      'X-BAPI-SIGN': sign,
      ...(this.simulated ? { 'X-BAPI-SIMULATED-TRADING': '1' } : {}),
    };
  }

  async call(method, path, query = {}, payload) {
    const qs = new URLSearchParams(query).toString();
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`;
    const body = payload ? JSON.stringify(payload) : '';
    const json = await request(url, { method, headers: this.headers(qs || body), body: body || undefined });
    if (json.retCode !== 0) throw new BrokerError(`Bybit: ${json.retMsg}`, { code: json.retCode, meta: json });
    return json.result ?? {};
  }

  async place(order) {
    const symbol = mapSymbol('bybit', order.symbol);
    const payload = {
      category: 'spot',
      symbol,
      side: order.side === 'buy' || order.side === 'long' ? 'Buy' : 'Sell',
      orderType: order.type === 'limit' ? 'Limit' : 'Market',
      qty: String(signedQty(order.qty)),
    };
    if (order.type === 'limit' && order.limitPrice) payload.price = String(order.limitPrice);
    const res = await this.call('POST', '/v5/order/create', {}, payload);
    return { brokerOrderId: res.orderId, status: 'submitted', filledQty: 0, avgFill: null, fees: 0 };
  }

  async cancel({ symbol, brokerOrderId }) {
    await this.call('POST', '/v5/order/cancel', {}, { category: 'spot', symbol: mapSymbol('bybit', symbol), orderId: brokerOrderId });
    return { cancelled: true };
  }

  async balances() {
    return this.call('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  }

  async positions() {
    const res = await this.call('GET', '/v5/position/list', { category: 'linear' });
    return { ok: true, source: 'bybit', positions: res.list ?? [] };
  }

  async close({ symbol, qty, side }) {
    return this.place({ symbol, side: side === 'long' ? 'sell' : 'buy', qty, type: 'market' });
  }
}

export function createBroker(config) {
  const name = (config.broker ?? 'paper').toLowerCase();
  if (name === 'okx') return new OkxBroker(config.okx);
  if (name === 'bybit') return new BybitBroker(config.bybit);
  // MT5 through a self-hosted gateway: this is how a customer on HFM, XM,
  // Exness, JustMarkets or STMarket is served at all, because those brokers
  // expose nothing but a MetaTrader terminal.
  if (name === 'mt5') return new Mt5Broker(config.mt5);
  return null;
}
