// Planner tests — pure logic, no hardware and no browser.
//   node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planSync,
  planIdentitySync,
  planDump,
  sanitizeLocalName,
  sanitizeLocalRelPath,
  flattenPlan,
  checkDestination,
  devicePath,
  isExcluded,
  compareByContent,
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

test('push does not delete unless --delete is set, but still lists what it would remove', () => {
  const p = plan({}, { 'gone.bin': file(540) }, { 'gone.bin': { size: 540, hash: 'h1' } });
  assert.deepEqual(p.deleteDevice, []);
  // Surplus files must be visible in the plan, not hidden in the unchanged count.
  assert.deepEqual(p.wouldDelete, [{ relPath: 'gone.bin', side: 'device', size: 540 }]);
  assert.deepEqual(p.unchanged, []);
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

test('push mirrors on the first run: surplus device files go even with no sync record', () => {
  // "Local is master" must mean the same thing on run one as on run one hundred.
  const p = plan({ 'keep.bin': file(540, 'h1') }, { 'surplus.bin': file(540) }, {}, { delete: true });
  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['surplus.bin']);
});

test('push lists surplus device files on the first run when --delete is off', () => {
  const p = plan({ 'keep.bin': file(540, 'h1') }, { 'surplus.bin': file(540) }, {});
  assert.deepEqual(p.wouldDelete.map((d) => d.relPath), ['surplus.bin']);
  assert.deepEqual(p.deleteDevice, []);
});

test('pull mirrors in reverse: surplus local files are removed with --delete', () => {
  const p = plan(
    { 'surplus.bin': file(540, 'h1') },
    { 'keep.bin': file(540) },
    {},
    { mode: 'pull', delete: true }
  );
  assert.deepEqual(p.deleteLocal.map((d) => d.relPath), ['surplus.bin']);
});

test('two-way does NOT delete a device file it has never seen', () => {
  // Absent locally in two-way is ambiguous — never synced, or added on the
  // device since. Only the state can tell, so an unknown file is left alone.
  const p = plan({}, { 'theirs.bin': file(540) }, {}, { mode: 'two-way', delete: true });
  assert.deepEqual(p.deleteDevice, []);
  assert.deepEqual(p.download.map((d) => d.relPath), ['theirs.bin']);
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

test('a folder holding an excluded file is never removed', () => {
  // remove() is recursive, so removing the folder would take the excluded
  // file with it.
  const p = plan(
    {},
    { 'keep/key_retail.bin': file(160), 'keep/dump.bin': file(540), keep: dir() },
    { 'keep/dump.bin': { size: 540, hash: 'h1' } },
    { delete: true }
  );
  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['keep/dump.bin']);
  assert.deepEqual(p.rmdirDevice, [], 'the folder still holds an excluded file');
});

test('a folder is not removed while a subfolder survives', () => {
  const p = plan(
    { 'a/b': dir() }, // the subfolder still exists locally, so it stays
    { a: dir(), 'a/b': dir(), 'a/old.bin': file(540) },
    { 'a/old.bin': { size: 540, hash: 'h1' } },
    { delete: true }
  );
  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['a/old.bin']);
  assert.deepEqual(p.rmdirDevice, [], 'a/b survives, so a cannot be removed recursively');
});

test('every device-touching operation stays under the device root', () => {
  // Containment is the core safety property: nothing the planner emits may
  // resolve outside the configured root, whatever the inputs look like.
  const p = plan(
    {
      'Zelda/Link.bin': file(540, 'h1'),
      'New/Moved.bin': file(540, 'hMoved'),
      'Empty': dir(),
    },
    {
      'Zelda/Link.bin': file(540),
      'Old/Moved.bin': file(540),
      'Surplus/junk.bin': file(540),
      Old: dir(),
      Surplus: dir(),
    },
    {
      'Zelda/Link.bin': { size: 540, hash: 'h0' },
      'Old/Moved.bin': { size: 540, hash: 'hMoved' },
      'Surplus/junk.bin': { size: 540, hash: 'hJunk' },
    },
    { delete: true }
  );

  const touched = [];
  for (const op of flattenPlan(p)) {
    if (op.op === 'mkdirLocal' || op.op === 'deleteLocal') continue;
    if (op.op === 'moveDevice') touched.push(op.from, op.to);
    else touched.push(op.relPath);
  }

  assert.ok(touched.length > 0, 'the fixture must actually exercise device operations');
  for (const rel of touched) {
    const full = devicePath(ROOT, rel);
    assert.ok(full.startsWith(`${ROOT}/`), `${full} escapes ${ROOT}`);
    assert.ok(!rel.includes('..'), `${rel} contains a parent traversal`);
  }
});

test('a bare drive root plus deletions is flagged', () => {
  const p = plan({}, { 'amiibolink/00.bin': file(540) }, {}, { delete: true });
  const atRoot = planSync({
    local: index({}),
    device: index({ 'amiibolink/00.bin': file(540) }),
    state: { entries: {} },
    deviceRoot: 'E:/',
    options: { delete: true },
  });
  assert.deepEqual(p.warnings, []);
  assert.equal(atRoot.warnings.length, 1);
  assert.match(atRoot.warnings[0], /whole drive/i);
});

test('a warning fires when the two sides share no paths at all', () => {
  // The classic misconfiguration: local folder contains "amiibo/", device root
  // is already "E:/amiibo", so every relative path is shifted by one level.
  const p = plan({ 'amiibo/Zelda/Link.bin': file(540, 'h1') }, { 'Zelda/Link.bin': file(540) }, {});
  assert.equal(p.stats.overlap, 0);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /No path is shared/);
});

test('no warning when the sides line up', () => {
  const p = plan({ 'Zelda/Link.bin': file(540, 'h1') }, { 'Zelda/Link.bin': file(540) }, {});
  assert.equal(p.stats.overlap, 1);
  assert.deepEqual(p.warnings, []);
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

// ---- content comparison -------------------------------------------------

test('content comparison finds device files with no local copy, whatever the name', () => {
  const r = compareByContent({
    local: index({ 'Whatever I Called It.bin': file(540, 'hA') }),
    device: index({ 'Zelda/Link.bin': file(540, 'hA'), 'Zelda/Rare.bin': file(540, 'hB') }),
  });

  assert.deepEqual(r.missingLocally.map((m) => m.relPath), ['Zelda/Rare.bin']);
  assert.deepEqual(r.missingOnDevice, []);
  // hA is on both sides under different names, so it is relocated, not missing.
  assert.equal(r.relocated.length, 1);
  assert.deepEqual(r.relocated[0].device, ['Zelda/Link.bin']);
  assert.deepEqual(r.relocated[0].local, ['Whatever I Called It.bin']);
});

test('content comparison reports local files absent from the device', () => {
  const r = compareByContent({
    local: index({ 'a.bin': file(540, 'hA'), 'b.bin': file(540, 'hB') }),
    device: index({ 'a.bin': file(540, 'hA') }),
  });
  assert.deepEqual(r.missingOnDevice.map((m) => m.relPath), ['b.bin']);
  assert.deepEqual(r.missingLocally, []);
});

test('identical paths and content are not reported as relocated', () => {
  const r = compareByContent({
    local: index({ 'Zelda/Link.bin': file(540, 'hA') }),
    device: index({ 'Zelda/Link.bin': file(540, 'hA') }),
  });
  assert.deepEqual(r.relocated, []);
  assert.deepEqual(r.missingLocally, []);
  assert.deepEqual(r.missingOnDevice, []);
});

test('content comparison surfaces duplicates on each side', () => {
  const r = compareByContent({
    local: index({ 'x.bin': file(540, 'hA'), 'copy of x.bin': file(540, 'hA') }),
    device: index({ 'one.bin': file(540, 'hA'), 'two.bin': file(540, 'hA') }),
  });
  assert.deepEqual(r.duplicateOnDevice[0].paths.sort(), ['one.bin', 'two.bin']);
  assert.deepEqual(r.duplicateLocally[0].paths.sort(), ['copy of x.bin', 'x.bin']);
});

test('content comparison ignores device-managed files', () => {
  const r = compareByContent({
    local: index({}),
    device: index({ 'key_retail.bin': file(160, 'hK'), 'settings.bin': file(17, 'hS') }),
  });
  assert.deepEqual(r.missingLocally, []);
});

test('unhashed device entries are skipped rather than misreported as missing', () => {
  const r = compareByContent({
    local: index({ 'a.bin': file(540, 'hA') }),
    device: index({ 'a.bin': { size: 540, isDir: false } }), // never hashed
  });
  assert.deepEqual(r.missingLocally, []);
  // The local file cannot be confirmed present, so it is reported as such.
  assert.deepEqual(r.missingOnDevice.map((m) => m.relPath), ['a.bin']);
});

// ---- amiibo identity ----------------------------------------------------

test('content comparison keys on the amiibo ID, not the bytes', async () => {
  // Two dumps of the same character: same amiibo ID, different UID/save data
  // and therefore different hashes. Byte comparison would call these distinct.
  const local = index({ 'mine/Link.bin': { size: 540, hash: 'hA', amiiboId: 'ID-LINK', isDir: false } });
  const device = index({
    'theirs/Link copy.bin': { size: 540, hash: 'hB', amiiboId: 'ID-LINK', isDir: false },
    'theirs/Zelda.bin': { size: 540, hash: 'hC', amiiboId: 'ID-ZELDA', isDir: false },
  });

  const byId = compareByContent({ local, device });
  assert.deepEqual(byId.missingLocally.map((m) => m.relPath), ['theirs/Zelda.bin']);

  const byBytes = compareByContent({ local, device, identity: 'bytes' });
  assert.equal(byBytes.missingLocally.length, 2, 'byte comparison mistakes a re-dump for a new amiibo');
});

test('files with no amiibo ID fall back to byte comparison', () => {
  const r = compareByContent({
    local: index({ 'notes.txt': { size: 10, hash: 'hX', isDir: false } }),
    device: index({ 'notes.txt': { size: 10, hash: 'hX', isDir: false } }),
  });
  assert.deepEqual(r.missingLocally, []);
  assert.deepEqual(r.missingOnDevice, []);
});

test('a variant sharing an amiibo ID is reported, not collapsed', () => {
  // Real case: Skylanders "Hammer Slam Bowser" and "Dark Hammer Slam Bowser"
  // share ID 0005ff00023a0702 and differ only in data. An ID-only view would
  // call the dark figure "already held".
  const r = compareByContent({
    local: index({ 'Bowser.bin': { size: 540, hash: 'hLight', amiiboId: 'SKY-BOWSER', isDir: false } }),
    device: index({
      'Bowser.bin': { size: 540, hash: 'hLight', amiiboId: 'SKY-BOWSER', isDir: false },
      'Dark Bowser.bin': { size: 540, hash: 'hDark', amiiboId: 'SKY-BOWSER', isDir: false },
    }),
  });

  assert.deepEqual(r.missingLocally, [], 'the ID is present locally, so nothing is "missing"');
  assert.equal(r.variants.length, 1, 'but the extra dump must still surface');
  assert.deepEqual(r.variants[0].device, ['Dark Bowser.bin']);
});

test('no variant is reported when both sides hold the same dumps', () => {
  const both = {
    'a.bin': { size: 540, hash: 'h1', amiiboId: 'ID-A', isDir: false },
  };
  const r = compareByContent({ local: index(both), device: index(both) });
  assert.deepEqual(r.variants, []);
});

test('operating-system metadata is never uploaded to the device', () => {
  // A push would otherwise carry Finder and Explorer droppings onto the drive.
  for (const junk of ['.DS_Store', 'desktop.ini', 'Thumbs.db', 'sub/.DS_Store']) {
    assert.equal(isExcluded(junk), true, `${junk} must be excluded`);
  }

  const p = plan(
    { 'Zelda/.DS_Store': file(6148, 'h1'), 'Zelda/desktop.ini': file(244, 'h2'), 'Zelda/Link.bin': file(540, 'h3') },
    {},
    {}
  );
  assert.deepEqual(p.upload.map((u) => u.relPath), ['Zelda/Link.bin']);
});

// ---- identity sync ------------------------------------------------------

const dump = (id, extra = {}) => ({ size: 540, isDir: false, amiiboId: id, ...extra });

function idPlan(local, device, options = {}) {
  return planIdentitySync({
    local: index(local),
    device: index(device),
    deviceRoot: ROOT,
    options,
  });
}

test('identity sync ignores paths entirely', () => {
  // The same dump, filed completely differently on each side — the real case
  // across two copies of one collection, which shared zero paths.
  const p = idPlan(
    { 'My Stuff/Link.bin': dump('ID-LINK', { hash: 'h1' }) },
    { 'loz/link.bin': dump('ID-LINK', { hash: 'h1' }) }
  );
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.download, []);
  assert.equal(p.stats.onBothSides, 1);
});

test('a second dump of an amiibo already held counts as a separate item', () => {
  // The accepted cost of not collapsing on ID alone: a re-scan of the same
  // figure has a different UID, so it reads as another item and transfers.
  // Erring this way keeps the 91 item cards and the four vehicle pairings,
  // which collapsing would silently discard.
  const p = idPlan(
    { 'mine/Link.bin': dump('ID-LINK', { hash: 'scan-a' }) },
    { 'theirs/Link.bin': dump('ID-LINK', { hash: 'scan-b' }) },
    { direction: 'push' }
  );
  assert.equal(p.upload.length, 1);
});

test('identity sync uploads an amiibo the device lacks, keeping the local layout', () => {
  const p = idPlan(
    { 'Zelda/Link.bin': dump('ID-LINK', { hash: 'h1' }) },
    {},
    { direction: 'push' }
  );
  assert.deepEqual(p.upload.map((u) => u.relPath), ['Zelda/Link.bin']);
  assert.deepEqual(p.mkdirDevice.map((m) => m.relPath), ['Zelda']);
});

test('identity sync downloads an amiibo only the device has', () => {
  const p = idPlan({}, { 'loz/rare.bin': dump('ID-RARE') }, { direction: 'pull' });
  assert.deepEqual(p.download.map((d) => d.relPath), ['loz/rare.bin']);
  assert.deepEqual(p.mkdirLocal.map((m) => m.relPath), ['loz']);
});

test('push never writes locally and pull never writes to the device', () => {
  const both = { 'a.bin': dump('ID-A', { hash: 'h1' }) };
  const push = idPlan(both, {}, { direction: 'push' });
  assert.deepEqual(push.download, []);
  const pull = idPlan(both, {}, { direction: 'pull' });
  assert.deepEqual(pull.upload, []);
  assert.deepEqual(pull.mkdirDevice, []);
});

test('vehicle pairings are transferred individually', () => {
  // One amiibo ID, four products. An ID-only rule would move just one.
  const local = {};
  for (const v of ['Warp Star', 'Winged Star', 'Shadow Star', 'Tank Star']) {
    local[`kirby/${v}.bin`] = { size: 2048, isDir: false, amiiboId: 'ID-KIRBY', vehicle: v, hash: `h-${v}` };
  }
  const device = { 'k/warp.bin': { size: 2048, isDir: false, amiiboId: 'ID-KIRBY', vehicle: 'Warp Star', hash: 'x' } };

  const p = idPlan(local, device, { direction: 'push' });
  assert.equal(p.upload.length, 3, 'the three vehicles the device lacks');
  assert.ok(!p.upload.some((u) => u.vehicle === 'Warp Star'));
});

test('dumps that differ only in content are treated as separate items', () => {
  // The 91 Animal Crossing item cards share an ID and have no vehicle, so
  // content is what tells them apart. Collapsing them would lose 90.
  const local = {};
  for (let i = 0; i < 5; i++) local[`hhd/${i}.bin`] = dump('ID-HHD', { hash: `h${i}` });

  const p = idPlan(local, {}, { direction: 'push' });
  assert.equal(p.upload.length, 5);
});

test('a duplicate of an amiibo already held transfers only once', () => {
  const p = idPlan(
    { 'a/Link.bin': dump('ID-LINK', { hash: 'same' }), 'b/Link copy.bin': dump('ID-LINK', { hash: 'same' }) },
    {},
    { direction: 'push' }
  );
  assert.equal(p.upload.length, 1, 'identical dumps are one identity');
});

test('an over-long destination is blocked, not truncated', () => {
  const long = `others/Monster Hunter/${'x'.repeat(45)}.bin`;
  const p = idPlan({ [long]: dump('ID-X', { hash: 'h' }) }, {}, { direction: 'push' });
  assert.deepEqual(p.upload, []);
  assert.equal(p.blocked.length, 1);
});

test('files with no readable amiibo ID are left alone and reported', () => {
  const p = idPlan(
    { 'notes.txt': { size: 10, isDir: false, hash: 'h' }, 'a.bin': dump('ID-A', { hash: 'h1' }) },
    {},
    { direction: 'push' }
  );
  assert.deepEqual(p.upload.map((u) => u.relPath), ['a.bin']);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /no readable amiibo ID/);
});

test('device-managed files are never identity-synced', () => {
  const p = idPlan({}, { 'key_retail.bin': dump('ID-K'), 'settings.bin': dump('ID-S') }, { direction: 'pull' });
  assert.deepEqual(p.download, []);
});

test('identity sync never deletes anything', () => {
  const p = idPlan({ 'mine.bin': dump('ID-A', { hash: 'h' }) }, { 'theirs.bin': dump('ID-B', { hash: 'h2' }) });
  assert.deepEqual(p.deleteDevice, []);
  assert.deepEqual(p.deleteLocal, []);
  assert.deepEqual(p.rmdirDevice, []);
});

// ---- full dump ----------------------------------------------------------

test('a dump downloads everything on the device, mirroring its layout', () => {
  const p = planDump({
    device: index({
      'Zelda': dir(),
      'Zelda/Link.bin': file(540),
      'ac/Isabelle.bin': file(540),
    }),
    deviceRoot: ROOT,
  });

  assert.deepEqual(p.download.map((d) => d.relPath).sort(), ['Zelda/Link.bin', 'ac/Isabelle.bin']);
  assert.ok(p.mkdirLocal.some((m) => m.relPath === 'Zelda'));
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.deleteLocal, []);
  assert.deepEqual(p.deleteDevice, []);
});

test('a dump re-fetches a file whose content is not known to match', () => {
  // Same path, same 540 bytes, but no recorded hash: every dump is 540 bytes,
  // so skipping on size would silently miss a changed file.
  const p = planDump({
    device: index({ 'a.bin': file(540) }),
    local: index({ 'a.bin': file(540, 'h1') }),
    deviceRoot: ROOT,
  });
  assert.deepEqual(p.download.map((d) => d.relPath), ['a.bin']);
});

test('a dump skips a file already held with identical content', () => {
  const p = planDump({
    device: index({ 'a.bin': file(540, 'same') }),
    local: index({ 'a.bin': file(540, 'same') }),
    deviceRoot: ROOT,
  });
  assert.deepEqual(p.download, []);
  assert.deepEqual(p.unchanged, ['a.bin']);
});

test('a dump leaves device state alone unless asked for it', () => {
  const device = index({ 'key_retail.bin': file(160), 'settings.bin': file(24), 'a.bin': file(540) });

  const without = planDump({ device, deviceRoot: ROOT });
  assert.deepEqual(without.download.map((d) => d.relPath), ['a.bin']);
  assert.match(without.warnings[0], /device state/);

  const with_ = planDump({ device, deviceRoot: ROOT, options: { includeDeviceFiles: true } });
  assert.equal(with_.download.length, 3);
});

test('a dump never writes to the device', () => {
  const p = planDump({
    device: index({ 'a.bin': file(540) }),
    local: index({ 'only-local.bin': file(540, 'h') }),
    deviceRoot: ROOT,
  });
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.mkdirDevice, []);
  assert.deepEqual(p.deleteDevice, []);
  assert.deepEqual(p.rmdirDevice, []);
});

// ---- local name sanitisation --------------------------------------------

test('a trailing space is trimmed, because the browser refuses such names', () => {
  // Real device folders: "others/Dark Souls " and "others/Chibi Robo ".
  // getDirectoryHandle rejects them with "Name is not allowed".
  assert.equal(sanitizeLocalName('Dark Souls '), 'Dark Souls');
  assert.equal(sanitizeLocalRelPath('others/Chibi Robo /01 - Chibi-Robo.bin'),
    'others/Chibi Robo/01 - Chibi-Robo.bin');
});

test('characters the local filesystem rejects are replaced', () => {
  // The device stores these happily — the write test confirmed it.
  assert.equal(sanitizeLocalName('Star*Q?.bin'), 'Star_Q_.bin');
  assert.equal(sanitizeLocalName('Quote "X".bin'), 'Quote _X_.bin');
  assert.equal(sanitizeLocalName('Colon:Test.bin'), 'Colon_Test.bin');
});

test('names that are legal are left exactly alone', () => {
  for (const name of ['Link.bin', "Majora's Mask.bin", 'Mr. Game & Watch.bin', 'Kamijō.bin']) {
    assert.equal(sanitizeLocalName(name), name);
  }
});

test('reserved device names are escaped', () => {
  assert.equal(sanitizeLocalName('CON'), '_CON');
  assert.equal(sanitizeLocalName('nul.bin'), '_nul.bin');
});

test('a name that sanitises to nothing still yields something usable', () => {
  assert.equal(sanitizeLocalName('   '), '_');
  assert.equal(sanitizeLocalName('...'), '_');
});

test('a dump carries the safe local destination and reports the rename', () => {
  const p = planDump({
    device: index({
      'others/Dark Souls ': dir(),
      'others/Dark Souls /1 - Solaire.bin': file(540),
    }),
    deviceRoot: ROOT,
  });

  const dl = p.download.find((d) => d.relPath.includes('Solaire'));
  assert.equal(dl.localPath, 'others/Dark Souls/1 - Solaire.bin');
  assert.ok(p.mkdirLocal.some((m) => m.localPath === 'others/Dark Souls'));
  assert.deepEqual(p.renamedLocally, [
    { from: 'others/Dark Souls /1 - Solaire.bin', to: 'others/Dark Souls/1 - Solaire.bin' },
  ]);
});

test('nothing is reported as renamed when no name needs changing', () => {
  const p = planDump({ device: index({ 'Zelda/Link.bin': file(540) }), deviceRoot: ROOT });
  assert.equal(p.renamedLocally, undefined);
  assert.equal(p.download[0].localPath, 'Zelda/Link.bin');
});
