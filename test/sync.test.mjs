// walkDevice against a simulated device: node --test test/
//
// The behaviour under test is one rule with teeth. A directory that was never
// enumerated must be distinguishable from an empty one, because remove() is
// recursive on the firmware (PROTOCOL.md §9.4) — a planner that reads "no
// children" as "safe to remove" erases a subtree nobody has seen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkDevice, applyPlan, UNENUMERATED } from '../web/js/sync.js';
import { ProtocolError } from '../web/js/protocol.js';
import { memRoot, listTree } from './helpers/fshandles.mjs';

const ROOT = 'E:/amiibo';

const file = (name, size = 540) => ({ name, size, type: 0, isDir: false, meta: null });
const dir = (name) => ({ name, size: 0, type: 1, isDir: true, meta: null });

// `tree` maps a full device path to its entries. `failures` maps a path to how
// many times read_dir should throw before succeeding, so a test can say "this
// folder fails once" or "this folder never lists".
function fakeClient(tree, failures = {}) {
  const left = { ...failures };
  return {
    calls: [],
    async readDir(path) {
      this.calls.push(path);
      if (left[path] > 0) {
        left[path]--;
        throw new ProtocolError(`no response to cmd 22 for 15000ms`, { cmd: 22, timeout: 'idle' });
      }
      return tree[path] ?? [];
    },
  };
}

const flagged = (index) => [...index]
  .filter(([, e]) => e.unenumerated)
  .map(([p, e]) => [p, e.unenumerated]);

test('a healthy walk flags nothing at all', async () => {
  const client = fakeClient({
    'E:/amiibo': [dir('Zelda'), file('loose.bin')],
    'E:/amiibo/Zelda': [file('Link.bin')],
  });

  const index = await walkDevice(client, ROOT);

  assert.deepEqual([...index.keys()].sort(), ['Zelda', 'Zelda/Link.bin', 'loose.bin']);
  assert.equal(index.get('Zelda').isDir, true);
  assert.equal(index.get('Zelda/Link.bin').size, 540);
  // The guard keys off this flag, so a healthy device growing one would
  // silently disable deletions on every sync.
  assert.deepEqual(flagged(index), []);
  assert.ok(!('unenumerated' in index.get('Zelda')), 'flag left behind as a falsy key');
});

test('a folder that fails once is retried and comes back clean', async () => {
  const client = fakeClient({
    'E:/amiibo': [dir('Zelda')],
    'E:/amiibo/Zelda': [file('Link.bin')],
  }, { 'E:/amiibo/Zelda': 1 });

  const index = await walkDevice(client, ROOT);

  assert.deepEqual(flagged(index), []);
  assert.ok(index.has('Zelda/Link.bin'));
  assert.equal(client.calls.filter((p) => p === 'E:/amiibo/Zelda').length, 2);
});

test('a folder that fails twice is flagged, and its siblings are still walked', async () => {
  const client = fakeClient({
    'E:/amiibo': [dir('Broken'), dir('Fine'), file('top.bin')],
    'E:/amiibo/Broken': [file('hidden.bin')],
    'E:/amiibo/Fine': [file('Yoshi.bin')],
  }, { 'E:/amiibo/Broken': 2 });

  const index = await walkDevice(client, ROOT);

  assert.equal(index.get('Broken').unenumerated, UNENUMERATED.failed);
  assert.match(index.get('Broken').listError, /cmd 22/);
  // The whole point: one dead folder costs you that folder, not the scan.
  assert.ok(index.has('Fine/Yoshi.bin'), 'a sibling was lost to the failure');
  assert.ok(index.has('top.bin'));
  assert.ok(!index.has('Broken/hidden.bin'));
});

test('the root failing twice rejects rather than reporting an empty device', async () => {
  const client = fakeClient({}, { 'E:/amiibo': 2 });

  // An empty index here would read as "the device holds nothing", which turns
  // a failed scan into a silent empty backup or a full re-upload.
  await assert.rejects(() => walkDevice(client, ROOT), /cmd 22/);
});

test('a folder whose children cannot be addressed is flagged too-deep', async () => {
  // 63 bytes is the cap for a whole path. This folder fits; its children cannot.
  const deep = 'x'.repeat(63 - 'E:/amiibo/'.length - 1);
  const client = fakeClient({
    'E:/amiibo': [dir(deep)],
    [`E:/amiibo/${deep}`]: [file('unreachable.bin')],
  });

  const index = await walkDevice(client, ROOT);

  assert.equal(index.get(deep).unenumerated, UNENUMERATED.deep);
  assert.ok(!client.calls.includes(`E:/amiibo/${deep}`), 'descended into an unaddressable folder');
});

test('stopping mid-walk leaves every unfinished folder flagged', async () => {
  let seen = 0;
  const client = fakeClient({
    'E:/amiibo': [dir('A'), dir('B')],
    'E:/amiibo/A': [file('1.bin'), file('2.bin')],
    'E:/amiibo/B': [file('3.bin')],
  });

  const index = await walkDevice(client, ROOT, { shouldStop: () => ++seen > 4 });

  // Whatever the walk got through, nothing it left half-read may look empty.
  for (const [relPath, e] of index) {
    if (!e.isDir) continue;
    const hasChildren = [...index.keys()].some((p) => p.startsWith(`${relPath}/`));
    if (!hasChildren) {
      assert.ok(e.unenumerated, `${relPath} looks empty after a stop`);
    }
  }
});

test('a nested failure flags only the folder that failed', async () => {
  const client = fakeClient({
    'E:/amiibo': [dir('A')],
    'E:/amiibo/A': [dir('B'), file('a.bin')],
    'E:/amiibo/A/B': [file('b.bin')],
  }, { 'E:/amiibo/A/B': 2 });

  const index = await walkDevice(client, ROOT);

  // A listed fine, so its flag must have been cleared even though a child died.
  assert.ok(!index.get('A').unenumerated, 'the parent kept a flag it had earned removal of');
  assert.equal(index.get('A/B').unenumerated, UNENUMERATED.failed);
  assert.ok(index.has('A/a.bin'));
});

// ---- applying an organise plan on a case-insensitive folder ---------------
//
// The wild failure this pins down: an organise planned "splatoon/X.bin ->
// Splatoon/X.bin" as a real move, the copy opened the source file itself, and
// the delete destroyed the only copy — then the folder, now genuinely empty,
// was swept. Whatever the browser offers, the run must end with the dump still
// existing, and a folder that was not really emptied must fail its rmdir
// loudly instead of vanishing.
test('an organise move that only changes case never loses the file', async () => {
  for (const nativeMove of [false, true]) {
    const root = memRoot({
      caseInsensitive: true,
      nativeMove,
      seed: { 'splatoon/Inkling.bin': new Uint8Array(540).fill(7) },
    });

    const result = await applyPlan({
      client: {},
      rootHandle: root,
      deviceRoot: 'E:/amiibo',
      state: { version: 1, entries: {} },
      ops: [
        { op: 'moveLocal', from: 'splatoon/Inkling.bin', to: 'Splatoon/Inkling.bin' },
        { op: 'rmdirLocal', relPath: 'splatoon' },
      ],
    });

    const tree = await listTree(root);
    const survivors = Object.entries(tree).filter(([p, v]) => v === 540);
    assert.equal(survivors.length, 1, `the dump survived (nativeMove: ${nativeMove})`);
    // The folder still holds the file on this filesystem, so its rmdir must
    // fail loudly rather than the plan pretending the sweep was clean.
    assert.equal(result.failed, 1, `rmdir failed loudly (nativeMove: ${nativeMove})`);
    assert.equal(tree.splatoon, 'dir');
  }
});

test('a download that fails once is retried and the file is not lost from the run', async () => {
  let readAttempts = 0;
  const client = {
    async readFile() {
      if (++readAttempts === 1) throw new Error('GATT operation already in progress.');
      return new Uint8Array(540).fill(9);
    },
  };
  const root = memRoot();

  const result = await applyPlan({
    client,
    rootHandle: root,
    deviceRoot: 'E:/amiibo',
    state: { version: 1, entries: {} },
    ops: [{ op: 'download', relPath: 'Zelda/Link.bin', size: 540 }],
  });

  assert.equal(readAttempts, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.log[0].ok, true);
  assert.equal((await listTree(root))['Zelda/Link.bin'], 540);
});

test('an upload that fails once is retried too', async () => {
  let writeAttempts = 0;
  const client = {
    async writeFile() {
      if (++writeAttempts === 1) throw new Error('GATT operation already in progress.');
    },
  };
  const root = memRoot({ seed: { 'Zelda/Link.bin': new Uint8Array(540).fill(9) } });

  const result = await applyPlan({
    client,
    rootHandle: root,
    deviceRoot: 'E:/amiibo',
    state: { version: 1, entries: {} },
    ops: [{ op: 'upload', relPath: 'Zelda/Link.bin', size: 540 }],
  });

  assert.equal(writeAttempts, 2);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
});

// ---- the tester's organise, end to end ------------------------------------
//
// Real planner, real executor, fake disk. A library whose series folders
// differ from canonical only by letter case (the tester's Splatoon/Skylanders/
// Fire Emblem/HHD folders), plus one genuinely misplaced dump. Whatever the
// browser offers for moving files, the invariant is absolute: organise never
// ends with fewer dumps than it started with.
test('a full organise of a case-mangled library never loses a dump', async () => {
  const { planOrganise, flattenPlan, amiiboRelPath } = await import('../web/js/planner.js');
  const MARIO = '0000000000000002';
  const LINK = '0100000000040002';
  const marioPath = amiiboRelPath(MARIO, { deviceRoot: 'E:/amiibo' }); // canonical
  const linkPath = amiiboRelPath(LINK, { deviceRoot: 'E:/amiibo' });
  // The same path with its series folder lower-cased: distinct string, same
  // folder on the tester's disk.
  const [marioDir, marioName] = [marioPath.slice(0, marioPath.lastIndexOf('/')), marioPath.split('/').pop()];
  const mangled = `${marioDir.toLowerCase()}/${marioName}`;
  assert.notEqual(mangled, marioPath, 'the canonical path must be case-distinct for this test');

  for (const nativeMove of [false, true]) {
    const root = memRoot({
      caseInsensitive: true,
      nativeMove,
      seed: {
        [mangled]: new Uint8Array(540).fill(1),
        'loose.bin': new Uint8Array(540).fill(2),
      },
    });

    const index = new Map([
      [marioDir.toLowerCase(), { size: 0, isDir: true }],
      [mangled, { size: 540, isDir: false, amiiboId: MARIO }],
      ['loose.bin', { size: 540, isDir: false, amiiboId: LINK }],
    ]);
    const plan = planOrganise({ index, side: 'local', walkRoot: 'E:/amiibo' });
    assert.equal(plan.moveLocal.length, 2, 'both dumps planned as moves');

    const result = await applyPlan({
      client: {},
      rootHandle: root,
      deviceRoot: 'E:/amiibo',
      state: { version: 1, entries: {} },
      ops: flattenPlan(plan),
    });

    const tree = await listTree(root);
    const dumps = Object.values(tree).filter((v) => v === 540);
    assert.equal(dumps.length, 2, `a dump vanished (nativeMove: ${nativeMove})`);
    // On this disk the folder keeps its original (lowercase) on-disk name, so
    // the filed path is compared the way the filesystem itself would.
    const filed = Object.entries(tree)
      .find(([p, v]) => v === 540 && p.toLowerCase() === linkPath.toLowerCase());
    assert.ok(filed, `the misplaced dump was filed (nativeMove: ${nativeMove})`);
    // The case-mangled folder was not really emptied, so its sweep must fail
    // loudly rather than the run reporting a clean tidy-up.
    assert.ok(result.failed >= 1, `the folder sweep failed loudly (nativeMove: ${nativeMove})`);
  }
});
