/**
 * Licensing.
 *
 * There are no user accounts any more. A device is activated by an owner-issued
 * key that carries its own commercial terms:
 *
 *   plan      monthly | yearly | lifetime
 *   quota     how many "operations" the key may consume (analyses, AI calls…)
 *   expires   when the subscription lapses
 *
 * The key IS the licence. It is signed with HMAC-SHA256 so the device can
 * validate it offline — the paying customer's phone never needs to phone home
 * to prove it paid, and the owner never has to run a database of logins.
 *
 * Format:  LV1-<base64url(payload)>-<base64url(hmac)>
 *
 * Security note, stated plainly: the owner's signing secret lives on the owner's
 * machine. Anyone who extracts it can mint keys. That is the honest trade of an
 * offline-validated licence versus a server call on every launch. Rotating the
 * secret invalidates every issued key, so it is versioned per owner.
 */
import crypto from 'node:crypto';

const PREFIX = 'LV1';

/** Charset avoids 0/O/1/I so a key can be read off a screen and typed. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const PLANS = {
  trial: { id: 'trial', label: 'Trial', days: 7, defaultQuota: 100 },
  monthly: { id: 'monthly', label: 'Monthly', days: 30, defaultQuota: 5000 },
  yearly: { id: 'yearly', label: 'Yearly', days: 365, defaultQuota: 60000 },
  lifetime: { id: 'lifetime', label: 'Lifetime', days: null, defaultQuota: null },
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

function timingEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export class Licensing {
  constructor({ store, secret, adminSecret = '', logger = console }) {
    if (!secret || String(secret).length < 16) {
      throw new Error('Licensing requires a signing secret of at least 16 characters (LUMINA_LICENSE_SECRET)');
    }
    this.store = store;
    this.secret = String(secret);
    this.adminSecret = String(adminSecret);
    this.logger = logger;
    this._schema();
  }

  _schema() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS licences (
        key_id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL,
        label TEXT,
        quota INTEGER,
        used INTEGER NOT NULL DEFAULT 0,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER,
        last_ip TEXT,
        signature TEXT NOT NULL -- holds the signed payload, so readable keys can be rebuilt
      );
      CREATE INDEX IF NOT EXISTS idx_lic_hash ON licences(key_hash);

      CREATE TABLE IF NOT EXISTS licence_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        key_id TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        ip TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lic_events ON licence_events(ts DESC);
    `);
  }

  /* ------------------------------- minting ------------------------------ */

  /**
   * Owner-only. Creates a key for a plan, with optional overrides, and records
   * it locally so the owner's own panel can list, revoke and audit it.
   */
  issue({ plan = 'monthly', label = '', quota = null, days = null, startingUsed = 0 } = {}) {
    const spec = PLANS[plan];
    if (!spec) throw Object.assign(new Error(`unknown plan: ${plan}`), { code: 'BAD_PLAN' });

    const keyId = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const effectiveDays = days ?? spec.days;
    const expiresAt = effectiveDays === null ? null : now + effectiveDays * 86400000;
    const effectiveQuota = quota === null ? spec.defaultQuota : quota;

    // Human-typeable body: 4 groups of 5 characters, derived from the key id and
    // a random nonce so two keys are never visually similar.
    const body = readable();

    const payload = {
      k: keyId,
      p: plan,
      q: effectiveQuota,
      e: expiresAt,
      i: now,
      n: body,
    };
    const payloadStr = b64u(JSON.stringify(payload));
    const sig = sign(this.secret, payloadStr);
    const key = `${PREFIX}.${payloadStr}.${sig}`;
    const readableKey = `LV-${body}`;

    this.store.run(
      `INSERT INTO licences (key_id,key_hash,plan,label,quota,used,issued_at,expires_at,signature)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      keyId,
      hashKey(readableKey),
      plan,
      label || null,
      effectiveQuota,
      startingUsed,
      now,
      expiresAt,
      payloadStr,
    );
    this.event(keyId, 'issued', { plan, quota: effectiveQuota, expiresAt });

    return {
      key,
      readableKey,
      keyId,
      plan,
      label: label || null,
      quota: effectiveQuota,
      used: startingUsed,
      expiresAt,
      issuedAt: now,
    };
  }

  /* ------------------------------ validation ---------------------------- */

  /**
   * Validate a key fully offline from its signature, then apply the *local*
   * ledger (usage, revocation) which is the only state the device tracks.
   */
  validate(key) {
    const parsed = this.parse(key);
    if (!parsed.ok) return parsed;

    const payload = parsed.payload;
    const row = this.store.get('SELECT * FROM licences WHERE key_id = ?', payload.k);

    // Quota: the signature carries the allowance, but consumption is local.
    // The signature proves the key is genuine; it is NOT the source of truth for
    // mutable commercial terms. An owner top-up or revoke must win, so the local
    // ledger is authoritative for quota and revocation once the row exists.
    const used = row?.used ?? 0;
    const quota = row && row.quota !== null && row.quota !== undefined ? row.quota : payload.q;
    // Same rule for expiry: an owner extension must be visible immediately.
    const expiresAt = row && row.expires_at !== undefined ? row.expires_at : payload.e;
    const expired = expiresAt !== null && expiresAt !== undefined && Date.now() > expiresAt;

    const reasons = [];
    if (expired) reasons.push('expired');
    if (quota !== null && quota !== undefined && used >= quota) reasons.push('quota_exhausted');
    if (row?.revoked) reasons.push('revoked');

    const ok = reasons.length === 0;
    if (row) {
      this.store.run('UPDATE licences SET last_seen = ? WHERE key_id = ?', Date.now(), payload.k);
    }
    return {
      ok,
      reasons,
      keyId: payload.k,
      plan: payload.p,
      quota: quota ?? null,
      used,
      remaining: quota === null || quota === undefined ? null : Math.max(0, quota - used),
      issuedAt: payload.i,
      expiresAt: expiresAt ?? null,
      daysLeft: expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000)) : null,
      label: row?.label ?? null,
    };
  }

  /** Signature check only — no ledger, no clock. Pure crypto. */
  parse(key) {
    if (typeof key !== 'string' || !key.trim()) {
      return { ok: false, reasons: ['missing'] };
    }
    const raw = key.trim();
    let payloadStr;
    let sig;

    if (raw.startsWith(`${PREFIX}.`)) {
      const parts = raw.split('.');
      if (parts.length !== 3) return { ok: false, reasons: ['malformed'] };
      payloadStr = parts[1];
      sig = parts[2];
    } else if (/^LV-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/i.test(raw)) {
      // Readable key: rebuild the payload from the owner's ledger.
      const body = raw.slice(3).replace(/-/g, '').toUpperCase();
      const row = this.store.get('SELECT * FROM licences WHERE key_hash = ?', hashKey(`LV-${group(body)}`));
      if (!row) return { ok: false, reasons: ['unknown_key'] };
      let payload;
      try {
        payload = JSON.parse(unb64u(row.signature).toString());
      } catch {
        return { ok: false, reasons: ['malformed'] };
      }
      if (!payload?.k) return { ok: false, reasons: ['malformed'] };
      return { ok: true, payload };
    } else {
      return { ok: false, reasons: ['malformed'] };
    }

    if (!timingEqual(sign(this.secret, payloadStr), sig)) {
      return { ok: false, reasons: ['bad_signature'] };
    }
    let payload;
    try {
      payload = JSON.parse(unb64u(payloadStr).toString());
    } catch {
      return { ok: false, reasons: ['malformed'] };
    }
    if (!payload?.k) return { ok: false, reasons: ['malformed'] };
    return { ok: true, payload };
  }

  /** Return the human-readable key only for an internal handoff flow. */
  readableKeyForId(keyId) {
    const row = this.store.get('SELECT signature FROM licences WHERE key_id = ?', String(keyId));
    if (!row?.signature) return null;
    try {
      const payload = JSON.parse(unb64u(row.signature).toString());
      return payload?.n ? `LV-${group(String(payload.n).replace(/-/g, ''))}` : null;
    } catch { return null; }
  }

  /** Consume one unit of quota. Called on every metered operation. */
  consume(key, n = 1) {
    const v = this.validate(key);
    if (!v.ok) return { ...v, consumed: 0 };
    const row = this.store.get('SELECT * FROM licences WHERE key_id = ?', v.keyId);
    if (!row) return { ...v, ok: false, reasons: ['unknown_key'], consumed: 0 };
    if (row.quota !== null && row.quota !== undefined && row.used + n > row.quota) {
      return { ...v, ok: false, reasons: ['quota_exhausted'], consumed: 0 };
    }
    this.store.run('UPDATE licences SET used = used + ? WHERE key_id = ?', n, v.keyId);
    return { ...v, ok: true, used: row.used + n, consumed: n, remaining: row.quota === null ? null : Math.max(0, row.quota - row.used - n) };
  }

  /* -------------------------------- owner ------------------------------- */

  /** Constant-time check of the owner panel passphrase. */
  checkOwner(secret) {
    if (!this.adminSecret) return false;
    return timingEqual(String(secret ?? ''), this.adminSecret);
  }

  list({ limit = 100 } = {}) {
    return this.store
      .all('SELECT * FROM licences ORDER BY issued_at DESC LIMIT ?', limit)
      .map((r) => ({
        keyId: r.key_id,
        plan: r.plan,
        label: r.label,
        quota: r.quota,
        used: r.used,
        revoked: Boolean(r.revoked),
        issuedAt: r.issued_at,
        expiresAt: r.expires_at,
        lastSeen: r.last_seen,
        expired: r.expires_at ? Date.now() > r.expires_at : false,
        remaining: r.quota === null ? null : Math.max(0, r.quota - r.used),
      }));
  }

  revoke(keyId, revoked = true) {
    const row = this.store.get('SELECT * FROM licences WHERE key_id = ?', keyId);
    if (!row) return null;
    this.store.run('UPDATE licences SET revoked = ? WHERE key_id = ?', revoked ? 1 : 0, keyId);
    this.event(keyId, revoked ? 'revoked' : 'unrevoked', {});
    return this.list().find((l) => l.keyId === keyId) ?? null;
  }

  /** Top up a customer without issuing a new key. */
  setQuota(keyId, quota) {
    const row = this.store.get('SELECT * FROM licences WHERE key_id = ?', keyId);
    if (!row) return null;
    this.store.run('UPDATE licences SET quota = ? WHERE key_id = ?', quota, keyId);
    this.event(keyId, 'quota_set', { quota });
    return this.list().find((l) => l.keyId === keyId) ?? null;
  }

  extend(keyId, days) {
    const row = this.store.get('SELECT * FROM licences WHERE key_id = ?', keyId);
    if (!row) return null;
    const base = Math.max(Date.now(), row.expires_at ?? Date.now());
    const next = base + days * 86400000;
    this.store.run('UPDATE licences SET expires_at = ? WHERE key_id = ?', next, keyId);
    this.event(keyId, 'extended', { days, expiresAt: next });
    return this.list().find((l) => l.keyId === keyId) ?? null;
  }

  resetUsage(keyId) {
    const row = this.store.get('SELECT * FROM licences WHERE key_id = ?', keyId);
    if (!row) return null;
    this.store.run('UPDATE licences SET used = 0 WHERE key_id = ?', keyId);
    this.event(keyId, 'usage_reset', {});
    return this.list().find((l) => l.keyId === keyId) ?? null;
  }

  event(keyId, action, detail, ip = null) {
    this.store.run('INSERT INTO licence_events (ts,key_id,action,detail,ip) VALUES (?,?,?,?,?)', Date.now(), keyId, action, JSON.stringify(detail ?? null), ip);
  }

  events(limit = 100) {
    return this.store.all('SELECT * FROM licence_events ORDER BY ts DESC LIMIT ?', limit);
  }

  summary() {
    const rows = this.store.all('SELECT * FROM licences');
    const now = Date.now();
    const active = rows.filter((r) => !r.revoked && (r.expires_at === null || r.expires_at > now) && (r.quota === null || r.used < r.quota));
    return {
      total: rows.length,
      active: active.length,
      revoked: rows.filter((r) => r.revoked).length,
      expired: rows.filter((r) => r.expires_at && r.expires_at <= now).length,
      byPlan: rows.reduce((a, r) => {
        a[r.plan] = (a[r.plan] ?? 0) + 1;
        return a;
      }, {}),
      consumed: rows.reduce((a, r) => a + r.used, 0),
    };
  }
}

/* -------------------------------- helpers -------------------------------- */

function hashKey(readable) {
  return crypto.createHash('sha256').update(String(readable).toUpperCase()).digest('hex');
}

/**
 * 20 characters drawn uniformly from a 32-char alphabet (100 bits).
 * Rejection sampling avoids the modulo bias of a naive byte % 32.
 */
function readable() {
  let out = '';
  while (out.length < 20) {
    const buf = crypto.randomBytes(32);
    for (const byte of buf) {
      if (byte < 224) out += ALPHABET[byte & 31];
      if (out.length === 20) break;
    }
  }
  return group(out);
}

function group(s) {
  return s.match(/.{1,5}/g)?.join('-') ?? s;
}
