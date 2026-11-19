/**
 * Execution engine.
 *
 * Owns the automated loop for a single user account:
 *   1. refresh market data for the watchlist
 *   2. analyse each symbol, produce a plan
 *   3. gate the plan through the risk engine
 *   4. open (paper or live) and then manage open positions every tick:
 *        stop-loss, take-profit, trailing stop, invalidation by regime flip
 *   5. persist everything and broadcast on the event bus
 *
 * It is deliberately boring, deterministic and defensive: an exception in one
 * symbol never stops the loop for the others, and every state change is
 * auditable. It never invents prices and never retries a rejected order.
 */
import { buildPlan, channelExit, closedBars } from '../analysis/engine.js';
import { timeframeMs } from '../market/data.js';

/**
 * A rule-based signal is valid for one entry: the bar after it closes. The
 * engine runs every minute, so without this a breakout that was stopped out
 * would be bought again on every cycle until the next bar.
 */
export function alreadyTradedSignal(plan, lastTradeAt, timeframe) {
  if (!plan?.systematic || !plan.signalTs) return false;
  return Number(lastTradeAt) >= Number(plan.signalTs) + timeframeMs(timeframe);
}
import { RiskEngine } from '../analysis/risk.js';
import * as I from '../analysis/indicators.js';
import { PaperBroker } from './paper-broker.js';

const now = () => Date.now();
const round = (v, d = 8) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

export class ExecutionEngine {
  constructor({ store, market, bus, config, broker = null, memory = null, logger = console, expert = null }) {
    this.store = store;
    this.market = market;
    this.bus = bus;
    this.config = config;
    this.broker = broker;
    this.memory = memory;
    // Optional second-opinion layer. When set and enabled, a vetoed plan is
    // blocked from auto-trade; the expert never places orders itself.
    this.expert = expert;
    // Optional callback: called with (userId, closedPositionRow) after every
    // close so the caller can record an anonymous vault lesson.
    this.onLesson = null;
    this.logger = logger;
    this.risk = new RiskEngine(config.account);
    this.running = false;
    this.timer = null;
    this.lastRun = null;
    this.lastError = null;
    this.cycle = 0;
    this.ticks = 0;
    this.cycleMs = null;
    this.activity = [];
  }

  /* ------------------------------ lifecycle ----------------------------- */

  start({ intervalMs } = {}) {
    if (this.running) return { running: true };
    this.running = true;
    const every = intervalMs ?? this.config.loop.intervalMs;
    this.bus.emit('engine', { status: 'started', intervalMs: every });
    const tick = async () => {
      if (!this.running) return;
      await this.runCycle().catch((e) => {
        this.lastError = e.message;
        this.record('error', `cycle failed: ${e.message}`);
      });
      if (this.running) this.timer = setTimeout(tick, every);
    };
    // small delay so the HTTP server is ready before the first fetch
    this.timer = setTimeout(tick, 1200);
    return { running: true, intervalMs: every };
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.bus.emit('engine', { status: 'stopped' });
    return { running: false };
  }

  status() {
    return {
      running: this.running,
      cycle: this.cycle,
      ticks: this.ticks,
      lastRun: this.lastRun,
      lastError: this.lastError,
      cycleMs: this.cycleMs,
      broker: this.broker?.id ?? 'paper',
      live: Boolean(this.config.live && this.broker),
      liveIsolation: 'owner-only until a per-licence broker account is connected',
      intervalMs: this.config.loop.intervalMs,
      timeframe: this.config.loop.timeframe,
      activity: this.activity.slice(0, 40),
    };
  }

  /** Feed one observation to the AI's memory. Never allowed to break a cycle. */
  remember(episode) {
    if (!this.memory) return;
    try {
      this.memory.record(episode);
    } catch (e) {
      this.record('warn', `memory record failed: ${e.message}`);
    }
  }

  record(level, message, meta) {
    const entry = { ts: now(), level, message, meta };
    this.activity.unshift(entry);
    if (this.activity.length > 120) this.activity.pop();
    try {
      this.store.log(level, 'engine', message, meta);
    } catch {
      /* logging must never break trading */
    }
    this.bus.emit('activity', entry);
  }

  /* -------------------------------- loop -------------------------------- */

  async runCycle({ userIds = null, force = false } = {}) {
    if (!this.running && !force && this.ticks > 0 && userIds === null) {
      // manual invocation while stopped is allowed (force)
    }
    const started = now();
    this.cycle++;
    this.ticks++;
    const users = userIds ? userIds.map((id) => this.store.getUserById(id)).filter(Boolean) : this.store.listUsers();
    const results = [];

    for (const user of users) {
      try {
        const r = await this.runForUser(user);
        results.push({ userId: user.id, ...r });
      } catch (e) {
        this.lastError = e.message;
        this.record('error', `user cycle failed: ${e.message}`, { userId: user.id });
        results.push({ userId: user.id, error: e.message });
      }
    }

    this.lastRun = now();
    this.cycleMs = this.lastRun - started;
    this.bus.emit('cycle', { cycle: this.cycle, ms: this.cycleMs, results });
    // persist equity snapshots for every user (dashboard sparklines)
    for (const user of users) this.snapshot(user.id);
    return { cycle: this.cycle, ms: this.cycleMs, results };
  }

  tradingPreferences(user) {
    try { return this.store.getSetting(user.id, 'preferences', {}) ?? {}; } catch { return {}; }
  }

  executionWatchlist(user) {
    try {
      const raw = this.store.getSetting(user.id, 'execution', null);
      const saved = raw ? JSON.parse(raw) : null;
      const mode = saved?.mode ?? 'all';
      if (mode === 'single' && saved?.symbol) return this.config.watchlist.filter((w) => w.symbol === saved.symbol);
      if (mode === 'custom' && Array.isArray(saved?.symbols)) {
        const wanted = new Set(saved.symbols);
        return this.config.watchlist.filter((w) => wanted.has(w.symbol));
      }
    } catch { /* invalid scope falls back to all */ }
    return this.config.watchlist;
  }

  async runForUser(user) {
    const watchlist = this.executionWatchlist(user);
    const timeframe = this.tradingPreferences(user).timeframe || this.config.loop.timeframe;
    const quotes = await this.refreshQuotes(watchlist, timeframe);
    const analysed = await this.analyseWatchlist(user, quotes, watchlist, timeframe);
    const opened = await this.considerEntries(user, quotes, analysed);
    const managed = await this.managePositions(user, quotes, timeframe);
    return { quotes: quotes.length, analysed: analysed.length, opened, managed };
  }

  /* ------------------------------- market ------------------------------- */

  async refreshQuotes(watchlist = this.config.watchlist, timeframe = this.config.loop.timeframe) {
    const out = [];
    for (const entry of watchlist) {
      try {
        const q = await this.market.quote(entry, timeframe);
        out.push(q);
        this.bus.emit('quote', q);
      } catch (e) {
        this.record('warn', `quote unavailable ${entry.symbol}: ${e.message}`);
      }
    }
    this.lastQuotes = out;
    return out;
  }

  async analyseWatchlist(user, quotes, watchlist = this.config.watchlist, timeframe = this.config.loop.timeframe) {
    const out = [];
    for (const entry of watchlist) {
      try {
        const candles = await this.market.candles({
          venue: entry.venue,
          symbol: entry.symbol,
          timeframe,
          limit: this.config.loop.historyBars,
        });
        const plan = buildPlan(candles, { symbol: entry.symbol, venue: entry.venue, timeframe, label: entry.label, assetClass: entry.assetClass, costs: this.paper().costs(entry) });
        const quote = quotes.find((q) => q.symbol === entry.symbol && q.venue === entry.venue);
        const enriched = { ...plan, quote: quote ?? null, candles: candles.slice(-120) };
        out.push(enriched);
        this.bus.emit('analysis', { symbol: entry.symbol, venue: entry.venue, ok: plan.ok, confidence: plan.confidence ?? null, regime: plan.regime?.regime ?? null });
        // persist only actionable, high-quality plans to keep the table readable
        if (plan.ok && plan.confidence >= this.config.account.minConfidence - 6) {
          this.persistSignal(user, plan, 'paper');
        }
      } catch (e) {
        this.record('warn', `analysis failed ${entry.symbol}: ${e.message}`);
      }
    }
    return out;
  }

  persistSignal(user, plan, mode) {
    const existing = this.store.latestSignalPerSymbol(user.id).find((s) => s.symbol === plan.symbol);
    if (existing && existing.playbook === plan.playbook && existing.direction === plan.direction && now() - existing.created_at < 20 * 60_000) {
      return existing.id;
    }
    const id = this.store.insertSignal({
      userId: user.id,
      symbol: plan.symbol,
      venue: plan.venue,
      timeframe: plan.timeframe,
      direction: plan.direction,
      confidence: plan.confidence,
      entry: plan.entry,
      stop: plan.stop,
      target1: plan.target1,
      target2: plan.target2,
      rewardRisk: plan.rewardRisk,
      regime: plan.regime?.regime,
      playbook: plan.playbook,
      rationale: plan.thesis,
      factors: plan.factors,
      invalidations: plan.invalidations,
      status: 'new',
      mode,
    });
    this.bus.emit('signal', { id, symbol: plan.symbol, direction: plan.direction, confidence: plan.confidence, playbook: plan.playbook });
    return id;
  }

  /* ------------------------------- entries ------------------------------ */

  async considerEntries(user, quotes, analysed) {
    const acc = this.accountState(user);
    if (!acc.autoTrade) {
      return { skipped: 'autotrade_disabled' };
    }
    const opened = [];
    const candidates = analysed
      .filter((p) => p.ok)
      .sort((a, b) => b.confidence - a.confidence);

    // Working state: positions opened earlier in *this* cycle must count against
    // the per-cycle limits, otherwise one sweep can open the whole watchlist.
    let openNow = [...acc.positions];
    let dayTrades = acc.dayTrades;
    const positionMap = Object.fromEntries(quotes.map((q) => [q.symbol, q.price]));

    for (const plan of candidates) {
      const quote = quotes.find((q) => q.symbol === plan.symbol && q.venue === plan.venue);
      if (!quote) continue;
      if (alreadyTradedSignal(plan, this.store.lastTradeAt(user.id, plan.symbol), plan.timeframe)) continue;
      const decision = this.risk.evaluate(plan, {
        equity: acc.equity,
        openPositions: openNow,
        dayPnl: acc.dayPnl,
        dayTrades,
        lastTradeAt: this.store.lastTradeAt(user.id, plan.symbol),
        positionMap,
      });
      this.bus.emit('risk', { symbol: plan.symbol, approved: decision.approved, reasons: decision.reasons, confidence: plan.confidence });
      if (!decision.approved) {
        if (decision.reasons.length && decision.reasons[0] !== 'position already open on this symbol') {
          this.record('info', `${plan.symbol} ${plan.playbook} blocked: ${decision.reasons.join('; ')}`);
        }
        continue;
      }

      // Expert second opinion (owner-enabled). A veto blocks auto-trade; a
      // cautious verdict records a note but lets the risk gate decide.
      if (this.expert && this.expertEnabled?.() === true) {
        try {
          const lessons = typeof this.expert.recentLessons === 'function' ? this.expert.recentLessons(6) : [];
           const verdict = await this.expert.review(plan, { equity: acc.equity, openPositions: openNow.length, dayPnl: acc.dayPnl, newsRisk: false, lessons });
          if (verdict.verdict === 'veto') {
            this.record('info', `${plan.symbol} ${plan.playbook} blocked by expert: ${(verdict.reasons ?? []).join('; ') || verdict.summary || 'veto'}`);
            this.bus.emit('risk', { symbol: plan.symbol, approved: false, reasons: ['expert veto'], confidence: plan.confidence, expert: verdict.verdict });
            continue;
          }
        } catch { /* expert outage must not break the cycle */ }
      }

      let qty = decision.sizing.qty;
      const side = plan.direction === 'long' ? 'buy' : 'sell';
      if (user.id === 'lic_owner' && acc.live && this.broker) {
        const brokerSize = await this.broker.sizeForRisk({ symbol: plan.symbol, side, entry: quote.price, stop: plan.stop, equity: acc.equity, riskPct: this.risk.policy.maxRiskPerTrade });
        if (!(brokerSize.qty > 0)) { this.record('info', `${plan.symbol} blocked: broker minimum volume exceeds risk-sized quantity`); continue; }
        qty = brokerSize.qty;
      }
      try {
        const liveRoute = Boolean(acc.live && this.broker && user.id === 'lic_owner');
        const signalId = this.persistSignal(user, plan, liveRoute ? 'live' : 'paper');
        let res;
        if (liveRoute) {
          const order = { userId: user.id, symbol: plan.symbol, side, qty, type: 'market', stop: plan.stop, target: plan.target1, signalId };
          res = typeof this.broker.placeProtected === 'function' ? await this.broker.placeProtected(order) : { ...(await this.broker.place(order)), protected: true };
          if (!res?.avgFill) throw new Error('broker did not confirm a fill; check MetaTrader');
          const record = (stop, target) =>
            this.store.insertPosition({ userId: user.id, mode: 'live', venue: this.broker.id, symbol: plan.symbol, side: plan.direction, qty: res.filledQty || qty, entry: res.avgFill, stop, target, fees: 0, signalId, brokerPositionId: res.brokerOrderId });
          if (!res.protected) {
            if (res.flattened) throw new Error(`broker did not keep the stop (${res.reason}); the position was closed at market`);
            record(null, null);
            throw new Error(`UNPROTECTED live position ${plan.symbol} ticket ${res.brokerOrderId}: the stop was not kept and closing failed (${res.closeError})`);
          }
          record(res.stop ?? plan.stop, res.target ?? plan.target1);
        } else {
          res = await this.paper().place({
            userId: user.id,
            mode: 'paper',
            venue: plan.venue,
            symbol: plan.symbol,
            side,
            qty,
            type: 'market',
            mid: quote.price,
            recentVolume: quote.volume ?? 0,
            signalId,
            stop: plan.stop,
            target: plan.target1,
          });
        }
        this.store.audit({
          userId: user.id,
          actor: 'engine',
          action: acc.live ? 'live_order_placed' : 'paper_order_placed',
          detail: { symbol: plan.symbol, side, qty, entry: quote.price, stop: plan.stop, target: plan.target1, confidence: plan.confidence, playbook: plan.playbook },
        });
        opened.push({ symbol: plan.symbol, side, qty, price: quote.price, playbook: plan.playbook });
        openNow = [...openNow, { symbol: plan.symbol, side: plan.direction, qty, entry: quote.price, stop: plan.stop, target: plan.target1 }];
        dayTrades++;
        this.record('trade', `opened ${side} ${plan.symbol} @ ${quote.price} (${plan.playbook}, ${plan.confidence}% conf)`, { qty });
        this.bus.emit('position', { action: 'open', symbol: plan.symbol, side: plan.direction, qty, price: quote.price });
        this.remember({
          kind: 'signal',
          userId: user.id,
          symbol: plan.symbol,
          summary: plan.systematic ? `${plan.name} ${plan.direction} ${plan.symbol} at ${quote.price}, stop ${plan.stop}, exit on the ${plan.exit?.bars ?? 20}-bar channel` : `${plan.name} ${plan.direction} ${plan.symbol} at ${quote.price} — ${plan.confidence}% confidence, ${plan.rewardRisk}R, ${plan.regime?.label ?? 'unknown regime'}`,
          tags: [plan.playbook, plan.regime?.regime, plan.direction].filter(Boolean),
          detail: { playbook: plan.playbook, confidence: plan.confidence, entry: quote.price, stop: plan.stop, target: plan.target1, regime: plan.regime?.regime },
          importance: Math.min(1, plan.confidence / 100 + 0.2),
        });
      } catch (e) {
        this.record('error', `order failed ${plan.symbol}: ${e.message}`);
      }
    }
    return opened;
  }

  /* ------------------------------- management --------------------------- */

  async managePositions(user, quotes, timeframe = this.config.loop.timeframe) {
    const positions = this.store.openPositions(user.id);
    const closed = [];
    // Detect closes made outside the app (manual TP/close in MetaTrader): a
    // live position that no longer exists on the broker is reconciled and
    // recorded as an anonymous vault lesson like any other close.
    const livePositions = positions.filter((p) => p.mode === 'live' && this.broker?.configured);
    if (livePositions.length && typeof this.broker.positions === 'function') {
      try {
        const remote = await this.broker.positions();
        const rows = Array.isArray(remote) ? remote : (remote.positions ?? []);
        const remoteTickets = new Set(rows.map((r) => String(r.ticket ?? r.position ?? r.id ?? '')));
        for (const pos of livePositions) {
          const ticket = String(pos.broker_position_id ?? '');
          if (ticket && remoteTickets.size && !remoteTickets.has(ticket)) {
            const quote = quotes.find((q) => q.symbol === pos.symbol);
            const exitPrice = Number(quote?.price ?? pos.entry);
            const pnl = pos.side === 'long' ? (exitPrice - pos.entry) * pos.qty : (pos.entry - exitPrice) * pos.qty;
            this.store.updatePosition(pos.id, { status: 'closed', exitPrice, pnl: round(pnl, 8), closedAt: now(), closeReason: 'closed_at_broker' });
            this.store.addRealized(user.id, pnl, 0);
            this.record('info', `${pos.symbol} was closed in MetaTrader — reconciled (PnL ${round(pnl, 2)})`);
            this.onLesson?.(user.id, this.store.position(user.id, pos.id));
            closed.push({ symbol: pos.symbol, reason: 'closed_at_broker', pnl });
          }
        }
      } catch (e) {
        this.record('warn', `broker reconcile failed: ${e.message}`);
      }
    }
    for (const pos of positions) {
      const quote = quotes.find((q) => q.symbol === pos.symbol);
      if (!quote) continue;
      const price = quote.price;
      let exit = null;

      if (pos.stop && (pos.side === 'long' ? price <= pos.stop : price >= pos.stop)) exit = 'stop_loss';
      else if (pos.target && (pos.side === 'long' ? price >= pos.target : price <= pos.target)) exit = 'take_profit';

      // Trend-following positions leave on the channel, judged on closed bars
      // exactly as the backtester judges them; no regime cut, no break-even.
      const playbook = pos.signal_id ? this.store.get('SELECT playbook FROM signals WHERE id = ?', pos.signal_id)?.playbook : null;
      if (!exit && playbook === 'donchian_breakout') {
        try {
          const candles = await this.market.candles({ venue: quote.venue, symbol: pos.symbol, timeframe, limit: 120 });
          if (channelExit(pos.side, closedBars(candles, timeframe), 20)) exit = 'channel_exit';
        } catch {
          /* no data: hold, the broker stop still protects */
        }
        if (!exit) continue;
      }

      // Regime invalidation: if the analysed regime flipped hard against us, cut.
      if (!exit) {
        try {
          const candles = await this.market.candles({ venue: pos.venue === 'paper' ? quote.venue : quote.venue, symbol: pos.symbol, timeframe, limit: 200 });
          const snap = I.snapshot(candles);
          const flip = pos.side === 'long' ? snap.ema21 < snap.ema50 && price < snap.ema50 && (snap.adx ?? 0) > 30 : snap.ema21 > snap.ema50 && price > snap.ema50 && (snap.adx ?? 0) > 30;
          if (flip) exit = 'regime_invalidation';
          // trailing stop once 1R is banked
          const next = this.risk.manageStop(pos, price, snap.atr);
          let held = true;
          if (next && pos.mode === 'live' && this.broker?.modifyProtection) {
            // A trailing stop only protects if the broker holds it.
            try {
              await this.broker.modifyProtection({ positionId: pos.broker_position_id, symbol: pos.symbol, stop: next });
            } catch (e) {
              held = false;
              this.record('warn', `could not trail ${pos.symbol} at the broker: ${e.message}`);
            }
          }
          if (next && held) {
            this.store.updatePosition(pos.id, { stop: next });
            this.record('info', `trailing stop ${pos.symbol} → ${next}`);
            this.bus.emit('position', { action: 'trail', symbol: pos.symbol, stop: next });
          }
        } catch {
          /* if data is unavailable we hold and retry next tick */
        }
      }

      if (!exit) continue;

      try {
        let res;
        if (pos.mode === 'live' && this.broker) {
          res = await this.broker.close({ symbol: pos.symbol, qty: pos.qty, side: pos.side, positionId: pos.broker_position_id });
          const pnl = pos.side === 'long' ? (price - pos.entry) * pos.qty : (pos.entry - price) * pos.qty;
          this.store.updatePosition(pos.id, { status: 'closed', exitPrice: price, pnl: round(pnl, 8), closedAt: now(), closeReason: exit });
          this.store.addRealized(user.id, pnl, 0);
          this.store.audit({ userId: user.id, actor: 'engine', action: 'live_position_closed', detail: { symbol: pos.symbol, reason: exit, price } });
        } else {
          res = await this.paper().close({ userId: user.id, position: pos, price, reason: exit, recentVolume: quote.volume ?? 0 });
        }
        closed.push({ symbol: pos.symbol, reason: exit, pnl: res.pnl, price: res.exitPrice ?? price });
        this.record(res.pnl >= 0 ? 'trade' : 'trade', `closed ${pos.symbol} (${exit}) PnL ${round(res.pnl, 2)}`);
        this.bus.emit('position', { action: 'close', symbol: pos.symbol, reason: exit, pnl: res.pnl });
        this.remember({
          kind: 'trade',
          userId: user.id,
          symbol: pos.symbol,
          summary: `Closed ${pos.side} ${pos.symbol} via ${String(exit).replace(/_/g, ' ')} for ${round(res.pnl, 2)} (${round(((res.exitPrice ?? price) - pos.entry) / Math.abs(pos.entry - (pos.stop ?? pos.entry)), 2)}R)`,
          tags: [pos.side, exit, res.pnl >= 0 ? 'win' : 'loss'].filter(Boolean),
          detail: { side: pos.side, entry: pos.entry, exit: res.exitPrice ?? price, pnl: res.pnl, reason: exit },
          importance: res.pnl >= 0 ? 0.8 : 0.9,
        });
        this.store.audit({ userId: user.id, actor: 'engine', action: 'position_closed', detail: { symbol: pos.symbol, reason: exit, pnl: res.pnl } });
        this.onLesson?.(user.id, this.store.position(user.id, pos.id));
      } catch (e) {
        this.record('error', `close failed ${pos.symbol}: ${e.message}`);
      }
    }
    return closed;
  }

  async atrFor(position, quote, timeframe = this.config.loop.timeframe) {
    try {
      const candles = await this.market.candles({ venue: quote.venue, symbol: position.symbol, timeframe, limit: 120 });
      return I.snapshot(candles).atr;
    } catch {
      return Math.abs(position.entry * 0.01);
    }
  }

  /* -------------------------------- state ------------------------------- */

  paper() {
    if (!this._paper) this._paper = new PaperBroker({ store: this.store, config: this.config });
    return this._paper;
  }

  accountState(user) {
    const acc = this.store.account(user.id) ?? { starting_equity: this.config.account.startingEquity, realized_pnl: 0, day_pnl: 0 };
    const positions = this.store.openPositions(user.id);
    const quotes = this.lastQuotes ?? [];
    const unrealised = positions.reduce((a, p) => {
      const q = quotes.find((x) => x.symbol === p.symbol);
      if (!q) return a;
      return a + (p.side === 'long' ? q.price - p.entry : p.entry - q.price) * p.qty;
    }, 0);
    const equity = acc.starting_equity + (acc.realized_pnl ?? 0) + unrealised;
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const dayTrades = this.store.get('SELECT COUNT(*) c FROM orders WHERE user_id = ? AND created_at >= ?', user.id, day.getTime())?.c ?? 0;
    return {
      equity,
      balance: acc.starting_equity + (acc.realized_pnl ?? 0),
      positions,
      dayPnl: acc.day_pnl ?? 0,
      dayTrades,
      autoTrade: this.store.getSetting(user.id, 'autoTrade', true),
      live: Boolean(acc.live_enabled && this.config.live && this.broker),
    };
  }

  snapshot(userId) {
    const user = this.store.getUserById(userId);
    if (!user) return;
    const acc = this.accountState(user);
    this.store.ensureDay(userId, acc.equity);
    this.store.snapshotEquity(userId, acc.equity, acc.balance);
    this.bus.emit('equity', { userId, equity: acc.equity, balance: acc.balance, dayPnl: acc.dayPnl });
  }
}

