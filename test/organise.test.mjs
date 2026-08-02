// planOrganise — pure logic, no hardware and no browser: node --test
//
// Organise invents no naming rules. amiiboRelPath already decides where a dump
// belongs and has only ever been called at ingest, for files with no home yet;
// this calls it for files that already have one, so the two can never disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planOrganise,
  planSync,
  planDump,
  flattenPlan,
  amiiboRelPath,
  isExcluded,
} from '../web/js/planner.js';

const ROOT = 'E:/amiibo';

const dir = () => ({ size: 0, isDir: true });
const dump = (amiiboId, extra = {}) => ({ size: 540, isDir: false, amiiboId, ...extra });
const index = (entries) => new Map(Object.entries(entries));

// Two real IDs from the shipped database, so the expected paths are whatever
// the layout engine actually produces rather than something restated here.
const MARIO = '0000000000000002';
const LINK = '0100000000040002';

const where = (id, deviceRoot = ROOT) => amiiboRelPath(id, { deviceRoot });

function orgPlan(entries, opts = {}) {
  return planOrganise({
    index: index(entries),
    side: opts.side ?? 'device',
    walkRoot: opts.walkRoot ?? ROOT,
    destRoot: opts.destRoot,
    options: opts.options ?? {},
  });
}

test('a flat pile of dumps is refiled into series folders', () => {
  const p = orgPlan({ 'a.bin': dump(MARIO), 'b.bin': dump(LINK) });

  assert.deepEqual(
    p.moveDevice.map((m) => [m.from, m.to]),
    [['a.bin', where(MARIO)], ['b.bin', where(LINK)]]
  );
  assert.ok(p.moveDevice[0].to.includes('/'), 'expected a folder in the target path');

  // Folders must exist before anything moves into them.
  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('mkdirDevice') < ops.indexOf('moveDevice'), 'folder must precede its file');
});

test('a file already in the right place is unchanged, not moved', () => {
  const p = orgPlan({ [where(MARIO)]: dump(MARIO) });

  assert.deepEqual(p.moveDevice, []);
  assert.deepEqual(p.unchanged, [where(MARIO)]);
});

test('organising an already-organised library is a no-op', () => {
  const first = orgPlan({ 'a.bin': dump(MARIO), 'b.bin': dump(LINK) });

  // Apply the plan on paper, then re-plan. buildPlan runs every planner twice,
  // so a planner that is not idempotent produces different work on the second
  // pass and the review the user approved is not what runs.
  const after = {};
  for (const m of first.moveDevice) after[m.to] = dump(m.to === where(MARIO) ? MARIO : LINK);
  for (const m of first.mkdirDevice) after[m.relPath] = dir();

  const second = orgPlan(after);
  assert.deepEqual(second.moveDevice, []);
  assert.deepEqual(second.rmdirDevice, []);
  assert.equal(second.unchanged.length, 2);
});

test('a folder emptied by the moves is swept, deepest first', () => {
  const p = orgPlan({ old: dir(), 'old/deep': dir(), 'old/deep/a.bin': dump(MARIO) });

  const removed = p.rmdirDevice.map((r) => r.relPath);
  assert.deepEqual(removed, ['old/deep', 'old']);
  const ops = flattenPlan(p);
  assert.ok(
    ops.findIndex((o) => o.op === 'moveDevice') < ops.findIndex((o) => o.op === 'rmdirDevice'),
    'a folder cannot go before the file inside it has moved out'
  );
});

test('a folder still holding something is left alone', () => {
  const p = orgPlan({
    old: dir(),
    'old/a.bin': dump(MARIO),
    'old/notes.txt': { size: 12, isDir: false }, // no amiiboId, so it stays
  });

  assert.deepEqual(p.rmdirDevice, []);
  assert.deepEqual(p.unidentified.map((u) => u.relPath), ['old/notes.txt']);
});

test('a file that is not a dump is left exactly where it is', () => {
  const p = orgPlan({ 'mystery.bin': { size: 540, isDir: false } });

  assert.deepEqual(p.moveDevice, []);
  assert.deepEqual(p.unidentified.map((u) => u.relPath), ['mystery.bin']);
  assert.ok(p.warnings.some((w) => w.includes('not recognised amiibo dumps')));
});

test('two dumps of one amiibo: the first moves, the second is blocked', () => {
  const p = orgPlan({ 'a.bin': dump(MARIO), 'b.bin': dump(MARIO) });

  assert.equal(p.moveDevice.length, 1);
  assert.equal(p.moveDevice[0].from, 'a.bin');
  assert.deepEqual(p.blocked.map((b) => b.relPath), ['b.bin']);
  assert.match(p.blocked[0].reason, /already claims/);
});

test('a target already occupied by a different file is blocked, not overwritten', () => {
  const p = orgPlan({ 'a.bin': dump(MARIO), [where(MARIO)]: { size: 12, isDir: false } });

  assert.deepEqual(p.moveDevice, []);
  assert.deepEqual(p.blocked.map((b) => b.relPath), ['a.bin']);
});

// ---- cross-root, which is what makes a rescue recoverable ----------------

test('walking the drive root files rescued dumps back under the device folder', () => {
  const p = orgPlan({
    r_: dir(),
    'r_/1': dir(),
    'r_/1/0001.bin': dump(MARIO),
    'r_/1/0002.bin': dump(LINK),
  }, { walkRoot: 'E:/', destRoot: 'E:/amiibo' });

  assert.deepEqual(
    p.moveDevice.map((m) => [m.from, m.to]),
    [['r_/1/0001.bin', `amiibo/${where(MARIO)}`], ['r_/1/0002.bin', `amiibo/${where(LINK)}`]]
  );
  // Both sides of every move stay relative to the walked root, which is what
  // lets applyPlan's existing moveDevice run this unchanged.
  for (const m of p.moveDevice) {
    assert.ok(!m.from.startsWith('E:/') && !m.to.startsWith('E:/'), 'absolute path in a plan');
  }
  // And the staging tree collapses completely rather than leaving r_/ behind.
  assert.deepEqual(p.rmdirDevice.map((r) => r.relPath), ['r_/1', 'r_']);
});

test('the byte budget is measured where the file will live, not where it is', () => {
  // A deep destination shortens the name ladder; organise must ask about the
  // destination or it emits a path the device cannot address.
  const deep = 'E:/amiibo/one/two/three';
  const p = orgPlan({ 'a.bin': dump(MARIO) }, { walkRoot: 'E:/', destRoot: deep });

  assert.equal(p.moveDevice[0].to, `amiibo/one/two/three/${where(MARIO, deep)}`);
});

test('a destination outside the walked root is refused', () => {
  assert.throws(
    () => orgPlan({ 'a.bin': dump(MARIO) }, { walkRoot: 'E:/amiibo', destRoot: 'E:/other' }),
    /not inside/
  );
});

// ---- what organise must never touch --------------------------------------

test('device-managed dumps are never refiled, even at drive-root scope', () => {
  const p = orgPlan({
    amiibolink: dir(),
    'amiibolink/00.bin': dump(MARIO),
    chameleon: dir(),
    'chameleon/slots/00.bin': dump(LINK),
    'loose.bin': dump(MARIO),
  }, { walkRoot: 'E:/', destRoot: 'E:/amiibo' });

  // These are real 540-byte dumps, so identification recognises them — moving
  // them would break slot emulation and Chameleon state.
  assert.deepEqual(p.moveDevice.map((m) => m.from), ['loose.bin']);
  assert.deepEqual(p.rmdirDevice, []);
  assert.deepEqual(p.unidentified, []);
});

test('a folder that could not be listed is never swept', () => {
  const p = orgPlan({
    stuck: { size: 0, isDir: true, unenumerated: 'unlistable' },
    'a.bin': dump(MARIO),
  });

  assert.deepEqual(p.rmdirDevice, []);
  assert.equal(p.stats.unenumerated, 1);
  assert.ok(p.warnings.some((w) => w.includes('could not be listed')));
});

test('the staging tree is excluded from sync and backup but not from organise', () => {
  const staged = { 'r_/1/0001.bin': dump(MARIO), 'r_/1': dir(), r_: dir() };

  // Sync and backup must treat it as scaffolding...
  assert.equal(isExcluded('r_/1/0001.bin'), true);
  const push = planSync({
    local: index(staged), device: index({}), state: { entries: {} }, deviceRoot: ROOT,
    options: { mode: 'push' },
  });
  assert.deepEqual(push.upload, []);
  const backup = planDump({ device: index(staged), deviceRoot: ROOT });
  assert.deepEqual(backup.download, []);

  // ...but organise is the operation whose job is to empty it. Honouring the
  // exclusion here would make the whole rescue round trip silently do nothing.
  const org = orgPlan(staged, { walkRoot: 'E:/', destRoot: 'E:/amiibo' });
  assert.equal(org.moveDevice.length, 1);
});

// ---- the local side ------------------------------------------------------

test('organising a folder emits local moves and sweeps in the right order', () => {
  const p = orgPlan({ old: dir(), 'old/a.bin': dump(MARIO) }, { side: 'local', walkRoot: '' });

  assert.deepEqual(
    p.moveLocal.map((m) => [m.from, m.to]),
    [['old/a.bin', amiiboRelPath(MARIO, { deviceRoot: '' })]]
  );
  assert.deepEqual(p.moveDevice, []);
  assert.deepEqual(p.rmdirLocal.map((r) => r.relPath), ['old']);

  const ops = flattenPlan(p).map((o) => o.op);
  assert.ok(ops.indexOf('mkdirLocal') < ops.indexOf('moveLocal'));
  assert.ok(ops.indexOf('moveLocal') < ops.indexOf('rmdirLocal'));
});

test('a large local-only plan does not estimate itself at zero seconds', () => {
  // The FSA API has no rename, so each local move is a read, a write and a
  // delete. Cheap per file, but a whole library of them is not instant, and a
  // plan reporting "0s" reads as "nothing to do".
  const many = {};
  for (let i = 0; i < 400; i++) many[`loose/${i}.bin`] = dump(`dead${String(i).padStart(12, '0')}`);
  many.loose = dir();

  const p = orgPlan(many, { side: 'local', walkRoot: '' });

  assert.equal(p.moveLocal.length, 400);
  assert.ok(p.stats.estimatedSeconds > 0, 'a 400-file local plan estimated at zero');
});

test('a local organise never touches the device', () => {
  const p = orgPlan({ 'a.bin': dump(MARIO) }, { side: 'local', walkRoot: '' });

  assert.deepEqual(p.moveDevice, []);
  assert.deepEqual(p.mkdirDevice, []);
  assert.deepEqual(p.rmdirDevice, []);
  assert.deepEqual(p.upload, []);
  assert.deepEqual(p.download, []);
});
