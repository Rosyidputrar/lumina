/** Shapes returned by the Lumina backend. Only the fields the app reads. */

export type Side = 'long' | 'short';
export type OrderSide = 'buy' | 'sell';

export interface Licence {
  plan: string;
  quota: number | null;
  used: number;
  remaining: number | null;
  daysLeft: number | null;
  expiresAt?: number | null;
  label: string | null;
}

export interface LicenceStatus {
  active: boolean;
  owner?: boolean;
  licence: Licence | null;
  reasons?: string[];
}

export interface Quote {
  symbol: string;
  venue: string;
  label: string;
  assetClass: string;
  price: number;
  bid: number | null;
  ask: number | null;
  changePct: number;
  high: number;
  low: number;
  volume: number;
  ts: number;
  stale: boolean;
}

export interface WatchItem {
  symbol: string;
  venue: string;
  label?: string;
  assetClass?: string;
}

export interface Position {
  id: string;
  user_id: string;
  mode: 'paper' | 'live';
  venue: string;
  symbol: string;
  side: Side;
  qty: number;
  entry: number;
  stop: number | null;
  target: number | null;
  opened_at: number;
  closed_at: number | null;
  exit_price: number | null;
  pnl: number | null;
  fees: number;
  status: 'open' | 'closed';
  close_reason: string | null;
  signal_id: string | null;
  mark?: number;
  unrealised?: number;
  unrealisedPct?: number;
  rMultiple?: number | null;
  notional?: number;
}

export interface Order {
  id: string;
  mode: string;
  venue: string;
  symbol: string;
  side: OrderSide;
  type: string;
  qty: number;
  status: string;
  avg_fill: number | null;
  fees: number;
  reject_reason: string | null;
  created_at: number;
}

export interface Factor {
  label: string;
  weight: number;
  strength: number;
  points: number;
  note: string;
}

export interface Signal {
  id: string;
  symbol: string;
  venue: string;
  timeframe: string;
  direction: Side;
  confidence: number;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  reward_risk: number | null;
  regime: string | null;
  playbook: string | null;
  rationale: string | null;
  factors: Factor[];
  invalidations: string[];
  status: 'new' | 'executed' | 'dismissed' | string;
  mode: string;
  created_at: number;
}

export interface RiskReport {
  equity: number;
  dayPnl: number;
  dayPnlPct: number;
  openRisk: number;
  openRiskPct: number;
  notional: number;
  leverageUsed: number;
  drawdownPct: number;
  limits: {
    maxRiskPerTradePct: number;
    maxDailyLossPct: number;
    maxPortfolioHeatPct: number;
    maxOpenPositions: number;
    maxEntriesPerSymbol: number;
    maxLeverage: number;
    dailyTradeCap: number;
    minConfidence: number;
    minRewardRisk: number;
    cooldownMinutes: number;
  };
}

export interface ActivityEntry {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'trade' | string;
  message: string;
}

export interface EngineStatus {
  running: boolean;
  cycle: number;
  ticks: number;
  lastRun: number | null;
  lastError: string | null;
  cycleMs: number | null;
  broker: string;
  live: boolean;
  intervalMs: number;
  timeframe: string;
  activity: ActivityEntry[];
}

export interface Account {
  currency: string | null;
  currencySource: string;
  brokerBalance: number | null;
  equity: number;
  balance: number;
  startingEquity: number;
  realizedPnl: number;
  dayPnl: number;
  unrealised: number;
  feesPaid: number;
  liveEnabled: boolean;
  connectedAccounts: number;
  brokerConnection: string;
  dayTrades: number;
}

export interface Terminal {
  licence: Licence;
  account: Account;
  quotes: Quote[];
  positions: Position[];
  signals: Signal[];
  recentSignals: Signal[];
  orders: Order[];
  risk: RiskReport;
  equityCurve: { ts: number; equity: number; balance: number }[];
  engine: EngineStatus;
  preferences: { timeframe?: string; style?: string };
  autoTrade: boolean;
  live: {
    enabled: boolean;
    broker: string | null;
    configured: boolean;
    mode: 'paper' | 'live';
    activeAccount: { label: string; login: string; server: string } | null;
    minConfidence: number;
    minRR: number;
  };
  analyst: { mode: string; provider: string };
  watchlist: WatchItem[];
  executionScope: { mode: string; symbol?: string | null; symbols?: string[] };
  marketHealth: { calls: number; failures: number; lastSuccess: number | null; venues: Record<string, { ok: boolean; at: number; message: string }> };
  serverTime: number;
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  stale?: boolean;
}

export interface Regime {
  regime: string;
  label: string;
  direction: string;
  adx: number | null;
  efficiency: number | null;
  atrPercentile: number | null;
  bbWidthPercentile: number | null;
}

export interface Zone {
  price: number;
  touches: number;
  kind: string;
  side: string;
  distancePct: number;
}

export interface Plan {
  ok: boolean;
  reason?: string;
  strategy?: string;
  systematic?: boolean;
  exit?: { type: string; bars: number } | null;
  signalTs?: number;
  filtered?: { playbook: string; direction: Side; why: string }[];
  symbol?: string;
  venue?: string;
  label?: string;
  timeframe?: string;
  playbook?: string;
  name?: string;
  direction?: Side;
  entry?: number;
  stop?: number;
  target1?: number;
  target2?: number;
  rewardRisk?: number;
  confidence?: number;
  regime?: Regime;
  factors?: Factor[];
  invalidations?: string[];
  thesis?: string;
  alternatives?: { playbook: string; name: string; direction: Side; confidence: number }[];
  snapshot?: Record<string, number | null>;
  zones?: Zone[];
  at?: number;
}

export interface AnalysisResponse {
  plan: Plan;
  candles: Candle[];
  series: { ema21: (number | null)[]; ema50: (number | null)[]; vwap: (number | null)[]; rsi: (number | null)[] };
}

export interface SweepRow {
  symbol: string;
  venue: string;
  label: string;
  price: number | null;
  ok: boolean;
  reason: string | null;
  playbook: string | null;
  direction: Side | null;
  confidence: number | null;
  rewardRisk: number | null;
  stop: number | null;
  target1: number | null;
  regime: string | null;
  thesis: string | null;
  systematic?: boolean;
  filtered?: string[];
}

export interface SweepResponse {
  timeframe: string;
  strategy?: string;
  pattern: string;
  profitOnly: boolean;
  minRR: number;
  analysed: number;
  setups: SweepRow[];
  rejected: SweepRow[];
  at: number;
}

export interface Explanation {
  mode: string;
  provider: string;
  headline: string;
  body: string[];
  factors: Factor[];
  confidence: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  provider: string | null;
  ts: number;
}

export interface JournalResponse {
  closed: Position[];
  stats: {
    trades: number;
    winRate: number;
    profitFactor: number | null;
    netPnl: number;
    avgWin: number;
    avgLoss: number;
    best: Position | null;
    worst: Position | null;
  };
  orders: Order[];
}

export interface PendingOrder {
  id: string;
  symbol: string;
  venue: string;
  side: OrderSide;
  qty: number;
  trigger_price: number;
  stop: number | null;
  target: number | null;
  status: string;
  created_at: number;
}

export interface BacktestResult {
  ok: boolean;
  reason?: string;
  symbol: string;
  venue: string;
  timeframe: string;
  bars: number;
  from: string;
  to: string;
  startingEquity: number;
  endingEquity: number;
  returnPct: number;
  cagrPct: number;
  trades: number;
  blocked: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  expectancyR: number;
  grossR?: number;
  feesPaid?: number;
  strategy?: string;
  costs?: { spreadBps: number; slippageBps: number; feeBps: number };
  maxDrawdownPct: number;
  avgBarsHeld: number;
  byPlaybook: { playbook: string; trades: number; winRate: number; pnl: number; avgR: number }[];
  curve: { ts: number; equity: number }[];
  tradeLog: { side: Side; entry: number; exit: number; pnl: number; rMultiple: number; reason: string; playbook: string; entryTs?: number; exitTs?: number; bars: number }[];
  assumptions: string[];
}

export interface VaultNoteSummary {
  id: string;
  path: string;
  title: string;
  tags: string[];
  source: string;
  bytes: number;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  backlinks: number;
  outgoing: number;
}

export interface VaultNote extends VaultNoteSummary {
  body: string;
  links: string[];
  editable?: boolean;
}

export interface VaultSnapshot {
  graph: { nodes: { id: string; title: string; group: string; degree: number }[]; edges: { id: string; source: string; target: string }[] };
  notes: VaultNoteSummary[];
  tags: { tag: string; count: number }[];
  stats: { notes: number; edges: number; tags: number; bytes: number; writes: number; evictions: number; limits: { maxNotes: number; maxTotalBytes: number } };
}

export interface FileRow {
  id: string;
  name: string;
  ext: string;
  mime: string;
  bytes: number;
  sha256: string;
  title: string | null;
  notes: string | null;
  visibility: 'public' | 'private';
  downloads: number;
  createdAt: number;
  shareToken: string;
  url: string;
  directUrl: string;
}

export interface NewsItem {
  title: string;
  summary: string;
  url: string | null;
  source: string | null;
  ts: number | string | null;
}

export interface BrokerProfile {
  connected: boolean;
  status: string;
  broker?: string;
  server?: string;
  login?: string;
  updatedAt?: number;
}

export interface Preferences {
  timeframe: string;
  style: string;
  autoTrade: boolean;
  live: boolean;
  brokerProfile: BrokerProfile;
}

export interface OwnerLicence {
  keyId: string;
  plan: string;
  label: string | null;
  quota: number | null;
  used: number;
  revoked: boolean;
  issuedAt: number;
  expiresAt: number | null;
  lastSeen: number | null;
  expired: boolean;
  remaining: number | null;
}

export interface StrategyProfile {
  id: string;
  label: string;
  playbooks: string[] | null;
  trendFilter: boolean;
  minStopAtr: number;
  maxCostShare: number | null;
  systematic?: boolean;
  assetClasses?: string[];
  exit?: { type: string; bars: number };
}

export interface IssuedLicence {
  key: string;
  readableKey: string;
  keyId: string;
  plan: string;
  label: string | null;
  quota: number | null;
  expiresAt: number | null;
}
