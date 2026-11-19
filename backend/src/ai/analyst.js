/**
 * The analyst.
 *
 * Two modes, and the UI always shows which one is active:
 *
 *  local  (default) — a deterministic, template-driven reasoner that reads the
 *                     engine's own factor table and turns it into prose. No
 *                     network, no key, no pretence: the label says
 *                     "local reasoning engine".
 *  claude (opt-in)  — if LUMINA_AI_KEY is set, the structured plan is sent to
 *                     the Anthropic Messages API and the reply is stored with
 *                     the provider name attached.
 *
 * The local path exists because a trading system must never fail to explain
 * itself just because an API key is missing or a vendor is down.
 */
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? 'n/a' : Number(v).toFixed(d));

export class Analyst {
  constructor({ config, market, memory = null, logger = console }) {
    this.config = config;
    this.market = market;
    this.memory = memory;
    this.logger = logger;
  }

  get mode() {
    return this.config.ai.provider === 'claude' && this.config.ai.apiKey ? 'claude' : 'local';
  }

  get providerLabel() {
    return this.mode === 'claude' ? `Anthropic · ${this.config.ai.model}` : 'Local reasoning engine';
  }

  /** Turn a plan into a readable, evidence-first briefing. */
  explainPlan(plan, quote) {
    if (!plan || !plan.ok) {
      return {
        mode: this.mode,
        provider: this.providerLabel,
        headline: 'No actionable setup',
        body: [
          `**Why nothing fired:** ${humanReason(plan?.reason)} on ${plan?.symbol ?? 'this instrument'}.`,
          plan?.regime ? `The tape is reading as **${plan.regime.label.toLowerCase()}** (ADX ${fmt(plan.regime.adx, 1)}, efficiency ${fmt(plan.regime.efficiency, 2)}).` : '',
          'The engine only acts when a playbook fires *and* the risk gate approves. Standing aside is a position.',
        ].filter(Boolean),
        factors: [],
        confidence: 0,
      };
    }

    const top = [...plan.factors].sort((a, b) => b.points - a.points).slice(0, 4);
    const weak = [...plan.factors].sort((a, b) => a.strength - b.strength).slice(0, 2);
    const risk = Math.abs(plan.entry - plan.stop);
    const riskPct = (risk / plan.entry) * 100;

    const body = [
      `**${plan.name}** on ${plan.label ?? plan.symbol}, ${plan.timeframe}. The regime is **${plan.regime.label.toLowerCase()}** (ADX ${fmt(plan.regime.adx, 1)}), which is the only reason this playbook is allowed to fire.`,
      `Entry **${fmt(plan.entry)}**, invalidation **${fmt(plan.stop)}** (${fmt(riskPct)}% away, ${fmt(risk / (plan.snapshot?.atr || risk), 2)}× ATR), first target **${fmt(plan.target1)}** at ${fmt(plan.rewardRisk)}R.`,
      `The strongest evidence: ${top.map((f) => `${f.label.toLowerCase()} — ${f.note}`).join('; ')}.`,
      `What is least convincing: ${weak.map((f) => `${f.label.toLowerCase()} (${Math.round(f.strength * 100)}% strength)`).join(' and ')}. Size accordingly; the risk engine has already capped this at 0.5% of equity.`,
      `**What kills this plan:** ${plan.invalidations.join(' · ')}`,
    ];

    return {
      mode: this.mode,
      provider: this.providerLabel,
      headline: `${plan.direction === 'long' ? 'Long' : 'Short'} ${plan.label ?? plan.symbol} · ${plan.name} · ${fmt(plan.confidence, 0)}% confidence`,
      body,
      factors: plan.factors,
      confidence: plan.confidence,
    };
  }

  /** Answer a free-form question with the current market context attached. */
  async ask({ question, plans = [], positions = [], risk = null, history = [], userId = null, news = [] }) {
    const context = this.buildContext(plans, positions, risk, news);
    // Retrieval: pull what the vault and episodic memory already know about this
    // question, so an answer improves as the vault grows rather than starting
    // from nothing every time.
    if (this.memory) {
      try {
        const symbols = plans.filter((p) => p.ok).map((p) => p.symbol);
        context.memory = this.memory.recall({ query: question, symbol: null, limit: 8 });
        if (symbols.length) {
          context.memory.bySymbol = Object.fromEntries(symbols.map((s) => [s, this.memory.recent({ symbol: s, limit: 4 }).map((e) => e.summary)]));
        }
        if (userId) context.memory.profile = this.memory.profile(userId);
      } catch (e) {
        this.logger.warn?.(`[analyst] memory recall failed: ${e.message}`);
      }
    }
    if (this.mode === 'claude') {
      try {
        return await this.askClaude({ question, context, history });
      } catch (e) {
        this.logger.warn?.(`[analyst] claude failed, falling back to local: ${e.message}`);
        return { ...this.askLocal({ question, context }), notice: `Claude unavailable (${e.message}) — answered locally.` };
      }
    }
    // Any OpenAI-compatible provider configured by the owner (DeepSeek, OpenRouter,
    // Groq, OpenAI…) gets the full grounded snapshot — never the canned local lines —
    // so answers are consistent and specific to the account.
    if (this.config.ai?.apiKey && this.config.ai?.baseUrl && !/anthropic/i.test(this.config.ai.baseUrl)) {
      const { chat } = await import('./providers.js');
      const result = await chat({
        baseUrl: this.config.ai.baseUrl,
        apiKey: this.config.ai.apiKey,
        model: this.config.ai.model ?? 'deepseek-chat',
        system: [
          'You are the LuminaVantage assistant inside a trading terminal.',
          'You answer from the JSON snapshot of the live engine: plans, positions, risk, licence.',
          'Rules: answer in the user\'s language (usually Malay), be concise, cite the snapshot\'s real numbers, never invent prices or trades, never promise returns.',
          'If the user asks to remove/modify the watchlist or any setting, explain that watchlist changes happen in Market Watch and settings in Settings — you are read-only.',
          'If the snapshot does not contain the answer, say so plainly and suggest where to look in the app.',
        ].join(' '),
        messages: [
          ...history.slice(-6).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
          { role: 'user', content: `Soalan: ${question}\n\nLive engine snapshot:\n${JSON.stringify(context, null, 1)}` },
        ],
        maxOutputTokens: 700,
      });
      if (result.ok) {
        return { mode: 'openai-compatible', provider: this.providerLabel, answer: result.answer, context, usage: result.usage ?? null };
      }
      this.logger.warn?.(`[analyst] provider failed, falling back to local: ${result.error}`);
      return { ...this.askLocal({ question, context }), notice: `Provider unavailable (${result.error}) — answered locally.` };
    }
    return this.askLocal({ question, context });
  }

  buildContext(plans, positions, risk, news = []) {
    const live = plans
      .filter((p) => p.ok)
      .slice(0, 6)
      .map((p) => ({
        symbol: p.symbol,
        timeframe: p.timeframe,
        regime: p.regime?.label,
        playbook: p.playbook,
        direction: p.direction,
        confidence: p.confidence,
        entry: p.entry,
        stop: p.stop,
        target1: p.target1,
        rewardRisk: p.rewardRisk,
        price: p.snapshot?.price,
        rsi: p.snapshot?.rsi,
        adx: p.snapshot?.adx,
        thesis: p.thesis,
        invalidations: p.invalidations,
      }));
    return {
      generatedAt: new Date().toISOString(),
      plans: live,
      // Headlines the model is allowed to reason over. They are evidence, not
      // instructions: a headline is quoted, never obeyed.
      news: (Array.isArray(news) ? news : []).slice(0, 12).map((n) => ({
        title: n.title,
        summary: n.summary,
        source: n.source,
        at: n.ts,
      })),
      openPositions: positions.map((p) => ({ symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, stop: p.stop, target: p.target })),
      risk,
    };
  }

  askLocal({ question, context }) {
    const q = String(question || '').toLowerCase();
    const plans = context.plans ?? [];
    const lines = [];

    const wants = (words) => words.some((w) => q.includes(w));

    if (!plans.length) {
      lines.push('Nothing is actionable on the current watchlist. Every instrument is either mid-range, too compressed for a clean stop, or blocked by the risk gate.');
    } else if (wants(['best', 'strongest', 'top', 'which'])) {
      const best = [...plans].sort((a, b) => b.confidence - a.confidence)[0];
      lines.push(`The highest-conviction setup right now is **${best.symbol}** — ${best.playbook} (${best.confidence}% confidence) inside a ${String(best.regime).toLowerCase()}.`);
      lines.push(`Entry ${fmt(best.entry)}, stop ${fmt(best.stop)}, first target ${fmt(best.target1)} (${fmt(best.rewardRisk)}R). ${best.thesis}`);
      lines.push(`It dies if: ${best.invalidations.join(' · ')}.`);
    }

    if (wants(['risk', 'size', 'position', 'exposure', 'leverage'])) {
      const r = context.risk;
      if (r) {
        lines.push(`Open risk is ${fmt(r.openRiskPct)}% of equity (${fmt(r.openRisk)} notional-to-stop), day P&L ${fmt(r.dayPnl)} (${fmt(r.dayPnlPct)}%), leverage used ${fmt(r.leverageUsed)}× of ${r.limits?.maxLeverage}×.`);
        lines.push(`Per-trade risk is capped at ${r.limits?.maxRiskPerTradePct}% and the day stops at ${r.limits?.maxDailyLossPct}%. Position size is always derived from the stop distance, never from confidence.`);
      } else {
        lines.push('No risk snapshot available yet — the engine has not completed a cycle.');
      }
    }

    if (wants(['why', 'explain', 'confidence', 'reason'])) {
      for (const p of plans.slice(0, 2)) {
        lines.push(`**${p.symbol}** scored ${p.confidence}%: regime ${p.regime}, RSI ${fmt(p.rsi, 1)}, ADX ${fmt(p.adx, 1)}, ${fmt(p.rewardRisk)}R to the first target. ${p.thesis}`);
      }
    }

    if (wants(['invalid', 'stop', 'exit', 'wrong'])) {
      lines.push('Invalidation is structural, not a feeling: ' + plans.slice(0, 3).map((p) => `${p.symbol} → ${p.invalidations[0]}`).join(' · ') + '.');
    }

    if (wants(['regime', 'trend', 'market', 'structure'])) {
      const byRegime = new Map();
      for (const p of plans) byRegime.set(p.regime, (byRegime.get(p.regime) ?? 0) + 1);
      lines.push(`Current regime spread across the watchlist: ${[...byRegime.entries()].map(([k, v]) => `${k} (${v})`).join(', ')}.`);
      lines.push('The engine only runs playbooks that the regime allows — a range playbook cannot fire in an established trend, which is why some symbols stay quiet.');
    }

    if (context.openPositions?.length) {
      lines.push(`Open: ${context.openPositions.map((p) => `${p.side} ${p.symbol} @ ${fmt(p.entry)}`).join(', ')}.`);
    }

    // Use the vault: if the question is one memory has an answer to, say so
    // before falling back to generic guidance.
    const mem = context.memory;
    if (mem) {
      const wantsHistory = wants(['before', 'last time', 'history', 'remember', 'past', 'learn', 'previous', 'seen']);
      if (wantsHistory && mem.notes?.length) {
        lines.push(`From the vault (${mem.notes.length} match${mem.notes.length === 1 ? '' : 'es'}):`);
        for (const n of mem.notes.slice(0, 4)) {
          lines.push(`• **${n.title}** — ${n.excerpt ?? 'linked note'}`);
        }
      }
      const sym = plans.length ? plans[0].symbol : null;
      const recentForSymbol = sym ? mem.bySymbol?.[sym] : null;
      if (recentForSymbol?.length) {
        lines.push(`What happened on **${sym}** recently: ${recentForSymbol.slice(0, 3).join(' · ')}.`);
      }
      if ((wantsHistory || mem.notes?.length) && mem.episodes?.length) {
        const top = mem.episodes.slice(0, 3).map((e) => `${e.kind} — ${e.summary}`);
        lines.push(`Memory context: ${top.join(' · ')}.`);
      }
    }

    if (lines.length === 0) {
      lines.push('Here is the current picture, in the order the engine ranks it:');
      for (const p of plans.slice(0, 4)) {
        lines.push(`• **${p.symbol}** ${p.direction} via ${p.playbook} — ${p.confidence}% confidence, ${fmt(p.rewardRisk)}R, regime ${String(p.regime).toLowerCase()}.`);
      }
      lines.push('Ask about a specific symbol, the risk budget, or why a setup is or is not valid.');
    }

    return {
      mode: 'local',
      provider: 'Local reasoning engine',
      answer: lines.join('\n\n'),
      context,
    };
  }

  async askClaude({ question, context, history }) {
    const system = [
      'You are the market-intelligence analyst inside a trading terminal.',
      'You receive a JSON snapshot of live plans produced by a deterministic strategy engine.',
      'Rules: be concise (max 220 words), cite the actual numbers from the snapshot, never invent prices or indicators, never promise returns, and always state what would invalidate a view.',
      'Trading knowledge: explain market structure, support/resistance, trend vs range, VWAP, RSI/MACD/EMA, ATR, breakouts, liquidity sweeps, risk-based position sizing, stop-loss placement, reward-to-risk, leverage, spread and slippage. Every actionable view must include a stop-loss, invalidation and risk warning.',
      'If the user asks for the best market, rank only the supplied active Market Watch plans by confidence and reward/risk; never invent an unavailable symbol. If the snapshot does not contain the answer, say so plainly.',
      'Use markdown sparingly (bold and bullets only).',
    ].join(' ');

    const messages = [
      ...history.slice(-6).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
      { role: 'user', content: `Question: ${question}\n\nLive engine snapshot:\n${JSON.stringify(context, null, 1)}` },
    ];

    const res = await fetch(`${this.config.ai.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.ai.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: this.config.ai.model, max_tokens: 900, system, messages }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new Error('empty response');
    return { mode: 'claude', provider: this.providerLabel, answer: text, context, usage: json.usage ?? null };
  }
}

function humanReason(reason) {
  const map = {
    insufficient_history: 'there is not enough clean history to compute a stable reading',
    no_setup: 'no playbook fired with acceptable geometry',
    no_plan: 'no plan was produced',
    stale_data: 'the venue returned stale data',
  };
  return map[reason] ?? 'the pre-trade gate rejected it';
}
