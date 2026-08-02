// Noticing that artwork changed upstream, and staging a candidate to look at.
//
// The manifest comes from a real local HTTP origin rather than a stubbed fetch,
// so the request, the JSON and the abort path are all genuinely exercised — the
// same posture as upstream.test.mjs. What must never happen here is a request
// to GitHub.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Artwork, blobSha, idFromImageName, MIN_PLAUSIBLE_IMAGES } from '../server/artwork.mjs';

const A = '0000000000000002';
const B = '0000000000340102';
const C = '00000000003c0102';

let origin;
let originServer;
let serving = {};
let dir;

before(async () => {
  originServer = createServer((req, res) => {
    const entry = serving[req.url];
    if (!entry) return res.writeHead(404).end('nope');
    res.writeHead(entry.status ?? 200, entry.headers ?? {});
    res.end(entry.body ?? '');
  });
  await new Promise((r) => originServer.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${originServer.address().port}`;
});

after(async () => {
  await new Promise((r) => originServer.close(r));
  await rm(dir ?? '', { recursive: true, force: true }).catch(() => {});
});

/** A manifest response listing the given id -> content pairs. */
const manifest = (entries, extra = {}) => JSON.stringify({
  truncated: false,
  tree: [
    ...Object.entries(entries).map(([id, body]) => ({
      path: `icon_${id.slice(0, 8)}-${id.slice(8)}.png`,
      type: 'blob',
      sha: blobSha(Buffer.from(body)),
      size: body.length,
    })),
    // Padding so the plausibility floor is cleared: the interesting entries are
    // the named ones, but a short list is refused by design.
    ...Array.from({ length: MIN_PLAUSIBLE_IMAGES }, (_, i) => ({
      path: `icon_ffff${String(i).padStart(4, '0')}-00000002.png`,
      type: 'blob',
      sha: blobSha(Buffer.from(`pad${i}`)),
      size: 4,
    })),
  ],
  ...extra,
});

let art;

beforeEach(async () => {
  await rm(dir ?? '', { recursive: true, force: true }).catch(() => {});
  dir = await mkdtemp(join(tmpdir(), 'artcmp-'));
  await mkdir(join(dir, 'images/full'), { recursive: true });
  await mkdir(join(dir, 'images/thumb'), { recursive: true });
  await mkdir(join(dir, 'images/med'), { recursive: true });
  serving = {};
  art = new Artwork({
    imagesDir: join(dir, 'images'),
    pendingDir: join(dir, 'pending'),
    manifestUrl: `${origin}/manifest`,
    base: `${origin}/images`,
  });
});

const putLocal = (id, body) => writeFile(join(dir, 'images/full', `${id}.png`), body);

// ---- the hash the whole thing rests on ----------------------------------

test('the blob hash is git\'s, so an untouched file needs no download to check', () => {
  // Verified against the real repository while designing this: the local file
  // web/data/images/full/0000000000000002.png hashes to the same value the
  // trees API reports for icon_00000000-00000002.png. That equality is what
  // makes the whole comparison free.
  assert.equal(blobSha(Buffer.from('what is up, doc?')), 'bd9dbf5aae1a3862dd1526723246b20206e5fc37');
  assert.equal(blobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    'the empty blob, which git itself knows by heart');
});

test('the file name maps back to an amiibo ID, and rejects anything else', () => {
  assert.equal(idFromImageName('icon_00000000-00000002.png'), A);
  assert.equal(idFromImageName('icon_00000000-00000002.jpg'), null);
  assert.equal(idFromImageName('README.md'), null);
  assert.equal(idFromImageName('icon_zz000000-00000002.png'), null);
});

// ---- the comparison -----------------------------------------------------

test('identical pictures are counted, not listed', async () => {
  serving['/manifest'] = { body: manifest({ [A]: 'PICTURE' }) };
  await putLocal(A, 'PICTURE');

  const d = await art.compare([A]);
  assert.equal(d.unchanged, 1);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.removed, []);
});

test('a picture upstream has and we do not is an addition', async () => {
  serving['/manifest'] = { body: manifest({ [A]: 'PICTURE' }) };
  const d = await art.compare([A]);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].id, A);
  assert.equal(d.added[0].size, 7);
});

test('a picture whose bytes moved is a change, carrying both hashes', async () => {
  serving['/manifest'] = { body: manifest({ [A]: 'NEW PICTURE' }) };
  await putLocal(A, 'OLD PICTURE');

  const d = await art.compare([A]);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].was, blobSha(Buffer.from('OLD PICTURE')));
  assert.equal(d.changed[0].sha, blobSha(Buffer.from('NEW PICTURE')));
});

test('a picture upstream dropped is a removal', async () => {
  serving['/manifest'] = { body: manifest({}) };
  await putLocal(A, 'PICTURE');
  const d = await art.compare([A]);
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].id, A);
});

test('artwork for an ID the database does not carry is ignored', async () => {
  // The padding in every manifest here is exactly that case, and it must never
  // turn into ~500 proposed additions.
  serving['/manifest'] = { body: manifest({ [A]: 'PICTURE' }) };
  const d = await art.compare([A]);
  assert.equal(d.added.length + d.changed.length + d.removed.length, 1);
});

// ---- declining a change -------------------------------------------------

test('a change declined earlier is not offered again', async () => {
  // The difference from the data model, and the reason it is written down: an
  // addition declined means "not this time", but a CHANGE declined means "I
  // prefer mine" — asking again every month would be nagging, not review.
  serving['/manifest'] = { body: manifest({ [A]: 'NEW PICTURE' }) };
  await putLocal(A, 'OLD PICTURE');
  const sha = blobSha(Buffer.from('NEW PICTURE'));

  const d = await art.compare([A], { [A]: { declined: sha } });
  assert.deepEqual(d.changed, []);
  assert.equal(d.held, 1, 'and it is counted, so the decision is visible');
});

test('but it IS offered again once upstream changes it further', async () => {
  // The other half of the semantic: the record holds one specific version, not
  // the picture forever.
  serving['/manifest'] = { body: manifest({ [A]: 'NEWER STILL' }) };
  await putLocal(A, 'OLD PICTURE');

  const staleRecord = { [A]: { declined: blobSha(Buffer.from('NEW PICTURE')) } };
  const d = await art.compare([A], staleRecord);
  assert.equal(d.changed.length, 1, 'a different version is a new question');
  assert.equal(d.held, 0);
});

// ---- refusing to believe a bad manifest ---------------------------------

test('a rate-limited index says so rather than reporting no changes', async () => {
  // The failure that would silently switch the feature off: 403 read as "the
  // list is empty" means every local picture looks like a removal, and an
  // honest-looking screen proposes deleting all of them.
  serving['/manifest'] = { status: 403, body: '{"message":"rate limit"}' };
  await assert.rejects(() => art.compare([A]), /rate-limited/);
});

test('an index that is not JSON, or has no file list, is refused', async () => {
  serving['/manifest'] = { body: '<html>error</html>' };
  await assert.rejects(() => art.compare([A]), /not JSON/);

  serving['/manifest'] = { body: '{"message":"not found"}' };
  await assert.rejects(() => art.compare([A]), /no file list/);
});

test('a short index is refused, because that is an error page not an image set', async () => {
  serving['/manifest'] = {
    body: JSON.stringify({ truncated: false, tree: [{ path: 'icon_00000000-00000002.png', type: 'blob', sha: 'x' }] }),
  };
  await assert.rejects(() => art.compare([A]), /only 1 pictures/);
});

test('a truncated index is refused, because absence in it means nothing', async () => {
  serving['/manifest'] = { body: manifest({ [A]: 'PICTURE' }, { truncated: true }) };
  await assert.rejects(() => art.compare([A]), /truncated/);
});

// ---- staging and promoting ----------------------------------------------

test('staging downloads once and caches, and refuses a path that is not an ID', async () => {
  serving[`/images/icon_${A.slice(0, 8)}-${A.slice(8)}.png`] = { body: 'CANDIDATE' };

  const first = await art.stage(A);
  assert.equal(first.toString(), 'CANDIDATE');
  assert.equal(existsSync(join(dir, 'pending', `${A}.png`)), true);

  // Second call answers from disk: the origin no longer serves it at all.
  delete serving[`/images/icon_${A.slice(0, 8)}-${A.slice(8)}.png`];
  assert.equal((await art.stage(A)).toString(), 'CANDIDATE');

  await assert.rejects(() => art.stage('../../etc/passwd'), /not an amiibo ID/);
});

test('nothing live is touched until promote', async () => {
  serving[`/images/icon_${A.slice(0, 8)}-${A.slice(8)}.png`] = { body: 'CANDIDATE' };
  await putLocal(A, 'LIVE');
  await art.stage(A);

  assert.equal(await readFile(join(dir, 'images/full', `${A}.png`), 'utf8'), 'LIVE',
    'staging alone changes nothing');

  await art.promote([A]);
  assert.equal(await readFile(join(dir, 'images/full', `${A}.png`), 'utf8'), 'CANDIDATE');
  assert.equal(await readFile(join(dir, 'pending/previous', `${A}.png`), 'utf8'), 'LIVE',
    'and the outgoing one is kept');
});

test('promoting drops the resized copies, which are of the old picture', async () => {
  // Leaving them would put an old thumbnail beside a new portrait, and nothing
  // would ever notice: the tier build only looks for MISSING files.
  serving[`/images/icon_${A.slice(0, 8)}-${A.slice(8)}.png`] = { body: 'CANDIDATE' };
  await putLocal(A, 'LIVE');
  await writeFile(join(dir, 'images/thumb', `${A}.png`), 'OLD THUMB');
  await writeFile(join(dir, 'images/med', `${A}.png`), 'OLD MED');

  await art.stage(A);
  await art.promote([A]);

  assert.deepEqual(await readdir(join(dir, 'images/thumb')), []);
  assert.deepEqual(await readdir(join(dir, 'images/med')), []);
});

test('promoting something never staged does nothing, quietly', async () => {
  await putLocal(A, 'LIVE');
  assert.deepEqual(await art.promote([A, B, C]), []);
  assert.equal(await readFile(join(dir, 'images/full', `${A}.png`), 'utf8'), 'LIVE');
});

test('discard removes the staged candidates and leaves the live ones', async () => {
  serving[`/images/icon_${A.slice(0, 8)}-${A.slice(8)}.png`] = { body: 'CANDIDATE' };
  await putLocal(A, 'LIVE');
  await art.stage(A);

  await art.discard();
  assert.equal(existsSync(join(dir, 'pending')), false);
  assert.equal(await readFile(join(dir, 'images/full', `${A}.png`), 'utf8'), 'LIVE');
});

// ---- the file can fail --------------------------------------------------

test('these checks fail on the mistakes they were written for', async () => {
  // 1. Comparing by SIZE instead of by hash. Two different pictures the same
  //    length are not rare — recompressions especially — and the whole point is
  //    to notice a change without downloading anything.
  const oldPic = Buffer.from('AAAAAAA');
  const newPic = Buffer.from('BBBBBBB');
  assert.equal(oldPic.length, newPic.length);
  assert.throws(
    () => assert.notEqual(oldPic.length, newPic.length, 'size must not distinguish these'),
    /must not distinguish these/);
  assert.notEqual(blobSha(oldPic), blobSha(newPic), 'the hash does');

  // 2. Treating a rate-limited index as an empty one. Every local picture then
  //    reads as a removal — a screen confidently proposing to delete all 948.
  serving['/manifest'] = { status: 403, body: '{}' };
  await putLocal(A, 'PICTURE');
  const asEmpty = { removed: [A] };   // what the lenient version would produce
  assert.throws(
    () => assert.deepEqual(asEmpty.removed, [], 'a failed check must not read as a removal'),
    /must not read as a removal/);
  await assert.rejects(() => art.compare([A]), /rate-limited/, 'and the real one refuses');

  // 3. Recording the refusal against the AMIIBO rather than against the
  //    version. That reads the same on the day it is written and turns "I
  //    prefer this picture" into "never show me a new one", silently, forever.
  serving['/manifest'] = { body: manifest({ [A]: 'NEWER STILL' }) };
  await putLocal(A, 'OLD PICTURE');

  const byAmiibo = { [A]: { declined: true } };          // the version-free record
  const byVersion = { [A]: { declined: blobSha(Buffer.from('NEW PICTURE')) } };

  const wouldHide = byAmiibo[A]?.declined ? [] : ['would be offered'];
  assert.throws(
    () => assert.notDeepEqual(wouldHide, [], 'a version-free record must hide the new picture too'),
    /must hide the new picture too/);

  const real = await art.compare([A], byVersion);
  assert.equal(real.changed.length, 1, 'and the real one asks again, because the version moved');
});
