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
import { blobSha } from '../server/artwork.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REAL_CACHE = join(REPO, 'tools/.cache');
const haveCache = existsSync(join(REAL_CACHE, 'db_amiibo.c'));
const opts = { skip: haveCache ? false : 'tools/.cache is empty; run npm run update-db first' };

const PASSWORD = 'a correct horse battery staple';
const MARIO = '0000000000000002';
const MARIO_SMB = '0000000000340102';   // the same character, a different series
const MARIO_GOLD = '00000000003c0102';

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
    // Artwork comes from the same local origin, so neither previewing nor
    // applying ever reaches GitHub. Unrouted paths there answer 404, which is
    // also the real "upstream has no picture for this one yet" case.
    imagesBase: `${origin}/images`,
    manifestUrl: `${origin}/manifest`,
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

/**
 * Wait for a background job and return what it produced.
 *
 * Artwork is fetched outside the request that asked for it — ten thousand
 * pictures do not fit in a response — so a test that wants the result has to
 * wait for it the same way the admin does.
 */
async function awaitJob(s, ref, { timeoutMs = 10_000 } = {}) {
  assert.ok(ref?.id, 'the response named a job');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await get(s, `/api/jobs/${ref.id}`)).json();
    if (job.state !== 'running') {
      assert.notEqual(job.state, 'failed', `the job failed: ${job.error}`);
      return job.result;
    }
    assert.ok(Date.now() < deadline, 'the job never finished');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const db = () => readFile(join(dir, 'site/data/amiibo-db.js'), 'utf8');
const overlayOnDisk = () => readFile(join(dir, 'data/amiibo-overrides.json'), 'utf8').catch(() => null);
const liveCache = () => readFile(join(dir, 'cache/db_amiibo.c'), 'utf8');

/** Serve a firmware with one amiibo renamed, so there is something to review. */
function serveRename(from = '"Mario"', to = '"Mario (Upstream)"') {
  serving = { '/firmware': { body: REAL_FIRMWARE.replace(from, to) }, '/api': { body: REAL_API } };
}

/** Serve a firmware with one amiibo upstream did not have before. */
const NEW_ID = 'ffff0000ffff0002';
function serveAddition(id = NEW_ID, name = 'Invented') {
  const row = `{0x${id.slice(0, 8)}, 0x${id.slice(8)}, "${name}", "${name}"}, \n`;
  serving = {
    '/firmware': { body: REAL_FIRMWARE.replace('{0x00000000,', `${row}{0x00000000,`) },
    '/api': { body: REAL_API },
  };
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

// ---- artwork -------------------------------------------------------------

/** A plausible image index, listing whatever the site already has on disk. */
async function serveManifest(entries = {}) {
  const tree = Object.entries(entries).map(([id, body]) => ({
    path: `icon_${id.slice(0, 8)}-${id.slice(8)}.png`,
    type: 'blob',
    sha: blobSha(Buffer.from(body)),
    size: body.length,
  }));
  // Padded past the plausibility floor, which exists so an error page cannot
  // read as "upstream deleted everything".
  for (let i = 0; i < 600; i++) {
    tree.push({
      path: `icon_ffff${String(i).padStart(4, '0')}-00000002.png`,
      type: 'blob', sha: blobSha(Buffer.from(`pad${i}`)), size: 4,
    });
  }
  serving['/manifest'] = { body: JSON.stringify({ truncated: false, tree }) };
}

test('the preview says what would happen to the artwork', opts, async () => {
  const s = await signIn();
  await mkdir(join(dir, 'site/data/images/full'), { recursive: true });
  await writeFile(join(dir, 'site/data/images/full', `${MARIO}.png`), 'OLD PICTURE');

  // serveRename() replaces the whole routing table, so the manifest route has
  // to be added after it, not before.
  serveRename();
  // Mario's picture moved; the second one upstream has and this site does not.
  await serveManifest({ [MARIO]: 'NEW PICTURE', [MARIO_SMB]: 'A PICTURE' });
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();

  assert.equal(preview.artworkError, null);
  assert.deepEqual(preview.artwork.changed.map((c) => c.id), [MARIO]);
  assert.deepEqual(preview.artwork.added.map((a) => a.id), [MARIO_SMB]);
  assert.deepEqual(preview.artwork.removed, [],
    'an entry with no picture on either side is not a removal');
});

test('an artwork check that fails leaves the data review intact', opts, async () => {
  // Two independent decisions. GitHub rate-limiting the image index is no
  // reason to be unable to review a rename, and reporting the whole preview as
  // broken would make it look like one.
  const s = await signIn();
  serveRename();
  serving['/manifest'] = { status: 403, body: '{"message":"rate limit"}' };
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();

  assert.equal(preview.ok, true, 'the data review is fine');
  assert.equal(preview.diff.counts.renamed, 1);
  assert.equal(preview.artwork, null);
  assert.match(preview.artworkError, /rate-limited/);
});

test('artwork can be checked with nothing pending at all', opts, async () => {
  // The case this exists for: upstream ships the picture a month after the
  // database entry, so there is no data update to carry the fetch and waiting
  // for an unrelated one would be the only alternative.
  const s = await signIn();
  await mkdir(join(dir, 'site/data/images/full'), { recursive: true });
  await writeFile(join(dir, 'site/data/images/full', `${MARIO}.png`), 'A PICTURE');
  await serveManifest({ [MARIO]: 'A PICTURE', [MARIO_SMB]: 'ANOTHER' });

  const body = await (await get(s, '/api/artwork')).json();
  assert.equal(body.ok, true);
  assert.equal(body.artwork.unchanged, 1);
  assert.deepEqual(body.artwork.added.map((a) => a.id), [MARIO_SMB]);
  assert.deepEqual(body.artwork.changed, []);
});

test('the artwork check needs a session, and reports a failure as one', opts, async () => {
  assert.equal((await fetch(`${base}/api/artwork`)).status, 401);

  const s = await signIn();
  serving['/manifest'] = { status: 403, body: '{"message":"rate limit"}' };
  const res = await get(s, '/api/artwork');
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /rate-limited/);
});

test('a pictures-only apply fetches what was accepted and nothing else', opts, async () => {
  // The on-demand path carries verdicts, exactly as the update path does. An
  // earlier version fetched everything missing behind a confirm dialog, which
  // is a bulk action wearing a review's clothes.
  const s = await signIn();
  const full = join(dir, 'site/data/images/full');
  await mkdir(full, { recursive: true });
  await writeFile(join(full, `${MARIO}.png`), 'MINE');
  for (const id of [MARIO_SMB, MARIO_GOLD]) {
    serving[`/images/icon_${id.slice(0, 8)}-${id.slice(8)}.png`] = { body: `ART ${id}` };
  }

  const body = await (await post(s, '/api/artwork/apply', {
    artwork: {
      [MARIO_SMB]: { verdict: 'keep', sha: null, op: 'add' },
      [MARIO_GOLD]: { verdict: 'skip', sha: null, op: 'add' },
    },
  })).json();

  const done = await awaitJob(s, body.artworkJob);
  assert.equal(done.artwork.fetched, 1, 'only the one that was accepted');
  assert.equal(await readFile(join(full, `${MARIO_SMB}.png`), 'utf8'), `ART ${MARIO_SMB}`);
  assert.equal(existsSync(join(full, `${MARIO_GOLD}.png`)), false, 'the declined one is absent');
  assert.equal(await readFile(join(full, `${MARIO}.png`), 'utf8'), 'MINE',
    'and the picture already here is untouched');

  // A declined ARRIVAL records nothing: "not this time" is the same promise the
  // data model makes, and the next check offers it again on its own.
  assert.equal(await overlayOnDisk(), null, 'no overlay was written at all');
});

test('a pictures-only apply never touches the database', opts, async () => {
  const s = await signIn();
  const before = await db();
  await mkdir(join(dir, 'site/data/images/full'), { recursive: true });
  serving[`/images/icon_${MARIO_SMB.slice(0, 8)}-${MARIO_SMB.slice(8)}.png`] = { body: 'ART' };

  await post(s, '/api/artwork/apply', {
    artwork: { [MARIO_SMB]: { verdict: 'keep', sha: null, op: 'add' } },
  });
  assert.equal(await db(), before, 'byte for byte');
});

test('a picture upstream dropped is deleted here only if that is accepted', opts, async () => {
  const s = await signIn();
  const images = join(dir, 'site/data/images');
  await mkdir(join(images, 'full'), { recursive: true });
  await mkdir(join(images, 'thumb'), { recursive: true });
  await writeFile(join(images, 'full', `${MARIO}.png`), 'MINE');
  await writeFile(join(images, 'thumb', `${MARIO}.png`), 'MINE THUMB');

  const declined = await (await post(s, '/api/artwork/apply', {
    artwork: { [MARIO]: { verdict: 'skip', sha: null, op: 'remove' } },
  })).json();
  // Waited for, because a second request while this one runs is refused — the
  // two carry different decisions and merging them would lose one.
  await awaitJob(s, declined.artworkJob);
  assert.equal(existsSync(join(images, 'full', `${MARIO}.png`)), true, 'declined: kept');

  const body = await (await post(s, '/api/artwork/apply', {
    artwork: { [MARIO]: { verdict: 'keep', sha: null, op: 'remove' } },
  })).json();
  const done = await awaitJob(s, body.artworkJob);
  assert.equal(done.artwork.deleted, 2, 'accepted: gone from every tier');
  assert.equal(existsSync(join(images, 'full', `${MARIO}.png`)), false);
  assert.equal(existsSync(join(images, 'thumb', `${MARIO}.png`)), false);
});

test('applying fetches artwork for the entries it added', opts, async () => {
  // The gap this closes: the admin could add two amiibo to the database and
  // leave the site with no pictures for them, reporting nothing, because the
  // image fetch lived only in the command-line tool.
  const s = await signIn();
  serveAddition();
  serving[`/images/icon_${NEW_ID.slice(0, 8)}-${NEW_ID.slice(8)}.png`] = { body: 'PNGDATA' };
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();

  const body = await (await post(s, '/api/upstream/apply',
    { fingerprint: preview.fingerprint, decisions: {} })).json();

  // The update itself is finished the moment it responds; the pictures follow.
  const done = await awaitJob(s, body.artworkJob);
  assert.equal(done.artwork.fetched, 1);
  assert.match(done.summary, /Artwork: 1 fetched/);
  assert.equal(
    await readFile(join(dir, 'site/data/images/full', `${NEW_ID}.png`), 'utf8'),
    'PNGDATA',
    'and it landed in the public site, beside the database it belongs to');
});

test('artwork is fetched only for what was accepted', opts, async () => {
  const s = await signIn();
  serveAddition();
  serving[`/images/icon_${NEW_ID.slice(0, 8)}-${NEW_ID.slice(8)}.png`] = { body: 'PNGDATA' };
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();
  const decisions = Object.fromEntries(preview.diff.changes.map((c) => [c.key, 'skip']));

  const body = await (await post(s, '/api/upstream/apply',
    { fingerprint: preview.fingerprint, decisions })).json();

  assert.equal(body.artworkJob, null, 'nothing was added, so no job was started');
  assert.equal(existsSync(join(dir, 'site/data/images/full', `${NEW_ID}.png`)), false);
});

test('declining a picture records the version refused, and holds it', opts, async () => {
  // Both halves of the semantic in one test, because either alone is a
  // different feature: the refusal must stick against THAT version, and it must
  // not stick against a later one.
  const s = await signIn();
  await mkdir(join(dir, 'site/data/images/full'), { recursive: true });
  await writeFile(join(dir, 'site/data/images/full', `${MARIO}.png`), 'OLD PICTURE');

  serveRename();
  await serveManifest({ [MARIO]: 'NEW PICTURE' });
  await post(s, '/api/upstream/refresh');
  let preview = await (await get(s, '/api/upstream/preview')).json();
  const sha = preview.artwork.changed[0].sha;

  await post(s, '/api/upstream/apply', {
    fingerprint: preview.fingerprint,
    decisions: {},
    artwork: { [MARIO]: { verdict: 'skip', sha } },
  });

  const overlay = JSON.parse(await overlayOnDisk());
  assert.equal(overlay.artwork[MARIO].declined, sha, 'the version refused is written down');
  assert.equal(await readFile(join(dir, 'site/data/images/full', `${MARIO}.png`), 'utf8'),
    'OLD PICTURE', 'and the picture on disk is untouched');

  // The same version again: not offered, because that decision was already made.
  serveRename();
  await serveManifest({ [MARIO]: 'NEW PICTURE' });
  await post(s, '/api/upstream/refresh');
  preview = await (await get(s, '/api/upstream/preview')).json();
  assert.deepEqual(preview.artwork.changed, []);
  assert.equal(preview.artwork.held, 1);

  // A different version: a new question, because the record names one picture
  // and not the amiibo forever.
  serveRename();
  await serveManifest({ [MARIO]: 'NEWER STILL' });
  await post(s, '/api/upstream/refresh');
  preview = await (await get(s, '/api/upstream/preview')).json();
  assert.equal(preview.artwork.changed.length, 1);
});

test('accepting a picture replaces it, and clears any older refusal', opts, async () => {
  const s = await signIn();
  const full = join(dir, 'site/data/images/full');
  await mkdir(full, { recursive: true });
  await mkdir(join(dir, 'site/data/images/thumb'), { recursive: true });
  await writeFile(join(full, `${MARIO}.png`), 'OLD PICTURE');
  await writeFile(join(dir, 'site/data/images/thumb', `${MARIO}.png`), 'OLD THUMB');

  serveRename();
  await serveManifest({ [MARIO]: 'NEW PICTURE' });
  serving[`/images/icon_${MARIO.slice(0, 8)}-${MARIO.slice(8)}.png`] = { body: 'NEW PICTURE' };
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();
  const sha = preview.artwork.changed[0].sha;

  // Looked at during the review, which is what stages it.
  const staged = await get(s, `/api/upstream/art/${MARIO}.png`);
  assert.equal(staged.status, 200);
  assert.equal(staged.headers.get('content-type'), 'image/png');
  assert.equal(await readFile(join(full, `${MARIO}.png`), 'utf8'), 'OLD PICTURE',
    'and looking at it changes nothing');

  const body = await (await post(s, '/api/upstream/apply', {
    fingerprint: preview.fingerprint,
    decisions: {},
    artwork: { [MARIO]: { verdict: 'keep', sha } },
  })).json();

  const done = await awaitJob(s, body.artworkJob);
  assert.equal(done.artwork.replaced, 1);
  assert.equal(await readFile(join(full, `${MARIO}.png`), 'utf8'), 'NEW PICTURE');
  const overlay = JSON.parse(await overlayOnDisk());
  assert.equal(overlay.artwork, undefined, 'no refusal is recorded for an acceptance');
});

test('artwork that will not download does not fail the update', opts, async () => {
  // The database is already written and promoted by the time artwork is
  // fetched. A picture that 404s — the normal case for an amiibo newer than the
  // image set — must leave a successful apply that says so, not a failed one.
  const s = await signIn();
  serveAddition();   // no /images route, so the fetch 404s
  await post(s, '/api/upstream/refresh');
  const preview = await (await get(s, '/api/upstream/preview')).json();

  const res = await post(s, '/api/upstream/apply',
    { fingerprint: preview.fingerprint, decisions: {} });
  const body = await res.json();

  assert.equal(res.status, 200, 'the update succeeded');
  assert.equal(body.ok, true);
  assert.match(await db(), new RegExp(NEW_ID), 'and the entry is in the database');

  // The invented entry is among those with no picture. Not the whole set, and
  // not a count: this update adds whatever the cached sources have that the
  // committed database does not, which changes as upstream does — writing that
  // down here would fail on the next real update while proving nothing.
  const done = await awaitJob(s, body.artworkJob);
  assert.ok(done.artwork.noArtwork.includes(NEW_ID));
  assert.deepEqual(done.artwork.failed, [], 'a missing picture is not a failure');
  assert.match(done.summary, /have none upstream yet/);
});

test('a fresh server adopts the fetch it just made instead of deleting it', opts, async () => {
  // The first run on a new server, exactly as it happened in production. The
  // cache is empty; UPDATE fetches the sources; the review has nothing in it
  // because the site is already current; the admin then discards the pending
  // fetch — and destroys the only copy. Every save afterwards fails with "the
  // upstream sources have not been fetched yet", which is true, and baffling.
  const s = await signIn();
  await rm(join(dir, 'cache/db_amiibo.c'), { force: true });
  await rm(join(dir, 'cache/amiibo.json'), { force: true });
  assert.equal(existsSync(join(dir, 'cache/db_amiibo.c')), false, 'a bare cache');

  await post(s, '/api/upstream/refresh');
  const body = await (await fetch(`${base}/api/upstream/pending`, {
    method: 'DELETE', headers: authed(s),
  })).json();

  assert.equal(body.adopted, true, 'kept, not deleted');
  assert.equal(existsSync(join(dir, 'cache/db_amiibo.c')), true);
  assert.equal(existsSync(join(dir, 'cache/amiibo.json')), true);

  // And the thing that was broken now works: a save can build.
  const save = await fetch(`${base}/api/overlay`, {
    method: 'PUT',
    headers: authed(s),
    body: JSON.stringify({ schema: 1, amiibos: { [MARIO]: { kind: 'override', name: 'Renamed' } } }),
  });
  assert.equal(save.status, 200, await save.text());
  assert.match(await db(), /Renamed/);
});

test('a server that already has sources still discards a pointless fetch', opts, async () => {
  // The other half: adopting always would leave the live pair replaced by an
  // unreviewed one on every no-op check. The rule is about the ONLY copy.
  const s = await signIn();
  const before = await liveCache();

  await post(s, '/api/upstream/refresh');
  const body = await (await fetch(`${base}/api/upstream/pending`, {
    method: 'DELETE', headers: authed(s),
  })).json();

  assert.equal(body.adopted, false);
  assert.equal(await liveCache(), before, 'the live pair is untouched');
  assert.equal(existsSync(join(dir, 'cache/pending/db_amiibo.c')), false, 'and the fetch is gone');
});

test('a fetch of any size runs outside the request that asked for it', opts, async () => {
  // The reason this machinery exists. Ten thousand pictures cannot come back in
  // a response at any timeout worth setting, and a dropped connection must not
  // abandon the work halfway — so apply answers immediately with a job to poll.
  const s = await signIn();
  const full = join(dir, 'site/data/images/full');
  await mkdir(full, { recursive: true });

  const many = {};
  for (let i = 0; i < 200; i++) {
    const id = `ffff${String(i).padStart(4, '0')}00000002`;
    many[id] = { verdict: 'keep', sha: null, op: 'add' };
    serving[`/images/icon_${id.slice(0, 8)}-${id.slice(8)}.png`] = { body: `ART ${i}` };
  }

  const res = await post(s, '/api/artwork/apply', { artwork: many });
  assert.equal(res.status, 202, 'accepted, not completed');
  const body = await res.json();
  assert.ok(body.artworkJob.id, 'with a job to watch');

  const done = await awaitJob(s, body.artworkJob, { timeoutMs: 30_000 });
  assert.equal(done.artwork.fetched, 200);
  assert.equal(existsSync(join(full, `ffff019900000002.png`)), true, 'the last one landed');
});

test('a second artwork request is refused while one is running, not merged', opts, async () => {
  // Two fetches at once would race on the same files. The refusal is the
  // important half: the second request's decisions are NOT the first's, so
  // answering with the first job's progress would silently discard them —
  // accept a deletion, get back the result of a job that declined one.
  const s = await signIn();
  await mkdir(join(dir, 'site/data/images/full'), { recursive: true });
  const many = {};
  for (let i = 0; i < 120; i++) {
    const id = `ffff${String(i).padStart(4, '0')}00000002`;
    many[id] = { verdict: 'keep', sha: null, op: 'add' };
    serving[`/images/icon_${id.slice(0, 8)}-${id.slice(8)}.png`] = { body: `ART ${i}` };
  }

  const first = await (await post(s, '/api/artwork/apply', { artwork: many })).json();
  const res = await post(s, '/api/artwork/apply', { artwork: many });
  const second = await res.json();

  assert.equal(res.status, 409);
  assert.match(second.error, /already running/);
  assert.equal(second.artworkJob.id, first.artworkJob.id, 'and says which one to watch');
  await awaitJob(s, first.artworkJob, { timeoutMs: 30_000 });
});

test('job progress is readable while the work is still running', opts, async () => {
  const s = await signIn();
  await mkdir(join(dir, 'site/data/images/full'), { recursive: true });
  const many = {};
  for (let i = 0; i < 300; i++) {
    const id = `ffff${String(i).padStart(4, '0')}00000002`;
    many[id] = { verdict: 'keep', sha: null, op: 'add' };
    serving[`/images/icon_${id.slice(0, 8)}-${id.slice(8)}.png`] = { body: `ART ${i}` };
  }

  const body = await (await post(s, '/api/artwork/apply', { artwork: many })).json();
  const job = await (await get(s, `/api/jobs/${body.artworkJob.id}`)).json();

  assert.equal(job.kind, 'artwork');
  assert.equal(job.total, 300, 'the size of the work is known up front');
  assert.ok(job.done <= job.total);
  await awaitJob(s, body.artworkJob, { timeoutMs: 30_000 });
});

test('an unknown job id is a 404, not a crash', opts, async () => {
  const s = await signIn();
  const res = await get(s, '/api/jobs/00000000-0000-0000-0000-000000000000');
  assert.equal(res.status, 404);
});

test('the resizer capability is proven, and says what it tried', opts, async () => {
  // Not "is the binary on PATH". The probe hands a real PNG to each candidate
  // and reads the width back out of the output.
  const s = await signIn();
  const body = await (await get(s, '/api/artwork/capability')).json();
  assert.equal(typeof body.ok, 'boolean');
  if (body.ok) {
    assert.ok(['sips', 'magick', 'convert'].includes(body.tool));
  } else {
    assert.equal(body.tool, null);
    assert.match(body.reason, /no working image tool/);
    assert.ok(Array.isArray(body.tried));
  }
});
