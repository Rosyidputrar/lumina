/**
 * Persistence layer — node:sqlite (built into Node 22+, no native deps).
 * Every write that matters to money or decisions lands in audit_log too.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const now = () => Date.now();
export const uid = (prefix = 'id') => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'trader',
  plan TEXT NOT NULL DEFAULT 'professional',
  created_at INTEGER NOT NULL,
  last_login INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  starting_equity REAL NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  fees_paid REAL NOT NULL DEFAULT 0,
  day_key TEXT,
  day_start_equity REAL,
  day_pnl REAL NOT NULL DEFAULT 0,
  peak_equity REAL,
  live_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL,
  confidence REAL NOT NULL,
  entry REAL,
  stop REAL,
  target1 REAL,
  target2 REAL,
  reward_risk REAL,
  regime TEXT,
  playbook TEXT,
  rationale TEXT,
  factors TEXT,
  invalidations TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  mode TEXT NOT NULL DEFAULT 'paper',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  signal_id TEXT,
  mode TEXT NOT NULL,
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  type TEXT NOT NULL,
  qty REAL NOT NULL,
  limit_price REAL,
  stop_price REAL,
  take_profit REAL,
  status TEXT NOT NULL,
  filled_qty REAL NOT NULL DEFAULT 0,
  avg_fill REAL,
  fees REAL NOT NULL DEFAULT 0,
  broker_order_id TEXT,
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  price REAL NOT NULL,
  qty REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  entry REAL NOT NULL,
  stop REAL,
  target REAL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  exit_price REAL,
  pnl REAL,
  fees REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  broker_position_id TEXT,
  signal_id TEXT,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(user_id, status);

CREATE TABLE IF NOT EXISTS pending_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  trigger_price REAL NOT NULL,
  stop REAL,
  target REAL,
  timeframe TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at INTEGER NOT NULL,
  filled_at INTEGER,
  fill_price REAL,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_open ON pending_orders(user_id, status);

CREATE TABLE IF NOT EXISTS equity_curve (
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  equity REAL NOT NULL,
  balance REAL NOT NULL,
  PRIMARY KEY (user_id, ts)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT,
  provider TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS service_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_service_ts ON service_events(ts DESC);
`;

export class Store {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this._stmts = new Map();
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  run(sql, ...params) {
    return this.stmt(sql).run(...params);
  }

  get(sql, ...params) {
    return this.stmt(sql).get(...params);
  }

  all(sql, ...params) {
    return this.stmt(sql).all(...params);
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  /* ------------------------------- users -------------------------------- */

  createUser({ email, name, passwordHash, salt, role = 'trader', plan = 'professional', startingEquity = 10000 }) {
    const id = uid('usr');
    const ts = now();
    this.tx(() => {
      this.run(
        'INSERT INTO users (id,email,name,password_hash,salt,role,plan,created_at) VALUES (?,?,?,?,?,?,?,?)',
        id,
        email.toLowerCase(),
        name,
        passwordHash,
        salt,
        role,
        plan,
        ts,
      );
      this.run(
        'INSERT INTO accounts (user_id,starting_equity,peak_equity,updated_at) VALUES (?,?,?,?)',
        id,
        startingEquity,
        startingEquity,
        ts,
      );
    });
    return this.getUserById(id);
  }

  getUserByEmail(email) {
    return this.get('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase());
  }

  getUserById(id) {
    return this.get('SELECT * FROM users WHERE id = ?', id);
  }

  touchLogin(id) {
    this.run('UPDATE users SET last_login = ? WHERE id = ?', now(), id);
  }

  listUsers() {
    return this.all(
      `SELECT u.id,u.email,u.name,u.role,u.plan,u.created_at,u.last_login,
              a.realized_pnl, a.day_pnl
         FROM users u LEFT JOIN accounts a ON a.user_id = u.id
        ORDER BY u.created_at ASC`,
    );
  }

  createSession(tokenHash, userId, expiresAt) {
    this.run('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)', tokenHash, userId, now(), expiresAt);
  }

  sessionUser(tokenHash) {
    const row = this.get('SELECT * FROM sessions WHERE token_hash = ?', tokenHash);
    if (!row) return null;
    if (row.expires_at < now()) {
      this.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
      return null;
    }
    return this.getUserById(row.user_id);
  }

  deleteSession(tokenHash) {
    this.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  /* ------------------------------ account ------------------------------- */

  account(userId) {
    return this.get('SELECT * FROM accounts WHERE user_id = ?', userId);
  }

  setLive(userId, enabled) {
    this.run('UPDATE accounts SET live_enabled = ?, updated_at = ? WHERE user_id = ?', enabled ? 1 : 0, now(), userId);
  }

  ensureDay(userId, equity) {
    const key = new Date().toISOString().slice(0, 10);
    const acc = this.account(userId);
    if (!acc) return;
    if (acc.day_key !== key) {
      this.run('UPDATE accounts SET day_key = ?, day_start_equity = ?, day_pnl = 0, updated_at = ? WHERE user_id = ?', key, equity, now(), userId);
    }
  }

  addRealized(userId, pnl, fee) {
    this.run(
      `UPDATE accounts SET realized_pnl = realized_pnl + ?, day_pnl = day_pnl + ?, fees_paid = fees_paid + ?, updated_at = ? WHERE user_id = ?`,
      pnl,
      pnl,
      fee,
      now(),
      userId,
    );
  }

  snapshotEquity(userId, equity, balance) {
    this.run('INSERT OR REPLACE INTO equity_curve (user_id,ts,equity,balance) VALUES (?,?,?,?)', userId, now(), equity, balance);
    const acc = this.account(userId);
    if (acc && (!acc.peak_equity || equity > acc.peak_equity)) {
      this.run('UPDATE accounts SET peak_equity = ? WHERE user_id = ?', equity, userId);
    }
  }

  equityCurve(userId, limit = 400) {
    return this.all('SELECT ts, equity, balance FROM equity_curve WHERE user_id = ? ORDER BY ts DESC LIMIT ?', userId, limit).reverse();
  }

  /* ------------------------------ signals ------------------------------- */

  insertSignal(s) {
    const id = s.id ?? uid('sig');
    this.run(
      `INSERT INTO signals (id,user_id,symbol,venue,timeframe,direction,confidence,entry,stop,target1,target2,
        reward_risk,regime,playbook,rationale,factors,invalidations,status,mode,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      s.userId,
      s.symbol,
      s.venue,
      s.timeframe,
      s.direction,
      s.confidence,
      s.entry,
      s.stop,
      s.target1,
      s.target2,
      s.rewardRisk,
      s.regime,
      s.playbook,
      s.rationale,
      JSON.stringify(s.factors ?? []),
      JSON.stringify(s.invalidations ?? []),
      s.status ?? 'new',
      s.mode ?? 'paper',
      s.createdAt ?? now(),
    );
    return id;
  }

  signals(userId, limit = 50) {
    return this.all('SELECT * FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit).map(hydrateSignal);
  }

  latestSignalPerSymbol(userId) {
    const rows = this.all(
      `SELECT s.* FROM signals s
        JOIN (SELECT symbol, MAX(created_at) m FROM signals WHERE user_id = ? GROUP BY symbol) t
          ON t.symbol = s.symbol AND t.m = s.created_at
       WHERE s.user_id = ?`,
      userId,
      userId,
    );
    return rows.map(hydrateSignal);
  }

  /* ------------------------------- orders ------------------------------- */

  insertOrder(o) {
    const id = o.id ?? uid('ord');
    const ts = now();
    this.run(
      `INSERT INTO orders (id,user_id,signal_id,mode,venue,symbol,side,type,qty,limit_price,stop_price,take_profit,
        status,filled_qty,avg_fill,fees,broker_order_id,reject_reason,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      o.userId,
      o.signalId ?? null,
      o.mode,
      o.venue,
      o.symbol,
      o.side,
      o.type ?? 'market',
      o.qty,
      o.limitPrice ?? null,
      o.stopPrice ?? null,
      o.takeProfit ?? null,
      o.status ?? 'new',
      o.filledQty ?? 0,
      o.avgFill ?? null,
      o.fees ?? 0,
      o.brokerOrderId ?? null,
      o.reason ?? null,
      ts,
      ts,
    );
    return id;
  }

  updateOrder(id, patch) {
    const keys = [];
    const vals = [];
    const map = {
      status: 'status',
      filledQty: 'filled_qty',
      avgFill: 'avg_fill',
      fees: 'fees',
      brokerOrderId: 'broker_order_id',
      rejectReason: 'reject_reason',
    };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        keys.push(`${col} = ?`);
        vals.push(patch[k]);
      }
    }
    if (!keys.length) return;
    vals.push(now(), id);
    this.run(`UPDATE orders SET ${keys.join(', ')}, updated_at = ? WHERE id = ?`, ...vals);
  }

  insertFill(f) {
    this.run('INSERT INTO fills (id,order_id,user_id,price,qty,fee,ts) VALUES (?,?,?,?,?,?,?)', uid('fil'), f.orderId, f.userId, f.price, f.qty, f.fee ?? 0, f.ts ?? now());
  }

  orders(userId, limit = 100) {
    return this.all('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', userId, limit);
  }

  openOrders(userId) {
    return this.all("SELECT * FROM orders WHERE user_id = ? AND status IN ('new','partially_filled')", userId);
  }

  /* ------------------------------ positions ----------------------------- */

  insertPosition(p) {
    const id = p.id ?? uid('pos');
    this.run(
      `INSERT INTO positions (id,user_id,mode,venue,symbol,side,qty,entry,stop,target,opened_at,fees,status,broker_position_id,signal_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      p.userId,
      p.mode,
      p.venue,
      p.symbol,
      p.side,
      p.qty,
      p.entry,
      p.stop ?? null,
      p.target ?? null,
      p.openedAt ?? now(),
      p.fees ?? 0,
      'open',
      p.brokerPositionId ?? null,
      p.signalId ?? null,
    );
    return id;
  }

  openPositions(userId) {
    return this.all("SELECT * FROM positions WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC", userId);
  }

  position(userId, id) {
    return this.get('SELECT * FROM positions WHERE user_id = ? AND id = ?', userId, id);
  }

  updatePosition(id, patch) {
    const map = {
      stop: 'stop',
      target: 'target',
      qty: 'qty',
      status: 'status',
      exitPrice: 'exit_price',
      pnl: 'pnl',
      fees: 'fees',
      closedAt: 'closed_at',
      closeReason: 'close_reason',
    };
    const keys = [];
    const vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        keys.push(`${col} = ?`);
        vals.push(patch[k]);
      }
    }
    if (!keys.length) return;
    vals.push(id);
    this.run(`UPDATE positions SET ${keys.join(', ')} WHERE id = ?`, ...vals);
  }

  /* ----------------------------- pending orders ---------------------------- */

  addPendingOrder({ userId, symbol, venue, side, qty, triggerPrice, stop, target, timeframe }) {
    const id = uid('pnd');
    this.run('INSERT INTO pending_orders (id,user_id,symbol,venue,side,qty,trigger_price,stop,target,timeframe,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, userId, symbol, venue, side, qty, triggerPrice, stop ?? null, target ?? null, timeframe ?? null, 'waiting', now());
    return this.get('SELECT * FROM pending_orders WHERE id = ?', id);
  }

  pendingOrders(userId) {
    return this.all("SELECT * FROM pending_orders WHERE user_id = ? AND status = 'waiting' ORDER BY created_at ASC", userId);
  }

  allWaitingOrders() {
    return this.all("SELECT * FROM pending_orders WHERE status = 'waiting'");
  }

  fillPendingOrder(id, price) {
    this.run("UPDATE pending_orders SET status = 'filled', filled_at = ?, fill_price = ? WHERE id = ?", now(), price, id);
  }

  cancelPendingOrder(id, reason = 'manual') {
    this.run("UPDATE pending_orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, id);
  }

  closedPositions(userId, limit = 100) {
    return this.all("SELECT * FROM positions WHERE user_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT ?", userId, limit);
  }

  countsBySymbol(userId, symbol) {
    const open = this.get("SELECT COUNT(*) c FROM positions WHERE user_id = ? AND symbol = ? AND status = 'open'", userId, symbol);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const trades = this.get('SELECT COUNT(*) c FROM orders WHERE user_id = ? AND created_at >= ? AND status != ?', userId, today.getTime(), 'rejected');
    return { open: open?.c ?? 0, tradesToday: trades?.c ?? 0 };
  }

  lastTradeAt(userId, symbol) {
    const row = this.get('SELECT MAX(opened_at) t FROM positions WHERE user_id = ? AND symbol = ?', userId, symbol);
    return row?.t ?? 0;
  }

  /* -------------------------------- logs -------------------------------- */

  audit({ userId, actor, action, detail, ip }) {
    this.run('INSERT INTO audit_log (ts,user_id,actor,action,detail,ip) VALUES (?,?,?,?,?,?)', now(), userId ?? null, actor, action, typeof detail === 'string' ? detail : JSON.stringify(detail ?? null), ip ?? null);
  }

  auditTrail(limit = 200, userId = null) {
    if (userId) return this.all('SELECT * FROM audit_log WHERE user_id = ? ORDER BY ts DESC LIMIT ?', userId, limit);
    return this.all('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?', limit);
  }

  log(level, source, message, meta) {
    this.run('INSERT INTO service_events (ts,level,source,message,meta) VALUES (?,?,?,?,?)', now(), level, source, message, meta ? JSON.stringify(meta) : null);
  }

  serviceEvents(limit = 100) {
    return this.all('SELECT * FROM service_events ORDER BY ts DESC LIMIT ?', limit);
  }

  /* ------------------------------- AI / UI ------------------------------ */

  addMessage({ userId, role, content, context, provider }) {
    const id = uid('msg');
    this.run('INSERT INTO ai_messages (id,user_id,role,content,context,provider,ts) VALUES (?,?,?,?,?,?,?)', id, userId, role, content, JSON.stringify(context ?? null), provider ?? null, now());
    return id;
  }

  messages(userId, limit = 60) {
    return this.all('SELECT * FROM ai_messages WHERE user_id = ? ORDER BY ts DESC LIMIT ?', userId, limit).reverse();
  }

  setSetting(userId, key, value) {
    this.run('INSERT INTO settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value = excluded.value', userId, key, JSON.stringify(value));
  }

  getSetting(userId, key, fallback = null) {
    const row = this.get('SELECT value FROM settings WHERE user_id = ? AND key = ?', userId, key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  settings(userId) {
    const rows = this.all('SELECT key, value FROM settings WHERE user_id = ?', userId);
    const out = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  }
}

function hydrateSignal(r) {
  return {
    ...r,
    factors: safeJson(r.factors, []),
    invalidations: safeJson(r.invalidations, []),
  };
}

function safeJson(v, d) {
  if (!v) return d;
  try {
    return JSON.parse(v);
  } catch {
    return d;
  }
}
