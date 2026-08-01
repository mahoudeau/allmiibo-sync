// What an upstream refresh would change, and what each answer writes.
//
// Every case here is built by mutating a real generated database rather than a
// hand-written fixture, because the thing under test is a parser of that exact
// format — and a fixture would drift from what the generator emits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseGenerated, diffDatabases, applyDecisions, bulkDecide, undecided,
} from '../web/js/dbdiff.js';
import { validateOverlay, EMPTY_OVERLAY } from '../web/js/overlay.js';

const DB = readFileSync(new URL('../web/data/amiibo-db.js', import.meta.url), 'utf8');

const MARIO = '0000000000000002';
const OTHER = '0000010000190002';

/** Replace one line of a generated table. */
function edit(text, from, to) {
  assert.ok(text.includes(from), `fixture expects ${from} to be present`);
  return text.replace(from, to);
}

// ---- reading a generated database back ----------------------------------

test('every table round-trips out of the generated file', () => {
  const db = parseGenerated(DB);
  assert.ok(db.names.size > 900, 'the names');
  assert.equal(db.names.get(MARIO), 'Mario');
  assert.ok(db.series.size > 20, 'the series labels');
  assert.equal(db.series.get('0'), 'Super Smash Bros.');
  assert.ok(db.seriesShort.size > 20, 'the folder tokens');
  assert.equal(db.seriesShort.get('0'), 'SSB');
  assert.ok(db.types.size >= 5, 'the types');
});

test('release dates are read, which the CLI parser silently did not', () => {
  // The generator emits names with double quotes and dates with single ones.
  // A parser that only knew about double quotes read every release table as
  // empty — so the CLI reported no date changes ever, rather than none
  // happening. Nothing surfaced it because "no changes" looks like good news.
  const db = parseGenerated(DB);
  assert.ok(db.releases.size > 900, `read ${db.releases.size} dates`);
  assert.match(db.releases.get(MARIO), /^\d{4}-\d{2}-\d{2}$/);

  const doubleQuotedOnly = /'([0-9a-f]{16})': ("(?:[^"\\]|\\.)*")/g;
  const block = DB.split('AMIIBO_RELEASE = Object.freeze({')[1].split('});')[0];
  assert.equal([...block.matchAll(doubleQuotedOnly)].length, 0,
    'and the old pattern really does match none of them');
});

test('a database with a table missing parses as empty rather than throwing', () => {
  const db = parseGenerated('export const AMIIBO_NAMES = Object.freeze({\n});\n');
  assert.equal(db.names.size, 0);
  assert.equal(db.seriesShort.size, 0);
  assert.deepEqual(parseGenerated('').names.size, 0);
  assert.deepEqual(parseGenerated(null).names.size, 0);
});

// ---- what counts as a change --------------------------------------------

test('an ID appearing is added, one disappearing is removed', () => {
  const after = edit(DB, `  '${MARIO}': "Mario",\n`, '');
  const d = diffDatabases(DB, after);

  const removed = d.changes.filter((c) => c.group === 'removed');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].subject, MARIO);
  assert.equal(removed[0].danger, true, 'upstream dropping an entry is not routine');

  // And the other way round.
  const back = diffDatabases(after, DB);
  const added = back.changes.filter((c) => c.group === 'added');
  assert.equal(added.length, 1);
  assert.equal(added[0].subject, MARIO);
  assert.equal(added[0].danger, false, 'an addition costs nothing');
  assert.deepEqual(added[0].choices, ['keep'], 'and there is nothing to decide');
});

test('a name upstream changed is a rename, not an add and a remove', () => {
  const after = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, after);
  assert.equal(d.counts.added, 0);
  assert.equal(d.counts.removed, 0);
  assert.equal(d.counts.renamed, 1);

  const [c] = d.changes.filter((x) => x.group === 'renamed');
  assert.equal(c.before, 'Mario');
  assert.equal(c.after, 'Mario (Classic)');
});

test('a release date changing is reported', () => {
  const db = parseGenerated(DB);
  const was = db.releases.get(MARIO);
  const after = edit(DB, `'${MARIO}': '${was}',`, `'${MARIO}': '1999-01-01',`);
  const d = diffDatabases(DB, after);
  const [c] = d.changes.filter((x) => x.group === 'release');
  assert.equal(c.before, was);
  assert.equal(c.after, '1999-01-01');
});

// ---- naming churn, the dangerous group ----------------------------------

test('a folder token changing is naming churn, with the device paths', () => {
  const after = edit(DB, '  0: "SSB",', '  0: "SMASH",');
  const d = diffDatabases(DB, after);

  const [c] = d.changes.filter((x) => x.kind === 'seriesFolder');
  assert.equal(c.group, 'naming');
  assert.equal(c.danger, true);
  assert.equal(c.before, 'SSB');
  assert.equal(c.after, 'SMASH');
  assert.match(c.device.before, /E:\/amiibo\/SSB\//);
  assert.match(c.device.after, /E:\/amiibo\/SMASH\//);
});

test('a delta row appearing for an EXISTING id is a rename, not a new filename', () => {
  // The bug inherited from the CLI report. AMIIBO_FILE_NAMES carries only the
  // IDs whose filename differs from their display name, so a row appearing
  // there for an ID that already existed means the file on the device is about
  // to be called something else. Comparing the tables key-wise calls that a
  // harmless "new filename".
  const after = DB.replace(
    'export const AMIIBO_FILE_NAMES = Object.freeze({\n',
    `export const AMIIBO_FILE_NAMES = Object.freeze({\n  '${MARIO}': "Mario (Smash)",\n`);

  const d = diffDatabases(DB, after);
  const naming = d.changes.filter((c) => c.group === 'naming' && c.kind === 'fileName');
  assert.equal(naming.length, 1, 'one rename');
  assert.equal(naming[0].subject, MARIO);
  assert.equal(naming[0].before, 'Mario', 'it was named by the display name');
  assert.equal(naming[0].after, 'Mario (Smash)', 'and now it is not');
  assert.equal(naming[0].danger, true);
  assert.match(naming[0].device.before, /\/Mario\.bin$/);
  assert.match(naming[0].device.after, /\/Mario \(Smash\)\.bin$/);
});

test('a delta row disappearing is a rename back, also churn', () => {
  const withRow = DB.replace(
    'export const AMIIBO_FILE_NAMES = Object.freeze({\n',
    `export const AMIIBO_FILE_NAMES = Object.freeze({\n  '${MARIO}': "Mario (Smash)",\n`);
  const d = diffDatabases(withRow, DB);
  const naming = d.changes.filter((c) => c.group === 'naming' && c.kind === 'fileName');
  assert.equal(naming.length, 1);
  assert.equal(naming[0].before, 'Mario (Smash)');
  assert.equal(naming[0].after, 'Mario');
});

test('a delta row for a BRAND NEW id is not churn: there was no file to rename', () => {
  const NEW = 'ffff000000000002';
  const after = DB
    .replace('export const AMIIBO_NAMES = Object.freeze({\n',
      `export const AMIIBO_NAMES = Object.freeze({\n  '${NEW}': "Invented",\n`)
    .replace('export const AMIIBO_FILE_NAMES = Object.freeze({\n',
      `export const AMIIBO_FILE_NAMES = Object.freeze({\n  '${NEW}': "Invented (X)",\n`);

  const d = diffDatabases(DB, after);
  assert.equal(d.changes.filter((c) => c.group === 'naming').length, 0,
    'nothing on any device is being renamed');
  assert.equal(d.changes.filter((c) => c.group === 'added').length, 1);
});

// ---- which answers a change can offer -----------------------------------

test('DISCARD is offered only where there is an edit to discard', () => {
  const after = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);

  const without = diffDatabases(DB, after);
  assert.deepEqual(without.changes.find((c) => c.group === 'renamed').choices,
    ['keep', 'skip'], 'nothing of mine, so nothing to discard');

  const withMine = diffDatabases(DB, after, {
    overlay: { ...EMPTY_OVERLAY, amiibos: { [MARIO]: { kind: 'override', name: 'My Mario' } } },
  });
  const c = withMine.changes.find((x) => x.group === 'renamed');
  assert.deepEqual(c.choices, ['keep', 'discard', 'skip']);
  assert.deepEqual(c.mine, { field: 'name', value: 'My Mario' });
});

// ---- what each answer writes --------------------------------------------

test('KEEP writes nothing at all', () => {
  const after = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const overlay = { ...EMPTY_OVERLAY, amiibos: { [MARIO]: { kind: 'override', name: 'My Mario' } } };
  const d = diffDatabases(DB, after, { overlay });

  const { overlay: next, applied } = applyDecisions(overlay, d, bulkDecide(d, 'all', 'keep'));
  assert.deepEqual(next.amiibos, overlay.amiibos, 'the overlay is untouched');
  assert.ok(applied.kept > 0);
  assert.equal(applied.pinsWritten, 0, 'the safe answer is free');
});

test('DISCARD drops my override so upstream wins from now on', () => {
  const after = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const overlay = { ...EMPTY_OVERLAY, amiibos: { [MARIO]: { kind: 'override', name: 'My Mario' } } };
  const d = diffDatabases(DB, after, { overlay });

  const { overlay: next } = applyDecisions(overlay, d, { [`renamed:${MARIO}`]: 'discard' });
  assert.equal(next.amiibos[MARIO], undefined, 'the entry is gone entirely');
  assert.deepEqual(validateOverlay(next), [], 'and the result still validates');
});

test('SKIP pins what the app shows today, and records what upstream said', () => {
  const after = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, after);

  const { overlay: next, applied } = applyDecisions(
    EMPTY_OVERLAY, d, { [`renamed:${MARIO}`]: 'skip' }, '2026-08-01');

  assert.equal(next.amiibos[MARIO].name, 'Mario', 'the published value is held');
  assert.equal(next.amiibos[MARIO].kind, 'override');
  assert.equal(next.amiibos[MARIO].upstreamWas.name, 'Mario (Classic)',
    'and what it is being held against');
  assert.equal(next.amiibos[MARIO].decidedAt, '2026-08-01');
  assert.equal(applied.pinsWritten, 1);
  assert.deepEqual(validateOverlay(next), []);
});

test('SKIP on a folder token pins the series, not the amiibo', () => {
  const after = edit(DB, '  0: "SSB",', '  0: "SMASH",');
  const d = diffDatabases(DB, after);

  const { overlay: next } = applyDecisions(EMPTY_OVERLAY, d, { 'naming:seriesFolder:0': 'skip' });
  assert.equal(next.series[0].short, 'SSB', 'the folder on the device does not move');
  assert.equal(next.series[0].upstreamWas.short, 'SMASH');
  assert.deepEqual(validateOverlay(next), []);
});

test('SKIP on a removal keeps the amiibo by authoring it', () => {
  // Upstream dropped it. The only way to keep it in the library is to say it
  // exists on your own authority, which is exactly what kind:'new' means.
  const after = edit(DB, `  '${MARIO}': "Mario",\n`, '');
  const d = diffDatabases(DB, after);

  const { overlay: next } = applyDecisions(EMPTY_OVERLAY, d, { [`removed:${MARIO}`]: 'skip' });
  assert.equal(next.amiibos[MARIO].kind, 'new');
  assert.equal(next.amiibos[MARIO].name, 'Mario');
  assert.deepEqual(validateOverlay(next), []);
});

test('the input overlay is never mutated', () => {
  const after = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const overlay = { ...EMPTY_OVERLAY, amiibos: { [MARIO]: { kind: 'override', name: 'Mine' } } };
  const snapshot = JSON.stringify(overlay);
  const d = diffDatabases(DB, after, { overlay });

  applyDecisions(overlay, d, { [`renamed:${MARIO}`]: 'discard' });
  applyDecisions(overlay, d, { [`renamed:${MARIO}`]: 'skip' });
  assert.equal(JSON.stringify(overlay), snapshot);
});

// ---- bulk answers and the gate ------------------------------------------

test('ACCEPT EVERYTHING SAFE leaves every dangerous change undecided', () => {
  // The teeth of the whole screen: the only way to accept a device-wide rename
  // or a removal is to touch it.
  const after = edit(
    edit(DB, '  0: "SSB",', '  0: "SMASH",'),
    `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, after);
  assert.ok(d.counts.danger > 0, 'there is something dangerous to leave alone');

  const safe = bulkDecide(d, 'safe');
  const left = undecided(d, safe);
  assert.equal(left.length, d.counts.danger, 'exactly the dangerous ones remain');
  for (const key of left) {
    assert.equal(d.changes.find((c) => c.key === key).danger, true);
  }
});

test('an addition never blocks apply, because there is nothing to decide', () => {
  const NEW = 'ffff000000000002';
  const after = DB.replace('export const AMIIBO_NAMES = Object.freeze({\n',
    `export const AMIIBO_NAMES = Object.freeze({\n  '${NEW}': "Invented",\n`);
  const d = diffDatabases(DB, after);
  assert.equal(d.counts.added, 1);
  assert.deepEqual(undecided(d, {}), [], 'nothing is required');
});

test('a decision naming a change that is not there is ignored, not guessed at', () => {
  const after = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, after);
  const { overlay: next, applied } = applyDecisions(
    EMPTY_OVERLAY, d, { 'renamed:deadbeefdeadbeef': 'skip' });
  assert.deepEqual(next.amiibos, {});
  assert.equal(applied.pinsWritten, 0);
});

// ---- overlay health -----------------------------------------------------

test('an override pointing at an ID upstream dropped is reported as orphaned', () => {
  const after = edit(DB, `  '${MARIO}': "Mario",\n`, '');
  const d = diffDatabases(DB, after, {
    overlay: {
      ...EMPTY_OVERLAY,
      amiibos: { [MARIO]: { kind: 'override', name: 'Mine' } },
      categories: { fav: { label: 'Favourites', members: [MARIO, OTHER] } },
    },
  });
  assert.equal(d.orphans.filter((o) => o.kind === 'amiibo').length, 1);
  assert.equal(d.orphans.filter((o) => o.kind === 'category').length, 1);
  assert.equal(d.counts.orphans, 2);
});

test('an authored amiibo is not orphaned by upstream not having it', () => {
  // That is the entire point of authoring one.
  const NEW = 'ffff000000000002';
  const d = diffDatabases(DB, DB, {
    overlay: { ...EMPTY_OVERLAY, amiibos: { [NEW]: { kind: 'new', name: 'Invented' } } },
  });
  assert.deepEqual(d.orphans, []);
});

// ---- the file can fail --------------------------------------------------

test('these checks fail on the mistakes they were written for', () => {
  // 1. Key-wise naming diff: a delta row appearing for an existing ID read as
  //    a harmless addition rather than a device-side rename.
  const after = DB.replace('export const AMIIBO_FILE_NAMES = Object.freeze({\n',
    `export const AMIIBO_FILE_NAMES = Object.freeze({\n  '${MARIO}': "Mario (Smash)",\n`);
  const keyWise = { fresh: [MARIO] };   // what the old comparison produced
  assert.throws(
    () => assert.equal(keyWise.fresh.length, 0, 'a rename must not read as an addition'),
    /must not read as an addition/);
  assert.equal(diffDatabases(DB, after).counts.naming, 1, 'and the real diff calls it churn');

  // 2. A release parser that only matches double quotes reads nothing.
  const block = DB.split('AMIIBO_RELEASE = Object.freeze({')[1].split('});')[0];
  assert.throws(
    () => assert.ok([...block.matchAll(/'([0-9a-f]{16})': ("[^"]*")/g)].length > 0,
      'a double-quote-only parser must find no dates'),
    /must find no dates/);

  // 3. SKIP that forgot to record what upstream said leaves a pin nobody can
  //    later classify as holding, moot or stale.
  const renamed = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, renamed);
  const { overlay: next } = applyDecisions(EMPTY_OVERLAY, d, { [`renamed:${MARIO}`]: 'skip' });
  assert.throws(
    () => assert.equal(next.amiibos[MARIO].upstreamWas, undefined),
    /strictly equal/,
    'the record must be there');
});
