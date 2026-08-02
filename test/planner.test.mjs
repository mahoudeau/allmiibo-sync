// Planner tests — pure logic, no hardware and no browser.
//   node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planSync,
  planIdentitySync,
  planDump,
  planReplace,
  sanitizeLocalName,
  sanitizeLocalRelPath,
  storedSize,
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

test('the estimate reflects what an upload actually costs', () => {
  const local = {};
  for (let i = 0; i < 100; i++) local[`f${i}.bin`] = file(540, `h${i}`);
  const p = plan(local, {}, {});

  assert.equal(p.stats.upload, 100);
  // Measured at ~2.5 s per 540-byte dump, so a hundred of them is a few
  // minutes — not the ~47 s the per-chunk throughput figure suggested.
  const minutes = p.stats.estimatedSeconds / 60;
  assert.ok(minutes > 3 && minutes < 6, `estimated ${minutes.toFixed(1)} min for 100 dumps`);
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

test('a second dump skips what the first one already fetched', () => {
  // The executor records size and hash per device path as it downloads.
  const device = index({ 'Zelda/Link.bin': file(540) });
  const local = index({ 'Zelda/Link.bin': file(540, 'downloaded') });
  const state = { entries: { 'Zelda/Link.bin': { size: 540, hash: 'downloaded' } } };

  const p = planDump({ device, local, state, deviceRoot: ROOT });
  assert.deepEqual(p.download, []);
  assert.deepEqual(p.unchanged, ['Zelda/Link.bin']);
});

test('a locally modified file is fetched again', () => {
  const p = planDump({
    device: index({ 'a.bin': file(540) }),
    local: index({ 'a.bin': file(540, 'edited-since') }),
    state: { entries: { 'a.bin': { size: 540, hash: 'downloaded' } } },
    deviceRoot: ROOT,
  });
  assert.deepEqual(p.download.map((d) => d.relPath), ['a.bin']);
});

test('a device file that changed size is fetched again', () => {
  const p = planDump({
    device: index({ 'a.bin': file(572) }),
    local: index({ 'a.bin': file(540, 'downloaded') }),
    state: { entries: { 'a.bin': { size: 540, hash: 'downloaded' } } },
    deviceRoot: ROOT,
  });
  assert.deepEqual(p.download.map((d) => d.relPath), ['a.bin']);
});

test('force re-fetches everything regardless of the record', () => {
  const p = planDump({
    device: index({ 'a.bin': file(540) }),
    local: index({ 'a.bin': file(540, 'downloaded') }),
    state: { entries: { 'a.bin': { size: 540, hash: 'downloaded' } } },
    deviceRoot: ROOT,
    options: { force: true },
  });
  assert.deepEqual(p.download.map((d) => d.relPath), ['a.bin']);
});

test('the skip is matched against the sanitised local path', () => {
  // Downloaded from "Dark Souls /x.bin", saved as "Dark Souls/x.bin".
  const p = planDump({
    device: index({ 'Dark Souls /x.bin': file(540) }),
    local: index({ 'Dark Souls/x.bin': file(540, 'downloaded') }),
    state: { entries: { 'Dark Souls /x.bin': { size: 540, hash: 'downloaded' } } },
    deviceRoot: ROOT,
  });
  assert.deepEqual(p.download, [], 'the renamed local copy must still count as held');
});

test('skipping is explained, including what it cannot notice', () => {
  const p = planDump({
    device: index({ 'a.bin': file(540) }),
    local: index({ 'a.bin': file(540, 'downloaded') }),
    state: { entries: { 'a.bin': { size: 540, hash: 'downloaded' } } },
    deviceRoot: ROOT,
  });
  assert.match(p.warnings.join(' '), /would not be noticed/);
});

// ---- capacity and ordering ----------------------------------------------

// Real hardware: 1,920,401 bytes total with 966,601 free, so 953,800 used.
const DRIVE = { totalSize: 1_920_401, freeSize: 966_601, usedSize: 953_800 };

test('uploads precede deletions when there is room for both', () => {
  const p = plan(
    { 'new.bin': file(540, 'h1') },
    { 'old.bin': file(540) },
    { 'old.bin': { size: 540, hash: 'h0' } },
    { delete: true, drive: DRIVE }
  );

  assert.equal(p.deleteFirst, false);
  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('upload') < ops.indexOf('deleteDevice'),
    'nothing is destroyed until its replacement is on the device');
});

test('deletions precede uploads when the incoming data would not fit', () => {
  // Nearly full drive: the new files only fit once the old ones are gone.
  const nearlyFull = { totalSize: 10_000, usedSize: 9_000 };
  const local = {};
  const device = {};
  const state = {};
  for (let i = 0; i < 10; i++) {
    local[`new${i}.bin`] = file(540, `n${i}`);
    device[`old${i}.bin`] = file(540);
    state[`old${i}.bin`] = { size: 540, hash: `o${i}` };
  }

  const p = plan(local, device, state, { delete: true, drive: nearlyFull });

  assert.equal(p.deleteFirst, true);
  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('deleteDevice') < ops.indexOf('upload'),
    'the room has to be reclaimed before the uploads can land');
  assert.match(p.warnings.join(' '), /Deleting before uploading/);
});

test('a plan that cannot fit even after deletions says so', () => {
  const tiny = { totalSize: 2_000, usedSize: 1_000 };
  const local = {};
  for (let i = 0; i < 20; i++) local[`f${i}.bin`] = file(540, `h${i}`);

  const p = plan(local, {}, {}, { delete: true, drive: tiny });
  assert.equal(p.capacity.fits, false);
  assert.match(p.warnings.join(' '), /Not enough room/);
});

test('folder removals travel with the file deletions', () => {
  const nearlyFull = { totalSize: 6_000, usedSize: 5_600 };
  const p = plan(
    { 'new.bin': file(540, 'h') },
    { 'gone/a.bin': file(540), gone: dir() },
    { 'gone/a.bin': { size: 540, hash: 'h0' } },
    { delete: true, drive: nearlyFull }
  );

  assert.equal(p.deleteFirst, true);
  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('deleteDevice') < ops.indexOf('rmdirDevice'), 'files before their folders');
  assert.ok(ops.indexOf('rmdirDevice') < ops.indexOf('upload'));
});

test('without drive figures the safe order is kept', () => {
  const p = plan({ 'a.bin': file(540, 'h') }, { 'b.bin': file(540) },
    { 'b.bin': { size: 540, hash: 'x' } }, { delete: true });
  assert.equal(p.capacity, undefined);
  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('upload') < ops.indexOf('deleteDevice'));
});

test('capacity counts what a file actually occupies, not its contents', () => {
  // A 540-byte dump costs about 1.1 kB once filesystem overhead is counted.
  assert.ok(storedSize(540) > 1000, `540 bytes should cost over 1 kB, got ${storedSize(540)}`);
});

test('a replace that only fits on paper is refused', () => {
  // The real failure: 1049 dumps, 590 kB of content, 963 kB free -- looked
  // fine on raw bytes, needed 1.18 MB, died 320 uploads in.
  const local = {};
  for (let i = 0; i < 1049; i++) local[`f${i}.bin`] = file(540, `h${i}`);

  const p = plan(local, {}, {}, {
    delete: true,
    drive: { totalSize: 1_920_401, freeSize: 963_589, usedSize: 956_812 },
  });

  assert.equal(p.capacity.fits, false, 'raw content bytes would have said this fits');
  assert.match(p.warnings.join(' '), /Not enough room/);
});

test('an empty device has room for a full library', () => {
  // Reported by users: a freshly formatted drive refused every sync. The drive
  // list gives free space, not used space, and reading it as "used" left
  // 1,757 bytes free — the amount littlefs actually occupies when empty.
  const drive = { totalSize: 1_920_401, freeSize: 1_918_644, usedSize: 1_757 };
  const local = {};
  for (let i = 0; i < 668; i++) local[`f${i}.bin`] = file(540, `h${i}`);

  const p = plan(local, {}, {}, { delete: true, drive });

  assert.equal(p.capacity.freeNow, 1_918_644);
  assert.equal(p.capacity.usedSize, 1_757);
  assert.equal(p.capacity.fits, true, '668 dumps fit on an empty 1.8 MB drive');
  assert.equal(p.warnings.join(' ').includes('Not enough room'), false);
});

test('overwriting a file already on the device needs no room for a second copy', () => {
  // A near-full device refreshing what it already holds. vfs_open_file opens
  // with TRUNC, so each old copy goes before its replacement is written.
  const drive = { totalSize: 1_920_401, freeSize: 20_000, usedSize: 1_900_401 };
  const local = {}, device = {}, state = {};
  for (let i = 0; i < 800; i++) {
    local[`f${i}.bin`] = file(540, `new${i}`);
    device[`f${i}.bin`] = file(540);
    state[`f${i}.bin`] = { size: 540, hash: `old${i}` };
  }

  const p = plan(local, device, state, { delete: true, drive });

  assert.equal(p.upload.length, 800);
  assert.equal(p.capacity.replacingBytes, 800 * storedSize(540));
  assert.equal(p.capacity.fits, true, 'replacing 800 files in place frees as much as it needs');
  assert.equal(p.deleteFirst, false);
});

test('an overwrite is only credited the copy it actually replaces', () => {
  // 300 fresh files on top of 100 replacements, with room for neither.
  const drive = { totalSize: 200_000, freeSize: 5_000, usedSize: 195_000 };
  const local = {}, device = {}, state = {};
  for (let i = 0; i < 100; i++) {
    local[`old${i}.bin`] = file(540, `new${i}`);
    device[`old${i}.bin`] = file(540);
    state[`old${i}.bin`] = { size: 540, hash: `o${i}` };
  }
  for (let i = 0; i < 300; i++) local[`fresh${i}.bin`] = file(540, `f${i}`);

  const p = plan(local, device, state, { delete: true, drive });

  assert.equal(p.capacity.replacingBytes, 100 * storedSize(540));
  assert.equal(p.capacity.fits, false);
  assert.match(p.warnings.join(' '), /files being overwritten/);
});

test('a drive carrying only the derived used figure still works', () => {
  // Saved runs and older exports have no freeSize field.
  const p = plan({ 'a.bin': file(540, 'h') }, {}, {},
    { delete: true, drive: { totalSize: 10_000, usedSize: 9_000 } });
  assert.equal(p.capacity.freeNow, 1_000);
  assert.equal(p.capacity.fits, false);
});

test('a replace deletes first even when uploads would fit', () => {
  // Deleting first is the point of a replacement: local is the source of
  // truth, and it avoids needing room for both copies.
  const p = plan(
    { 'new.bin': file(540, 'h1') },
    { 'old.bin': file(540) },
    { 'old.bin': { size: 540, hash: 'h0' } },
    { delete: true, drive: DRIVE, preferDeleteFirst: true }
  );

  assert.equal(p.deleteFirst, true);
  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('deleteDevice') < ops.indexOf('upload'));
});

test('a smart sync still protects the device copy until its replacement lands', () => {
  const p = plan(
    { 'a.bin': file(540, 'new') },
    { 'a.bin': file(540), 'gone.bin': file(540) },
    { 'a.bin': { size: 540, hash: 'old' }, 'gone.bin': { size: 540, hash: 'g' } },
    { mode: 'two-way', delete: true, drive: DRIVE }
  );
  assert.equal(p.deleteFirst, false);
});

test('the run log records every operation, not only the failures', async () => {
  // Verified through the executor rather than the planner, since that is where
  // the record is built.
  const { applyPlan } = await import('../web/js/sync.js');

  const client = {
    createFolder: async () => {},
    writeFile: async (path) => {
      if (path.includes('full')) {
        const err = new Error('cmd 21 failed with status 1');
        err.cmd = 21;
        err.status = 1;
        throw err;
      }
    },
    remove: async () => {},
  };

  const ops = [
    { op: 'mkdirDevice', relPath: 'a' },
    { op: 'upload', relPath: 'a/ok.bin', size: 540, hash: 'h1' },
    { op: 'upload', relPath: 'a/full.bin', size: 540, hash: 'h2' },
  ];

  // Uploads read the local file first, so the handle has to yield bytes.
  const fileHandle = {
    async getFile() {
      return { size: 540, arrayBuffer: async () => new Uint8Array(540).buffer };
    },
  };
  const rootHandle = {
    async getDirectoryHandle() { return rootHandle; },
    async getFileHandle() { return fileHandle; },
  };

  const state = { entries: {} };
  const result = await applyPlan({
    client,
    rootHandle,
    deviceRoot: 'E:/amiibo',
    state,
    ops,
    callbacks: {},
  });

  assert.equal(result.log.length, 3, 'successes are recorded too');
  assert.equal(result.log[0].op, 'mkdirDevice');
  assert.equal(result.log[0].ok, true);

  const failure = result.log.find((e) => e.ok === false);
  assert.equal(failure.path, 'a/full.bin');
  assert.equal(failure.cmd, 21, 'the command that failed');
  assert.equal(failure.status, 1, 'and the status it returned');
  assert.ok(Number.isFinite(failure.ms), 'with a duration');
  assert.ok(Number.isFinite(failure.at), 'and an offset into the run');
});

test('a half-written file left by a failed upload is re-uploaded, not skipped', () => {
  // vfs_open_file creates the file before vfs_write_file fills it, so a push
  // that runs out of room leaves a 0-byte file behind. With no sync record and
  // no device hash, treating that as unknowable would strand it forever.
  const p = plan(
    { 'a.bin': file(540, 'h1') },
    { 'a.bin': file(0) },
    {},
    { mode: 'push', delete: true }
  );

  assert.deepEqual(p.upload.map((u) => u.relPath), ['a.bin']);
  assert.deepEqual(p.ambiguous, []);
});

test('differing sizes are still unknowable in neither direction, so pull takes the device copy', () => {
  const p = plan({ 'a.bin': file(540, 'h1') }, { 'a.bin': file(0) }, {}, { mode: 'pull' });
  assert.deepEqual(p.download.map((d) => d.relPath), ['a.bin']);
});

test('equal sizes with no record are still left alone', () => {
  // The case the size rule must not swallow: two 540-byte dumps that may or
  // may not be the same.
  const p = plan({ 'a.bin': file(540, 'h1') }, { 'a.bin': file(540) }, {});
  assert.deepEqual(p.upload, []);
  assert.equal(p.ambiguous.length, 1);
});

test('a file being moved is never also deleted', () => {
  // Renaming a folder to differ only in case put the device path first in sort
  // order, so a delete was scheduled before the move that claimed the same
  // file. With deletions running first, the rename then had no source.
  const local = new Map();
  const device = new Map();
  const state = {};
  for (let i = 0; i < 3; i++) {
    local.set(`street fighter/f${i}.bin`, { size: 540, hash: `sf${i}`, isDir: false });
    device.set(`Street fighter/f${i}.bin`, { size: 540, isDir: false });
    state[`Street fighter/f${i}.bin`] = { size: 540, hash: `sf${i}` };
  }

  const p = planSync({
    local, device, state: { entries: state }, deviceRoot: ROOT,
    options: { mode: 'push', delete: true, preferDeleteFirst: true },
  });

  assert.equal(p.moveDevice.length, 3, 'renamed, not re-uploaded');
  assert.deepEqual(p.upload, []);

  const moving = new Set(p.moveDevice.map((m) => m.from));
  const deleting = new Set(p.deleteDevice.map((d) => d.relPath));
  const both = [...moving].filter((f) => deleting.has(f));
  assert.deepEqual(both, [], 'a move source must never also be deleted');
});

test('a move still happens when the device path sorts after the local one', () => {
  // The mirror image of the case above, to be sure the fix is not order-bound.
  const p = plan(
    { 'AAA/f.bin': file(540, 'h1') },
    { 'zzz/f.bin': file(540) },
    { 'zzz/f.bin': { size: 540, hash: 'h1' } },
    { delete: true }
  );
  assert.deepEqual(p.moveDevice, [{ from: 'zzz/f.bin', to: 'AAA/f.bin' }]);
  assert.deepEqual(p.deleteDevice, []);
});

// ---- replace ------------------------------------------------------------

test('a replace deletes everything under the root, then writes everything back', () => {
  const p = planReplace({
    local: index({ 'a.bin': file(540, 'h1'), 'sub/b.bin': file(540, 'h2'), sub: dir() }),
    device: index({ 'old1.bin': file(540), 'old2.bin': file(540), 'olddir/c.bin': file(540), olddir: dir() }),
    deviceRoot: ROOT,
  });

  assert.deepEqual(p.deleteDevice.map((d) => d.relPath).sort(),
    ['old1.bin', 'old2.bin', 'olddir/c.bin']);
  assert.deepEqual(p.upload.map((u) => u.relPath).sort(), ['a.bin', 'sub/b.bin']);
  assert.equal(p.deleteFirst, true);
  assert.deepEqual(p.unchanged, [], 'a replacement skips nothing');
});

test('a replace re-uploads a file the device already has', () => {
  // The point of the operation: a device file of the right size and the wrong
  // contents cannot be detected without reading it back, so it is replaced
  // rather than trusted.
  const same = { 'a.bin': file(540, 'h1') };
  const p = planReplace({
    local: index(same),
    device: index({ 'a.bin': file(540) }),
    deviceRoot: ROOT,
  });

  assert.deepEqual(p.upload.map((u) => u.relPath), ['a.bin']);
  assert.deepEqual(p.deleteDevice.map((d) => d.relPath), ['a.bin']);
});

test('a replace clears before it writes', () => {
  const p = planReplace({
    local: index({ 'a.bin': file(540, 'h') }),
    device: index({ 'old.bin': file(540) }),
    deviceRoot: ROOT,
  });
  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('deleteDevice') < ops.indexOf('upload'));
});

test('a replace leaves device state alone', () => {
  const p = planReplace({
    local: index({}),
    device: index({ 'key_retail.bin': file(160), 'settings.bin': file(24) }),
    deviceRoot: 'E:/',
  });
  assert.deepEqual(p.deleteDevice, []);
});

test('a replace that cannot fit the drive says so', () => {
  const local = {};
  for (let i = 0; i < 2000; i++) local[`f${i}.bin`] = file(540, `h${i}`);
  const p = planReplace({
    local: index(local),
    device: index({}),
    deviceRoot: ROOT,
    options: { drive: { totalSize: 1_920_401, usedSize: 0 } },
  });
  assert.equal(p.capacity.fits, false);
  assert.match(p.warnings.join(' '), /Will not fit/);
});

test('the time estimate matches what the hardware actually did', () => {
  // A push of 1049 dumps with 831 deletions took 48 minutes.
  const local = {};
  for (let i = 0; i < 1049; i++) local[`f${i}.bin`] = file(540, `h${i}`);
  const device = {};
  for (let i = 0; i < 831; i++) device[`old${i}.bin`] = file(540);

  const p = planReplace({ local: index(local), device: index(device), deviceRoot: ROOT });
  const minutes = p.stats.estimatedSeconds / 60;
  assert.ok(minutes > 35 && minutes < 60, `estimated ${minutes.toFixed(0)} min, expected about 48`);
});

// ---- folders that were never listed --------------------------------------
//
// walkDevice records a directory before reading it, so one it could not list
// sits in the index with no children — shaped exactly like an empty folder.
// remove() is recursive on the firmware (PROTOCOL.md §9.4), so treating the
// two alike erases a subtree nobody has seen. This already applied to
// path-too-long folders before any of the timeout work.

const unlisted = (reason = 'unlistable') => ({ size: 0, isDir: true, unenumerated: reason });

for (const reason of ['unlistable', 'too-deep', 'stopped', 'not-listed']) {
  test(`a folder flagged ${reason} is never removed`, () => {
    const p = plan({}, { Zelda: unlisted(reason) }, {}, { mode: 'push', delete: true });

    assert.deepEqual(p.rmdirDevice, []);
    assert.equal(p.stats.unenumerated, 1);
    assert.deepEqual(p.unenumerated.map((u) => u.relPath), ['Zelda']);
    assert.ok(
      p.warnings.some((w) => w.includes('could not be listed') && w.includes('Zelda')),
      'the plan removed nothing but never said why'
    );
  });
}

test('nor is the parent of a folder that was never listed', () => {
  const p = plan({}, { a: dir(), 'a/b': unlisted() }, {}, { mode: 'push', delete: true });
  assert.deepEqual(p.rmdirDevice, []);
});

test('a listed sibling is still removed — the guard is surgical, not blanket', () => {
  const p = plan({}, { a: dir(), b: unlisted() }, {}, { mode: 'push', delete: true });

  // Without this the guard could quietly degrade into "never rmdir anything".
  assert.deepEqual(p.rmdirDevice.map((r) => r.relPath), ['a']);
});

test('an unlisted folder does not stop uploads', () => {
  const p = plan(
    { 'a/x.bin': file(540, 'h1'), a: dir() },
    { a: unlisted() },
    {},
    { mode: 'push', delete: true }
  );

  // Blocking deletions must not turn into blocking the transfer the user asked
  // for; a push into an unreadable folder is still the user's explicit call.
  assert.deepEqual(p.upload.map((u) => u.relPath), ['a/x.bin']);
});

test('a local file under an unlisted folder is not deleted locally on pull', () => {
  const p = plan(
    { 'a/x.bin': file(540, 'h1'), a: dir() },
    { a: unlisted() },
    {},
    { mode: 'pull', delete: true }
  );

  assert.deepEqual(p.deleteLocal, []);
  assert.deepEqual(p.ambiguous.map((a) => a.relPath), ['a/x.bin']);
  assert.match(p.ambiguous[0].reason, /could not be listed/);
});

test('two-way does not delete a local file whose device folder went unlisted', () => {
  const p = plan(
    { 'a/x.bin': file(540, 'h1'), a: dir() },
    { a: unlisted() },
    { 'a/x.bin': { size: 540, hash: 'h1' } }, // synced before, so it looks removed
    { mode: 'two-way', delete: true }
  );

  assert.deepEqual(p.deleteLocal, []);
  assert.deepEqual(p.ambiguous.map((a) => a.relPath), ['a/x.bin']);
});

test('the no-shared-paths warning is suppressed when a folder could not be listed', () => {
  const p = plan(
    { 'a/x.bin': file(540, 'h1') },
    { b: unlisted(), 'c/y.bin': file(540, 'h2') },
    {}
  );

  // The unlisted folder is the real diagnosis; blaming the device root would
  // send the user off re-pointing a setting that was never wrong.
  assert.ok(!p.warnings.some((w) => w.includes('No path is shared')));
});

test('replace leaves an unlisted folder standing and says so', () => {
  const p = planReplace({
    local: index({ 'x.bin': file(540, 'h1') }),
    device: index({ Broken: unlisted(), keep: dir() }),
    deviceRoot: ROOT,
  });

  assert.deepEqual(p.rmdirDevice.map((r) => r.relPath), ['keep']);
  assert.ok(p.warnings.some((w) => w.includes('not a complete replacement')));
});

test('replace stops assuming an empty drive when a folder could not be listed', () => {
  const drive = { totalSize: 1_920_401, freeSize: 1_000_000 };
  const clean = planReplace({
    local: index({ 'x.bin': file(540, 'h1') }),
    device: index({ keep: dir() }),
    deviceRoot: ROOT,
    options: { drive },
  });
  const stuck = planReplace({
    local: index({ 'x.bin': file(540, 'h1') }),
    device: index({ Broken: unlisted() }),
    deviceRoot: ROOT,
    options: { drive },
  });

  assert.equal(clean.capacity.usableBytes, drive.totalSize);
  // 840 KB that stays put is 840 KB the uploads cannot have.
  assert.ok(stuck.capacity.usableBytes < drive.totalSize,
    'planned against room the unlisted folder is still occupying');
  assert.equal(stuck.capacity.usableBytes, drive.freeSize);
});

test('a backup warns that a subtree was not copied', () => {
  const p = planDump({
    device: index({ 'x.bin': file(540, 'h1'), Broken: unlisted() }),
    deviceRoot: ROOT,
  });

  assert.equal(p.stats.unenumerated, 1);
  assert.ok(p.warnings.some((w) => w.includes('Nothing inside them was backed up')));
});
