/**
 * Continuous market watcher — the cheap always-on reading loop.
 *
 * Runs an interval timer that feeds compact chart summaries and headlines to a
 * low-cost model (e.g. DeepSeek Flash) and stores a rolling digest per user.
 * A hard token budget per hour stops a runaway loop before it becomes an
 * invoice: once the budget is spent, the watcher pauses until the next window.
 *
 * It only produces notes and flags; it never trades and never changes settings.
 */
const NOTE_LIMIT = 200;

export class MarketWatcher {
  constructor({ config, market, store, logger = console } = {}) {
    this.config = config;
    this.market = market;
    this.store = store;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.notes = [];
    // Budget: tokens used within the current hour window.
    this.budget = { tokens: 0, windowStart: Date.now(), capPerHour: Number(config.watcher?.tokensPerHour ?? 1_000_000) };
  }

  status() {
    return {
      running: this.running,
      model: this.config.watcher?.model ?? null,
      provider: this.config.watcher?.provider ?? 'none',
      intervalMs: this.config.watcher?.intervalMs ?? 0,
      tokensUsedThisHour: this.budget.tokens,
      capPerHour: this.budget.capPerHour,
      pausedByBudget: this.budget.tokens >= this.budget.capPerHour,
      notes: this.notes.length,
    };
  }

  start() {
    if (this.running || !this.config.watcher?.model) return { running: false, reason: 'watcher model not configured' };
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.cycle().catch((e) => this.logger.warn?.(`[watcher] ${e.message}`));
      if (this.running) this.timer = setTimeout(tick, this.config.watcher.intervalMs ?? 120_000);
    };
    this.timer = setTimeout(tick, 2000);
    return { running: true };
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return { running: false };
  }

  addNote(note) {
    this.notes.unshift({ ...note, ts: Date.now() });
    if (this.notes.length > NOTE_LIMIT) this.notes.length = NOTE_LIMIT;
  }

  async cycle() {
    // Reset the hourly budget window.
    if (Date.now() - this.budget.windowStart >= 3_600_000) {
      this.budget = { ...this.budget, tokens: 0, windowStart: Date.now() };
    }
    if (this.budget.tokens >= this.budget.capPerHour) {
      this.addNote({ level: 'budget', message: `Token budget habis (${this.budget.capPerHour}/jam) — watcher berhenti sehingga window baru.` });
      return { paused: true };
    }

    const symbols = (this.config.watchlist ?? []).slice(0, 6);
    const summary = [];
    for (const entry of symbols) {
      try {
        const candles = await this.market.candles({ venue: entry.venue, symbol: entry.symbol, timeframe: this.config.watcher?.timeframe ?? '15m', limit: 60 });
        if (!candles.length) continue;
        const first = candles[0].close;
        const last = candles.at(-1).close;
        const hi = Math.max(...candles.map((c) => c.high));
        const lo = Math.min(...candles.map((c) => c.low));
        const vol = candles.reduce((a, c) => a + (c.volume ?? 0), 0);
        summary.push(`${entry.symbol}: last=${last} change=${(((last - first) / first) * 100).toFixed(2)}% hi=${hi} lo=${lo} vol=${vol}`);
      } catch { /* one symbol failing must not stop the sweep */ }
    }
    const prompt = [
      'Baca ringkasan pasar ini. Jawab JSON {"marketRead":"...","flags":["..."],"volatility":"low|normal|high"}',
      ...summary,
    ].join('\n');

    const base = String(this.config.watcher.baseUrl ?? this.config.ai?.baseUrl ?? '').replace(/\/+$/, '');
    const key = this.config.watcher.apiKey ?? this.config.ai?.apiKey ?? '';
    const model = this.config.watcher.model;
    let read = null;
    if (base && key && model) {
      const url = /\/chat\/completions$/.test(base) ? base : `${base.replace(/\/v\d+$/, '')}/v1/chat/completions`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 45_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 300, temperature: 0.1 }),
          signal: ac.signal,
        });
        const body = await res.json().catch(() => null);
        const text = body?.choices?.[0]?.message?.content ?? '';
        read = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? 'null');
        const used = Number(body?.usage?.total_tokens ?? Math.ceil(prompt.length / 4));
        this.budget.tokens += used;
      } catch (e) {
        this.addNote({ level: 'error', message: `watcher read gagal: ${e.message}` });
      } finally { clearTimeout(timer); }
    }
    if (read) this.addNote({ level: 'read', ...read, symbols: summary.length });
    return { ok: true, read, tokens: this.budget.tokens };
  }
}
