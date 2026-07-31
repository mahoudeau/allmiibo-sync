// The admin service, driven over real HTTP.
//
// The server is started on an ephemeral port against a temporary directory, so
// nothing here touches the repository's own data. The security assertions are
// the point: a public repository means an attacker reads this file too, and
// these are the properties that have to hold anyway.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createAdminServer } from '../server/index.mjs';
import { hashPassword, CSRF_HEADER } from '../server/auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const PASSWORD = 'a correct horse battery staple';

let dir;
let base;
let handle;
let ctx;

// The generator needs the real upstream sources. They live in a gitignored
// cache, so these tests only run where an update has been fetched at least once.
const CACHE = join(REPO, 'tools/.cache');
const haveCache = existsSync(join(CACHE, 'db_amiibo.c'));
const opts = { skip: haveCache ? false : 'tools/.cache is empty; run npm run update-db first' };

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'allmiibo-admin-'));
  await mkdir(join(dir, 'data'), { recursive: true });
  await mkdir(join(dir, 'site/data'), { recursive: true });
  await mkdir(join(dir, 'site/css'), { recursive: true });
  await mkdir(join(dir, 'site/js'), { recursive: true });
  // A database to regenerate over, so the stable series tokens are preserved.
  await copyFile(join(REPO, 'web/data/amiibo-db.js'), join(dir, 'site/data/amiibo-db.js'));
  // The shared assets the admin borrows from the site: the skin, the mascot and
  // the icon set. A real deployment has these already; the temp site needs them
  // copied in for the route to be exercised.
  await copyFile(join(REPO, 'web/css/app.css'), join(dir, 'site/css/app.css'));
  await copyFile(join(REPO, 'web/js/sprite.js'), join(dir, 'site/js/sprite.js'));
  await copyFile(join(REPO, 'web/js/icons.js'), join(dir, 'site/js/icons.js'));

  ctx = createAdminServer({
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: 'a'.repeat(64),
    publicSiteDir: join(dir, 'site'),
    dataDir: join(dir, 'data'),
    cacheDir: CACHE,
    secureCookies: false,
  });
  handle = ctx.server;
  await new Promise((r) => handle.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${handle.address().port}`;
});

after(async () => {
  await new Promise((r) => handle.close(r));
  await rm(dir, { recursive: true, force: true });
});

/** A logged-in client: keeps the cookie and the CSRF token. */
async function signIn(password = PASSWORD) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  const body = await res.json();
  const cookie = (res.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
  return { res, body, cookie, csrf: body.csrf };
}

const authed = (s, extra = {}) => ({ cookie: s.cookie, [CSRF_HEADER]: s.csrf, ...extra });

// ---- authentication -----------------------------------------------------

test('an unauthenticated request is refused', opts, async () => {
  for (const path of ['/api/overlay', '/api/backups', '/api/export', '/api/session']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401, path);
  }
});

test('a wrong password is refused, and says nothing useful', opts, async () => {
  const { res, body } = await signIn('wrong');
  assert.equal(res.status, 401);
  assert.equal(body.error, 'wrong password');
  assert.equal(res.headers.getSetCookie?.()?.length ?? 0, 0, 'and sets no cookie');
});

test('the right password signs you in with a hardened cookie', opts, async () => {
  const { res, body } = await signIn();
  assert.equal(res.status, 200);
  assert.ok(body.csrf, 'and hands over a CSRF token');
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=\d+/);
});

test('a session reads the overlay', opts, async () => {
  const s = await signIn();
  const res = await fetch(`${base}/api/overlay`, { headers: { cookie: s.cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.overlay.schema, 1);
});

test('a forged cookie does not authenticate', opts, async () => {
  const res = await fetch(`${base}/api/overlay`, {
    headers: { cookie: 'allmiibo_admin=made.up' },
  });
  assert.equal(res.status, 401);
});

// ---- CSRF ---------------------------------------------------------------

test('a write without the CSRF token is refused', opts, async () => {
  const s = await signIn();
  const res = await fetch(`${base}/api/overlay`, {
    method: 'PUT',
    headers: { cookie: s.cookie },
    body: JSON.stringify({ schema: 1 }),
  });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /CSRF/);
});

test('a write with another session\'s CSRF token is refused', opts, async () => {
  const a = await signIn();
  const b = await signIn();
  const res = await fetch(`${base}/api/overlay`, {
    method: 'PUT',
    headers: authed({ cookie: a.cookie, csrf: b.csrf }),
    body: JSON.stringify({ schema: 1 }),
  });
  assert.equal(res.status, 403);
});

// ---- saving -------------------------------------------------------------

test('a valid overlay saves, backs up, and rebuilds the site database', opts, async () => {
  const s = await signIn();
  const overlay = {
    schema: 1,
    amiibos: { '0000000000000002': { kind: 'override', name: 'Mario (Smash)' } },
  };
  const res = await fetch(`${base}/api/overlay`, {
    method: 'PUT', headers: authed(s), body: JSON.stringify(overlay),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.entries >= 946);

  // The overlay landed.
  const saved = JSON.parse(await readFile(join(dir, 'data/amiibo-overrides.json'), 'utf8'));
  assert.equal(saved.amiibos['0000000000000002'].name, 'Mario (Smash)');

  // And the public site's database was rebuilt with it, which is what makes
  // this a CMS rather than an editor.
  const db = await readFile(join(dir, 'site/data/amiibo-db.js'), 'utf8');
  assert.match(db, /"Mario \(Smash\)"/);
  assert.match(db, /AMIIBO_UPSTREAM = Object\.freeze\(\{\s*'0000000000000002'/);
});

test('a second save keeps a backup of the first', opts, async () => {
  const s = await signIn();
  const res = await fetch(`${base}/api/overlay`, {
    method: 'PUT', headers: authed(s),
    body: JSON.stringify({ schema: 1, amiibos: {} }),
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).backup, 'a backup was taken');

  const list = await fetch(`${base}/api/backups`, { headers: { cookie: s.cookie } });
  assert.ok((await list.json()).backups.length > 0);
});

test('an invalid overlay is refused and changes nothing', opts, async () => {
  const s = await signIn();
  const before = await readFile(join(dir, 'data/amiibo-overrides.json'), 'utf8');

  const res = await fetch(`${base}/api/overlay`, {
    method: 'PUT', headers: authed(s),
    body: JSON.stringify({ schema: 1, catagories: {} }), // a typo, not a category
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.details.join(' ').includes('catagories'), 'and says which key');

  assert.equal(await readFile(join(dir, 'data/amiibo-overrides.json'), 'utf8'), before,
    'the overlay on disk is untouched');
});

test('an overlay that would collide is refused before anything is written', opts, async () => {
  // Two amiibos in one series folder wanting one filename. The generator gates
  // on this, and the save has to gate on it too.
  const s = await signIn();
  const before = await readFile(join(dir, 'site/data/amiibo-db.js'), 'utf8');

  const res = await fetch(`${base}/api/overlay`, {
    method: 'PUT', headers: authed(s),
    body: JSON.stringify({
      schema: 1,
      amiibos: {
        '0000000000000002': { kind: 'override', fileName: 'Clash' },
        '0000010000190002': { kind: 'override', fileName: 'Clash' },
      },
    }),
  });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /would not build/);
  assert.equal(await readFile(join(dir, 'site/data/amiibo-db.js'), 'utf8'), before,
    'the site database is untouched');
});

test('a path pinned on an ID standing for many dumps is refused', opts, async () => {
  const s = await signIn();
  const res = await fetch(`${base}/api/overlay`, {
    method: 'PUT', headers: authed(s),
    body: JSON.stringify({
      schema: 1,
      amiibos: { '1f00000004c41e03': { kind: 'override', path: 'KAR/Kirby.bin' } },
    }),
  });
  assert.equal(res.status, 422);
  assert.match(JSON.stringify(await res.json()), /vehicle pairings/);
});

// ---- limits and hardening ----------------------------------------------

test('an oversized body is refused rather than buffered', opts, async () => {
  const s = await signIn();
  const res = await fetch(`${base}/api/overlay`, {
    method: 'PUT', headers: authed(s),
    body: 'x'.repeat(5 * 1024 * 1024),
  });
  assert.ok(res.status === 413 || res.status === 400, `got ${res.status}`);
});

test('the UI is served with headers that stop it leaking', opts, async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the site\'s stylesheet, fonts and shared modules are served to the admin', opts, async () => {
  // The admin reuses the skin, the mascot and the icon set rather than keeping
  // second copies. If these stop resolving the admin renders as a blank page,
  // so the route is worth pinning.
  for (const [path, needle] of [
    ['/css/app.css', '--pixel'],
    ['/js/sprite.js', 'pirateMark'],
    ['/js/icons.js', 'ICONS'],
  ]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${path} must be served`);
    assert.match(await res.text(), new RegExp(needle), `${path} looks wrong`);
  }
});

test('the admin\'s own files still win over the shared prefixes', opts, async () => {
  const res = await fetch(`${base}/adminui.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /admin UI/);
});

test('a relative PUBLIC_SITE_DIR still serves the shared assets', opts, async () => {
  // The bug this exists for: join('./web', '/css/app.css') normalises to
  // 'web/css/app.css', which does not start with './web', so the containment
  // check refused the server's own stylesheet as a traversal attempt. The admin
  // then rendered as a blank page, because a failed import runs nothing.
  // Paths are resolved to absolute up front now.
  const relCtx = createAdminServer({
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: 'b'.repeat(64),
    publicSiteDir: './web',        // relative, exactly as .env ships it
    dataDir: './content',
    cacheDir: './tools/.cache',
    secureCookies: false,
  });
  await new Promise((r) => relCtx.server.listen(0, '127.0.0.1', r));
  const relBase = `http://127.0.0.1:${relCtx.server.address().port}`;
  try {
    for (const path of ['/css/app.css', '/js/sprite.js', '/js/icons.js']) {
      const res = await fetch(`${relBase}${path}`);
      assert.equal(res.status, 200, `${path} must be served with a relative config`);
    }
    // And the guard still holds with a relative root.
    const escaped = await fetch(`${relBase}/css/../../package.json`);
    assert.ok(escaped.status === 403 || escaped.status === 404);
  } finally {
    await new Promise((r) => relCtx.server.close(r));
  }
});

test('the shared prefixes cannot be used to escape the public site', opts, async () => {
  for (const attack of ['/css/../../package.json', '/js/../../.env']) {
    const res = await fetch(`${base}${attack}`);
    assert.ok(res.status === 403 || res.status === 404, `${attack} gave ${res.status}`);
  }
});

test('a traversal attempt cannot escape the UI directory', opts, async () => {
  // The one place a request string reaches the filesystem.
  for (const attack of [
    '/../server/auth.mjs',
    '/../../etc/passwd',
    '/..%2f..%2fpackage.json',
    '/%2e%2e/%2e%2e/package.json',
  ]) {
    const res = await fetch(`${base}${attack}`);
    assert.ok(res.status === 403 || res.status === 404, `${attack} gave ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('SESSION_SECRET'), `${attack} leaked a file`);
    assert.ok(!body.includes('"name": "allmiibo-sync"'), `${attack} leaked package.json`);
  }
});

test('an unknown API endpoint is a 404, not a stack trace', opts, async () => {
  const s = await signIn();
  const res = await fetch(`${base}/api/nope`, { headers: { cookie: s.cookie } });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'no such endpoint');
  assert.ok(!JSON.stringify(body).includes('at '), 'no stack');
});

test('logging out clears the cookie', opts, async () => {
  const s = await signIn();
  const res = await fetch(`${base}/api/logout`, { method: 'POST', headers: authed(s) });
  assert.equal(res.status, 200);
  assert.match(res.headers.getSetCookie()[0], /Max-Age=0/);
});

test('a server with no password configured refuses everything', opts, async () => {
  const bare = createAdminServer({ passwordHash: '', sessionSecret: '' });
  await new Promise((r) => bare.server.listen(0, '127.0.0.1', r));
  const port = bare.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/overlay`);
    assert.equal(res.status, 503, 'refuses rather than running unprotected');
  } finally {
    await new Promise((r) => bare.server.close(r));
  }
});

test('the export is the overlay verbatim, as an attachment', opts, async () => {
  const s = await signIn();
  const res = await fetch(`${base}/api/export`, { headers: { cookie: s.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment/);
  assert.equal(await res.text(), await readFile(join(dir, 'data/amiibo-overrides.json'), 'utf8'));
});
