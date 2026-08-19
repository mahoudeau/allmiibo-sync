// moveLocalFile against in-memory filesystem handles: node --test test/
//
// The behaviour under test is the one that destroyed files in the wild. The
// filesystems Chrome runs on are case-insensitive, so a move that only fixes
// letter case ("splatoon/" to "Splatoon/") opens the source file as its own
// destination — and the copy-and-delete idiom then deletes the only copy.
// The mover must either really rename (native move()) or leave the file
// alone; it must never end a move with the bytes gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  moveLocalFile,
  readLocalFile,
  writeLocalFile,
  removeLocalDir,
} from '../web/js/localfs.js';
import { memRoot, listTree } from './helpers/fshandles.mjs';

const DUMP = new Uint8Array(540).fill(7);

test('a case-only folder move without native move() leaves the file intact', async () => {
  const root = memRoot({ caseInsensitive: true, seed: { 'splatoon/Inkling.bin': DUMP } });

  await moveLocalFile(root, 'splatoon/Inkling.bin', 'Splatoon/Inkling.bin');

  // No native rename exists, so the safe outcome is "unchanged", not "gone".
  const bytes = await readLocalFile(root, 'splatoon/Inkling.bin');
  assert.equal(bytes.length, 540, 'the dump survived');
  assert.deepEqual(await listTree(root), { splatoon: 'dir', 'splatoon/Inkling.bin': 540 });
});

test('a case-only filename move without native move() leaves the file intact', async () => {
  const root = memRoot({ caseInsensitive: true, seed: { 'Zelda/link.bin': DUMP } });

  await moveLocalFile(root, 'Zelda/link.bin', 'Zelda/Link.bin');

  const bytes = await readLocalFile(root, 'Zelda/link.bin');
  assert.equal(bytes.length, 540);
});

test('with native move() a case-only move really renames', async () => {
  const root = memRoot({
    caseInsensitive: true,
    nativeMove: true,
    seed: { 'splatoon/Inkling.bin': DUMP },
  });

  await moveLocalFile(root, 'splatoon/Inkling.bin', 'Splatoon/Inkling.bin');

  const tree = await listTree(root);
  // The folder keeps its on-disk identity (a dir rename is the sweep's job),
  // but the file now lives under its canonical name and nothing was lost.
  assert.equal(tree['splatoon/Inkling.bin'], 540);
  const bytes = await readLocalFile(root, 'Splatoon/Inkling.bin');
  assert.equal(bytes.length, 540);
});

test('an ordinary cross-folder move still moves, both with and without move()', async () => {
  for (const nativeMove of [false, true]) {
    const root = memRoot({ nativeMove, seed: { 'loose/Link.bin': DUMP } });

    await moveLocalFile(root, 'loose/Link.bin', 'Zelda/Link.bin');

    const tree = await listTree(root);
    assert.equal(tree['Zelda/Link.bin'], 540, `moved (nativeMove: ${nativeMove})`);
    assert.ok(!('loose/Link.bin' in tree), `source gone (nativeMove: ${nativeMove})`);
  }
});

test('a same-name copy in a case-sensitive tree is still a real move', async () => {
  // Two distinct folders that only look alike on a case-insensitive disk.
  const root = memRoot({ seed: { 'splatoon/Inkling.bin': DUMP } });

  await moveLocalFile(root, 'splatoon/Inkling.bin', 'Splatoon/Inkling.bin');

  const tree = await listTree(root);
  assert.equal(tree['Splatoon/Inkling.bin'], 540);
  assert.ok(!('splatoon/Inkling.bin' in tree));
});

test('removeLocalDir refuses a folder that still holds anything', async () => {
  const root = memRoot({ caseInsensitive: true, seed: { 'splatoon/Inkling.bin': DUMP } });

  await assert.rejects(() => removeLocalDir(root, 'splatoon'));
  assert.equal((await readLocalFile(root, 'splatoon/Inkling.bin')).length, 540);
});

test('writeLocalFile then readLocalFile round-trips through nested folders', async () => {
  const root = memRoot();

  await writeLocalFile(root, 'a/b/c.bin', DUMP);

  assert.deepEqual(await readLocalFile(root, 'a/b/c.bin'), DUMP);
});
