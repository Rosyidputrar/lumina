/**
 * AI provider layer — OpenAI-compatible, so any endpoint works.
 *
 * The owner picks a base URL, a key and a model. Anything that speaks the
 * OpenAI chat-completions shape (OpenAI itself, OpenRouter, Groq, Together,
 * DeepSeek, Ollama, LM Studio, vLLM, a company gateway) is therefore a
 * first-class provider without a code change per vendor.
 *
 * Two rules shape this file:
 *
 *   1. **The key never leaves the edge.** It is stored in D1, written only by
 *      an authenticated owner, never returned to a browser, never logged.
 *   2. **Spending is bounded before it happens.** Every call is priced and
 *      checked against a credit budget first; a runaway loop must hit a wall
 *      rather than an invoice.
 *
 * Pure fetch + crypto. No imports, so this file also runs on Cloudflare.
 */

/* ─────────────────────────── cost estimation ────────────────────────────── */

/**
 * Published per-million-token prices, used only to *estimate* spend before the
 * call. Real numbers come back in the response's `usage` field and are recorded
 * separately, so an out-of-date table can never silently overrun the budget by
 * more than one request.
 *
 * Unknown models fall back to a deliberately pessimistic rate.
 */
export const PRICES = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
  'o3-mini': { in: 1.1, out: 4.4 },
  'o4-mini': { in: 1.1, out: 4.4 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-3.5': { in: 0.8, out: 4 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'llama-3.3-70b': { in: 0.59, out: 0.79 },
  'qwen-2.5-72b': { in: 0.35, out: 0.4 },
  'mistral-large': { in: 2, out: 6 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
};

/** Pessimistic default: $5 in, $20 out per million tokens. */
const DEFAULT_PRICE = { in: 5, out: 20 };

export function priceOf(model) {
  if (!model) return DEFAULT_PRICE;
  const key = String(model).toLowerCase();
  if (PRICES[key]) return PRICES[key];
  // Longest matching prefix, so "gpt-4o-mini-2024-07-18" finds "gpt-4o-mini"
  // and not "gpt-4o".
  const match = Object.keys(PRICES)
    .filter((k) => key.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return match ? PRICES[match] : DEFAULT_PRICE;
}

/** Very cheap token estimate: ~4 characters per token, which over-counts. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}

export function estimateCost(model, promptText, maxOutputTokens = 700) {
  const p = priceOf(model);
  const inTokens = estimateTokens(promptText);
  const cost = (inTokens / 1e6) * p.in + (maxOutputTokens / 1e6) * p.out;
  return { inTokens, maxOutputTokens, cost: Math.round(cost * 1e6) / 1e6 };
}

/* ──────────────────────────────── requests ──────────────────────────────── */

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}

/**
 * Normalise a base URL. Owners paste all of these in practice:
 *   https://api.openai.com
 *   https://api.openai.com/v1
 *   https://api.openai.com/v1/chat/completions
 * All three must end up at the same endpoint.
 */
export function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('A base URL is required.');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Only https, or plain http to localhost, so a key is never sent in clear. */
export function baseUrlProblem(baseUrl) {
  let u;
  try {
    u = new URL(String(baseUrl));
  } catch {
    return 'That is not a valid URL.';
  }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return null;
  return 'Use https:// (or http://localhost for a local model). A key must never travel in clear text.';
}

/**
 * Fetch the model list from the provider.
 *
 * Every OpenAI-compatible server exposes `GET /v1/models`, but the shape of the
 * reply varies, so this accepts the common variants and returns a sorted,
 * de-duplicated list. A failure is reported rather than swallowed: the owner
 * needs to know their key or URL is wrong.
 */
export async function listModels({ baseUrl, apiKey, timeoutMs = 12000 }) {
  const problem = baseUrlProblem(baseUrl);
  if (problem) return { ok: false, error: problem };

  const base = String(baseUrl).trim().replace(/\/+$/, '');
  const root = /\/v\d+$/.test(base) ? base : /\/chat\/completions$/.test(base) ? base.replace(/\/chat\/completions$/, '') : `${base}/v1`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${root}/models`, {
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, detail: text.slice(0, 200) };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: 'The provider did not return JSON.' };
    }
    const raw = json.data ?? json.models ?? json.result ?? (Array.isArray(json) ? json : []);
    const ids = raw
      .map((m) => (typeof m === 'string' ? m : m.id ?? m.name ?? m.model))
      .filter((x) => typeof x === 'string' && x.length > 0);
    const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    return { ok: true, models: unique, count: unique.length };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'The provider timed out.' : 'Could not reach the provider.' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One chat completion.
 *
 * Returns `{ ok, text, usage, cost, error }` and never throws on a provider
 * failure — the caller decides what a dead AI means for a trade. Estimated cost
 * is returned even on failure so the ledger can record attempts.
 */
export async function chat({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  maxOutputTokens = 700,
  temperature = 0.2,
  timeoutMs = 45000,
}) {
  const problem = baseUrlProblem(baseUrl);
  if (problem) return { ok: false, error: problem };

  const promptText = system + messages.map((m) => m.content).join('\n');
  const estimate = estimateCost(model, promptText, maxOutputTokens);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(chatEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: maxOutputTokens,
        temperature,
        stream: false,
      }),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, detail: text.slice(0, 300), estimate };
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: 'The provider did not return JSON.', detail: text.slice(0, 200), estimate };
    }

    const choice = (json.choices ?? [])[0] ?? {};
    const answer = String(choice.message?.content ?? choice.text ?? '').trim();
    if (!answer) return { ok: false, error: 'The provider returned an empty answer.', estimate };

    // Prefer the provider's own accounting; fall back to the estimate.
    const usage = json.usage ?? null;
    let cost = estimate.cost;
    if (usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
      const p = priceOf(model);
      cost = Math.round(((usage.prompt_tokens / 1e6) * p.in + (usage.completion_tokens / 1e6) * p.out) * 1e6) / 1e6;
    }

    return {
      ok: true,
      answer,
      usage,
      cost,
      estimate,
      modelUsed: json.model ?? model,
      finishReason: choice.finish_reason ?? null,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return { ok: false, error: aborted ? 'The model timed out.' : 'Could not reach the model.', estimate };
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────────────────────── budget control ───────────────────────────── */

/**
 * Decide whether a call may proceed.
 *
 * Kept as a pure function so the rules are testable without a database:
 * a hard monthly cap, a per-call cost ceiling, and an optional daily cap.
 */
export function budgetCheck({ spentUsd = 0, capUsd = 10, costEstimate = 0, perCallCapUsd = 0.25, dailySpent = 0, dailyCapUsd = null }) {
  if (capUsd !== null && spentUsd >= capUsd) {
    return { allowed: false, reason: 'MONTHLY_CAP', message: `The AI budget of $${capUsd.toFixed(2)} is used up.`, remaining: 0 };
  }
  if (dailyCapUsd !== null && dailySpent >= dailyCapUsd) {
    return { allowed: false, reason: 'DAILY_CAP', message: `The daily AI cap of $${dailyCapUsd.toFixed(2)} is used up.`, remaining: 0 };
  }
  if (costEstimate > perCallCapUsd) {
    return {
      allowed: false,
      reason: 'CALL_TOO_EXPENSIVE',
      message: `This single call would cost about $${costEstimate.toFixed(4)}, above the $${perCallCapUsd.toFixed(2)} per-call ceiling. Pick a cheaper model or raise the ceiling.`,
    };
  }
  const remaining = capUsd === null ? null : Math.max(0, capUsd - spentUsd);
  if (remaining !== null && costEstimate > remaining) {
    return { allowed: false, reason: 'INSUFFICIENT_CREDIT', message: 'Not enough budget left for this call.', remaining };
  }
  return { allowed: true, remaining };
}
