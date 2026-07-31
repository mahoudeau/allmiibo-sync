// Login, sessions, rate limiting and CSRF.
//
// The repository is public, so this file reveals the whole scheme. That is
// fine, and is the point: the security is in the secrets, which live only in the
// server's environment, never here and never in git.
//
//   ADMIN_PASSWORD_HASH   scrypt, as produced by hashPassword() below
//   SESSION_SECRET        random, at least 32 bytes of hex
//
// The subdomain the admin answers on is a secret too, but treat it as obscurity
// rather than protection: it appears in DNS and in Certificate Transparency logs
// the moment TLS is issued, which makes subdomains publicly enumerable. What
// actually protects this is below.

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

// scrypt parameters. N=16384 is the usual interactive default: costly enough to
// make guessing expensive, fast enough that one login is imperceptible.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export const SESSION_COOKIE = 'allmiibo_admin';
export const CSRF_HEADER = 'x-csrf-token';

/** Sessions expire, so a forgotten open tab is not a permanent key. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Failed logins are rate limited per client. The window is deliberately long
// relative to the attempt count: a human who mistypes twice is unaffected, and
// anything automated is reduced to a crawl.
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Hash a password for ADMIN_PASSWORD_HASH.
 *
 * Run once, by hand:
 *   node -e "import('./server/auth.mjs').then(m => console.log(m.hashPassword('your password')))"
 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Check a password against a stored hash.
 *
 * Constant-time on the digest comparison, so a wrong password cannot be
 * narrowed down by timing. A malformed or missing hash returns false rather
 * than throwing: a misconfigured server must refuse everyone, not everyone.
 */
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, keyHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ---- sessions -----------------------------------------------------------
//
// A signed, stateless token: the payload says who and until when, and the HMAC
// says the server issued it. No session store, so nothing to lose on restart
// beyond having to log in again.

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Mint a session token valid until now + ttl. */
export function issueSession(secret, { ttlMs = SESSION_TTL_MS, now = Date.now() } = {}) {
  const body = { exp: now + ttlMs, csrf: randomBytes(16).toString('hex') };
  const payload = b64url(JSON.stringify(body));
  return { token: `${payload}.${sign(payload, secret)}`, csrf: body.csrf, expires: body.exp };
}

/**
 * Verify a session token. Returns its payload, or null for anything wrong:
 * missing, malformed, tampered with, or expired.
 */
export function readSession(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, mac] = token.split('.', 2);
  if (!payload || !mac) return null;

  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(mac);
  // Compare in constant time, and only when the lengths already match:
  // timingSafeEqual throws on a length mismatch, which would itself leak.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body?.exp !== 'number' || body.exp <= now) return null;
  return body;
}

/** The Set-Cookie value for a session. */
export function sessionCookie(token, { secure = true, maxAgeMs = SESSION_TTL_MS } = {}) {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    // Strict rather than Lax: nothing here is ever reached by following a link
    // from elsewhere, so there is no usability cost and it removes CSRF from
    // navigations entirely.
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  // Omitted only for local http development; a cookie without it would be sent
  // in the clear.
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** The Set-Cookie value that clears a session. */
export function clearCookie({ secure = true } = {}) {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Pull one cookie out of a Cookie header. */
export function readCookie(header, name = SESSION_COOKIE) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// ---- rate limiting ------------------------------------------------------

/**
 * Failed-attempt tracking, in memory.
 *
 * A restart forgets it, which is an accepted limit: this exists to make guessing
 * impractical, and an attacker cannot restart the process. Entries are dropped
 * once their window passes so the map cannot grow without bound.
 */
export class RateLimiter {
  constructor({ max = MAX_ATTEMPTS, windowMs = LOCKOUT_MS } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  /** Whether this key is currently locked out, and for how much longer. */
  check(key, now = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry) return { locked: false, retryAfterMs: 0 };
    if (now - entry.first > this.windowMs) {
      this.hits.delete(key);
      return { locked: false, retryAfterMs: 0 };
    }
    if (entry.count < this.max) return { locked: false, retryAfterMs: 0 };
    return { locked: true, retryAfterMs: this.windowMs - (now - entry.first) };
  }

  fail(key, now = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry || now - entry.first > this.windowMs) {
      this.hits.set(key, { first: now, count: 1 });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  succeed(key) {
    this.hits.delete(key);
  }

  /** Drop expired entries. Called opportunistically, not on a timer. */
  sweep(now = Date.now()) {
    for (const [key, entry] of this.hits) {
      if (now - entry.first > this.windowMs) this.hits.delete(key);
    }
  }
}

/**
 * The CSRF check for a mutating request.
 *
 * SameSite=Strict already stops a cross-site form post carrying the cookie, so
 * this is the second layer rather than the only one: the token is handed out
 * with the session and has to be echoed in a header, which a cross-origin
 * attacker cannot read.
 */
export function checkCsrf(session, header) {
  if (!session?.csrf || typeof header !== 'string' || !header) return false;
  const a = Buffer.from(session.csrf);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
