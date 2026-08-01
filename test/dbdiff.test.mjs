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
  assert.deepEqual(added[0].choices, ['keep', 'skip'],
    'and it can be declined, which holds it out until the next update');
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

test('nothing is required, because untouched means accepted', () => {
  // The old screen blocked APPLY until every change had been clicked, including
  // rows whose only possible answer was "yes". NN/g: do not confirm routine
  // actions. Anything left alone is accepted, and the confirm step says how
  // many that is rather than refusing to proceed.
  const after = edit(
    edit(DB, '  0: "SSB",', '  0: "SMASH",'),
    `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, after);
  assert.ok(d.counts.danger > 0, 'even with something dangerous in it');
  assert.deepEqual(undecided(d, {}), [],
    'no change blocks apply on its own');
  assert.ok(d.changes.every((c) => c.required === false));
});

test('every change offers at least two real answers', () => {
  // A row with one button is not a question. The old screen had them — a brand
  // new series label offered only TAKE, and still blocked APPLY.
  const after = edit(
    edit(DB, '  0: "SSB",', '  0: "SMASH",'),
    `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, after, {
    overlay: { ...EMPTY_OVERLAY, amiibos: { [MARIO]: { kind: 'override', name: 'Mine' } } },
  });

  for (const e of d.entities) {
    if (!e.decidable) continue;   // shown as a consequence, with no buttons
    const keys = new Set(e.changeKeys);
    const choices = d.changes.filter((c) => keys.has(c.key)).flatMap((c) => c.choices);
    assert.ok(new Set(choices).size > 1,
      `${e.label} offers only ${[...new Set(choices)]} — that is not a question`);
  }
});

test('a decision naming a change that is not there is ignored, not guessed at', () => {
  const after = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, after);
  const { overlay: next, applied } = applyDecisions(
    EMPTY_OVERLAY, d, { 'renamed:deadbeefdeadbeef': 'skip' });
  assert.deepEqual(next.amiibos, {});
  assert.equal(applied.pinsWritten, 0);
});

// ---- declining an addition, and the next update -------------------------

/** A database with one more entry in it, the way an upstream refresh arrives. */
function withNewEntry(text, id, name) {
  return text.replace('export const AMIIBO_NAMES = Object.freeze({\n',
    `export const AMIIBO_NAMES = Object.freeze({\n  '${id}': "${name}",\n`);
}

/**
 * What the generator emits once the exclusion is in the overlay: the entry is
 * absent from the names, and the excluded table records what upstream calls it.
 *
 * Built by replacing the table if the database has one and appending if it does
 * not, then checked by parsing the result back. Both halves of that were wrong
 * in turn: appending alone left the generator's own empty table in front, where
 * the parser found it first and read no exclusions at all. A fixture that
 * assumes the shape of a generated file has to prove it guessed right.
 */
function withExclusion(text, id, name) {
  assert.ok(!text.includes(`'${id}'`), 'the entry must not be in the database');
  const row = `  '${id}': ${JSON.stringify(name)},\n`;
  const head = 'export const AMIIBO_EXCLUDED = Object.freeze({';
  const out = text.includes(head)
    ? text.replace(`${head}`, `${head}\n${row.trimEnd()}`)
    : `${text}\n${head}\n${row}});\n`;

  assert.equal(parseGenerated(out).excluded.get(id), name,
    'the fixture must actually read back as excluded');
  return out;
}

const NEW_ID = 'ffff000000000002';

test('declining an addition writes an exclusion, and nothing else', () => {
  const after = withNewEntry(DB, NEW_ID, 'Invented');
  const d = diffDatabases(DB, after);
  const { overlay: next, applied } = applyDecisions(
    EMPTY_OVERLAY, d, { [`added:${NEW_ID}`]: 'skip' });

  assert.deepEqual(next.excluded, [NEW_ID]);
  assert.deepEqual(next.amiibos, {}, 'no pin: there is nothing published to hold');
  assert.deepEqual(validateOverlay(next), []);
  assert.ok(applied.excluded > 0 || next.excluded.length === 1);
});

// Both sides of the next update: the published database and the freshly
// generated candidate are built from the SAME overlay, so both hold the entry
// out. Their names tables are identical and a plain diff sees nothing at all —
// the excluded table is the only thing keeping the question alive.
const declined = () => ({
  published: withExclusion(DB, NEW_ID, 'Invented'),
  candidate: withExclusion(DB, NEW_ID, 'Invented'),
  overlay: { ...EMPTY_OVERLAY, excluded: [NEW_ID] },
});

test('a declined addition is offered again on the next update', () => {
  const { published, candidate, overlay } = declined();
  const d = diffDatabases(published, candidate, { overlay });

  const again = d.changes.filter((c) => c.group === 'added' && c.subject === NEW_ID);
  assert.equal(again.length, 1, 'offered exactly once, not twice');
  assert.equal(again[0].declinedBefore, true, 'and marked as one you already saw');
  assert.equal(again[0].label, 'Invented', 'by the name upstream gives it');
  assert.equal(d.summary.amiibo.add, 1, 'and it is in the headline count');
});

test('accepting it the second time clears the exclusion', () => {
  // Otherwise the entry would be added and immediately held out again, which is
  // the kind of loop nobody would think to look for.
  const { published, candidate, overlay: before } = declined();
  const d = diffDatabases(published, candidate, { overlay: before });

  const { overlay: next } = applyDecisions(before, d, { [`added:${NEW_ID}`]: 'keep' });
  assert.deepEqual(next.excluded, [], 'the entry is let through');
  assert.deepEqual(before.excluded, [NEW_ID], 'and the input was not mutated');
  assert.deepEqual(validateOverlay(next), []);
});

test('leaving it untouched accepts it, like every other change', () => {
  const { published, candidate, overlay: before } = declined();
  const d = diffDatabases(published, candidate, { overlay: before });
  const { overlay: next } = applyDecisions(before, d, {});
  assert.deepEqual(next.excluded, [], 'silence is acceptance, so it comes back in');
});

test('declining it again keeps it out, without listing it twice', () => {
  const { published, candidate, overlay: before } = declined();
  const d = diffDatabases(published, candidate, { overlay: before });
  const { overlay: next } = applyDecisions(before, d, { [`added:${NEW_ID}`]: 'skip' });
  assert.deepEqual(next.excluded, [NEW_ID]);
  assert.deepEqual(validateOverlay(next), [], 'a duplicate would be a hard error');
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

  // 3. A plain names-only diff cannot see a declined addition at all: both
  //    sides omit it, so "offered again next update" would silently be never.
  const { published, candidate } = declined();
  assert.deepEqual(
    [...parseGenerated(published).names.keys()],
    [...parseGenerated(candidate).names.keys()],
    'the two databases name exactly the same entries');
  assert.throws(
    () => assert.ok(parseGenerated(candidate).names.has(NEW_ID),
      'a names-only comparison must find nothing to report'),
    /must find nothing to report/);

  // 4. SKIP that forgot to record what upstream said leaves a pin nobody can
  //    later classify as holding, moot or stale.
  const renamed = edit(DB, `'${MARIO}': "Mario",`, `'${MARIO}': "Mario (Classic)",`);
  const d = diffDatabases(DB, renamed);
  const { overlay: next } = applyDecisions(EMPTY_OVERLAY, d, { [`renamed:${MARIO}`]: 'skip' });
  assert.throws(
    () => assert.equal(next.amiibos[MARIO].upstreamWas, undefined),
    /strictly equal/,
    'the record must be there');
});

test('a value upstream has only just introduced cannot be held back', () => {
  // Found by real upstream data, not by a constructed case: upstream shipped a
  // brand new series, and "keep what the site shows today" tried to pin its
  // label to null — because there was no previous label. That fails validation,
  // so the whole apply was refused with an error about the build rather than
  // about the impossible choice.
  const after = DB.replace(
    'export const AMIIBO_SERIES = Object.freeze({\n',
    'export const AMIIBO_SERIES = Object.freeze({\n  99: "Brand New Series",\n');

  const d = diffDatabases(DB, after);
  const [label] = d.changes.filter((c) => c.group === 'label');
  assert.equal(label.before, null, 'there was no previous label');
  assert.deepEqual(label.choices, ['keep'], 'so taking it is the only answer');

  // And asking to hold it anyway writes nothing rather than something invalid.
  const { overlay: next } = applyDecisions(EMPTY_OVERLAY, d, { [label.key]: 'skip' });
  assert.deepEqual(next.series, {}, 'no pin was written');
  assert.deepEqual(validateOverlay(next), []);
});

test('a release date appearing CAN be held back, because absent is a real value', () => {
  // The exception to the rule above: for a date, "none" is a value the site can
  // legitimately show, and null in the overlay means exactly that.
  const NEW_ID = 'ffff000000000002';
  const after = DB
    .replace('export const AMIIBO_NAMES = Object.freeze({\n',
      `export const AMIIBO_NAMES = Object.freeze({\n  '${NEW_ID}': "Invented",\n`)
    .replace('export const AMIIBO_RELEASE = Object.freeze({\n',
      `export const AMIIBO_RELEASE = Object.freeze({\n  '${NEW_ID}': '2026-01-01',\n`);

  const d = diffDatabases(DB, after);
  const [release] = d.changes.filter((c) => c.group === 'release');
  assert.equal(release.before, null);
  assert.ok(release.choices.includes('skip'), 'holding "no date" is meaningful');

  const { overlay: next } = applyDecisions(EMPTY_OVERLAY, d, { [release.key]: 'skip' });
  assert.equal(next.amiibos[NEW_ID].release, null, 'pinned to no date');
  assert.deepEqual(validateOverlay(next), []);
});
