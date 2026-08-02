// Fetching artwork, and the tiers built from it.
//
// Nothing here touches the network or needs an image tool installed: `fetch`
// and the child-process runner are both injected, which is the reason
// fetchArtwork() takes them as arguments. The one thing that must be real is
// the filesystem, because "already have it" and "write it once" are what the
// function is actually for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fetchArtwork, findResizer, removeArtwork, describeArtwork, artUrl, TIERS,
} from '../tools/fetch-amiibo-images.mjs';

const A = '0000000000000002';
const B = '0000000000340102';
const C = '00000000003c0102';

const dir = () => mkdtemp(join(tmpdir(), 'artwork-'));

/** A fetch that answers from a map of URL -> status/body. */
function stubFetch(byId) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const id = /icon_([0-9a-f]{8})-([0-9a-f]{8})\.png$/.exec(url);
    const key = id ? id[1] + id[2] : url;
    const answer = byId[key] ?? { status: 404 };
    return {
      ok: answer.status < 400,
      status: answer.status,
      arrayBuffer: async () => new TextEncoder().encode(answer.body ?? 'PNG').buffer,
    };
  };
  fetch.calls = calls;
  return fetch;
}

/** An exec that records what it was asked to run, and pretends every tool works. */
function stubExec({ has = ['sips'] } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if ((cmd === 'sips' || cmd === 'magick' || cmd === 'convert') && args.some((a) => /version/.test(a))) {
      if (!has.includes(cmd)) throw new Error(`${cmd}: not found`);
      return { stdout: '' };
    }
    // A resize: write the output files the real tool would have written.
    const destIdx = args.indexOf('--out') >= 0 ? args.indexOf('--out') : args.indexOf('-path');
    const destDir = args[destIdx + 1];
    for (const a of args) {
      if (a.endsWith('.png')) {
        await writeFile(join(destDir, a.split('/').pop()), 'RESIZED');
      }
    }
    return { stdout: '' };
  };
  exec.calls = calls;
  return exec;
}

// ---- the URL ------------------------------------------------------------

test('the upstream URL splits the ID the way the image set names files', () => {
  assert.equal(artUrl(A, 'https://x/images'),
    'https://x/images/icon_00000000-00000002.png');
});

// ---- fetching -----------------------------------------------------------

test('only the IDs with no artwork are fetched', async () => {
  const imagesDir = await dir();
  await mkdir(join(imagesDir, 'full'), { recursive: true });
  await writeFile(join(imagesDir, 'full', `${A}.png`), 'ALREADY');

  const fetch = stubFetch({ [B]: { status: 200, body: 'NEW' } });
  const report = await fetchArtwork({
    ids: [A, B], imagesDir, fetch, exec: stubExec(),
  });

  assert.equal(report.cached, 1, 'the one on disk was not re-fetched');
  assert.equal(report.fetched, 1);
  assert.equal(fetch.calls.length, 1, 'and exactly one request went out');
  assert.equal(await readFile(join(imagesDir, 'full', `${A}.png`), 'utf8'), 'ALREADY',
    'the existing file is left exactly as it was');
});

test('a 404 is normal and named, not a failure', async () => {
  // Upstream publishes pictures on its own schedule, so an entry newer than the
  // image set simply has none yet. Counting that as an error would make every
  // update look broken.
  const imagesDir = await dir();
  const report = await fetchArtwork({
    ids: [A, B], imagesDir, exec: stubExec(),
    fetch: stubFetch({ [A]: { status: 200 } }),
  });
  assert.deepEqual(report.noArtwork, [B]);
  assert.deepEqual(report.failed, []);
  assert.equal(report.fetched, 1);
});

test('one bad image does not stop the others', async () => {
  const imagesDir = await dir();
  const report = await fetchArtwork({
    ids: [A, B, C], imagesDir, exec: stubExec(),
    fetch: stubFetch({
      [A]: { status: 200 }, [B]: { status: 500 }, [C]: { status: 200 },
    }),
  });
  assert.equal(report.fetched, 2);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0], /HTTP 500/);
});

test('an ID that is not an amiibo ID is ignored rather than requested', async () => {
  const imagesDir = await dir();
  const fetch = stubFetch({});
  const report = await fetchArtwork({
    ids: ['../../etc/passwd', 'NOTHEX', A], imagesDir, fetch, exec: stubExec(),
  });
  assert.equal(report.considered, 1);
  assert.equal(fetch.calls.length, 1);
  assert.match(fetch.calls[0], /icon_00000000-00000002\.png$/);
});

// ---- the tiers ----------------------------------------------------------

test('the tiers are built from whatever tool the machine has', async () => {
  const imagesDir = await dir();
  const exec = stubExec({ has: ['sips'] });
  const report = await fetchArtwork({
    ids: [A], imagesDir, exec, fetch: stubFetch({ [A]: { status: 200 } }),
  });

  assert.equal(report.tiers.tool, 'sips');
  assert.equal(report.tiers.skipped, false);
  for (const t of TIERS) {
    assert.deepEqual(await readdir(join(imagesDir, t.dir)), [`${A}.png`]);
  }
});

test('ImageMagick is used where sips does not exist, which is the server', async () => {
  // The dev machine is macOS and production is Linux, so the code cannot assume
  // either one. `mogrify -path` is the batch form; sips wants `--out`.
  const imagesDir = await dir();
  const exec = stubExec({ has: ['magick'] });
  const report = await fetchArtwork({
    ids: [A], imagesDir, exec, fetch: stubFetch({ [A]: { status: 200 } }),
  });

  assert.equal(report.tiers.tool, 'magick');
  const resize = exec.calls.find((c) => c.args.includes('-path'));
  assert.equal(resize.cmd, 'magick');
  assert.equal(resize.args[0], 'mogrify');
  assert.ok(resize.args.includes('96x96>') || resize.args.includes('256x256>'));
});

test('with no image tool the artwork is still fetched, and the report says so', async () => {
  // The failure this prevents is silence: the pictures arrive, the tiers do
  // not, and the grid shows placeholders for the new entries with nothing
  // anywhere explaining why.
  const imagesDir = await dir();
  const report = await fetchArtwork({
    ids: [A], imagesDir, exec: stubExec({ has: [] }),
    fetch: stubFetch({ [A]: { status: 200 } }),
  });

  assert.equal(report.fetched, 1, 'the full-size image is there');
  assert.deepEqual(await readdir(join(imagesDir, 'full')), [`${A}.png`]);
  assert.equal(report.tiers.skipped, true);
  assert.deepEqual(await readdir(join(imagesDir, 'thumb')), [], 'no tiers');
  assert.match(describeArtwork(report), /Tiers NOT generated/);
  assert.match(describeArtwork(report), /npm run fetch-images/,
    'and it says what to do about it');
});

test('findResizer prefers sips, then magick, then convert', async () => {
  assert.equal(await findResizer(stubExec({ has: ['sips', 'magick'] })), 'sips');
  assert.equal(await findResizer(stubExec({ has: ['magick', 'convert'] })), 'magick');
  assert.equal(await findResizer(stubExec({ has: ['convert'] })), 'convert');
  assert.equal(await findResizer(stubExec({ has: [] })), null);
});

test('a tier already generated is not generated again', async () => {
  const imagesDir = await dir();
  const exec = stubExec();
  const fetch = stubFetch({ [A]: { status: 200 } });
  await fetchArtwork({ ids: [A], imagesDir, exec, fetch });

  const second = await fetchArtwork({ ids: [A], imagesDir, exec, fetch });
  assert.equal(second.fetched, 0);
  assert.equal(second.tiers.built, 0, 'nothing left to build');
});

// ---- removal ------------------------------------------------------------

test('removing artwork takes every tier, and refuses anything but an ID', async () => {
  const imagesDir = await dir();
  const exec = stubExec();
  await fetchArtwork({ ids: [A], imagesDir, exec, fetch: stubFetch({ [A]: { status: 200 } }) });

  await assert.rejects(() => removeArtwork('../../../etc/passwd', imagesDir), /not an amiibo ID/);
  assert.equal(await removeArtwork(A, imagesDir), 3, 'full, thumb and med');
  assert.deepEqual(await readdir(join(imagesDir, 'full')), []);
  assert.equal(await removeArtwork(A, imagesDir), 0, 'removing it again is quiet');
});

// ---- the file can fail --------------------------------------------------

test('these checks fail on the mistakes they were written for', async () => {
  const imagesDir = await dir();

  // 1. Treating a 404 as a failure. Every update would then report failures for
  //    entries whose art simply is not published yet — which is the normal case
  //    the moment upstream adds an amiibo.
  const report = await fetchArtwork({
    ids: [A], imagesDir, exec: stubExec(), fetch: stubFetch({}),
  });
  assert.throws(
    () => assert.ok(report.failed.length > 0, 'a missing picture must not read as a failure'),
    /must not read as a failure/);

  // 2. Skipping the tiers silently. Without the flag the report is
  //    indistinguishable from a complete run on a machine that has sips.
  const noTool = await fetchArtwork({
    ids: [B], imagesDir, exec: stubExec({ has: [] }),
    fetch: stubFetch({ [B]: { status: 200 } }),
  });
  assert.throws(
    () => assert.match(describeArtwork({ ...noTool, tiers: { ...noTool.tiers, skipped: false } }),
      /Tiers NOT generated/, 'a report without the flag must say nothing about tiers'),
    /must say nothing about tiers/);
});
