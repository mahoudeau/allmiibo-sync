// FCA container tests.
//
// FCA is the second all-in-one format, read only. Written against the published
// specification (https://github.com/fishybow/fca/blob/main/SPEC.md) rather than
// against a real archive, so the builder below IS the spec: if these pass and a
// real file still fails, the builder is what to check first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { detectFca, splitFca, FCA_TYPES } from '../web/js/fca.js';
import { expandBundles } from '../web/js/bundlesource.js';
import { AMIIBO_ID_OFFSET, VEHICLE_CODE_OFFSET, VEHICLE_FLAG_OFFSET, seriesFolder } from '../web/js/amiibo.js';
import { sanitizeLocalName } from '../web/js/devicepath.js';

// The device folder an amiibo lands in, derived rather than written out: a
// series name is curated and can be renamed, which changes the path — so the
// expectation has to come from the same table the code reads.
const dir = (id) => sanitizeLocalName(seriesFolder(parseInt(id.slice(12, 14), 16)));

const ROOT = 'E:/amiibo';
const MARIO = '0000000000000002';
const LINK = '0000000003710102';
const KIRBY_AR = '1f00000004c41e03';

function dump(idHex, { uid = [0x04, 0xbb, 0xb5, 0xe8, 0x39, 0x4d, 0xf7], size = 540 } = {}) {
  const u = new Uint8Array(size);
  u[0] = uid[0]; u[1] = uid[1]; u[2] = uid[2];
  u[3] = 0x88 ^ uid[0] ^ uid[1] ^ uid[2];
  u[4] = uid[3]; u[5] = uid[4]; u[6] = uid[5]; u[7] = uid[6];
  u[8] = uid[3] ^ uid[4] ^ uid[5] ^ uid[6];
  u[9] = 0x48;
  u[0x0a] = 0x0f; u[0x0b] = 0xe0;
  u.set([0xf1, 0x10, 0xff, 0xee], 0x0c);
  u[0x10] = 0xa5;
  u.set(Uint8Array.from(idHex.match(/../g).map((h) => parseInt(h, 16))), AMIIBO_ID_OFFSET);
  return u;
}

const uidFor = (n) => [0x04, n, 0xb5, 0xe8, 0x39, 0x4d, n];

// A v3 dump: 2048 bytes with a vehicle signature, which is the whole point of
// FCA next to the flat format.
function v3(idHex, code, flag, n) {
  const u = dump(idHex, { uid: uidFor(n), size: 2048 });
  for (const [i, ch] of [...code].entries()) u[VEHICLE_CODE_OFFSET + i] = ch.charCodeAt(0);
  u[VEHICLE_CODE_OFFSET + code.length] = 0x3a; // ':'
  u[VEHICLE_FLAG_OFFSET] = flag;
  return u;
}

const VEHICLES = [
  ['PB4W17', 0x02, 'Warp Star'],
  ['PB4W17', 0x04, 'Winged Star'],
  ['PB5T42', 0x04, 'Shadow Star'],
  ['PC6V28', 0x04, 'Tank Star'],
];

/**
 * Build an archive exactly as the specification lays it out:
 *   "FCA" + version, then per entry a 4-byte total size, a 2-byte header size,
 *   the header, and the payload. Total size counts everything after itself.
 */
function fca(entries, { version = 1, headerSize = 2 } = {}) {
  const parts = [Uint8Array.from([0x46, 0x43, 0x41, version])];
  for (const { type, bytes } of entries) {
    const total = 2 + headerSize + bytes.length;
    const prefix = new Uint8Array(6 + headerSize);
    new DataView(prefix.buffer).setUint32(0, total, false); // big-endian
    new DataView(prefix.buffer).setUint16(4, headerSize, false);
    if (headerSize >= 1) prefix[6] = type;
    if (headerSize >= 2) prefix[7] = 0; // reserved
    parts.push(prefix, bytes);
  }
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---- detection ----------------------------------------------------------

test('an archive of amiibo entries is recognised', () => {
  const a = fca([
    { type: 1, bytes: dump(MARIO, { uid: uidFor(1) }) },
    { type: 1, bytes: dump(LINK, { uid: uidFor(2) }) },
  ]);
  assert.deepEqual(detectFca(a), { version: 1, count: 2, amiibos: 2 });
});

test('the entries must tile the file exactly', () => {
  const a = fca([{ type: 1, bytes: dump(MARIO) }, { type: 1, bytes: dump(LINK, { uid: uidFor(2) }) }]);
  // A trailing byte means the last entry does not end where the file does.
  assert.equal(detectFca(new Uint8Array([...a, 0x00])), null);
  // A truncated file runs an entry past the end.
  assert.equal(detectFca(a.subarray(0, a.length - 4)), null);
});

test('something that merely starts with FCA is not an archive', () => {
  const fake = new Uint8Array(600);
  fake.set([0x46, 0x43, 0x41, 0x01]);
  assert.equal(detectFca(fake), null);
});

test('a flat bundle is not mistaken for an archive, nor the reverse', () => {
  const flat = new Uint8Array(2 * 572);
  flat.set(dump(MARIO), 0);
  flat.set(dump(LINK, { uid: uidFor(2) }), 572);
  assert.equal(detectFca(flat), null);
  assert.equal(detectFca(new Uint8Array(0)), null);
  assert.equal(detectFca(dump(MARIO)), null);
});

test('an archive holding no amiibo is left alone', () => {
  // Parses perfectly. Still none of this app's business.
  const a = fca([{ type: 3, bytes: new Uint8Array(1024) }]);
  assert.equal(detectFca(a), null);
});

test('an empty archive is legal but is not a library', () => {
  assert.equal(detectFca(fca([])), null);
});

// ---- reading ------------------------------------------------------------

test('amiibo entries come out with their IDs', () => {
  const a = fca([
    { type: 1, bytes: dump(MARIO, { uid: uidFor(1) }) },
    { type: 1, bytes: dump(LINK, { uid: uidFor(2) }) },
  ]);
  const { records, skipped, version } = splitFca(a);
  assert.equal(version, 1);
  assert.deepEqual(skipped, []);
  assert.deepEqual(records.map((r) => r.amiiboId), [MARIO, LINK]);
  assert.deepEqual(records.map((r) => r.dump.length), [540, 540]);
});

test('non-amiibo entries are reported, not silently dropped', () => {
  const a = fca([
    { type: 1, bytes: dump(MARIO, { uid: uidFor(1) }) },
    { type: 3, bytes: new Uint8Array(1024) },
    { type: 5, bytes: new Uint8Array(64) },
  ]);
  const { records, skipped } = splitFca(a);
  assert.equal(records.length, 1);
  assert.deepEqual(skipped.map((s) => s.reason), [
    `${FCA_TYPES[3]} is not an amiibo`,
    `${FCA_TYPES[5]} is not an amiibo`,
  ]);
});

test('a type-0 entry is opened, and kept only if it really is a dump', () => {
  // The spec calls 0 "unknown or unspecified" and notes that a default
  // implementation writes 0x00, so a lax packer can label a real dump this way.
  // Real archives use it for a README instead, which the length check rejects.
  const readme = new TextEncoder().encode('When you make a amiibo Card...');
  const a = fca([
    { type: 0, bytes: dump(MARIO, { uid: uidFor(1) }) },
    { type: 0, bytes: readme },
  ]);
  const { records, skipped } = splitFca(a);
  assert.deepEqual(records.map((r) => r.amiiboId), [MARIO], 'the dump is read');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /Unknown, \d+ bytes, is not a readable dump/);
});

test('a v3 entry keeps its whole dump and its vehicle', () => {
  // The reason FCA is worth reading: a 572-byte record cannot carry this.
  const a = fca(VEHICLES.map(([code, flag], i) =>
    ({ type: 2, bytes: v3(KIRBY_AR, code, flag, 10 + i) })));
  const { records } = splitFca(a);
  assert.equal(records.length, 4);
  assert.deepEqual(records.map((r) => r.dump.length), [2048, 2048, 2048, 2048]);
  assert.deepEqual(records.map((r) => r.vehicle), VEHICLES.map(([, , name]) => name));
});

test('a dump is copied out, not left as a view on the archive', () => {
  const a = fca([{ type: 1, bytes: dump(MARIO) }, { type: 1, bytes: dump(LINK, { uid: uidFor(2) }) }]);
  assert.equal(splitFca(a).records[0].dump.buffer.byteLength, 540);
});

// ---- unpacking into the collection --------------------------------------

const entry = (extra) => ({ size: 540, isDir: false, hash: null, ...extra });

async function expand(name, bytes, opts = {}) {
  const index = new Map([[name, entry({
    size: bytes.length,
    bundle: { kind: 'fca', count: detectFca(bytes)?.count ?? 0 },
  })]]);
  return expandBundles({ index, read: async () => bytes, deviceRoot: ROOT, ...opts });
}

test('an archive unpacks into the collection like a flat bundle', async () => {
  const bytes = fca([
    { type: 1, bytes: dump(MARIO, { uid: uidFor(1) }) },
    { type: 1, bytes: dump(LINK, { uid: uidFor(2) }) },
  ]);
  const r = await expand('library.fca', bytes);
  assert.deepEqual(r.excludes, ['library.fca'], 'the container is never sent');
  assert.equal(r.virtual.size, 2);
  assert.equal(r.report.bundles[0].kind, 'fca');
  assert.equal(r.report.bundles[0].added, 2);
});

test('four vehicles of one character survive as four separate amiibo', async () => {
  // They share an ID, so keying on that alone would keep one and drop three.
  const bytes = fca(VEHICLES.map(([code, flag], i) =>
    ({ type: 2, bytes: v3(KIRBY_AR, code, flag, 20 + i) })));
  const r = await expand('riders.fca', bytes);
  assert.equal(r.report.bundles[0].unique, 4, 'four distinct items');
  assert.equal(r.virtual.size, 4);
  assert.deepEqual([...r.virtual.keys()].sort(),
    ['Shadow', 'Tank', 'Warp', 'Winged'].map((v) => `${dir(KIRBY_AR)}/Kirby (${v}).bin`).sort());
  for (const e of r.virtual.values()) assert.equal(e.size, 2048, 'the full dump is kept');
});

test('a non-amiibo entry is reported through the unpack summary', async () => {
  const bytes = fca([
    { type: 1, bytes: dump(MARIO, { uid: uidFor(1) }) },
    { type: 4, bytes: new Uint8Array(256) },
  ]);
  const r = await expand('mixed.fca', bytes);
  assert.equal(r.virtual.size, 1);
  assert.equal(r.report.bundles[0].blocked.length, 1);
  assert.match(r.report.bundles[0].blocked[0].reason, /not an amiibo/);
});

// ---- real archives, when they are there ---------------------------------
//
// The tests above are written against a builder that follows the spec, so they
// prove the reader matches my reading of it. These prove it matches what a real
// packer emits, which is the part a spec cannot settle. Numbers are measured
// from four Flashiibo exports.

const samples = fileURLToPath(new URL('../amiibos/flashiibo-fca/', import.meta.url));
const sample = (name) => `${samples}${name}`;
const read = (name) => new Uint8Array(readFileSync(sample(name)));

test('a real archive of v2 dumps reads', { skip: !existsSync(sample('only ac.fca')) }, () => {
  const b = read('only ac.fca');
  assert.deepEqual(detectFca(b), { version: 1, count: 525, amiibos: 525 });
  const { records, skipped } = splitFca(b);
  assert.equal(records.length, 525);
  assert.deepEqual(skipped, []);
  assert.ok(records.every((r) => r.dump.length === 540 && r.type === 1));
  assert.equal(new Set(records.map((r) => r.amiiboId)).size, 525, 'the whole Animal Crossing set');
});

test('a real archive keeps Air Riders vehicles, which the flat format cannot', { skip: !existsSync(sample('only air riders.fca')) }, () => {
  const b = read('only air riders.fca');
  assert.deepEqual(detectFca(b), { version: 1, count: 16, amiibos: 16 });
  const { records } = splitFca(b);
  assert.equal(records.length, 16, '4 characters x 4 vehicles');
  assert.ok(records.every((r) => r.dump.length === 2048 && r.type === 2), 'whole I2C dumps');
  assert.equal(new Set(records.map((r) => r.amiiboId)).size, 4, 'four characters share four IDs');
  assert.deepEqual(new Set(records.map((r) => r.vehicle)),
    new Set(['Warp Star', 'Winged Star', 'Shadow Star', 'Tank Star']));
});

test('a real archive carrying a README skips it and keeps the rest', { skip: !existsSync(sample('all except air riders.fca')) }, () => {
  // Entry 402 is a 253-byte note about registering Wolf Link, filed as type 0.
  const b = read('all except air riders.fca');
  assert.deepEqual(detectFca(b), { version: 1, count: 942, amiibos: 941 });
  const { records, skipped } = splitFca(b);
  assert.equal(records.length, 941);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /is not a readable dump/);
});

test('every real archive unpacks into the collection', { skip: !existsSync(samples) }, async () => {
  for (const name of readdirSync(samples).filter((f) => f.endsWith('.fca'))) {
    const bytes = read(name);
    const found = detectFca(bytes);
    assert.ok(found, `${name} is recognised`);
    const r = await expand(name, bytes);
    assert.equal(r.report.bundles[0].kind, 'fca');
    assert.ok(r.virtual.size > 0, `${name} yields amiibo`);
    assert.deepEqual(r.excludes, [name], `${name} is never sent to a device`);
  }
});
