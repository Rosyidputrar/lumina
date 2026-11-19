/**
 * Paper broker.
 *
 * A broker interface backed by the local database with deliberately unkind
 * fills: cross the spread, pay taker fees, and eat slippage that scales with
 * order size relative to recent volume. This is the mode the automated engine
 * trades in by default and it is the mode used for all backtest validation.
 *
 * Interface (shared with the live adapters):
 *   place(order) -> { brokerOrderId, status, filledQty, avgFill, fees }
 *   close(position, price, reason) -> { exitPrice, pnl, fees }
 *   cancel(brokerOrderId)
 *   positions()
 */
import { uid } from '../store.js';

const round = (v, d = 8) => Number(v.toFixed(d));

import { costsFor, DEFAULT_COSTS } from '../analysis/costs.js';

export class PaperBroker {
  constructor({ store, config, clock = () => Date.now() }) {
    this.store = store;
    this.cfg = config.paper ?? {};
    // Fills are priced with the instrument's own cost class.
    this.costTable = config.costs ?? DEFAULT_COSTS;
    this.clock = clock;
    this.id = 'paper';
  }

  /** Simulate a taker fill against a quoted mid price. */
  costs(instrument) {
    return costsFor(instrument ?? {}, this.costTable);
  }

  fillPrice(side, mid, qty, recentVolume, costs = this.costs()) {
    const spread = (mid * costs.spreadBps) / 10000 / 2;
    const impactBps = qty > 0 && recentVolume > 0 ? (qty / recentVolume) * 100 : 0;
    const slip = (mid * costs.slippageBps + mid * impactBps) / 10000;
    return round(side === 'buy' || side === 'long' ? mid + spread + slip : mid - spread - slip, 8);
  }

  async place({ userId, mode = 'paper', venue, symbol, side, qty, type = 'market', limitPrice, mid, recentVolume, signalId, stop, target, reduceOnly = false }) {
    if (!(qty > 0)) throw new Error('paper: qty must be > 0');
    const costs = this.costs({ venue, symbol });
    const px = type === 'limit' && limitPrice ? limitPrice : this.fillPrice(side, mid, qty, recentVolume, costs);
    const fee = round((px * qty * costs.feeBps) / 10000, 8);
    const orderId = this.store.insertOrder({
      userId,
      signalId,
      mode,
      venue,
      symbol,
      side,
      type,
      qty,
      limitPrice: limitPrice ?? null,
      stopPrice: stop ?? null,
      takeProfit: target ?? null,
      status: 'filled',
      filledQty: qty,
      avgFill: px,
      fees: fee,
      brokerOrderId: uid('paper'),
    });
    this.store.insertFill({ orderId, userId, price: px, qty, fee, ts: this.clock() });

    if (!reduceOnly) {
      const positionId = this.store.insertPosition({
        userId,
        mode,
        venue,
        symbol,
        side: side === 'buy' ? 'long' : 'short',
        qty,
        entry: px,
        stop,
        target,
        fees: fee,
        signalId,
        brokerPositionId: uid('paperpos'),
      });
      return { brokerOrderId: orderId, positionId, status: 'filled', filledQty: qty, avgFill: px, fees: fee };
    }
    return { brokerOrderId: orderId, status: 'filled', filledQty: qty, avgFill: px, fees: fee };
  }

  close({ userId, position, price, reason = 'manual', recentVolume = 0 }) {
    const exitSide = position.side === 'long' ? 'sell' : 'buy';
    const costs = this.costs({ venue: position.venue, symbol: position.symbol });
    const px = this.fillPrice(exitSide, price, position.qty, recentVolume, costs);
    const fee = round((px * position.qty * costs.feeBps) / 10000, 8);
    const gross = position.side === 'long' ? (px - position.entry) * position.qty : (position.entry - px) * position.qty;
    // Net of both legs: the entry fee was paid when the position opened and
    // belongs in the trade's result, the same way the backtester counts it.
    const entryFee = Number(position.fees ?? 0) || 0;
    const pnl = round(gross - fee - entryFee, 8);

    const orderId = this.store.insertOrder({
      userId,
      signalId: position.signal_id,
      mode: position.mode,
      venue: position.venue,
      symbol: position.symbol,
      side: exitSide,
      type: 'market',
      qty: position.qty,
      status: 'filled',
      filledQty: position.qty,
      avgFill: px,
      fees: fee,
      brokerOrderId: uid('paper'),
    });
    this.store.insertFill({ orderId, userId, price: px, qty: position.qty, fee, ts: this.clock() });
    this.store.updatePosition(position.id, {
      status: 'closed',
      exitPrice: px,
      pnl,
      fees: (position.fees ?? 0) + fee,
      closedAt: this.clock(),
      closeReason: reason,
    });
    this.store.addRealized(userId, pnl, fee + entryFee);
    return { exitPrice: px, pnl, fees: round(fee + entryFee, 8), gross: round(gross, 8) };
  }

  async cancel() {
    return { cancelled: true };
  }

  async positions() {
    return { ok: true, source: 'local' };
  }
}
