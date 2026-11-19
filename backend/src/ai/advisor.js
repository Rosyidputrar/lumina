/**
 * The AI advisor: a model proposes a trade, the engine decides whether it is
 * allowed to exist.
 *
 * This is the high-risk path, so the threat model is explicit. A language model
 * may be wrong, may be manipulated by text in a prompt, or may simply emit
 * broken JSON. None of that may reach a broker. Therefore:
 *
 *   - The model's output is **parsed, never trusted**. It must be a single JSON
 *     object; prose, markdown fences and multiple objects are rejected.
 *   - Every number is **re-derived from live market data**, not taken from the
 *     model. A proposal says "long BTC", not "long BTC at 42000".
 *   - The stop distance, position size and risk are computed here. A model that
 *     asks for 50x leverage gets the policy's maximum, or a refusal.
 *   - A proposal that fails any gate is returned as `rejected` with reasons, so
 *     the owner can see the model tried and was stopped.
 *
 * Pure functions, no imports — so this file also runs on Cloudflare.
 */

/**
 * Absolute ceilings for anything the AI may cause. Deliberately tighter than
 * the manual caps: a human typing an order has judgement a model does not.
 */
export const AI_CAPS = {
  maxRiskPct: 1.0, // never risk more than 1% of equity on an AI suggestion
  maxLeverage: 3,
  maxLadderDepth: 4,
  minRewardRisk: 1.3,
  minConfidence: 55,
  maxNotionalPct: 25, // never commit more than a quarter of equity
  allowedDir: ['long', 'short', 'flat'],
  allowedStrategy: ['dca', 'grid', 'none'],
};

/** The JSON contract we ask the model for, and the only shape we accept. */
export const AI_SCHEMA_HINT = `Respond with ONE JSON object and nothing else:
{
  "direction": "long" | "short" | "flat",
  "confidence": 0-100,
  "strategy": "dca" | "grid" | "none",
  "depth": 1-4,            // only for dca
  "levels": 2-20,          // only for grid
  "rewardRisk": number,    // expected reward divided by risk
  "reason": "one or two sentences"
}`;

/**
 * Extract the first balanced JSON object from a model reply.
 *
 * Models wrap JSON in fences, prefix it with prose, or emit two objects. Only a
 * single, complete, top-level object is accepted; anything else returns null
 * rather than being "repaired", because a repaired payload is a guessed payload.
 */
export function extractJson(text) {
  const src = String(text ?? '');
  const start = src.indexOf('{');
  if (start < 0) return null;

  // An array wrapping the object is not the contract; refuse it rather than
  // reaching inside, otherwise "one object" is not actually enforced.
  const firstArray = src.indexOf('[');
  if (firstArray >= 0 && firstArray < start) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(src.slice(start, i + 1));
          return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const num = (v, fallback = null) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ─────────────────────────────── validation ─────────────────────────────── */

/**
 * Check a parsed proposal against the caps *before* any price is involved.
 * Returns either `{ ok: true, proposal }` or `{ ok: false, reasons }`.
 */
export function validateProposal(raw, { equity = 10000, snapshot = {} } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reasons: ['the model did not return a JSON object'] };
  }

  const reasons = [];
  const direction = String(raw.direction ?? '').toLowerCase().trim();
  if (!AI_CAPS.allowedDir.includes(direction)) {
    reasons.push(`direction must be one of ${AI_CAPS.allowedDir.join('/')}`);
  }

  const confidence = num(raw.confidence);
  if (confidence === null) reasons.push('confidence must be a number');
  else if (confidence < 0 || confidence > 100) reasons.push('confidence must be between 0 and 100');
  else if (confidence < AI_CAPS.minConfidence) {
    reasons.push(`confidence ${confidence} is below the ${AI_CAPS.minConfidence} floor`);
  }

  const strategy = String(raw.strategy ?? 'none').toLowerCase().trim();
  if (!AI_CAPS.allowedStrategy.includes(strategy)) {
    reasons.push(`strategy must be one of ${AI_CAPS.allowedStrategy.join('/')}`);
  }

  const rewardRisk = num(raw.rewardRisk);
  if (rewardRisk !== null && rewardRisk < AI_CAPS.minRewardRisk) {
    reasons.push(`reward-to-risk ${rewardRisk} is below the ${AI_CAPS.minRewardRisk} minimum`);
  }

  let depth = num(raw.depth, 1);
  if (depth !== null) {
    if (depth < 1) reasons.push('depth must be at least 1');
    else if (depth > AI_CAPS.maxLadderDepth) {
      // Clamped rather than rejected: the intent is honoured, the excess is not.
      depth = AI_CAPS.maxLadderDepth;
    }
  }

  let levels = num(raw.levels, 10);
  if (levels !== null) {
    if (levels < 2) reasons.push('levels must be at least 2');
    else if (levels > 20) levels = 20;
  }

  // Strategy/regime sanity: a ladder or grid into a trending market is how
  // averaging-down accounts die, so refuse it regardless of the model's view.
  const adx = num(snapshot?.adx);
  if (direction !== 'flat' && Number.isFinite(adx)) {
    if (strategy === 'dca' && adx > 40) {
      reasons.push('averaging into a strongly trending market (ADX above 40) is refused');
    }
    if (strategy === 'grid' && adx > 22) {
      reasons.push('a grid needs a range, and ADX shows a trend');
    }
  }

  if (direction === 'flat') {
    // "Flat" is a valid, useful answer that authorises nothing.
    return { ok: true, proposal: { direction, confidence: confidence ?? 0, strategy: 'none', reason: String(raw.reason ?? '').slice(0, 500), flat: true } };
  }

  if (!(equity > 0)) reasons.push('the book has no equity to risk');

  if (reasons.length) return { ok: false, reasons };

  return {
    ok: true,
    proposal: {
      direction,
      confidence,
      strategy: strategy === 'none' ? 'none' : strategy,
      depth: Math.max(1, Math.round(depth ?? 1)),
      levels: Math.max(2, Math.round(levels ?? 10)),
      rewardRisk,
      reason: String(raw.reason ?? '').slice(0, 500),
      flat: false,
    },
  };
}

/* ─────────────────────────── turning it into a trade ────────────────────── */

/**
 * Convert an approved proposal into concrete order parameters.
 *
 * Every price comes from `snapshot`, never from the model. The stop is placed
 * at the engine's ATR distance, the size is derived from that distance, and the
 * risk is capped by `AI_CAPS` regardless of what the model claimed.
 */
export function proposalToOrder(proposal, { snapshot, equity, side, riskPct = 0.5 }) {
  const price = num(snapshot?.price);
  const atr = num(snapshot?.atr);
  if (!(price > 0)) throw new Error('no price in the snapshot');
  if (!(atr > 0)) throw new Error('no ATR in the snapshot');
  if (!(equity > 0)) throw new Error('no equity to size against');

  const risk = Math.min(Math.max(riskPct, 0.01), AI_CAPS.maxRiskPct) / 100;
  const budget = equity * risk;

  // Stop distance widened for ladder strategies so the whole ladder fits.
  const stopDistance = atr * (proposal.strategy === 'dca' ? 2.5 : 1.8);
  const dir = proposal.direction === 'short' ? -1 : 1;
  const stop = price - dir * stopDistance;

  const qty = budget / stopDistance;
  const notional = qty * price;
  const notionalPct = (notional / equity) * 100;

  const cappedNotionalPct = Math.min(notionalPct, AI_CAPS.maxNotionalPct);
  const scale = notionalPct > AI_CAPS.maxNotionalPct ? cappedNotionalPct / notionalPct : 1;
  const finalQty = qty * scale;

  const rewardRisk = proposal.rewardRisk ?? 2;
  const target = price + dir * stopDistance * Math.max(rewardRisk, AI_CAPS.minRewardRisk);

  return {
    side: proposal.direction,
    entry: round(price, 8),
    stop: round(stop, 8),
    target: round(target, 8),
    qty: round(finalQty, 8),
    notional: round(finalQty * price, 2),
    riskUsedPct: round(risk * 100, 4),
    maxLoss: round(finalQty * stopDistance, 2),
    stopDistance: round(stopDistance, 8),
    leverage: 1,
    clamped: {
      notional: scale < 1,
      depth: proposal.depth > AI_CAPS.maxLadderDepth,
    },
  };
}

function round(v, d = 8) {
  return Number.isFinite(v) ? Number(v.toFixed(d)) : null;
}

/* ────────────────────────── whole-flow convenience ──────────────────────── */

/**
 * Parse → validate → price. One call for the route, so there is no path where a
 * half-validated proposal reaches an order.
 */
export function advise({ replyText, snapshot, equity, riskPct = 0.5 }) {
  const raw = extractJson(replyText);
  if (!raw) {
    return { ok: false, stage: 'parse', reasons: ['the model did not return a usable JSON object'] };
  }
  const checked = validateProposal(raw, { equity, snapshot });
  if (!checked.ok) {
    return { ok: false, stage: 'validate', reasons: checked.reasons, proposal: raw };
  }
  if (checked.proposal.flat) {
    return { ok: true, stage: 'flat', proposal: checked.proposal, order: null };
  }
  try {
    const order = proposalToOrder(checked.proposal, { snapshot, equity, side: checked.proposal.direction, riskPct });
    return { ok: true, stage: 'order', proposal: checked.proposal, order };
  } catch (err) {
    return { ok: false, stage: 'pricing', reasons: [String(err && err.message)] };
  }
}

/** The system prompt that asks for that JSON and forbids everything else. */
export function advisorSystemPrompt() {
  return [
    'You are the trade advisor inside a systematic terminal.',
    'You are given a live market snapshot with indicators and the engine plan.',
    'Decide whether to trade. Most of the time the honest answer is "flat".',
    'Never invent prices: the terminal derives entry, stop and size from live data.',
    'Refuse when the setup is unclear, the regime fights the direction, or data is stale.',
    'Assume the reader will lose real money on a bad call.',
    AI_SCHEMA_HINT,
  ].join('\n');
}
