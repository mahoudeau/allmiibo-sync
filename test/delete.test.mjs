// Deleting: the whole device folder (WIPE) and chosen amiibo (selection).
//   node --test
//
// Both are the sharp end of the tool, so what they refuse to touch matters as
// much as what they remove.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planWipe, flattenPlan } from '../web/js/planner.js';
import { planDeviceDeletes } from '../web/js/syncflow.js';
import { findRescueStaging, stagingNotice } from '../web/js/rescue.js';

const ROOT = 'E:/amiibo';

const dir = (extra = {}) => ({ size: 0, isDir: true, ...extra });
const file = (size = 540) => ({ size, isDir: false });
const dump = (amiiboId) => ({ size: 540, isDir: false, amiiboId });
const index = (entries) => new Map(Object.entries(entries));

const wipe = (device, deviceRoot = ROOT) => planWipe({ device: index(device), deviceRoot });

// ---- WIPE ----------------------------------------------------------------

test('a wipe removes every file and then the folders, deepest first', () => {
  const p = wipe({
    Zelda: dir(), 'Zelda/Link.bin': file(), 'Zelda/deep': dir(), 'Zelda/deep/a.bin': file(),
    'loose.bin': file(),
  });

  assert.deepEqual(p.deleteDevice.map((d) => d.relPath).sort(),
    ['Zelda/Link.bin', 'Zelda/deep/a.bin', 'loose.bin']);
  assert.deepEqual(p.rmdirDevice.map((r) => r.relPath), ['Zelda/deep', 'Zelda']);
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.download, []);

  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('deleteDevice') < ops.indexOf('rmdirDevice'),
    'a folder must not go before its contents');
});

test('a wipe keeps the files the device itself needs', () => {
  const p = wipe({ 'key_retail.bin': file(160), 'settings.bin': file(17), 'a.bin': file() });

  // Deleting the signing keys does not empty the device, it breaks it.
  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['a.bin']);
  assert.deepEqual(p.kept.map((k) => k.relPath).sort(), ['key_retail.bin', 'settings.bin']);
  assert.ok(p.warnings.some((w) => w.includes('device state')));
});

test('a wipe does not remove a folder that still holds something it kept', () => {
  const p = wipe({ sys: dir(), 'sys/settings.bin': file(17), 'sys/a.bin': file() });

  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['sys/a.bin']);
  // remove() is recursive, so removing sys/ would take the file we spared.
  assert.deepEqual(p.rmdirDevice, []);
});

test('a wipe leaves a folder that never listed standing, and says so', () => {
  const p = wipe({ stuck: dir({ unenumerated: 'unlistable' }), 'a.bin': file() });

  assert.deepEqual(p.rmdirDevice, []);
  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['a.bin']);
  assert.equal(p.stats.unenumerated, 1);
  assert.ok(p.warnings.some((w) => w.includes('left standing')));
});

test('a wipe at the drive root says what else is in scope', () => {
  const p = wipe({ 'a.bin': file() }, 'E:/');

  assert.ok(p.warnings.some((w) => w.includes('whole drive') && w.includes('amiibolink')));
});

test('a wipe of a subfolder does not raise the whole-drive warning', () => {
  const p = wipe({ 'a.bin': file() }, 'E:/r_');
  assert.ok(!p.warnings.some((w) => w.includes('whole drive')));
});

// ---- deleting chosen amiibo ----------------------------------------------

const HHD = '026a0001026a0001';

test('selecting an amiibo removes exactly its device files', () => {
  const device = index({ 'a.bin': dump('A'), 'b.bin': dump('B'), 'c.bin': dump('C') });

  const p = planDeviceDeletes(device, new Set(['A', 'C']), ROOT);

  assert.deepEqual(p.deleteDevice.map((d) => d.relPath).sort(), ['a.bin', 'c.bin']);
  // Nothing local is involved: this works with no folder chosen at all.
  assert.deepEqual(p.deleteLocal, []);
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.download, []);
});

test('one amiibo id can mean many files, and all of them go', () => {
  const device = index({
    'HHD/card1.bin': dump(HHD),
    'HHD/card2.bin': dump(HHD),
    'HHD/card3.bin': dump(HHD),
    'Zelda/Link.bin': dump('LINK'),
  });

  const p = planDeviceDeletes(device, new Set([HHD]), ROOT);

  // The 91 HHD item cards share one fabricated id, so a confirm counting
  // amiibo instead of files would understate this by ninety.
  assert.equal(p.deleteDevice.length, 3);
  assert.equal(p.stats.deleteDevice, 3);
  assert.ok(!p.deleteDevice.some((d) => d.relPath.startsWith('Zelda/')));
});

test('a folder emptied by the deletions is swept, one still in use is not', () => {
  const device = index({
    Zelda: dir(), 'Zelda/Link.bin': dump('LINK'),
    Mario: dir(), 'Mario/a.bin': dump('A'), 'Mario/b.bin': dump('B'),
  });

  const p = planDeviceDeletes(device, new Set(['LINK', 'A']), ROOT);

  assert.deepEqual(p.rmdirDevice.map((r) => r.relPath), ['Zelda']);
});

test('device state is never deleted by an amiibo selection', () => {
  // key_retail.bin is not a dump so it carries no id, but a future index that
  // mislabelled it must not be able to take it out this way.
  const device = index({ 'key_retail.bin': dump('A'), 'a.bin': dump('A') });

  const p = planDeviceDeletes(device, new Set(['A']), ROOT);

  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['a.bin']);
});

test('a folder that never listed is never swept by a selection delete', () => {
  const device = index({
    stuck: dir({ unenumerated: 'unlistable' }),
    'stuck/a.bin': dump('A'),
  });

  const p = planDeviceDeletes(device, new Set(['A']), ROOT);

  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['stuck/a.bin']);
  assert.deepEqual(p.rmdirDevice, []);
});

// ---- the staging notice --------------------------------------------------

test('the staging notice offers a way out and never deletes on one click', () => {
  const notice = stagingNotice({ present: true, batches: 8, files: 397, path: 'E:/r_' });

  assert.match(notice.body, /397/);
  assert.deepEqual(notice.options.map((o) => o.value), ['organise', 'backup', 'delete', 'later']);
  // chooseDialog resolves on a single click, so the destructive choice must
  // only ever be a route to a second, explicit confirm.
  assert.match(notice.options.find((o) => o.value === 'delete').hint, /Asks again/);
});

test('no notice for a clean device, or an empty staging folder', () => {
  assert.equal(stagingNotice({ present: false, batches: 0, files: 0 }), null);
  assert.equal(stagingNotice({ present: true, batches: 0, files: 0 }), null);
});

test('a staging tree left by a repair is found on a device that never scanned it', async () => {
  // E:/r_ is a sibling of the device folder, so nothing rooted at E:/amiibo
  // would ever list it.
  const tree = {
    'E:/': [{ name: 'amiibo', isDir: true }, { name: 'r_', isDir: true }],
    'E:/r_': [{ name: '1', isDir: true }, { name: '2', isDir: true }],
    'E:/r_/2': [{ name: '0051.bin', isDir: false }],
  };
  const client = { async readDir(p) { return tree[p] ?? []; } };

  const found = await findRescueStaging(client, 'E:/');
  assert.equal(found.present, true);
  assert.equal(found.files, 51);
  assert.ok(stagingNotice(found));
});
