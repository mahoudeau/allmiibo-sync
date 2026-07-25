// Planner tests — pure logic, no hardware and no browser.
//   node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planSync,
  flattenPlan,
  checkDestination,
  devicePath,
  isExcluded,
} from '../web/js/planner.js';

const ROOT = 'E:/amiibo';

const file = (size, hash) => ({ size, hash, isDir: false });
const dir = () => ({ size: 0, isDir: true });

function index(entries) {
  return new Map(Object.entries(entries));
}

function plan(local, device, state, options = {}) {
  return planSync({
    local: index(local),
    device: index(device),
    state: { entries: state },
    deviceRoot: ROOT,
    options,
  });
}

// ---- path helpers -------------------------------------------------------

test('devicePath joins the root and tolerates a trailing slash', () => {
  assert.equal(devicePath('E:/amiibo', 'Zelda/Link.bin'), 'E:/amiibo/Zelda/Link.bin');
  assert.equal(devicePath('E:/amiibo/', 'Zelda/Link.bin'), 'E:/amiibo/Zelda/Link.bin');
});

test('checkDestination enforces the 63-byte path cap on the full path', () => {
  // Real path from the device, exactly at the limit.
  assert.equal(checkDestination('E:/amiibo', 'others/Monster Hunter/Palamute _Canyne Malzeno X_.bin'), null);
  const over = checkDestination('E:/amiibo', 'others/Monster Hunter/Palamute _Canyne Malzeno XX_.bin');
  assert.match(over, /64 bytes, over the 63-byte limit/);
});

test('checkDestination counts UTF-8 bytes, not characters', () => {
  const name = `${'ō'.repeat(24)}.bin`; // 24 chars, 48 bytes, plus .bin
  const why = checkDestination('E:/amiibo', name);
  assert.match(why, /filename is \d+ bytes/);
});

test('device-managed files are excluded by default', () => {
  assert.equal(isExcluded('settings.bin'), true);
  assert.equal(isExcluded('key_retail.bin'), true);
  assert.equal(isExcluded('Zelda/Link.bin'), false);
});

// ---- push ---------------------------------------------------------------

test('push uploads a new local file and creates its folders first', () => {
  const p = plan({ 'Zelda/Link.bin': file(540, 'h1'), Zelda: dir() }, {}, {});

  assert.deepEqual(p.mkdirDevice.map((m) => m.relPath), ['Zelda']);
  assert.deepEqual(p.upload.map((u) => u.relPath), ['Zelda/Link.bin']);

  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('mkdirDevice') < ops.indexOf('upload'), 'folder must precede its file');
});

test('push does not re-create a folder that already exists on the device', () => {
  const p = plan({ 'Zelda/Link.bin': file(540, 'h1') }, { Zelda: dir() }, {});
  assert.deepEqual(p.mkdirDevice, [], 'create_folder is not idempotent, so it must be skipped');
  assert.equal(p.upload.length, 1);
});

test('push leaves an identical file alone', () => {
  const p = plan(
    { 'Zelda/Link.bin': file(540, 'h1') },
    { 'Zelda/Link.bin': file(540) },
    { 'Zelda/Link.bin': { size: 540, hash: 'h1' } }
  );
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.unchanged, ['Zelda/Link.bin']);
});

test('push re-uploads a locally modified file', () => {
  const p = plan(
    { 'Zelda/Link.bin': file(540, 'h2') },
    { 'Zelda/Link.bin': file(540) },
    { 'Zelda/Link.bin': { size: 540, hash: 'h1' } }
  );
  assert.deepEqual(p.upload.map((u) => u.relPath), ['Zelda/Link.bin']);
});

test('equal size is not treated as equal content when there is no sync record', () => {
  // Every amiibo dump is 540 bytes, so size proves nothing.
  const p = plan({ 'a.bin': file(540, 'h1') }, { 'a.bin': file(540) }, {});
  assert.deepEqual(p.upload, []);
  assert.equal(p.ambiguous.length, 1);
  assert.match(p.ambiguous[0].reason, /no sync record/);
});

test('a verified device hash resolves the ambiguous case', () => {
  const same = plan({ 'a.bin': file(540, 'h1') }, { 'a.bin': file(540, 'h1') }, {});
  assert.deepEqual(same.unchanged, ['a.bin']);
  assert.deepEqual(same.ambiguous, []);

  const differs = plan({ 'a.bin': file(540, 'h1') }, { 'a.bin': file(540, 'h9') }, {});
  assert.deepEqual(differs.upload.map((u) => u.relPath), ['a.bin']);
});

// ---- deletion safety ----------------------------------------------------

test('push does not delete from the device unless --delete is set', () => {
  const p = plan({}, { 'gone.bin': file(540) }, { 'gone.bin': { size: 540, hash: 'h1' } });
  assert.deepEqual(p.deleteDevice, []);
  assert.equal(p.ambiguous.length, 1);
  assert.match(p.ambiguous[0].reason, /--delete is off/);
});

test('push with --delete removes a file the local side dropped', () => {
  const p = plan(
    {},
    { 'gone.bin': file(540) },
    { 'gone.bin': { size: 540, hash: 'h1' } },
    { delete: true }
  );
  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['gone.bin']);
});

test('a device file that was never synced is left alone, even with --delete', () => {
  const p = plan({}, { 'theirs.bin': file(540) }, {}, { delete: true });
  assert.deepEqual(p.deleteDevice, []);
  assert.deepEqual(p.unchanged, ['theirs.bin']);
});

test('folders are removed deepest-first and only after their files', () => {
  const p = plan(
    {},
    {
      'a/b/deep.bin': file(540),
      'a/top.bin': file(540),
      a: dir(),
      'a/b': dir(),
    },
    {
      'a/b/deep.bin': { size: 540, hash: 'h1' },
      'a/top.bin': { size: 540, hash: 'h2' },
    },
    { delete: true }
  );

  assert.deepEqual(p.rmdirDevice.map((d) => d.relPath), ['a/b', 'a']);

  const ops = flattenPlan(p);
  const lastDelete = ops.map((o) => o.op).lastIndexOf('deleteDevice');
  const firstRmdir = ops.map((o) => o.op).indexOf('rmdirDevice');
  assert.ok(lastDelete < firstRmdir, 'files must be deleted before their folders');
});

test('files are deleted individually rather than by removing the folder', () => {
  // remove() is recursive on the device, so a folder must never stand in for
  // its contents.
  const p = plan(
    {},
    { 'a/one.bin': file(540), 'a/two.bin': file(540), a: dir() },
    {
      'a/one.bin': { size: 540, hash: 'h1' },
      'a/two.bin': { size: 540, hash: 'h2' },
    },
    { delete: true }
  );
  assert.deepEqual(
    p.deleteDevice.map((d) => d.relPath).sort(),
    ['a/one.bin', 'a/two.bin']
  );
});

// ---- moves --------------------------------------------------------------

test('a file that only moved is renamed on the device, not re-uploaded', () => {
  const p = plan(
    { 'New/Link.bin': file(540, 'h1') },
    { 'Old/Link.bin': file(540), Old: dir(), New: dir() },
    { 'Old/Link.bin': { size: 540, hash: 'h1' } }
  );

  assert.deepEqual(p.moveDevice, [{ from: 'Old/Link.bin', to: 'New/Link.bin' }]);
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.deleteDevice, []);
});

test('a move to an over-long destination is blocked, not attempted', () => {
  const longRel = `others/Monster Hunter/${'x'.repeat(45)}.bin`;
  const p = plan(
    { [longRel]: file(540, 'h1') },
    { 'Old/Link.bin': file(540) },
    { 'Old/Link.bin': { size: 540, hash: 'h1' } }
  );
  assert.deepEqual(p.moveDevice, []);
  assert.equal(p.blocked.length, 1);
  assert.match(p.blocked[0].reason, /over the 63-byte limit/);
});

// ---- pull ---------------------------------------------------------------

test('pull downloads a device-only file and creates local folders', () => {
  const p = plan({}, { 'Zelda/Link.bin': file(540) }, {}, { mode: 'pull' });
  assert.deepEqual(p.download.map((d) => d.relPath), ['Zelda/Link.bin']);
  assert.deepEqual(p.mkdirLocal.map((m) => m.relPath), ['Zelda']);
  assert.deepEqual(p.upload, []);
});

test('pull never writes to the device', () => {
  const p = plan(
    { 'only-local.bin': file(540, 'h1') },
    { 'a.bin': file(540) },
    {},
    { mode: 'pull', delete: true }
  );
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.deleteDevice, []);
  assert.deepEqual(p.mkdirDevice, []);
  assert.deepEqual(p.moveDevice, []);
});

// ---- two-way ------------------------------------------------------------

test('two-way sends each side the other side changes', () => {
  const p = plan(
    { 'local-changed.bin': file(540, 'new'), 'device-changed.bin': file(540, 'old') },
    { 'local-changed.bin': file(540, 'old'), 'device-changed.bin': file(540, 'new') },
    {
      'local-changed.bin': { size: 540, hash: 'old' },
      'device-changed.bin': { size: 540, hash: 'old' },
    },
    { mode: 'two-way' }
  );

  assert.deepEqual(p.upload.map((u) => u.relPath), ['local-changed.bin']);
  assert.deepEqual(p.download.map((d) => d.relPath), ['device-changed.bin']);
});

test('two-way reports a file changed on both sides as a conflict, changing nothing', () => {
  const p = plan(
    { 'a.bin': file(540, 'mine') },
    { 'a.bin': file(540, 'theirs') },
    { 'a.bin': { size: 540, hash: 'base' } },
    { mode: 'two-way' }
  );

  assert.equal(p.conflicts.length, 1);
  assert.match(p.conflicts[0].reason, /both sides/);
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.download, []);
});

test('two-way flags delete-versus-modify rather than guessing', () => {
  const p = plan(
    { 'a.bin': file(540, 'edited') },
    {},
    { 'a.bin': { size: 540, hash: 'base' } },
    { mode: 'two-way', delete: true }
  );

  assert.equal(p.conflicts.length, 1);
  assert.match(p.conflicts[0].reason, /removed on the device but modified locally/);
  assert.deepEqual(p.deleteLocal, []);
});

test('two-way propagates a delete when the surviving copy is untouched', () => {
  const p = plan(
    { 'a.bin': file(540, 'base') },
    {},
    { 'a.bin': { size: 540, hash: 'base' } },
    { mode: 'two-way', delete: true }
  );
  assert.deepEqual(p.deleteLocal.map((d) => d.relPath), ['a.bin']);
  assert.deepEqual(p.conflicts, []);
});

// ---- misc ---------------------------------------------------------------

test('excluded device files are never uploaded, downloaded or deleted', () => {
  const p = plan(
    { 'settings.bin': file(17, 'h1') },
    { 'settings.bin': file(17), 'key_retail.bin': file(160) },
    {},
    { mode: 'two-way', delete: true }
  );
  assert.deepEqual(flattenPlan(p), []);
});

test('an over-long upload is blocked and reported, not attempted', () => {
  const longRel = `others/Monster Hunter/${'y'.repeat(45)}.bin`;
  const p = plan({ [longRel]: file(540, 'h1') }, {}, {});
  assert.deepEqual(p.upload, []);
  assert.equal(p.blocked.length, 1);
  assert.equal(p.blocked[0].action, 'upload');
});

test('an empty local folder is created on the device', () => {
  const p = plan({ 'Empty Folder': dir() }, {}, {});
  assert.deepEqual(p.mkdirDevice.map((m) => m.relPath), ['Empty Folder']);
});

test('the estimate reflects the measured ~2 KB/s link', () => {
  const local = {};
  for (let i = 0; i < 100; i++) local[`f${i}.bin`] = file(540, `h${i}`);
  const p = plan(local, {}, {});

  assert.equal(p.stats.upload, 100);
  assert.equal(p.stats.uploadBytes, 54000);
  // 100 files x (2 commands + 3 chunks) is on the order of a minute.
  assert.ok(p.stats.estimatedSeconds > 30 && p.stats.estimatedSeconds < 120,
    `estimate ${p.stats.estimatedSeconds}s should be about a minute`);
});

test('an unknown mode is rejected', () => {
  assert.throws(() => plan({}, {}, {}, { mode: 'sideways' }), /unknown mode/);
});
