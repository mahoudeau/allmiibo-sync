// The upstream parsers and the name derivation.
//
// This logic used to live inside tools/build-amiibo-db.mjs, where nothing could
// reach it: the database has been generated from it for months with no direct
// test at all. It now lives in web/js/dbsource.js so the generator, the admin
// server and the admin's preview screen all run the same code, and this is where
// that code is pinned.
//
// Fixtures are hand-written and tiny. The real sources land in tools/.cache/,
// which is gitignored, so they cannot be used here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseFirmwareTable,
  parseAmiiboApi,
  mergeSources,
  initialism,
  abbreviate,
  assignSeriesShort,
  disambiguate,
  buildNameTables,
  findNameCollisions,
  seriesByteOf,
  sortNum,
} from '../web/js/dbsource.js';
import {
  AMIIBO_NAMES,
  AMIIBO_FILE_NAMES,
  AMIIBO_SHORT_NAMES,
} from '../web/data/amiibo-db.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const FIRMWARE = fixture('db_amiibo.min.c');
const API = JSON.parse(fixture('amiibo.min.json'));

// ---- the firmware table -------------------------------------------------

test('rows become 16-character lowercase IDs', () => {
  const names = parseFirmwareTable(FIRMWARE);
  assert.equal(names.get('0000000000000002'), 'Mario');
  assert.equal(names.get('00010000000c0002'), 'Luigi');
  for (const id of names.keys()) assert.match(id, /^[0-9a-f]{16}$/);
});

test('uppercase hex in the source is lowercased', () => {
  // The ID is the join of two hex words and is compared as a string everywhere,
  // so a stray uppercase digit would silently create a second, unmatchable entry.
  const names = parseFirmwareTable(FIRMWARE);
  assert.equal(names.get('0abc000000de0002'), 'Uppercase Hex');
  assert.equal(names.get('0ABC000000DE0002'), undefined);
});

test('an escaped quote inside a name is unescaped', () => {
  assert.equal(parseFirmwareTable(FIRMWARE).get('0181000100440502'), 'Isabelle "Summer"');
});

test('non-ASCII names survive intact', () => {
  const name = parseFirmwareTable(FIRMWARE).get('1d00000004220002');
  assert.equal(name, 'Tatsuhisa Kamijō');
  assert.equal(Buffer.byteLength(name), name.length + 1, 'the ō is two bytes');
});

test('malformed rows are skipped without throwing, and parsing continues', () => {
  const names = parseFirmwareTable(FIRMWARE);
  assert.equal(names.get('0002000000010002'), undefined, 'a row missing a field');
  assert.equal(names.get('0003000000020002'), undefined, 'a row missing its brace');
  assert.equal(names.get('0004000000030002'), 'After The Mess', 'parsing recovered');
});

test('parsing is repeatable, so a shared /g regex cannot leak state', () => {
  assert.deepEqual([...parseFirmwareTable(FIRMWARE)], [...parseFirmwareTable(FIRMWARE)]);
});

// ---- the API ------------------------------------------------------------

test('series and type bytes are parsed from their hex keys', () => {
  const api = parseAmiiboApi(API);
  assert.equal(api.series[0], 'Super Smash Bros.');
  assert.equal(api.series[5], 'Animal Crossing');
  assert.equal(api.types[1], 'Card');
});

test('the earliest regional release wins, whatever order it is listed in', () => {
  // Mario lists na 2014-11-21, jp 2014-12-06, eu 2014-11-28.
  assert.equal(parseAmiiboApi(API).releases.get('0000000000000002'), '2014-11-21');
});

test('null and empty release blocks yield no date rather than a bad one', () => {
  const api = parseAmiiboApi(API);
  assert.equal(api.releases.get('9999000000000002'), '2020-01-02', 'nulls are filtered out');
  assert.equal(api.releases.get('8888000000000002'), undefined, 'no dates at all');
});

// ---- merging ------------------------------------------------------------

test('the firmware name wins where both sources have one', () => {
  // pixl.js is more specific: "[AC] 001 - Isabelle" rather than "Isabelle".
  const merged = mergeSources(parseFirmwareTable(FIRMWARE), parseAmiiboApi(API));
  assert.equal(merged.names.get('0000000000000002'), 'Mario');
});

test('the API fills IDs the firmware table does not carry', () => {
  const merged = mergeSources(parseFirmwareTable(FIRMWARE), parseAmiiboApi(API));
  assert.equal(merged.names.get('9999000000000002'), 'Only In The API');
});

test('merging without an API gives names only', () => {
  const merged = mergeSources(parseFirmwareTable(FIRMWARE), null);
  assert.ok(merged.names.size > 0);
  assert.deepEqual(merged.series, {});
  assert.equal(merged.releases.size, 0);
});

test('series and type tables come out in ascending numeric order', () => {
  const keys = Object.keys(sortNum({ 30: 'c', 2: 'a', 255: 'd', 9: 'b' }));
  assert.deepEqual(keys, ['2', '9', '30', '255']);
});

// ---- derivation ---------------------------------------------------------

test('an initialism takes word initials and keeps digits whole', () => {
  assert.equal(initialism('Mario Sports Superstars'), 'MSS');
  assert.equal(initialism('Street Fighter 6'), 'SF6');
  assert.equal(initialism('Xenoblade Chronicles 3'), 'XC3');
  assert.equal(initialism("Yoshi's Woolly World"), 'YSWW');
});

test('a single word has no useful initialism', () => {
  // "S" would serve both Splatoon and Skylanders.
  assert.equal(initialism('Splatoon'), null);
  assert.equal(initialism('Kirby'), null);
});

test('abbreviation shortens the tail after the last separator', () => {
  assert.equal(abbreviate('Pink Gold Peach - Horse Racing'), 'Pink Gold Peach - HR');
  assert.equal(abbreviate('Link - Ocarina Of Time'), 'Link - OOT');
});

test('abbreviation declines when there is nothing to gain', () => {
  assert.equal(abbreviate('Mario'), null, 'no separator');
  assert.equal(abbreviate('Mario - Wedding'), null, 'a single-word tail');
});

test('a committed series token is preserved even when the label changes', () => {
  // This is the stability rule: a changed token renames a folder on every
  // synced device, so upstream rewording must not move it.
  const short = assignSeriesShort({ 14: 'Mario Sports Superstars Deluxe' }, { 14: 'MSS' });
  assert.equal(short[14], 'MSS');
});

test('a new series mints a token, and a newcomer gives way on a clash', () => {
  const short = assignSeriesShort({ 0: 'Super Smash Bros.', 1: 'Super Simple Bros.' }, {});
  assert.equal(short[0], 'SSB');
  assert.notEqual(short[1], 'SSB', 'the second must not take the same token');
  assert.equal(short[1], 'Super Simple Bros.', 'it falls back to the full label');
});

test('a single-word series keeps its full label as the token', () => {
  assert.equal(assignSeriesShort({ 4: 'Splatoon' }, {})[4], 'Splatoon');
});

test('a pin overrides even the stability rule', () => {
  // The only way to correct a token that was minted badly.
  const short = assignSeriesShort({ 30: 'Kirby Air Riders' }, { 30: 'OLD' }, { 30: 'KAR' });
  assert.equal(short[30], 'KAR');
});

// ---- disambiguation -----------------------------------------------------

const entriesOf = (obj) => Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0]));

test('a duplicate name is resolved by figure type first', () => {
  // Same character, one Figure and one Card: the Figure keeps the plain name.
  const entries = entriesOf({
    '34c2000004aa1d02': 'Luke', // type 00 = Figure
    '34c2000104cd1d02': 'Luke', // type 01 = Card
  });
  const { suffixes, rules } = disambiguate(entries, { types: { 0: 'Figure', 1: 'Card' } });
  assert.equal(suffixes.get('34c2000004aa1d02'), '');
  assert.equal(suffixes.get('34c2000104cd1d02'), ' (Card)');
  assert.equal(rules[0].rule, 'figure type');
});

test('then by character variant', () => {
  const entries = entriesOf({
    '3509000004101802': 'Palico', // variant 00
    '35090100042b1802': 'Palico', // variant 01
  });
  const { suffixes, rules } = disambiguate(entries, {});
  assert.equal(suffixes.get('3509000004101802'), '');
  assert.equal(suffixes.get('35090100042b1802'), ' v2');
  assert.equal(rules[0].rule, 'character variant');
});

test('and finally by model number, for two printings of one card', () => {
  const entries = entriesOf({
    '3c80000104e81d02': 'Terry',
    '3c80000104f11d02': 'Terry',
  });
  const { suffixes, rules } = disambiguate(entries, {});
  assert.equal(suffixes.get('3c80000104e81d02'), ' 04e8');
  assert.equal(suffixes.get('3c80000104f11d02'), ' 04f1');
  assert.equal(rules[0].rule, 'model number');
});

test('the same name in different series is not a clash', () => {
  const entries = entriesOf({
    '0000000000000002': 'Mario', // series 00
    '0000000000340102': 'Mario', // series 01
  });
  const { suffixes, rules } = disambiguate(entries, {});
  assert.equal(suffixes.get('0000000000000002'), '');
  assert.equal(suffixes.get('0000000000340102'), '');
  assert.deepEqual(rules, [], 'different folders, no disambiguation needed');
});

// ---- the delta tables and the collision gate ----------------------------

test('name tables carry only the rows that differ', () => {
  const entries = entriesOf({
    '0000000000000002': 'Mario',
    '0e01000102c20e02': 'Pink Gold Peach - Horse Racing',
  });
  const { suffixes } = disambiguate(entries, {});
  const { fileNames, shortNames } = buildNameTables(entries, suffixes);
  assert.equal(fileNames.size, 0, 'no name needed disambiguating');
  assert.equal(shortNames.get('0e01000102c20e02'), 'Pink Gold Peach - HR');
  assert.equal(shortNames.has('0000000000000002'), false, 'short enough already');
});

test('a collision no rule can resolve is reported rather than emitted', () => {
  // Same series, name, type, variant and model number: every rule is exhausted.
  const entries = entriesOf({
    aaaa000001110002: 'Twin',
    bbbb000001110002: 'Twin',
  });
  const names = new Map(entries);
  const { suffixes } = disambiguate(entries, {});
  const { fileNames, shortNames } = buildNameTables(entries, suffixes);
  const clashes = findNameCollisions(entries, { fileNames, shortNames, names });
  assert.ok(clashes.length > 0);
  assert.deepEqual(clashes[0].kind, 'filename');
  assert.equal(clashes[0].value, 'Twin 0111');
});

test('the committed database has no collisions, checked through this function', () => {
  // test/db.test.mjs asserts the same property with its own inline check. This
  // proves the shared function the generator gates on agrees with it, so the two
  // cannot drift apart and quietly stop protecting the same thing.
  const entries = Object.entries(AMIIBO_NAMES).sort((a, b) => a[0].localeCompare(b[0]));
  const clashes = findNameCollisions(entries, {
    names: new Map(entries),
    fileNames: new Map(Object.entries(AMIIBO_FILE_NAMES)),
    shortNames: new Map(Object.entries(AMIIBO_SHORT_NAMES)),
  });
  assert.deepEqual(clashes, [], 'all 946 entries are uniquely named within their series');
  assert.equal(entries.length, 946, 'and the check actually ran over the whole table');
});

test('the series byte is byte 6 of the ID', () => {
  assert.equal(seriesByteOf('0000000000000002'), 0x00);
  assert.equal(seriesByteOf('1f00000004c41e03'), 0x1e);
  assert.equal(seriesByteOf('00000003039bff02'), 0xff);
});
