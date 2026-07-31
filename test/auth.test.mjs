// The admin's authentication layer.
//
// This file describes the whole scheme, and the repository is public, so the
// scheme has to hold up with the attacker reading it. The secrets live only in
// the server's environment. Everything below is about making sure the code that
// uses them cannot be talked out of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  hashPassword,
  verifyPassword,
  issueSession,
  readSession,
  sessionCookie,
  clearCookie,
  readCookie,
  checkCsrf,
  RateLimiter,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../server/auth.mjs';

const SECRET = randomBytes(32).toString('hex');

// ---- passwords ----------------------------------------------------------

test('a password verifies against its own hash and nothing else', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('Correct horse battery staple', hash), false);
  assert.equal(verifyPassword('', hash), false);
  assert.equal(verifyPassword('correct horse battery stapl', hash), false);
});

test('the same password hashes differently every time', () => {
  // A per-password salt: two accounts with the same password must not be
  // visibly the same, and a precomputed table must not help.
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same', a), true);
  assert.equal(verifyPassword('same', b), true);
});

test('a malformed or missing hash refuses everyone', () => {
  // A misconfigured server must let nobody in, not everybody.
  for (const stored of ['', 'garbage', 'scrypt$1', undefined, null, 'bcrypt$x$y$z$a$b']) {
    assert.equal(verifyPassword('anything', stored), false, `stored=${stored}`);
  }
});

test('a non-string password is refused rather than crashing', () => {
  const hash = hashPassword('x');
  for (const pw of [undefined, null, 42, {}, []]) {
    assert.equal(verifyPassword(pw, hash), false);
  }
});

// ---- sessions -----------------------------------------------------------

test('a freshly issued session reads back', () => {
  const { token, csrf, expires } = issueSession(SECRET);
  const body = readSession(token, SECRET);
  assert.ok(body);
  assert.equal(body.csrf, csrf);
  assert.equal(body.exp, expires);
});

test('a session signed with another secret is refused', () => {
  const { token } = issueSession(SECRET);
  assert.equal(readSession(token, randomBytes(32).toString('hex')), null);
});

test('a tampered payload is refused', () => {
  // The whole point: the payload says when it expires, so it must not be
  // editable without invalidating the signature.
  const { token } = issueSession(SECRET);
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9, csrf: 'x' })).toString('base64url');
  assert.equal(readSession(`${forged}.${mac}`, SECRET), null);
  assert.equal(readSession(`${payload}.${'a'.repeat(mac.length)}`, SECRET), null);
});

test('an expired session is refused', () => {
  const { token } = issueSession(SECRET, { ttlMs: 1000, now: 0 });
  assert.ok(readSession(token, SECRET, { now: 500 }), 'valid inside its window');
  assert.equal(readSession(token, SECRET, { now: 1001 }), null, 'and not outside it');
});

test('garbage never throws, it just fails', () => {
  // A signature of a different length used to be able to throw out of
  // timingSafeEqual, which would itself have been a signal.
  for (const token of ['', 'nodot', 'a.b', '.', 'a.', '.b', null, undefined, 42, 'a.'.repeat(50)]) {
    assert.doesNotThrow(() => readSession(token, SECRET));
    assert.equal(readSession(token, SECRET), null, `token=${token}`);
  }
});

test('sessions expire by default rather than lasting forever', () => {
  const { expires } = issueSession(SECRET, { now: 0 });
  assert.equal(expires, SESSION_TTL_MS);
  assert.ok(SESSION_TTL_MS <= 24 * 60 * 60 * 1000, 'a day at the very most');
});

// ---- cookies ------------------------------------------------------------

test('the session cookie is locked down', () => {
  const cookie = sessionCookie('tok');
  assert.match(cookie, /HttpOnly/, 'not readable from JavaScript');
  assert.match(cookie, /SameSite=Strict/, 'not sent on cross-site requests');
  assert.match(cookie, /Secure/, 'not sent in the clear');
  assert.match(cookie, /Max-Age=\d+/, 'expires');
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=tok`));
});

test('Secure is only ever dropped for local development', () => {
  assert.doesNotMatch(sessionCookie('tok', { secure: false }), /Secure/);
  assert.match(sessionCookie('tok', { secure: false }), /HttpOnly/, 'the rest still applies');
});

test('logging out clears the cookie', () => {
  assert.match(clearCookie(), /Max-Age=0/);
  assert.match(clearCookie(), /HttpOnly/);
});

test('one cookie is picked out of a header of many', () => {
  assert.equal(readCookie(`a=1; ${SESSION_COOKIE}=wanted; b=2`), 'wanted');
  assert.equal(readCookie(`${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second`), 'first');
  assert.equal(readCookie('a=1; b=2'), null);
  assert.equal(readCookie(''), null);
  assert.equal(readCookie(undefined), null);
  assert.equal(readCookie('malformed'), null);
});

test('a cookie whose name merely ends in the right thing is not matched', () => {
  assert.equal(readCookie(`not_${SESSION_COOKIE}=nope`), null);
});

// ---- CSRF ---------------------------------------------------------------

test('a write needs the token that came with the session', () => {
  const { csrf } = issueSession(SECRET);
  const session = { csrf };
  assert.equal(checkCsrf(session, csrf), true);
  assert.equal(checkCsrf(session, `${csrf}x`), false);
  assert.equal(checkCsrf(session, ''), false);
  assert.equal(checkCsrf(session, undefined), false);
  assert.equal(checkCsrf(null, csrf), false);
  assert.equal(checkCsrf({}, csrf), false);
});

test('two sessions do not share a CSRF token', () => {
  assert.notEqual(issueSession(SECRET).csrf, issueSession(SECRET).csrf);
});

// ---- rate limiting ------------------------------------------------------

test('repeated failures lock a client out', () => {
  const rl = new RateLimiter({ max: 3, windowMs: 1000 });
  assert.equal(rl.check('ip', 0).locked, false);
  rl.fail('ip', 0);
  rl.fail('ip', 1);
  assert.equal(rl.check('ip', 2).locked, false, 'still under the limit');
  rl.fail('ip', 2);
  assert.equal(rl.check('ip', 3).locked, true, 'and now over it');
});

test('the lockout lifts once the window passes', () => {
  const rl = new RateLimiter({ max: 1, windowMs: 1000 });
  rl.fail('ip', 0);
  assert.equal(rl.check('ip', 500).locked, true);
  assert.equal(rl.check('ip', 1500).locked, false);
});

test('a success clears the count, so one typo is not held against you', () => {
  const rl = new RateLimiter({ max: 2, windowMs: 1000 });
  rl.fail('ip', 0);
  rl.succeed('ip');
  rl.fail('ip', 1);
  assert.equal(rl.check('ip', 2).locked, false);
});

test('clients are limited independently', () => {
  const rl = new RateLimiter({ max: 1, windowMs: 1000 });
  rl.fail('a', 0);
  assert.equal(rl.check('a', 1).locked, true);
  assert.equal(rl.check('b', 1).locked, false);
});

test('the lockout reports how long is left, and it decreases', () => {
  const rl = new RateLimiter({ max: 1, windowMs: 1000 });
  rl.fail('ip', 0);
  const early = rl.check('ip', 100).retryAfterMs;
  const later = rl.check('ip', 900).retryAfterMs;
  assert.ok(early > later && later > 0, `${early} then ${later}`);
});

test('expired entries are swept, so the map cannot grow without bound', () => {
  const rl = new RateLimiter({ max: 1, windowMs: 1000 });
  for (let i = 0; i < 100; i++) rl.fail(`ip-${i}`, 0);
  assert.equal(rl.hits.size, 100);
  rl.sweep(2000);
  assert.equal(rl.hits.size, 0);
});
