/**
 * MT5 broker, through mt5-gateway.
 *
 * MetaTrader 5 has no cloud API: the terminal only runs on Windows, or under
 * Wine. This adapter speaks HTTP to mt5-gateway
 * (https://github.com/Gabriel-Rockson/mt5-gateway), a container that runs MT5
 * under Wine and exposes it as a small REST API:
 *
 *   this adapter ──HTTP──▶ mt5-gateway ──▶ MT5 under Wine ──▶ the broker
 *
 * The contract below was written against the gateway's own route code, not
 * guessed. The points that matter, because getting them wrong loses money:
 *   - Auth is the X-API-Key header (a Bearer token alone is a 401).
 *   - /fetch_data_pos and /get_positions return a bare JSON array, not
 *     {data: [...]}; /symbols returns {total, symbols}; /orders {total, orders}.
 *   - The last bar from /fetch_data_pos is still forming. The analysis engine
 *     drops it (closedBars), so nothing here reads it as final.
 *   - Tick and deal times are epoch seconds (time) or milliseconds (time_msc),
 *     already shifted from broker wall-clock to real UTC.
 *   - The broker rounds SL/TP to the symbol's digits. Prices are rounded here
 *     first, and protection is verified within half a point, never exactly.
 *   - Orders default to IOC filling, which many brokers reject; the filling
 *     mode is taken from the symbol's own flags.
 *   - Symbols are broker-specific (EURUSD, EURUSDm, EURUSD.s). A symbol that
 *     does not exist fails loudly instead of being guessed.
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
  '1w': 'W1',
};

/** Tags Lumina's orders in MT5, so the owner can tell them from manual trades. */
export const LUMINA_MAGIC = 260511;

/** MT5 symbol filling flags: SYMBOL_FILLING_FOK = 1, SYMBOL_FILLING_IOC = 2. */
export function fillingFor(info) {
  const flags = Number(info?.filling_mode ?? 0);
  if (flags & 2) return 'IOC';
  if (flags & 1) return 'FOK';
  return 'RETURN';
}

/** Accept a bare array or any of the wrappers older gateway builds used. */
function listOf(r, key) {
  if (Array.isArray(r)) return r;
  for (const k of [key, 'data', 'result'].filter(Boolean)) if (Array.isArray(r?.[k])) return r[k];
  return [];
}

function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

async function call(base, apiKey, path, { method = 'GET', body, timeout = 20_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  // X-API-Key is what mt5-gateway checks. The Bearer header is kept for
  // gateways that read it instead; one never invalidates the other.
  const headers = { accept: 'application/json', 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
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
      json = { error: text.slice(0, 300), error_type: 'bad_json' };
    }
    if (!res.ok || json?.ok === false) {
      const reason = json?.error ?? json?.message ?? `HTTP ${res.status}`;
      const err = new BrokerError(`MT5 gateway: ${reason}`, {
        code: json?.error_type ?? (res.status === 401 ? 'GATEWAY_UNAUTHORIZED' : `HTTP_${res.status}`),
        status: res.status,
        path,
        details: json?.details,
        mt5_error: json?.mt5_error,
        body: json,
      });
      // A 502 with unknown_outcome means the order may have executed.
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
   * baseUrl points at one gateway container, e.g. http://mt5:5001 inside
   * Docker Compose or http://127.0.0.1:10003 from the host.
   */
  constructor(cfg = {}) {
    this.id = 'mt5';
    this.cfg = cfg;
    this.base = String(cfg.baseUrl ?? '').replace(/\/+$/, '');
    this.apiKey = cfg.apiKey ?? '';
    this.simulated = Boolean(cfg.demo);
    this.infoCache = new Map();
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
      const body = e.meta?.body ?? null;
      return { ok: false, reason: e.message, code: e.code, status: body?.status ?? null, mt5: body?.mt5_status ?? null };
    }
  }

  async account() {
    const r = await call(this.base, this.apiKey, '/account');
    return r.data ?? r;
  }

  /** Symbols are broker-specific, so this is how a caller finds the real name. */
  async symbols(search = '*') {
    return listOf(await call(this.base, this.apiKey, `/symbols?search=${encodeURIComponent(search)}`), 'symbols');
  }

  /** The raw payload, for diagnosing an unexpected shape. Never parsed. */
  async rawSymbols(search = '*') {
    return call(this.base, this.apiKey, `/symbols?search=${encodeURIComponent(search)}`);
  }

  async tick(symbol) {
    const r = await call(this.base, this.apiKey, `/symbol_info_tick/${encodeURIComponent(symbol)}`);
    return r.data ?? r;
  }

  /** Contract details (digits, point, volume limits, filling flags), cached for ten minutes. */
  async symbolInfo(symbol) {
    const hit = this.infoCache.get(symbol);
    if (hit && Date.now() - hit.at < 600_000) return hit.info;
    const r = await call(this.base, this.apiKey, `/symbol_info/${encodeURIComponent(symbol)}`);
    const info = r.data ?? r;
    this.infoCache.set(symbol, { at: Date.now(), info });
    return info;
  }

  /** A price rounded to the symbol's digits, as the broker will store it. */
  roundPrice(info, price) {
    if (price === null || price === undefined || !Number.isFinite(Number(price))) return null;
    const digits = Number.isInteger(Number(info?.digits)) ? Number(info.digits) : 5;
    return Number(Number(price).toFixed(digits));
  }

  /** A volume floored to the symbol's step and clamped to its limits. */
  roundVolume(info, qty) {
    const step = Number(info?.volume_step ?? 0.01) || 0.01;
    const min = Number(info?.volume_min ?? step);
    const max = Number(info?.volume_max ?? Infinity);
    const floored = Math.floor(Number(qty) / step + 1e-9) * step;
    const v = Number(Math.min(max, floored).toFixed(decimalsOf(step)));
    return v >= min ? v : 0;
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

  /** The lot size whose loss at the stop is riskPct of equity, in the broker's own contract terms. */
  async sizeForRisk({ symbol, side, entry, stop, equity, riskPct = 0.005 }) {
    const info = await this.symbolInfo(symbol);
    const lossOne = Math.abs(await this.calcProfit({ symbol, side, volume: 1, priceOpen: entry, priceClose: stop }));
    if (!(lossOne > 0) || !(equity > 0)) throw new BrokerError('broker could not calculate risk for this symbol', { code: 'BROKER_SIZE_UNAVAILABLE' });
    const raw = (equity * riskPct) / lossOne;
    const qty = this.roundVolume(info, raw);
    const min = Number(info.volume_min ?? 0.01);
    return { qty, rawQty: raw, min, max: Number(info.volume_max ?? raw), step: Number(info.volume_step ?? 0.01), lossAtStop: lossOne, margin: qty > 0 ? await this.calcMargin({ symbol, side, volume: qty, price: entry }) : 0 };
  }

  /** Bars in our own shape, so the analysis engine does not need to know MT5. */
  async candles({ symbol, timeframe = '1h', limit = 300 }) {
    const tf = TF[timeframe] ?? 'H1';
    const r = await call(this.base, this.apiKey, `/fetch_data_pos?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}&num_bars=${Number(limit) || 300}`);
    return listOf(r, 'data')
      .map((b) => ({
        ts: typeof b.time === 'number' ? b.time * 1000 : b.time ? Date.parse(b.time) : null,
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
    const info = await this.symbolInfo(order.symbol);
    const side = order.side === 'buy' || order.side === 'long' ? 'BUY' : 'SELL';
    const volume = this.roundVolume(info, order.qty);
    if (!(volume > 0)) throw new BrokerError(`volume ${order.qty} is below the broker minimum ${info.volume_min}`, { code: 'VOLUME_TOO_SMALL' });
    const body = {
      symbol: order.symbol,
      volume,
      type: side,
      type_filling: fillingFor(info),
      deviation: 20,
      magic: LUMINA_MAGIC,
      comment: String(order.comment ?? 'lumina').slice(0, 31),
    };
    if (order.type === 'limit' && order.limitPrice) {
      body.type = `${side}_LIMIT`;
      body.price = this.roundPrice(info, order.limitPrice);
    }
    if (order.stop) body.sl = this.roundPrice(info, order.stop);
    if (order.target) body.tp = this.roundPrice(info, order.target);

    const res = await call(this.base, this.apiKey, '/order', { method: 'POST', body });
    const r = res.result ?? res.data ?? {};
    // On a hedging account the position ticket is the opening order's ticket.
    const orderId = r.order ?? r.ticket ?? r.order_id ?? null;
    return {
      brokerOrderId: orderId === null ? null : String(orderId),
      status: r.retcode === 10009 || r.retcode === 10010 ? 'filled' : 'submitted',
      filledQty: Number(r.volume ?? volume),
      avgFill: Number(r.price ?? 0) || null,
      partial: Boolean(res.partial_fill),
      fees: 0,
      stop: body.sl ?? null,
      target: body.tp ?? null,
      raw: res,
    };
  }

  async cancel({ brokerOrderId }) {
    const r = await call(this.base, this.apiKey, `/orders/${encodeURIComponent(brokerOrderId)}`, { method: 'DELETE' });
    return { cancelled: r.ok !== false };
  }

  /** Move a live position's SL/TP at the broker. A value left out keeps the broker's current one. */
  async modifyProtection({ positionId, symbol, stop, target }) {
    if (!positionId) throw new BrokerError('changing SL/TP needs the position ticket', { code: 'NO_POSITION_ID' });
    const info = symbol ? await this.symbolInfo(symbol) : null;
    const body = { position: Number(positionId) };
    if (stop !== undefined && stop !== null) body.sl = info ? this.roundPrice(info, stop) : Number(stop);
    if (target !== undefined && target !== null) body.tp = info ? this.roundPrice(info, target) : Number(target);
    const r = await call(this.base, this.apiKey, '/modify_sl_tp', { method: 'POST', body });
    return { ok: true, stop: body.sl ?? null, target: body.tp ?? null, raw: r };
  }

  /** Is the position at the broker carrying the SL/TP we asked for? Compared within half a point. */
  async verifyProtection({ positionId, symbol, side, qty, stop, target }) {
    const info = await this.symbolInfo(symbol).catch(() => null);
    const tol = Math.max(Number(info?.point ?? 0) / 2, 1e-9);
    const book = await this.positions();
    const wantedSide = side === 'buy' || side === 'long' ? 'long' : 'short';
    const rows = book.positions.filter((p) => p.symbol === symbol && p.side === wantedSide);
    const match = (positionId ? rows.find((p) => String(p.ticket) === String(positionId)) : null) ?? rows.find((p) => Math.abs(Number(p.qty) - Number(qty)) <= Math.max(1e-8, Number(qty) * 0.02)) ?? rows[0];
    if (!match) return { ok: false, reason: 'POSITION_NOT_VISIBLE' };
    const wantStop = info ? this.roundPrice(info, stop) : Number(stop);
    const wantTarget = target === null || target === undefined ? null : info ? this.roundPrice(info, target) : Number(target);
    const stopOk = Number.isFinite(wantStop) && match.stop !== null && Math.abs(match.stop - wantStop) <= tol;
    const targetOk = wantTarget === null ? true : match.target !== null && Math.abs(match.target - wantTarget) <= tol;
    return { ok: stopOk && targetOk, reason: stopOk ? (targetOk ? null : 'TP_NOT_CONFIRMED') : 'SL_NOT_CONFIRMED', position: match };
  }

  /**
   * Place an order and make sure it is protected, or undo it.
   *
   * A live position without its stop is the one state this terminal must not
   * leave behind. If the broker did not keep the SL/TP, it is set again once;
   * if that also fails, the position is closed at market. The caller learns
   * exactly which of these happened.
   */
  async placeProtected(order) {
    const res = await this.place(order);
    if (!res.avgFill) return { ...res, protected: false, flattened: false, reason: 'UNCONFIRMED_FILL' };
    const want = { positionId: res.brokerOrderId, symbol: order.symbol, side: order.side, qty: res.filledQty, stop: order.stop, target: order.target };
    let check = await this.verifyProtection(want).catch((e) => ({ ok: false, reason: e.message }));
    if (!check.ok && res.brokerOrderId) {
      await this.modifyProtection({ positionId: res.brokerOrderId, symbol: order.symbol, stop: order.stop, target: order.target }).catch(() => null);
      check = await this.verifyProtection(want).catch((e) => ({ ok: false, reason: e.message }));
    }
    if (check.ok) return { ...res, protected: true, position: check.position };
    try {
      if (!res.brokerOrderId) throw new Error('no ticket to close');
      await this.close({ positionId: res.brokerOrderId });
      return { ...res, protected: false, flattened: true, reason: check.reason };
    } catch (e) {
      return { ...res, protected: false, flattened: false, reason: check.reason, closeError: e.message };
    }
  }

  async positions() {
    const rows = listOf(await call(this.base, this.apiKey, '/get_positions'), 'positions');
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
        magic: p.magic ?? null,
        raw: p,
      })),
    };
  }

  async close({ positionId }) {
    // Closing needs the position ticket, not the symbol: one symbol can hold
    // several positions.
    if (!positionId) throw new BrokerError('closing an MT5 position needs its ticket', { code: 'NO_POSITION_ID' });
    const res = await call(this.base, this.apiKey, '/close_position', { method: 'POST', body: { position: { ticket: Number(positionId) } } });
    const price = Number(res.result?.price ?? res.price ?? 0) || null;
    return { closed: true, price, raw: res };
  }

  /** Broker truth: open positions and pending orders. */
  async reconcile() {
    const [positions, orders] = await Promise.all([this.positions(), call(this.base, this.apiKey, '/orders')]);
    return { positions: positions.positions, orders: listOf(orders, 'orders') };
  }

  /**
   * Emergency flatten. mt5-gateway has no kill switch of its own, so this
   * closes every open position; it cannot stop new orders from elsewhere.
   */
  async kill({ flatten = false } = {}) {
    if (!flatten) throw new BrokerError('mt5-gateway has no kill switch; use flatten to close every position', { code: 'NOT_SUPPORTED' });
    return call(this.base, this.apiKey, '/close_all_positions', { method: 'POST', body: {} });
  }

  async releaseKill() {
    throw new BrokerError('mt5-gateway has no kill switch to release', { code: 'NOT_SUPPORTED' });
  }
}
