// walkDevice against a simulated device: node --test test/
//
// The behaviour under test is one rule with teeth. A directory that was never
// enumerated must be distinguishable from an empty one, because remove() is
// recursive on the firmware (PROTOCOL.md §9.4) — a planner that reads "no
// children" as "safe to remove" erases a subtree nobody has seen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkDevice, UNENUMERATED } from '../web/js/sync.js';
import { ProtocolError } from '../web/js/protocol.js';

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
