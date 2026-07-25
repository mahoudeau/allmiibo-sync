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
  const c = buildCollection(new Set(['0000050004e90102'])); // Mario + Luma, newer than the table
  const all = c.series.flatMap((s) => s.items);
  const extra = all.find((i) => i.id === '0000050004e90102');

  assert.ok(extra, 'unlisted amiibos must still appear');
  assert.equal(extra.inDatabase, false);
  assert.equal(extra.hasLocal, true);
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
  assert.equal(decodeAmiiboId('0000000000002102').seriesName, 'Series 0x21');
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
