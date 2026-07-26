// Amiibo identity tests. The offsets and field layout are verified against
// real dumps in tools/, so these lock the behaviour in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAmiiboId,
  decodeAmiiboId,
  amiiboName,
  buildCollection,
  AMIIBO_ID_OFFSET,
  parseVehicle,
  characterName,
  hasVehicles,
  amiiboVersion,
  KNOWN_VEHICLES,
  VEHICLE_CODE_OFFSET,
  VEHICLE_FLAG_OFFSET,
} from '../web/js/amiibo.js';

// A minimal stand-in for a dump: 540 bytes with an ID at offset 84.
function dump(idHex, size = 540) {
  const u = new Uint8Array(size);
  u[0] = 0x04; // NXP manufacturer byte, as in every real dump
  const id = Uint8Array.from(idHex.match(/../g).map((h) => parseInt(h, 16)));
  u.set(id, AMIIBO_ID_OFFSET);
  return u;
}

test('the amiibo ID is read from bytes 84..91', () => {
  assert.equal(parseAmiiboId(dump('0181000100440502')), '0181000100440502');
});

test('bytes that are not an amiibo dump yield no ID', () => {
  const junk = new Uint8Array(540); // trailing ID byte is 0x00, not 0x02
  assert.equal(parseAmiiboId(junk), null);
});

test('a short buffer does not throw', () => {
  assert.equal(parseAmiiboId(new Uint8Array(10)), null);
});

test('the documented field layout decodes', () => {
  // Real Isabelle card from a verified collection.
  const d = decodeAmiiboId('0181000100440502');
  assert.equal(d.type, 0x01);
  assert.equal(d.typeName, 'Card');
  assert.equal(d.series, 0x05);
  assert.equal(d.seriesName, 'Animal Crossing');
});

test('a figure decodes as a figure', () => {
  const d = decodeAmiiboId('0000000000000002');
  assert.equal(d.typeName, 'Figure');
  assert.equal(d.seriesName, 'Super Smash Bros.');
});

test('names come from the vendored database', () => {
  assert.equal(amiiboName('0181000100440502'), '[AC] 001 - Isabelle');
  assert.equal(amiiboName('ffffffffffffffff'), null);
});

test('the collection marks owned and missing per series', () => {
  const c = buildCollection(new Set(['0181000100440502']));
  const ac = c.series.find((s) => s.seriesName === 'Animal Crossing');
  const isabelle = ac.items.find((i) => i.id === '0181000100440502');

  assert.equal(isabelle.hasLocal, true);
  assert.ok(ac.total > ac.ownedLocal, 'the rest of the series should read as missing');
  assert.equal(c.stats.ownedLocal, 1);
  assert.ok(c.stats.missingLocal > 900);
});

test('an owned amiibo absent from the database is still listed', () => {
  // The HHD item-card ID: a real dump that no amiibo database will ever list.
  // It is a curated outlier — recognised by name and NOT counted as "not in
  // the database", because 91 well-known cards sharing one ID is not news.
  const c = buildCollection(new Set(['026a000100000502']));
  const all = c.series.flatMap((s) => s.items);
  const extra = all.find((i) => i.id === '026a000100000502');

  assert.ok(extra, 'unlisted amiibos must still appear');
  assert.equal(extra.inDatabase, false);
  assert.equal(extra.special, 'hhd-items');
  assert.equal(extra.hasLocal, true);
  assert.equal(c.stats.notInDatabase, 0);
});

test('a genuinely unknown amiibo still counts as not-in-database', () => {
  // A non-HHD head that the database has never seen.
  const c = buildCollection(new Set(['0999000109990502']));
  assert.equal(c.stats.notInDatabase, 1);
});

test('device ownership is tracked separately from local', () => {
  const c = buildCollection(new Set(['0181000100440502']), new Set(['0183000100450502']));
  const all = c.series.flatMap((s) => s.items);
  assert.equal(all.find((i) => i.id === '0181000100440502').hasDevice, false);
  assert.equal(all.find((i) => i.id === '0183000100450502').hasDevice, true);
  assert.equal(c.stats.ownedDevice, 1);
});

test('series labels come from the authoritative table', () => {
  // A hand-derived table had these wrong; they are worth pinning down.
  assert.equal(decodeAmiiboId('000000000000ff02').seriesName, 'Super Nintendo World');
  assert.equal(decodeAmiiboId('0000000000001c02').seriesName, 'My Mario Wooden Blocks');
  assert.equal(decodeAmiiboId('0000000000001e02').seriesName, 'Kirby Air Riders');
  assert.equal(decodeAmiiboId('0000000000000f02').seriesName, 'Monster Hunter');
});

test('an unknown series byte degrades to the raw value rather than guessing', () => {
  assert.equal(decodeAmiiboId('0000000000002f02').seriesName, 'Series 0x2f');
});

test('the Block figure type is known', () => {
  assert.equal(decodeAmiiboId('0000000400000002').typeName, 'Block');
});

// ---- v3 dumps (NTAG I2C 2K) --------------------------------------------

test('a v3 dump parses even though its trailing ID byte is 0x03', () => {
  // Kirby Air Riders. An earlier version required 0x02 here and rejected the
  // whole series; the trailing byte is an amiibo format version, not a
  // constant.
  const u = new Uint8Array(2048);
  u[0] = 0x04;
  u.set(Uint8Array.from('1f00000004c41e03'.match(/../g).map((h) => parseInt(h, 16))), 84);
  assert.equal(parseAmiiboId(u), '1f00000004c41e03');
});

test('v3 series and name resolve', () => {
  assert.equal(decodeAmiiboId('1f00000004c41e03').seriesName, 'Kirby Air Riders');
  assert.equal(amiiboName('1f00000004c41e03'), 'Kirby');
  assert.equal(amiiboName('1f03010004c91e03'), 'Bandana Waddle Dee');
});

test('a file of an unrecognised length is not treated as a dump', () => {
  // key_retail.bin is 160 bytes; settings.bin 17. Neither is an amiibo.
  assert.equal(parseAmiiboId(new Uint8Array(160)), null);
  assert.equal(parseAmiiboId(new Uint8Array(17)), null);
});

test('the vehicle is read from the SRAM buffer of a v3 dump', () => {
  const u = new Uint8Array(2048);
  u.set(Uint8Array.from('PB4W17', (c) => c.charCodeAt(0)), VEHICLE_CODE_OFFSET);
  u[VEHICLE_FLAG_OFFSET] = 0x02;
  assert.deepEqual(parseVehicle(u), { code: 'PB4W17:02', name: 'Warp Star' });

  u[VEHICLE_FLAG_OFFSET] = 0x04;
  assert.equal(parseVehicle(u).name, 'Winged Star');
});

test('an uncatalogued vehicle returns its code rather than nothing', () => {
  const u = new Uint8Array(2048);
  u.set(Uint8Array.from('PZ9Q99', (c) => c.charCodeAt(0)), VEHICLE_CODE_OFFSET);
  u[VEHICLE_FLAG_OFFSET] = 0x07;
  assert.deepEqual(parseVehicle(u), { code: 'PZ9Q99:07', name: null });
});

test('non-v3 dumps carry no vehicle', () => {
  assert.equal(parseVehicle(new Uint8Array(540)), null);
});

test('an ID absent from the database is named through its character head', () => {
  // A fabricated tail on a real character head: the exact ID is unknown, the
  // character is not.
  assert.equal(characterName('1f010000deadbe03'), 'Meta Knight');
  assert.equal(characterName('00000000deadbe02'), 'Mario');
});

test('a head shared by variants resolves to the base character', () => {
  // 00000000 covers Mario, Mario - Gold Edition, Mario - Wedding, ...
  assert.equal(characterName('0000000000340102'), 'Mario');
});

test('an entirely unknown head yields nothing rather than a guess', () => {
  assert.equal(characterName('abcdef0000000002'), null);
});

test('the collection names unlisted amiibos by character, marked as a guess', () => {
  const id = '1f010000deadbe03'; // unknown tail, known Meta Knight head
  const c = buildCollection(new Set([id]));
  const item = c.series.flatMap((s) => s.items).find((i) => i.id === id);
  assert.equal(item.name, 'Meta Knight');
  assert.equal(item.nameSource, 'inferred');
  assert.equal(item.inDatabase, false, 'still flagged as absent from the database');
});

test('the character in the ID outranks a filename', () => {
  // A filename gave "MK+" where the ID says Meta Knight. The dump beats the
  // typing.
  const id = '1f010000deadbe03';
  const c = buildCollection(new Set([id]), null, { nameHints: new Map([[id, 'MK+']]) });
  const item = c.series.flatMap((s) => s.items).find((i) => i.id === id);
  assert.equal(item.name, 'Meta Knight');
  assert.equal(item.nameSource, 'inferred');
});

test('a filename is used when the character is genuinely unknown', () => {
  const id = 'abcdef0004c10102'; // head unknown to the database
  const c = buildCollection(new Set([id]), null, { nameHints: new Map([[id, 'Elephant Mario']]) });
  const item = c.series.flatMap((s) => s.items).find((i) => i.id === id);
  assert.equal(item.name, 'Elephant Mario');
  assert.equal(item.nameSource, 'filename');
});

test('the HHD card set gets its curated name, never Stinky, never a guess', () => {
  // 91 Animal Crossing item cards share head 026a0001 with the villager
  // Stinky. They are not Stinky — and they are not a filename guess either:
  // the set is a known outlier with a curated identity.
  const id = '026a000100000502';
  const c = buildCollection(new Set([id]), null, {
    nameHints: new Map([[id, 'HHD Items']]),
    dumpCounts: new Map([[id, 91]]),
  });
  const item = c.series.flatMap((s) => s.items).find((i) => i.id === id);
  assert.equal(item.name, 'Happy Home Designer cards');
  assert.equal(item.nameSource, 'curated');
  assert.equal(item.typeName, 'Card');
});

test('a database name is never overridden by a hint', () => {
  const id = '0181000100440502';
  const c = buildCollection(new Set([id]), null, { nameHints: new Map([[id, 'Nonsense']]) });
  const item = c.series.flatMap((s) => s.items).find((i) => i.id === id);
  assert.equal(item.name, '[AC] 001 - Isabelle');
  assert.equal(item.nameSource, 'database');
});

test('vehicles apply to the Kirby Air Riders series', () => {
  assert.equal(hasVehicles('1f00000004c41e03'), true);  // Kirby, Air Riders
  assert.equal(hasVehicles('1f01000004c61e03'), true);  // Meta Knight
  assert.equal(hasVehicles('0181000100440502'), false); // Isabelle, Animal Crossing
});

test('the vehicle line-up is the full known set, so it reads as a checklist', () => {
  assert.deepEqual(KNOWN_VEHICLES, ['Shadow Star', 'Tank Star', 'Warp Star', 'Winged Star']);
});

test('the amiibo format version is byte 7', () => {
  assert.equal(amiiboVersion('1f00000004c41e03'), 3);
  assert.equal(amiiboVersion('0181000100440502'), 2);
});

test('release dates exist for every database entry, in sortable form', async () => {
  const { AMIIBO_RELEASE } = await import('../web/data/amiibo-db.js');
  const entries = Object.entries(AMIIBO_RELEASE);
  assert.ok(entries.length >= 900, `${entries.length} dates`);
  for (const [id, date] of entries) {
    assert.match(id, /^[0-9a-f]{16}$/);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${id}: ${date}`);
  }
  // Launch wave amiibos date from November 2014.
  assert.equal(AMIIBO_RELEASE['0000000000000002'], '2014-11-21');
});

test('every series resolves to a representative with a database entry', async () => {
  const { seriesRepresentative, AMIIBO_NAMES } = await import('../web/js/amiibo.js');
  const seen = new Set(Object.keys(AMIIBO_NAMES).map((id) => parseInt(id.slice(12, 14), 16)));
  for (const s of seen) {
    const id = seriesRepresentative(s);
    assert.ok(id && AMIIBO_NAMES[id], `series 0x${s.toString(16)} has no representative`);
  }
  assert.equal(AMIIBO_NAMES[seriesRepresentative(0x05)], '[AC] 001 - Isabelle');
});

test('the HHD card manifest lists 91 cards with unique, well-formed UIDs', async () => {
  const { HHD_CARDS, HHD_CARDS_BY_UID } = await import('../web/data/hhd-cards.js');
  assert.equal(HHD_CARDS.length, 91);
  const uids = new Set();
  for (const c of HHD_CARDS) {
    assert.ok(Number.isInteger(c.card) && c.card >= 1 && c.card <= 91, `card ${c.card}`);
    assert.match(c.uid, /^[0-9a-f]{14}$/, `${c.card}: ${c.uid}`);
    assert.ok(c.count > 0, `${c.card}: ${c.count} items`);
    assert.ok(c.teaser.length > 0, `${c.card} has no teaser`);
    uids.add(c.uid);
  }
  assert.equal(uids.size, 91, 'UIDs are the identity — a duplicate would merge two cards');
  assert.equal(HHD_CARDS_BY_UID.get(HHD_CARDS[0].uid), HHD_CARDS[0]);
});

test('parseUid skips the BCC byte, matching how NTAG UIDs are actually laid out', async () => {
  const { parseUid } = await import('../web/js/amiibo.js');
  const bytes = new Uint8Array(540);
  bytes.set([0x04, 0x11, 0x22, 0x99, 0x33, 0x44, 0x55, 0x66]); // byte 3 = BCC0, skipped
  assert.equal(parseUid(bytes), '04112233445566');
  assert.equal(parseUid(new Uint8Array(2)), null);
});

test('hideHhd removes the fan-made set from the universe entirely', () => {
  const id = '026a000100000502';
  const owned = new Set([id, '0000000000000002']);
  // Off (default): the set is a known entry — 946 database rows + 1 curated.
  const shown = buildCollection(owned, null, { dumpCounts: new Map([[id, 91]]) });
  assert.equal(shown.stats.knownTotal, 947);
  assert.ok(shown.series.flatMap((s) => s.items).some((i) => i.special === 'hhd-items'));
  // On: gone from the list and from every count, even though dumps are owned.
  const hidden = buildCollection(owned, null, { dumpCounts: new Map([[id, 91]]), hideHhd: true });
  assert.equal(hidden.stats.knownTotal, 946);
  assert.ok(!hidden.series.flatMap((s) => s.items).some((i) => i.special));
  assert.equal(hidden.stats.ownedKnown, 1); // just Mario
  // An official-only collector can reach "complete": missing excludes the set.
  assert.equal(hidden.stats.missingLocal, 945);
});

test('hideHhd also suppresses the curated placeholder when nothing is owned', () => {
  const c = buildCollection(new Set(), null, { hideHhd: true });
  assert.equal(c.stats.knownTotal, 946);
  assert.ok(!c.series.flatMap((s) => s.items).some((i) => i.special));
});
