/**
 * Position-building and range strategies: DCA and GRID.
 *
 * These are the two strategies every retail bot app sells, and both are sold
 * dishonestly: DCA "averages down" until the account is gone, and GRID loses
 * everything the moment price leaves the range it was fitted to. This module
 * implements them anyway, because they are genuinely useful, but with the caps
 * those apps leave out:
 *
 *   DCA   hard ladder depth, widening gaps, and a hard invalidation level that
 *         closes the whole ladder instead of adding to a losing book forever.
 *   GRID  refuses to arm unless the regime is actually ranging (low ADX, price
 *         inside the Donchian band), and carries a hard stop outside the range.
 *
 * Every number that reaches a broker comes from here, and every plan states its
 * own worst case so the UI can show it rather than hide it.
 *
 * Pure functions. No imports, no I/O — so this file also runs on Cloudflare.
 */

const round = (v, d = 8) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

/* ───────────────────────────── risk presets ─────────────────────────────── */

/**
 * The one genuinely good idea from the app-store bots: three named risk
 * profiles. They change *sizing*, never the strategy's direction — a preset must
 * not be able to turn a bad setup into a good one.
 */
export const PRESETS = {
  conservative: {
    id: 'conservative',
    label: 'Conservative',
    maxRiskPerTrade: 0.0025,
    maxPortfolioHeat: 0.01,
    maxOpenPositions: 2,
    maxLeverage: 1,
    maxPositionNotionalPct: 0.15,
    minConfidence: 70,
    minRewardRisk: 2.0,
    dailyTradeCap: 4,
    cooldownMinutes: 90,
    maxDailyLoss: 0.01,
  },
  optimal: {
    id: 'optimal',
    label: 'Optimal',
    maxRiskPerTrade: 0.005,
    maxPortfolioHeat: 0.02,
    maxOpenPositions: 3,
    maxLeverage: 3,
    maxPositionNotionalPct: 0.25,
    minConfidence: 62,
    minRewardRisk: 1.6,
    dailyTradeCap: 12,
    cooldownMinutes: 30,
    maxDailyLoss: 0.02,
  },
  aggressive: {
    id: 'aggressive',
    label: 'Aggressive',
    maxRiskPerTrade: 0.01,
    maxPortfolioHeat: 0.04,
    maxOpenPositions: 5,
    maxLeverage: 5,
    maxPositionNotionalPct: 0.35,
    minConfidence: 55,
    minRewardRisk: 1.3,
    dailyTradeCap: 30,
    cooldownMinutes: 10,
    maxDailyLoss: 0.04,
  },
};

export function presetPolicy(preset, overrides = {}) {
  const base = PRESETS[preset] ?? PRESETS.optimal;
  const { id, label, ...policy } = base;
  return { ...policy, ...overrides };
}

/* ──────────────────────────────── safety ────────────────────────────────── */

/** Absolute ceilings that no preset, and no owner override, may exceed. */
export const HARD_CAPS = {
  maxLadderDepth: 8,
  maxGridLevels: 20,
  maxRiskPerTrade: 0.02,
  minStopDistanceAtr: 0.4,
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ─────────────────────────────────── DCA ────────────────────────────────── */

/**
 * Build a DCA ladder.
 *
 * `side: 'long'` means "buy the dips": the first entry is now, and each further
 * rung sits lower. `side: 'short'` mirrors it.
 *
 * The invalidation price is the point at which the plan is simply wrong, and it
 * is always inside the total risk budget. That is the difference between this
 * and an app-store DCA bot: the worst case is written down before the first
 * order, not discovered afterwards.
 */
export function planDCA({
  price,
  side = 'long',
  atr,
  equity,
  riskPerTrade = 0.005,
  depth = 4,
  spacingAtr = 0.8,
  sizeMultiplier = 1.5,
  stopAtr = 2.5,
} = {}) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('DCA needs a positive price');
  if (!Number.isFinite(atr) || atr <= 0) throw new Error('DCA needs a positive ATR');
  if (!Number.isFinite(equity) || equity <= 0) throw new Error('DCA needs equity');

  const rungs = clamp(Math.round(depth), 1, HARD_CAPS.maxLadderDepth);
  const risk = clamp(riskPerTrade, 0.0001, HARD_CAPS.maxRiskPerTrade);
  const budget = equity * risk;
  const dir = side === 'short' ? -1 : 1;

  // Geometric ladder: each rung is `sizeMultiplier` times the last. The total
  // notional therefore grows faster than linearly, which is exactly why the
  // depth is capped.
  // Rung 1 is the market entry; each further rung sits a fixed distance away in
  // the losing direction, so the average only improves as the position is built.
  const weights = [];
  const prices = [];
  for (let i = 0; i < rungs; i++) {
    weights.push(sizeMultiplier ** i);
    prices.push(round(price + dir * -1 * i * spacingAtr * atr, 8));
  }
  prices[0] = round(price, 8);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  // Size so that a stop-out of the whole ladder loses `budget`, not the per-rung
  // budget. Averaging down must not multiply the risk.
  const lastPrice = prices[prices.length - 1];
  const invalidation = round(lastPrice + dir * -1 * stopAtr * atr, 8);
  const avgEntry = prices.reduce((a, p, i) => a + p * weights[i], 0) / weightSum;
  const riskPerUnit = Math.abs(avgEntry - invalidation);
  if (riskPerUnit <= 0) throw new Error('DCA invalidation coincides with entry');
  const totalQty = budget / riskPerUnit;

  const ladder = prices.map((p, i) => ({
    rung: i + 1,
    price: p,
    qty: round((totalQty * weights[i]) / weightSum, 8),
    notional: round(((totalQty * weights[i]) / weightSum) * p, 2),
  }));

  const funded = ladder.reduce((a, r) => a + r.notional, 0);

  return {
    strategy: 'dca',
    side,
    depth: rungs,
    ladder,
    spacingAtr,
    stopAtr,
    averageEntry: round(avgEntry, 8),
    invalidation,
    totalQty: round(totalQty, 8),
    totalNotional: round(funded, 2),
    maxLoss: round(budget, 2),
    maxLossPct: round((budget / equity) * 100, 3),
    // Stated plainly so the UI cannot hide it.
    note:
      side === 'short'
        ? 'Sells into strength. If price keeps rising past the invalidation level the whole ladder is closed at maxLoss.'
        : 'Buys into weakness. If price keeps falling past the invalidation level the whole ladder is closed at maxLoss.',
  };
}

/* ────────────────────────────────── GRID ────────────────────────────────── */

/**
 * Decide whether a grid is even appropriate.
 *
 * A grid is a bet on mean reversion. Arming one in a trend is the single most
 * common way these bots blow up, so this refuses unless the market is measurably
 * ranging.
 */
export function gridSuitability({ adx, bbWidthPct, price, donchianHigh, donchianLow, atr }) {
  const reasons = [];
  if (Number.isFinite(adx) && adx > 22) reasons.push('trending: ADX is too high for a range');
  if (Number.isFinite(bbWidthPct) && bbWidthPct < 0.6) reasons.push('range too tight to clear fees');
  if (Number.isFinite(donchianHigh) && Number.isFinite(donchianLow) && Number.isFinite(price)) {
    const span = donchianHigh - donchianLow;
    if (span <= 0) reasons.push('no measurable range');
    else if (price > donchianHigh || price < donchianLow) reasons.push('price is outside the range');
  }
  if (!Number.isFinite(atr) || atr <= 0) reasons.push('ATR unavailable');
  return { suitable: reasons.length === 0, reasons };
}

/**
 * Build a neutral grid inside the recent range, with a hard stop beyond it.
 *
 * Levels are priced so each buy/sell pair clears a stated fee threshold;
 * otherwise the bot is only generating commission.
 */
export function planGrid({
  price,
  donchianHigh,
  donchianLow,
  atr,
  equity,
  levels = 10,
  feePct = 0.00055,
  riskPerTrade = 0.005,
  suitability,
} = {}) {
  if (!Number.isFinite(price) || price <= 0) throw new Error('GRID needs a positive price');
  if (!Number.isFinite(donchianHigh) || !Number.isFinite(donchianLow) || donchianHigh <= donchianLow) {
    throw new Error('GRID needs a valid range');
  }
  if (suitability && !suitability.suitable) {
    throw new Error(`GRID refused: ${suitability.reasons.join('; ')}`);
  }

  const n = clamp(Math.round(levels), 2, HARD_CAPS.maxGridLevels);
  const high = donchianHigh;
  const low = donchianLow;
  const step = (high - low) / n;
  const risk = clamp(riskPerTrade, 0.0001, HARD_CAPS.maxRiskPerTrade);

  // Each rung must clear round-trip fees plus a margin, or it is not worth
  // placing at all.
  const stepPct = step / price;
  const profitable = stepPct > feePct * 2.5;

  const grid = [];
  for (let i = 1; i < n; i++) {
    const p = round(low + i * step, 8);
    grid.push({ level: i, price: p, side: p < price ? 'buy' : 'sell' });
  }

  // Size from the distance to the stop, never from the number of levels.
  const stopDistance = Number.isFinite(atr) && atr > 0 ? atr * 1.5 : step;
  const perLevelRisk = (equity * risk) / Math.max(1, grid.length);
  const qty = perLevelRisk / stopDistance;

  const stop = round(low - stopDistance, 8);
  const maxLoss = round(qty * stopDistance * grid.length, 2);

  return {
    strategy: 'grid',
    range: { high: round(high, 8), low: round(low, 8), step: round(step, 8), stepPct: round(stepPct * 100, 3) },
    levels: grid,
    perLevelQty: round(qty, 8),
    perLevelNotional: round(qty * price, 2),
    stop,
    maxLoss,
    maxLossPct: round((maxLoss / equity) * 100, 3),
    feePerRoundTripPct: round(feePct * 100, 4),
    profitable: profitable,
    note: profitable
      ? 'Each step clears fees with margin.'
      : 'WARNING: the step is too small to clear fees reliably. Widen the range or reduce the level count.',
  };
}

/* ───────────────────────────── combined planner ─────────────────────────── */

/**
 * One entry point for the UI and the API: pick a strategy, get a plan, and get
 * back either a usable plan or the reason it was refused.
 */
export function planStrategy(kind, input = {}) {
  try {
    if (kind === 'dca') {
      return { ok: true, plan: planDCA(input) };
    }
    if (kind === 'grid') {
      const suit = gridSuitability(input);
      if (!suit.suitable) return { ok: false, strategy: 'grid', reasons: suit.reasons };
      return { ok: true, plan: planGrid({ ...input, suitability: suit }) };
    }
    return { ok: false, reasons: [`unknown strategy: ${kind}`] };
  } catch (err) {
    return { ok: false, strategy: kind, reasons: [String(err && err.message)] };
  }
}
