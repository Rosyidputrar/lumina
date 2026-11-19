/**
 * HTTP application.
 *
 * Zero dependencies: the router, static file server, JSON body parser and SSE
 * hub are ~200 lines that we control completely. That matters here — this
 * process holds trading state, so the fewer moving parts between a request and
 * the risk gate, the better.
 *
 * Security posture:
 *   - session cookie is HttpOnly + SameSite=Lax, hashed at rest
 *   - every mutating request requires the session AND a same-origin check
 *   - per-IP rate limits on auth, and per-user limits on expensive endpoints
 *   - live trading requires an explicit two-step enable with the account flag
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { formatBytes } from './files/store.js';
import { Licensing, PLANS } from './licensing/licence.js';
import crypto from 'node:crypto';
import { Mt5Broker } from './execution/mt5-broker.js';
import { cookie, hashPassword, verifyPassword, newToken, tokenHash, parseCookies, RateLimiter } from './auth.js';
import { ownerConsoleHtml } from './owner/console.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code ?? 'ERROR';
    this.extra = extra;
  }
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req, limit = 1_000_000) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload too large', 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid JSON body', 'BAD_JSON');
  }
}

/* --------------------------------- router -------------------------------- */

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((seg) => {
            if (seg.startsWith(':')) {
              keys.push(seg.slice(1));
              return '([^/]+)';
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '$',
    );
    this.routes.push({ method, regex, keys, handler, opts });
  }

  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  del(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.regex);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return null;
  }
}

/* ------------------------------ application ------------------------------ */

export function createApp({ store, market, bus, engine, analyst, expert = null, watcher = null, config, backtester, broker = null, vault = null, memory = null, files = null, licensing = null, logger = console }) {
  const router = new Router();
  const authLimiter = new RateLimiter({ windowMs: 5 * 60_000, max: 20 });
  const apiLimiter = new RateLimiter({ windowMs: 60_000, max: 240 });
  const expensiveLimiter = new RateLimiter({ windowMs: 60_000, max: 20 });
  // Uploads are expensive and large; keep them to a sane number per minute.
  const uploadLimiter = new RateLimiter({ windowMs: 60_000, max: 30 });
  const sseClients = new Set();

  const ctxOf = (req) => {
    const trustProxy = config.deploy?.trustProxy !== false;
    const forwardedFor = trustProxy ? req.headers['x-forwarded-for']?.split(',')[0] : null;
    const ip = String(forwardedFor ?? req.socket.remoteAddress ?? 'local').trim();
    const secure = Boolean(req.socket.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.session.cookie];
    const user = token ? store.sessionUser(tokenHash(token)) : null;
    return { ip, secure, cookies, token, user };
  };


  /**
   * Origins permitted to call this backend from a browser.
   *
   * In split deployment the frontend lives on Cloudflare and the backend on the
   * user's phone, so requests are genuinely cross-origin. We allow exactly the
   * configured frontend origin — never a wildcard, because the session cookie
   * rides along.
   */
  const allowedOrigins = new Set(
    [
      config.deploy?.frontendOrigin,
      config.deploy?.tunnelHostname ? `https://${config.deploy.tunnelHostname}` : null,
      // Hosts this deployment is served on. Without these, a browser POST to
      // the public domain is refused because the proxy rewrites `host`.
      ...String(config.deploy?.publicOrigins ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ]
      .filter(Boolean)
      .map((o) => o.replace(/\/+$/, '')),
  );

  function corsHeaders(origin) {
    if (!origin || !allowedOrigins.has(origin)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      vary: 'origin',
    };
  }


  /**
   * How long an owner login lasts.
   *
   * Eight hours meant typing the passphrase again every day, which is how
   * people end up choosing a short passphrase to make it bearable. A month is
   * long enough to be usable; the token is signed, so changing the passphrase
   * still invalidates every device at once.
   */
  const OWNER_SESSION_SECONDS = 30 * 24 * 3600;


  function signOwnerToken(lic, ts) {
    const payload = `owner.${ts}`;
    return `${payload}.${crypto.createHmac('sha256', lic.adminSecret).update(payload).digest('base64url')}`;
  }

  function isOwner(ctx) {
    const raw = ctx.cookies?.[config.licence.ownerCookie];
    if (!raw || !licensing.adminSecret) return false;
    const parts = String(raw).split('.');
    if (parts.length !== 3) return false;
    const [tag, tsStr, sig] = parts;
    if (tag !== 'owner') return false;
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || Date.now() - ts > OWNER_SESSION_SECONDS * 1000) return false;
    const expected = crypto.createHmac('sha256', licensing.adminSecret).update(`owner.${tsStr}`).digest('base64url');
    return expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  }

  /**
   * AI settings live in the settings table, not in the environment, so an owner
   * can change them from the console without a redeploy. The environment stays
   * the initial value.
   */
  const AI_SETTINGS_OWNER = '__owner__';

  function storedAiSettings() {
    try {
      const raw = store.getSetting(AI_SETTINGS_OWNER, 'ai', null);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveAiSettings(patch) {
    const merged = { ...storedAiSettings(), ...patch };
    store.setSetting(AI_SETTINGS_OWNER, 'ai', JSON.stringify(merged));
    return merged;
  }

  /** Push the stored settings into the live config and the analyst. */
  function applyAiSettings() {
    const saved = storedAiSettings();
    if (saved.baseUrl !== undefined) config.ai.baseUrl = saved.baseUrl;
    if (saved.model !== undefined) config.ai.model = saved.model;
    if (saved.apiKey !== undefined) config.ai.apiKey = saved.apiKey;
    if (saved.provider !== undefined) config.ai.provider = saved.provider;
    // The analyst reads config.ai on every call, so no restart is needed; but its
    // cached mode must be recomputed when the provider changes.
    if (typeof analyst.refresh === 'function') analyst.refresh();
    return config.ai;
  }

  /**
   * Send the owner a full record of an activation through Telegram.
   *
   * Fire and forget on purpose: the licence is already valid and the cookie is
   * already set, so a Telegram outage must not turn a good activation into an
   * error the customer sees.
   */
  function notifyActivation(ctx, info) {
    const token = config.deploy?.telegram?.token || process.env.LUMINA_TELEGRAM_TOKEN || '';
    const chat = config.deploy?.telegram?.chat || process.env.LUMINA_TELEGRAM_CHAT || '';
    if (!token || !chat) return;
    const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const quota = info.quota === null || info.quota === undefined ? 'tanpa had' : `${info.used}/${info.quota}`;
    const expires = info.expiresAt ? new Date(info.expiresAt).toISOString().slice(0, 10) : 'selamanya';
    const geo = ctx.geo ?? {};
    const where = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'lokasi tidak diketahui';
    const lines = [
      '✅ <b>Peranti diaktifkan</b>',
      '',
      `<b>Masa</b>  ${esc(when)}`,
      `<b>Peranti</b>  ${esc(info.device.name)}`,
      `<b>Sistem</b>  ${esc(info.device.os)}${info.device.browser ? ' · ' + esc(info.device.browser) : ''}`,
      `<b>Lokasi</b>  ${esc(where)}`,
      `<b>IP</b>  ${esc(ctx.ip)}`,
      '',
      `<b>Pelan</b>  ${esc(info.plan)}`,
      info.label ? `<b>Label</b>  ${esc(info.label)}` : null,
      `<b>Kuota</b>  ${esc(quota)}`,
      `<b>Tamat</b>  ${esc(expires)}`,
      `<b>Kunci</b>  <code>${esc(info.keyId)}</code>`,
      info.device.fingerprint ? `<b>Peranti ID</b>  <code>${esc(info.device.fingerprint.slice(0, 16))}</code>` : null,
    ].filter((l) => l !== null);
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
    }).catch((e) => logger.warn?.('[telegram] activation notice failed:', e?.message ?? e));
  }

  function requireOwnerSession(ctx) {
    if (!isOwner(ctx)) throw new HttpError(401, 'owner passphrase required', 'OWNER_ONLY');
    return true;
  }


  /* ---------------------------- licence gate ---------------------------- */

  function licenceKeyOf(ctx) {
    return ctx.cookies?.[config.licence.cookie] ?? null;
  }

  /** Every licensed device gets one account row so the engine runs unchanged. */
  function ensureDeviceAccount(identity) {
    const existing = store.account(identity.id);
    if (existing) return existing;
    const ts = Date.now();
    store.run('INSERT OR IGNORE INTO users (id,email,name,password_hash,salt,role,plan,created_at) VALUES (?,?,?,?,?,?,?,?)',
      identity.id, identity.keyId + '@device.local', identity.label ?? 'Licensed device', 'licence', 'licence', identity.owner ? 'owner' : 'trader', identity.plan ?? 'licensed', ts);
    store.run('INSERT OR IGNORE INTO accounts (user_id,starting_equity,peak_equity,updated_at) VALUES (?,?,?,?)',
      identity.id, config.account.startingEquity, config.account.startingEquity, ts);
    return store.account(identity.id);
  }

  /**
   * The owner's own terminal.
   *
   * The owner already proved who they are with the console passphrase, so they
   * must not also need a licence key — that would mean buying from themselves,
   * and a quota would lock the owner out of their own account mid-session.
   * This identity is unlimited by construction, never by a setting that could be
   * misconfigured.
   */
  const OWNER_IDENTITY = { id: 'lic_owner', keyId: 'owner', plan: 'owner', label: 'Owner' };

  function requireLicence(ctx, { metered = false, cost = 1 } = {}) {
    // An owner session wins over any licence cookie: it is the stronger proof.
    if (isOwner(ctx)) {
      ensureDeviceAccount(OWNER_IDENTITY);
      return {
        ...OWNER_IDENTITY,
        quota: null,
        used: 0,
        remaining: null,
        daysLeft: null,
        expiresAt: null,
        owner: true,
      };
    }
    const key = licenceKeyOf(ctx);
    if (!key) throw new HttpError(401, 'this device is not activated', 'NOT_ACTIVATED');
    const check = metered ? licensing.consume(key, Math.max(1, Number(cost) || 1)) : licensing.validate(key);
    if (!check.ok) {
      const reason = check.reasons?.[0] ?? 'invalid';
      const map = {
        expired: [403, 'licence expired', 'LICENCE_EXPIRED'],
        quota_exhausted: [402, 'quota exhausted for this period', 'QUOTA_EXHAUSTED'],
        revoked: [403, 'licence revoked', 'LICENCE_REVOKED'],
        bad_signature: [403, 'licence signature is invalid', 'LICENCE_INVALID'],
        malformed: [400, 'licence key is malformed', 'LICENCE_MALFORMED'],
        missing: [401, 'this device is not activated', 'NOT_ACTIVATED'],
        unknown_key: [403, 'this key was not issued by this owner', 'LICENCE_UNKNOWN'],
      };
      const [status, message, code] = map[reason] ?? [403, 'licence rejected', 'LICENCE_REJECTED'];
      throw new HttpError(status, message, code, { licence: check });
    }
    const identity = {
      id: 'lic_' + check.keyId,
      keyId: check.keyId,
      plan: check.plan,
      label: check.label ?? 'Licensed device',
      quota: check.quota,
      used: check.used,
      remaining: check.remaining,
      daysLeft: check.daysLeft,
      expiresAt: check.expiresAt,
      owner: false,
    };
    ensureDeviceAccount(identity);
    return identity;
  }

  function accessIdFor(keyId) { return `LV-${String(keyId).toUpperCase()}`; }
  function accessCodeHash(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
  function issueAccessCode(keyId) {
    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    store.setSetting(`lic_${keyId}`, 'login_handoff', { hash: accessCodeHash(code), issuedAt: Date.now() });
    return code;
  }

  function licenceCookie(ctx, value, maxAge = 400 * 24 * 3600) {
    const crossSite = Boolean(config.deploy?.frontendOrigin);
    return cookie(config.licence.cookie, value, { maxAge, secure: ctx.secure || crossSite, sameSite: crossSite ? 'None' : 'Lax', httpOnly: true });
  }

  function ownerCookie(ctx, value, maxAge = OWNER_SESSION_SECONDS) {
    const crossSite = Boolean(config.deploy?.frontendOrigin);
    return cookie(config.licence.ownerCookie, value, { maxAge, secure: ctx.secure || crossSite, sameSite: crossSite ? 'None' : 'Lax', httpOnly: true });
  }

  /* --------------------- support rooms (chat → telegram) ------------------- */

  /**
   * Every user chat becomes a numbered support room. The owner sees the room
   * card (name, registered date, broker, login — never credentials) and replies
   * with /reply <room> <text> via the Telegram bot; the message lands in the
   * user's dashboard chat. Fire-and-forget: chat must never block on Telegram.
   */
  async function notifySupportMessage(user, text, role) {
    try {
      if (role !== 'user') return;
      const token = config.deploy?.telegram?.token || process.env.LUMINA_TELEGRAM_TOKEN || '';
      const chat = config.deploy?.telegram?.chat || process.env.LUMINA_TELEGRAM_CHAT || '';
      if (!token || !chat) return;
      const roomId = store.getSetting(user.id, 'support_room', null);
      const account = store.account(user.id);
      const profile = brokerProfilePublic(user.id);
      const esc = (v) => String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      const header = [
        '💬 <b>Room #' + roomId + '</b> — ' + esc(user.label || user.keyId),
        'Plan: ' + esc(user.plan) + ' · Positions: ' + store.openPositions(user.id).length,
        'Broker: ' + esc(profile.broker || 'belum connect') + ' · Login: ' + esc(profile.login || '-') + ' · Status: ' + esc(profile.status || 'not_connected'),
        '',
      ].join('\n');
      fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: header + esc(text), parse_mode: 'HTML', disable_web_page_preview: true }),
      }).catch(() => {});
    } catch { /* never block the chat on a relay failure */ }
  }

  function supportRoomFor(userId) {
    const room = store.getSetting(userId, 'support_room', null);
    if (room) return room;
    const count = (store.all("SELECT COUNT(DISTINCT user_id) c FROM settings WHERE key = 'support_room'")[0]?.c ?? 0) + 1;
    return count;
  }

  /**
   * Same-origin guard for state-changing verbs (CSRF).
   *
   * The host a request was *addressed* to is not the host the browser thinks it
   * is talking to. Behind the edge proxy the Worker rewrites `host` to the origin
   * it forwards to, so comparing Origin to that host rejected every browser POST
   * on the public domain with 403 'cross-origin request blocked' — which is
   * exactly what the owner console hit on Unlock.
   *
   * The hosts the proxy may report are therefore trusted too, but only the hosts
   * this deployment actually uses: an explicit allow-list, never a wildcard.
   */
  function checkOrigin(req, ctx) {
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients (curl, tests, CLI) have no Origin
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, 'bad origin', 'CSRF');
    }
    if (allowedOrigins.has(origin.replace(/\/+$/, ''))) return; // configured frontend
    const host = String(req.headers.host || '');
    if (parsed.host === host) return; // genuine same-origin
    // Behind the proxy: the public host is forwarded, the internal one is not.
    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    if (forwarded && parsed.host === forwarded) return;
    // Deliberately no comparison against this server's own host beyond the one
    // above: that check passes for *any* Origin whenever the deployment host is
    // trusted, which would turn the guard into a no-op.
    throw new HttpError(403, 'cross-origin request blocked', 'CSRF');
  }

  /* ----------------------- encrypted broker profiles ---------------------- */

  function credentialKey() {
    const secret = String(config.credentialSecret ?? '');
    if (secret.length < 32) throw new HttpError(503, 'customer broker storage is not configured', 'CREDENTIAL_STORAGE_UNAVAILABLE');
    return crypto.createHash('sha256').update(secret).digest();
  }

  function encryptCredential(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: ciphertext.toString('base64url') });
  }

  function brokerProfilePublic(userId) {
    const profile = store.getSetting(userId, 'broker_profile', null);
    if (!profile) return { connected: false, status: 'not_connected' };
    return { connected: true, status: profile.status ?? 'pending', broker: profile.broker, server: profile.server, login: profile.login, updatedAt: profile.updatedAt, gateway: profile.gateway ?? null };
  }

  /* ---------------------------- account currency --------------------------- */

  /**
   * What the broker says the account is denominated in.
   *
   * Global config defaults to USD, which is a lie for a ringgit account. The
   * broker is the only authority here, so ask it, keep the answer for a minute
   * to avoid a network call per poll, and fall back to config when it cannot be
   * reached — never invent a currency.
   */
  let currencyCache = { at: 0, value: null };

  async function accountCurrency() {
    const fallback = { currency: config.account?.currency ?? 'USD', source: 'config' };
    if (!broker || !broker.configured) return fallback;
    if (Date.now() - currencyCache.at < 60_000 && currencyCache.value) return currencyCache.value;
    try {
      const acc = await broker.account();
      const code = String(acc?.currency ?? acc?.Currency ?? '').toUpperCase();
      if (!/^[A-Z]{3,5}$/.test(code)) return fallback;
      const value = {
        currency: code,
        balance: Number(acc?.balance ?? acc?.Balance ?? NaN),
        equity: Number(acc?.equity ?? acc?.Equity ?? NaN),
        leverage: Number(acc?.leverage ?? acc?.Leverage ?? NaN),
        margin: Number(acc?.margin ?? acc?.Margin ?? NaN),
        freeMargin: Number(acc?.margin_free ?? acc?.freeMargin ?? acc?.FreeMargin ?? NaN),
        marginLevel: Number(acc?.margin_level ?? acc?.marginLevel ?? acc?.MarginLevel ?? NaN),
        profit: Number(acc?.profit ?? acc?.Profit ?? NaN),
        name: acc?.name ?? acc?.Name ?? null,
        login: acc?.login ?? acc?.Login ?? config.mt5?.login ?? null,
        server: acc?.server ?? acc?.Server ?? config.mt5?.server ?? null,
        source: 'broker',
      };
      for (const k of ['balance', 'equity', 'leverage', 'margin', 'freeMargin', 'marginLevel', 'profit']) if (!Number.isFinite(value[k])) value[k] = null;
      currencyCache = { at: Date.now(), value };
      return value;
    } catch (e) {
      logger.warn?.(`[currency] broker account unavailable: ${e.message}`);
      return fallback;
    }
  }

  function userTradingPrefs(user) {
    try { return store.getSetting(user.id, 'preferences', {}) ?? {}; } catch { return {}; }
  }

  function selectedWatchlist(user) {
    const base = Array.isArray(config.watchlist) ? config.watchlist : [];
    try {
      const raw = store.getSetting(user.id, 'execution', null);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved?.mode === 'single' && saved.symbol) return base.filter((w) => w.symbol === saved.symbol);
      if (saved?.mode === 'custom' && Array.isArray(saved.symbols)) {
        const wanted = new Set(saved.symbols);
        return base.filter((w) => wanted.has(w.symbol));
      }
    } catch { /* invalid scope falls back to the complete watchlist */ }
    return base;
  }

  function activeAccountSummary() {
    try {
      const id = store.getSetting('owner', 'active_mt5_account', null);
      if (!id) return null;
      const acc = (store.getSetting('owner', 'mt5_accounts', []) ?? []).find((a) => a.id === id);
      return acc ? { label: acc.label, login: acc.login, server: acc.server } : null;
    } catch { return null; }
  }

  /** Assemble everything the terminal needs in one round trip. */
  async function terminalState(user) {
    const activeWatchlist = selectedWatchlist(user);
    const preferences = userTradingPrefs(user);
    const account = store.account(user.id);
    // The configured MT5 gateway belongs to the owner. A licence token must
    // never inherit its balance, currency, margin or login. Customer broker
    // profiles stay pending until a dedicated gateway is assigned.
    const customerProfile = user.owner ? null : brokerProfilePublic(user.id);
    const ownerBrokerMoney = user.owner ? await accountCurrency() : { currency: config.account?.currency ?? 'USD', source: 'paper', balance: null, equity: null, leverage: null, margin: null, freeMargin: null, marginLevel: null, profit: null };
    const money = ownerBrokerMoney;
    const positions = store.openPositions(user.id);
    const quotes = (engine.lastQuotes ?? []).length ? engine.lastQuotes : await refreshQuotesSafe();
    const marks = Object.fromEntries(quotes.map((q) => [q.symbol, q.price]));
    const enriched = positions.map((p) => {
      const mark = marks[p.symbol] ?? p.entry;
      const move = p.side === 'long' ? mark - p.entry : p.entry - mark;
      return {
        ...p,
        mark,
        unrealised: Number((move * p.qty).toFixed(2)),
        unrealisedPct: Number(((move / p.entry) * 100).toFixed(2)),
        rMultiple: p.stop ? Number((move / Math.abs(p.entry - p.stop)).toFixed(2)) : null,
        notional: Number((mark * p.qty).toFixed(2)),
      };
    });
    const unrealised = enriched.reduce((a, p) => a + p.unrealised, 0);
    let equity = (account?.starting_equity ?? config.account.startingEquity) + (account?.realized_pnl ?? 0) + unrealised;
    let balance = (account?.starting_equity ?? 0) + (account?.realized_pnl ?? 0);

    // Once a real account is connected, the broker's own balance and equity are
    // the truth. Showing the paper ledger's 10,000 next to a MYR 956 balance was
    // the last place where the terminal and the broker disagreed, and every risk
    // percentage is computed from it, so it also sized trades wrongly.
    const liveAccount = Boolean(user.owner) && Boolean(account?.live_enabled) && Boolean(config.live) && Boolean(broker?.configured);
    if (liveAccount && Number.isFinite(money.equity) && money.equity > 0) {
      equity = money.equity;
      balance = Number.isFinite(money.balance) ? money.balance : money.equity - unrealised;
    }
    const riskReport = engine.risk.report({
      equity,
      openPositions: positions,
      dayPnl: account?.day_pnl ?? 0,
      startingEquity: account?.starting_equity ?? config.account.startingEquity,
    });

    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayTrades = store.get('SELECT COUNT(*) c FROM orders WHERE user_id = ? AND created_at >= ?', user.id, dayStart.getTime())?.c ?? 0;

    return {
      licence: { plan: user.plan, quota: user.quota ?? null, used: user.used ?? 0, remaining: user.remaining ?? null, daysLeft: user.daysLeft ?? null, label: user.label },
      account: {
        currency: money.currency,
        currencySource: money.source,
        brokerBalance: money.balance,
        brokerMargin: money.margin,
        brokerFreeMargin: money.freeMargin,
        brokerMarginLevel: money.marginLevel,
        brokerFloatingPnl: money.profit,
        equity: Number(equity.toFixed(2)),
        balance: Number(balance.toFixed(2)),
        startingEquity: account?.starting_equity ?? config.account.startingEquity,
        realizedPnl: Number((account?.realized_pnl ?? 0).toFixed(2)),
        dayPnl: Number((account?.day_pnl ?? 0).toFixed(2)),
        unrealised: Number(unrealised.toFixed(2)),
        feesPaid: Number((account?.fees_paid ?? 0).toFixed(2)),
        liveEnabled: Boolean(user.owner && account?.live_enabled),
        connectedAccounts: user.owner ? (broker?.configured ? 1 : 0) : (customerProfile?.status === 'connected' ? 1 : 0),
        brokerConnection: user.owner ? (broker?.configured ? 'connected' : 'not_configured') : (customerProfile?.status ?? 'not_connected'),
        dayTrades,
      },
      quotes,
      positions: enriched,
      signals: store.latestSignalPerSymbol(user.id),
      recentSignals: store.signals(user.id, 20),
      orders: store.orders(user.id, 30),
      risk: riskReport,
      equityCurve: store.equityCurve(user.id, 240),
      engine: { ...engine.status(), timeframe: preferences.timeframe || engine.status().timeframe },
      preferences,
      autoTrade: store.getSetting(user.id, 'autoTrade', true),
      live: {
        enabled: Boolean(user.owner && account?.live_enabled),
        broker: user.owner ? config.broker : null,
        configured: Boolean(user.owner && config.live && broker && broker.configured),
        mode: user.owner && account?.live_enabled && config.live && broker ? 'live' : 'paper',
        activeAccount: user.owner ? activeAccountSummary() : null,
        minConfidence: config.account.minConfidence,
        minRR: config.account.minRewardRisk,
      },
      analyst: { mode: analyst.mode, provider: analyst.providerLabel },
      watchlist: activeWatchlist,
      executionScope: (() => {
        try { return JSON.parse(store.getSetting(user.id, 'execution', null) ?? 'null') ?? { mode: 'all' }; } catch { return { mode: 'all' }; }
      })(),
      marketHealth: market.healthReport(),
      serverTime: Date.now(),
    };
  }

  async function refreshQuotesSafe() {
    try {
      return await engine.refreshQuotes();
    } catch {
      return [];
    }
  }

  /* -------------------------------- auth -------------------------------- */

  /* ------------------------------- licensing ------------------------------ */

  /**
   * Activation. The key is exchanged for a long-lived HttpOnly cookie so the
   * customer types it once, and the key itself never sits in localStorage where
   * any XSS could read it.
   */
  router.post('/api/licence/activate', async (ctx) => {
    const lim = authLimiter.check(`activate:${ctx.ip}`);
    if (!lim.ok) throw new HttpError(429, `too many attempts, retry in ${lim.retryAfter}s`, 'RATE_LIMITED');
    const { key } = ctx.body ?? {};
    const check = licensing.validate(key);
    if (!check.ok) {
      const reason = check.reasons?.[0] ?? 'invalid';
      licensing.event(null, 'activation_failed', { reason }, ctx.ip);
      const map = {
        expired: [403, 'that licence has expired', 'LICENCE_EXPIRED'],
        quota_exhausted: [402, 'that licence has no quota left', 'QUOTA_EXHAUSTED'],
        revoked: [403, 'that licence was revoked', 'LICENCE_REVOKED'],
        bad_signature: [403, 'that key is not genuine', 'LICENCE_INVALID'],
        malformed: [400, 'that does not look like a licence key', 'LICENCE_MALFORMED'],
        unknown_key: [403, 'that key was not issued by this owner', 'LICENCE_UNKNOWN'],
      };
      const [status, message, code] = map[reason] ?? [403, 'licence rejected', 'LICENCE_REJECTED'];
      throw new HttpError(status, message, code, { reasons: check.reasons });
    }
    licensing.event(check.keyId, 'activated', { plan: check.plan }, ctx.ip);
    ctx.resHeaders.push(licenceCookie(ctx, key));
    ensureDeviceAccount({ id: `lic_${check.keyId}`, keyId: check.keyId, plan: check.plan, label: check.label ?? 'Licensed device' });
    const accessCode = issueAccessCode(check.keyId);

    // Tell the owner, with everything that identifies the device. This is a
    // record of an activation, not a request for permission: the licence is
    // already valid and the cookie is already set, so a notification failure
    // must never delay or block the customer.
    const hints = ctx.body?.device ?? {};
    notifyActivation(ctx, {
      plan: check.plan,
      keyId: check.keyId,
      label: check.label ?? null,
      quota: check.quota ?? null,
      used: check.used ?? 0,
      expiresAt: check.expiresAt ?? null,
      device: {
        name: String(hints.name || 'tidak dikenali').slice(0, 60),
        os: String(hints.os || '?').slice(0, 60),
        browser: String(hints.browser || '').slice(0, 60),
        fingerprint: String(hints.fingerprint || '').slice(0, 64),
      },
      ip: ctx.ip,
    });

    return { ok: true, licence: publicLicence(check), login: { id: accessIdFor(check.keyId), code: accessCode } };
  });

  /** Device two login: ID is public-ish, code is the actual secret. */
  router.post('/api/login', async (ctx) => {
    const lim = authLimiter.check(`login:${ctx.ip}`);
    if (!lim.ok) throw new HttpError(429, `too many attempts, retry in ${lim.retryAfter}s`, 'RATE_LIMITED');
    const rawId = String(ctx.body?.id ?? '').trim().toUpperCase();
    const code = String(ctx.body?.code ?? '').trim().toUpperCase();
    const keyId = rawId.replace(/^LV-/, '').toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(keyId) || !/^[A-F0-9]{16}$/.test(code)) throw new HttpError(401, 'login ID or access code is invalid', 'LOGIN_INVALID');
    const saved = store.getSetting(`lic_${keyId}`, 'login_handoff', null);
    if (!saved?.hash || !crypto.timingSafeEqual(Buffer.from(saved.hash), Buffer.from(accessCodeHash(code)))) throw new HttpError(401, 'login ID or access code is invalid', 'LOGIN_INVALID');
    const key = licensing.readableKeyForId(keyId);
    const check = licensing.validate(key);
    if (!check.ok) throw new HttpError(403, 'licence is no longer active', 'LICENCE_REJECTED');
    ctx.resHeaders.push(licenceCookie(ctx, key));
    ensureDeviceAccount({ id: `lic_${keyId}`, keyId, plan: check.plan, label: check.label ?? 'Licensed device' });
    licensing.event(keyId, 'device_login', { accessId: accessIdFor(keyId) }, ctx.ip);
    return { ok: true, licence: publicLicence(check) };
  });

  /** Who am I — used on boot to decide between the activation screen and the app. */
  router.get('/api/licence', async (ctx) => {
    // The owner is always active on their own terminal; the UI reads this on boot
    // to choose between the activation screen and the dashboard.
    if (isOwner(ctx)) {
      return {
        active: true,
        owner: true,
        licence: { plan: 'owner', quota: null, used: 0, remaining: null, daysLeft: null, expiresAt: null, label: 'Owner' },
        reasons: [],
      };
    }
    const key = licenceKeyOf(ctx);
    if (!key) return { active: false, licence: null };
    const check = licensing.validate(key);
    return { active: check.ok, licence: check.ok ? publicLicence(check) : { reasons: check.reasons }, reasons: check.ok ? [] : check.reasons };
  });

  router.post('/api/licence/deactivate', async (ctx) => {
    ctx.resHeaders.push(licenceCookie(ctx, '', 0));
    return { ok: true };
  });

  /* -------------------------------- owner ------------------------------- */

  /**
   * The owner panel. Guarded by a separate passphrase (LUMINA_OWNER_SECRET),
   * never by a licence key: an owner who also holds a customer key must not be
   * able to mint more keys with it.
   */
  router.post('/api/owner/login', async (ctx) => {
    const lim = authLimiter.check(`owner:${ctx.ip}`);
    if (!lim.ok) throw new HttpError(429, 'too many attempts', 'RATE_LIMITED');
    const { passphrase } = ctx.body ?? {};
    if (!licensing.checkOwner(passphrase)) {
      store.audit({ userId: null, actor: 'owner', action: 'owner_login_failed', detail: null, ip: ctx.ip });
      throw new HttpError(401, 'wrong passphrase', 'OWNER_ONLY');
    }
    // The owner session is a short-lived signed cookie, not a stored session.
    ctx.resHeaders.push(ownerCookie(ctx, signOwnerToken(licensing, Date.now())));
    store.audit({ userId: null, actor: 'owner', action: 'owner_login', detail: null, ip: ctx.ip });
    return { ok: true };
  });

  router.post('/api/owner/logout', async (ctx) => {
    ctx.resHeaders.push(ownerCookie(ctx, '', 0));
    return { ok: true };
  });

  router.get('/api/owner/session', async (ctx) => ({ authenticated: isOwner(ctx) }));

  /**
   * The owner console: one self-contained page, no build step. It is served
   * without a session on purpose, because it is only a shell; every byte of
   * data it shows comes from /api/owner/*, which is owner-gated server side.
   * Being public also means it works from any browser, with no Telegram.
   */
  router.get('/console', async (ctx) => {
    const html = ownerConsoleHtml();
    ctx.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // The page is owner-only in practice; keep it out of any frame or index.
      'x-frame-options': 'DENY',
      'x-robots-tag': 'noindex, nofollow',
    });
    return ctx.res.end(html);
  });

  router.get('/api/owner/licences', async (ctx) => {
    requireOwnerSession(ctx);
    return { licences: licensing.list({ limit: 200 }), summary: licensing.summary(), events: licensing.events(80), plans: PLANS };
  });

  router.post('/api/owner/licences', async (ctx) => {
    requireOwnerSession(ctx);
    const { plan, label, quota, days } = ctx.body ?? {};
    if (!PLANS[plan]) throw new HttpError(400, `unknown plan: ${plan}`, 'BAD_PLAN');
    const issued = licensing.issue({
      plan,
      label: label ?? '',
      quota: quota === undefined || quota === null || quota === '' ? null : Number(quota),
      days: days === undefined || days === null || days === '' ? null : Number(days),
    });
    store.audit({ userId: null, actor: 'owner', action: 'licence_issued', detail: { keyId: issued.keyId, plan: issued.plan, quota: issued.quota }, ip: ctx.ip });
    return { licence: issued };
  });

  /**
   * Files exist only for the owner now: a customer's device has no account, so
   * publishing a share link is an owner action. Both routes are owner-gated.
   */
  /**
   * The AI provider as the owner console shows it: mode, base URL, model and a
   * hint for the key. The key itself is never returned, because a browser page
   * is the wrong place for it.
   */
  /* ------------------------------ MT5 gateway ----------------------------- */

  /**
   * Live MT5 status for the owner console.
   *
   * The gateway runs as its own container, so it is reachable only from inside
   * the Docker network. This proxies the read-only calls the console needs and
   * never returns the gateway key or the broker password.
   */
  /**
   * Make our book match the broker's.
   *
   * A live order can execute and still fail to reach us: the gateway is slow
   * enough that the request times out after the fill, or the process restarts
   * in between. That leaves the terminal claiming a flat book while the broker
   * holds real positions — the worst possible disagreement. This reads the
   * broker and imports what we are missing, and closes what the broker no
   * longer has.
   */
  router.post('/api/owner/mt5/sync', async (ctx) => {
    requireOwnerSession(ctx);
    const cfg = config.mt5 ?? {};
    if (!cfg.baseUrl || !cfg.apiKey) throw new HttpError(409, 'MT5 gateway is not configured', 'NOT_CONFIGURED');
    const mt5 = new Mt5Broker(cfg);
    const remote = await mt5.positions();
    const rows = Array.isArray(remote) ? remote : (remote.positions ?? []);
    ensureDeviceAccount(OWNER_IDENTITY);
    const local = store.all("SELECT * FROM positions WHERE status = 'open' AND mode = 'live'");
    const localTickets = new Set(local.map((p) => String(p.broker_order_id ?? '')).filter(Boolean));
    const remoteTickets = new Set(rows.map((r) => String(r.ticket)));

    const imported = [];
    for (const r of rows) {
      if (localTickets.has(String(r.ticket))) continue;
      store.insertPosition({
        userId: OWNER_IDENTITY.id,
        mode: 'live',
        venue: 'mt5',
        symbol: r.symbol,
        side: r.side === 'sell' || r.side === 'short' ? 'short' : 'long',
        qty: Number(r.qty ?? r.volume ?? 0),
        entry: Number(r.entry ?? r.openPrice ?? 0),
        stop: r.stop === undefined || r.stop === null ? null : Number(r.stop),
        target: r.target === undefined || r.target === null ? null : Number(r.target),
        brokerPositionId: String(r.ticket),
        fees: 0,
      });
      imported.push(String(r.ticket));
    }

    const vanished = [];
    for (const p of local) {
      const id = String(p.broker_order_id ?? '');
      if (id && !remoteTickets.has(id)) {
        store.updatePosition(p.id, { status: 'closed', closedAt: Date.now(), exitPrice: p.entry, pnl: 0, exitReason: 'closed_at_broker' });
        vanished.push(id);
      }
    }

    store.audit({ userId: null, actor: 'owner', action: 'mt5_reconciled', detail: { imported: imported.length, vanished: vanished.length }, ip: ctx.ip });
    return { ok: true, brokerPositions: rows.length, imported, vanished };
  });

  router.get('/api/owner/mt5', async (ctx) => {
    requireOwnerSession(ctx);
    const cfg = config.mt5 ?? {};
    const live = await accountCurrency();
    const account = {
      login: live.login || cfg.login || null,
      server: live.server || cfg.server || null,
      label: cfg.label || null,
      currency: live.currency,
      currencySource: live.source,
      balance: live.balance,
      equity: live.equity,
      leverage: live.leverage,
      holder: live.name,
    };
    if (!cfg.baseUrl || !cfg.apiKey) {
      return { configured: false, account, gateway: null, positions: [], symbols: [] };
    }
    const broker = new Mt5Broker(cfg);
    const out = { configured: true, account, gateway: null, positions: [], symbols: [], error: null };
    try {
      const h = await broker.health();
      out.gateway = {
        status: h.status ?? null,
        mt5: h.mt5_status ?? null,
        version: h.version ?? null,
        uptime: h.uptime_seconds ?? null,
        killSwitch: Boolean(h.kill_switch_active),
        lastError: h.last_error ?? null,
        serverTime: h.server_time ?? null,
      };
    } catch (e) {
      out.error = `${e.code ?? 'ERROR'}: ${e.message} (gateway ${cfg.baseUrl})`;
      return out;
    }
    try {
      const acc = await broker.account();
      // Only the fields a person needs, so a schema change cannot dump secrets.
      out.mt5Account = {
        login: acc.login ?? acc.account ?? null,
        name: acc.name ?? null,
        server: acc.server ?? null,
        currency: acc.currency ?? null,
        balance: acc.balance ?? null,
        equity: acc.equity ?? null,
        margin: acc.margin ?? null,
        freeMargin: acc.margin_free ?? null,
        leverage: acc.leverage ?? null,
        profit: acc.profit ?? null,
      };
    } catch (e) {
      out.error = out.error ?? e.message;
    }
    try {
      const pos = await broker.positions();
      out.positions = (pos.positions ?? []).map((p) => ({
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        entry: p.entry,
        stop: p.stop,
        target: p.target,
        pnl: p.pnl,
      }));
    } catch (e) {
      out.error = out.error ?? e.message;
    }
    // The search pattern is a query parameter because a broker's symbol names are
    // its own (EURUSDm, EURUSD.r, XAUUSDm…). Reporting the count and the first few
    // names is how the owner finds out what to use, without a terminal.
    const search = typeof ctx.query?.search === 'string' && ctx.query.search.trim() ? ctx.query.search.trim() : '*';
    try {
      const syms = await broker.symbols(search);
      const list = Array.isArray(syms) ? syms : [];
      out.symbolSearch = search;
      out.symbolCount = list.length;
      out.symbols = list.slice(0, 40).map((x) => x?.name ?? x).filter(Boolean);
      if (!list.length) {
        // Distinguish 'the broker has no symbols yet' from 'the shape changed'.
        const raw = await broker.rawSymbols(search).catch(() => null);
        out.symbolRaw = raw ? JSON.stringify(raw).slice(0, 400) : null;
      }
    } catch (e) {
      out.symbolError = e.message;
    }
    return out;
  });

  /**
   * Candles straight from MT5, so the owner can prove the data path works
   * before any analysis depends on it.
   *
   * The symbol is passed through untouched: a broker names its own instruments
   * (EURUSD.s here, EURUSDm elsewhere) and guessing would silently read the
   * wrong market.
   */
  /* ------------------------------- AI settings ----------------------------- */

  /**
   * The AI provider, settable from the console.
   *
   * Until now the only way to set it was /aiurl and /aikey in Telegram, which
   * write to the Worker's D1 — a different store from this backend, so the
   * console kept showing the environment value and nothing appeared to happen.
   * These two routes write where the analyst actually reads.
   */
  const AI_KEYS = ['baseUrl', 'model', 'apiKey', 'provider', 'enabled'];

  function aiSettingsNow() {
    const key = String(config.ai.apiKey || '');
    return {
      provider: config.ai.provider || 'local',
      baseUrl: config.ai.baseUrl || '',
      model: config.ai.model || '',
      enabled: Boolean(key) && config.ai.provider !== 'local',
      mode: analyst.mode,
      label: analyst.providerLabel,
      keyHint: key ? `…${key.slice(-4)}` : '',
      hasKey: Boolean(key),
    };
  }

  /**
   * Close positions left on instruments that are no longer watched.
   *
   * These are orphans: their symbol has no quote any more, so they can never be
   * marked, never be closed at a price, and they hold every position slot open
   * forever. They are closed at their own entry, which is the only honest price
   * available, with P/L zero and a reason on the record.
   */
  router.post('/api/owner/positions/purge', async (ctx) => {
    requireOwnerSession(ctx);
    const watched = new Set((config.watchlist ?? []).map((w) => w.symbol));
    const open = store.all("SELECT * FROM positions WHERE status = 'open'");
    const orphans = open.filter((p) => !watched.has(p.symbol));
    if (ctx.body?.dryRun === true) {
      return { ok: true, dryRun: true, wouldClose: orphans.length, symbols: [...new Set(orphans.map((p) => p.symbol))] };
    }
    let closed = 0;
    for (const pos of orphans) {
      try {
        await engine.paper().close({ userId: pos.user_id, position: pos, price: pos.entry, reason: 'stale_symbol', recentVolume: 0 });
        closed += 1;
      } catch (e) {
        logger.warn?.(`[purge] could not close ${pos.id}: ${e.message}`);
      }
    }
    store.audit({ userId: null, actor: 'owner', action: 'positions_purged', detail: { closed, symbols: [...new Set(orphans.map((p) => p.symbol))] }, ip: ctx.ip });
    return { ok: true, closed, remaining: store.all("SELECT id FROM positions WHERE status = 'open'").length };
  });

  /* --------------------------- owner: the engine --------------------------- */

  /**
   * What the engine is doing, and why nothing was traded.
   *
   * 'no signals' is the answer people actually need when auto-trade appears idle,
   * so the last cycle's decision is returned with the plan reason for each
   * instrument, not just a running flag.
   */
  router.get('/api/owner/engine', async (ctx) => {
    requireOwnerSession(ctx);
    const quotes = engine.lastQuotes ?? [];
    return {
      engine: engine.status(),
      autoTrade: store.getSetting(OWNER_IDENTITY.id, 'autoTrade', true),
      instruments: selectedWatchlist(OWNER_IDENTITY).map((w) => ({ symbol: w.symbol, venue: w.venue, price: quotes.find((q) => q.symbol === w.symbol)?.price ?? null })),
      signals: store.latestSignalPerSymbol(OWNER_IDENTITY.id),
      live: config.account?.live === true || config.live === true,
      ...(await accountCurrency().then((a) => ({ currency: a.currency, balance: a.balance, leverage: a.leverage }))),
    };
  });

  router.post('/api/owner/engine', async (ctx) => {
    requireOwnerSession(ctx);
    const body = ctx.body ?? {};
    if (body.action === 'start') engine.start();
    if (body.action === 'stop') engine.stop();
    if (typeof body.autoTrade === 'boolean') store.setSetting(OWNER_IDENTITY.id, 'autoTrade', body.autoTrade);
    store.audit({ userId: null, actor: 'owner', action: 'engine_control', detail: { action: body.action ?? null, autoTrade: body.autoTrade ?? null }, ip: ctx.ip });
    return { ok: true, engine: engine.status(), autoTrade: store.getSetting(OWNER_IDENTITY.id, 'autoTrade', true) };
  });

  /** Run one cycle immediately, so 'test now' does not mean 'wait a minute'. */
  router.post('/api/owner/engine/run', async (ctx) => {
    requireOwnerSession(ctx);
    ensureDeviceAccount(OWNER_IDENTITY);
    const result = await engine.runCycle({ userIds: [OWNER_IDENTITY.id], force: true });
    store.audit({ userId: null, actor: 'owner', action: 'engine_run_now', detail: result, ip: ctx.ip });
    return { ok: true, result, signals: store.latestSignalPerSymbol(OWNER_IDENTITY.id) };
  });

  /* -------------------------- owner: the position book --------------------- */

  /** Every open position on the deployment, so the owner can flatten one. */
  router.get('/api/owner/positions', async (ctx) => {
    requireOwnerSession(ctx);
    const quotes = engine.lastQuotes ?? [];
    const marks = Object.fromEntries(quotes.map((q) => [q.symbol, q.price]));
    const rows = store.all("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC LIMIT 200");
    return {
      positions: rows.map((p) => {
        const mark = marks[p.symbol] ?? p.entry;
        const move = p.side === 'long' ? mark - p.entry : p.entry - mark;
        return { ...p, mark, unrealised: Number((move * p.qty).toFixed(2)) };
      }),
      total: rows.length,
    };
  });

  router.post('/api/owner/positions/:id/close', async (ctx) => {
    requireOwnerSession(ctx);
    const pos = store.get("SELECT * FROM positions WHERE id = ? AND status = 'open'", ctx.params.id);
    if (!pos) throw new HttpError(404, 'open position not found', 'NOT_FOUND');
    const quotes = (engine.lastQuotes ?? []).length ? engine.lastQuotes : await refreshQuotesSafe();
    const quote = quotes.find((q) => q.symbol === pos.symbol);
    if (!quote) throw new HttpError(503, 'no live quote for this symbol right now', 'STALE_DATA');
    const res = pos.mode === 'live' && broker
      ? await broker.close({ symbol: pos.symbol, qty: pos.qty, side: pos.side, positionId: pos.broker_position_id })
      : await engine.paper().close({ userId: pos.user_id, position: pos, price: quote.price, reason: 'owner', recentVolume: quote.volume ?? 0 });
    if (pos.mode === 'live') {
      const exitPrice = res.price ?? quote.price;
      const pnl = pos.side === 'long' ? (exitPrice - pos.entry) * pos.qty : (pos.entry - exitPrice) * pos.qty;
      store.updatePosition(pos.id, { status: 'closed', exitPrice, pnl, closedAt: Date.now(), closeReason: 'owner' });
      store.addRealized(pos.user_id, pnl, 0);
      res.pnl = pnl; res.exitPrice = exitPrice;
    }
    store.audit({ userId: null, actor: 'owner', action: 'position_closed_by_owner', detail: { id: pos.id, symbol: pos.symbol, pnl: res.pnl }, ip: ctx.ip });
    bus.emit('position', { action: 'close', symbol: pos.symbol, reason: 'owner', pnl: res.pnl });
    return { ok: true, ...res };
  });

  /* --------------------------------- style -------------------------------- */

  /**
   * How the owner wants to trade.
   *
   * The timeframe, the reward the engine looks for and how tight it wants the
   * stop are one decision, not three, so they move together. Each preset sets
   * the loop timeframe every consumer already reads.
   */
  const STYLES = {
    scalping: { timeframe: '5m', minRewardRisk: 1.2, minConfidence: 58, cooldownMinutes: 5, dailyTradeCap: 60, label: 'Scalping · 5m' },
    intraday: { timeframe: '15m', minRewardRisk: 1.5, minConfidence: 60, cooldownMinutes: 15, dailyTradeCap: 24, label: 'Intraday · 15m' },
    swing: { timeframe: '4h', minRewardRisk: 2.2, minConfidence: 66, cooldownMinutes: 240, dailyTradeCap: 6, label: 'Swing · 4h' },
  };

  function styleNow() {
    const tf = config.loop?.timeframe ?? '1h';
    const found = Object.entries(STYLES).find(([, v]) => v.timeframe === tf);
    return { style: found ? found[0] : 'custom', timeframe: tf, presets: STYLES };
  }

  function applyStyle(name) {
    const preset = STYLES[String(name ?? '').toLowerCase()];
    if (!preset) throw new HttpError(400, `unknown style; choose one of ${Object.keys(STYLES).join(', ')}`, 'BAD_STYLE');
    config.loop.timeframe = preset.timeframe;
    engine.risk.policy.minRewardRisk = preset.minRewardRisk;
    engine.risk.policy.minConfidence = preset.minConfidence;
    engine.risk.policy.cooldownMinutes = preset.cooldownMinutes;
    engine.risk.policy.dailyTradeCap = preset.dailyTradeCap;
    store.setSetting(AI_SETTINGS_OWNER, 'style', String(name).toLowerCase());
    return preset;
  }

  function loadStyle() {
    try {
      const saved = store.getSetting(AI_SETTINGS_OWNER, 'style', null);
      if (saved && STYLES[saved]) {
        const p = STYLES[saved];
        config.loop.timeframe = p.timeframe;
        engine.risk.policy.minRewardRisk = p.minRewardRisk;
        engine.risk.policy.minConfidence = p.minConfidence;
        engine.risk.policy.cooldownMinutes = p.cooldownMinutes;
        engine.risk.policy.dailyTradeCap = p.dailyTradeCap;
      }
    } catch {
      /* a corrupt setting must not stop the server booting */
    }
  }

  router.get('/api/owner/style', async (ctx) => {
    requireOwnerSession(ctx);
    return styleNow();
  });

  router.post('/api/owner/style', async (ctx) => {
    requireOwnerSession(ctx);
    const preset = applyStyle(ctx.body?.style);
    store.audit({ userId: null, actor: 'owner', action: 'trading_style_set', detail: { style: ctx.body?.style, preset }, ip: ctx.ip });
    return { ok: true, ...styleNow() };
  });

  /* ------------------------- execution scope ----------------------------- */

  router.get('/api/owner/execution', async (ctx) => {
    requireOwnerSession(ctx);
    let saved = null;
    try { saved = JSON.parse(store.getSetting(OWNER_IDENTITY.id, 'execution', null) ?? 'null'); } catch {}
    return { mode: saved?.mode ?? 'all', symbol: saved?.symbol ?? null, symbols: saved?.symbols ?? [], available: config.watchlist.map((w) => w.symbol) };
  });

  router.post('/api/owner/execution', async (ctx) => {
    requireOwnerSession(ctx);
    const body = ctx.body ?? {};
    const mode = String(body.mode ?? 'all').toLowerCase();
    if (!['all', 'single', 'custom'].includes(mode)) throw new HttpError(400, 'mode must be all, single or custom', 'BAD_SCOPE');
    const available = new Set(config.watchlist.map((w) => w.symbol));
    const symbols = Array.isArray(body.symbols) ? [...new Set(body.symbols.map(String).filter((x) => available.has(x)))] : [];
    const symbol = available.has(String(body.symbol ?? '')) ? String(body.symbol) : null;
    if (mode === 'single' && !symbol) throw new HttpError(400, 'single mode needs a watched symbol', 'BAD_SCOPE');
    if (mode === 'custom' && !symbols.length) throw new HttpError(400, 'custom mode needs at least one watched symbol', 'BAD_SCOPE');
    const value = { mode, symbol, symbols };
    store.setSetting(OWNER_IDENTITY.id, 'execution', JSON.stringify(value));
    store.audit({ userId: null, actor: 'owner', action: 'execution_scope_updated', detail: value, ip: ctx.ip });
    return { ok: true, ...value, available: [...available] };
  });

  /* --------------------------------- risk --------------------------------- */

  /**
   * The owner's risk envelope.
   *
   * These numbers decide whether a ticket is allowed at all, so they belong to
   * the person who owns the account, not to a constant in the source. Every
   * value is clamped to a sane band: a typo must not turn the engine into a
   * casino, and a zero must not divide by zero later.
   */
  const RISK_FIELDS = {
    maxRiskPerTradePct: { key: 'maxRiskPerTrade', scale: 0.01, min: 0.05, max: 10 },
    maxDailyLossPct: { key: 'maxDailyLoss', scale: 0.01, min: 0, max: 50 }, // 0 = no daily stop
    maxPortfolioHeatPct: { key: 'maxPortfolioHeat', scale: 0.01, min: 0, max: 50 }, // 0 = no cap
    maxOpenPositions: { key: 'maxOpenPositions', scale: 1, min: 0, max: 500, int: true }, // 0 = unlimited
    maxEntriesPerSymbol: { key: 'maxEntriesPerSymbol', scale: 1, min: 1, max: 20, int: true },
    maxLeverage: { key: 'maxLeverage', scale: 1, min: 0, max: 500 }, // 0 = no cap
    dailyTradeCap: { key: 'dailyTradeCap', scale: 1, min: 0, max: 5000, int: true }, // 0 = no cap
    cooldownMinutes: { key: 'cooldownMinutes', scale: 1, min: 0, max: 1440 },
    minConfidence: { key: 'minConfidence', scale: 1, min: 0, max: 100 },
    minRewardRisk: { key: 'minRewardRisk', scale: 1, min: 0, max: 20 },
  };

  function riskLimitsNow() {
    const p = engine.risk.policy;
    return Object.fromEntries(
      Object.entries(RISK_FIELDS).map(([name, f]) => [name, Number((p[f.key] / f.scale).toFixed(4))]),
    );
  }

  function applyRiskLimits(values) {
    const applied = {};
    for (const [name, f] of Object.entries(RISK_FIELDS)) {
      const raw = Number(values?.[name]);
      if (!Number.isFinite(raw)) continue;
      let v = Math.min(f.max, Math.max(f.min, raw));
      if (f.int) v = Math.round(v);
      const scaled = Number((v * f.scale).toFixed(8));
      engine.risk.policy[f.key] = scaled;
      config.account[f.key] = scaled;
      applied[name] = v;
    }
    return applied;
  }

  function loadRiskLimits() {
    try {
      const raw = store.getSetting(AI_SETTINGS_OWNER, 'risk', null);
      if (raw) applyRiskLimits(JSON.parse(raw));
    } catch {
      /* a corrupt setting must not stop the server booting */
    }
  }

  router.get('/api/owner/risk', async (ctx) => {
    requireOwnerSession(ctx);
    loadRiskLimits();
    return { limits: riskLimitsNow(), bounds: Object.fromEntries(Object.entries(RISK_FIELDS).map(([k, f]) => [k, { min: f.min, max: f.max }])) };
  });

  router.post('/api/owner/risk', async (ctx) => {
    requireOwnerSession(ctx);
    const applied = applyRiskLimits(ctx.body ?? {});
    if (!Object.keys(applied).length) throw new HttpError(400, 'no known risk limit was sent', 'BAD_REQUEST');
    store.setSetting(AI_SETTINGS_OWNER, 'risk', JSON.stringify(riskLimitsNow()));
    store.audit({ userId: null, actor: 'owner', action: 'risk_limits_updated', detail: applied, ip: ctx.ip });
    return { ok: true, limits: riskLimitsNow() };
  });

  /* --------------- aliases the panel uses, over the same ledger ------------- */

  /**
   * /views/owner.js speaks a slightly different vocabulary from the console:
   * /owner/keys instead of /owner/licences. Rather than fork the logic, these
   * forward to the same functions so there is one behaviour, not two.
   */
  router.post('/api/owner/keys', async (ctx) => {
    requireOwnerSession(ctx);
    const { label, plan, quota, days } = ctx.body ?? {};
    const issued = licensing.issue({ label: String(label ?? ''), plan: String(plan ?? 'monthly'), quota, days });
    store.audit({ userId: null, actor: 'owner', action: 'licence_issued', detail: { keyId: issued.keyId, plan: issued.plan }, ip: ctx.ip });
    return { ok: true, ...issued };
  });

  router.post('/api/owner/keys/:keyId/revoke', async (ctx) => {
    requireOwnerSession(ctx);
    const revoked = ctx.body?.revoked ?? true;
    licensing.revoke(ctx.params.keyId, revoked);
    store.audit({ userId: null, actor: 'owner', action: revoked ? 'licence_revoked' : 'licence_restored', detail: ctx.params.keyId, ip: ctx.ip });
    return { ok: true, keyId: ctx.params.keyId, revoked };
  });

  router.post('/api/owner/keys/:keyId/quota', async (ctx) => {
    requireOwnerSession(ctx);
    licensing.setQuota(ctx.params.keyId, ctx.body?.quota ?? null);
    return { ok: true, keyId: ctx.params.keyId, quota: ctx.body?.quota ?? null };
  });

  router.post('/api/owner/keys/:keyId/extend', async (ctx) => {
    requireOwnerSession(ctx);
    const days = Number(ctx.body?.days ?? 30);
    if (!Number.isFinite(days) || days <= 0) throw new HttpError(400, 'days must be a positive number', 'BAD_REQUEST');
    licensing.extend(ctx.params.keyId, days);
    store.audit({ userId: null, actor: 'owner', action: 'licence_extended', detail: { keyId: ctx.params.keyId, days }, ip: ctx.ip });
    return { ok: true, keyId: ctx.params.keyId, days };
  });

  /** The panel's save button posts here; it is the same store as /settings. */
  router.post('/api/owner/ai', async (ctx) => {
    requireOwnerSession(ctx);
    const body = ctx.body ?? {};
    const patch = {};
    if (body.baseUrl !== undefined) {
      const url = String(body.baseUrl).trim().replace(/\/+$/, '');
      if (url && !/^https:\/\//i.test(url)) throw new HttpError(400, 'the base URL must start with https://', 'BAD_URL');
      patch.baseUrl = url;
    }
    if (body.model !== undefined) patch.model = String(body.model).trim().slice(0, 120);
    if (body.provider !== undefined) patch.provider = String(body.provider).trim().toLowerCase();
    if (body.apiKey) patch.apiKey = String(body.apiKey);
    if (body.clearKey === true) patch.apiKey = '';
    saveAiSettings(patch);
    applyAiSettings();
    store.audit({ userId: null, actor: 'owner', action: 'ai_settings_updated', detail: Object.keys(patch), ip: ctx.ip });
    return { ok: true, ...aiSettingsNow() };
  });

  /* --------------------------- owner telemetry ---------------------------- */

  router.get('/api/owner/readiness', async (ctx) => {
    requireOwnerSession(ctx);
    const checks = [];
    const cfg = config.mt5 ?? {};
    let gateway = null;
    if (cfg.baseUrl && cfg.apiKey) {
      try {
        const h = await new Mt5Broker(cfg).health();
        gateway = h;
        checks.push({ id: 'gateway', label: 'MT5 gateway connected', ok: h.mt5_status === 'connected', detail: h.mt5_status ?? h.status ?? 'unknown' });
      } catch (e) { checks.push({ id: 'gateway', label: 'MT5 gateway connected', ok: false, detail: e.message }); }
    } else checks.push({ id: 'gateway', label: 'MT5 gateway configured', ok: false, detail: 'credentials or URL missing' });
    const account = await accountCurrency();
    checks.push({ id: 'currency', label: 'Broker currency detected', ok: account.source === 'broker', detail: account.currency });
    checks.push({ id: 'live', label: 'Live policy enabled', ok: Boolean(config.live && broker?.configured), detail: config.live && broker?.configured ? 'ready' : 'paper only' });
    checks.push({ id: 'isolation', label: 'Customer account isolation', ok: true, detail: 'customer live is blocked until a broker is assigned' });
    checks.push({ id: 'sltp', label: 'SL/TP protection verification', ok: true, detail: 'fills are rejected when protection is not confirmed' });
    checks.push({ id: 'ai', label: 'AI provider', ok: analyst.mode !== 'local', detail: analyst.providerLabel });
    checks.push({ id: 'news', label: 'News feed', ok: Boolean(config.news?.feedUrl), detail: config.news?.feedUrl ? 'configured' : 'not configured' });
    const limits = engine.risk.policy;
    checks.push({ id: 'risk', label: 'Unlimited caps mode', ok: limits.maxDailyLoss === 0 && limits.maxOpenPositions === 0 && limits.maxPortfolioHeat === 0 && limits.maxLeverage === 0 && limits.dailyTradeCap === 0, detail: 'daily=' + limits.maxDailyLoss + ' positions=' + limits.maxOpenPositions + ' heat=' + limits.maxPortfolioHeat + ' leverage=' + limits.maxLeverage });
    const blockers = checks.filter((x) => !x.ok);
    return { ok: blockers.length === 0, checks, blockers, account: { currency: account.currency, balance: account.balance, equity: account.equity }, gateway: gateway ? { status: gateway.status, mt5: gateway.mt5_status } : null, database: { primary: 'sqlite', neonConfigured: Boolean(process.env.DATABASE_URL) } };
  });

  router.get('/api/owner/summary', async (ctx) => {
    requireOwnerSession(ctx);
    const licences = licensing.summary();
    const open = store.openPositions(OWNER_IDENTITY.id);
    const quotes = engine.lastQuotes ?? [];
    return {
      licences,
      engine: engine.status(),
      venues: market.status?.() ?? null,
      account: store.account(OWNER_IDENTITY.id),
      openPositions: open.length,
      instruments: (config.watchlist ?? []).length,
      quoted: quotes.length,
      live: config.account?.live === true,
    };
  });

  router.get('/api/owner/events', async (ctx) => {
    requireOwnerSession(ctx);
    const limit = Math.min(200, Math.max(1, Number(ctx.query?.limit ?? 60)));
    const events = licensing.events(limit);
    const audit = store.auditTrail(limit);
    return { events, audit };
  });

  /* ------------------- owner routes the older panel calls ------------------- */

  /**
   * The owner panel under /views/owner.js was written against an API that only
   * ever existed on the Worker: /owner/keys, /owner/devices, /owner/ai/models,
   * /owner/ai/usage. On this backend they answered 404, so the panel showed
   * 'endpoint not found'. These are the same shapes, backed by the real ledger.
   */
  router.get('/api/owner/keys', async (ctx) => {
    requireOwnerSession(ctx);
    return { keys: licensing.list({ limit: 200 }), summary: licensing.summary() };
  });

  router.get('/api/owner/devices', async (ctx) => {
    requireOwnerSession(ctx);
    // Devices live in the Worker's D1, not here. Report honestly rather than
    // inventing an empty list that looks like 'no devices'.
    return { devices: [], pending: 0, approved: 0, note: 'peranti disimpan pada Worker, bukan backend ini' };
  });

  router.post('/api/owner/devices/:id/:action', async (ctx) => {
    requireOwnerSession(ctx);
    throw new HttpError(501, 'device approval happens in the Telegram bot', 'DEVICES_ON_EDGE');
  });

  router.get('/api/owner/ai/usage', async (ctx) => {
    requireOwnerSession(ctx);
    const rows = store.all('SELECT ts, action, detail FROM audit_log WHERE action LIKE ? ORDER BY ts DESC LIMIT 200', 'ai_%');
    return { usage: rows.map((r) => ({ ts: r.ts, action: r.action, detail: r.detail })) };
  });

  router.post('/api/owner/ai/models', async (ctx) => {
    requireOwnerSession(ctx);
    const baseUrl = String(ctx.body?.baseUrl ?? config.ai.baseUrl ?? '').replace(/\/+$/, '');
    const key = String(ctx.body?.apiKey ?? config.ai.apiKey ?? '');
    if (!baseUrl) throw new HttpError(400, 'a base URL is required', 'BAD_URL');
    if (!/^https:\/\//i.test(baseUrl)) throw new HttpError(400, 'the base URL must start with https://', 'BAD_URL');
    try {
      const res = await fetch(`${baseUrl}/models`, {
        headers: key ? { authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}`, models: [] };
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
      return { ok: true, models: list.map((m) => ({ id: m.id ?? m.name, ownedBy: m.owned_by ?? m.ownedBy ?? null })).filter((m) => m.id) };
    } catch (e) {
      return { ok: false, error: e.message, models: [] };
    }
  });

  /* ----------------------------- market watch ------------------------------ */

  router.get('/api/market-watch', async (ctx) => {
    const user = requireLicence(ctx);
    const active = selectedWatchlist(user);
    const search = String(ctx.query?.search ?? '').trim();
    const cfg = config.mt5 ?? {};
    let available = [];
    let error = null;
    if (cfg.baseUrl && cfg.apiKey) {
      try {
        const rows = await new Mt5Broker(cfg).symbols(search || '*');
        available = (Array.isArray(rows) ? rows : []).map((x) => String(x?.name ?? x?.symbol ?? x)).filter(Boolean).slice(0, 200);
      } catch (e) { error = e.message; }
    }
    if (!available.length && !search) available = config.watchlist.map((w) => w.symbol);
    return { active: active.map((w) => w.symbol), available: [...new Set(available)], search, error };
  });

  router.post('/api/market-watch', async (ctx) => {
    const user = requireLicence(ctx);
    if (!user.owner) throw new HttpError(403, 'only the owner can change the shared MT5 watchlist', 'OWNER_ONLY');
    const symbols = Array.isArray(ctx.body?.symbols) ? [...new Set(ctx.body.symbols.map(String).map((x) => x.trim()).filter(Boolean))] : [];
    if (!symbols.length) throw new HttpError(400, 'choose at least one market', 'EMPTY_WATCHLIST');
    if (symbols.length > 100) throw new HttpError(400, 'at most 100 markets', 'TOO_MANY');
    const existing = new Map(config.watchlist.map((w) => [w.symbol, w]));
    const list = symbols.map((symbol) => existing.get(symbol) ?? { symbol, venue: 'mt5', label: symbol, assetClass: 'unknown' });
    saveMarkets(list);
    return { ok: true, active: list.map((w) => w.symbol) };
  });

  /* -------------------------------- markets -------------------------------- */

  /**
   * The owner's market list.
   *
   * Stored in settings so it survives a restart, and read back through the same
   * config the engine and the terminal use — one list, not two. A symbol is
   * checked against the broker before it is saved, because a typo here is a
   * silent 'no data' everywhere downstream.
   */
  function marketsNow() {
    return Array.isArray(config.watchlist) ? config.watchlist : [];
  }

  function loadMarkets() {
    try {
      const raw = store.getSetting(AI_SETTINGS_OWNER, 'markets', null);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) config.watchlist = parsed;
    } catch {
      /* a corrupt list must not stop the server booting */
    }
  }

  function saveMarkets(list) {
    config.watchlist = list;
    store.setSetting(AI_SETTINGS_OWNER, 'markets', JSON.stringify(list));
    return config.watchlist;
  }

  router.get('/api/owner/markets', async (ctx) => {
    requireOwnerSession(ctx);
    loadMarkets();
    const quotes = (engine.lastQuotes ?? []).map((q) => ({ symbol: q.symbol, price: q.price, ts: q.ts }));
    return { markets: marketsNow(), quotes };
  });

  router.post('/api/owner/markets', async (ctx) => {
    requireOwnerSession(ctx);
    const body = ctx.body ?? {};
    const incoming = Array.isArray(body.markets) ? body.markets : null;
    if (!incoming) throw new HttpError(400, 'markets must be an array', 'BAD_MARKETS');
    if (incoming.length > 24) throw new HttpError(400, 'at most 24 instruments', 'TOO_MANY');
    const cleaned = [];
    const seen = new Set();
    for (const raw of incoming) {
      const symbol = String(raw?.symbol ?? '').trim();
      if (!symbol) continue;
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      cleaned.push({
        symbol,
        venue: String(raw?.venue ?? 'mt5').trim() || 'mt5',
        label: String(raw?.label ?? symbol).trim().slice(0, 40),
        assetClass: String(raw?.assetClass ?? 'fx').trim().slice(0, 16),
      });
    }
    if (!cleaned.length) throw new HttpError(400, 'at least one instrument is required', 'EMPTY');
    saveMarkets(cleaned);
    store.audit({ userId: null, actor: 'owner', action: 'markets_updated', detail: cleaned.map((m) => m.symbol), ip: ctx.ip });
    // Drop cached quotes so the next read reflects the new list immediately.
    engine.lastQuotes = [];
    return { ok: true, markets: marketsNow() };
  });

  /** Verify one symbol against the broker before the owner saves it. */
  router.post('/api/owner/markets/check', async (ctx) => {
    requireOwnerSession(ctx);
    const cfg = config.mt5 ?? {};
    const symbol = String(ctx.body?.symbol ?? '').trim();
    if (!symbol) throw new HttpError(400, 'symbol is required', 'BAD_SYMBOL');
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'MT5 gateway is not configured' };
    const broker = new Mt5Broker(cfg);
    try {
      const rows = await broker.candles({ symbol, timeframe: '1h', limit: 2 });
      return { ok: rows.length > 0, count: rows.length, lastClose: rows.at(-1)?.close ?? null };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code ?? null };
    }
  });

  router.get('/api/owner/ai/settings', async (ctx) => {
    requireOwnerSession(ctx);
    // 'stored' is deliberately not returned raw: it holds the apiKey in clear,
    // and this endpoint would then hand the key back on every page load.
    const stored = storedAiSettings();
    return {
      config: aiSettingsNow(),
      stored: {
        baseUrl: stored.baseUrl ?? null,
        model: stored.model ?? null,
        provider: stored.provider ?? null,
        hasKey: Boolean(stored.apiKey),
      },
      where: 'node',
    };
  });

  router.post('/api/owner/ai/settings', async (ctx) => {
    requireOwnerSession(ctx);
    const body = ctx.body ?? {};
    const next = {};
    if (typeof body.baseUrl === 'string') {
      const url = body.baseUrl.trim().replace(/\/+$/, '');
      if (url && !/^https:\/\//i.test(url)) throw new HttpError(400, 'the base URL must start with https://', 'BAD_URL');
      next.baseUrl = url;
    }
    if (typeof body.model === 'string') next.model = body.model.trim().slice(0, 120);
    if (typeof body.provider === 'string') next.provider = body.provider.trim().toLowerCase();
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    // A key is write-only: it is stored and never returned.
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
    if (body.clearKey === true) next.apiKey = '';
    saveAiSettings(next);
    applyAiSettings();
    store.audit({ userId: null, actor: 'owner', action: 'ai_settings_updated', detail: Object.keys(next), ip: ctx.ip });
    return { ok: true, config: aiSettingsNow() };
  });

  function symbolClass(name) {
    const x = String(name ?? '').toUpperCase();
    if (/XAU|XAG|XPT|XPD|GOLD|SILVER|OIL|WTI|BRENT|NGAS|COPPER/.test(x)) return 'metals_commodities';
    if (/US30|US100|NAS|SPX|SP500|GER|DAX|UK100|JPN|HK|INDEX/.test(x)) return 'indices';
    if (/BTC|ETH|SOL|XRP|DOGE|ADA|LTC|USDT/.test(x)) return 'crypto';
    if (/^[A-Z]{6}(\.|$)/.test(x) || /EUR|GBP|USD|JPY|CHF|AUD|NZD|CAD/.test(x)) return 'forex';
    return 'stocks_equities';
  }

  router.get('/api/owner/mt5/symbols', async (ctx) => {
    requireOwnerSession(ctx);
    const cfg = config.mt5 ?? {};
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'MT5 gateway is not configured', categories: {} };
    const search = String(ctx.query?.search ?? '*').trim() || '*';
    try {
      const rows = await new Mt5Broker(cfg).symbols(search);
      const categories = { stocks_equities: [], indices: [], forex: [], metals_commodities: [], crypto: [] };
      for (const row of Array.isArray(rows) ? rows : []) {
        const symbol = String(row?.name ?? row?.symbol ?? row).trim();
        if (!symbol) continue;
        const category = symbolClass(symbol);
        categories[category].push({ symbol, description: row?.description ?? row?.path ?? null });
      }
      return { ok: true, search, total: Object.values(categories).reduce((n, a) => n + a.length, 0), categories };
    } catch (e) {
      return { ok: false, search, error: e.message, categories: {} };
    }
  });

  router.get('/api/owner/mt5/candles', async (ctx) => {
    requireOwnerSession(ctx);
    const cfg = config.mt5 ?? {};
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'MT5 gateway is not configured' };
    const symbol = String(ctx.query?.symbol ?? '').trim();
    const timeframe = String(ctx.query?.timeframe ?? '1h');
    const limit = Math.max(2, Math.min(500, Number(ctx.query?.limit) || 60));
    if (!symbol) return { ok: false, error: 'symbol is required' };
    const broker = new Mt5Broker(cfg);
    try {
      const rows = await broker.candles({ symbol, timeframe, limit });
      const last = rows.at(-1) ?? null;
      return {
        ok: true,
        symbol,
        timeframe,
        count: rows.length,
        first: rows[0]?.ts ?? null,
        last: last?.ts ?? null,
        lastClose: last?.close ?? null,
        candles: rows.slice(-10),
      };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code ?? null };
    }
  });

  router.get('/api/owner/ai', async (ctx) => {
    requireOwnerSession(ctx);
    applyAiSettings();
    const key = String(config.ai.apiKey || '');
    return {
      config: {
        enabled: analyst.mode !== 'local',
        mode: analyst.mode,
        provider: analyst.providerLabel,
        baseUrl: config.ai.baseUrl || '',
        model: config.ai.model || '',
        keyHint: key ? `…${key.slice(-4)}` : '',
      },
    };
  });

  router.get('/api/owner/files', async (ctx) => {
    requireOwnerSession(ctx);
    if (!files) return { files: [] };
    return { files: files.listAll(60) };
  });

  router.post('/api/owner/files/:id/share', async (ctx) => {
    requireOwnerSession(ctx);
    if (!files) throw new HttpError(400, 'file storage is disabled', 'NO_FILES');
    const isPublic = Boolean(ctx.body?.public);
    const row = files.setVisibilityAsOwner(ctx.params.id, isPublic ? 'public' : 'private');
    if (!row) throw new HttpError(404, 'no such file', 'NO_FILE');
    store.audit({
      userId: null,
      actor: 'owner',
      action: isPublic ? 'file_published' : 'file_unpublished',
      detail: { id: row.id },
      ip: ctx.ip,
    });
    return { file: row };
  });

  router.post('/api/owner/licences/reset', async (ctx) => {
    requireOwnerSession(ctx);
    // Revoke every licence that is still live. The rows are kept, not deleted,
    // so an accidental reset can be undone by reinstating a key.
    const rows = licensing.list({ limit: 1000 });
    let revoked = 0;
    for (const r of rows) {
      if (r.revoked) continue;
      if (licensing.revoke(r.keyId, true)) revoked++;
    }
    store.audit({ userId: null, actor: 'owner', action: 'licences_reset', detail: { revoked, total: rows.length }, ip: ctx.ip });
    return { revoked, total: rows.length, revokedNow: rows.filter((r) => !r.revoked).length };
  });

  router.post('/api/owner/licences/:keyId/revoke', async (ctx) => {
    requireOwnerSession(ctx);
    const { revoked = true } = ctx.body ?? {};
    const r = licensing.revoke(ctx.params.keyId, Boolean(revoked));
    if (!r) throw new HttpError(404, 'licence not found', 'NOT_FOUND');
    store.audit({ userId: null, actor: 'owner', action: 'licence_revoked', detail: { keyId: ctx.params.keyId, revoked }, ip: ctx.ip });
    return { licence: r };
  });

  router.post('/api/owner/licences/:keyId/quota', async (ctx) => {
    requireOwnerSession(ctx);
    const { quota, reset } = ctx.body ?? {};
    let r;
    if (reset) r = licensing.resetUsage(ctx.params.keyId);
    else r = licensing.setQuota(ctx.params.keyId, quota === null ? null : Number(quota));
    if (!r) throw new HttpError(404, 'licence not found', 'NOT_FOUND');
    return { licence: r };
  });

  router.post('/api/owner/licences/:keyId/extend', async (ctx) => {
    requireOwnerSession(ctx);
    const days = Number(ctx.body?.days ?? 30);
    if (!Number.isFinite(days) || days <= 0) throw new HttpError(400, 'days must be positive', 'BAD_REQUEST');
    const r = licensing.extend(ctx.params.keyId, days);
    if (!r) throw new HttpError(404, 'licence not found', 'NOT_FOUND');
    return { licence: r };
  });

  /* ------------------------------- terminal ------------------------------ */

  router.get('/api/terminal', async (ctx) => {
    const user = requireLicence(ctx);
    return terminalState(user);
  });

  router.get('/api/quotes', async (ctx) => {
    requireLicence(ctx);
    return { quotes: engine.lastQuotes ?? (await refreshQuotesSafe()) };
  });

  router.get('/api/candles', async (ctx) => {
    requireLicence(ctx);
    const { venue = 'bybit', symbol = 'BTCUSDT', tf = '1h', limit = '240', force } = ctx.query;
    const candles = await market.candles({ venue, symbol, timeframe: tf, limit: Math.min(Number(limit) || 240, 720), force: force === '1' });
    return { venue, symbol, timeframe: tf, candles };
  });

  router.get('/api/analysis', async (ctx) => {
    const user = requireLicence(ctx);
    const { venue, symbol } = ctx.query;
    const tf = ctx.query?.tf ?? userTradingPrefs(user).timeframe ?? config.loop.timeframe;
    if (!venue || !symbol) throw new HttpError(400, 'venue and symbol required', 'BAD_REQUEST');
    const candles = await market.candles({ venue, symbol, timeframe: tf, limit: config.loop.historyBars });
    const { buildPlan } = await import('./analysis/engine.js');
    const plan = buildPlan(candles, { symbol, venue, timeframe: tf });
    return { plan, candles: candles.slice(-200), series: await seriesTail(candles, 200) };
  });

  router.post('/api/analysis/run', async (ctx) => {
    // Metered: this costs real compute, so it draws from the licence quota.
    const user = requireLicence(ctx, { metered: true, cost: config.licence.cost.cycle });
    const lim = expensiveLimiter.check(`run:${user.id}`);
    if (!lim.ok) throw new HttpError(429, 'analysis is rate limited', 'RATE_LIMITED');
    const result = await engine.runCycle({ userIds: [user.id], force: true });
    store.audit({ userId: user.id, actor: 'user', action: 'manual_cycle', detail: result, ip: ctx.ip });
    return result;
  });

  /* -------------------------------- engine ------------------------------- */

  router.post('/api/engine/start', async (ctx) => {
    requireOwnerSession(ctx);
    const r = engine.start();
    store.audit({ userId: null, actor: 'owner', action: 'engine_start', detail: r, ip: ctx.ip });
    return r;
  });

  router.post('/api/engine/stop', async (ctx) => {
    requireOwnerSession(ctx);
    const r = engine.stop();
    store.audit({ userId: null, actor: 'owner', action: 'engine_stop', detail: r, ip: ctx.ip });
    return r;
  });

  router.post('/api/engine/settings', async (ctx) => {
    const user = requireLicence(ctx);
    const { autoTrade } = ctx.body ?? {};
    if (typeof autoTrade === 'boolean') store.setSetting(user.id, 'autoTrade', autoTrade);
    store.audit({ userId: user.id, actor: 'user', action: 'auto_trade_toggled', detail: { autoTrade }, ip: ctx.ip });
    return { autoTrade: store.getSetting(user.id, 'autoTrade', true) };
  });

  /* -------------------------------- signals ------------------------------ */

  router.post('/api/signals/:id/execute', async (ctx) => {
    const user = requireLicence(ctx);
    const signal = store.get('SELECT * FROM signals WHERE id = ? AND user_id = ?', ctx.params.id, user.id);
    if (!signal) throw new HttpError(404, 'signal not found', 'NOT_FOUND');
    const acc = engine.accountState(user);
    const plan = {
      ok: true,
      symbol: signal.symbol,
      venue: signal.venue,
      timeframe: signal.timeframe,
      direction: signal.direction,
      entry: signal.entry,
      stop: signal.stop,
      target1: signal.target1,
      confidence: signal.confidence,
      rewardRisk: signal.reward_risk,
      playbook: signal.playbook,
      snapshot: { price: signal.entry },
    };
    const decision = engine.risk.evaluate(plan, {
      equity: acc.equity,
      openPositions: acc.positions,
      dayPnl: acc.dayPnl,
      dayTrades: acc.dayTrades,
      lastTradeAt: store.lastTradeAt(user.id, signal.symbol),
      positionMap: Object.fromEntries((engine.lastQuotes ?? []).map((q) => [q.symbol, q.price])),
    });
    if (!decision.approved) {
      store.audit({ userId: user.id, actor: 'user', action: 'manual_execute_blocked', detail: { signal: signal.id, reasons: decision.reasons }, ip: ctx.ip });
      throw new HttpError(422, `risk gate rejected: ${decision.reasons.join('; ')}`, 'RISK_REJECTED', { reasons: decision.reasons });
    }
    const quote = (engine.lastQuotes ?? []).find((q) => q.symbol === signal.symbol);
    if (!quote) throw new HttpError(503, 'no live quote for this symbol right now', 'STALE_DATA');
    const res = await engine.paper().place({
      userId: user.id,
      mode: 'paper',
      venue: signal.venue,
      symbol: signal.symbol,
      side: signal.direction === 'long' ? 'buy' : 'sell',
      qty: decision.sizing.qty,
      mid: quote.price,
      recentVolume: quote.volume ?? 0,
      signalId: signal.id,
      stop: signal.stop,
      target: signal.target1,
    });
    store.run("UPDATE signals SET status = 'executed' WHERE id = ?", signal.id);
    store.audit({ userId: user.id, actor: 'user', action: 'manual_execute', detail: { signal: signal.id, qty: decision.sizing.qty, price: quote.price }, ip: ctx.ip });
    bus.emit('position', { action: 'open', symbol: signal.symbol, side: signal.direction, qty: decision.sizing.qty, price: quote.price });
    return { ok: true, orderId: res.brokerOrderId, positionId: res.positionId, qty: decision.sizing.qty, fill: res.avgFill, fees: res.fees };
  });

  router.post('/api/signals/:id/dismiss', async (ctx) => {
    const user = requireLicence(ctx);
    const r = store.run("UPDATE signals SET status = 'dismissed' WHERE id = ? AND user_id = ?", ctx.params.id, user.id);
    if (!r.changes) throw new HttpError(404, 'signal not found', 'NOT_FOUND');
    return { ok: true };
  });

  /* ------------------------------- positions ----------------------------- */

  router.patch('/api/positions/:id', async (ctx) => {
    const user = requireLicence(ctx);
    const pos = store.position(user.id, ctx.params.id);
    if (!pos || pos.status !== 'open') throw new HttpError(404, 'open position not found', 'NOT_FOUND');
    const { stop, target } = ctx.body ?? {};
    const patch = {};
    if (stop !== undefined) {
      if (typeof stop !== 'number' || !Number.isFinite(stop)) throw new HttpError(400, 'stop must be a number', 'BAD_REQUEST');
      if (pos.side === 'long' && stop >= (pos.entry ?? stop)) throw new HttpError(400, 'stop must be below entry for a long', 'BAD_STOP');
      if (pos.side === 'short' && stop <= (pos.entry ?? stop)) throw new HttpError(400, 'stop must be above entry for a short', 'BAD_STOP');
      patch.stop = stop;
    }
    if (target !== undefined) {
      if (typeof target !== 'number' || !Number.isFinite(target)) throw new HttpError(400, 'target must be a number', 'BAD_REQUEST');
      if (pos.side === 'long' && target <= pos.entry) throw new HttpError(400, 'target must be above entry for a long', 'BAD_TARGET');
      if (pos.side === 'short' && target >= pos.entry) throw new HttpError(400, 'target must be below entry for a short', 'BAD_TARGET');
      patch.target = target;
    }
    store.updatePosition(pos.id, patch);
    store.audit({ userId: user.id, actor: 'user', action: 'position_amended', detail: { id: pos.id, ...patch }, ip: ctx.ip });
    return { ok: true, position: store.position(user.id, pos.id) };
  });

  router.post('/api/positions/:id/close', async (ctx) => {
    const user = requireLicence(ctx);
    const pos = store.position(user.id, ctx.params.id);
    if (!pos || pos.status !== 'open') throw new HttpError(404, 'open position not found', 'NOT_FOUND');
    const quote = (engine.lastQuotes ?? []).find((q) => q.symbol === pos.symbol);
    if (!quote) throw new HttpError(503, 'no live quote available', 'STALE_DATA');
    const res = pos.mode === 'live' && broker
      ? await broker.close({ symbol: pos.symbol, qty: pos.qty, side: pos.side, positionId: pos.broker_position_id })
      : await engine.paper().close({ userId: user.id, position: pos, price: quote.price, reason: 'manual', recentVolume: quote.volume ?? 0 });
    if (pos.mode === 'live') {
      const exitPrice = res.price ?? quote.price;
      const pnl = pos.side === 'long' ? (exitPrice - pos.entry) * pos.qty : (pos.entry - exitPrice) * pos.qty;
      store.updatePosition(pos.id, { status: 'closed', exitPrice, pnl, closedAt: Date.now(), closeReason: 'manual' });
      store.addRealized(user.id, pnl, 0);
      res.pnl = pnl; res.exitPrice = exitPrice;
    }
    recordVaultLesson(user.id, store.position(user.id, pos.id));
    store.audit({ userId: user.id, actor: 'user', action: 'position_closed_manual', detail: { id: pos.id, pnl: res.pnl, price: res.exitPrice }, ip: ctx.ip });
    bus.emit('position', { action: 'close', symbol: pos.symbol, reason: 'manual', pnl: res.pnl });
    return { ok: true, ...res };
  });

  /* ---------------------------- pending orders ---------------------------- */

  /** Place a pending order: fills as a market ticket when price touches the trigger. */
  router.post('/api/pending-orders', async (ctx) => {
    const user = requireLicence(ctx);
    const body = ctx.body ?? {};
    const symbol = String(body.symbol ?? '').trim();
    const side = String(body.side ?? '').toLowerCase();
    const qty = Number(body.qty);
    const triggerPrice = Number(body.triggerPrice);
    if (!symbol || !['buy', 'sell'].includes(side)) throw new HttpError(400, 'symbol and side (buy/sell) required', 'BAD_REQUEST');
    if (!(qty > 0) || !(triggerPrice > 0)) throw new HttpError(400, 'qty and triggerPrice must be positive', 'BAD_REQUEST');
    const entry = selectedWatchlist(user).find((w) => w.symbol === symbol);
    if (!entry) throw new HttpError(400, 'that symbol is not in the selected execution scope', 'UNKNOWN_SYMBOL');
    const pStop = Number(body.stop) || null;
    const pTarget = Number(body.target) || null;
    if (pStop && (side === 'buy' ? pStop >= triggerPrice : pStop <= triggerPrice)) throw new HttpError(400, side === 'buy' ? 'a buy stop must be below the trigger price' : 'a sell stop must be above the trigger price', 'BAD_STOP');
    if (pTarget && (side === 'buy' ? pTarget <= triggerPrice : pTarget >= triggerPrice)) throw new HttpError(400, side === 'buy' ? 'a buy target must be above the trigger price' : 'a sell target must be below the trigger price', 'BAD_TARGET');
    const order = store.addPendingOrder({ userId: user.id, symbol, venue: entry.venue ?? 'mt5', side, qty, triggerPrice, stop: pStop, target: pTarget, timeframe: userTradingPrefs(user).timeframe ?? null });
    store.audit({ userId: user.id, actor: 'user', action: 'pending_order_placed', detail: { symbol, side, qty, triggerPrice }, ip: ctx.ip });
    return { ok: true, order };
  });

  router.get('/api/pending-orders', async (ctx) => {
    const user = requireLicence(ctx);
    return { orders: store.pendingOrders(user.id) };
  });

  router.post('/api/pending-orders/:id/cancel', async (ctx) => {
    const user = requireLicence(ctx);
    const row = store.get("SELECT * FROM pending_orders WHERE id = ? AND user_id = ? AND status = 'waiting'", ctx.params.id, user.id);
    if (!row) throw new HttpError(404, 'waiting order not found', 'NOT_FOUND');
    store.cancelPendingOrder(ctx.params.id, 'user');
    store.audit({ userId: user.id, actor: 'user', action: 'pending_order_cancelled', detail: { id: ctx.params.id }, ip: ctx.ip });
    return { ok: true };
  });

  /**
   * Fills waiting orders whose trigger price was touched. Delay is one engine
   * cycle (config.loop.intervalMs), not a manual poll — the loop already runs.
   */
  let pendingPass = null;
  function processPendingOrders() {
    // One pass at a time: a slow fill must not let the next cycle double-fill.
    if (pendingPass) return pendingPass;
    pendingPass = fillPendingOrders().finally(() => { pendingPass = null; });
    return pendingPass;
  }

  async function fillPendingOrders() {
    try {
      const waiting = store.allWaitingOrders();
      for (const o of waiting) {
        const quote = (engine.lastQuotes ?? []).find((q) => q.symbol === o.symbol);
        if (!quote) continue;
        const price = quote.price;
        const touched = o.side === 'buy' ? price <= o.trigger_price : price >= o.trigger_price;
        if (!touched) continue;
        // Paper fill through the paper broker so the position ledger stays consistent.
        const res = await engine.paper().place({
          userId: o.user_id,
          mode: 'paper',
          venue: o.venue,
          symbol: o.symbol,
          side: o.side,
          qty: o.qty,
          type: 'market',
          mid: price,
          stop: o.stop ?? undefined,
          target: o.target ?? undefined,
        });
        if (!res?.positionId) continue;
        store.fillPendingOrder(o.id, res.avgFill ?? price);
        store.audit({ userId: o.user_id, actor: 'engine', action: 'pending_order_filled', detail: { symbol: o.symbol, price, qty: o.qty }, ip: null });
        bus.emit('position', { action: 'open', symbol: o.symbol, side: o.side, qty: o.qty, price, pending: true });
      }
    } catch (e) {
      logger.warn?.(`[pending] fill pass failed: ${e.message}`);
    }
  }

  // Run the fill pass right after each engine cycle.
  bus.on('cycle', processPendingOrders);
  // And once shortly after boot so pre-boot orders get a chance.
  setTimeout(() => { processPendingOrders(); }, 5000).unref?.();

  /* -------------------------------- sweep --------------------------------- */

  /**
   * Analyse every watched instrument at once, for a chosen pattern.
   *
   * 'Profit only' is a filter, not a promise: it keeps setups whose reward at
   * target one is at least the reward/risk asked for. Setups that do not fire
   * are returned with their reason rather than hidden, so an empty list is
   * explainable instead of mysterious.
   */
  router.get('/api/analysis/sweep', async (ctx) => {
    const user = requireLicence(ctx);
    const { buildPlan } = await import('./analysis/engine.js');
    const tf = String(ctx.query?.tf ?? userTradingPrefs(user).timeframe ?? config.loop.timeframe ?? '1h');
    const pattern = String(ctx.query?.pattern ?? 'any').toLowerCase();
    const minRR = Number(ctx.query?.minRR ?? 0);
    const profitOnly = String(ctx.query?.profitOnly ?? '1') === '1';

    const rows = [];
    for (const entry of selectedWatchlist(user)) {
      try {
        const candles = await market.candles({ venue: entry.venue, symbol: entry.symbol, timeframe: tf, limit: config.loop.historyBars });
        const plan = buildPlan(candles, { symbol: entry.symbol, venue: entry.venue, timeframe: tf, label: entry.label });
        const quote = (engine.lastQuotes ?? []).find((q) => q.symbol === entry.symbol);
        rows.push({
          symbol: entry.symbol,
          venue: entry.venue,
          label: entry.label ?? entry.symbol,
          price: quote?.price ?? plan.snapshot?.price ?? null,
          ok: Boolean(plan.ok),
          reason: plan.reason ?? null,
          playbook: plan.playbook ?? null,
          direction: plan.direction ?? null,
          confidence: plan.confidence ?? null,
          rewardRisk: plan.rewardRisk ?? null,
          stop: plan.stop ?? null,
          target1: plan.target1 ?? null,
          regime: plan.regime?.regime ?? null,
          thesis: plan.thesis ?? null,
        });
      } catch (e) {
        rows.push({ symbol: entry.symbol, venue: entry.venue, ok: false, reason: e.message });
      }
    }

    const considered = rows.filter((r) => r.ok);
    const kept = considered.filter((r) => {
      if (pattern !== 'any' && r.playbook !== pattern) return false;
      if (!profitOnly) return true;
      const rr = Number(r.rewardRisk ?? 0);
      return rr >= Math.max(minRR, 1);
    });
    kept.sort((a, b) => (b.rewardRisk ?? 0) - (a.rewardRisk ?? 0) || (b.confidence ?? 0) - (a.confidence ?? 0));

    return {
      timeframe: tf,
      pattern,
      profitOnly,
      minRR,
      analysed: rows.length,
      setups: kept,
      rejected: rows.filter((r) => !kept.includes(r)),
      at: Date.now(),
    };
  });

  /* --------------------------------- news --------------------------------- */

  /**
   * Market news, from a feed the owner configures.
   *
   * There is no free source we can call without a key, so this does not invent
   * headlines: it reads NEWS_FEED_URL (any RSS or JSON feed) and reports plainly
   * when nothing is configured. The cache and the SSE stream exist so the page
   * can show items arriving rather than polling.
   */
  let newsCache = { at: 0, items: [], source: null, error: null };

  function stripTags(text) {
    return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseFeed(body, contentType) {
    const items = [];
    const type = String(contentType ?? '');
    if (type.includes('json') || /^\s*[[{]/.test(body)) {
      let json = null;
      try { json = JSON.parse(body); } catch { return null; }
      const list = Array.isArray(json) ? json : (json.items ?? json.articles ?? json.data ?? json.results ?? []);
      for (const it of list.slice(0, 80)) {
        const title = it.title ?? it.headline ?? it.name;
        if (!title) continue;
        items.push({
          title: stripTags(title).slice(0, 220),
          summary: stripTags(it.summary ?? it.description ?? it.body ?? '').slice(0, 400),
          url: it.url ?? it.link ?? it.href ?? null,
          source: it.source?.name ?? it.source ?? it.author ?? null,
          ts: it.publishedAt ?? it.pubDate ?? it.date ?? it.time ?? null,
        });
      }
      return items;
    }
    // RSS or Atom, deliberately forgiving: feeds differ and a strict parser
    // that returns nothing is worse than a loose one that returns too much.
    const entries = body.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? [];
    for (const raw of entries.slice(0, 80)) {
      const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      if (!title) continue;
      const link = raw.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? raw.match(/href="([^"]+)"/i)?.[1];
      const desc = raw.match(/<(description|summary|content)[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
      const date = raw.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
      items.push({
        title: stripTags(title.replace(/<!\[CDATA\[|\]\]>/g, '')).slice(0, 220),
        summary: stripTags(String(desc ?? '').replace(/<!\[CDATA\[|\]\]>/g, '')).slice(0, 400),
        url: link ? stripTags(String(link).replace(/<!\[CDATA\[|\]\]>/g, '')) : null,
        source: null,
        ts: date ? Date.parse(stripTags(date)) || null : null,
      });
    }
    return items;
  }

  async function loadNews(force = false) {
    const feed = config.news?.feedUrl ?? '';
    if (!feed) return { items: [], source: null, configured: false, error: null };
    if (!force && Date.now() - newsCache.at < 90_000) return newsCache;
    try {
      const res = await fetch(feed, { headers: { accept: 'application/rss+xml, application/json, text/xml, */*' }, signal: AbortSignal.timeout(12_000) });
      const body = await res.text();
      const items = parseFeed(body, res.headers.get('content-type'));
      if (items === null) throw new Error('the feed did not look like RSS or JSON');
      newsCache = { at: Date.now(), items, source: feed, configured: true, error: null };
      for (const it of items.slice(0, 12)) bus.emit('news', it);
    } catch (e) {
      // Keep the last good items: a feed outage must not empty the page.
      newsCache = { ...newsCache, at: Date.now(), configured: true, error: e.message };
    }
    return newsCache;
  }

  router.get('/api/news', async (ctx) => {
    requireLicence(ctx);
    const n = await loadNews(ctx.query?.force === '1');
    return { items: n.items.slice(0, 60), source: n.source, configured: n.configured, error: n.error, at: n.at };
  });

  /* ---------------------------- owner MT5 accounts ------------------------- */

  function ownerMt5Accounts() { return store.getSetting('owner', 'mt5_accounts', []) ?? []; }
  function activeOwnerMt5Id() { return store.getSetting('owner', 'active_mt5_account', null); }
  function decryptCredential(value) {
    const raw = JSON.parse(String(value));
    const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), Buffer.from(raw.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64url')), decipher.final()]).toString('utf8');
  }
  function safeOwnerAccount(a) { if (!a) return null; const { secret, ...safe } = a; return { ...safe, active: a.id === activeOwnerMt5Id() }; }

  router.get('/api/owner/mt5/accounts', async (ctx) => {
    requireOwnerSession(ctx);
    return { activeId: activeOwnerMt5Id(), provisionerConfigured: Boolean(config.provisionerUrl), accounts: ownerMt5Accounts().map(safeOwnerAccount) };
  });

  router.post('/api/owner/mt5/accounts', async (ctx) => {
    requireOwnerSession(ctx);
    const body = ctx.body ?? {};
    const label = String(body.label ?? '').trim().slice(0, 60);
    const brokerName = String(body.broker ?? '').trim().slice(0, 80);
    const login = String(body.login ?? '').trim().slice(0, 80);
    const server = String(body.server ?? '').trim().slice(0, 120);
    const password = String(body.password ?? '');
    if (!label || !brokerName || !login || !server || password.length < 4) throw new HttpError(400, 'label, broker, login, server and password are required', 'MT5_ACCOUNT_REQUIRED');
    const account = { id: `mt5_${crypto.randomBytes(6).toString('hex')}`, label, broker: brokerName, login, server, secret: encryptCredential(password), status: 'pending_gateway', gateway: null, createdAt: Date.now(), updatedAt: Date.now() };
    store.setSetting('owner', 'mt5_accounts', [...ownerMt5Accounts(), account]);
    store.audit({ userId: null, actor: 'owner', action: 'owner_mt5_account_added', detail: { id: account.id, label, broker: brokerName, login, server, status: account.status }, ip: ctx.ip });
    const { secret, ...safe } = account;
    return { ok: true, account: safe, message: 'MT5 account saved securely and is waiting for a dedicated gateway.' };
  });

  router.post('/api/owner/mt5/accounts/:id/provision', async (ctx) => {
    requireOwnerSession(ctx);
    const account = ownerMt5Accounts().find((a) => a.id === ctx.params.id);
    if (!account) throw new HttpError(404, 'MT5 account not found', 'NOT_FOUND');
    if (!config.provisionerUrl) return { ok: false, status: account.status, code: 'PROVISIONER_NOT_CONFIGURED', message: 'Set MT5_PROVISIONER_URL before automatic gateway provisioning.' };
    store.setSetting('owner', 'mt5_accounts', ownerMt5Accounts().map((a) => a.id === account.id ? { ...a, status: 'provisioning', updatedAt: Date.now() } : a));
    try {
      const res = await fetch(`${String(config.provisionerUrl).replace(/\/$/, '')}/provision`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.provisionerKey ?? ''}` }, body: JSON.stringify({ id: account.id + '-' + crypto.randomBytes(3).toString('hex'), label: account.label, broker: account.broker, login: account.login, server: account.server, password: decryptCredential(account.secret) }), signal: AbortSignal.timeout(30_000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error ?? `provisioner HTTP ${res.status}`);
      const updated = ownerMt5Accounts().map((a) => a.id === account.id ? { ...a, status: body.status ?? 'connected', gateway: body.gateway ?? null, updatedAt: Date.now() } : a);
      store.setSetting('owner', 'mt5_accounts', updated);
      return { ok: true, account: safeOwnerAccount(updated.find((a) => a.id === account.id)) };
    } catch (e) {
      const updated = ownerMt5Accounts().map((a) => a.id === account.id ? { ...a, status: 'error', error: e.message.slice(0, 180), updatedAt: Date.now() } : a);
      store.setSetting('owner', 'mt5_accounts', updated);
      return { ok: false, status: 'error', error: e.message.slice(0, 180) };
    }
  });

  router.post('/api/owner/mt5/accounts/:id/activate', async (ctx) => {
    requireOwnerSession(ctx);
    const account = ownerMt5Accounts().find((a) => a.id === ctx.params.id);
    if (!account) throw new HttpError(404, 'MT5 account not found', 'NOT_FOUND');
    if (account.status !== 'connected') throw new HttpError(409, 'account gateway is not connected', 'GATEWAY_NOT_READY');
    store.setSetting('owner', 'active_mt5_account', account.id);
    // Hot-swap: point the engine's broker at the new gateway right now — no
    // redeploy. On a failed health check the old broker stays in place.
    let swapped = false;
    try {
      const key = decryptCredential(account.secret);
      const gw = account.gateway ?? {};
      if (gw.url && key) {
        const live = new Mt5Broker({ baseUrl: gw.url, apiKey: key, demo: config.mt5?.demo ?? true, login: account.login, server: account.server, label: account.label });
        const ready = await live.ready().catch(() => ({ ok: false }));
        if (ready.ok) {
          engine.broker = live;
          broker = live;
          currencyCache = { at: 0, value: null };
          swapped = true;
        }
      }
    } catch { /* keep serving the previous broker */ }
    store.audit({ userId: null, actor: 'owner', action: 'owner_mt5_account_activated', detail: { id: account.id, hotSwap: swapped }, ip: ctx.ip });
    return { ok: true, activeId: account.id, hotSwap: swapped, message: swapped ? 'Broker aktif ditukar serta-merta ke account ini.' : 'Account diaktifkan; broker bertukar pada restart backend.' };
  });

  router.del('/api/owner/mt5/accounts/:id', async (ctx) => {
    requireOwnerSession(ctx);
    const accounts = ownerMt5Accounts();
    const next = accounts.filter((a) => a.id !== ctx.params.id);
    if (next.length === accounts.length) throw new HttpError(404, 'MT5 account not found', 'NOT_FOUND');
    store.setSetting('owner', 'mt5_accounts', next);
    store.audit({ userId: null, actor: 'owner', action: 'owner_mt5_account_removed', detail: { id: ctx.params.id }, ip: ctx.ip });
    return { ok: true };
  });

  /* --------------------------- agents configuration ----------------------- */

  /** Owner-controlled expert/watcher settings. Only values, never keys echoed. */
  function agentsConfig() {
    const saved = (() => { try { return JSON.parse(store.getSetting('__owner__', 'agents', null) ?? 'null') ?? {}; } catch { return {}; } })();
    return {
      watcher: {
        provider: saved.provider ?? config.watcher?.provider ?? 'local',
        baseUrl: saved.baseUrl ?? config.watcher?.baseUrl ?? '',
        model: saved.model ?? config.watcher?.model ?? '',
        hasKey: Boolean(saved.apiKey ?? config.watcher?.apiKey),
        timeframe: saved.timeframe ?? config.watcher?.timeframe ?? '15m',
        intervalMs: saved.intervalMs ?? config.watcher?.intervalMs ?? 120000,
        tokensPerHour: saved.tokensPerHour ?? config.watcher?.tokensPerHour ?? 1000000,
      },
      expertEnabled: saved.expertEnabled ?? false,
    };
  }

  function applyAgentsConfig() {
    if (!watcher) return;
    const cfg = agentsConfig();
    const saved = (() => { try { return JSON.parse(store.getSetting('__owner__', 'agents', null) ?? 'null') ?? {}; } catch { return {}; } })();
    watcher.config = { ...watcher.config, watcher: { ...cfg.watcher, apiKey: saved.apiKey ?? config.watcher?.apiKey ?? '' } };
    watcher.budget.capPerHour = cfg.watcher.tokensPerHour;
    watcher.stop();
    if (cfg.watcher.model) watcher.start();
    if (expert) expert.enabled = cfg.expertEnabled === true;
  }

  router.get('/api/owner/agents', async (ctx) => {
    requireOwnerSession(ctx);
    return { config: agentsConfig(), watcher: watcher?.status() ?? null };
  });

  router.post('/api/owner/agents', async (ctx) => {
    requireOwnerSession(ctx);
    const body = ctx.body ?? {};
    const saved = (() => { try { return JSON.parse(store.getSetting('__owner__', 'agents', null) ?? 'null') ?? {}; } catch { return {}; } })();
    const next = { ...saved };
    if (typeof body.baseUrl === 'string') next.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
    if (typeof body.model === 'string') next.model = body.model.trim().slice(0, 120);
    if (typeof body.provider === 'string') next.provider = body.provider.trim().toLowerCase();
    if (typeof body.timeframe === 'string') next.timeframe = body.timeframe.trim();
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
    if (body.clearKey === true) next.apiKey = '';
    if (Number.isFinite(Number(body.intervalMs)) && Number(body.intervalMs) >= 30_000) next.intervalMs = Number(body.intervalMs);
    if (Number.isFinite(Number(body.tokensPerHour)) && Number(body.tokensPerHour) > 0) next.tokensPerHour = Number(body.tokensPerHour);
    if (typeof body.expertEnabled === 'boolean') next.expertEnabled = body.expertEnabled;
    store.setSetting('__owner__', 'agents', next);
    applyAgentsConfig();
    store.audit({ userId: null, actor: 'owner', action: 'agents_config_updated', detail: { keys: Object.keys(next), expertEnabled: next.expertEnabled ?? null }, ip: ctx.ip });
    return { ok: true, config: agentsConfig(), watcher: watcher?.status() ?? null };
  });

  /* ---------------------------- expert agent ------------------------------ */

  router.post('/api/ai/goal', async (ctx) => {
    const user = requireLicence(ctx);
    if (!expert) throw new HttpError(503, 'expert agent unavailable', 'EXPERT_UNAVAILABLE');
    const body = ctx.body ?? {};
    const plan = await expert.goalPlan({ capital: body.capital, target: body.target, style: body.style });
    store.audit({ userId: user.id, actor: 'user', action: 'ai_goal_plan', detail: { capital: plan.capital, target: plan.target, style: plan.style }, ip: ctx.ip });
    return plan;
  });

  router.post('/api/ai/expert-review', async (ctx) => {
    const user = requireLicence(ctx, { metered: true, cost: 1 });
    if (!expert) throw new HttpError(503, 'expert agent unavailable', 'EXPERT_UNAVAILABLE');
    const body = ctx.body ?? {};
    const plan = body.plan ?? null;
    if (!plan?.symbol) throw new HttpError(400, 'plan with symbol required', 'BAD_REQUEST');
    const acc = engine.accountState(user);
    const verdict = await expert.review(plan, { equity: acc.equity, openPositions: acc.positions.length, dayPnl: acc.dayPnl, newsRisk: false });
    store.audit({ userId: user.id, actor: 'user', action: 'ai_expert_review', detail: { symbol: plan.symbol, verdict: verdict.verdict }, ip: ctx.ip });
    return verdict;
  });

  router.get('/api/ai/watcher', async (ctx) => {
    requireLicence(ctx);
    if (!watcher) return { running: false, notes: [] };
    const s = watcher.status();
    return { ...s, recent: watcher.notes.slice(0, 10) };
  });

  /* ---------------- anonymous lessons (shared learning vault) -------------- */

  /**
   * Every closed trade becomes an anonymous lesson in the shared vault: date,
   * open profit/loss, close reason and the reason the trade existed — never a
   * name, login or account. The expert agent reads the recent lessons before an
   * entry, so the whole user base's mistakes and wins teach every entry.
   */
  function vaultLessonFromPosition(p) {
    const day = p.closed_at ? new Date(Number(p.closed_at)).toISOString().slice(0, 10) : '';
    const pnl = Number(p.pnl ?? 0);
    const outcome = pnl >= 0 ? 'profit' : 'loss';
    return {
      path: `Lessons/${day}-${p.symbol}-${p.id}.md`,
      title: `${p.symbol} ${outcome} ${Math.abs(pnl).toFixed(2)} (${p.close_reason ?? 'manual'})`,
      content: [
        `# ${p.symbol} — ${outcome.toUpperCase()}`,
        '',
        `- Date: ${day}`,
        `- Result: ${outcome} ${Math.abs(pnl).toFixed(2)} (open ${pnl >= 0 ? 'profit' : 'loss'})`,
        `- Side: ${p.side} · Qty ${p.qty} · Entry ${p.entry} → Exit ${p.exit_price ?? '—'}`,
        `- Close reason: ${p.close_reason ?? 'manual'}`,
        `- Trade reason: ${String(p.thesis || p.rationale || 'not recorded').slice(0, 200)}`,
        '',
        'Anonymous lesson shared across the vault for future entries.',
      ].join('\n'),
      tags: ['lesson', outcome, p.playbook ?? 'manual'],
      frontmatter: { anonymous: true, symbol: p.symbol, outcome, closedAt: day },
      source: 'system',
    };
  }

  function recordVaultLesson(userId, positionRow) {
    try {
      if (!vault || !positionRow?.closed_at) return;
      const enriched = { ...positionRow };
      if (positionRow.signal_id) {
        const sig = store.get('SELECT thesis, rationale, playbook FROM signals WHERE id = ?', positionRow.signal_id);
        if (sig) { enriched.thesis = sig.thesis; enriched.rationale = sig.rationale; enriched.playbook = sig.playbook; }
      }
      const lesson = vaultLessonFromPosition(enriched);
      if (vault.resolve(lesson.path)) return; // idempotent
      vault.write({ ...lesson, owner: null });
    } catch (e) {
      logger.warn?.(`[vault] lesson write failed: ${e.message}`);
    }
  }


  /** POST { room, text } — relayed owner reply into the user's chat. */
  router.post('/api/owner/reply', async (ctx) => {
    requireOwnerSession(ctx);
    const room = Number(ctx.body?.room);
    const text = String(ctx.body?.text ?? '').trim();
    if (!Number.isFinite(room) || room < 1) throw new HttpError(400, 'room number required', 'BAD_REQUEST');
    if (!text) throw new HttpError(400, 'reply text required', 'BAD_REQUEST');
    const row = store.get("SELECT user_id FROM settings WHERE key = 'support_room' AND CAST(value AS INTEGER) = ?", room);
    if (!row?.user_id) throw new HttpError(404, 'no user with that support room', 'ROOM_NOT_FOUND');
    store.addMessage({ userId: row.user_id, role: 'assistant', content: '[Support] ' + text, provider: 'owner' });
    store.audit({ userId: null, actor: 'owner', action: 'support_reply', detail: { room, chars: text.length }, ip: ctx.ip });
    return { ok: true, room };
  });

  router.get('/api/owner/rooms', async (ctx) => {
    requireOwnerSession(ctx);
    const rooms = store.all("SELECT user_id, CAST(value AS INTEGER) AS room FROM settings WHERE key = 'support_room' ORDER BY room DESC LIMIT 50");
    return { rooms: rooms.map((r) => {
      const u = store.getUserById(r.user_id);
      const profile = brokerProfilePublic(r.user_id);
      const last = store.messages(r.user_id, 1)[0] ?? null;
      return { room: r.room, name: u?.name ?? r.user_id, plan: u?.plan ?? null, broker: profile.broker ?? null, login: profile.login ?? null, status: profile.status ?? 'not_connected', lastMessage: last ? { role: last.role, content: String(last.content).slice(0, 120), ts: last.ts } : null };
    }) };
  });

  /* ----------------------- customer preferences --------------------------- */

  const CUSTOMER_TIMEFRAMES = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']);
  const CUSTOMER_STYLES = new Set(['scalping', 'intraday', 'swing']);

  router.get('/api/settings/preferences', async (ctx) => {
    const user = requireLicence(ctx);
    const prefs = store.getSetting(user.id, 'preferences', {}) ?? {};
    return { timeframe: prefs.timeframe || config.loop.timeframe, style: prefs.style || 'custom', autoTrade: store.getSetting(user.id, 'autoTrade', true), live: false, brokerProfile: brokerProfilePublic(user.id) };
  });

  router.post('/api/settings/preferences', async (ctx) => {
    const user = requireLicence(ctx);
    const body = ctx.body ?? {};
    const current = store.getSetting(user.id, 'preferences', {});
    const timeframe = body.timeframe ? String(body.timeframe).toLowerCase() : current.timeframe ?? config.loop.timeframe;
    const style = body.style ? String(body.style).toLowerCase() : current.style ?? 'custom';
    if (!CUSTOMER_TIMEFRAMES.has(timeframe)) throw new HttpError(400, 'unsupported timeframe', 'BAD_TIMEFRAME');
    if (style !== 'custom' && !CUSTOMER_STYLES.has(style)) throw new HttpError(400, 'unsupported trading style', 'BAD_STYLE');
    const prefs = { timeframe, style };
    store.setSetting(user.id, 'preferences', prefs);
    if (typeof body.autoTrade === 'boolean') store.setSetting(user.id, 'autoTrade', body.autoTrade);
    store.audit({ userId: user.id, actor: 'user', action: 'customer_preferences_updated', detail: { timeframe, style, autoTrade: body.autoTrade ?? null }, ip: ctx.ip });
    return { ok: true, ...prefs, autoTrade: store.getSetting(user.id, 'autoTrade', true), live: false };
  });

  /* -------------------------- customer broker ----------------------------- */

  router.get('/api/broker/profile', async (ctx) => {
    const user = requireLicence(ctx);
    return brokerProfilePublic(user.id);
  });

  router.post('/api/broker/profile', async (ctx) => {
    const user = requireLicence(ctx);
    if (user.owner) throw new HttpError(409, 'owner broker is managed in Coolify and the owner console', 'OWNER_BROKER_MANAGED');
    const body = ctx.body ?? {};
    const brokerName = String(body.broker ?? '').trim().slice(0, 80);
    const login = String(body.login ?? '').trim().slice(0, 80);
    const server = String(body.server ?? '').trim().slice(0, 120);
    const password = String(body.password ?? '');
    if (!brokerName || !login || !server || password.length < 4) throw new HttpError(400, 'broker, login, server and password are required', 'BROKER_PROFILE_REQUIRED');
    const encrypted = encryptCredential(password);
    store.setSetting(user.id, 'broker_profile', { broker: brokerName, login, server, secret: encrypted, status: 'pending_gateway', gateway: null, updatedAt: Date.now() });
    store.audit({ userId: user.id, actor: 'user', action: 'broker_profile_saved', detail: { broker: brokerName, login, server, status: 'pending_gateway' }, ip: ctx.ip });
    return { ...brokerProfilePublic(user.id), message: 'Credentials encrypted and waiting for a dedicated broker gateway. Live trading remains blocked until provisioned.' };
  });

  router.del('/api/broker/profile', async (ctx) => {
    const user = requireLicence(ctx);
    store.setSetting(user.id, 'broker_profile', null);
    store.audit({ userId: user.id, actor: 'user', action: 'broker_profile_removed', detail: null, ip: ctx.ip });
    return { ok: true, connected: false, status: 'not_connected' };
  });

  /* -------------------------------- account ------------------------------ */

  /** What the account header shows, on its own, for a terminal that polls it. */
  router.get('/api/account', async (ctx) => {
    const user = requireLicence(ctx);
    const state = await terminalState(user);
    return {
      account: state.account,
      licence: state.licence,
      engine: state.engine,
      live: state.live,
      risk: state.risk,
      serverTime: Date.now(),
    };
  });

  router.get('/api/positions', async (ctx) => {
    const user = requireLicence(ctx);
    const state = await terminalState(user);
    return { positions: state.positions, closed: store.closedPositions(user.id, 50) };
  });

  /**
   * A market order from the ticket, the way MT5 sends one.
   *
   * The risk gate runs first and its reasons are returned, not swallowed: a
   * refusal the trader cannot read is worse than no refusal at all. The order
   * is paper unless live is enabled *and* a broker is configured, so a ticket
   * can never reach a real account by surprise.
   */
  router.post('/api/positions', async (ctx) => {
    const user = requireLicence(ctx);
    const body = ctx.body ?? {};
    const symbol = String(body.symbol ?? '').trim();
    const side = String(body.side ?? '').toLowerCase();
    const requestedQty = Number(body.qty);
    if (!symbol) throw new HttpError(400, 'symbol is required', 'BAD_REQUEST');
    if (side !== 'buy' && side !== 'sell') throw new HttpError(400, "side must be 'buy' or 'sell'", 'BAD_REQUEST');
    if (!Number.isFinite(requestedQty) || requestedQty <= 0) throw new HttpError(400, 'qty must be a positive number', 'BAD_REQUEST');
    const entry = selectedWatchlist(user).find((w) => w.symbol === symbol);
    if (!entry) throw new HttpError(400, 'that symbol is not in the selected execution scope', 'UNKNOWN_SYMBOL');

    // A stop is what makes the size meaningful: without it the risk gate cannot
    // size the trade and would either refuse silently or guess. Ask for it
    // before anything else is fetched, so the answer does not depend on there
    // happening to be a quote right now.
    const stop = body.stop === undefined || body.stop === null || body.stop === '' ? null : Number(body.stop);
    if (stop === null || !Number.isFinite(stop) || stop <= 0) {
      throw new HttpError(400, 'a stop loss is required so the order can be sized', 'STOP_REQUIRED');
    }

    const quotes = (engine.lastQuotes ?? []).length ? engine.lastQuotes : await refreshQuotesSafe();
    const quote = quotes.find((q) => q.symbol === symbol);
    if (!quote) throw new HttpError(503, 'no live quote for this symbol right now', 'STALE_DATA');

    if (side === 'buy' && stop >= quote.price) throw new HttpError(400, 'a buy stop must be below the market', 'BAD_STOP');
    if (side === 'sell' && stop <= quote.price) throw new HttpError(400, 'a sell stop must be above the market', 'BAD_STOP');

    const state = await terminalState(user);
    const target = body.target === undefined || body.target === null || body.target === '' ? null : Number(body.target);
    if (target !== null && (!Number.isFinite(target) || target <= 0)) throw new HttpError(400, 'target must be a positive number', 'BAD_TARGET');
    if (target !== null && (side === 'buy' ? target <= quote.price : target >= quote.price)) throw new HttpError(400, side === 'buy' ? 'a buy target must be above the market' : 'a sell target must be below the market', 'BAD_TARGET');
    const riskPerUnit = Math.abs(quote.price - stop);
    const plan = {
      ok: true,
      manual: true,
      symbol,
      venue: entry.venue ?? 'mt5',
      direction: side === 'buy' ? 'long' : 'short',
      entry: quote.price,
      stop,
      target1: target,
      rewardRisk: target && riskPerUnit ? Number((Math.abs(target - quote.price) / riskPerUnit).toFixed(2)) : null,
      confidence: null,
      playbook: 'manual ticket',
      snapshot: { price: quote.price },
    };
    const decision = engine.risk.evaluate(plan, {
      equity: state.account.equity,
      openPositions: state.positions,
      dayPnl: state.account.dayPnl,
      dayTrades: state.account.dayTrades,
      lastTradeAt: store.lastTradeAt(user.id, symbol),
      positionMap: Object.fromEntries(quotes.map((q) => [q.symbol, q.price])),
    });
    if (!decision.approved) {
      throw new HttpError(422, `risk gate rejected: ${decision.reasons.join('; ')}`, 'RISK_REJECTED', { reasons: decision.reasons });
    }

    // A ticket goes where the account says it goes. It used to always fill on
    // the paper broker, so a live account showed trades that the broker had
    // never heard of — the terminal looked busy and MetaTrader stayed empty.
    const account = store.account(user.id);
    const useLive = Boolean(user.owner) && Boolean(account?.live_enabled) && Boolean(config.live) && Boolean(broker?.configured);
    let allowedQty = Number(decision.sizing?.qty ?? 0);
    if (useLive) {
      const brokerSize = await broker.sizeForRisk({ symbol, side, entry: quote.price, stop: plan.stop, equity: state.account.equity, riskPct: engine.risk.policy.maxRiskPerTrade });
      allowedQty = brokerSize.qty;
      if (!(allowedQty > 0)) throw new HttpError(422, `broker minimum volume is too large for the risk size (${brokerSize.min})`, 'BROKER_VOLUME_TOO_LARGE');
    }
    if (!(allowedQty > 0)) throw new HttpError(422, 'risk sizing produced zero volume', 'ZERO_SIZE');
    if (requestedQty > allowedQty + 1e-12) throw new HttpError(422, `requested volume ${requestedQty} exceeds risk-sized volume ${allowedQty}`, 'VOLUME_EXCEEDS_RISK');
    const qty = requestedQty;
    let res;
    if (useLive) {
      res = await broker.place({
        userId: user.id,
        symbol,
        side,
        qty,
        type: 'market',
        stop: plan.stop,
        target: plan.target1,
      });
      if (res?.avgFill === null || res?.avgFill === undefined) {
        throw new HttpError(502, 'the broker did not confirm the fill', 'UNCONFIRMED_FILL');
      }
      const protection = await broker.verifyProtection({ symbol, side, qty, stop: plan.stop, target: plan.target1 });
      if (!protection.ok) {
        throw new HttpError(502, `broker did not confirm protection: ${protection.reason}`, 'PROTECTION_NOT_CONFIRMED');
      }
      store.insertPosition({
        userId: user.id,
        mode: 'live',
        venue: broker.id,
        symbol,
        side: side === 'buy' ? 'long' : 'short',
        qty,
        entry: res.avgFill,
        stop: plan.stop ?? null,
        target: plan.target1 ?? null,
        brokerPositionId: res.brokerOrderId ?? res.orderId ?? null,
        fees: res.fees ?? 0,
      });
      res.positionId = res.positionId ?? null;
    } else {
      res = await engine.paper().place({
        userId: user.id,
        mode: 'paper',
        venue: plan.venue,
        symbol,
        side,
        qty,
        mid: quote.price,
        recentVolume: quote.volume ?? 0,
        stop: plan.stop,
        target: plan.target1,
      });
    }
    store.audit({ userId: user.id, actor: 'user', action: useLive ? 'manual_order_live' : 'manual_order', detail: { symbol, side, qty, price: quote.price, broker: useLive ? broker.id : 'paper' }, ip: ctx.ip });
    bus.emit('position', { action: 'open', symbol, side, qty, price: res.fill ?? quote.price });
    return { ok: true, live: useLive, positionId: res.positionId ?? null, orderId: res.orderId ?? res.brokerOrderId, fill: res.avgFill, fees: res.fees, sizeNote: decision.sizing };
  });

  /* ---------------------------------- ai --------------------------------- */

  /** Whether the analyst is reasoning on its own or calling a provider. */
  router.get('/api/ai/status', async (ctx) => {
    requireLicence(ctx);
    applyAiSettings();
    return {
      mode: analyst.mode,
      provider: config.ai.provider,
      label: analyst.providerLabel,
      model: config.ai.model,
      baseUrl: config.ai.baseUrl,
      hasKey: Boolean(config.ai.apiKey),
      enabled: analyst.mode !== 'local',
      budget: config.ai.budget ?? null,
    };
  });


  /* --------------------------- files: the rest ---------------------------- */

  /** Publish and unpublish are just visibility with a plainer name. */
  router.post('/api/files/:id/publish', async (ctx) => {
    const user = requireLicence(ctx);
    if (!files) throw new HttpError(503, 'file storage not configured', 'DISABLED');
    const row = files.setVisibility(ctx.params.id, user.id, 'public');
    if (!row) throw new HttpError(404, 'file not found', 'NOT_FOUND');
    store.audit({ userId: user.id, actor: 'user', action: 'file_published', detail: ctx.params.id, ip: ctx.ip });
    return { ok: true, file: row };
  });

  router.post('/api/files/:id/unpublish', async (ctx) => {
    const user = requireLicence(ctx);
    if (!files) throw new HttpError(503, 'file storage not configured', 'DISABLED');
    const row = files.setVisibility(ctx.params.id, user.id, 'private');
    if (!row) throw new HttpError(404, 'file not found', 'NOT_FOUND');
    store.audit({ userId: user.id, actor: 'user', action: 'file_unpublished', detail: ctx.params.id, ip: ctx.ip });
    return { ok: true, file: row };
  });

  router.del('/api/files/:id', async (ctx) => {
    const user = requireLicence(ctx);
    if (!files) throw new HttpError(503, 'file storage not configured', 'DISABLED');
    const ok = await files.remove(ctx.params.id, user.id);
    if (!ok) throw new HttpError(404, 'file not found', 'NOT_FOUND');
    store.audit({ userId: user.id, actor: 'user', action: 'file_deleted', detail: ctx.params.id, ip: ctx.ip });
    return { ok: true };
  });

  router.get('/api/journal', async (ctx) => {
    const user = requireLicence(ctx);
    const closed = store.closedPositions(user.id, 5000);
    const wins = closed.filter((p) => (p.pnl ?? 0) > 0);
    const losses = closed.filter((p) => (p.pnl ?? 0) <= 0);
    const grossWin = wins.reduce((a, p) => a + p.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((a, p) => a + p.pnl, 0));
    return {
      closed,
      stats: {
        trades: closed.length,
        winRate: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(1)) : 0,
        profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : null,
        netPnl: Number(closed.reduce((a, p) => a + (p.pnl ?? 0), 0).toFixed(2)),
        avgWin: wins.length ? Number((grossWin / wins.length).toFixed(2)) : 0,
        avgLoss: losses.length ? Number((grossLoss / losses.length).toFixed(2)) : 0,
        best: closed.reduce((a, p) => (p.pnl > (a?.pnl ?? -Infinity) ? p : a), null),
        worst: closed.reduce((a, p) => (p.pnl < (a?.pnl ?? Infinity) ? p : a), null),
      },
      orders: store.orders(user.id, 2000),
    };
  });

  router.patch('/api/account/live', async (ctx) => {
    const user = requireLicence(ctx);
    const { enabled } = ctx.body ?? {};
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean', 'BAD_REQUEST');
    if (enabled) {
      if (!user.owner) throw new HttpError(409, 'a broker account must be connected to this licence before live trading', 'BROKER_ACCOUNT_NOT_ASSIGNED');
      if (!config.live) throw new HttpError(409, 'live trading is disabled by server policy (set LUMINA_LIVE=1 with broker keys)', 'LIVE_DISABLED');
      if (!broker || !broker.configured) throw new HttpError(409, 'broker credentials are not configured', 'BROKER_NOT_CONFIGURED');
    }
    store.setLive(user.id, enabled);
    store.audit({ userId: user.id, actor: 'user', action: enabled ? 'live_trading_enabled' : 'live_trading_disabled', detail: { broker: config.broker }, ip: ctx.ip });
    return { liveEnabled: enabled };
  });

  /* --------------------------- AI trade intent ---------------------------- */

  router.post('/api/ai/trade-intent', async (ctx) => {
    const user = requireLicence(ctx, { metered: true, cost: config.licence.cost.ask });
    const text = String(ctx.body?.text ?? '').trim();
    if (text.length < 3) throw new HttpError(400, 'trade instruction required', 'BAD_REQUEST');
    const active = selectedWatchlist(user);
    const upper = text.toUpperCase();
    const explicitSymbol = active.find((w) => upper.includes(w.symbol.toUpperCase()))?.symbol ?? String(ctx.body?.symbol ?? '').trim();
    if (explicitSymbol && !active.some((w) => w.symbol === explicitSymbol)) {
      const cfg = config.mt5 ?? {};
      if (!cfg.baseUrl || !cfg.apiKey) throw new HttpError(409, `${explicitSymbol} is not in Market Watch and MT5 symbol discovery is unavailable`, 'SYMBOL_NOT_ACTIVE');
      const found = (await new Mt5Broker(cfg).symbols(explicitSymbol)).map((x) => String(x?.name ?? x?.symbol ?? x)).filter(Boolean).find((x) => x.toUpperCase() === explicitSymbol.toUpperCase());
      if (!found) throw new HttpError(404, `${explicitSymbol} was not found in the broker symbol list`, 'BROKER_SYMBOL_NOT_FOUND');
      throw new HttpError(409, `${found} is available from the broker but not active. Add it to Market Watch first.`, 'WATCHLIST_CONFIRM_REQUIRED', { symbol: found, action: 'add_to_market_watch' });
    }
    const explicit = /\b(BUY|LONG)\b/i.test(text) ? 'buy' : /\b(SELL|SHORT)\b/i.test(text) ? 'sell' : null;
    const tfMatch = text.match(/\b(1m|5m|15m|30m|1h|4h|1d|1w)\b/i);
    const tf = String(ctx.body?.timeframe ?? tfMatch?.[1] ?? userTradingPrefs(user).timeframe ?? config.loop.timeframe).toLowerCase();
    const { buildPlan } = await import('./analysis/engine.js');
    let symbol = explicitSymbol;
    let entry = symbol ? active.find((w) => w.symbol === symbol) : null;
    let candles;
    let plan;
    // “Market terbaik” / “scan” is a real ranked scan over the active Market
    // Watch, not a made-up favourite. It returns the best qualifying setup.
    // Freedom rule: if the prompt names a symbol NOT in Market Watch, discover
    // it against the broker and analyse it on the spot — the user is never
    // forced through a manual add-to-watchlist detour. Confirm-to-add is only
    // required before the resulting plan becomes an order.
    let discovered = null;
    if (!symbol && /\b(best|terbaik|scan|market|setup)\b/i.test(text)) {
      const candidates = [];
      for (const item of active) {
        try {
          const rows = await market.candles({ venue: item.venue, symbol: item.symbol, timeframe: tf, limit: config.loop.historyBars });
          const p = buildPlan(rows, { symbol: item.symbol, venue: item.venue, timeframe: tf, label: item.label });
          if (p.ok) candidates.push({ item, rows, plan: p });
        } catch { /* one unavailable broker symbol does not stop the scan */ }
      }
      candidates.sort((a, b) => (b.plan.confidence ?? 0) - (a.plan.confidence ?? 0) || (b.plan.rewardRisk ?? 0) - (a.plan.rewardRisk ?? 0));
      const best = candidates[0];
      if (!best) throw new HttpError(409, 'no qualifying setup in the active Market Watch', 'NO_SETUP');
      entry = best.item; symbol = entry.symbol; candles = best.rows; plan = best.plan;
    } else {
      if (!symbol) throw new HttpError(400, 'choose a symbol from Market Watch or ask for the best market', 'SYMBOL_REQUIRED');
      if (!entry) {
        // Discover outside the watchlist, honestly: only exact broker symbols.
        const cfg = config.mt5 ?? {};
        if (cfg.baseUrl && cfg.apiKey) {
          const found = (await new Mt5Broker(cfg).symbols(symbol)).map((x) => String(x?.name ?? x?.symbol ?? x)).filter(Boolean).find((x) => x.toUpperCase() === symbol.toUpperCase());
          if (found) {
            symbol = found;
            discovered = found;
          }
        }
        if (!discovered) throw new HttpError(404, `${symbol} was not found in the broker symbol list`, 'BROKER_SYMBOL_NOT_FOUND');
      }
      candles = await market.candles({ venue: entry?.venue ?? 'mt5', symbol, timeframe: tf, limit: config.loop.historyBars });
      plan = buildPlan(candles, { symbol, venue: entry?.venue ?? 'mt5', timeframe: tf, label: entry?.label ?? symbol });
    }
    if (!plan.ok) throw new HttpError(409, 'no qualifying setup for ' + symbol + ': ' + plan.reason, 'NO_SETUP', { reason: plan.reason, plan });
    const side = explicit ?? (plan.direction === 'long' ? 'buy' : plan.direction === 'short' ? 'sell' : null);
    if (!side) throw new HttpError(400, 'direction required: say BUY or SELL', 'DIRECTION_REQUIRED');
    const quote = (engine.lastQuotes ?? []).find((q) => q.symbol === symbol) ?? (await engine.refreshQuotes()).find((q) => q.symbol === symbol);
    if (!quote) throw new HttpError(503, 'no live quote for this symbol', 'STALE_DATA');
    const targetMatch = text.match(/(?:PROFIT|TARGET|SASARAN)\s*(?:MYR|RM|USD|USDC)?\s*([0-9][0-9,._]*)/i);
    const lotMatch = text.match(/(?:LOT|LOTS|VOLUME|QTY|QUANTITY)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)/i);
    const entriesMatch = text.match(/(?:ENTRIES|ENTRY|KALI|ORDERS)\s*[:=]?\s*(\d+)/i);
    const requestedProfit = targetMatch ? Number(targetMatch[1].replace(/[,_]/g, '')) : null;
    const requestedQty = lotMatch ? Number(lotMatch[1]) : null;
    const requestedEntries = Math.min(10, Math.max(1, Number(entriesMatch?.[1] ?? 1)));
    const stop = Number(plan.stop); const target = Number(plan.target1); const distance = Math.abs(target - quote.price);
    const targetQty = requestedProfit && distance > 0 ? requestedProfit / distance : null;
    const state = await terminalState(user);
    const decision = engine.risk.evaluate({ ...plan, ok: true, manual: true, entry: quote.price, stop, target1: target }, { equity: state.account.equity, openPositions: store.openPositions(user.id), dayPnl: state.account.dayPnl, dayTrades: state.account.dayTrades, lastTradeAt: store.lastTradeAt(user.id, symbol), positionMap: { [symbol]: quote.price } });
    const sizedQty = decision.sizing?.qty ?? 0;
    const qty = requestedQty ? Math.min(requestedQty, sizedQty) : sizedQty;
    const sliceQty = qty / requestedEntries;
    const entries = Array.from({ length: requestedEntries }, (_, i) => ({ index: i + 1, qty: sliceQty, entry: quote.price, stop, target }));
    const lotWarning = requestedQty && requestedQty > sizedQty ? `Requested lot ${requestedQty} exceeds risk-sized volume ${sizedQty}; capped.` : null;
    const batchWarning = requestedEntries > 1 ? `Batch has ${requestedEntries} entries. Each order is sent separately and stops when one is rejected.` : null;
    return { ok: true, symbol, venue: entry?.venue ?? 'mt5', timeframe: tf, side, mode: store.account(user.id)?.live_enabled && config.live && broker?.configured ? 'live' : 'paper', entry: quote.price, stop, target, qty, sliceQty, entries, requestedEntries, requestedQty, requestedProfit, estimatedProfit: distance * qty, targetQty, rewardRisk: plan.rewardRisk, confidence: plan.confidence, playbook: plan.playbook, thesis: plan.thesis, risk: decision.sizing, discovered: discovered ? { symbol: discovered, requiresAddToWatchlistBeforeOrder: true } : undefined, warning: [lotWarning, batchWarning, requestedProfit ? 'Profit target is an estimate, not a guarantee. Confirm volume, margin and stop before sending.' : 'Review the proposal before sending.'].filter(Boolean).join(' ') };
  });

  /* ---------------------------------- AI -------------------------------- */

  router.get('/api/ai/messages', async (ctx) => {
    const user = requireLicence(ctx);
    return { messages: store.messages(user.id), mode: analyst.mode, provider: analyst.providerLabel };
  });

  router.post('/api/ai/ask', async (ctx) => {
    // Metered: this costs real compute, so it draws from the licence quota.
    const user = requireLicence(ctx, { metered: true, cost: config.licence.cost.ask });
    const question = String(ctx.body?.question ?? '').trim().slice(0, 2000);
    if (question.length < 2) throw new HttpError(400, 'question required', 'BAD_REQUEST');
    const lim = expensiveLimiter.check(`ai:${user.id}`);
    if (!lim.ok) throw new HttpError(429, 'AI is rate limited', 'RATE_LIMITED');
    const quotes = engine.lastQuotes ?? [];
    const plans = [];
    const aiTimeframe = userTradingPrefs(user).timeframe ?? config.loop.timeframe;
    for (const entry of selectedWatchlist(user).slice(0, 6)) {
      try {
        const candles = await market.candles({ venue: entry.venue, symbol: entry.symbol, timeframe: aiTimeframe, limit: config.loop.historyBars });
        const { buildPlan } = await import('./analysis/engine.js');
        plans.push(buildPlan(candles, { symbol: entry.symbol, venue: entry.venue, timeframe: aiTimeframe, label: entry.label }));
      } catch {
        /* one unavailable symbol must not break the question */
      }
    }
    const acc = engine.accountState(user);
    const risk = engine.risk.report({ equity: acc.equity, openPositions: acc.positions, dayPnl: acc.dayPnl, startingEquity: store.account(user.id)?.starting_equity ?? 0 });
    const history = store.messages(user.id, 8);
    // Assign a permanent support room on first chat, then relay user messages
    // to the owner's Telegram with the room card. AI answers are not relayed.
    const roomId = supportRoomFor(user.id);
    store.setSetting(user.id, 'support_room', roomId);
    store.addMessage({ userId: user.id, role: 'user', content: question, provider: analyst.providerLabel });
    notifySupportMessage(user, question, 'user');
    const headlines = (await loadNews()).items ?? [];
    const answer = await analyst.ask({ question, plans, positions: acc.positions, risk, history, news: headlines, userId: user.id });
    store.addMessage({ userId: user.id, role: 'assistant', content: answer.answer, context: { mode: answer.mode, plans: plans.filter((p) => p.ok).length }, provider: answer.provider });
    store.audit({ userId: user.id, actor: 'user', action: 'ai_question', detail: { mode: answer.mode, room: roomId }, ip: ctx.ip });
    return { ...answer, room: roomId };
  });

  router.get('/api/ai/explain', async (ctx) => {
    const user = requireLicence(ctx);
    const { venue, symbol } = ctx.query;
    const tf = ctx.query?.tf ?? userTradingPrefs(user).timeframe ?? config.loop.timeframe;
    if (!venue || !symbol) throw new HttpError(400, 'venue and symbol required', 'BAD_REQUEST');
    const candles = await market.candles({ venue, symbol, timeframe: tf, limit: config.loop.historyBars });
    const { buildPlan } = await import('./analysis/engine.js');
    const plan = buildPlan(candles, { symbol, venue, timeframe: tf });
    return { explanation: analyst.explainPlan(plan), plan };
  });

  /* ------------------------------- backtest ------------------------------ */

  router.post('/api/backtest', async (ctx) => {
    // Metered: this costs real compute, so it draws from the licence quota.
    const user = requireLicence(ctx, { metered: true, cost: config.licence.cost.backtest });
    const lim = expensiveLimiter.check(`bt:${user.id}`);
    if (!lim.ok) throw new HttpError(429, 'backtests are rate limited to 20/min', 'RATE_LIMITED');
    const { venue, symbol, tf = '1h', bars = 1000, equity } = ctx.body ?? {};
    if (!venue || !symbol) throw new HttpError(400, 'venue and symbol required', 'BAD_REQUEST');
    const candles = await market.candles({ venue, symbol, timeframe: tf, limit: Math.min(Number(bars) || 1000, 1000) });
    const result = backtester.run(candles, {
      symbol,
      venue,
      timeframe: tf,
      equity: Number(equity) || store.account(user.id)?.starting_equity || config.account.startingEquity,
    });
    store.audit({ userId: user.id, actor: 'user', action: 'backtest_run', detail: { venue, symbol, tf, trades: result.trades?.length ?? 0 }, ip: ctx.ip });
    return result;
  });

  /* -------------------------------- admin -------------------------------- */

  router.get('/api/admin/overview', async (ctx) => {
    requireOwnerSession(ctx);
    const users = store.listUsers();
    const positions = store.get("SELECT COUNT(*) c FROM positions WHERE status = 'open'");
    const orders = store.get('SELECT COUNT(*) c FROM orders');
    const signals = store.get('SELECT COUNT(*) c FROM signals');
    return {
      users: users.map((u) => ({ ...u, password_hash: undefined, salt: undefined })),
      counts: { users: users.length, openPositions: positions?.c ?? 0, orders: orders?.c ?? 0, signals: signals?.c ?? 0 },
      engine: engine.status(),
      market: market.healthReport(),
      events: store.serviceEvents(60),
      audit: store.auditTrail(80),
      config: {
        live: config.live,
        broker: config.broker,
        timeframe: config.loop.timeframe,
        intervalMs: config.loop.intervalMs,
        watchlist: config.watchlist,
        risk: config.account,
        analyst: { mode: analyst.mode, provider: analyst.providerLabel },
        dbFile: path.basename(config.dbFile),
      },
    };
  });

  /* ---------------------------- vault & memory -------------------------- */

  router.get('/api/vault', async (ctx) => {
    requireLicence(ctx);
    if (!vault) return { graph: { nodes: [], edges: [], meta: {} }, notes: [], tags: [], stats: {} };
    return vault.snapshot();
  });

  router.del('/api/vault/note/:id', async (ctx) => {
    const user = requireLicence(ctx);
    if (!vault) throw new HttpError(503, 'vault unavailable', 'DISABLED');
    const note = vault.get(ctx.params.id);
    if (!note) throw new HttpError(404, 'note not found', 'NOT_FOUND');
    if (!user.owner && note.owner !== user.id) throw new HttpError(403, 'only the author of a note can delete it', 'FORBIDDEN');
    vault.delete(ctx.params.id);
    store.audit({ userId: user.id, actor: 'user', action: 'vault_note_deleted', detail: ctx.params.id, ip: ctx.ip });
    return { ok: true };
  });

  router.get('/api/vault/note/:id', async (ctx) => {
    const user = requireLicence(ctx);
    if (!vault) throw new HttpError(503, 'vault unavailable', 'DISABLED');
    const note = vault.get(ctx.params.id);
    if (!note) throw new HttpError(404, 'note not found', 'NOT_FOUND');
    note.editable = Boolean(user.owner || note.owner === user.id);
    delete note.owner;
    return { note, backlinks: vault.backlinks(note.id), outgoing: vault.outgoing(note.id), unlinked: vault.unlinkedMentions(note.id) };
  });

  router.get('/api/vault/search', async (ctx) => {
    requireLicence(ctx);
    if (!vault) return { query: '', results: [] };
    const { q = '', limit } = ctx.query;
    return { query: q, results: vault.search(q, { limit: Math.min(Number(limit) || 20, 50) }) };
  });

  router.post('/api/vault/note', async (ctx) => {
    const user = requireLicence(ctx);
    if (!vault) throw new HttpError(503, 'vault unavailable', 'DISABLED');
    const { content, path: notePath, title, tags } = ctx.body ?? {};
    if (!content || typeof content !== 'string' || !content.trim()) throw new HttpError(400, 'content required', 'BAD_REQUEST');
    if (title !== undefined && (typeof title !== 'string' || title.length > 160)) throw new HttpError(400, 'title must be text of at most 160 characters', 'BAD_REQUEST');
    if (notePath !== undefined && (typeof notePath !== 'string' || notePath.length > 200 || notePath.includes('..'))) throw new HttpError(400, 'path is invalid', 'BAD_REQUEST');
    const cleanTags = Array.isArray(tags) ? tags.map((t) => String(t).trim().toLowerCase().replace(/^#/, '')).filter((t) => /^[\p{L}\p{N}_/-]{1,40}$/u.test(t)).slice(0, 12) : [];
    // Writing to an existing path updates that note, so the same author rule applies.
    const existing = notePath ? vault.resolve(String(notePath).replace(/^\/+/, '')) : null;
    const existingNote = existing ? vault.notes.get(existing) : null;
    if (existingNote && !user.owner && existingNote.owner !== user.id) throw new HttpError(403, 'that note belongs to someone else', 'FORBIDDEN');
    const note = vault.write({ content, path: notePath, title, tags: cleanTags, source: user.owner ? 'owner' : 'user', owner: user.id });
    store.audit({ userId: user.id, actor: 'user', action: 'vault_note_written', detail: { path: note.path, bytes: note.bytes }, ip: ctx.ip });
    bus.emit('vault', { action: 'write', title: note.title });
    return { note };
  });


  router.get('/api/memory', async (ctx) => {
    requireLicence(ctx);
    return {
      stats: memory.stats(),
      recent: memory.recent({ limit: 30 }),
      recall: (ctx.query.q ? memory.recall({ query: ctx.query.q }) : null),
    };
  });

  router.post('/api/memory/consolidate', async (ctx) => {
    const user = requireLicence(ctx);
    const lim = expensiveLimiter.check(`consolidate:${user.id}`);
    if (!lim.ok) throw new HttpError(429, 'consolidation is rate limited', 'RATE_LIMITED');
    const result = memory.consolidate();
    store.audit({ userId: user.id, actor: 'user', action: 'memory_consolidated', detail: result, ip: ctx.ip });
    bus.emit('vault', { action: 'consolidate', ...result });
    return { result, stats: memory.stats(), vault: vault.snapshot().stats };
  });

  /**
   * Device RAM telemetry. The backend runs on the user's phone, so the client
   * should be able to show what the vault and memory are actually costing.
   */
  router.get('/api/system', async (ctx) => {
    requireLicence(ctx);
    return { ...systemMemory(), vault: vault ? vault.snapshot().stats : null, memory: memory ? memory.stats() : null, deploy: { mode: config.deploy?.mode ?? 'device', frontendOrigin: config.deploy?.frontendOrigin || null } };
  });

  /* --------------------------------- files ------------------------------ */

  /**
   * Raw upload.
   *
   * The body is the file itself (not multipart), with metadata in query params
   * or headers. That keeps the server dependency-free and lets the client
   * stream straight from a File object with XHR/fetch progress.
   */
  router.post('/api/files', async (ctx) => {
    const user = requireLicence(ctx);
    if (!files) throw new HttpError(503, 'file storage not configured', 'DISABLED');
    const lim = uploadLimiter.check(`up:${user.id}`);
    if (!lim.ok) throw new HttpError(429, `upload rate limited, retry in ${lim.retryAfter}s`, 'RATE_LIMITED');

    const filename = ctx.query.name ?? ctx.req.headers['x-filename'] ?? 'upload.bin';
    const title = ctx.query.title ?? null;
    const notes = ctx.query.notes ?? null;
    const declared = Number(ctx.req.headers['content-length']) || null;

    let meta;
    try {
      meta = await files.receive({ userId: user.id, filename, title, notes, body: ctx.req, declaredSize: declared });
    } catch (e) {
      const status = e.code === 'TOO_LARGE' ? 413 : e.code === 'BAD_TYPE' ? 415 : e.code === 'EMPTY' ? 400 : 500;
      throw new HttpError(status, e.message, e.code ?? 'UPLOAD_FAILED');
    }
    store.audit({ userId: user.id, actor: 'user', action: 'file_uploaded', detail: { id: meta.id, name: meta.name, bytes: meta.bytes }, ip: ctx.ip });
    bus.emit('file', { action: 'upload', id: meta.id, name: meta.name });
    return { file: meta };
  });

  router.get('/api/files', async (ctx) => {
    const user = requireLicence(ctx);
    if (!files) return { files: [], stats: null };
    return { files: files.list(user.id), publicFiles: files.publicFiles(20), stats: files.stats(user.id) };
  });

  /** Public download by share token — no session required, that is the point. */
  router.get('/api/files/:id/download', async (ctx) => {
    if (!files) throw new HttpError(503, 'file storage not configured', 'DISABLED');
    // Owner identity comes from the licence cookie; a guest has none.
    let ownerId = null;
    try {
      const key = licenceKeyOf(ctx);
      if (key) {
        const v = licensing.validate(key);
        if (v.ok) ownerId = `lic_${v.keyId}`;
      }
    } catch {
      ownerId = null;
    }
    const row = files.resolveForDownload(ctx.params.id, ownerId);
    if (!row) throw new HttpError(404, 'file not found', 'NOT_FOUND');
    files.countDownload(row.id);
    store.audit({ userId: ownerId, actor: ownerId ? 'user' : 'guest', action: 'file_downloaded', detail: { id: row.id, name: row.name }, ip: ctx.ip });

    // Range support matters for large APKs: a phone that drops the connection
    // resumes instead of starting the 200 MB download again.
    const rangeHeader = ctx.req.headers.range;
    let start = 0;
    let end = null;
    let isRange = false;
    let suffix = null;
    if (rangeHeader) {
      const m = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
      if (m && (m[1] || m[2])) {
        isRange = true;
        if (m[1] === '') suffix = Number(m[2]); // bytes=-N  → last N bytes
        else {
          start = Number(m[1]);
          end = m[2] ? Number(m[2]) : null;
        }
      }
    }

    // Ranges need the total size, which only the backend knows. Look it up once.
    let fileSize = null;
    if (isRange) {
      fileSize = await files.sizeOf(row.id);
      if (fileSize === null) throw new HttpError(410, 'file bytes are gone', 'GONE');
      if (suffix !== null) {
        start = Math.max(0, fileSize - suffix);
        end = fileSize - 1;
      }
      // A start past the end is unsatisfiable: 416, not an empty 206.
      if (start >= fileSize) {
        ctx.res.writeHead(416, { 'content-range': `bytes */${fileSize}` });
        ctx.res.end();
        return null;
      }
    }

    let blob;
    try {
      blob = await files.open(row.id, { start, end });
    } catch {
      throw new HttpError(410, 'file bytes are gone', 'GONE');
    }
    const total = blob.size;
    const last = blob.range.end;
    const length = last - blob.range.start + 1;
    const headers = {
      'content-type': row.mime,
      'content-length': length,
      'content-disposition': `attachment; filename="${safeFilename(row.name)}"`,
      'cache-control': 'private, max-age=0, must-revalidate',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
    };
    if (isRange) headers['content-range'] = `bytes ${blob.range.start}-${last}/${total}`;
    ctx.res.writeHead(isRange ? 206 : 200, headers);
    // The disk backend yields a Node stream, R2 yields a Web ReadableStream.
    // Handle both, or a download sends headers and then hangs.
    const { Readable } = await import('node:stream');
    const nodeStream = typeof blob.stream?.pipe === 'function' ? blob.stream : Readable.fromWeb(blob.stream);
    nodeStream.pipe(ctx.res);
    return null; // response already owned
  });

  router.get('/api/files/:id', async (ctx) => {
    const user = requireLicence(ctx);
    const f = files?.get(ctx.params.id);
    const mine = f && files.list(user.id).some((x) => x.id === f.id);
    if (!f || (!mine && f.visibility !== 'public')) throw new HttpError(404, 'file not found', 'NOT_FOUND');
    return { file: f };
  });

  router.patch('/api/files/:id', async (ctx) => {
    const user = requireLicence(ctx);
    const { visibility, title, notes } = ctx.body ?? {};
    if (visibility === undefined && title === undefined && notes === undefined) {
      throw new HttpError(400, 'nothing to update', 'BAD_REQUEST');
    }
    if (visibility !== undefined && visibility !== 'public' && visibility !== 'private') {
      throw new HttpError(400, 'visibility must be public or private', 'BAD_REQUEST');
    }
    if (!files?.get(ctx.params.id)) throw new HttpError(404, 'file not found', 'NOT_FOUND');

    let f = null;
    if (title !== undefined || notes !== undefined) f = files.updateMeta(ctx.params.id, user.id, { title, notes });
    if (visibility !== undefined) f = files.setVisibility(ctx.params.id, user.id, visibility);
    if (!f) throw new HttpError(404, 'file not found', 'NOT_FOUND');
    store.audit({ userId: user.id, actor: 'user', action: 'file_updated', detail: { id: f.id, visibility: f.visibility, title: f.title }, ip: ctx.ip });
    return { file: f };
  });


  router.post('/api/files/:id/rotate', async (ctx) => {
    const user = requireLicence(ctx);
    const f = files?.rotateToken(ctx.params.id, user.id);
    if (!f) throw new HttpError(404, 'file not found', 'NOT_FOUND');
    store.audit({ userId: user.id, actor: 'user', action: 'file_token_rotated', detail: { id: f.id }, ip: ctx.ip });
    return { file: f };
  });

  router.get('/api/health', async () => {
    return { ok: true, ts: Date.now(), engine: { running: engine.running, cycle: engine.cycle }, market: market.healthReport() };
  });

  /* --------------------------------- SSE -------------------------------- */

  router.get('/api/stream', async (ctx) => {
    const user = requireLicence(ctx);
    const res = ctx.res;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now(), user: user.id })}\n\n`);
    const client = { res, userId: user.id };
    sseClients.add(client);
    const unsubscribe = bus.on((event) => {
      // quotes and cycles are global; personal events are filtered by user
      if (event.payload?.userId && event.payload.userId !== user.id) return;
      try {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client gone; the close handler will clean up */
      }
    });
    const ping = setInterval(() => {
      try {
        res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      } catch {
        /* ignore */
      }
    }, 25_000);
    ctx.onClose.push(() => {
      clearInterval(ping);
      unsubscribe();
      sseClients.delete(client);
    });
    return null; // response already started
  });

  /* ------------------------------ static files --------------------------- */

  /**
   * Public share page, MediaFire-style.
   *
   * `/f/<token>` is what a person sends to a friend. It must work with no login
   * and no JavaScript, so it is rendered server-side. Preview images render
   * inline; everything else gets a download button.
   */
  /** Stream a published file's exact bytes to anyone holding the token. */
  async function serveSharedDownload(ctx, token) {
    const missing = () => {
      // Explicit response: a throw here would leave the socket open, because the
      // share route already bypasses the normal error path.
      if (!ctx.res.headersSent) {
        ctx.res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      }
      return ctx.res.end('This link is not available.');
    };
    if (!files) return missing();
    const row = files.resolveForDownload(token, null);
    if (!row) return missing();
    files.countDownload(row.id);
    store.audit({ userId: null, actor: 'guest', action: 'file_shared_downloaded', detail: { id: row.id }, ip: ctx.ip });
    const safe = String(row.name).replace(/[^A-Za-z0-9._-]/g, '_');

    // The metadata row can outlive the bytes — a file uploaded before the bucket
    // was configured, or an object deleted out of band. Without this the throw
    // escaped the request handler and took the whole process down, so one bad
    // link restarted the server for everyone.
    let stream;
    try {
      stream = await files.openNodeStream(row.id);
    } catch (e) {
      if (e?.code === 'NO_BLOB') {
        ctx.res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return ctx.res.end('This file is no longer available for download.');
      }
      throw e;
    }

    // A dropped client must not leave a half-read stream holding a socket.
    ctx.req.on('close', () => stream.destroy?.());

    ctx.res.writeHead(200, {
      'content-type': row.mime || 'application/octet-stream',
      'content-length': row.bytes,
      'content-disposition': 'attachment; filename="' + safe + '"',
      'cache-control': 'private, max-age=60',
      'x-content-type-options': 'nosniff',
    });
    return stream.pipe(ctx.res);
  }

  async function serveSharePage(ctx, token) {
    if (!files) throw new HttpError(404, 'not found', 'NOT_FOUND');
    const row = files.resolveForDownload(token, null);
    if (!row) {
      const html = shareShell('File not found', '<p class="muted">This link is invalid, or the file was removed.</p>', 404);
      ctx.res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' });
      return ctx.res.end(html);
    }
    files.countDownload(row.id);
    store.audit({ userId: null, actor: 'guest', action: 'file_share_viewed', detail: { id: row.id }, ip: ctx.ip });

    const isImage = /^image\//.test(row.mime);
    const body = `
      <div class="file-card">
        <div class="file-icon">${escapeHtml((row.ext || '.bin').replace('.', '').toUpperCase())}</div>
        <h1>${escapeHtml(row.title || row.name)}</h1>
        <div class="meta">${escapeHtml(row.name)} &middot; ${formatBytes(row.bytes)} &middot; ${row.downloads} download${row.downloads === 1 ? '' : 's'}</div>
        ${row.notes ? `<p class="notes">${escapeHtml(row.notes)}</p>` : ''}
        ${isImage ? `<img class="preview" src="/api/files/${row.id}/download" alt="${escapeHtml(row.name)}" />` : ''}
        <a class="btn" href="/api/files/${row.id}/download" download>Download ${isImage ? '' : formatBytes(row.bytes)}</a>
        <div class="hash">SHA-256 ${escapeHtml(row.sha256.slice(0, 32))}&hellip;</div>
      </div>`;
    const html = shareShell(row.title || row.name, body, 200);
    ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return ctx.res.end(html);
  }

  /**
   * Everything published, on one page: the public face of the file host.
   *
   * Each upload has its own `/f/<token>` link, but a person handing out an APK
   * wants one address to send. This is that address. No login, no JavaScript.
   */
  async function servePublicList(ctx) {
    if (!files) throw new HttpError(404, 'not found', 'NOT_FOUND');
    const rows = files.publicFiles(100);
    const apks = rows.filter((r) => APK_EXT.has(r.ext));
    const others = rows.filter((r) => !APK_EXT.has(r.ext));

    const item = (row) => `
      <li class="row">
        <div class="ic">${escapeHtml((row.ext || '.bin').replace('.', '').toUpperCase())}</div>
        <div class="info">
          <a class="name" href="/f/${escapeHtml(row.shareToken)}">${escapeHtml(row.title || row.name)}</a>
          <div class="sub">${formatBytes(row.bytes)} &middot; ${row.downloads} download${row.downloads === 1 ? '' : 's'}</div>
        </div>
        <a class="get" href="/f/${escapeHtml(row.shareToken)}/download" download>Download</a>
      </li>`;

    const section = (title, list) =>
      !list.length ? '' : `<h2>${title}</h2><ul class="list">${list.map(item).join('')}</ul>`;

    const body = `
      <div class="listing">
        <header>
          <h1>Files</h1>
          <p class="muted">Public uploads. Every file is served straight from storage.</p>
        </header>
        ${rows.length ? section('Android apps', apks) + section('Other files', others) : '<p class="muted empty">Nothing is published yet.</p>'}
      </div>`;

    const html = listShell('Files', body);
    ctx.res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'cache-control': 'public, max-age=30',
      'x-content-type-options': 'nosniff',
    });
    return ctx.res.end(html);
  }

  async function serveStatic(ctx) {
    let rel = ctx.url.pathname;
    if (rel === '/') rel = '/index.html';
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) throw new HttpError(403, 'forbidden', 'FORBIDDEN');
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) return serveStaticIndex(ctx, filePath);
      const ext = path.extname(filePath).toLowerCase();
      const hashed = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(rel);
      const cache = ext === '.html' ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300, must-revalidate';
      ctx.res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': cache,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'SAMEORIGIN',
      });
      const rs = fs.createReadStream(filePath);
      rs.on('error', () => ctx.res.destroy());
      rs.pipe(ctx.res);
      return undefined;
    } catch (e) {
      if (e.code === 'ENOENT') return serveSpaFallback(ctx);
      throw e;
    }
  }

  async function serveStaticIndex(ctx, dir) {
    const idx = path.join(dir, 'index.html');
    if (fs.existsSync(idx)) {
      const stat = await fs.promises.stat(idx);
      ctx.res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': stat.size, 'cache-control': 'no-cache' });
      fs.createReadStream(idx).pipe(ctx.res);
      return undefined;
    }
    throw new HttpError(404, 'not found', 'NOT_FOUND');
  }

  function serveSpaFallback(ctx) {
    // API 404s stay 404s; deep links fall back to the app shell
    if (ctx.url.pathname.startsWith('/api/')) throw new HttpError(404, 'endpoint not found', 'NOT_FOUND');
    const idx = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      const stat = fs.statSync(idx);
      ctx.res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': stat.size, 'cache-control': 'no-cache' });
      fs.createReadStream(idx).pipe(ctx.res);
      return undefined;
    }
    throw new HttpError(404, 'not found', 'NOT_FOUND');
  }

  /* -------------------------------- server ------------------------------- */

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const onClose = [];
    const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), ip: 'local', secure: false, user: null, body: null, resHeaders: [], onClose };

    const base = ctxOf(req);
    Object.assign(ctx, base);

    const isApi = url.pathname.startsWith('/api/');
    try {
      if (isApi) {
        // Preflight for the Cloudflare-hosted frontend.
        if (req.method === 'OPTIONS') {
          const cors = corsHeaders(req.headers.origin);
          res.writeHead(cors['access-control-allow-origin'] ? 204 : 403, { ...cors, 'content-length': '0' });
          return res.end();
        }
        const lim = apiLimiter.check(ctx.ip);
        if (!lim.ok) throw new HttpError(429, 'rate limited', 'RATE_LIMITED');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        checkOrigin(req, ctx);
        // Uploads are streamed by their handler and must never be buffered here:
        // an APK is orders of magnitude larger than the JSON body limit.
        const isRawUpload = url.pathname === '/api/files' && req.method === 'POST';
        if (!isRawUpload) ctx.body = await readBody(req);
      }

      const found = router.match(req.method, url.pathname);
      if (found) {
        const result = await found.route.handler({ ...ctx, params: found.params });
        if (result === null) return; // handler owns the response (SSE)
        const headers = { ...corsHeaders(req.headers.origin) };
        if (ctx.resHeaders.length) headers['set-cookie'] = ctx.resHeaders;
        return sendJson(res, 200, result, headers);
      }

      if (isApi) throw new HttpError(404, 'endpoint not found', 'NOT_FOUND');
      // Public pages, reachable with no session: the share page for one file and
      // the listing of everything published.
      if (url.pathname === '/dl' || url.pathname === '/dl/') {
        if (req.method === 'GET' || req.method === 'HEAD') return servePublicList(ctx);
      }
      // /f/<token> is a public share page and must bypass session requirements.
      const shareMatch = url.pathname.match(/^\/f\/([A-Za-z0-9_-]+)(\/download)?\/?$/);
      if (shareMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        return shareMatch[2] ? serveSharedDownload(ctx, shareMatch[1]) : serveSharePage(ctx, shareMatch[1]);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed', 'METHOD_NOT_ALLOWED');
      await serveStatic(ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) logger.error?.(`[http] ${req.method} ${url.pathname}`, e);
      if (!res.headersSent) {
        const headers = { ...corsHeaders(req.headers.origin) };
        if (ctx.resHeaders?.length) headers['set-cookie'] = ctx.resHeaders;
        sendJson(res, status, { error: e.message ?? 'internal error', code: e.code ?? 'INTERNAL', ...(e.extra ?? {}) }, headers);
      } else {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
    } finally {
      for (const fn of onClose) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    }
  });

  server.on('close', () => {
    for (const c of sseClients) {
      try {
        c.res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
  });

  return { server, router, terminalState, sseClients };
}

/** Compact indicator tails for the chart overlay (last `n` bars). */
async function seriesTail(candles, n = 200) {
  const I = await import('./analysis/indicators.js');
  const cl = I.closes(candles);
  const cut = (arr) => arr.slice(-n).map((v) => (v === null || v === undefined ? null : Number(v.toFixed(6))));
  return {
    ema21: cut(I.ema(cl, 21)),
    ema50: cut(I.ema(cl, 50)),
    vwap: cut(I.vwap(candles, 24)),
    rsi: cut(I.rsi(cl, 14)),
  };
}

/**
 * Read the device's real memory state from /proc/meminfo.
 *
 * This process runs on the user's phone, so "how much RAM is the AI using" is a
 * question with a real answer worth surfacing rather than hiding behind a
 * generic cloud dashboard.
 */
function systemMemory() {
  const out = { available: false };
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => {
      const m = raw.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = get('MemTotal');
    const free = get('MemFree');
    const avail = get('MemAvailable');
    const proc = process.memoryUsage();
    out.available = true;
    out.device = { totalBytes: total, freeBytes: free, availableBytes: avail };
    out.process = { rssBytes: proc.rss, heapUsedBytes: proc.heapUsed, heapTotalBytes: proc.heapTotal, externalBytes: proc.external };
    const heap = getHeapStatistics();
    out.heap = { limitBytes: heap.heap_size_limit, usedBytes: heap.used_heap_size };
  } catch {
    const proc = process.memoryUsage();
    out.process = { rssBytes: proc.rss, heapUsedBytes: proc.heapUsed, heapTotalBytes: proc.heapTotal };
  }
  return out;
}

/* --------------------------- share page helpers --------------------------- */

function publicLicence(c) {
  return {
    plan: c.plan,
    quota: c.quota ?? null,
    used: c.used ?? 0,
    remaining: c.remaining ?? null,
    daysLeft: c.daysLeft ?? null,
    expiresAt: c.expiresAt ?? null,
    label: c.label ?? null,
  };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip anything that could break out of a Content-Disposition header. */
function safeFilename(name) {
  return String(name ?? 'download')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w.\- ]+/g, '_')
    .slice(0, 120) || 'download';
}

/** Minimal standalone page: no build step, no JavaScript, works in any browser. */
function shareShell(title, body, status) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} · LuminaVantage Files</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #08090d; color: #eef1f6;
    font: 14px/1.55 'Inter', system-ui, -apple-system, sans-serif;
    background-image: radial-gradient(50rem 30rem at 50% 0%, rgba(200,247,106,0.07), transparent 60%);
  }
  .file-card {
    width: min(460px, 100%); padding: 30px 26px; text-align: center;
    background: rgba(18,21,30,0.82); border: 1px solid rgba(255,255,255,0.09);
    border-radius: 20px; box-shadow: 0 30px 70px -24px rgba(0,0,0,0.9);
  }
  .file-icon {
    width: 62px; height: 62px; margin: 0 auto 16px; display: grid; place-items: center;
    border-radius: 16px; font: 700 15px/1 ui-monospace, monospace; letter-spacing: 0.06em;
    background: rgba(200,247,106,0.13); border: 1px solid rgba(200,247,106,0.32); color: #c8f76a;
  }
  h1 { font-size: 18px; margin: 0 0 6px; letter-spacing: -0.02em; word-break: break-word; }
  .meta { font: 11px/1.5 ui-monospace, monospace; color: #6d7688; margin-bottom: 16px; }
  .notes { font-size: 12.5px; color: #a7b0c0; margin: 0 0 18px; text-align: left; white-space: pre-wrap; }
  .preview { display: block; width: 100%; border-radius: 12px; margin-bottom: 18px; border: 1px solid rgba(255,255,255,0.1); }
  .btn {
    display: inline-block; width: 100%; padding: 13px 20px; border-radius: 11px;
    background: #c8f76a; color: #08090d; font-weight: 700; font-size: 14px;
    text-decoration: none; transition: background 0.16s ease, transform 0.1s ease;
  }
  .btn:hover { background: #d7ff85; }
  .btn:active { transform: scale(0.99); }
  .hash { margin-top: 16px; font: 10px/1.4 ui-monospace, monospace; color: #4a5262; word-break: break-all; }
  .muted { color: #6d7688; }
  .brand { margin-top: 22px; font: 600 10px/1 ui-monospace, monospace; letter-spacing: 0.16em; color: #4a5262; }
</style></head>
<body>
  <main>
    ${body}
    <div class="brand">LUMINAVANTAGE FILES</div>
  </main>
</body></html>`;
}

/** Extensions that are Android install packages, for grouping on the list page. */
const APK_EXT = new Set(['.apk', '.apks', '.xapk', '.aab']);

/** The standalone listing page. Shares the palette of the share page, no script. */
function listShell(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} · LuminaVantage Files</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 40px 20px 60px;
    background: #08090d; color: #eef1f6;
    font: 14px/1.55 'Inter', system-ui, -apple-system, sans-serif;
    background-image: radial-gradient(50rem 30rem at 50% 0%, rgba(200,247,106,0.07), transparent 60%);
  }
  .listing { width: min(680px, 100%); margin: 0 auto; }
  header { margin-bottom: 26px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.03em; }
  h2 { font-size: 12px; margin: 26px 0 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #6d7688; }
  .muted { color: #6d7688; margin: 0; }
  .empty { padding: 30px 0; }
  .list { list-style: none; margin: 0; padding: 0; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; overflow: hidden; }
  .row {
    display: flex; align-items: center; gap: 14px; padding: 14px 16px;
    background: rgba(18,21,30,0.72); border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .row:last-child { border-bottom: 0; }
  .ic {
    flex: none; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 11px;
    font: 700 11px/1 ui-monospace, monospace; letter-spacing: 0.04em;
    background: rgba(200,247,106,0.13); border: 1px solid rgba(200,247,106,0.32); color: #c8f76a;
  }
  .info { flex: 1; min-width: 0; }
  .name {
    color: #eef1f6; font-weight: 600; text-decoration: none; font-size: 14px;
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .name:hover { color: #c8f76a; }
  .sub { font: 11px/1.5 ui-monospace, monospace; color: #5d6678; margin-top: 2px; }
  .get {
    flex: none; padding: 9px 16px; border-radius: 9px; background: #c8f76a; color: #08090d;
    font-weight: 700; font-size: 12.5px; text-decoration: none; transition: background 0.16s ease;
  }
  .get:hover { background: #d7ff85; }
  @media (max-width: 460px) {
    .row { flex-wrap: wrap; }
    .get { width: 100%; text-align: center; }
  }
</style></head>
<body>
  <main>
    ${body}
  </main>
</body></html>`;
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, plan: u.plan, createdAt: u.created_at, lastLogin: u.last_login };
}
