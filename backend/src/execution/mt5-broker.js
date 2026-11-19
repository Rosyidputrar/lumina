/**
 * MT5 broker, through a self-hosted gateway.
 *
 * MetaTrader 5 has no cloud API: the terminal only runs on Windows, or under
 * Wine. Instead of paying a per-account bridge, this talks to `mt5-gateway`
 * running in Docker (one container per broker account), which exposes the
 * terminal over plain HTTP:
 *
 *   this adapter ──HTTP──▶ mt5-gateway ──▶ MT5 under Wine ──▶ the broker
 *
 * That is what lets a customer use HFM, XM, Exness, JustMarkets or STMarket:
 * those brokers offer nothing but MT4/MT5, so the terminal is the only door.
 *
 * Three things this adapter refuses to pretend about:
 *   - Symbols are broker-specific. This one calls EURUSD `EURUSDm`, another
 *     calls it `EURUSD`. A symbol that does not exist must fail loudly, not be
 *     guessed, so the caller passes the exact name from /symbols.
 *   - A close can come back `unresolved`, meaning the dealer desk acknowledged
 *     without a price. That is unknown, never zero.
 *   - `502 unknown_outcome` means the order may have executed. Retrying blindly
 *     can double a position, so it is surfaced as such.
 */
import { BrokerError } from './exchanges.js';

/** Timeframe names differ from ours; map explicitly rather than guess. */
const TF = {
  '1m': 'M1',
  '5m': 'M5',
  '15m': 'M15',
  '30m': 'M30',
  '1h': 'H1',
  '4h': 'H4',
  '1d': 'D1',
};

async function call(base, apiKey, path, { method = 'GET', body, idempotencyKey, timeout = 20_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const headers = { accept: 'application/json', authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Every trade request carries a stable key: a repeat replays the original
  // response instead of placing a second order.
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { ok: false, error: text.slice(0, 300), error_type: 'bad_json' };
    }
    if (!res.ok || json?.ok === false) {
      const err = new BrokerError(`MT5 gateway: ${json?.error ?? `HTTP ${res.status}`}`, {
        code: json?.error_type ?? `HTTP_${res.status}`,
        status: res.status,
        path,
        details: json?.details,
        mt5_error: json?.mt5_error,
        body: json,
      });
      // 502 unknown_outcome must not be treated as a clean failure.
      if (json?.error_type === 'unknown_outcome') err.meta.unknownOutcome = true;
      throw err;
    }
    return json;
  } catch (e) {
    if (e instanceof BrokerError) throw e;
    throw new BrokerError(`MT5 gateway unreachable: ${e?.message ?? e}`, { code: 'GATEWAY_UNREACHABLE', path });
  } finally {
    clearTimeout(timer);
  }
}

export class Mt5Broker {
  /**
   * @param {object} cfg  { baseUrl, apiKey, demo }
   * baseUrl points at one gateway container, e.g. http://127.0.0.1:5001
   */
  constructor(cfg = {}) {
    this.id = 'mt5';
    this.cfg = cfg;
    this.base = String(cfg.baseUrl ?? '').replace(/\/+$/, '');
    this.apiKey = cfg.apiKey ?? '';
    this.simulated = Boolean(cfg.demo);
  }

  get configured() {
    return Boolean(this.base && this.apiKey);
  }

  async health() {
    if (!this.configured) throw new BrokerError('MT5 gateway is not configured', { code: 'NOT_CONFIGURED' });
    return call(this.base, this.apiKey, '/health');
  }

  /** True when the terminal is logged in and trading-ready. */
  async ready() {
    if (!this.configured) return { ok: false, reason: 'not configured' };
    try {
      const r = await call(this.base, this.apiKey, '/health/ready', { timeout: 8000 });
      return { ok: r.status === 'ready', status: r.status, mt5: r.mt5_status };
    } catch (e) {
      // A gateway that is up but not logged in answers 503 with a real body.
      // That is not a transport failure, so report what it said.
      const body = e.meta?.body ?? e.meta?.details ?? null;
      return { ok: false, reason: e.message, code: e.code, status: body?.status ?? null, mt5: body?.mt5_status ?? null };
    }
  }

  async account() {
    const r = await call(this.base, this.apiKey, '/account');
    return r.data ?? r;
  }

  /**
   * Symbols are broker-specific, so this is how a caller finds the real name.
   *
   * The gateway wraps list results as {ok, data:[…]}, but some builds return the
   * array directly. Accept both rather than reporting an empty list when the
   * data is actually there.
   */
  async symbols(search = '*') {
    const r = await call(this.base, this.apiKey, `/symbols?search=${encodeURIComponent(search)}`);
    if (Array.isArray(r)) return r;
    if (Array.isArray(r?.data)) return r.data;
    if (Array.isArray(r?.symbols)) return r.symbols;
    if (Array.isArray(r?.result)) return r.result;
    return [];
  }

  /** The raw payload, for diagnosing an unexpected shape. Never parsed. */
  async rawSymbols(search = '*') {
    return call(this.base, this.apiKey, `/symbols?search=${encodeURIComponent(search)}`);
  }

  async tick(symbol) {
    const r = await call(this.base, this.apiKey, `/symbol_info_tick/${encodeURIComponent(symbol)}`);
    return r.data ?? r;
  }

  async symbolInfo(symbol) {
    const r = await call(this.base, this.apiKey, `/symbol_info/${encodeURIComponent(symbol)}`);
    return r.data ?? r;
  }

  async orderCheck(order) {
    const r = await call(this.base, this.apiKey, '/order_check', { method: 'POST', body: { symbol: order.symbol, volume: Number(order.qty), type: order.side === 'sell' ? 'SELL' : 'BUY', sl: Number(order.stop), tp: Number(order.target ?? 0) } });
    return r.data ?? r;
  }

  async calcProfit({ symbol, side, volume, priceOpen, priceClose }) {
    const r = await call(this.base, this.apiKey, '/order_calc_profit', { method: 'POST', body: { symbol, volume: Number(volume), type: side === 'sell' ? 'SELL' : 'BUY', price_open: Number(priceOpen), price_close: Number(priceClose) } });
    return Number(r.data?.profit ?? r.profit ?? r.result?.profit ?? 0);
  }

  async calcMargin({ symbol, side, volume, price }) {
    const r = await call(this.base, this.apiKey, '/order_calc_margin', { method: 'POST', body: { symbol, volume: Number(volume), type: side === 'sell' ? 'SELL' : 'BUY', price: Number(price) } });
    return Number(r.data?.margin ?? r.margin ?? r.result?.margin ?? 0);
  }

  async sizeForRisk({ symbol, side, entry, stop, equity, riskPct = 0.005 }) {
    const info = await this.symbolInfo(symbol);
    const lossOne = Math.abs(await this.calcProfit({ symbol, side, volume: 1, priceOpen: entry, priceClose: stop }));
    if (!(lossOne > 0) || !(equity > 0)) throw new BrokerError('broker could not calculate risk for this symbol', { code: 'BROKER_SIZE_UNAVAILABLE' });
    const raw = equity * riskPct / lossOne;
    const min = Number(info.volume_min ?? info.volumeMin ?? 0.01);
    const max = Number(info.volume_max ?? info.volumeMax ?? raw);
    const step = Number(info.volume_step ?? info.volumeStep ?? 0.01);
    const floor = (v) => Math.floor(v / step + 1e-9) * step;
    const qty = Math.min(max, Math.max(0, floor(raw)));
    return { qty: Number(qty.toFixed(8)), rawQty: raw, min, max, step, lossAtStop: lossOne, margin: await this.calcMargin({ symbol, side, volume: Math.max(qty, min), price: entry }) };
  }

  /** Bars in our own shape, so the analysis engine does not need to know MT5. */
  async candles({ symbol, timeframe = '1h', limit = 300 }) {
    const tf = TF[timeframe] ?? 'H1';
    const r = await call(this.base, this.apiKey, `/fetch_data_pos?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}&num_bars=${Number(limit) || 300}`);
    const rows = r.data ?? [];
    return rows
      .map((b) => ({
        ts: b.time ? new Date(b.time).getTime() : null,
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
        volume: Number(b.tick_volume ?? b.real_volume ?? 0),
      }))
      .filter((c) => c.ts && Number.isFinite(c.open) && Number.isFinite(c.close))
      .sort((a, b) => a.ts - b.ts);
  }

  async place(order) {
    if (!this.configured) throw new BrokerError('MT5 gateway is not configured', { code: 'NOT_CONFIGURED' });
    const side = order.side === 'buy' || order.side === 'long' ? 'BUY' : 'SELL';
    const body = {
      symbol: order.symbol,
      volume: Number(order.qty),
      type: side,
    };
    if (order.type === 'limit' && order.limitPrice) {
      body.type = `${side}_LIMIT`;
      body.price = Number(order.limitPrice);
    }
    if (order.stop) body.sl = Number(order.stop);
    if (order.target) body.tp = Number(order.target);
    if (order.comment) body.comment = String(order.comment).slice(0, 31);
    // A stable key derived from the signal makes a retry safe.
    const key = order.signalId ? `sig-${order.signalId}` : undefined;

    const res = await call(this.base, this.apiKey, '/order', { method: 'POST', body, idempotencyKey: key });
    const r = res.result ?? res.data ?? {};
    const orderId = r.order ?? r.ticket ?? r.order_id ?? null;
    const fillSource = res.fill_price_source ?? null;
    return {
      brokerOrderId: orderId === null ? null : String(orderId),
      status: res.state === 'executed' || r.retcode === 10009 ? 'filled' : 'submitted',
      filledQty: Number(r.volume ?? 0),
      avgFill: Number(r.price ?? 0) || null,
      fees: 0,
      fillPriceSource: fillSource,
      raw: res,
    };
  }

  async cancel({ brokerOrderId }) {
    const r = await call(this.base, this.apiKey, `/orders/${encodeURIComponent(brokerOrderId)}`, { method: 'DELETE' });
    return { cancelled: r.ok !== false };
  }

  async verifyProtection({ symbol, side, qty, stop, target }) {
    const book = await this.positions();
    const wantedSide = side === 'buy' || side === 'long' ? 'long' : 'short';
    const rows = (book.positions ?? []).filter((p) => p.symbol === symbol && p.side === wantedSide);
    const match = rows.find((p) => Math.abs(Number(p.qty) - Number(qty)) < Math.max(0.00000001, Number(qty) * 0.02)) ?? rows[0];
    if (!match) return { ok: false, reason: 'POSITION_NOT_VISIBLE' };
    const stopOk = Number.isFinite(Number(stop)) && Math.abs(Number(match.stop) - Number(stop)) < 1e-8;
    const targetOk = target === null || target === undefined ? match.target === null : Math.abs(Number(match.target) - Number(target)) < 1e-8;
    return { ok: stopOk && targetOk, reason: stopOk ? (targetOk ? null : 'TP_NOT_CONFIRMED') : 'SL_NOT_CONFIRMED', position: match };
  }

  async positions() {
    const r = await call(this.base, this.apiKey, '/get_positions');
    const rows = r.data ?? [];
    return {
      ok: true,
      source: 'mt5',
      positions: rows.map((p) => ({
        ticket: p.ticket,
        symbol: p.symbol,
        side: Number(p.type) === 0 ? 'long' : 'short',
        qty: Number(p.volume),
        entry: Number(p.price_open),
        stop: Number(p.sl) || null,
        target: Number(p.tp) || null,
        pnl: Number(p.profit ?? 0),
        raw: p,
      })),
    };
  }

  async close({ symbol, qty, side, positionId }) {
    // Closing needs the position ticket, not the symbol: one symbol can hold
    // several positions.
    if (!positionId) throw new BrokerError('closing an MT5 position needs its ticket', { code: 'NO_POSITION_ID' });
    const res = await call(this.base, this.apiKey, '/close_position', {
      method: 'POST',
      body: { position: { ticket: Number(positionId) } },
      idempotencyKey: `close-${positionId}`,
    });
    const source = res.fill_price_source ?? null;
    // `unresolved` means the price is unknown, not zero.
    const price = source === 'unresolved' ? null : Number(res.result?.price ?? res.price ?? 0) || null;
    return { closed: true, price, fillPriceSource: source, raw: res };
  }

  /** Broker truth: positions, orders and the last 24h of deals. */
  async reconcile() {
    const r = await call(this.base, this.apiKey, '/reconcile');
    return r.data ?? r;
  }

  /**
   * Emergency stop. `flatten` also closes every position and removes pending
   * orders, which is what an owner wants when something is wrong.
   */
  async kill({ flatten = false } = {}) {
    const r = await call(this.base, this.apiKey, `/kill${flatten ? '?flatten=true' : ''}`, { method: 'POST' });
    return r;
  }

  async releaseKill() {
    const r = await call(this.base, this.apiKey, '/kill/release', { method: 'POST' });
    return r;
  }
}
