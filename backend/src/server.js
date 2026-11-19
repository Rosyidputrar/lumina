/**
 * Entrypoint. Wires the store, market data, broker, execution engine, analyst
 * and HTTP app together, then starts the automated loop if enabled.
 *
 * Run:  node src/server.js
 * Env:  see README.md / src/config.js
 */
import { config, DEV_LICENSE_SECRET } from './config.js';
import crypto from 'node:crypto';
import { Store } from './store.js';
import { EventBus } from './bus.js';
import { MarketData, providers as cryptoProviders, mt5Provider } from './market/data.js';
import { ExecutionEngine } from './execution/engine.js';
import { Analyst } from './ai/analyst.js';
import { ExpertAgent } from './ai/expert-agent.js';
import { MarketWatcher } from './ai/watcher.js';
import { Backtester } from './analysis/backtest.js';
import { createBroker } from './execution/exchanges.js';
import { createApp } from './app.js';
import { Vault } from './vault/vault.js';
import { Memory } from './vault/memory.js';
import { FileStore } from './files/store.js';
import { Licensing } from './licensing/licence.js';
import { Mt5Broker } from './execution/mt5-broker.js';

export async function bootstrap(overrides = {}) {
  const cfg = { ...config, ...overrides };
  // Fail closed: with the published development secret anyone can mint licence keys.
  if (cfg.licence.secret === DEV_LICENSE_SECRET) {
    if (cfg.env === 'production') throw new Error('LUMINA_LICENSE_SECRET must be set in production (32+ random characters)');
    console.warn('  warning     LUMINA_LICENSE_SECRET is not set; using the development secret. Never deploy like this.');
  }
  const store = new Store(cfg.dbFile);
  const bus = new EventBus();
  let broker = createBroker(cfg);
  // MT5 is the data source for forex, metals and indices. The crypto venues stay
  // registered so nothing that already works breaks, but a watchlist entry names
  // its venue explicitly and is never re-routed.
  const providerMap = { ...cryptoProviders };
  if (cfg.mt5?.baseUrl && cfg.mt5?.apiKey) {
    const { Mt5Broker } = await import('./execution/mt5-broker.js');
    providerMap.mt5 = mt5Provider({ broker: new Mt5Broker(cfg.mt5) });
  }
  const market = new MarketData({ providersMap: providerMap });
  const vault = new Vault(cfg.vault);
  const memory = new Memory({ vault, maxEpisodes: cfg.memory.maxEpisodes });
  seedVault(vault, cfg);
  const files = cfg.files?.enabled ? new FileStore({ store, root: cfg.files.root, maxBytes: cfg.files.maxBytes, r2: cfg.files.r2, logger: console }) : null;
  const licensing = new Licensing({ store, secret: cfg.licence.secret, adminSecret: cfg.licence.ownerSecret });
  const analyst = new Analyst({ config: cfg, market, memory });
  const expert = new ExpertAgent({ config: cfg, vault });
  const watcher = new MarketWatcher({ config: cfg, market, store });
  if (cfg.watcher?.model) watcher.start();
  // Expert gating reads the owner's live toggle from the agents settings.
  expert.expertEnabled = () => {
    try { return JSON.parse(store.getSetting('__owner__', 'agents', null) ?? 'null')?.expertEnabled === true; } catch { return false; }
  };
  const engine = new ExecutionEngine({ store, market, bus, config: cfg, broker, memory, expert });
  engine.onLesson = (userId, row) => recordVaultLesson(userId, row);
  const backtester = new Backtester({ config: cfg });
  // Settings saved from the console override the environment, so a change there
  // survives a restart. This must happen before createApp reads config.ai.
  try {
    const saved = store.getSetting('__owner__', 'ai', null);
    const savedStyle = store.getSetting('__owner__', 'style', null);
    if (savedStyle) {
      const preset = { scalping: { tf: '5m', rr: 1.2, conf: 58, cd: 5, cap: 60 }, intraday: { tf: '15m', rr: 1.5, conf: 60, cd: 15, cap: 24 }, swing: { tf: '4h', rr: 2.2, conf: 66, cd: 240, cap: 6 } }[savedStyle];
      if (preset) {
        cfg.loop.timeframe = preset.tf;
        cfg.account.minRewardRisk = preset.rr;
        cfg.account.minConfidence = preset.conf;
        cfg.account.cooldownMinutes = preset.cd;
        cfg.account.dailyTradeCap = preset.cap;
      }
    }
    const { setStrategy } = await import('./analysis/engine.js');
    const savedStrategy = store.getSetting('__owner__', 'strategy', null);
    setStrategy(savedStrategy === 'classic' || savedStrategy === 'trend' ? savedStrategy : cfg.strategy);
    const savedRisk = store.getSetting('__owner__', 'risk', null);
    if (savedRisk) {
      const limits = JSON.parse(savedRisk);
      const map = { maxRiskPerTradePct: ['maxRiskPerTrade', 0.01], maxDailyLossPct: ['maxDailyLoss', 0.01], maxPortfolioHeatPct: ['maxPortfolioHeat', 0.01], maxOpenPositions: ['maxOpenPositions', 1], maxEntriesPerSymbol: ['maxEntriesPerSymbol', 1], maxLeverage: ['maxLeverage', 1], dailyTradeCap: ['dailyTradeCap', 1], cooldownMinutes: ['cooldownMinutes', 1], minConfidence: ['minConfidence', 1], minRewardRisk: ['minRewardRisk', 1] };
      for (const [name, [key, scale]] of Object.entries(map)) {
        const v = Number(limits[name]);
        if (Number.isFinite(v)) cfg.account[key] = Number((v * scale).toFixed(8));
      }
    }
    const savedMarkets = store.getSetting('__owner__', 'markets', null);
    if (savedMarkets) {
      const list = JSON.parse(savedMarkets);
      if (Array.isArray(list) && list.length) cfg.watchlist = list;
    }
    if (saved) {
      const ai = JSON.parse(saved);
      if (ai.baseUrl !== undefined) cfg.ai.baseUrl = ai.baseUrl;
      if (ai.model !== undefined) cfg.ai.model = ai.model;
      if (ai.apiKey !== undefined) cfg.ai.apiKey = ai.apiKey;
      if (ai.provider !== undefined) cfg.ai.provider = ai.provider;
    }
  } catch {
    /* a corrupt setting must not stop the server booting */
  }
  /**
   * Active-account routing. When the owner has provisioned AND activated an MT5
   * account from the registry, the engine trades through THAT account's gateway.
   * Falls back to the bootstrap env gateway when nothing is activated.
   */
  function decryptGatewayKey(encrypted) {
    try {
      const secret = String(cfg.credentialSecret ?? '');
      if (!encrypted || secret.length < 32) return null;
      const raw = JSON.parse(String(encrypted));
      const keyHash = crypto.createHash('sha256').update(secret).digest();
      const decipher = crypto.createDecipheriv('aes-256-gcm', keyHash, Buffer.from(raw.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(raw.tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64url')), decipher.final()]).toString('utf8');
    } catch { return null; }
  }
  function activeMt5Config() {
    try {
      const activeId = store.getSetting('owner', 'active_mt5_account', null);
      if (!activeId) return null;
      const account = (store.getSetting('owner', 'mt5_accounts', []) ?? []).find((a) => a.id === activeId);
      if (!account || account.status !== 'connected') return null;
      // Gateway credentials come from the provisioner response (gateway.url + key
      // recorded at provision time), stored encrypted with the account.
      const gw = account.gateway ?? {};
      if (!gw.url) return null;
      // The provisioner sets the gateway's API_KEY to the MT5 password we sent,
      // so the gateway key is the (encrypted) account secret itself.
      const key = decryptGatewayKey(account.secret);
      if (!key) return null;
      return { baseUrl: gw.url, apiKey: key, demo: cfg.mt5?.demo ?? true, login: account.login, server: account.server, label: account.label };
    } catch { return null; }
  }
  function applyActiveBroker() {
    const cfgA = activeMt5Config();
    if (!cfgA) return null;
    const active = new Mt5Broker(cfgA);
    engine.broker = active;
    broker = active;
    return cfgA;
  }
  applyActiveBroker();

  const { server, terminalState } = createApp({ store, market, bus, engine, analyst, expert, watcher, config: cfg, backtester, broker, vault, memory, files, licensing });

  return { cfg, store, bus, market, engine, analyst, expert, watcher, backtester, broker, server, terminalState, vault, memory, files, licensing };
}

/**
 * Bootstrap vault content.
 *
 * A trading terminal's knowledge starts as vocabulary: what each playbook means,
 * what the risk limits are, how position size is derived. Seeding these as
 * linked concept notes means every record the engine later writes has somewhere
 * to attach, so the graph is navigable from the first cycle rather than a cloud
 * of orphans.
 */
function seedVault(vault, cfg) {
  const seeds = [
    ['Concepts/Risk Engine', 'Risk Engine', ['concept', 'risk'], 'Position size is derived from the stop distance, never from conviction. Per-trade risk is a fixed fraction of equity, so a wider stop produces a smaller position. Sizing is implemented by [[Position Sizing]] and enforced before every entry; see [[Confidence Scoring]] for why conviction never overrides it.'],
    ['Concepts/Position Sizing', 'Position Sizing', ['concept', 'risk'], 'size = (equity × maxRiskPerTrade) ÷ |entry − stop|, capped by notional and leverage. See [[Risk Engine]]. Playbooks produce the stop; see [[Trend Pullback]] and [[Liquidity Sweep Reversal]] for how it is placed.'],
    ['Concepts/Regime Detection', 'Regime Detection', ['concept', 'analysis'], 'ADX, efficiency ratio and ATR percentile classify the tape as trend, range, compression or expansion. Playbooks are gated by regime: [[Range Mean Reversion]] cannot fire in an established trend, while [[Momentum Continuation]] needs one.'],
    ['Concepts/Confidence Scoring', 'Confidence Scoring', ['concept', 'analysis'], 'Every candidate is scored by ten weighted factors; confidence is the weighted sum, not a vibe. Weak factors are documented rather than hidden. The score gates entry via [[Risk Engine]] and is only meaningful after [[Regime Detection]].'],
    ['Playbooks/Trend Pullback', 'Trend Pullback', ['playbook'], 'Entry on a retrace into the EMA21/EMA50 band while trend structure holds. Invalidated by a close through the trend EMA. Requires an established trend from [[Regime Detection]]; sizing per [[Position Sizing]].'],
    ['Playbooks/Breakout Retest', 'Breakout Retest', ['playbook'], 'Trade the retest of a broken Donchian edge with volume expansion. Invalidated by a close back inside the range. Works best when [[Regime Detection]] reports expansion.'],
    ['Playbooks/Liquidity Sweep Reversal', 'Liquidity Sweep Reversal', ['playbook'], 'Stops taken beyond a prior extreme and immediately reclaimed. Invalidated by any close beyond the sweep extreme. The tightest of the playbooks, so [[Position Sizing]] often allows the largest size here.'],
    ['Playbooks/Range Mean Reversion', 'Range Mean Reversion', ['playbook'], 'Fade the tested edge of a 40-bar range back toward the mid. Invalidated when ADX rises and the range resolves into a trend — the exact condition [[Momentum Continuation]] then looks for.'],
    ['Playbooks/Momentum Continuation', 'Momentum Continuation', ['playbook'], 'Ride an aligned impulse across ROC, MACD and participation. Invalidated when the histogram flips against the position. Needs an expansion or trend regime from [[Regime Detection]].'],
    ['Architecture/Device Deployment', 'Device Deployment', ['concept', 'deployment'], 'The backend runs on the user\'s own phone — no hosting bill. The frontend is served from Cloudflare and reaches the device over a Cloudflare Tunnel. The vault and [[Risk Engine]] state live in the device\'s RAM, so growing knowledge costs nothing.'],
  ];
  for (const [path, title, tags, body] of seeds) {
    if (vault.resolve(title)) continue;
    vault.write({
      path: `${path}.md`,
      title,
      content: `# ${title}\n\n${body}\n`,
      tags,
      frontmatter: { concept: true, pinned: true, seeded: true },
      source: 'system',
    });
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

let consolidationTimer = null;

if (isMain) {
  const { cfg, store, market, engine, server, broker, vault, memory, files } = await bootstrap();
  server.listen(cfg.port, cfg.host, async () => {
    const banner = [
      '',
      '  LUMINAVANTAGE  ·  AI market intelligence + automated execution',
      `  http://${cfg.host}:${cfg.port}`,
      `  mode        ${cfg.live ? `LIVE (${cfg.broker})` : 'PAPER'}${broker && !broker.configured ? ' — broker keys missing, live locked' : ''}`,
      `  timeframe   ${cfg.loop.timeframe}   watchlist ${cfg.watchlist.length} instruments`,
      `  database    ${cfg.dbFile}`,
      `  analyst     ${cfg.ai.provider === 'claude' && cfg.ai.apiKey ? `Anthropic ${cfg.ai.model}` : 'local reasoning engine'}`,
      '',
    ].join('\n');
    console.log(banner);
    store.log('info', 'server', 'started', { port: cfg.port, live: cfg.live, broker: cfg.broker });

    if (!cfg.licence.ownerSecret) console.log('  owner       disabled (set LUMINA_OWNER_SECRET to unlock the owner panel)');
    if (!store.get('SELECT COUNT(*) c FROM licences')?.c) console.log('  licences    none issued yet — run `npm run seed` to mint a trial key');

    if (cfg.loop.enabled) {
      engine.start();
      console.log(`  automation  every ${Math.round(cfg.loop.intervalMs / 1000)}s`);
    } else {
      console.log('  automation  disabled (LUMINA_AUTOTRADE=0)');
    }
    // The vault starts populated so the graph is never empty on first load.
    // (seeding happens in bootstrap() so programmatic and test use get it too)
    // Periodically fold episodes into the vault. This is the loop that makes
    // the AI's knowledge accumulate instead of resetting.
    const consolidateMs = cfg.vault.consolidateEveryMs;
    consolidationTimer = setInterval(() => {
      try {
        const r = memory.consolidate();
        if (r.written) console.log(`  memory      consolidated ${r.written} note(s) from ${r.episodes} episode(s)`);
      } catch (e) {
        console.error('  memory      consolidation failed:', e.message);
      }
    }, consolidateMs);
    consolidationTimer.unref?.();
    console.log(`  vault       RAM-only · ${vault.notes.size} notes · consolidating every ${Math.round(consolidateMs / 60000)}m`);
    if (files) console.log(`  files       ${files.blobs.kind === 'r2' ? 'R2' : 'disk'} · ${files.stats().files} file(s) · limit ${Math.round(cfg.files.maxBytes / 1048576)} MB each`);
    // warm the quote cache so the first dashboard render is populated
    engine.refreshQuotes().catch(() => {});
  });

  const shutdown = (sig) => {
    console.log(`\n[${sig}] shutting down`);
    if (consolidationTimer) clearInterval(consolidationTimer);
    engine.stop();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
