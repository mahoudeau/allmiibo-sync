// The upstream refresh, over real HTTP.
//
// Deliberately a separate file from server.test.mjs, with its own server and
// its own COPY of the upstream cache. Applying a refresh promotes the pending
// sources over the live ones, and the repository's tools/.cache is the live one
// for every other test and for `npm run update-db`. A test that overwrote it
// would be corrupting real state to check itself.
//
// The sources are served by a local origin rather than fetched, so nothing here
// touches the network.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdminServer } from '../server/index.mjs';
import { hashPassword, CSRF_HEADER } from '../server/auth.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REAL_CACHE = join(REPO, 'tools/.cache');
const haveCache = existsSync(join(REAL_CACHE, 'db_amiibo.c'));
const opts = { skip: haveCache ? false : 'tools/.cache is empty; run npm run update-db first' };

const PASSWORD = 'a correct horse battery staple';
const MARIO = '0000000000000002';

let dir;
let base;
let handle;
let origin;
let originServer;
let serving = {};

let REAL_FIRMWARE = '';
let REAL_API = '';

before(async () => {
  if (haveCache) {
    REAL_FIRMWARE = await readFile(join(REAL_CACHE, 'db_amiibo.c'), 'utf8');
    REAL_API = await readFile(join(REAL_CACHE, 'amiibo.json'), 'utf8');
  }
  originServer = createServer((req, res) => {
    const entry = serving[req.url];
    if (!entry) return res.writeHead(404).end('nope');
    res.writeHead(entry.status ?? 200);
    res.end(entry.body ?? '');
  });
  await new Promise((r) => originServer.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${originServer.address().port}`;
});

after(async () => {
  // beforeEach closes the PREVIOUS admin server, so the last one is still
  // listening and would hold the process open after every test has passed.
  if (handle) await new Promise((r) => handle.close(r));
  await new Promise((r) => originServer.close(r));
  await rm(dir ?? '', { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  if (handle) await new Promise((r) => handle.close(r));
  await rm(dir ?? '', { recursive: true, force: true }).catch(() => {});

  dir = await mkdtemp(join(tmpdir(), 'allmiibo-up-'));
  await mkdir(join(dir, 'data'), { recursive: true });
  await mkdir(join(dir, 'site/data'), { recursive: true });
  await mkdir(join(dir, 'cache'), { recursive: true });

  await copyFile(join(REPO, 'web/data/amiibo-db.js'), join(dir, 'site/data/amiibo-db.js'));
  // Our own copy of the cache: promote() replaces it, and the repository's must
  // not be what gets replaced.
  await copyFile(join(REAL_CACHE, 'db_amiibo.c'), join(dir, 'cache/db_amiibo.c'));
  await copyFile(join(REAL_CACHE, 'amiibo.json'), join(dir, 'cache/amiibo.json'));

  const ctx = createAdminServer({
    passwordHash: hashPassword(PASSWORD),
    sessionSecret: 'a'.repeat(64),
    publicSiteDir: join(dir, 'site'),
    dataDir: join(dir, 'data'),
    cacheDir: join(dir, 'cache'),
    secureCookies: false,
    sources: { 'db_amiibo.c': `${origin}/firmware`, 'amiibo.json': `${origin}/api` },
  });
  handle = ctx.server;
  await new Promise((r) => handle.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${handle.address().port}`;

  // By default the origin serves exactly what is already live: a refresh that
  // changes nothing, which each test then perturbs.
  serving = { '/firmware': { body: REAL_FIRMWARE }, '/api': { body: REAL_API } };
});

async function signIn() {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await res.json();
  return { cookie: (res.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '', csrf: body.csrf };
}
const authed = (s) => ({ cookie: s.cookie, [CSRF_HEADER]: s.csrf });

const get = (s, path) => fetch(`${base}${path}`, { headers: { cookie: s.cookie } });
const post = (s, path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: authed(s), body: JSON.stringify(body ?? {}),
});

const db = () => readFile(join(dir, 'site/data/amiibo-db.js'), 'utf8');
const overlayOnDisk = () => readFile(join(dir, 'data/amiibo-overrides.json'), 'utf8').catch(() => null);
const liveCache = () => readFile(join(dir, 'cache/db_amiibo.c'), 'utf8');

/** Serve a firmware with one amiibo renamed, so there is something to review. */
function serveRename(from = '"Mario"', to = '"Mario (Upstream)"') {
  serving = { '/firmware': { body: REAL_FIRMWARE.replace(from, to) }, '/api': { body: REAL_API } };
}

// ---- the gates -----------------------------------------------------------

test('every upstream route needs a session, and the writes need a token', opts, async () => {
  for (const path of ['/api/upstream', '/api/upstream/preview']) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, path);
  }
  assert.equal((await fetch(`${base}/api/upstream/refresh`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/upstream/apply`, { method: 'POST' })).status, 401);

  // A session but no CSRF token: the existing gate covers the new routes with
  // no new code, including DELETE.
  const s = await signIn();
  for (const [method, path] of [
    ['POST', '/api/upstream/refresh'],
    ['POST', '/api/upstream/apply'],
    ['DELETE', '/api/upstream/pending'],
  ]) {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie: s.cookie } });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
});

// ---- refresh -------------------------------------------------------------

test('a refresh lands in pending and does not touch the live cache', opts, async () => {
  const s = await signIn();
  const before = await liveCache();
  serveRename();

  const res = await post(s, '/api/upstream/refresh');
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.changed, true, 'the sources differ from what is live');

  assert.equal(await liveCache(), before, 'the live cache is untouched');
  const status = await (await get(s, '/api/upstream')).json();
  assert.ok(status.pending, 'and the fetch is visible');
});

test('a refresh of identical sources says nothing moved', opts, async () => {
  const s = await signIn();
  const body = await (await post(s, '/api/upstream/refresh')).json();
  assert.equal(body.changed, false);
});

test('an unfetchable source is a 502 with nothing written', opts, async () => {
  const s = await signIn();
  const before = await liveCache();
  serving = { '/firmware': { status: 500, body: '' }, '/api': { body: REAL_API } };

  const res = await post(s, '/api/upstream/refresh');
  assert.equal(res.status, 502);
  assert.equal(await liveCache(), before);
  const status = await (await get(s, '/api/upstream')).json();
  assert.equal(status.pending, null);
});

test('an error page served with a 200 is refused', opts, async () => {
  const s = await signIn();
  serving = { '/firmware': { body: '<html>Not Found</html>' }, '/api': { body: REAL_API } };
  const res = await post(s, '/api/upstream/refresh');
  assert.equal(res.status, 502);
  assert.match((await res.json()).details[0], /not the database/);
});

// ---- preview -------------------------------------------------------------

test('a preview with nothing pending says so', opts, async () => {
  const s = await signIn();
  const body = await (await get(s, '/api/upstream/preview')).json();
  assert.equal(body.pending, null);
});

test('a preview shows the change and its device consequence', opts, async () => {
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');

  const body = await (await get(s, '/api/upstream/preview')).json();
  assert.equal(body.ok, true, JSON.stringify(body.errors));
  assert.ok(body.fingerprint, 'and hands back something apply can check');

  const renamed = body.diff.changes.filter((c) => c.group === 'renamed');
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].after, 'Mario (Upstream)');

  const naming = body.diff.changes.filter((c) => c.group === 'naming');
  assert.equal(naming.length, 1, 'the file on the device is renamed too');
  assert.match(naming[0].device.before, /\/Mario\.bin$/);
  assert.equal(naming[0].danger, true);

  // A preview writes nothing at all.
  assert.equal(await overlayOnDisk(), null);
  assert.doesNotMatch(await db(), /Mario \(Upstream\)/);
});

test('the report survives the trip, including the field that is a function', opts, async () => {
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');
  const body = await (await get(s, '/api/upstream/preview')).json();

  assert.equal(body.report.seriesLabel, undefined, 'the function is gone, not silently dropped');
  assert.ok(Array.isArray(body.report.mintedSeries), 'and resolved into data');
  assert.ok(body.report.entries > 900);
});

// ---- apply ---------------------------------------------------------------

test('anything not decided is accepted, and the receipt says how many', opts, async () => {
  // Refusing instead meant a row nobody could act on held the whole update
  // hostage. Accepting by default is also what the site does the rest of the
  // time: it follows upstream unless the overlay says otherwise.
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();

  const res = await post(s, '/api/upstream/apply', {
    fingerprint: preview.fingerprint,
    decisions: {},
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.applied.acceptedByDefault, preview.diff.changes.length,
    'every change was taken, and the count is reported rather than assumed');
  assert.match(await db(), /Mario \(Upstream\)/, 'so upstream is published');
  assert.equal(body.applied.pinsWritten, 0, 'and nothing was pinned');
});

test('KEEP publishes upstream and writes no pins', opts, async () => {
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();

  const decisions = Object.fromEntries(preview.diff.changes.map((c) => [c.key, 'keep']));
  const res = await post(s, '/api/upstream/apply', { fingerprint: preview.fingerprint, decisions });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  assert.match(await db(), /Mario \(Upstream\)/, 'the site has the new name');
  assert.equal(body.applied.pinsWritten, 0, 'and the safe answer wrote nothing');
  assert.match(await liveCache(), /Mario \(Upstream\)/, 'the cache was promoted');

  const after = await (await get(s, '/api/upstream')).json();
  assert.equal(after.pending, null, 'and the pending fetch is cleared');
});

test('SKIP holds the old value and records what upstream said', opts, async () => {
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();

  // Skip the rename, keep everything else.
  const decisions = Object.fromEntries(preview.diff.changes.map((c) => [
    c.key, c.group === 'renamed' || c.group === 'naming' ? 'skip' : 'keep',
  ]));
  const res = await post(s, '/api/upstream/apply', { fingerprint: preview.fingerprint, decisions });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  const overlay = JSON.parse(await overlayOnDisk());
  assert.equal(overlay.amiibos[MARIO].name, 'Mario', 'the published name is held');
  assert.equal(overlay.amiibos[MARIO].upstreamWas.name, 'Mario (Upstream)',
    'against what upstream now says');
  assert.ok(overlay.amiibos[MARIO].decidedAt, 'and when the line was drawn');

  assert.match(await db(), /'0000000000000002': "Mario"/, 'the site still says Mario');
  assert.match(await liveCache(), /Mario \(Upstream\)/,
    'while the cache moved on, so the next refresh compares against the new truth');
});

test('a stale preview is refused rather than applied to the wrong world', opts, async () => {
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();
  const decisions = Object.fromEntries(preview.diff.changes.map((c) => [c.key, 'keep']));

  // Something else changed the overlay in between — a second tab saving.
  await fetch(`${base}/api/overlay`, {
    method: 'PUT', headers: authed(s),
    body: JSON.stringify({ schema: 1, amiibos: { [MARIO]: { kind: 'override', name: 'Meanwhile' } } }),
  });

  const res = await post(s, '/api/upstream/apply', { fingerprint: preview.fingerprint, decisions });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /out of date/);
  assert.ok(body.fingerprint, 'and hands back the current one so the UI can reload');

  assert.match(await db(), /Meanwhile/, 'the other save stands');
  assert.equal(await liveCache(), REAL_FIRMWARE, 'and nothing was promoted');
});

test('decisions that would collide are refused, and nothing is written', opts, async () => {
  // The gate that runs AFTER the decisions are applied, and the only case that
  // reaches it: upstream rotates two names in one series — Mario becomes
  // "Dr. Mario" and Dr. Mario becomes something else — which is self-consistent
  // upstream. Skipping only the second half holds Dr. Mario at its old name
  // while Mario takes it too, and two amiibo in one series folder cannot both
  // be called that.
  const s = await signIn();
  const DR_MARIO = '0000010000190002';
  serving = {
    '/firmware': {
      body: REAL_FIRMWARE
        .replace('"Dr. Mario"', '"Dr. Mario RENAMED"')
        .replace(/(?<!Dr\. )"Mario"/, '"Dr. Mario"'),
    },
    '/api': { body: REAL_API },
  };
  await post(s, '/api/upstream/refresh');

  const preview = await (await get(s, '/api/upstream/preview')).json();
  assert.equal(preview.ok, true, 'upstream itself is consistent');

  const dbBefore = await db();
  const overlayBefore = await overlayOnDisk();

  // Keep Mario's move onto the name, skip Dr. Mario's move off it.
  const decisions = Object.fromEntries(preview.diff.changes.map((c) => [
    c.key, String(c.subject) === DR_MARIO ? 'skip' : 'keep',
  ]));
  const res = await post(s, '/api/upstream/apply',
    { fingerprint: preview.fingerprint, decisions });

  assert.equal(res.status, 422, 'refused before anything was written');
  assert.match((await res.json()).error, /would not build/);

  assert.equal(await db(), dbBefore, 'the published database is untouched');
  assert.equal(await overlayOnDisk(), overlayBefore, 'and so is the overlay');
  assert.equal(await liveCache(), REAL_FIRMWARE, 'and nothing was promoted');
});

test('applying with nothing pending is refused', opts, async () => {
  const s = await signIn();
  const res = await post(s, '/api/upstream/apply', { fingerprint: 'x', decisions: {} });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /no pending refresh/);
});

test('discarding throws the fetch away and leaves everything alone', opts, async () => {
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');

  const res = await fetch(`${base}/api/upstream/pending`, { method: 'DELETE', headers: authed(s) });
  assert.equal(res.status, 200);

  const status = await (await get(s, '/api/upstream')).json();
  assert.equal(status.pending, null);
  assert.equal(await liveCache(), REAL_FIRMWARE);
  assert.doesNotMatch(await db(), /Mario \(Upstream\)/);
});

// ---- the receipt ---------------------------------------------------------

test('apply reports the renames it is about to cause', opts, async () => {
  // "14 files will be renamed on every synced device" is worth more than any
  // of the counts.
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();
  const decisions = Object.fromEntries(preview.diff.changes.map((c) => [c.key, 'keep']));

  const body = await (await post(s, '/api/upstream/apply',
    { fingerprint: preview.fingerprint, decisions })).json();

  assert.equal(body.renames.length, 1);
  assert.match(body.renames[0].before, /E:\/amiibo\/SSB\/Mario\.bin/);
  assert.match(body.renames[0].after, /Mario \(Upstream\)\.bin/);
});

test('a skipped rename is not reported as a rename, because it does not happen', opts, async () => {
  const s = await signIn();
  serveRename();
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();
  const decisions = Object.fromEntries(preview.diff.changes.map((c) => [c.key, 'skip']));

  const body = await (await post(s, '/api/upstream/apply',
    { fingerprint: preview.fingerprint, decisions })).json();
  assert.deepEqual(body.renames, []);
});
