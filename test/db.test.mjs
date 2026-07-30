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
} from '../web/data/amiibo-db.js';

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
