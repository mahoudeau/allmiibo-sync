// Invariants of the generated database.
//
// tools/build-amiibo-db.mjs enforces these at generation time and refuses to
// write a file that breaks them. These tests enforce the same things on the
// file that is actually committed, so a hand edit — which the header forbids but
// nothing prevents — cannot slip a collision into a release.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AMIIBO_NAMES,
  AMIIBO_SERIES,
  AMIIBO_TYPES,
  AMIIBO_RELEASE,
  AMIIBO_SERIES_SHORT,
  AMIIBO_FILE_NAMES,
  AMIIBO_SHORT_NAMES,
  AMIIBO_CATEGORIES,
  AMIIBO_PATHS,
  AMIIBO_NOTES,
  AMIIBO_AUTHORED,
  AMIIBO_UPSTREAM,
} from '../web/data/amiibo-db.js';
import { validatePinnedPath } from '../web/js/overlay.js';

const ids = Object.keys(AMIIBO_NAMES);
const seriesOf = (id) => parseInt(id.slice(12, 14), 16);

test('every ID is 16 lowercase hex characters', () => {
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
});

test('every series byte an ID uses has a label', () => {
  for (const id of ids) {
    assert.ok(AMIIBO_SERIES[seriesOf(id)] !== undefined, `series 0x${id.slice(12, 14)} has no label`);
  }
});

test('every series has a short token, and they are unique', () => {
  const tokens = Object.values(AMIIBO_SERIES_SHORT);
  for (const b of Object.keys(AMIIBO_SERIES)) {
    assert.ok(AMIIBO_SERIES_SHORT[b], `series ${b} (${AMIIBO_SERIES[b]}) has no short token`);
  }
  assert.equal(new Set(tokens).size, tokens.length, 'two series share a folder token');
  assert.equal(Object.keys(AMIIBO_SERIES_SHORT).length, Object.keys(AMIIBO_SERIES).length);
});

test('a short token is never longer than the label it stands in for', () => {
  for (const [b, token] of Object.entries(AMIIBO_SERIES_SHORT)) {
    assert.ok(
      Buffer.byteLength(token) <= Buffer.byteLength(AMIIBO_SERIES[b]),
      `${token} is no shorter than ${AMIIBO_SERIES[b]}`
    );
  }
});

// The one that matters: two amiibos in one series folder must not want the same
// filename, or the second overwrites the first on the device.
test('filenames are unique within their series folder', () => {
  const seen = new Map();
  for (const id of ids) {
    const name = AMIIBO_FILE_NAMES[id] ?? AMIIBO_NAMES[id];
    const key = `${seriesOf(id)}/${name}`;
    assert.equal(seen.get(key), undefined, `${key} claimed by ${seen.get(key)} and ${id}`);
    seen.set(key, id);
  }
});

test('abbreviated names are unique within their series folder too', () => {
  const seen = new Map();
  for (const id of ids) {
    const name = AMIIBO_SHORT_NAMES[id] ?? AMIIBO_FILE_NAMES[id] ?? AMIIBO_NAMES[id];
    const key = `${seriesOf(id)}/${name}`;
    assert.equal(seen.get(key), undefined, `${key} claimed by ${seen.get(key)} and ${id}`);
    seen.set(key, id);
  }
});

test('the naming tables carry only deltas, and only for IDs that exist', () => {
  for (const [table, name] of [[AMIIBO_FILE_NAMES, 'AMIIBO_FILE_NAMES'], [AMIIBO_SHORT_NAMES, 'AMIIBO_SHORT_NAMES']]) {
    for (const [id, value] of Object.entries(table)) {
      assert.ok(AMIIBO_NAMES[id], `${name} names ${id}, which is not in the database`);
      assert.notEqual(value, AMIIBO_NAMES[id], `${name}[${id}] repeats the display name`);
    }
  }
});

test('an abbreviated name is genuinely shorter than the name it replaces', () => {
  for (const [id, short] of Object.entries(AMIIBO_SHORT_NAMES)) {
    const from = AMIIBO_FILE_NAMES[id] ?? AMIIBO_NAMES[id];
    assert.ok(Buffer.byteLength(short) < Buffer.byteLength(from), `${short} does not shorten ${from}`);
  }
});

test('no filename would breach the device name limit on its own', () => {
  // 47 bytes for the name, less 4 for ".bin". Nothing in the database is close,
  // and if something ever is, the path ladder can only fall back to the ID.
  for (const id of ids) {
    const name = AMIIBO_SHORT_NAMES[id] ?? AMIIBO_FILE_NAMES[id] ?? AMIIBO_NAMES[id];
    assert.ok(Buffer.byteLength(`${name}.bin`) <= 47, `${name}.bin is over the 47-byte name limit`);
  }
});

test('every type byte an ID uses has a label', () => {
  for (const id of ids) {
    const t = parseInt(id.slice(6, 8), 16);
    assert.ok(AMIIBO_TYPES[t] !== undefined, `type ${t} has no label`);
  }
});

test('release dates are ISO dates for IDs in the database', () => {
  for (const [id, date] of Object.entries(AMIIBO_RELEASE)) {
    assert.ok(AMIIBO_NAMES[id], `${id} has a release date but no name`);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

// ---- curated tables -----------------------------------------------------
//
// These come from content/amiibo-overrides.json by way of the generator. They
// are empty until something is curated, but the shape is always emitted so
// consumers can import it, and these hold whatever ends up in it to the same
// standard as the upstream tables.

test('the curated tables are always present, so importers need no fallback', () => {
  for (const [name, table] of [
    ['AMIIBO_CATEGORIES', AMIIBO_CATEGORIES],
    ['AMIIBO_PATHS', AMIIBO_PATHS],
    ['AMIIBO_NOTES', AMIIBO_NOTES],
    ['AMIIBO_UPSTREAM', AMIIBO_UPSTREAM],
  ]) {
    assert.equal(typeof table, 'object', `${name} must be an object`);
    assert.ok(Object.isFrozen(table), `${name} must be frozen`);
  }
  assert.ok(Array.isArray(AMIIBO_AUTHORED));
  assert.ok(Object.isFrozen(AMIIBO_AUTHORED));
});

test('every curated table keys only real amiibo', () => {
  for (const [name, table] of [
    ['AMIIBO_PATHS', AMIIBO_PATHS],
    ['AMIIBO_NOTES', AMIIBO_NOTES],
    ['AMIIBO_UPSTREAM', AMIIBO_UPSTREAM],
  ]) {
    for (const id of Object.keys(table)) {
      assert.ok(AMIIBO_NAMES[id], `${name} names ${id}, which is not in the database`);
    }
  }
  for (const id of AMIIBO_AUTHORED) {
    assert.ok(AMIIBO_NAMES[id], `AMIIBO_AUTHORED lists ${id}, which is not in the database`);
  }
});

test('categories reference real amiibo and carry a label', () => {
  for (const [catId, cat] of Object.entries(AMIIBO_CATEGORIES)) {
    assert.match(catId, /^[a-z0-9][a-z0-9-]*$/, `${catId} is not a slug`);
    assert.ok(cat.label, `${catId} has no label`);
    assert.ok(Array.isArray(cat.members));
    assert.equal(new Set(cat.members).size, cat.members.length, `${catId} lists a member twice`);
    for (const m of cat.members) {
      assert.ok(AMIIBO_NAMES[m], `category ${catId} lists ${m}, which is not in the database`);
    }
  }
});

test('every pinned path is one a device could actually accept', () => {
  // Same check the overlay validator runs, applied to what was committed: safe
  // segments, inside the byte limits, and never on an ID that stands for more
  // than one physical dump.
  for (const [id, path] of Object.entries(AMIIBO_PATHS)) {
    assert.deepEqual(validatePinnedPath(id, path), [], `${id} -> ${path}`);
  }
});

test('an authored entry is not also recorded as an upstream override', () => {
  // It cannot be both invented here and a correction of something upstream.
  for (const id of AMIIBO_AUTHORED) {
    assert.equal(AMIIBO_UPSTREAM[id], undefined, `${id} is authored and yet has an upstream value`);
  }
});

test('an override records a value that actually differs', () => {
  // A recorded upstream value identical to the current one is a no-op override
  // that should have been dropped at generation.
  for (const [id, was] of Object.entries(AMIIBO_UPSTREAM)) {
    assert.notEqual(was, AMIIBO_NAMES[id], `${id}: the override matches upstream, so it does nothing`);
  }
});

test('every curated series face is an amiibo of the series it represents', async () => {
  const { AMIIBO_SERIES_FACE, AMIIBO_NAMES } = await import('../web/data/amiibo-db.js');
  // The overlay refuses one that is not, but this is the committed artefact —
  // and the header showing a character from another series would read as an
  // artwork bug rather than a bad pin.
  for (const [byte, id] of Object.entries(AMIIBO_SERIES_FACE)) {
    assert.match(id, /^[0-9a-f]{16}$/, `face for series ${byte} is an ID`);
    assert.ok(AMIIBO_NAMES[id], `face ${id} is a real amiibo`);
    assert.equal(parseInt(id.slice(12, 14), 16), Number(byte),
      `face ${id} belongs to series ${byte}`);
  }
});

