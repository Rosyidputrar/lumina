/**
 * Configuration. Everything is driven by environment variables with safe,
 * explicit defaults. Live trading is OFF unless LUMINA_LIVE=1 *and* a broker
 * key is present — there is no accidental path to real money.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const env = process.env;

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const json = (v, d) => {
  if (!v) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
};

/**
 * What the engine watches.
 *
 * MT5 is the venue for forex, metals and indices, because those instruments
 * exist only inside a MetaTrader terminal. Symbol names are the broker's own —
 * this broker appends `.s` (EURUSD.s, US100.s), another might use `EURUSDm` or
 * `EURUSD`. They are set from LUMINA_WATCHLIST rather than guessed here, and a
 * wrong name fails loudly instead of quietly reading a different market.
 */
export const DEFAULT_WATCHLIST = [
  { symbol: env.MT5_SYMBOL_EURUSD ?? 'EURUSD.s', venue: 'mt5', label: 'EUR / USD', assetClass: 'fx' },
  { symbol: env.MT5_SYMBOL_GBPUSD ?? 'GBPUSD.s', venue: 'mt5', label: 'GBP / USD', assetClass: 'fx' },
  { symbol: env.MT5_SYMBOL_XAUUSD ?? 'XAUUSD.s', venue: 'mt5', label: 'Gold / USD', assetClass: 'metal' },
  { symbol: env.MT5_SYMBOL_US100 ?? 'US100.s', venue: 'mt5', label: 'Nasdaq 100', assetClass: 'index' },
];

/**
 * What the engine watches when no MT5 gateway is configured.
 *
 * The MT5 list above can only be quoted through a gateway; without one every
 * instrument failed with "unknown venue: mt5" and the terminal sat empty. These
 * instruments come from public market-data APIs that need no key, so a fresh
 * install shows real prices and the paper engine has something to analyse.
 */
export const PUBLIC_WATCHLIST = [
  { symbol: 'BTC-USDT', venue: 'okx', label: 'Bitcoin / USDT', assetClass: 'crypto' },
  { symbol: 'ETH-USDT', venue: 'okx', label: 'Ether / USDT', assetClass: 'crypto' },
  { symbol: 'SOL-USDT', venue: 'okx', label: 'Solana / USDT', assetClass: 'crypto' },
  { symbol: 'EURUSD', venue: 'kraken', label: 'EUR / USD', assetClass: 'fx' },
  { symbol: 'GBPUSD', venue: 'kraken', label: 'GBP / USD', assetClass: 'fx' },
  { symbol: 'PAXGUSD', venue: 'kraken', label: 'Gold (PAXG) / USD', assetClass: 'metal' },
];

/** The default list: MT5 when a gateway is configured, public venues otherwise. */
export function defaultWatchlist() {
  return env.MT5_GATEWAY_URL && env.MT5_GATEWAY_KEY ? DEFAULT_WATCHLIST : PUBLIC_WATCHLIST;
}

/** The signing secret used when none is configured. Never valid in production. */
export const DEV_LICENSE_SECRET = 'dev-only-change-me-please-32chars-min';

export function loadConfig(overrides = {}) {
  const liveRequested = String(env.LUMINA_LIVE ?? '0') === '1';
  const brokerName = (env.LUMINA_BROKER ?? 'paper').toLowerCase();

  const cfg = {
    root: ROOT,
    port: num(env.PORT, 8787),
    host: env.HOST ?? '127.0.0.1',
    env: env.NODE_ENV ?? 'development',

    live: liveRequested && brokerName !== 'paper',
    provisionerUrl: env.MT5_PROVISIONER_URL ?? '',
    provisionerKey: env.MT5_PROVISIONER_KEY ?? '',

    broker: brokerName,
    okx: {
      apiKey: env.OKX_API_KEY ?? '',
      apiSecret: env.OKX_API_SECRET ?? '',
      passphrase: env.OKX_PASSPHRASE ?? '',
      baseUrl: env.OKX_BASE_URL ?? 'https://www.okx.com',
      demo: String(env.OKX_DEMO ?? '0') === '1',
    },
    bybit: {
      apiKey: env.BYBIT_API_KEY ?? '',
      apiSecret: env.BYBIT_API_SECRET ?? '',
      baseUrl: env.BYBIT_BASE_URL ?? 'https://api.bybit.com',
      demo: String(env.BYBIT_DEMO ?? '0') === '1',
    },
    // MT5 through a self-hosted gateway container. One gateway per broker
    // account, so baseUrl points at that container and the API key is the one
    // given to the container at boot. Credentials for the broker itself live
    // in the container, never here.
    mt5: {
      baseUrl: env.MT5_GATEWAY_URL ?? '',
      apiKey: env.MT5_GATEWAY_KEY ?? '',
      demo: String(env.MT5_DEMO ?? '1') === '1',
      // The broker account is shown to the owner, never the password.
      login: env.MT5_LOGIN ?? '',
      server: env.MT5_SERVER ?? '',
      label: env.MT5_LABEL ?? '',
    },

    // A news feed the owner points at. Empty means the page says so instead of
    // inventing headlines.
    news: {
      feedUrl: env.NEWS_FEED_URL ?? '',
    },

    dbFile: env.LUMINA_DB ?? path.join(ROOT, 'data', 'sentinel.db'),

    // Account & risk envelope for automated execution
    account: {
      startingEquity: num(env.LUMINA_EQUITY, 10000),
      currency: 'USD',
      maxRiskPerTrade: num(env.LUMINA_RISK_PER_TRADE, 0.005), // 0.5% equity
      maxDailyLoss: num(env.LUMINA_MAX_DAILY_LOSS, 0), // 0 = no daily loss halt
      maxOpenPositions: num(env.LUMINA_MAX_POSITIONS, 0), // 0 = unlimited
      maxEntriesPerSymbol: num(env.LUMINA_MAX_ENTRIES_PER_SYMBOL, 3),
      maxPositionNotionalPct: num(env.LUMINA_MAX_POS_PCT, 0), // 0 = no notional cap
      maxLeverage: num(env.LUMINA_MAX_LEVERAGE, 0), // 0 = no leverage cap
      minConfidence: num(env.LUMINA_MIN_CONFIDENCE, 62),
      minRewardRisk: num(env.LUMINA_MIN_RR, 1.6),
      dailyTradeCap: num(env.LUMINA_DAILY_TRADE_CAP, 0), // 0 = unlimited
      cooldownMinutes: num(env.LUMINA_COOLDOWN_MIN, 0), // 0 = no cooldown
    },

    // Execution loop
    loop: {
      enabled: String(env.LUMINA_AUTOTRADE ?? '1') === '1',
      intervalMs: num(env.LUMINA_LOOP_MS, 60_000),
      timeframe: env.LUMINA_TIMEFRAME ?? '1h',
      historyBars: num(env.LUMINA_HISTORY, 400),
    },

    watchlist: json(env.LUMINA_WATCHLIST, defaultWatchlist()),

    // AI analyst (optional). Without a key the analyst runs a deterministic
    // local model — clearly labelled, never pretending to be an LLM.
    ai: {
      provider: env.LUMINA_AI_PROVIDER ?? 'local',
      baseUrl: env.LUMINA_AI_BASE_URL ?? 'https://api.anthropic.com',
      apiKey: env.LUMINA_AI_KEY ?? env.ANTHROPIC_API_KEY ?? '',
      model: env.LUMINA_AI_MODEL ?? 'claude-sonnet-5-5',
    },

    // The continuous, cheap reader. DeepSeek Flash-class by design: it runs at
    // least once every few minutes, so cost is governed by a hard token cap.
    watcher: {
      provider: env.LUMINA_WATCHER_PROVIDER ?? env.LUMINA_AI_PROVIDER ?? 'local',
      baseUrl: env.LUMINA_WATCHER_BASE_URL ?? env.LUMINA_AI_BASE_URL ?? '',
      apiKey: env.LUMINA_WATCHER_KEY ?? env.LUMINA_AI_KEY ?? '',
      model: env.LUMINA_WATCHER_MODEL ?? '',
      timeframe: env.LUMINA_WATCHER_TIMEFRAME ?? '15m',
      intervalMs: num(env.LUMINA_WATCHER_INTERVAL_MS, 120_000),
      tokensPerHour: num(env.LUMINA_WATCHER_TOKENS_PER_HOUR, 1_000_000),
    },

    /**
     * Licensing replaces accounts entirely.
     *
     * The owner mints keys on their own machine; the customer's device validates
     * them offline with the shared signing secret. No login, no user database,
     * no per-customer server call.
     */
    licence: {
      cookie: 'lumina_licence',
      ownerCookie: 'lumina_owner',
      // IMPORTANT: set this on the owner's machine and keep it stable. Rotating
      // it invalidates every key already issued.
      secret: env.LUMINA_LICENSE_SECRET || DEV_LICENSE_SECRET,
      ownerSecret: env.LUMINA_OWNER_SECRET ?? '',
      // A device that has never been activated cannot trade or ask the analyst.
      required: String(env.LUMINA_LICENSE_REQUIRED ?? '1') === '1',
      // Metered operations consume quota. Backtests and cycles cost more than
      // a plain read, so they are weighted.
      cost: {
        cycle: num(env.LUMINA_COST_CYCLE, 3),
        ask: num(env.LUMINA_COST_ASK, 1),
        backtest: num(env.LUMINA_COST_BACKTEST, 5),
      },
    },

    session: {
      cookie: 'lumina_session',
      ttlDays: num(env.LUMINA_SESSION_DAYS, 7),
      secret: env.LUMINA_SESSION_SECRET ?? '',
    },

    // Customer broker passwords are encrypted at rest. Without this secret the
    // customer connect form fails closed instead of writing plaintext.
    credentialSecret: env.LUMINA_CREDENTIAL_SECRET ?? '',

    // Paper trading fills (all in basis points)
    paper: {
      spreadBps: num(env.LUMINA_SPREAD_BPS, 1.5),
      slippageBps: num(env.LUMINA_SLIPPAGE_BPS, 1.0),
      feeBps: num(env.LUMINA_FEE_BPS, 4),
    },

    /**
     * The Obsidian vault and the AI's memory both live in process RAM only.
     * That is the point: this backend runs on the user's own device, so the
     * growing knowledge costs nothing to host. Caps keep a phone's memory safe.
     */
    vault: {
      maxNotes: num(env.LUMINA_VAULT_MAX_NOTES, 400),
      maxNoteBytes: num(env.LUMINA_VAULT_MAX_NOTE_BYTES, 20 * 1024),
      maxTotalBytes: num(env.LUMINA_VAULT_MAX_BYTES, 4 * 1024 * 1024),
      maxEdges: num(env.LUMINA_VAULT_MAX_EDGES, 5000),
      consolidateEveryMs: num(env.LUMINA_VAULT_CONSOLIDATE_MS, 5 * 60_000),
    },
    memory: {
      maxEpisodes: num(env.LUMINA_MEMORY_EPISODES, 2000),
    },

    /**
     * Shared files (APKs and other binaries) go to DISK, unlike the vault.
     * A shared download link must survive a restart, and an APK is far too
     * large to hold in RAM on a phone.
     */
    files: {
      enabled: String(env.LUMINA_FILES ?? '1') === '1',
      root: env.LUMINA_FILES_DIR ?? path.join(ROOT, 'data', 'files'),
      maxBytes: num(env.LUMINA_FILES_MAX_BYTES, 300 * 1024 * 1024),
      /**
       * Cloudflare R2, or any S3-compatible bucket. When these are set the
       * bytes go to the bucket instead of the server's disk, which removes the
       * bandwidth cost from a small VPS. Leave them empty to keep using disk.
       */
      r2: {
        endpoint: env.LUMINA_R2_ENDPOINT ?? '',
        bucket: env.LUMINA_R2_BUCKET ?? '',
        accessKeyId: env.LUMINA_R2_ACCESS_KEY ?? '',
        secretAccessKey: env.LUMINA_R2_SECRET_KEY ?? '',
        region: env.LUMINA_R2_REGION ?? 'auto',
        prefix: env.LUMINA_R2_PREFIX ?? 'files',
      },
    },

    /**
     * Split deployment: the backend runs on the user's device (free), the
     * frontend is served from Cloudflare. `origin` is the frontend's public URL,
     * used for CORS and for the SSE cookie to be allowed cross-site.
     */
    deploy: {
      mode: env.LUMINA_DEPLOY ?? 'device',
      frontendOrigin: env.LUMINA_FRONTEND_ORIGIN ?? '',
      // Extra origins this deployment answers on. A browser sends Origin: the
      // public host it typed, while the edge proxy rewrites `host` to the origin
      // it forwards to; listing the public hosts here keeps the CSRF guard both
      // strict and correct. Comma-separated, absolute URLs.
      publicOrigins: env.LUMINA_PUBLIC_ORIGINS ?? '',
      // Activation notices. Separate from the Worker's bot secrets on purpose:
      // the Node backend is what performs an activation, so it is what must
      // report one.
      telegram: {
        token: env.LUMINA_TELEGRAM_TOKEN ?? '',
        chat: env.LUMINA_TELEGRAM_CHAT ?? '',
      },
      // Cloudflare Tunnel gives the device a public HTTPS hostname with no
      // port forwarding and no inbound firewall rule.
      tunnelHostname: env.LUMINA_TUNNEL_HOSTNAME ?? '',
      trustProxy: String(env.LUMINA_TRUST_PROXY ?? '1') === '1',
    },
  };

  return { ...cfg, ...overrides };
}

export const config = loadConfig();
