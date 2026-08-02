// The rescue drain loop against a simulated stuck folder: node --test test/
//
// The device under test stalls partway through listing one folder. That is the
// whole scenario: entries before the stall come back, entries after it never
// do, and moving the recovered ones out is what lets the next attempt reach
// further.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rescueFolder, findRescueStaging, driveRootOf, BATCH_SIZE } from '../web/js/rescue.js';

const STUCK = 'E:/amiibo';

const dirEntry = (name) => ({ name, size: 0, type: 1, isDir: true, meta: null });
const fileEntry = (name) => ({ name, size: 540, type: 0, isDir: false, meta: null });

/**
 * A device whose `stuck` folder only ever reveals its first `window` entries.
 * Everything else behaves normally, so the loop's only lever is emptying the
 * folder until what remains fits inside the window.
 *
 * `renameFails` maps a filename to how many times its rename should throw.
 */
function fakeDevice({
  files = [],
  folders = [],
  window = 3,
  stuck = STUCK,
  renameFails = {},
  drive = {},
} = {}) {
  const remaining = [...folders.map(dirEntry), ...files.map(fileEntry)];
  const tree = { 'E:/': [dirEntry('amiibo')], ...drive };
  const fails = { ...renameFails };

  return {
    tree,
    renames: [],
    created: [],
    removed: [],

    async readDir(path) {
      if (path === stuck) return remaining.slice();
      if (tree[path]) return tree[path];
      throw Object.assign(new Error(`no such folder ${path}`), { status: 1 });
    },

    async readDirPartial(path) {
      if (path !== stuck) return { entries: await this.readDir(path), complete: true };
      // Once what is left fits in the window the device manages the whole reply.
      if (remaining.length <= window) return { entries: remaining.slice(), complete: true };
      return { entries: remaining.slice(0, window), complete: false };
    },

    async createFolder(path) {
      if (tree[path]) throw Object.assign(new Error('already exists'), { status: 1 });
      this.created.push(path);
      tree[path] = [];
      const parent = path.slice(0, path.lastIndexOf('/')) || 'E:/';
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (tree[parent]) tree[parent] = [...tree[parent], dirEntry(name)];
    },

    async rename(from, to) {
      const name = from.slice(from.lastIndexOf('/') + 1);
      if (fails[name] > 0) {
        fails[name]--;
        throw Object.assign(new Error('no response to cmd 25'), { cmd: 25, timeout: 'idle' });
      }
      const i = remaining.findIndex((e) => e.name === name);
      if (i === -1) throw new Error(`missing ${from}`);
      remaining.splice(i, 1);
      this.renames.push({ from, to });
      const dir = to.slice(0, to.lastIndexOf('/'));
      tree[dir] = [...(tree[dir] ?? []), fileEntry(to.slice(to.lastIndexOf('/') + 1))];
      return undefined;
    },

    async remove(path) {
      this.removed.push(path);
    },

    left: () => remaining.map((e) => e.name),
  };
}

const names = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => `dump ${i + from}.bin`);

test('a folder drains over several passes until it lists cleanly', async () => {
  const client = fakeDevice({ files: names(8), window: 3 });

  const report = await rescueFolder({ client, path: STUCK });

  assert.equal(report.complete, true);
  assert.equal(report.stalled, false);
  assert.equal(report.rescued.length, 6, 'should stop once the remainder fits the window');
  assert.ok(report.passes >= 3, `expected several passes, got ${report.passes}`);
  assert.deepEqual(client.left(), ['dump 7.bin', 'dump 8.bin']);
});

test('rescued files are numbered continuously across batches', async () => {
  const client = fakeDevice({ files: names(120), window: 20 });

  const report = await rescueFolder({ client, path: STUCK });

  const tos = report.rescued.map((r) => r.to);
  assert.equal(tos[0], 'E:/r_/1/0001.bin');
  assert.equal(tos[BATCH_SIZE - 1], `E:/r_/1/${String(BATCH_SIZE).padStart(4, '0')}.bin`);
  // The counter runs on rather than restarting, so every name is unique alone.
  assert.equal(tos[BATCH_SIZE], 'E:/r_/2/0051.bin');
  assert.equal(new Set(tos.map((t) => t.slice(t.lastIndexOf('/') + 1))).size, tos.length);
});

test('no batch folder is allowed to grow past the cap', async () => {
  const client = fakeDevice({ files: names(120), window: 20 });

  const report = await rescueFolder({ client, path: STUCK });

  const perBatch = new Map();
  for (const { to } of report.rescued) {
    const batch = to.split('/')[2];
    perBatch.set(batch, (perBatch.get(batch) ?? 0) + 1);
  }
  assert.ok(perBatch.size > 1, 'never rolled over into a second batch');
  // The rescue must not rebuild the oversized folder it is dismantling.
  for (const [batch, n] of perBatch) {
    assert.ok(n <= BATCH_SIZE, `batch ${batch} holds ${n}`);
  }
});

test('a batch rolls over mid-pass rather than at a pass boundary', async () => {
  // One pass recovers 60 entries, which straddles the 50-file cap.
  const client = fakeDevice({ files: names(70), window: 60 });

  const report = await rescueFolder({ client, path: STUCK });

  const firstPassBatches = new Set(report.rescued.slice(0, 60).map((r) => r.to.split('/')[2]));
  assert.deepEqual([...firstPassBatches].sort(), ['1', '2']);
});

test('a stall at the same entry ends the loop and reports it', async () => {
  // Nine files, a window of three, and the fourth never moves: every pass sees
  // the same three names and gets no further.
  const client = fakeDevice({
    files: names(9),
    window: 3,
    renameFails: { 'dump 1.bin': 99, 'dump 2.bin': 99, 'dump 3.bin': 99 },
  });

  const report = await rescueFolder({ client, path: STUCK });

  assert.equal(report.stalled, true);
  assert.equal(report.complete, false);
  assert.equal(report.rescued.length, 0);
  assert.equal(report.failed.length, 3);
  assert.ok(report.passes < 5, `looped ${report.passes} times on a dead folder`);
});

test('a folder that yields nothing at all is reported as unrecoverable', async () => {
  const client = fakeDevice({ files: names(5), window: 0 });

  const report = await rescueFolder({ client, path: STUCK });

  assert.equal(report.recoverable, false);
  assert.equal(report.rescued.length, 0);
  // Nothing may be destroyed on the strength of a listing that never happened.
  assert.deepEqual(client.removed, []);
  assert.deepEqual(client.renames, []);
});

test('a rename that fails once is retried and succeeds', async () => {
  const client = fakeDevice({ files: names(4), window: 1, renameFails: { 'dump 1.bin': 1 } });

  const report = await rescueFolder({ client, path: STUCK });

  assert.equal(report.failed.length, 0);
  assert.ok(report.rescued.some((r) => r.from.endsWith('dump 1.bin')));
});

test('a rename that fails twice is recorded, and the file stays put', async () => {
  const client = fakeDevice({ files: names(6), window: 4, renameFails: { 'dump 2.bin': 99 } });

  const report = await rescueFolder({ client, path: STUCK });

  assert.deepEqual(report.failed.map((f) => f.name), ['dump 2.bin']);
  // Skipped, not fatal: the rest of the pass still ran.
  assert.ok(report.rescued.length >= 3, `only ${report.rescued.length} moved`);
  assert.ok(client.left().includes('dump 2.bin'), 'a file we could not move went missing');
});

test('a subfolder is reported and never moved or removed', async () => {
  const client = fakeDevice({ files: names(6), folders: ['Zelda'], window: 3 });

  const report = await rescueFolder({ client, path: STUCK });

  assert.deepEqual(report.folders, ['Zelda']);
  assert.ok(!client.renames.some((r) => r.from.endsWith('/Zelda')));
  assert.deepEqual(client.removed, []);
  assert.ok(client.left().includes('Zelda'));
});

test('stopping leaves every file either moved or untouched', async () => {
  const client = fakeDevice({ files: names(20), window: 10 });
  let seen = 0;

  await assert.rejects(
    () => rescueFolder({ client, path: STUCK, shouldStop: () => ++seen > 6 }),
    (err) => {
      assert.equal(err.stopped, true);
      return true;
    }
  );

  // Every rename that happened is a completed move; nothing is half-done.
  const movedNames = client.renames.map((r) => r.from.slice(r.from.lastIndexOf('/') + 1));
  for (const name of movedNames) {
    assert.ok(!client.left().includes(name), `${name} is in both places`);
  }
  assert.equal(movedNames.length + client.left().length, 20);
});

test('a folder that inches along forever is stopped by the pass cap', async () => {
  // Progress on every pass, so stall detection never fires, but never enough
  // to finish. Without a backstop this runs until the folder happens to empty.
  const client = fakeDevice({ files: names(200), window: 1 });

  const report = await rescueFolder({ client, path: STUCK });

  assert.equal(report.complete, false);
  assert.equal(report.stalled, true, 'the cap must report as a stop, not as success');
  assert.ok(report.passes <= 50, `ran ${report.passes} passes`);
  // Whatever it did manage is still safely moved.
  assert.equal(report.rescued.length, report.passes);
});

test('the folder lists fine on the first try, so nothing is moved', async () => {
  const client = fakeDevice({ files: names(3), window: 10 });

  const report = await rescueFolder({ client, path: STUCK });

  assert.equal(report.complete, true);
  assert.equal(report.passes, 1);
  assert.deepEqual(client.renames, []);
});

test('an aborted run resumes at the next free number, overwriting nothing', async () => {
  const client = fakeDevice({
    files: names(4),
    window: 2,
    drive: {
      'E:/': [dirEntry('amiibo'), dirEntry('r_')],
      'E:/r_': [dirEntry('1')],
      'E:/r_/1': [fileEntry('0001.bin'), fileEntry('0002.bin'), fileEntry('0003.bin')],
    },
  });

  const report = await rescueFolder({ client, path: STUCK });

  assert.equal(report.rescued[0].to, 'E:/r_/1/0004.bin');
  // create_folder is not idempotent, so a folder a listing showed present must
  // never be created again — the error is indistinguishable from a real one.
  assert.ok(!client.created.includes('E:/r_'));
  assert.ok(!client.created.includes('E:/r_/1'));
});

test('findRescueStaging counts what is parked without listing every batch', async () => {
  const client = fakeDevice({
    drive: {
      'E:/': [dirEntry('amiibo'), dirEntry('r_')],
      'E:/r_': [dirEntry('1'), dirEntry('2'), dirEntry('3')],
      'E:/r_/3': [fileEntry('0101.bin'), fileEntry('0102.bin')],
    },
  });

  assert.deepEqual(await findRescueStaging(client), {
    present: true, batches: 3, files: BATCH_SIZE * 2 + 2, path: 'E:/r_',
  });
});

test('findRescueStaging reports a clean drive as empty', async () => {
  const client = fakeDevice({});
  assert.deepEqual(await findRescueStaging(client), { present: false, batches: 0, files: 0 });
});

test('the drive root is taken from the path, whatever its depth', () => {
  assert.equal(driveRootOf('E:/amiibo'), 'E:/');
  assert.equal(driveRootOf('E:/amiibo/deep/deeper'), 'E:/');
  assert.equal(driveRootOf('I:/'), 'I:/');
  assert.throws(() => driveRootOf('amiibo/loose'), /not a device path/);
});
