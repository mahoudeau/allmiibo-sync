// Fetching the upstream sources, without letting them take effect.
//
// The network is avoided by making the source URLs configurable and pointing
// them at a local origin — one seam, no fetch monkey-patching, and the real
// fetch path including abort and streaming is still exercised.
//
// Almost every test here asserts the same thing from a different angle: the
// live cache is not touched. A refresh that quietly replaced it would mean the
// next unrelated save published unreviewed upstream data, which is the failure
// the whole review screen exists to prevent.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Upstream, MIN_PLAUSIBLE_ENTRIES } from '../server/upstream.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(REPO, 'tools/.cache');
const haveCache = existsSync(join(CACHE, 'db_amiibo.c'));
const opts = { skip: haveCache ? false : 'tools/.cache is empty; run npm run update-db first' };

let dir;
let origin;
let server;
// What the local origin serves, per path. Set per test.
let serving = {};

// Real sources, used as the plausible payloads.
let REAL_FIRMWARE = '';
let REAL_API = '';

before(async () => {
  if (haveCache) {
    REAL_FIRMWARE = await readFile(join(CACHE, 'db_amiibo.c'), 'utf8');
    REAL_API = await readFile(join(CACHE, 'amiibo.json'), 'utf8');
  }

  server = createServer((req, res) => {
    const entry = serving[req.url];
    if (!entry) return res.writeHead(404).end('nope');
    if (entry.hang) return;                       // never responds
    res.writeHead(entry.status ?? 200, entry.headers ?? {});
    res.end(entry.body ?? '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  await rm(dir ?? '', { recursive: true, force: true }).catch(() => {});
  dir = await mkdtemp(join(tmpdir(), 'allmiibo-upstream-'));
  await mkdir(dir, { recursive: true });
  // A live pair that must survive everything below.
  await writeFile(join(dir, 'db_amiibo.c'), 'LIVE-FIRMWARE', 'utf8');
  await writeFile(join(dir, 'amiibo.json'), 'LIVE-API', 'utf8');
  serving = {};
});

/** An Upstream pointed at the local origin. */
const make = (over = {}) => new Upstream({
  cacheDir: dir,
  sources: {
    'db_amiibo.c': `${origin}/firmware`,
    'amiibo.json': `${origin}/api`,
  },
  ...over,
});

/** Serve both sources as the real, plausible payloads. */
function serveReal() {
  serving = {
    '/firmware': { body: REAL_FIRMWARE },
    '/api': { body: REAL_API },
  };
}

const live = async () => ({
  firmware: await readFile(join(dir, 'db_amiibo.c'), 'utf8'),
  api: await readFile(join(dir, 'amiibo.json'), 'utf8'),
});

// ---- the happy path ------------------------------------------------------

test('a refresh lands in pending/ and leaves the live pair alone', opts, async () => {
  serveReal();
  const u = make();
  const meta = await u.refresh({ now: '2026-08-01T00:00:00.000Z' });

  assert.equal(meta.sources.length, 2);
  assert.ok(meta.sources.every((s) => s.entries >= MIN_PLAUSIBLE_ENTRIES));
  assert.equal(meta.changed, true, 'these differ from the placeholder live pair');

  const pending = await u.readPending();
  assert.equal(pending['db_amiibo.c'], REAL_FIRMWARE);
  assert.equal(pending['amiibo.json'], REAL_API);

  const l = await live();
  assert.equal(l.firmware, 'LIVE-FIRMWARE', 'the live cache is untouched');
  assert.equal(l.api, 'LIVE-API');
});

test('promote makes pending live and keeps the outgoing pair', opts, async () => {
  serveReal();
  const u = make();
  await u.refresh();
  await u.promote();

  const l = await live();
  assert.equal(l.firmware, REAL_FIRMWARE, 'the fetch is now live');
  assert.equal(await u.pending(), null, 'and pending is cleared');

  assert.equal(await readFile(join(dir, 'previous/db_amiibo.c'), 'utf8'), 'LIVE-FIRMWARE',
    'the version it replaced is kept for a manual undo');
});

test('discard throws the fetch away and changes nothing', opts, async () => {
  serveReal();
  const u = make();
  await u.refresh();
  await u.discard();

  assert.equal(await u.pending(), null);
  const l = await live();
  assert.equal(l.firmware, 'LIVE-FIRMWARE');
});

test('promote with nothing pending refuses rather than clearing the cache', opts, async () => {
  const u = make();
  await assert.rejects(() => u.promote(), /no pending fetch/);
  assert.equal((await live()).firmware, 'LIVE-FIRMWARE');
});

// ---- what must not be believed ------------------------------------------

test('a 200 carrying an error page is refused, and nothing is written', opts, async () => {
  // The case atomicity does not help with: perfectly well-formed, entirely
  // wrong. GitHub answers 200 with HTML more often than it 404s.
  serving = {
    '/firmware': { body: '<!doctype html><html><body>Not Found</body></html>' },
    '/api': { body: REAL_API },
  };
  const u = make();
  await assert.rejects(() => u.refresh(), /not the database/);

  assert.equal(await u.pending(), null, 'no pending fetch was recorded');
  assert.equal((await live()).firmware, 'LIVE-FIRMWARE', 'and the live pair stands');
});

test('a truncated API payload is refused', opts, async () => {
  const parsed = JSON.parse(REAL_API);
  const few = Object.fromEntries(Object.entries(parsed.amiibos).slice(0, 3));
  serving = {
    '/firmware': { body: REAL_FIRMWARE },
    '/api': { body: JSON.stringify({ ...parsed, amiibos: few }) },
  };
  const u = make();
  await assert.rejects(() => u.refresh(), /only 3 entries/);
  assert.equal(await u.pending(), null);
});

test('a non-2xx is refused with the status', opts, async () => {
  serving = { '/firmware': { status: 503, body: 'busy' }, '/api': { body: REAL_API } };
  await assert.rejects(() => make().refresh(), /HTTP 503/);
  assert.equal((await live()).firmware, 'LIVE-FIRMWARE');
});

test('a body over the cap is aborted rather than buffered whole', opts, async () => {
  serving = { '/firmware': { body: 'x'.repeat(5000) }, '/api': { body: REAL_API } };
  await assert.rejects(() => make({ maxBytes: 1000 }).refresh(), /cap/);
  assert.equal(await make().pending(), null);
});

test('a declared content-length over the cap is refused before the body', opts, async () => {
  serving = {
    '/firmware': { body: 'x', headers: { 'content-length': '99999999' } },
    '/api': { body: REAL_API },
  };
  await assert.rejects(() => make({ maxBytes: 1000 }).refresh(), /over the/);
});

test('an origin that never answers times out rather than hanging', opts, async () => {
  serving = { '/firmware': { hang: true }, '/api': { body: REAL_API } };
  await assert.rejects(() => make({ timeoutMs: 150 }).refresh(),
    (err) => /timeout|abort/i.test(err.message ?? String(err)));
  assert.equal((await live()).firmware, 'LIVE-FIRMWARE');
});

test('the second source failing leaves no half-written pending', opts, async () => {
  serving = { '/firmware': { body: REAL_FIRMWARE }, '/api': { status: 500, body: '' } };
  const u = make();
  await assert.rejects(() => u.refresh());
  assert.equal(await u.pending(), null,
    'no meta.json, so nothing reports a fetch that did not complete');
  assert.equal(await u.readPending(), null);
});

// ---- state a caller can see ---------------------------------------------

test('status reports the live pair and any pending fetch', opts, async () => {
  const u = make();
  const before_ = await u.status();
  assert.equal(before_.live.length, 2);
  assert.ok(before_.live.every((s) => s.present));
  assert.equal(before_.pending, null);

  serveReal();
  await u.refresh();
  const after_ = await u.status();
  assert.ok(after_.pending, 'the fetch is visible');
  assert.equal(after_.pending.sources.length, 2);
});

test('a refresh of identical sources reports that nothing moved', opts, async () => {
  // Worth one glance rather than reading a diff of nothing.
  await writeFile(join(dir, 'db_amiibo.c'), REAL_FIRMWARE, 'utf8');
  await writeFile(join(dir, 'amiibo.json'), REAL_API, 'utf8');
  serveReal();

  const meta = await make().refresh();
  assert.equal(meta.changed, false);
  assert.ok(meta.sources.every((s) => s.changed === false));
});

test('an interrupted refresh reports nothing pending', opts, async () => {
  serveReal();
  const u = make();
  await u.refresh();
  // meta.json is the marker, written last. Without it there is no fetch.
  await rm(join(dir, 'pending/meta.json'));
  assert.equal(await u.pending(), null);
  assert.equal(await u.readPending(), null);
});

test('a write failing part-way leaves no fetch claiming to be complete', opts, async () => {
  // The case the marker ordering exists for, and the only one that reaches it:
  // every fetch happens before any write, so a network failure never gets this
  // far. Here the second write is made to fail, which is what a full disk or a
  // permission problem looks like.
  serveReal();
  const u = make();
  // A directory where a file needs to go: the rename onto it cannot succeed.
  await mkdir(join(dir, 'pending', 'amiibo.json'), { recursive: true });

  await assert.rejects(() => u.refresh());
  assert.equal(await u.pending(), null,
    'meta.json is written last, so a half-finished directory claims nothing');
  assert.equal(await u.readPending(), null);
  assert.equal((await live()).firmware, 'LIVE-FIRMWARE', 'and the live pair stands');
});

// ---- the file can fail ---------------------------------------------------

test('these checks fail if a refresh is allowed to touch the live cache', opts, async () => {
  serveReal();
  const u = make();
  await u.refresh();

  // The assertion every test above leans on.
  const l = await live();
  assert.equal(l.firmware, 'LIVE-FIRMWARE');
  assert.throws(
    () => assert.equal(REAL_FIRMWARE, 'LIVE-FIRMWARE', 'a refresh must not overwrite the cache'),
    /must not overwrite the cache/,
    'and it would notice if it had');

  // The plausibility gate is the one that stops a well-formed wrong answer.
  assert.ok(MIN_PLAUSIBLE_ENTRIES > 100, 'the floor is meaningfully above zero');
  assert.throws(
    () => assert.ok(0 >= MIN_PLAUSIBLE_ENTRIES, 'an error page must not pass the gate'),
    /must not pass the gate/);
});
