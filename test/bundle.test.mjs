// All-in-one bundle tests.
//
// The format was reverse engineered from two real bundles, but amiibos/ is not
// committed, so everything here is asserted against synthetic bundles built to
// the same spec. The real samples are checked only if they happen to be present
// — see the guarded block at the bottom, which pins the exact numbers measured
// from them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  detectBundle,
  splitBundle,
  packBundle,
  normalizeDump,
  isLossyInBundle,
  BUNDLE_RECORD_SIZE,
  BUNDLE_DUMP_SIZE,
} from '../web/js/bundle.js';
import { expandBundles, ownedKey } from '../web/js/bundlesource.js';
import { amiiboRelPath } from '../web/js/planner.js';
import { AMIIBO_ID_OFFSET, HHD_ID } from '../web/js/amiibo.js';
import { AMIIBO_NAMES } from '../web/data/amiibo-db.js';

const ROOT = 'E:/amiibo';

// Real IDs, so the database lookups detection depends on actually resolve.
const MARIO = '0000000000000002';
const LINK = '0000000003710102';
const KIRBY_AR = '1f00000004c41e03';

// A dump that passes every structural check a real one does: NTAG215 header,
// valid BCC bytes, amiibo magic and capability container.
function dump(idHex, { uid = [0x04, 0xbb, 0xb5, 0xe8, 0x39, 0x4d, 0xf7], size = 540 } = {}) {
  const u = new Uint8Array(size);
  u[0] = uid[0]; u[1] = uid[1]; u[2] = uid[2];
  u[3] = 0x88 ^ uid[0] ^ uid[1] ^ uid[2]; // BCC0
  u[4] = uid[3]; u[5] = uid[4]; u[6] = uid[5]; u[7] = uid[6];
  u[8] = uid[3] ^ uid[4] ^ uid[5] ^ uid[6]; // BCC1
  u[9] = 0x48; // internal
  u[0x0a] = 0x0f; u[0x0b] = 0xe0; // static lock
  u.set([0xf1, 0x10, 0xff, 0xee], 0x0c); // capability container
  u[0x10] = 0xa5; // amiibo magic
  u.set(Uint8Array.from(idHex.match(/../g).map((h) => parseInt(h, 16))), AMIIBO_ID_OFFSET);
  return u;
}

const uidFor = (n) => [0x04, n, 0xb5, 0xe8, 0x39, 0x4d, n];

function bundle(specs) {
  return packBundle(specs.map(({ id, n = 1 }) => dump(id, { uid: uidFor(n) })));
}

// ---- detection ----------------------------------------------------------

test('a run of 572-byte records is a bundle', () => {
  const b = bundle([{ id: MARIO, n: 1 }, { id: LINK, n: 2 }, { id: KIRBY_AR, n: 3 }]);
  assert.equal(b.length, 3 * BUNDLE_RECORD_SIZE);
  assert.deepEqual(detectBundle(b), { recordSize: 572, count: 3, known: 3 });
});

test('the 32 bytes after each dump are 0xFF, as in every real record', () => {
  const b = bundle([{ id: MARIO }, { id: LINK, n: 2 }]);
  for (const start of [BUNDLE_DUMP_SIZE, BUNDLE_RECORD_SIZE + BUNDLE_DUMP_SIZE]) {
    const pad = b.subarray(start, start + 32);
    assert.ok(pad.every((x) => x === 0xff), `padding at ${start}`);
  }
});

test('a single dump is a dump, not a one-record bundle', () => {
  // 572 is a dump size the firmware recognises, so this is the case that would
  // turn one amiibo into a phantom library if detection were loose.
  assert.equal(detectBundle(packBundle([dump(MARIO)])), null);
  assert.equal(detectBundle(dump(MARIO)), null);
  assert.equal(detectBundle(dump(MARIO, { size: 2048 })), null);
});

test('a length that is not a whole number of records is not a bundle', () => {
  const b = bundle([{ id: MARIO }, { id: LINK, n: 2 }]);
  assert.equal(detectBundle(b.subarray(0, b.length - 1)), null);
  assert.equal(detectBundle(new Uint8Array(0)), null);
});

test('right length but wrong contents is not a bundle', () => {
  // Zeros, 0xFF and noise all divide evenly by 572 and must still be rejected:
  // the structural checks, not the length, are what decide.
  const zeros = new Uint8Array(3 * BUNDLE_RECORD_SIZE);
  assert.equal(detectBundle(zeros), null);
  assert.equal(detectBundle(new Uint8Array(3 * BUNDLE_RECORD_SIZE).fill(0xff)), null);

  const noise = new Uint8Array(3 * BUNDLE_RECORD_SIZE);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) & 0xff;
  assert.equal(detectBundle(noise), null);
});

test('one corrupt record rejects the whole file', () => {
  const b = bundle([{ id: MARIO }, { id: LINK, n: 2 }, { id: KIRBY_AR, n: 3 }]);
  b[BUNDLE_RECORD_SIZE + 0x10] = 0x00; // clear the second record's magic
  assert.equal(detectBundle(b), null);
});

test('records naming no known amiibo are rejected', () => {
  // Structurally perfect, but the IDs mean nothing — below the 90% threshold.
  const b = bundle([{ id: 'aaaa0000aaaa0002' }, { id: 'bbbb0000bbbb0002', n: 2 }]);
  assert.equal(detectBundle(b), null);
});

// ---- splitting and packing ---------------------------------------------

test('splitting yields plain 540-byte dumps with their IDs', () => {
  const recs = splitBundle(bundle([{ id: MARIO }, { id: LINK, n: 2 }]));
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.amiiboId), [MARIO, LINK]);
  assert.deepEqual(recs.map((r) => r.dump.length), [540, 540]);
  assert.deepEqual(recs.map((r) => r.offset), [0, BUNDLE_RECORD_SIZE]);
});

test('pack and split round-trip byte for byte', () => {
  const dumps = [dump(MARIO, { uid: uidFor(1) }), dump(LINK, { uid: uidFor(2) })];
  const recs = splitBundle(packBundle(dumps));
  for (const [i, r] of recs.entries()) assert.deepEqual([...r.dump], [...dumps[i]]);
});

test('a split dump does not keep the whole bundle alive', () => {
  // Copied rather than a view: a 540-byte subarray of a 539 kB file would pin
  // all of it in memory.
  const b = bundle([{ id: MARIO }, { id: LINK, n: 2 }]);
  const { dump: d } = splitBundle(b)[0];
  assert.equal(d.buffer.byteLength, 540);
});

test('a 532-byte dump is zero-extended, exactly as the real bundles did', () => {
  const short = dump(MARIO).subarray(0, 532);
  const norm = normalizeDump(short);
  assert.equal(norm.length, BUNDLE_DUMP_SIZE);
  assert.deepEqual([...norm.subarray(532)], [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('a 2048-byte dump is truncated, and says so', () => {
  assert.equal(normalizeDump(dump(KIRBY_AR, { size: 2048 })).length, BUNDLE_DUMP_SIZE);
  assert.equal(isLossyInBundle(2048), true);
  assert.equal(isLossyInBundle(540), false);
  assert.equal(isLossyInBundle(572), false);
});

test('a length that is not a dump is not packed', () => {
  assert.equal(normalizeDump(new Uint8Array(100)), null);
  assert.equal(packBundle([new Uint8Array(100)]).length, 0);
});

// ---- choosing a path ---------------------------------------------------

test('every amiibo in the database gets a unique path that fits the device', () => {
  for (const root of [ROOT, 'E:/amiibo/library', 'E:/a']) {
    const seen = new Map();
    for (const id of Object.keys(AMIIBO_NAMES)) {
      const p = amiiboRelPath(id, { deviceRoot: root });
      assert.ok(p, `${id} has no path under ${root}`);
      assert.equal(seen.get(p), undefined, `${p} claimed by ${seen.get(p)} and ${id}`);
      seen.set(p, id);
      const full = `${root}/${p}`;
      assert.ok(Buffer.byteLength(full) <= 63, `${full} is over the path limit`);
      assert.ok(Buffer.byteLength(p.split('/').pop()) <= 47, `${p} is over the name limit`);
    }
  }
});

test('names the database cannot make unique are disambiguated, not counted', () => {
  // Figure type, character variant and model number — the three real reasons
  // two amiibos share a display name.
  assert.equal(amiiboRelPath('34c2000104cd1d02', { deviceRoot: ROOT }), 'Street Fighter 6/Luke (Card).bin');
  assert.equal(amiiboRelPath('34c2000004aa1d02', { deviceRoot: ROOT }), 'Street Fighter 6/Luke.bin');
  assert.equal(amiiboRelPath('35090100042b1802', { deviceRoot: ROOT }), 'Monster Hunter Rise/Palico v2.bin');
  assert.equal(amiiboRelPath('3c80000104e81d02', { deviceRoot: ROOT }), 'Street Fighter 6/Terry 04e8.bin');
  assert.equal(amiiboRelPath('3c80000104f11d02', { deviceRoot: ROOT }), 'Street Fighter 6/Terry 04f1.bin');
});

test('a long series label falls back to its initialism only when it has to', () => {
  // "Mario Sports Superstars/Pink Gold Peach - Horse Racing.bin" is 68 bytes
  // under "E:/amiibo" — the longest path in the database, and 5 over the limit.
  const pgp = Object.keys(AMIIBO_NAMES).find(
    (id) => AMIIBO_NAMES[id] === 'Pink Gold Peach - Horse Racing'
  );
  assert.ok(pgp, 'the long MSS name is still in the database');
  assert.equal(amiiboRelPath(pgp, { deviceRoot: 'E:/' }), 'Mario Sports Superstars/Pink Gold Peach - Horse Racing.bin');
  assert.equal(amiiboRelPath(pgp, { deviceRoot: 'E:/amiibo' }), 'MSS/Pink Gold Peach - Horse Racing.bin');
  // Deeper still, and the abbreviated name earns its keep.
  assert.equal(amiiboRelPath(pgp, { deviceRoot: 'E:/amiibo/deep/deeper/deepest' }), 'MSS/Pink Gold Peach - HR.bin');
});

test('an unknown amiibo still gets somewhere to go', () => {
  assert.equal(amiiboRelPath('deadbeefdeadbeef', { deviceRoot: ROOT }), 'Unknown/deadbeefdeadbeef.bin');
});

test('a name is measured in bytes, not characters', () => {
  // "Tatsuhisa “Luke” Kamijō" is 23 characters and 29 bytes.
  const id = Object.keys(AMIIBO_NAMES).find((k) => /Kamij/.test(AMIIBO_NAMES[k]));
  const p = amiiboRelPath(id, { deviceRoot: ROOT });
  assert.ok(Buffer.byteLength(`${ROOT}/${p}`) <= 63);
});

// ---- expanding into the local index ------------------------------------

const entry = (extra) => ({ size: 540, isDir: false, hash: null, ...extra });

function localIndex(files) {
  return new Map(Object.entries(files));
}

async function expand(files, { device = null, deviceRoot = ROOT } = {}) {
  const bytes = new Map(Object.entries(files).map(([p, e]) => [p, e.bytes]));
  return expandBundles({
    index: localIndex(Object.fromEntries(
      Object.entries(files).map(([p, e]) => [p, entry({ ...e, bytes: undefined })])
    )),
    read: async (p) => bytes.get(p),
    deviceRoot,
    device,
  });
}

test('a folder with no bundle is left completely alone', async () => {
  const r = await expand({ 'Mario.bin': { amiiboId: MARIO } });
  assert.equal(r.virtual.size, 0);
  assert.deepEqual(r.excludes, []);
  assert.deepEqual(r.report.bundles, []);
});

test('a bundle is excluded and its amiibos take its place', async () => {
  const bytes = bundle([{ id: MARIO, n: 1 }, { id: LINK, n: 2 }]);
  const r = await expand({
    'all-in-one.bin': { size: bytes.length, bundle: { recordSize: 572, count: 2 }, bytes },
  });
  assert.deepEqual(r.excludes, ['all-in-one.bin'], 'the container never goes to the device');
  assert.equal(r.virtual.size, 2);
  assert.deepEqual([...r.virtual.keys()].sort(), ['Super Mario Bros/Mario - Wedding.bin', 'Super Smash Bros/Mario.bin']);
  for (const [p, e] of r.virtual) {
    assert.equal(e.virtual, true, `${p} is marked virtual`);
    assert.equal(e.fromBundle, 'all-in-one.bin');
    assert.equal(r.sources.get(p).length, 540);
  }
  assert.equal(r.report.bundles[0].added, 2);
});

test('duplicate records inside a bundle collapse', async () => {
  // The real air-riders sample held six records for four amiibos, two of them
  // byte-identical.
  const dumps = [
    dump(KIRBY_AR, { uid: uidFor(1) }),
    dump(KIRBY_AR, { uid: uidFor(1) }), // byte-identical
    dump(KIRBY_AR, { uid: uidFor(2) }), // same amiibo, different tag
    dump(MARIO, { uid: uidFor(3) }),
  ];
  const bytes = packBundle(dumps);
  const r = await expand({
    'ar.bin': { size: bytes.length, bundle: { recordSize: 572, count: 4 }, bytes },
  });
  assert.equal(r.report.bundles[0].count, 4);
  assert.equal(r.report.bundles[0].unique, 2, 'four records, two amiibos');
  assert.equal(r.report.bundles[0].duplicates, 2);
  assert.equal(r.virtual.size, 2);
});

test('an amiibo already in the folder is not offered again', async () => {
  const bytes = bundle([{ id: MARIO, n: 1 }, { id: LINK, n: 2 }]);
  const r = await expand({
    'mine/Mario.bin': { amiiboId: MARIO },
    'all-in-one.bin': { size: bytes.length, bundle: { recordSize: 572, count: 2 }, bytes },
  });
  assert.equal(r.virtual.size, 1);
  assert.equal(r.report.bundles[0].haveLocally, 1);
  assert.equal(r.report.bundles[0].added, 1);
  assert.ok(![...r.virtual.values()].some((e) => e.amiiboId === MARIO));
});

test('an amiibo already on the device is not sent again', async () => {
  // The case identity sync cannot catch on its own: the device's copy is a
  // different physical tag, so its content hash differs and the planner would
  // read the bundle's copy as a new item.
  const bytes = bundle([{ id: MARIO, n: 1 }, { id: LINK, n: 2 }]);
  const device = new Map([['whatever/m.bin', entry({ amiiboId: MARIO, hash: 'other-tag' })]]);
  const r = await expand(
    { 'all-in-one.bin': { size: bytes.length, bundle: { recordSize: 572, count: 2 }, bytes } },
    { device }
  );
  assert.equal(r.report.bundles[0].onDevice, 1);
  assert.equal(r.virtual.size, 1);
  assert.equal(r.report.deviceIdentified, true);
});

test('a device index with no identities admits it rather than implying a check', async () => {
  const bytes = bundle([{ id: MARIO, n: 1 }].concat([{ id: LINK, n: 2 }]));
  const device = new Map([['m.bin', entry({ size: 540 })]]); // walked, never read
  const r = await expand(
    { 'all-in-one.bin': { size: bytes.length, bundle: { recordSize: 572, count: 2 }, bytes } },
    { device }
  );
  assert.equal(r.report.deviceIdentified, false);
  assert.equal(r.virtual.size, 2);
});

test('the Happy Home Designer cards are kept apart by UID, not collapsed', async () => {
  // All 91 share one fabricated ID. Keying on the ID alone would drop 90 of
  // them the moment the device held any one.
  const dumps = [0, 1, 2].map((i) => dump(HHD_ID, { uid: uidFor(0x10 + i) }));
  const bytes = packBundle(dumps);
  const r = await expand({
    'hhd.bin': { size: bytes.length, bundle: { recordSize: 572, count: 3 }, bytes },
  });
  assert.equal(r.report.bundles[0].unique, 3);
  assert.equal(r.virtual.size, 3, 'three cards, three paths');
  // Named by UID, since the shared ID cannot tell them apart.
  assert.deepEqual([...r.virtual.keys()].sort(), [
    'AC/HHD 0410b5e8394d10.bin',
    'AC/HHD 0411b5e8394d11.bin',
    'AC/HHD 0412b5e8394d12.bin',
  ]);
  assert.notEqual(ownedKey(HHD_ID, 'aaa'), ownedKey(HHD_ID, 'bbb'));
  assert.equal(ownedKey(MARIO, 'aaa'), ownedKey(MARIO, 'bbb'));
});

test('a path already used by a real file is not stolen', async () => {
  const bytes = bundle([{ id: MARIO, n: 1 }, { id: LINK, n: 2 }]);
  const r = await expand({
    // Occupies exactly the path Mario would be given, but is not Mario.
    'Super Smash Bros/Mario.bin': { amiiboId: LINK },
    'all-in-one.bin': { size: bytes.length, bundle: { recordSize: 572, count: 2 }, bytes },
  });
  assert.equal(r.virtual.has('Super Smash Bros/Mario.bin'), false);
  assert.equal(r.report.bundles[0].blocked.length, 1);
  assert.match(r.report.bundles[0].blocked[0].reason, /already taken/);
});

test('two bundles offering the same amiibo transfer it once', async () => {
  const a = bundle([{ id: MARIO, n: 1 }, { id: LINK, n: 2 }]);
  const b = bundle([{ id: MARIO, n: 3 }, { id: KIRBY_AR, n: 4 }]);
  const r = await expand({
    'a.bin': { size: a.length, bundle: { recordSize: 572, count: 2 }, bytes: a },
    'b.bin': { size: b.length, bundle: { recordSize: 572, count: 2 }, bytes: b },
  });
  assert.equal(r.virtual.size, 3, 'Mario once, not twice');
  // Not "already in your folder" — it is coming, just from the other bundle.
  assert.equal(r.report.bundles[1].haveLocally, 0);
  assert.equal(r.report.bundles[1].duplicates, 1);
});

test('a bundle that cannot be read is reported, not thrown', async () => {
  const r = await expandBundles({
    index: localIndex({ 'bad.bin': entry({ bundle: { recordSize: 572, count: 2 } }) }),
    read: async () => { throw new Error('device is asleep'); },
    deviceRoot: ROOT,
  });
  assert.equal(r.report.bundles[0].error, 'device is asleep');
  assert.equal(r.virtual.size, 0);
});

// ---- the real samples, when they are there ------------------------------

const samples = fileURLToPath(new URL('../amiibos/all-in-one/', import.meta.url));
const sample = (name) => `${samples}${name}`;

test('the 943-amiibo sample reads as measured', { skip: !existsSync(sample('Ally all in one 942.bin')) }, () => {
  const bytes = new Uint8Array(readFileSync(sample('Ally all in one 942.bin')));
  const found = detectBundle(bytes);
  assert.equal(found.recordSize, 572);
  assert.equal(found.count, 943);
  assert.equal(found.known, 943, 'every record names an amiibo the database knows');

  const recs = splitBundle(bytes, { recordSize: 572 });
  assert.equal(new Set(recs.map((r) => r.amiiboId)).size, 943, 'no duplicate IDs');
  assert.equal(new Set(recs.map((r) => r.uid)).size, 943, 'every record a distinct tag');

  const ids = new Set(recs.map((r) => r.amiiboId));
  const missing = Object.keys(AMIIBO_NAMES).filter((id) => !ids.has(id));
  assert.equal(missing.length, 3, 'predates the last three Air Riders characters');
});

test('the air-riders sample holds six records for four amiibos', { skip: !existsSync(sample('all in one air riders.bin')) }, () => {
  const bytes = new Uint8Array(readFileSync(sample('all in one air riders.bin')));
  assert.deepEqual(detectBundle(bytes), { recordSize: 572, count: 6, known: 6 });

  const recs = splitBundle(bytes, { recordSize: 572 });
  assert.equal(new Set(recs.map((r) => r.amiiboId)).size, 4);
  assert.equal(new Set(recs.map((r) => r.uid)).size, 5);
  assert.deepEqual([...recs[0].dump], [...recs[1].dump], 'records 0 and 1 are identical');
});
