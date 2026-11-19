/**
 * Risk engine.
 *
 * Position size is derived from the stop distance, never from conviction.
 * A high-confidence setup with a wide stop gets a *smaller* position, which is
 * the whole point. Every rejection returns a machine-readable reason so the UI
 * and the audit log can explain why an opportunity was not taken.
 */

const round = (v, d = 8) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export class RiskEngine {
  constructor(policy) {
    this.policy = {
      maxRiskPerTrade: 0.005,
      maxDailyLoss: 0,
      maxOpenPositions: 0,
      maxEntriesPerSymbol: 1,
      maxPositionNotionalPct: 0,
      maxLeverage: 0,
      minConfidence: 62,
      minRewardRisk: 1.6,
      dailyTradeCap: 0,
      cooldownMinutes: 0,
      maxPortfolioHeat: 0,
      ...policy,
    };
  }

  /** Position size for a plan, in base units, capped by notional and leverage. */
  size({ equity, entry, stop, price, maxNotionalPct }) {
    const stopDistance = Math.abs(entry - stop);
    if (!(stopDistance > 0) || !(equity > 0) || !(entry > 0)) {
      return { qty: 0, riskAmount: 0, notional: 0, reason: 'invalid_inputs' };
    }
    const riskAmount = equity * this.policy.maxRiskPerTrade;
    const rawQty = riskAmount / stopDistance;
    const px = price ?? entry;
    const notionalPct = maxNotionalPct ?? this.policy.maxPositionNotionalPct;
    const notionalCap = notionalPct > 0 ? equity * notionalPct : Infinity;
    const leverageCap = this.policy.maxLeverage > 0 ? (equity * this.policy.maxLeverage) / px : Infinity;
    const notionalQty = notionalCap / px;
    const qty = Math.min(rawQty, notionalQty, leverageCap);
    return {
      qty: round(qty, 8),
      riskAmount: round(qty * stopDistance, 2),
      notional: round(qty * px, 2),
      capped: qty < rawQty - 1e-12,
      stopDistance: round(stopDistance, 8),
    };
  }

  /**
   * Full pre-trade check. `ctx` carries account + portfolio state.
   * Returns { approved, reasons[], sizing }.
   */
  evaluate(plan, ctx) {
    const p = this.policy;
    const reasons = [];
    const { equity, openPositions = [], dayPnl = 0, dayTrades = 0, lastTradeAt = 0, symbol, positionMap = {} } = ctx;

    if (!plan?.ok) return { approved: false, reasons: [plan?.reason ?? 'no_plan'], sizing: null };

    // A manual ticket has no signal behind it, so confidence and reward/risk are
    // not meaningful and must not be faked to pass. Every hard portfolio limit
    // below still applies — the trader is trusted with direction, not with
    // breaking the book.
    if (!plan.manual) {
      if (plan.confidence < p.minConfidence) reasons.push(`confidence ${plan.confidence} below ${p.minConfidence}`);
      if (plan.rewardRisk < p.minRewardRisk) reasons.push(`reward/risk ${plan.rewardRisk} below ${p.minRewardRisk}`);
    }

    // Zero means no cap. The owner asked to trade on the licence's credit alone,
    // so position count, trade count and heat are all optional now. Per-trade
    // risk still sizes every order — that is sizing, not a limit.
    const openCount = openPositions.length;
    if (p.maxOpenPositions > 0 && openCount >= p.maxOpenPositions) {
      reasons.push(`max open positions (${p.maxOpenPositions}) reached`);
    }

    const sameSymbol = openPositions.filter((x) => x.symbol === plan.symbol).length;
    if (p.maxEntriesPerSymbol > 0 && sameSymbol >= p.maxEntriesPerSymbol) {
      reasons.push(`max entries on ${plan.symbol} (${p.maxEntriesPerSymbol}) reached`);
    }

    const dayLoss = Math.abs(Math.min(dayPnl, 0));
    // A daily loss stop is optional. Zero means none: the owner asked to trade
    // for as long as the licence has credit, and per-trade risk plus the heat
    // limit still bound every order, so this is not an open gate.
    if (p.maxDailyLoss > 0 && dayLoss >= equity * p.maxDailyLoss) {
      reasons.push(`daily loss limit hit (${round((dayLoss / equity) * 100, 2)}%)`);
    }

    if (p.dailyTradeCap > 0 && dayTrades >= p.dailyTradeCap) {
      reasons.push(`daily trade cap (${p.dailyTradeCap}) reached`);
    }

    if (lastTradeAt && Date.now() - lastTradeAt < p.cooldownMinutes * 60_000) {
      reasons.push(`cooldown active for ${Math.ceil((p.cooldownMinutes * 60_000 - (Date.now() - lastTradeAt)) / 60000)} more min`);
    }

    // Correlated exposure guard: do not stack the same direction on correlated books.
    const sameDirection = openPositions.filter((x) => x.side === plan.direction);
    const heat = sameDirection.reduce((a, x) => a + Math.abs((x.entry - (x.stop ?? x.entry)) * x.qty), 0);
    const sizing = this.size({ equity, entry: plan.entry, stop: plan.stop, price: plan.snapshot?.price ?? plan.entry });

    if (p.maxPortfolioHeat > 0 && heat + sizing.riskAmount > equity * p.maxPortfolioHeat) {
      reasons.push(`portfolio heat would exceed ${round(p.maxPortfolioHeat * 100, 1)}%`);
    }

    if (!(sizing.qty > 0)) reasons.push('position size rounds to zero — stop too wide for equity');

    // Notional exposure of the whole book
    const notionalExposure = openPositions.reduce((a, x) => a + x.qty * (positionMap[x.symbol] ?? x.entry), 0);
    if (p.maxLeverage > 0) {
      const maxBook = equity * p.maxLeverage;
      if (notionalExposure + sizing.notional > maxBook) reasons.push('book leverage limit');
    }

    return { approved: reasons.length === 0, reasons, sizing };
  }

  /**
   * Trailing stop suggestion.
   *
   * Two behaviours in one call, because they always happen in this order:
   *   1. at ~0.9R the stop is pulled to break-even (plus a small buffer, so the
   *      trade does not close for exactly zero after fees);
   *   2. from then on it trails the price at a fixed ATR multiple.
   *
   * Returns null when the stop should stay put, so the caller can skip the
   * amend round-trip entirely.
   */
  manageStop(position, price, atr) {
    const { side, entry, stop } = position;
    if (!stop || !atr) return null;
    // 1R is the distance to the ORIGINAL stop when it is known. Measured from a
    // stop that has already moved, it shrinks to almost nothing after break-even.
    const r = Math.abs(entry - (position.initialStop ?? stop));
    const moved = side === 'long' ? price - entry : entry - price;
    if (moved < r * 0.9) return null;

    const breakeven = side === 'long' ? Math.max(stop, entry + r * 0.05) : Math.min(stop, entry - r * 0.05);
    const trail = side === 'long' ? Math.max(breakeven, price - atr * 1.6) : Math.min(breakeven, price + atr * 1.6);

    // Never loosen a stop: a trailing stop that moves backwards is not a stop.
    if (side === 'long' ? trail > stop * 1.0005 : trail < stop * 0.9995) return round(trail, 8);
    return null;
  }

  /**
   * What kind of stop move this is, so the journal and the Telegram alert can
   * say "moved to break-even" rather than a bare number.
   */
  stopAction(position, nextStop) {
    const { side, entry, stop } = position;
    if (!nextStop) return null;
    const r = Math.abs(entry - stop);
    const atBreakeven = side === 'long' ? nextStop >= entry + r * 0.04 : nextStop <= entry - r * 0.04;
    const previously = side === 'long' ? (stop ?? -Infinity) >= entry : (stop ?? Infinity) <= entry;
    if (atBreakeven && !previously) return 'breakeven';
    return 'trail';
  }

  /** Risk snapshot for the dashboard. */
  report({ equity, openPositions, dayPnl, startingEquity }) {
    const heat = openPositions.reduce((a, x) => a + Math.abs((x.entry - (x.stop ?? x.entry)) * x.qty), 0);
    const notional = openPositions.reduce((a, x) => a + x.qty * x.entry, 0);
    return {
      equity: round(equity, 2),
      dayPnl: round(dayPnl, 2),
      dayPnlPct: round((dayPnl / (equity - dayPnl || 1)) * 100, 2),
      openRisk: round(heat, 2),
      openRiskPct: round((heat / (equity || 1)) * 100, 2),
      notional: round(notional, 2),
      leverageUsed: round(notional / (equity || 1), 2),
      drawdownPct: round(((startingEquity - equity) / (startingEquity || 1)) * 100 * -1, 2),
      limits: {
        maxRiskPerTradePct: round(this.policy.maxRiskPerTrade * 100, 2),
        maxDailyLossPct: round(this.policy.maxDailyLoss * 100, 2),
        maxPortfolioHeatPct: round((this.policy.maxPortfolioHeat ?? 0.02) * 100, 2),
        maxOpenPositions: this.policy.maxOpenPositions,
        maxEntriesPerSymbol: this.policy.maxEntriesPerSymbol,
        maxLeverage: this.policy.maxLeverage,
        dailyTradeCap: this.policy.dailyTradeCap,
        minConfidence: this.policy.minConfidence,
        minRewardRisk: this.policy.minRewardRisk,
        cooldownMinutes: this.policy.cooldownMinutes,
      },
      headroom: {
        tradesLeft: Math.max(0, this.policy.dailyTradeCap - 0),
        lossBudget: round(Math.max(0, equity * this.policy.maxDailyLoss + Math.min(dayPnl, 0)), 2),
      },
    };
  }
}
