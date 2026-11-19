/**
 * A stand-in for mt5-gateway (github.com/Gabriel-Rockson/mt5-gateway) that
 * answers with the same shapes its routes produce, read from its source:
 * X-API-Key auth, bare arrays from /fetch_data_pos and /get_positions,
 * {total, symbols} and {total, orders}, epoch-second tick times, ISO bar
 * times, results under `result`, and errors as {error, error_type, mt5_error}.
 *
 * It behaves like a broker where it matters to Lumina: SL/TP are rounded to
 * the symbol's digits, a symbol can refuse a filling mode, and `quirks` can
 * make it drop a stop, refuse a modify or refuse a close.
 */
import http from 'node:http';
import { makeCandles } from './helpers.js';

const SYMBOLS = {
  EURUSD: { name: 'EURUSD', digits: 5, point: 0.00001, volume_min: 0.01, volume_max: 100, volume_step: 0.01, filling_mode: 1, trade_contract_size: 100000, price: 1.1, currency_profit: 'USD' },
  XAUUSD: { name: 'XAUUSD', digits: 2, point: 0.01, volume_min: 0.01, volume_max: 50, volume_step: 0.01, filling_mode: 2, trade_contract_size: 100, price: 4100, currency_profit: 'USD' },
};

export async function startFakeGateway({ apiKey = 'gateway-test-key', quirks = {} } = {}) {
  const state = { positions: [], nextTicket: 5001, requests: [], quirks };
  const series = {
    EURUSD: makeCandles(400, { start: 1.1, drift: 0.0002, seed: 3 }),
    XAUUSD: makeCandles(400, { start: 4100, drift: 0.0003, seed: 5 }),
  };
  const priceOf = (s) => series[s].at(-1).close;
  const round = (v, d) => Number(Number(v).toFixed(d));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    state.requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!url.pathname.startsWith('/health') && req.headers['x-api-key'] !== apiKey) return send(401, { error: 'Unauthorized: missing or invalid API key' });
    const sym = (s) => SYMBOLS[s] ?? null;

    switch (`${req.method} ${url.pathname.replace(/\/[^/]+$/, (m) => (url.pathname.startsWith('/symbol_info') || url.pathname.startsWith('/orders/') ? '/:p' : m))}`) {
      case 'GET /health':
        return send(200, { status: 'healthy', mt5_status: 'connected', uptime_seconds: 12.5, mt5_account: 1234567, last_error: null });
      case 'GET /health/ready':
        return send(200, { status: 'ready', mt5_status: 'connected' });
      case 'GET /account':
        return send(200, { login: 1234567, name: 'Demo', server: 'Broker-Demo', currency: 'USD', balance: 10000, equity: 10000, margin: 0, margin_free: 10000, margin_level: 0, profit: 0, leverage: 100, terminal_trade_allowed: true });
      case 'GET /symbols':
        return send(200, { total: 2, symbols: Object.keys(SYMBOLS) });
      case 'GET /symbol_info/:p': {
        const s = sym(decodeURIComponent(url.pathname.split('/').pop()));
        if (!s) return send(404, { error: 'symbol (not found or not selectable) not found', error_type: 'not_found' });
        const { price, ...info } = s;
        return send(200, info);
      }
      case 'GET /symbol_info_tick/:p': {
        const name = decodeURIComponent(url.pathname.split('/').pop());
        if (!sym(name)) return send(404, { error: 'symbol tick info not found', error_type: 'not_found' });
        const p = priceOf(name);
        const now = Date.now();
        return send(200, { time: Math.floor(now / 1000), bid: p, ask: p + sym(name).point * 10, last: 0, volume: 0, time_msc: now });
      }
      case 'GET /fetch_data_pos': {
        const name = url.searchParams.get('symbol');
        if (!sym(name)) return send(404, { error: 'symbol (not found or not selectable) not found', error_type: 'not_found' });
        const n = Number(url.searchParams.get('num_bars') ?? 100);
        return send(200, series[name].slice(-n).map((c) => ({ time: new Date(c.ts).toISOString().replace(/\.\d{3}Z$/, 'Z'), open: c.open, high: c.high, low: c.low, close: c.close, tick_volume: Math.round(c.volume), spread: 10, real_volume: 0 })));
      }
      case 'POST /order_calc_profit': {
        const s = sym(body.symbol);
        const dir = body.type === 'BUY' ? 1 : -1;
        return send(200, { profit: round((body.price_close - body.price_open) * body.volume * s.trade_contract_size * dir, 2) });
      }
      case 'POST /order_calc_margin': {
        const s = sym(body.symbol);
        return send(200, { margin: round((body.price * body.volume * s.trade_contract_size) / 100, 2) });
      }
      case 'POST /order': {
        const s = sym(body.symbol);
        if (!s) return send(400, { error: `Symbol not found or not selectable: ${body.symbol}`, error_type: 'validation_error' });
        const allowed = { FOK: 1, IOC: 2 };
        if (body.type_filling && body.type_filling !== 'RETURN' && !(s.filling_mode & allowed[body.type_filling])) {
          return send(400, { error: 'Send order failed', error_type: 'mt5_error', mt5_error: { retcode: 10030, comment: 'Unsupported filling mode' } });
        }
        const buy = body.type === 'BUY';
        const price = buy ? priceOf(body.symbol) + s.point * 10 : priceOf(body.symbol);
        if (body.sl !== undefined && (buy ? body.sl >= price : body.sl <= price)) return send(400, { error: `For ${buy ? 'BUY' : 'SELL'} orders, SL must be ${buy ? 'below' : 'above'} entry price`, error_type: 'validation_error' });
        const ticket = state.nextTicket++;
        state.positions.push({
          ticket,
          time: Math.floor(Date.now() / 1000),
          type: buy ? 0 : 1,
          magic: body.magic ?? 0,
          volume: body.volume,
          price_open: price,
          sl: quirks.dropStops ? 0 : round(body.sl ?? 0, s.digits),
          tp: quirks.dropStops ? 0 : round(body.tp ?? 0, s.digits),
          price_current: price,
          profit: 0,
          symbol: body.symbol,
          comment: body.comment ?? '',
        });
        return send(200, { message: 'Order executed successfully', result: { retcode: 10009, deal: ticket + 90000, order: ticket, volume: body.volume, price, bid: priceOf(body.symbol), ask: price, comment: 'Request executed' }, sl_confirmed: null, tp_confirmed: null, partial_fill: false });
      }
      case 'GET /get_positions':
        return send(200, state.positions);
      case 'GET /orders':
        return send(200, { total: 0, orders: [] });
      case 'POST /modify_sl_tp': {
        if (quirks.refuseModify) return send(400, { error: 'Modify SL/TP failed', error_type: 'mt5_error', mt5_error: { retcode: 10016, comment: 'Invalid stops' } });
        const p = state.positions.find((x) => x.ticket === Number(body.position));
        if (!p) return send(400, { error: `position ${body.position} not found`, error_type: 'validation_error' });
        const d = sym(p.symbol).digits;
        if (body.sl !== undefined && body.sl !== null) p.sl = round(body.sl, d);
        if (body.tp !== undefined && body.tp !== null) p.tp = round(body.tp, d);
        return send(200, { message: 'SL/TP modified successfully', result: { retcode: 10009 } });
      }
      case 'POST /close_position': {
        if (quirks.refuseClose) return send(400, { error: 'Failed to close position', error_type: 'validation_error' });
        const i = state.positions.findIndex((x) => x.ticket === Number(body?.position?.ticket));
        if (i < 0) return send(400, { error: 'Failed to close position', error_type: 'validation_error' });
        const [p] = state.positions.splice(i, 1);
        return send(200, { message: 'Position closed successfully', result: { retcode: 10009, price: priceOf(p.symbol), volume: p.volume, order: p.ticket + 1 } });
      }
      case 'POST /close_all_positions': {
        const n = state.positions.length;
        state.positions = [];
        return send(200, { message: `Closed ${n} positions` });
      }
      default:
        return send(404, { error: 'not found', error_type: 'not_found' });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, apiKey, state, close: () => new Promise((r) => server.close(r)) };
}
