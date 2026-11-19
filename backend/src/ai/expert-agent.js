/**
 * Expert agent — a second, goal-aware AI layer above the deterministic analyst.
 *
 * Two agents live here:
 *
 *   1. ExpertAgent.review(): grades an analyst plan before it becomes an order.
 *   2. ExpertAgent.goalPlan(): turns "I want 500 profit today with 40 capital"
 *      into an honest plan — feasibility, style, sizing and the risk gate —
 *      with a Q&A loop for follow-up questions.
 *
 * Hard rules, stated plainly:
 *   - The expert never places orders and never overrides the risk engine.
 *   - A vetoed plan cannot auto-trade. Cautious plans keep the engine's
 *     confidence but are reported.
 *   - It uses the same OpenAI-compatible provider the owner configured, and
 *     degrades to a deterministic local verdict when no provider is set.
 */
import { estimateCost } from './providers.js';

const SYSTEM = `You are the Expert Agent of LuminaVantage, a trading terminal.
You review trading plans produced by a deterministic analyst engine.
You never execute orders. You grade them.
Answer ONLY with compact JSON: {"verdict":"agree|cautious|veto","confidence":<0-100>,
"reasons":["..."],"summary":"one sentence in Malay"}.
Ground every reason in the given numbers: risk, R:R, volatility, confidence, regime.
If the plan risks more than stated, say veto.`;

function localVerdict(plan, context) {
  const reasons = [];
  let verdict = 'agree';
  const confidence = Math.round(Number(plan.confidence ?? 0));
  const rr = Number(plan.rewardRisk ?? 0);
  if (confidence < 65) { verdict = 'cautious'; reasons.push(`confidence hanya ${confidence}%`); }
  if (rr < 1.3) { verdict = 'veto'; reasons.push(`R:R ${rr} terlalu rendah`); }
  if (context.openPositions >= 6) { verdict = 'cautious'; reasons.push('terlalu banyak position terbuka'); }
  if (context.newsRisk) { verdict = verdict === 'veto' ? 'veto' : 'cautious'; reasons.push('berita berisiko tinggi sedang aktif'); }
  if (!reasons.length) reasons.push('semua faktor utama dalam julat selamat');
  return { verdict, confidence, reasons, summary: reasons.join('; '), provider: 'local' };
}

async function callProvider(cfg, prompt, maxOutput = 500) {
  const base = String(cfg.ai?.baseUrl ?? '').replace(/\/+$/, '');
  const key = cfg.ai?.apiKey ?? '';
  if (!base || !key) return null;
  const url = /\/chat\/completions$/.test(base) ? base : `${base.replace(/\/v\d+$/, '')}/v1/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cfg.ai.model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], max_tokens: maxOutput, temperature: 0.2 }),
      signal: ac.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) return null;
    const text = body.choices?.[0]?.message?.content ?? '';
    try {
      const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
      if (!['agree', 'cautious', 'veto'].includes(parsed.verdict)) return null;
      return { ...parsed, provider: cfg.ai.provider, usage: body.usage ?? null };
    } catch { return null; }
  } catch { return null; } finally { clearTimeout(timer); }
}

export class ExpertAgent {
  constructor({ config, vault = null, logger = console } = {}) {
    this.config = config;
    this.vault = vault;
    this.logger = logger;
  }

  /** Recent anonymous lessons from the shared vault, for entry-time context. */
  recentLessons(limit = 8) {
    try {
      const notes = [...this.vault?.notes?.values() ?? []]
        .filter((n) => (n.frontmatter?.anonymous === true))
        .sort((a, b) => String(b.frontmatter?.closedAt ?? '').localeCompare(String(a.frontmatter?.closedAt ?? '')))
        .slice(0, limit);
      return notes.map((n) => ({ title: n.title, outcome: n.frontmatter?.outcome, date: n.frontmatter?.closedAt, excerpt: String(n.content ?? '').slice(0, 200) }));
    } catch { return []; }
  }

  /** Grade one analyst plan against account context. */
  async review(plan, context = {}) {
    const prompt = [
      `Symbol: ${plan.symbol} ${plan.direction ?? ''} via ${plan.playbook ?? 'unknown'}`,
      `Entry ${plan.entry} stop ${plan.stop} target ${plan.target1 ?? plan.target}`,
      `Engine confidence ${plan.confidence} R:R ${plan.rewardRisk} regime ${plan.regime ?? 'n/a'}`,
      `Account: equity ${context.equity} open positions ${context.openPositions} dayPnl ${context.dayPnl}`,
      `News risk level: ${context.newsRisk ? 'elevated' : 'normal'}`,
      ...(context.lessons?.length ? ['Recent shared lessons (anonymous): ' + context.lessons.slice(0, 4).map((l) => l.title).join('; ')] : []),
    ].join('\n');
    const remote = await callProvider(this.config, prompt);
    const verdict = remote ?? localVerdict(plan, context);
    verdict.usage = verdict.usage ?? { inTokens: Math.ceil(prompt.length / 4), outTokens: 120 };
    verdict.cost = estimateCost(this.config.ai?.model, prompt, verdict.usage.outTokens ?? 120).cost;
    return verdict;
  }

  /**
   * Goal-based planning. Honesty first: if the requested profit needs more risk
   * than the policy allows, say so instead of promising the number.
   */
  async goalPlan({ capital, target, style }) {
    const equity = Number(capital) || 0;
    const want = Number(target) || 0;
    const pct = equity > 0 ? (want / equity) * 100 : Infinity;
    const rrFloor = Number(this.config.account?.minRewardRisk ?? 1.6);
    const riskPct = Number(this.config.account?.maxRiskPerTrade ?? 0.005) * 100;
    const styleRow = { scalping: { tf: '5m', rr: 1.2, trades: 12 }, intraday: { tf: '15m', rr: 1.5, trades: 6 }, swing: { tf: '4h', rr: 2.2, trades: 2 } }[style] ?? { tf: '15m', rr: 1.5, trades: 6 };

    // Risk arithmetic, not optimism: max win per trade at policy risk.
    const riskPerTrade = equity * (riskPct / 100);
    const maxWinPerTrade = riskPerTrade * Math.max(styleRow.rr, rrFloor);
    const tradesNeeded = maxWinPerTrade > 0 ? Math.ceil(want / maxWinPerTrade) : Infinity;
    const feasible = tradesNeeded <= styleRow.trades * 2;

    return {
      ok: true,
      capital: equity,
      target: want,
      targetPctOfCapital: Number.isFinite(pct) ? Number(pct.toFixed(1)) : null,
      style: style ?? 'intraday',
      timeframe: styleRow.tf,
      suggestedTradesPerDay: styleRow.trades,
      riskPerTrade: Number(riskPerTrade.toFixed(2)),
      maxWinPerTrade: Number(maxWinPerTrade.toFixed(2)),
      tradesNeededForTarget: tradesNeeded,
      feasible,
      verdict: feasible ? 'possible_with_discipline' : 'not_realistic',
      warning: feasible
        ? null
        : `Sasaran ${want} dengan modal ${equity} memerlukan ~${tradesNeeded} trade penuh win. Ini melebihi policy risiko; sasaran realistik ialah ~${Math.floor(maxWinPerTrade * styleRow.trades)}.`,
      modes: { paper: true, live: false },
      engine: { confidenceFloor: this.config.account?.minConfidence, rrFloor, riskPct },
    };
  }
}
