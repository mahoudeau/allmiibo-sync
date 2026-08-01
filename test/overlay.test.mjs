// The curated overlay: schema, merge and the things it must refuse.
//
// The overlay is the one place a human writes data that ends up deciding where
// files land on a device, so validation is the load-bearing part. Everything
// here that rejects is deliberately a hard failure in the generator: the build
// writes nothing rather than shipping a database that could overwrite one amiibo
// with another.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_OVERLAY,
  SCHEMA_VERSION,
  validateOverlay,
  validatePinnedPath,
  applyOverlay,
  overlayPins,
  overlayCategories,
  serializeOverlay,
  parseOverlay,
} from '../web/js/overlay.js';

const ID = '0000000000000002';        // Mario, series 00
const ID2 = '0000000000340102';       // Mario, series 01
const AIR_RIDERS = '1f00000004c41e03'; // series 0x1e, four vehicles share this
const HHD = '026a000100000502';        // 91 cards share this
const NEW_ID = 'ffff000100010402';

const overlay = (extra) => ({ schema: SCHEMA_VERSION, ...extra });
const upstream = () => ({
  names: new Map([[ID, 'Mario'], [ID2, 'Mario']]),
  series: { 0: 'Super Smash Bros.', 1: 'Super Mario Bros.' },
  types: { 0: 'Figure' },
  releases: new Map([[ID, '2014-11-21']]),
});

const ok = (o) => assert.deepEqual(validateOverlay(o), [], 'should be valid');
const rejects = (o, re) => {
  const errs = validateOverlay(o);
  assert.ok(errs.length > 0, 'should have been rejected');
  if (re) assert.match(errs.join('\n'), re);
};

// ---- schema -------------------------------------------------------------

test('an empty overlay is valid', () => {
  ok(EMPTY_OVERLAY);
  ok(overlay({}));
});

test('the schema version is pinned', () => {
  rejects({ schema: 99 }, /schema must be 1/);
  rejects({}, /schema must be 1/);
});

test('an unknown key is an error, not a shrug', () => {
  // A mistyped "catagories" that silently does nothing is the worst failure
  // mode a curated file can have.
  rejects(overlay({ catagories: {} }), /unknown top-level key "catagories"/);
  rejects(overlay({ amiibos: { [ID]: { kind: 'override', colour: 'red' } } }), /unknown key "colour"/);
  rejects(overlay({ series: { 0: { labl: 'x' } } }), /unknown key "labl"/);
  rejects(overlay({ categories: { a: { label: 'x', membrs: [] } } }), /unknown key "membrs"/);
});

test('IDs must be 16 lowercase hex characters', () => {
  rejects(overlay({ amiibos: { ABCD000000000002: { kind: 'override' } } }), /not a 16-character lowercase hex/);
  rejects(overlay({ amiibos: { abc: { kind: 'override' } } }), /not a 16-character/);
});

test('kind is required and explicit, never inferred', () => {
  rejects(overlay({ amiibos: { [ID]: { name: 'x' } } }), /kind must be/);
  rejects(overlay({ amiibos: { [ID]: { kind: 'edit' } } }), /kind must be/);
  ok(overlay({ amiibos: { [ID]: { kind: 'override', name: 'x' } } }));
});

test('an authored amiibo needs a name', () => {
  rejects(overlay({ amiibos: { [NEW_ID]: { kind: 'new' } } }), /needs a name/);
  ok(overlay({ amiibos: { [NEW_ID]: { kind: 'new', name: 'Custom' } } }));
});

test('a release is an ISO date, or null to delete one', () => {
  rejects(overlay({ amiibos: { [ID]: { kind: 'override', release: '14/02/26' } } }), /YYYY-MM-DD/);
  ok(overlay({ amiibos: { [ID]: { kind: 'override', release: null } } }));
  ok(overlay({ amiibos: { [ID]: { kind: 'override', release: '2026-02-14' } } }));
});

// ---- curated names ------------------------------------------------------

test('a filename is one segment, not a path', () => {
  // sanitizeLocalName strips illegal characters but not separators, so this
  // would otherwise sail through and quietly create a folder.
  rejects(overlay({ amiibos: { [ID]: { kind: 'override', fileName: 'a/b' } } }), /must be a filename, not a path/);
  rejects(overlay({ amiibos: { [ID]: { kind: 'override', fileName: 'a\\b' } } }), /must be a filename, not a path/);
});

test('a filename the sanitiser would rewrite is refused', () => {
  rejects(overlay({ amiibos: { [ID]: { kind: 'override', fileName: 'Trailing ' } } }), /not a safe filename/);
  rejects(overlay({ amiibos: { [ID]: { kind: 'override', fileName: 'colon:name' } } }), /not a safe filename/);
});

test('a filename must fit the device name limit with .bin', () => {
  rejects(overlay({ amiibos: { [ID]: { kind: 'override', fileName: 'x'.repeat(60) } } }), /over the 47-byte limit/);
});

test('an abbreviation must actually be shorter', () => {
  rejects(
    overlay({ amiibos: { [ID]: { kind: 'override', fileName: 'Short', shortName: 'Much Longer' } } }),
    /shortName must be shorter/
  );
});

// ---- pinned paths -------------------------------------------------------

test('a pinned path must be relative, safe and end in .bin', () => {
  const pin = (p) => overlay({ amiibos: { [ID]: { kind: 'override', path: p } } });
  rejects(pin('/abs/x.bin'), /must be relative/);
  rejects(pin('C:/x.bin'), /must be relative/);
  rejects(pin('a\\b.bin'), /must be relative/);
  rejects(pin('../escape.bin'), /must not contain/);
  rejects(pin('SSB/Mario.txt'), /must end in \.bin/);
  rejects(pin('SSB//Mario.bin'), /empty segment/);
  ok(pin('SSB/Mario.bin'));
});

test('a pinned path must fit the device limit at the reference root', () => {
  rejects(
    overlay({ amiibos: { [ID]: { kind: 'override', path: 'Mario Sports Superstars/Pink Gold Peach - Horse Racing.bin' } } }),
    /over the 63-byte limit/
  );
});

test('a path cannot be pinned where one ID stands for many dumps', () => {
  // This is the invariant that makes it safe to try a pin first in the path
  // ladder. Air Riders characters have four vehicle pairings per ID and the 91
  // HHD cards share one fabricated ID; a single pinned path would collapse them
  // all onto one filename and keep the last.
  assert.match(validatePinnedPath(AIR_RIDERS, 'KAR/Kirby.bin').join(), /four vehicle pairings/);
  assert.match(validatePinnedPath(HHD, 'AC/HHD.bin').join(), /share one ID/);
  assert.deepEqual(validatePinnedPath(ID, 'SSB/Mario.bin'), []);
});

// ---- categories ---------------------------------------------------------

test('category ids are slugs and members are real IDs', () => {
  rejects(overlay({ categories: { 'Bad Id': { label: 'x' } } }), /lowercase a-z0-9 and dashes/);
  rejects(overlay({ categories: { ok: {} } }), /label is required/);
  rejects(overlay({ categories: { ok: { label: 'x', members: ['nope'] } } }), /is not an amiibo ID/);
  rejects(overlay({ categories: { ok: { label: 'x', members: [ID, ID] } } }), /listed twice/);
  ok(overlay({ categories: { 'for-the-kids': { label: 'Kids', order: 2, members: [ID] } } }));
});

test('a member that is no longer in the database is dropped and reported', () => {
  const { categories, notices } = overlayCategories(
    overlay({ categories: { fav: { label: 'Fav', members: [ID, 'dead0000dead0002'] } } }),
    new Map([[ID, 'Mario']])
  );
  assert.deepEqual(categories.fav.members, [ID]);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /not in the database/);
});

test('categories come out ordered', () => {
  const { categories } = overlayCategories(overlay({
    categories: {
      b: { label: 'B', order: 2 },
      a: { label: 'A', order: 1 },
    },
  }));
  assert.deepEqual(Object.keys(categories), ['a', 'b']);
});

// ---- merging ------------------------------------------------------------

test('an override replaces the upstream name and records what it replaced', () => {
  const r = applyOverlay(upstream(), overlay({
    amiibos: { [ID]: { kind: 'override', name: 'Mario (Smash)' } },
  }));
  assert.equal(r.names.get(ID), 'Mario (Smash)');
  assert.equal(r.upstreamWas.get(ID), 'Mario', 'so update-db can spot upstream moving later');
});

test('an authored amiibo is added and listed', () => {
  const r = applyOverlay(upstream(), overlay({
    amiibos: { [NEW_ID]: { kind: 'new', name: 'Custom', release: '2026-02-14' } },
  }));
  assert.equal(r.names.get(NEW_ID), 'Custom');
  assert.deepEqual(r.authored, [NEW_ID]);
  assert.equal(r.releases.get(NEW_ID), '2026-02-14');
});

test('a null release deletes the upstream date', () => {
  const r = applyOverlay(upstream(), overlay({
    amiibos: { [ID]: { kind: 'override', release: null } },
  }));
  assert.equal(r.releases.has(ID), false);
});

test('authoring an ID upstream already has is a hard error', () => {
  // Two sources now claim to name one ID and the tool cannot choose.
  const r = applyOverlay(upstream(), overlay({
    amiibos: { [ID]: { kind: 'new', name: 'Mine' } },
  }));
  const err = r.notices.find((n) => n.level === 'error');
  assert.ok(err, 'must be fatal, not a warning');
  assert.match(err.message, /Change kind to "override"/);
  assert.equal(r.names.get(ID), 'Mario', 'and upstream is left alone');
});

test('overriding an ID upstream dropped only warns', () => {
  // A routine refresh must not fail because a third party edited their repo.
  const r = applyOverlay(upstream(), overlay({
    amiibos: { dead0000dead0002: { kind: 'override', name: 'Gone' } },
  }));
  assert.equal(r.notices.filter((n) => n.level === 'error').length, 0);
  const warn = r.notices.find((n) => n.code === 'orphaned');
  assert.ok(warn);
  assert.equal(r.names.has('dead0000dead0002'), false, 'the override does not resurrect it');
});

test('an override upstream has caught up with is reported as redundant', () => {
  const r = applyOverlay(upstream(), overlay({
    amiibos: { [ID]: { kind: 'override', name: 'Mario' } },
  }));
  const note = r.notices.find((n) => n.code === 'redundant');
  assert.ok(note, 'so it can be cleaned up');
  assert.equal(r.upstreamWas.has(ID), false, 'and nothing is recorded as replaced');
});

test('series and type labels can be corrected', () => {
  const r = applyOverlay(upstream(), overlay({
    series: { 0: { label: 'Smash' } },
    types: { 0: { label: 'Statue' } },
  }));
  assert.equal(r.series[0], 'Smash');
  assert.equal(r.types[0], 'Statue');
});

test('applying an overlay never mutates its input', () => {
  const before = upstream();
  const snapshot = [...before.names];
  applyOverlay(before, overlay({ amiibos: { [NEW_ID]: { kind: 'new', name: 'X' } } }));
  assert.deepEqual([...before.names], snapshot);
});

// ---- declining an addition ----------------------------------------------

test('an excluded ID is not in the database, and is refused as a list', () => {
  rejects(overlay({ excluded: ID }), /excluded must be an array/);
  rejects(overlay({ excluded: ['NOPE'] }), /not a 16-character lowercase hex ID/);
  rejects(overlay({ excluded: [ID, ID] }), /listed twice/);
  ok(overlay({ excluded: [ID] }));

  const merged = applyOverlay(upstream(), overlay({ excluded: [ID] }));
  assert.equal(merged.names.has(ID), false, 'gone from the names');
  assert.equal(merged.releases.has(ID), false, 'and from the dates with it');
  assert.equal(merged.names.has(ID2), true, 'the rest are untouched');
});

test('what an excluded entry WAS called is kept, so it can be offered again', () => {
  // Without this the exclusion would be silent forever: the generated database
  // omits the ID, so the next update would find no difference to report and the
  // "not this time" promise would quietly become "never".
  const merged = applyOverlay(upstream(), overlay({ excluded: [ID] }));
  assert.equal(merged.excluded.get(ID), 'Mario');
});

test('excluding an ID upstream dropped anyway is not an error', () => {
  const merged = applyOverlay(upstream(), overlay({ excluded: [NEW_ID] }));
  assert.equal(merged.excluded.size, 0, 'nothing to exclude, nothing to report');
  assert.deepEqual(merged.notices, []);
});

test('an excluded amiibo takes no part in naming or collision checks', () => {
  // ID and ID2 are both "Mario" and would normally disambiguate against each
  // other. Removing one before anything is derived means the other is simply
  // Mario — which is the whole reason the removal happens first.
  const merged = applyOverlay(upstream(), overlay({ excluded: [ID2] }));
  assert.deepEqual([...merged.names.values()], ['Mario']);
});

// ---- pins ---------------------------------------------------------------

test('pins are collected per kind', () => {
  const pins = overlayPins(overlay({
    series: { 30: { short: 'KAR' } },
    amiibos: {
      [ID]: { kind: 'override', fileName: 'Mario (Smash)', path: 'SSB/Mario.bin', blurb: 'note' },
      [ID2]: { kind: 'override', shortName: 'M - SMB' },
    },
  }));
  assert.equal(pins.seriesShort[30], 'KAR');
  assert.equal(pins.fileNames.get(ID), 'Mario (Smash)');
  assert.equal(pins.shortNames.get(ID2), 'M - SMB');
  assert.equal(pins.paths.get(ID), 'SSB/Mario.bin');
  assert.equal(pins.notes.get(ID), 'note');
});

// ---- round trip ---------------------------------------------------------

test('serialising sorts keys and ends with a newline, for small diffs', () => {
  const text = serializeOverlay({ schema: 1, amiibos: { [ID2]: { kind: 'override' }, [ID]: { kind: 'override' } } });
  assert.ok(text.endsWith('\n'));
  assert.ok(text.indexOf(`"${ID}"`) < text.indexOf(`"${ID2}"`), 'IDs sorted');
  assert.deepEqual(JSON.parse(text).amiibos[ID], { kind: 'override' });
});

test('parsing rejects bad JSON and bad shape with a useful message', () => {
  assert.throws(() => parseOverlay('{ not json'), /not valid JSON/);
  assert.throws(() => parseOverlay('{"schema":1,"nope":{}}'), /unknown top-level key/);
  assert.deepEqual(parseOverlay('{"schema":1}').amiibos, {});
});

// ---- series curation ----------------------------------------------------

test('a series face must be an amiibo in that series', () => {
  // Otherwise the series header shows a character from somewhere else, which
  // looks like a bug in the artwork rather than a bad pin.
  const ok = validateOverlay({
    ...EMPTY_OVERLAY,
    series: { 0: { face: '0000000000000002' } },   // series byte 00
  });
  assert.deepEqual(ok, []);

  const wrong = validateOverlay({
    ...EMPTY_OVERLAY,
    series: { 1: { face: '0000000000000002' } },   // claims series 01
  });
  assert.equal(wrong.length, 1);
  assert.match(wrong[0], /is not in that series/);

  for (const face of ['nothex', '', 'ABCDEF0000000002', 42]) {
    const bad = validateOverlay({ ...EMPTY_OVERLAY, series: { 0: { face } } });
    assert.ok(bad.length > 0, `${JSON.stringify(face)} is refused`);
  }
});

test('a folder token is one folder name, held to the device\'s rules', () => {
  assert.deepEqual(validateOverlay({ ...EMPTY_OVERLAY, series: { 0: { short: 'SSB' } } }), []);

  const path = validateOverlay({ ...EMPTY_OVERLAY, series: { 0: { short: 'a/b' } } });
  assert.match(path[0], /one folder name, not a path/);

  const backslash = validateOverlay({ ...EMPTY_OVERLAY, series: { 0: { short: 'a\\b' } } });
  assert.match(backslash[0], /one folder name, not a path/);

  // Something the sanitiser would rewrite is a lie about what lands on disk.
  const unsafe = validateOverlay({ ...EMPTY_OVERLAY, series: { 0: { short: 'a:b' } } });
  assert.ok(unsafe.length > 0);
});

test('series pins reach the generator', async () => {
  const { overlayPins } = await import('../web/js/overlay.js');
  const pins = overlayPins({
    ...EMPTY_OVERLAY,
    series: { 0: { short: 'SMASH', face: '0000000000000002', label: 'Smash' } },
  });
  assert.equal(pins.seriesShort[0], 'SMASH');
  assert.equal(pins.seriesFace[0], '0000000000000002');
  assert.equal('label' in pins.seriesShort, false, 'the label is applied, not pinned');
});

// ---- the record a skip-pin leaves --------------------------------------

test('upstreamWas records only pinnable fields, and only beside a pin', () => {
  const ok = validateOverlay({
    ...EMPTY_OVERLAY,
    amiibos: {
      '0000000000000002': {
        kind: 'override', name: 'Mine',
        upstreamWas: { name: 'Theirs' },
        decidedAt: '2026-08-01',
      },
    },
  });
  assert.deepEqual(ok, []);

  // A record with no pin beside it is dangling. This is what makes dropping a
  // pin self-checking: the drop has to take the record with it.
  const dangling = validateOverlay({
    ...EMPTY_OVERLAY,
    amiibos: { '0000000000000002': { kind: 'override', upstreamWas: { name: 'Theirs' } } },
  });
  assert.equal(dangling.length, 1);
  assert.match(dangling[0], /no pin beside it/);

  const unknown = validateOverlay({
    ...EMPTY_OVERLAY,
    amiibos: { '0000000000000002': { kind: 'override', name: 'x', upstreamWas: { nope: 'y' } } },
  });
  assert.match(unknown[0], /not a pinnable field/);

  // null is meaningful: upstream produced nothing for that field.
  assert.deepEqual(validateOverlay({
    ...EMPTY_OVERLAY,
    amiibos: { '0000000000000002': { kind: 'override', release: '2014-11-21', upstreamWas: { release: null } } },
  }), []);

  const badDate = validateOverlay({
    ...EMPTY_OVERLAY,
    amiibos: { '0000000000000002': { kind: 'override', name: 'x', decidedAt: 'yesterday' } },
  });
  assert.match(badDate[0], /decidedAt must be YYYY-MM-DD/);
});

test('a series pin carries the same record', () => {
  assert.deepEqual(validateOverlay({
    ...EMPTY_OVERLAY,
    series: { 0: { short: 'SSB', upstreamWas: { short: 'SMASH' }, decidedAt: '2026-08-01' } },
  }), []);

  const dangling = validateOverlay({
    ...EMPTY_OVERLAY,
    series: { 0: { label: 'Smash', upstreamWas: { short: 'SMASH' } } },
  });
  assert.match(dangling[0], /no pin beside it/);
});

test('the schema version does not move: the keys are additive', () => {
  // Every file written before these keys existed still validates, so bumping
  // would buy nothing — and the key set is closed either way, so an older
  // checkout rejects a newer file regardless of the number.
  assert.deepEqual(validateOverlay({ ...EMPTY_OVERLAY }), []);
  assert.equal(SCHEMA_VERSION, 1);
});
