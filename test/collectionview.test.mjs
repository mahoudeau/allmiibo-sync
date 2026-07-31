// Filtering, counting and ordering a collection.
//
// This logic used to live inside collectionui.js, where it could not be reached
// by a test: that file imports Web Bluetooth, the File System Access API and the
// sync engine, none of which exist under node:test. It now sits on its own so
// both the collection page and the admin can use it, and so the rules it
// encodes are pinned rather than merely working.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILTERS,
  normaliseFilter,
  filterCounts,
  matchesFilter,
  seriesDate,
  completionRatio,
  sortSeries,
  searchText,
} from '../web/js/collectionview.js';

const item = (id, extra = {}) => ({ id, name: `Amiibo ${id}`, inDatabase: true, ...extra });
const group = (series, seriesName, items) => ({ series, seriesName, items });

// hasDevice is deliberately three-valued: true, false, or undefined when no
// device has been scanned at all.
const owned = (id) => item(id, { hasLocal: true });
const onDevice = (id) => item(id, { hasLocal: false, hasDevice: true });
const missingFromDevice = (id) => item(id, { hasLocal: true, hasDevice: false });
const missing = (id) => item(id, { hasLocal: false });

// ---- filters ------------------------------------------------------------

test('a stored filter survives only if it is still meaningful', () => {
  assert.equal(normaliseFilter('owned', { hasDevice: true }), 'owned');
  assert.equal(normaliseFilter('missing', { hasDevice: false }), 'missing');
  // "not on device" cannot be shown or cleared when there is no device, so a
  // stale preference must not leave the page filtered by it.
  assert.equal(normaliseFilter('notondevice', { hasDevice: false }), 'all');
  assert.equal(normaliseFilter('notondevice', { hasDevice: true }), 'notondevice');
  assert.equal(normaliseFilter('nonsense', { hasDevice: true }), 'all');
  assert.equal(normaliseFilter(undefined, {}), 'all');
});

test('the filter list is what the pills are built from', () => {
  assert.deepEqual(FILTERS.map((f) => f.value), ['all', 'owned', 'missing', 'notondevice']);
  assert.equal(FILTERS.find((f) => f.value === 'notondevice').needsDevice, true);
});

test('counts split owned from missing, and count the device separately', () => {
  const collection = {
    series: [group(0, 'Smash', [owned('a'), missing('b'), missingFromDevice('c')])],
  };
  const counts = filterCounts(collection);
  assert.equal(counts.all, 3);
  assert.equal(counts.owned, 2, 'owned locally or on the device');
  assert.equal(counts.missing, 1);
  assert.equal(counts.notondevice, 1, 'only the one explicitly absent from a scanned device');
});

test('an unscanned device does not make everything "not on device"', () => {
  // hasDevice undefined means nothing is known, which is not the same as
  // known-absent. Getting this wrong would show a full count before any scan.
  const collection = { series: [group(0, 'Smash', [owned('a'), owned('b')])] };
  assert.equal(filterCounts(collection).notondevice, 0);
});

test('counting nothing is zero, not a crash', () => {
  assert.deepEqual(filterCounts(null), { all: 0, owned: 0, missing: 0, notondevice: 0 });
  assert.deepEqual(filterCounts({ series: [] }).all, 0);
});

// ---- the row predicate --------------------------------------------------

test('each filter keeps what it says', () => {
  const o = owned('a');
  const m = missing('b');
  const nd = missingFromDevice('c');

  assert.equal(matchesFilter(o, 'text', { filter: 'owned' }), true);
  assert.equal(matchesFilter(m, 'text', { filter: 'owned' }), false);

  assert.equal(matchesFilter(m, 'text', { filter: 'missing' }), true);
  assert.equal(matchesFilter(o, 'text', { filter: 'missing' }), false);

  assert.equal(matchesFilter(nd, 'text', { filter: 'notondevice' }), true);
  assert.equal(matchesFilter(o, 'text', { filter: 'notondevice' }), false,
    'undefined hasDevice is not "absent from the device"');
});

test('search is a substring of the precomputed haystack', () => {
  const o = owned('a');
  assert.equal(matchesFilter(o, 'mario smash 0000', { query: 'mario' }), true);
  assert.equal(matchesFilter(o, 'mario smash 0000', { query: 'luigi' }), false);
  assert.equal(matchesFilter(o, 'mario smash 0000', { query: '' }), true);
});

test('filter and search both have to pass', () => {
  const m = missing('b');
  assert.equal(matchesFilter(m, 'mario', { filter: 'missing', query: 'mario' }), true);
  assert.equal(matchesFilter(m, 'mario', { filter: 'owned', query: 'mario' }), false);
  assert.equal(matchesFilter(m, 'mario', { filter: 'missing', query: 'luigi' }), false);
});

test('no filter and no query keeps everything', () => {
  assert.equal(matchesFilter(missing('b'), 'anything', {}), true);
});

// ---- ordering -----------------------------------------------------------

const RELEASES = { a: '2014-11-21', b: '2015-03-12', c: '2017-01-01' };

test('a series is dated by its earliest entry, and the answer is memoised', () => {
  const g = group(0, 'Smash', [item('b'), item('a')]);
  assert.equal(seriesDate(g, RELEASES), '2014-11-21');
  // Memoised onto the group, so re-sorting does not rescan every item.
  assert.equal(g._date, '2014-11-21');
});

test('a series with no dated entry has no date', () => {
  const g = group(9, 'Unknown', [item('zz')]);
  assert.equal(seriesDate(g, RELEASES), null);
});

test('completion counts only catalogued entries', () => {
  // Otherwise a folder of unrecognised dumps could report a series as complete.
  const g = group(0, 'Smash', [
    item('a', { hasLocal: true }),
    item('b', {}),
    item('c', { hasLocal: true, inDatabase: false }),
  ]);
  assert.equal(completionRatio(g), 0.5, '1 of the 2 catalogued entries');
});

test('a series with nothing catalogued sorts last rather than as complete', () => {
  const g = group(0, 'Smash', [item('a', { inDatabase: false, hasLocal: true })]);
  assert.equal(completionRatio(g), -1);
});

test('sorting by name is alphabetical', () => {
  const groups = [group(1, 'Zelda', []), group(0, 'Animal Crossing', [])];
  assert.deepEqual(sortSeries(groups, 'name', RELEASES).map((g) => g.seriesName),
    ['Animal Crossing', 'Zelda']);
});

test('sorting by completion puts the fullest first', () => {
  const full = group(0, 'Full', [item('a', { hasLocal: true })]);
  const half = group(1, 'Half', [item('b', { hasLocal: true }), item('c', {})]);
  assert.deepEqual(sortSeries([half, full], 'completion', RELEASES).map((g) => g.seriesName),
    ['Full', 'Half']);
});

test('sorting by release is oldest first, with undated series last', () => {
  // The fiddly one: an undated series must not be treated as ancient.
  const old = group(0, 'Old', [item('a')]);
  const newer = group(1, 'New', [item('c')]);
  const undated = group(2, 'Undated', [item('zz')]);
  assert.deepEqual(
    sortSeries([undated, newer, old], 'release', RELEASES).map((g) => g.seriesName),
    ['Old', 'New', 'Undated']
  );
});

test('release ties break on the series byte, so the order is stable', () => {
  const a = group(5, 'Later Byte', [item('a')]);
  const b = group(2, 'Earlier Byte', [item('a')]);
  assert.deepEqual(sortSeries([a, b], 'release', RELEASES).map((g) => g.series), [2, 5]);
});

test('sorting returns a new array and leaves the input alone', () => {
  const groups = [group(1, 'Zelda', []), group(0, 'Animal Crossing', [])];
  const before = groups.map((g) => g.seriesName);
  sortSeries(groups, 'name', RELEASES);
  assert.deepEqual(groups.map((g) => g.seriesName), before);
});

test('an unknown sort mode falls back to release order', () => {
  const old = group(0, 'Old', [item('a')]);
  const newer = group(1, 'New', [item('c')]);
  assert.deepEqual(sortSeries([newer, old], 'nonsense', RELEASES).map((g) => g.seriesName),
    ['Old', 'New']);
});

// ---- the haystack -------------------------------------------------------

test('the search text covers name, ID, series and filenames', () => {
  const text = searchText(item('0000000000000002', { name: 'Mario' }), {
    seriesName: 'Super Smash Bros.',
    fileNames: ['my mario.bin'],
  });
  assert.match(text, /mario/);
  assert.match(text, /0000000000000002/, 'so pasting an ID finds it');
  assert.match(text, /smash/);
  assert.match(text, /my mario\.bin/, 'so searching for what is on disk works');
  assert.equal(text, text.toLowerCase(), 'lowercased once, not per keystroke');
});
