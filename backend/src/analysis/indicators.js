/**
 * Technical indicator library.
 *
 * Everything here is a pure function of an OHLCV array so it can be unit
 * tested and reused by both the live engine and the backtester. Conventions:
 *   - inputs are arrays of { ts, open, high, low, close, volume }
 *   - outputs are arrays aligned to the input, with `null` while warming up
 *     (never silently zero-filled — a zero would look like a real signal)
 */

export const closes = (c) => c.map((x) => x.close);
export const highs = (c) => c.map((x) => x.high);
export const lows = (c) => c.map((x) => x.low);
export const volumes = (c) => c.map((x) => x.volume ?? 0);

/** Simple moving average. */
export function sma(values, period) {
  if (period <= 0) throw new Error('sma: period must be > 0');
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period`. */
export function ema(values, period) {
  if (period <= 0) throw new Error('ema: period must be > 0');
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder smoothing (used by RSI / ATR / ADX). */
function wilder(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Relative Strength Index (Wilder). */
export function rsi(values, period = 14) {
  const n = values.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const gains = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const d = values[i] - values[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const avgG = wilder(gains.slice(1), period);
  const avgL = wilder(losses.slice(1), period);
  for (let i = 0; i < avgG.length; i++) {
    const g = avgG[i];
    const l = avgL[i];
    if (g === null || l === null) continue;
    const idx = i + period;
    out[idx] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** True Range then ATR (Wilder). */
export function trueRange(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out[i] = c.high - c.low;
      continue;
    }
    const pc = candles[i - 1].close;
    out[i] = Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  }
  return out;
}

export function atr(candles, period = 14) {
  const tr = trueRange(candles);
  return wilder(tr.slice(1), period).reduce((acc, v, i) => {
    acc[i + 1] = v;
    return acc;
  }, new Array(candles.length).fill(null));
}

/** MACD: {macd, signal, hist}. */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] === null || es[i] === null ? null : ef[i] - es[i]));
  const seedIdx = line.findIndex((v) => v !== null);
  const compact = line.slice(seedIdx).filter((v) => v !== null);
  const sig = ema(compact, signalPeriod);
  const signal = new Array(values.length).fill(null);
  for (let i = 0; i < sig.length; i++) signal[seedIdx + i] = sig[i];
  const hist = values.map((_, i) => (line[i] === null || signal[i] === null ? null : line[i] - signal[i]));
  return { macd: line, signal, hist };
}

/** Bollinger Bands. */
export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (mid[i] === null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

/** Average Directional Index with +DI / -DI. */
export function adx(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > dn && up > 0 ? up : 0;
    minusDM[i] = dn > up && dn > 0 ? dn : 0;
  }
  const tr = trueRange(candles);
  const atrS = wilder(tr.slice(1), period);
  const pS = wilder(plusDM.slice(1), period);
  const mS = wilder(minusDM.slice(1), period);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = 0; i < atrS.length; i++) {
    const idx = i + 1;
    if (atrS[i] === null || atrS[i] === 0) continue;
    plusDI[idx] = (100 * pS[i]) / atrS[i];
    minusDI[idx] = (100 * mS[i]) / atrS[i];
    const sum = plusDI[idx] + minusDI[idx];
    dx[idx] = sum === 0 ? 0 : (100 * Math.abs(plusDI[idx] - minusDI[idx])) / sum;
  }
  const firstDx = dx.findIndex((v) => v !== null);
  const compact = dx.slice(firstDx).filter((v) => v !== null);
  const adxS = wilder(compact, period);
  const adxOut = new Array(n).fill(null);
  for (let i = 0; i < adxS.length; i++) adxOut[firstDx + i] = adxS[i];
  return { adx: adxOut, plusDI, minusDI };
}

/** Rolling VWAP over `period` bars (session VWAP when period = bars in a day). */
export function vwap(candles, period = 24) {
  const out = new Array(candles.length).fill(null);
  let pvSum = 0;
  let vSum = 0;
  const pv = [];
  const v = [];
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const vol = candles[i].volume ?? 0;
    pv.push(tp * vol);
    v.push(vol);
    pvSum += tp * vol;
    vSum += vol;
    if (i >= period) {
      pvSum -= pv[i - period];
      vSum -= v[i - period];
    }
    if (i >= period - 1 && vSum > 0) out[i] = pvSum / vSum;
  }
  return out;
}

/** Donchian channel (highest high / lowest low over period). */
export function donchian(candles, period = 20) {
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** Stochastic %K / %D. */
export function stochastic(candles, period = 14, smoothK = 3, smoothD = 3) {
  const raw = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    raw[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }
  const kValues = smoothNullable(raw, smoothK);
  const dValues = smoothNullable(kValues, smoothD);
  return { k: kValues, d: dValues };
}

function smoothNullable(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] === null) {
        ok = false;
        break;
      }
      sum += values[j];
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

/** On-balance volume. */
export function obv(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const dir = Math.sign(candles[i].close - candles[i - 1].close);
    out[i] = out[i - 1] + dir * (candles[i].volume ?? 0);
  }
  return out;
}

/** Pivot highs/lows with `left`/`right` confirmation bars. */
export function pivots(candles, left = 3, right = 3) {
  const highsOut = [];
  const lowsOut = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highsOut.push({ i, ts: candles[i].ts, price: candles[i].high });
    if (isLow) lowsOut.push({ i, ts: candles[i].ts, price: candles[i].low });
  }
  return { highs: highsOut, lows: lowsOut };
}

/**
 * Support / resistance zones from pivots, clustered by ATR proximity.
 * Returns zones sorted by strength (touches).
 */
export function levels(candles, { lookback = 180, toleranceAtr = 0.6 } = {}) {
  const slice = candles.slice(-lookback);
  const a = lastValue(atr(slice, 14)) ?? (slice.at(-1).close * 0.005);
  const { highs: ph, lows: pl } = pivots(slice, 2, 2);
  const points = [...ph.map((p) => ({ ...p, kind: 'resistance' })), ...pl.map((p) => ({ ...p, kind: 'support' }))];
  const zones = [];
  for (const p of points.sort((x, y) => x.price - y.price)) {
    const tol = a * toleranceAtr;
    const z = zones.find((z) => Math.abs(z.price - p.price) <= tol);
    if (z) {
      z.touches++;
      z.price = (z.price * (z.touches - 1) + p.price) / z.touches;
      z.firstTs = Math.min(z.firstTs, p.ts);
      z.lastTs = Math.max(z.lastTs, p.ts);
    } else {
      zones.push({ price: p.price, touches: 1, firstTs: p.ts, lastTs: p.ts, kind: p.kind });
    }
  }
  const price = candles.at(-1).close;
  return zones
    .map((z) => ({ ...z, distancePct: ((z.price - price) / price) * 100, side: z.price >= price ? 'above' : 'below' }))
    .sort((a, b) => b.touches - a.touches || Math.abs(a.distancePct) - Math.abs(b.distancePct))
    .slice(0, 8);
}

/**
 * Divergence between price and an oscillator over the last two pivots.
 * Returns 'bullish' | 'bearish' | null plus the pivot pair for evidence.
 *
 * Two families, both real and both used by the sweep playbook:
 *   classic — price makes a lower low while the oscillator makes a higher low
 *             (or a higher high with a lower high) → exhaustion
 *   hidden  — price makes a higher low while the oscillator makes a lower low
 *             (or a lower high with a higher high) → continuation
 * `type` reports the direction the divergence argues for; `kind` says which
 * family fired.
 */
export function divergence(candles, oscillator, side = 'low') {
  const piv = pivots(candles, 3, 1);
  const points = side === 'low' ? piv.lows : piv.highs;
  const usable = points.filter((p) => oscillator[p.i] !== null && p.i < candles.length - 1);
  if (usable.length < 2) return { type: null };
  const [a, b] = usable.slice(-2);
  const oa = oscillator[a.i];
  const ob = oscillator[b.i];
  const pair = { from: { ...a, osc: oa }, to: { ...b, osc: ob } };

  if (side === 'low') {
    if (b.price < a.price && ob > oa + 1.5) return { type: 'bullish', kind: 'classic', ...pair };
    if (b.price > a.price && ob < oa - 1.5) return { type: 'bullish', kind: 'hidden', ...pair };
  } else {
    if (b.price > a.price && ob < oa - 1.5) return { type: 'bearish', kind: 'classic', ...pair };
    if (b.price < a.price && ob > oa + 1.5) return { type: 'bearish', kind: 'hidden', ...pair };
  }
  return { type: null, ...pair };
}

/**
 * Fair value gaps (3-candle imbalance) in the lookback window.
 */
export function fairValueGaps(candles, lookback = 80) {
  const out = [];
  const start = Math.max(2, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    if (c.low > a.high) out.push({ kind: 'bullish', from: a.high, to: c.low, ts: candles[i - 1].ts, i: i - 1 });
    else if (c.high < a.low) out.push({ kind: 'bearish', from: c.high, to: a.low, ts: candles[i - 1].ts, i: i - 1 });
  }
  // keep only gaps not yet fully filled
  const price = candles.at(-1).close;
  return out.filter((g) => (g.kind === 'bullish' ? price > g.from : price < g.to)).slice(-4);
}

/** % change over n bars. */
export function roc(values, period = 10) {
  return values.map((v, i) => (i < period || values[i - period] === 0 ? null : ((v - values[i - period]) / values[i - period]) * 100));
}

/** Realised volatility (annualised-ish, per-bar stdev of returns in %). */
export function volatility(values, period = 30) {
  const rets = values.map((v, i) => (i === 0 ? 0 : (v - values[i - 1]) / values[i - 1]));
  const out = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j++) mean += rets[j];
    mean /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (rets[j] - mean) ** 2;
    out[i] = Math.sqrt(v / period) * 100;
  }
  return out;
}

export function lastValue(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  return null;
}

export function valueAt(arr, i) {
  return arr[i] === undefined ? null : arr[i];
}

/** Build a full indicator snapshot for the last bar. */
export function snapshot(candles) {
  if (!Array.isArray(candles) || candles.length < 30) throw new Error('snapshot: need at least 30 candles');
  const cl = closes(candles);
  const price = cl.at(-1);
  const e21 = ema(cl, 21);
  const e50 = ema(cl, 50);
  const e200 = ema(cl, Math.min(200, Math.floor(candles.length * 0.9)));
  const r = rsi(cl, 14);
  const a = atr(candles, 14);
  const m = macd(cl);
  const b = bollinger(cl, 20, 2);
  const d = adx(candles, 14);
  const vw = vwap(candles, 24);
  const st = stochastic(candles, 14);
  const vol = volumes(candles);
  const dc = donchian(candles, 20);
  return {
    price,
    ema21: lastValue(e21),
    ema50: lastValue(e50),
    ema200: lastValue(e200),
    rsi: lastValue(r),
    atr: lastValue(a),
    atrPct: (lastValue(a) / price) * 100,
    macd: lastValue(m.macd),
    macdSignal: lastValue(m.signal),
    macdHist: lastValue(m.hist),
    bbUpper: lastValue(b.upper),
    bbMid: lastValue(b.mid),
    bbLower: lastValue(b.lower),
    bbWidthPct: ((lastValue(b.upper) - lastValue(b.lower)) / price) * 100,
    adx: lastValue(d.adx),
    plusDI: lastValue(d.plusDI),
    minusDI: lastValue(d.minusDI),
    vwap: lastValue(vw),
    stochK: lastValue(st.k),
    stochD: lastValue(st.d),
    donchianHigh: lastValue(dc.upper),
    donchianLow: lastValue(dc.lower),
    // The most recent swing range, which is what a grid is actually fitted to.
    rangeHigh: Math.max(...candles.slice(-40).map((c) => c.high)),
    rangeLow: Math.min(...candles.slice(-40).map((c) => c.low)),
    obv: lastValue(obv(candles)),
    volume: vol.at(-1),
    volumeAvg: sma(vol, 20).at(-1),
    volRatio: vol.at(-1) / (sma(vol, 20).at(-1) || 1),
    roc10: lastValue(roc(cl, 10)),
    volatility: lastValue(volatility(cl, 30)),
    series: { ema21: e21, ema50: e50, rsi: r, macd: m, atr: a, bollinger: b, adx: d, vwap: vw, stoch: st, obv: obv(candles) },
  };
}
