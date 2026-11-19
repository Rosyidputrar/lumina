/**
 * The analysis engine.
 *
 * One job: turn a candle series into an explainable, falsifiable trade plan.
 * Every point of confidence is traceable to a named factor with a number
 * attached, and every plan ships with explicit invalidation criteria. If the
 * evidence is thin the engine says "no trade" instead of manufacturing one.
 *
 * Nothing in here knows about money, brokers or users — it is a pure function
 * of market data, which is what makes it backtestable and unit-testable.
 */
import * as I from './indicators.js';
import { costsFor, roundTripCost } from './costs.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const pct = (v, d = 2) => round(v, d);

/* ------------------------------- regime -------------------------------- */

/**
 * Classify the market state. Deliberately uses structure rather than a single
 * indicator: ADX for trend strength, EMA stack for direction, ATR percentile
 * for expansion/compression, and efficiency ratio for trend quality.
 */
export function detectRegime(candles, snap) {
  const cl = I.closes(candles);
  const atrSeries = snap.series.atr.filter((v) => v !== null);
  const atrNow = snap.atr ?? 0;
  const atrRank = atrSeries.length > 40 ? percentileRank(atrSeries, atrNow) : 0.5;

  const efficiency = efficiencyRatio(cl, 20);
  const adxVal = snap.adx ?? 0;
  const stackedUp = snap.ema21 > snap.ema50 && snap.ema50 > (snap.ema200 ?? -Infinity) && snap.price > snap.ema21;
  const stackedDown = snap.ema21 < snap.ema50 && snap.ema50 < (snap.ema200 ?? Infinity) && snap.price < snap.ema21;
  const bbWidth = snap.bbWidthPct ?? 0;
  const bbRank = bbWidthRank(candles, snap);

  let regime = 'range';
  let label = 'Balanced range';
  if (atrRank > 0.82 && bbRank > 0.8) {
    regime = 'expansion';
    label = 'Volatility expansion';
  } else if (bbRank < 0.18 && atrRank < 0.25) {
    regime = 'compression';
    label = 'Volatility compression (coiling)';
  } else if (adxVal >= 25 && efficiency > 0.32 && stackedUp) {
    regime = 'trend_up';
    label = 'Established uptrend';
  } else if (adxVal >= 25 && efficiency > 0.32 && stackedDown) {
    regime = 'trend_down';
    label = 'Established downtrend';
  } else if (adxVal >= 20 && efficiency > 0.22 && stackedUp) {
    regime = 'weak_up';
    label = 'Early uptrend';
  } else if (adxVal >= 20 && efficiency > 0.22 && stackedDown) {
    regime = 'weak_down';
    label = 'Early downtrend';
  }

  return {
    regime,
    label,
    direction: regime.includes('up') ? 'long' : regime.includes('down') ? 'short' : 'neutral',
    adx: pct(adxVal, 1),
    efficiency: round(efficiency, 3),
    atrPercentile: round(atrRank, 2),
    bbWidthPercentile: round(bbRank, 2),
    stackedUp,
    stackedDown,
    playbooks: PLAYBOOK_FIT[regime] ?? PLAYBOOK_FIT.range,
  };
}

const PLAYBOOK_FIT = {
  trend_up: ['trend_pullback', 'breakout_retest', 'momentum_continuation'],
  weak_up: ['trend_pullback', 'breakout_retest'],
  trend_down: ['trend_pullback', 'breakout_retest', 'momentum_continuation'],
  weak_down: ['trend_pullback', 'breakout_retest'],
  range: ['range_mean_reversion', 'liquidity_sweep_reversal'],
  compression: ['breakout_retest', 'liquidity_sweep_reversal'],
  expansion: ['momentum_continuation', 'breakout_retest'],
};

function efficiencyRatio(values, period) {
  const n = values.length;
  if (n <= period) return 0;
  const net = Math.abs(values[n - 1] - values[n - 1 - period]);
  let path = 0;
  for (let i = n - period; i < n; i++) path += Math.abs(values[i] - values[i - 1]);
  return path === 0 ? 0 : net / path;
}

function percentileRank(arr, value) {
  if (!arr.length) return 0.5;
  let below = 0;
  for (const v of arr) if (v <= value) below++;
  return below / arr.length;
}

function bbWidthRank(candles, snap) {
  const widths = [];
  const period = 60;
  for (let i = Math.max(20, candles.length - period); i < candles.length; i++) {
    const w = I.bollinger(I.closes(candles.slice(0, i + 1)), 20, 2);
    const up = w.upper.at(-1);
    const lo = w.lower.at(-1);
    const mid = w.mid.at(-1);
    if (up !== null && lo !== null && mid) widths.push(((up - lo) / mid) * 100);
  }
  if (widths.length < 10) return 0.5;
  return percentileRank(widths, widths.at(-1));
}

/* ------------------------------ playbooks ------------------------------ */

/**
 * Each playbook returns a candidate or null. Candidates are scored by the
 * `scoreCandidate` function below using shared + playbook-specific factors.
 */
const playbooks = {
  /** Buy/sell a pullback into the EMA21/EMA50 zone inside an established trend. */
  trend_pullback({ candles, snap, regime, zones }) {
    const dir = regime.direction;
    if (dir === 'neutral') return null;
    const price = snap.price;
    const bandLo = Math.min(snap.ema21, snap.ema50);
    const bandHi = Math.max(snap.ema21, snap.ema50);
    const atr = snap.atr;
    const inZone = price >= bandLo - atr * 0.9 && price <= bandHi + atr * 0.9;
    const pulledBack = dir === 'long' ? snap.rsi < 58 && snap.rsi > 34 : snap.rsi > 42 && snap.rsi < 66;
    if (!inZone && !(distancePct(price, snap.ema21) < 0.8)) return null;
    if (!pulledBack) return null;

    const entry = price;
    const swing = dir === 'long' ? lowOf(candles, 12) : highOf(candles, 12);
    const stop = dir === 'long' ? Math.min(swing, entry - atr * 1.2) : Math.max(swing, entry + atr * 1.2);
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return null;
    const structureTarget = dir === 'long' ? nearestAbove(zones, price)?.price : nearestBelow(zones, price)?.price;
    const measured = dir === 'long' ? entry + risk * 2.4 : entry - risk * 2.4;
    const target1 = structureTarget && Math.abs(structureTarget - entry) / risk > 0.8 ? structureTarget : measured;
    const target2 = dir === 'long' ? Math.max(target1, entry + risk * 3.2) : Math.min(target1, entry - risk * 3.2);

    return {
      playbook: 'trend_pullback',
      name: 'Trend pullback',
      direction: dir,
      entry,
      stop,
      target1,
      target2,
      factors: [
        factor('Trend alignment', 22, 1, `ADX ${pct(snap.adx, 1)}, ${regime.label.toLowerCase()}`),
        factor('Pullback depth', 14, clamp((60 - Math.abs(50 - snap.rsi)) / 20, 0, 1), `RSI ${pct(snap.rsi, 1)} cooled without breaking structure`),
        factor('Dynamic support', 12, inZone ? 1 : 0.4, `Price within EMA21/50 band (${pct(bandLo)}–${pct(bandHi)})`),
        factor('Volume participation', 8, clamp(snap.volRatio / 1.4, 0, 1), `Volume ${round(snap.volRatio, 2)}× 20-bar average`),
        factor('Room to resistance', 10, clamp(Math.abs(target1 - entry) / (risk * 3), 0, 1), `Structure target ${pct(target1)}`),
      ],
      invalidations: [
        `Close beyond ${pct(dir === 'long' ? snap.ema50 : snap.ema50)} against the trend`,
        `Loss of swing ${dir === 'long' ? 'low' : 'high'} at ${pct(swing)}`,
      ],
      thesis: `${regime.label}: price has retraced into the ${dir === 'long' ? 'demand' : 'supply'} band while trend structure holds.`,
    };
  },

  /** Trade the retest of a broken level / Donchian edge. */
  breakout_retest({ candles, snap, regime, zones }) {
    const don = I.donchian(candles, 20);
    const up = don.upper.at(-2);
    const dn = don.lower.at(-2);
    if (up === null || dn === null) return null;
    const atr = snap.atr;
    const price = snap.price;
    const brokeUp = snap.price > up && candles.at(-1).close > up && (regime.regime === 'expansion' || regime.stackedUp || regime.direction !== 'down');
    const brokeDown = snap.price < dn && candles.at(-1).close < dn && regime.direction !== 'up';

    let dir;
    let level;
    if (brokeUp && Math.abs(price - up) < atr * 1.4) {
      dir = 'long';
      level = up;
    } else if (brokeDown && Math.abs(price - dn) < atr * 1.4) {
      dir = 'short';
      level = dn;
    } else {
      return null;
    }

    const entry = price;
    const stop = dir === 'long' ? level - atr * 0.9 : level + atr * 0.9;
    const risk = Math.abs(entry - stop);
    const target1 = dir === 'long' ? entry + risk * 2.2 : entry - risk * 2.2;
    const target2 = dir === 'long' ? entry + risk * 3.4 : entry - risk * 3.4;

    return {
      playbook: 'breakout_retest',
      name: 'Breakout retest',
      direction: dir,
      entry,
      stop,
      target1,
      target2,
      factors: [
        factor('Breakout confirmation', 20, snap.volRatio > 1.3 ? 1 : 0.6, `Close beyond 20-bar ${dir === 'long' ? 'high' : 'low'} at ${pct(level)}`),
        factor('Volume expansion', 14, clamp(snap.volRatio / 1.8, 0, 1), `Volume ${round(snap.volRatio, 2)}× average`),
        factor('Volatility regime', 10, regime.regime === 'expansion' ? 1 : 0.5, regime.label),
        factor('Momentum', 12, clamp(Math.abs(snap.macdHist) / (atr * 0.35), 0, 1), `MACD histogram ${round(snap.macdHist, 2)}`),
        factor('Retest proximity', 8, clamp(1 - Math.abs(price - level) / (atr * 1.4), 0, 1), `Price ${round(Math.abs(price - level) / atr, 2)}× ATR from the broken level`),
      ],
      invalidations: [`Sustained hourly close back inside the range (${pct(level)})`, 'Volume dries up on continuation'],
      thesis: `Range edge at ${pct(level)} broke with participation; the retest offers asymmetric entry.`,
    };
  },

  /** Liquidity sweep then reclaim — the classic stop-hunt reversal. */
  liquidity_sweep_reversal({ candles, snap, zones }) {
    const atr = snap.atr;
    const price = snap.price;
    const look = candles.slice(-4);
    const priorLow = Math.min(...candles.slice(-24, -3).map((c) => c.low));
    const priorHigh = Math.max(...candles.slice(-24, -3).map((c) => c.high));
    const sweptLow = look.some((c) => c.low < priorLow) && price > priorLow;
    const sweptHigh = look.some((c) => c.high > priorHigh) && price < priorHigh;
    if (!sweptLow && !sweptHigh) return null;

    const dir = sweptLow ? 'long' : 'short';
    const sweepLevel = sweptLow ? priorLow : priorHigh;
    const sweepExtreme = sweptLow ? Math.min(...look.map((c) => c.low)) : Math.max(...look.map((c) => c.high));
    const entry = price;
    const stop = sweptLow ? sweepExtreme - atr * 0.35 : sweepExtreme + atr * 0.35;
    const risk = Math.abs(entry - stop);
    if (risk <= 0 || risk > atr * 3) return null;
    const target1 = sweptLow ? entry + risk * 2.0 : entry - risk * 2.0;
    const target2 = sweptLow ? entry + risk * 3.0 : entry - risk * 3.0;

    const rsiDiv = I.divergence(candles, snap.series.rsi, sweptLow ? 'low' : 'high');

    return {
      playbook: 'liquidity_sweep_reversal',
      name: 'Liquidity sweep reversal',
      direction: dir,
      entry,
      stop,
      target1,
      target2,
      factors: [
        factor('Liquidity sweep', 20, 1, `${sweptLow ? 'Low' : 'High'} at ${pct(sweepLevel)} swept to ${pct(sweepExtreme)} then reclaimed`),
        factor('Reclaim quality', 14, clamp(Math.abs(price - sweepLevel) / (atr * 0.6), 0, 1), `Price back ${round(Math.abs(price - sweepLevel) / atr, 2)}× ATR inside the range`),
        factor('RSI divergence', 12, rsiDiv.type ? 1 : 0.35, rsiDiv.type ? `${rsiDiv.type} divergence confirmed on the sweep` : 'No divergence — momentum confirmation only'),
        factor('Wick rejection', 10, clamp(Math.abs(candleWickRatio(candles.at(-1), sweptLow ? 'low' : 'high')) / 0.6, 0, 1), 'Rejection wick on the sweep candle'),
        factor('Reward/risk geometry', 8, clamp(risk / atr < 1.2 ? 1 : 0.5, 0, 1), `Stop ${round(risk / atr, 2)}× ATR beyond the sweep`),
      ],
      invalidations: [`Any close beyond the sweep extreme (${pct(sweepExtreme)})`, 'Failure to hold the reclaimed level for two bars'],
      thesis: `Stops were taken beyond ${pct(sweepLevel)} and immediately reclaimed — the trapped side is now the fuel.`,
    };
  },

  /** Fade range edges back to the mid. */
  range_mean_reversion({ candles, snap, regime }) {
    if (regime.regime !== 'range') return null;
    const don = I.donchian(candles, 40);
    const upper = don.upper.at(-1);
    const lower = don.lower.at(-1);
    if (upper === null || lower === null) return null;
    const mid = (upper + lower) / 2;
    const pos = (snap.price - lower) / (upper - lower);
    const long = pos < 0.16 && snap.rsi < 36;
    const short = pos > 0.84 && snap.rsi > 64;
    if (!long && !short) return null;
    const dir = long ? 'long' : 'short';
    const atr = snap.atr;
    const entry = snap.price;
    const stop = long ? lower - atr * 0.75 : upper + atr * 0.75;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) return null;
    const target1 = mid;
    const target2 = long ? upper : lower;
    if (Math.abs(target1 - entry) / risk < 0.9) return null;

    return {
      playbook: 'range_mean_reversion',
      name: 'Range mean reversion',
      direction: dir,
      entry,
      stop,
      target1,
      target2,
      factors: [
        factor('Range position', 18, clamp(Math.abs(pos - 0.5) * 2, 0, 1), `Price at ${pct(pos * 100, 0)}% of the 40-bar range`),
        factor('Oscillator extreme', 14, clamp(Math.abs(snap.rsi - 50) / 22, 0, 1), `RSI ${pct(snap.rsi, 1)}`),
        factor('Regime suitability', 12, 1, 'Range regime — mean reversion has the edge'),
        factor('Mid-range objective', 10, clamp(Math.abs(target1 - entry) / (risk * 1.5), 0, 1), `Mid at ${pct(mid)}, ${round(Math.abs(target1 - entry) / risk, 2)}R away`),
        factor('Volatility containment', 8, clamp(1 - (regime.atrPercentile ?? 0.5), 0, 1), 'Low ATR percentile keeps the range intact'),
      ],
      invalidations: [`Close outside ${pct(long ? lower : upper)} invalidates the range`, `ADX > 30 suggests the range is resolving`],
      thesis: `Range-bound tape (${regime.label.toLowerCase()}): fade the extreme, target the mid.`,
    };
  },

  /** Ride a strong impulse with a shallow continuation entry. */
  momentum_continuation({ candles, snap, regime }) {
    if (!['expansion', 'trend_up', 'trend_down'].includes(regime.regime)) return null;
    const dir = snap.macdHist > 0 && snap.price > snap.ema21 ? 'long' : snap.macdHist < 0 && snap.price < snap.ema21 ? 'short' : null;
    if (!dir) return null;
    if (Math.abs(snap.roc10) < 0.6) return null;
    const atr = snap.atr;
    const entry = snap.price;
    const stop = dir === 'long' ? entry - atr * 1.5 : entry + atr * 1.5;
    const risk = Math.abs(entry - stop);
    const target1 = dir === 'long' ? entry + risk * 2.0 : entry - risk * 2.0;
    const target2 = dir === 'long' ? entry + risk * 3.0 : entry - risk * 3.0;

    return {
      playbook: 'momentum_continuation',
      name: 'Momentum continuation',
      direction: dir,
      entry,
      stop,
      target1,
      target2,
      factors: [
        factor('Impulse strength', 18, clamp(Math.abs(snap.roc10) / 3, 0, 1), `10-bar ROC ${pct(snap.roc10)}%`),
        factor('MACD alignment', 14, clamp(Math.abs(snap.macdHist) / (atr * 0.3), 0, 1), `Histogram ${round(snap.macdHist, 2)}`),
        factor('EMA structure', 12, 1, `Price ${dir === 'long' ? 'above' : 'below'} EMA21 (${pct(snap.ema21)})`),
        factor('Trend persistence', 10, clamp((snap.adx ?? 0) / 35, 0, 1), `ADX ${pct(snap.adx, 1)}`),
        factor('Participation', 8, clamp(snap.volRatio / 1.5, 0, 1), `Volume ${round(snap.volRatio, 2)}× average`),
      ],
      invalidations: [`Close back through EMA21 (${pct(snap.ema21)})`, 'MACD histogram flips sign against the position'],
      thesis: `Momentum is aligned across trend, MACD and participation — continuation is the higher-probability path.`,
    };
  },
};

function factor(label, weight, strength, note) {
  const s = clamp(strength, 0, 1);
  return { label, weight, strength: round(s, 3), points: round(weight * s, 2), note };
}

function distancePct(a, b) {
  return Math.abs((a - b) / b) * 100;
}
function lowOf(candles, n) {
  return Math.min(...candles.slice(-n).map((c) => c.low));
}
function highOf(candles, n) {
  return Math.max(...candles.slice(-n).map((c) => c.high));
}
function nearestAbove(zones, price) {
  return zones.filter((z) => z.price > price).sort((a, b) => a.price - b.price)[0] ?? null;
}
function nearestBelow(zones, price) {
  return zones.filter((z) => z.price < price).sort((a, b) => b.price - a.price)[0] ?? null;
}
function candleWickRatio(candle, side) {
  const range = candle.high - candle.low || 1;
  return side === 'low' ? (Math.min(candle.open, candle.close) - candle.low) / range : (candle.high - Math.max(candle.open, candle.close)) / range;
}

/* -------------------------------- scoring ------------------------------- */

export function scoreCandidate(candidate, ctx) {
  const factors = [...candidate.factors];

  // Shared context factors — the same for every playbook.
  const { snap, regime, candles } = ctx;
  const trendDir = regime.direction;
  const aligned = trendDir === 'neutral' ? 0.5 : trendDir === candidate.direction ? 1 : 0;
  factors.push(factor('Higher-timeframe bias', 12, aligned, aligned === 1 ? 'Aligned with the dominant regime' : aligned === 0 ? 'Counter-trend — size down' : 'Neutral regime, no bias'));

  const rr = Math.abs(candidate.target1 - candidate.entry) / Math.max(Math.abs(candidate.entry - candidate.stop), 1e-9);
  factors.push(factor('Reward/risk', 12, clamp((rr - 1) / 1.8, 0, 1), `${round(rr, 2)} : 1 to first target`));

  const cleanStop = Math.abs(candidate.entry - candidate.stop) / (snap.atr || 1);
  factors.push(factor('Stop placement', 8, clamp(1 - Math.abs(cleanStop - 1.4) / 2, 0, 1), `Stop ${round(cleanStop, 2)}× ATR from entry`));

  const volSane = snap.volatility === null ? 0.5 : clamp(1 - Math.abs(snap.volatility - 0.9) / 1.6, 0, 1);
  factors.push(factor('Volatility sanity', 6, volSane, `Per-bar volatility ${pct(snap.volatility)}%`));

  // Structural confluence: is the entry near a real level?
  const zones = I.levels(candles);
  const near = zones.find((z) => Math.abs(z.price - candidate.entry) / candidate.entry < 0.004);
  factors.push(factor('Structural confluence', 10, near ? clamp(near.touches / 3, 0.35, 1) : 0.25, near ? `Entry sits on a ${near.touches}× tested ${near.kind} at ${pct(near.price)}` : 'No tested level at entry'));

  const raw = factors.reduce((a, f) => a + f.points, 0);
  const max = factors.reduce((a, f) => a + f.weight, 0);
  const confidence = clamp((raw / max) * 100, 0, 100);

  return { factors, confidence: round(confidence, 1), rewardRisk: round(rr, 2), zones };
}

/* --------------------------------- plan -------------------------------- */

/**
 * Build the final plan object consumed by the risk engine, the UI and the
 * journal. Returns null when no playbook fires.
 */
const TIMEFRAME_MS = {
  m1: 60_000, m5: 300_000, m15: 900_000, m30: 1_800_000,
  h1: 3_600_000, '1h': 3_600_000, h4: 14_400_000, '4h': 14_400_000,
  d1: 86_400_000, '1d': 86_400_000,
};

/**
 * Drop the bar that is still forming.
 *
 * Brokers send the in-progress candle as the last row. Its volume is only the
 * part of the period that has elapsed, so a volume ratio against a 20-bar
 * average reads near zero (0.03 was observed on a 1h chart), every volume
 * factor collapses, and no setup is ever found. Its close moves too, so the
 * indicators describe a bar that does not exist yet.
 *
 * Trading on closed bars only is the normal convention for a reason.
 */
export function closedBars(candles, timeframe) {
  const ms = TIMEFRAME_MS[String(timeframe ?? '').toLowerCase()];
  if (!ms || !Array.isArray(candles) || candles.length < 2) return candles;
  const ts = Number(candles.at(-1)?.ts);
  if (!Number.isFinite(ts)) return candles;
  return Date.now() - ts < ms ? candles.slice(0, -1) : candles;
}

/* ------------------------------ strategies ----------------------------- */

/**
 * Strategy profiles: which playbooks may fire, and which rules a candidate
 * must pass before it is scored.
 *
 * `trend` is the default since a walk-forward study on real OKX and Kraken
 * history (13 markets, 1h/4h/1d, development and holdout sets kept apart).
 * The original rule set had almost no edge before costs (+0.015R a trade) and
 * lost -0.14R a trade on the holdout once costs were counted. Four rules, each
 * chosen for a reason rather than for the number it produced, took the holdout
 * to about break-even (-0.008R) and the worst drawdown from 39% to 8%:
 *   1. trade only with the 200-EMA trend (price and EMA50 on the same side);
 *   2. no counter-trend fades (range reversion, liquidity sweep) and no
 *      breakout retest, whose edge was negative before costs;
 *   3. a stop at least 2x ATR away, so ordinary noise does not stop it out;
 *   4. skip a setup whose round-trip cost exceeds 10% of the risk.
 * Break-even is not profit. Neither profile is a promise of returns.
 *
 * `classic` keeps the original behaviour for anyone who relies on it.
 */
export const STRATEGIES = {
  trend: {
    id: 'trend',
    label: 'Trend-aligned',
    playbooks: ['trend_pullback', 'momentum_continuation'],
    trendFilter: true,
    minStopAtr: 2,
    maxCostShare: 0.1,
  },
  classic: {
    id: 'classic',
    label: 'Classic (all playbooks)',
    playbooks: null,
    trendFilter: false,
    minStopAtr: 0,
    maxCostShare: null,
  },
};

let activeStrategy = 'trend';

export function setStrategy(name) {
  if (!STRATEGIES[name]) throw Object.assign(new Error(`unknown strategy: ${name}`), { code: 'BAD_STRATEGY' });
  activeStrategy = name;
  return STRATEGIES[name];
}

export function currentStrategy() {
  return activeStrategy;
}

/** Apply a profile's rules to one candidate. Returns the (possibly adjusted) candidate or a reason. */
function applyStrategy(c, profile, snap, costs) {
  if (profile.trendFilter) {
    const up = snap.ema200 !== null && snap.price > snap.ema200 && snap.ema50 > snap.ema200;
    const down = snap.ema200 !== null && snap.price < snap.ema200 && snap.ema50 < snap.ema200;
    if (c.direction === 'long' ? !up : !down) return { rejected: `${c.direction} against the 200-EMA trend` };
  }
  let out = c;
  if (profile.minStopAtr > 0 && snap.atr > 0) {
    const risk = Math.abs(c.entry - c.stop);
    const min = snap.atr * profile.minStopAtr;
    if (risk < min) {
      // Widen the stop and keep the same reward/risk, so the size shrinks with it.
      const rr = Math.abs(c.target1 - c.entry) / risk;
      const sgn = c.direction === 'long' ? 1 : -1;
      out = { ...c, stop: c.entry - sgn * min, target1: c.entry + sgn * min * rr, target2: c.entry + sgn * min * Math.max(rr, 3) };
    }
  }
  if (profile.maxCostShare && costs) {
    const cost = roundTripCost(costs) * out.entry;
    const risk = Math.abs(out.entry - out.stop);
    if (cost > profile.maxCostShare * risk) return { rejected: `costs would be ${Math.round((cost / risk) * 100)}% of the risk` };
  }
  return { candidate: out };
}

export function buildPlan(input, { symbol, venue, timeframe, label, assetClass = null, costs = null, strategy = undefined } = {}) {
  const candles = closedBars(input, timeframe);
  const profile = STRATEGIES[strategy ?? activeStrategy] ?? STRATEGIES.trend;
  const instrumentCosts = costs ?? costsFor({ assetClass, symbol, venue });
  if (!Array.isArray(candles) || candles.length < 60) {
    return { ok: false, reason: 'insufficient_history', candles: candles?.length ?? 0 };
  }
  const snap = I.snapshot(candles);
  const regime = detectRegime(candles, snap);
  const ctx = { candles, snap, regime };
  const zones = I.levels(candles);
  const candidates = [];
  const filtered = [];
  for (const name of regime.playbooks) {
    const fn = playbooks[name];
    if (!fn) continue;
    if (profile.playbooks && !profile.playbooks.includes(name)) continue;
    try {
      const c = fn({ candles, snap, regime, zones });
      if (!c) continue;
      const r = applyStrategy(c, profile, snap, instrumentCosts);
      if (r.candidate) candidates.push(r.candidate);
      else filtered.push({ playbook: c.playbook, direction: c.direction, why: r.rejected });
    } catch {
      /* a playbook that cannot evaluate simply does not fire */
    }
  }
  if (!candidates.length) {
    return {
      ok: false,
      reason: filtered.length ? 'filtered_by_strategy' : 'no_setup',
      strategy: profile.id,
      filtered,
      symbol,
      venue,
      timeframe,
      regime,
      snapshot: summarise(snap),
      zones,
      at: candles.at(-1).ts,
    };
  }
  const scored = candidates
    .map((c) => {
      const s = scoreCandidate(c, ctx);
      return { ...c, ...s };
    })
    .sort((a, b) => b.confidence - a.confidence);
  const best = scored[0];

  return {
    ok: true,
    symbol,
    venue,
    label: label ?? symbol,
    timeframe,
    strategy: profile.id,
    filtered,
    playbook: best.playbook,
    name: best.name,
    direction: best.direction,
    entry: round(best.entry, 6),
    stop: round(best.stop, 6),
    target1: round(best.target1, 6),
    target2: round(best.target2, 6),
    rewardRisk: best.rewardRisk,
    confidence: best.confidence,
    regime,
    factors: best.factors,
    invalidations: best.invalidations,
    thesis: best.thesis,
    alternatives: scored.slice(1, 3).map((s) => ({ playbook: s.playbook, name: s.name, direction: s.direction, confidence: s.confidence })),
    snapshot: summarise(snap),
    zones,
    at: candles.at(-1).ts,
  };
}

function summarise(snap) {
  const keep = ['price', 'ema21', 'ema50', 'ema200', 'rsi', 'atr', 'atrPct', 'macd', 'macdSignal', 'macdHist', 'bbUpper', 'bbMid', 'bbLower', 'bbWidthPct', 'adx', 'plusDI', 'minusDI', 'vwap', 'stochK', 'stochD', 'volRatio', 'roc10', 'volatility'];
  const out = {};
  for (const k of keep) out[k] = round(snap[k], 4);
  return out;
}

export { playbooks };
