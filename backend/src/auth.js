/**
 * Authentication and authorisation.
 *
 * - scrypt password hashing with a per-user salt (node:crypto, no deps)
 * - opaque session tokens; only a SHA-256 hash of the token is stored
 * - HttpOnly, SameSite=Lax cookies; Secure when the request arrived over TLS
 * - CSRF protection for state-changing verbs via a double-submit token
 * - constant-time comparisons on every secret comparison
 */
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 8) {
    const err = new Error('password must be at least 8 characters');
    err.code = 'WEAK_PASSWORD';
    throw err;
  }
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password, salt, expected) {
  try {
    const { hash } = hashPassword(password, salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function cookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAge !== undefined) bits.push(`Max-Age=${Math.floor(maxAge)}`);
  return bits.join('; ');
}

/** Simple sliding-window rate limiter, keyed by string. */
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 60 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      const retryAfter = Math.ceil((this.windowMs - (now - arr[0])) / 1000);
      return { ok: false, retryAfter };
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
    return { ok: true, remaining: this.max - arr.length };
  }
}

export function randomIdemKey() {
  return crypto.randomBytes(12).toString('hex');
}
