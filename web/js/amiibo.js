// Amiibo identity: reading the amiibo ID out of a dump and describing it.
//
// Content hashing cannot identify an amiibo — two dumps of the same character
// differ in UID and save data, so byte-identical comparison reports them as
// different figures. The amiibo ID is the stable identity.
//
// Offset verified two ways:
//   - firmware: amiibo_helper.c reads
//       head = to_little_endian_int32(&ntag->data[84]);
//       tail = to_little_endian_int32(&ntag->data[88]);
//   - measured against 2084 real dumps across every format seen, including
//     2048-byte NTAG I2C 2K images used by the newest releases.
//
// Note that the trailing ID byte is NOT invariably 0x02: Kirby Air Riders
// carries 0x03. An earlier version rejected those dumps outright on that
// assumption, so validity is now decided by dump length rather than by
// guessing at a magic byte.
//
// The firmware also defines AMII_ID_OFFSET 476, and writes the ID to both 84
// and 476 when *generating* a tag. In retail dumps 476 falls inside encrypted
// data and reads as noise, so 84 is the one to use.

import { AMIIBO_NAMES, AMIIBO_SERIES, AMIIBO_TYPES } from '../data/amiibo-db.js';

export const AMIIBO_ID_OFFSET = 84;
export const AMIIBO_ID_SIZE = 8;

// Known dump lengths, from the firmware's ntag_def.h. A file of any other
// length is not treated as a dump, which keeps device state such as
// settings.bin and key_retail.bin from being mistaken for amiibos.
export const DUMP_SIZES = {
  532: 'TagMo',
  540: 'NTAG215',
  572: 'Thenaya',
  2048: 'NTAG I2C 2K', // newer releases — Kirby Air Riders and later
};

// Figure type (byte 3) and amiibo series (byte 6). Both tables come from
// AmiiboAPI via the generated database, which is authoritative — a
// hand-derived version of this got twelve series labels wrong, including
// 0xff, which is Super Nintendo World rather than a catch-all.
export const TYPE_NAMES = AMIIBO_TYPES;
export const SERIES_NAMES = AMIIBO_SERIES;

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Extract the amiibo ID from a dump. Returns a 16-character lowercase hex
 * string, or null if the bytes are not a dump of a recognised length.
 *
 * The ID sits at byte 84 in every format observed, including the 2048-byte
 * NTAG I2C 2K images used by newer releases.
 */
export function parseAmiiboId(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!DUMP_SIZES[u.length]) return null;

  const candidates = [AMIIBO_ID_OFFSET];
  // Thenaya dumps carry 32 extra bytes that could sit at either end.
  if (u.length === 572) candidates.push(AMIIBO_ID_OFFSET + 32);

  const read = (offset) =>
    offset + AMIIBO_ID_SIZE <= u.length ? hex(u.subarray(offset, offset + AMIIBO_ID_SIZE)) : null;
  const plausible = (id) => id && !/^0+$/.test(id) && !/^f+$/.test(id);

  // Prefer an offset the database recognises; that is what disambiguates the
  // two possible Thenaya placements.
  for (const offset of candidates) {
    const id = read(offset);
    if (id && AMIIBO_NAMES[id]) return id;
  }
  for (const offset of candidates) {
    const id = read(offset);
    if (plausible(id)) return id;
  }
  return null;
}

// ---- v3 / NTAG I2C 2K vehicle identity ----------------------------------
//
// Kirby Air Riders amiibo are two pieces: the character figure carries the
// tag, the vehicle acts as the antenna. The amiibo ID identifies the
// *character only* — all four vehicles for one character share an ID — and the
// vehicle lives in the tag's SRAM buffer at pages 0xF0–0xFF.
//
// Within that buffer, bytes 979–984 of the dump hold an ASCII part code and
// byte 988 a discriminator. Measured across 16 dumps (4 characters × 4
// vehicles): the signature is identical across characters and unique per
// vehicle. Background: AmiiboAPI issue #243, and xSke's write-up there.

export const VEHICLE_CODE_OFFSET = 979;
export const VEHICLE_FLAG_OFFSET = 988;

export const VEHICLE_SIGNATURES = Object.freeze({
  'PB4W17:02': 'Warp Star',
  'PB4W17:04': 'Winged Star',
  'PB5T42:04': 'Shadow Star',
  'PC6V28:04': 'Tank Star',
});

// Every character takes every vehicle, so this doubles as the per-character
// checklist. It is only as complete as what has been observed — a Hop Star is
// announced alongside Chef Kawasaki and is not here yet — so treat a missing
// chip as "not seen in your dumps", not as proof the pairing does not exist.
export const KNOWN_VEHICLES = Object.freeze([
  ...new Set(Object.values(VEHICLE_SIGNATURES)),
].sort());

/** Amiibo format version — byte 7 of the ID. 2 is standard, 3 is Air Riders. */
export function amiiboVersion(id) {
  if (!id || id.length !== 16) return null;
  return parseInt(id.slice(14, 16), 16);
}

export const SERIES_KIRBY_AIR_RIDERS = 0x1e;

/**
 * Whether an amiibo pairs with a vehicle. Scoped to the Kirby Air Riders
 * series rather than to the v3 format: v3 is a tag/format version, and a later
 * v3 series need not use vehicles at all.
 *
 * Within the series every character takes every vehicle, so the full vehicle
 * list applies to each of them.
 */
export function hasVehicles(id) {
  if (!id || id.length !== 16) return false;
  return parseInt(id.slice(12, 14), 16) === SERIES_KIRBY_AIR_RIDERS;
}

/**
 * Vehicle carried by a v3 dump, or null when the dump is not one.
 * Returns { code, name }, with name null for a vehicle not yet catalogued.
 */
export function parseVehicle(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u.length !== 2048) return null;

  const raw = u.subarray(VEHICLE_CODE_OFFSET, VEHICLE_CODE_OFFSET + 6);
  if (![...raw].every((c) => c >= 0x20 && c < 0x7f)) return null;

  const code = `${String.fromCharCode(...raw)}:${u[VEHICLE_FLAG_OFFSET]
    .toString(16)
    .padStart(2, '0')}`;
  return { code, name: VEHICLE_SIGNATURES[code] ?? null };
}

/** Break an ID into its documented fields. */
export function decodeAmiiboId(id) {
  if (!id || id.length !== 16) return null;
  const b = (i) => parseInt(id.slice(i * 2, i * 2 + 2), 16);
  const series = b(6);
  const type = b(3);
  return {
    id,
    gameCharacter: id.slice(0, 4),
    variant: b(2),
    type,
    typeName: TYPE_NAMES[type] ?? `Type 0x${type.toString(16).padStart(2, '0')}`,
    model: id.slice(8, 12),
    series,
    seriesName: SERIES_NAMES[series] ?? `Series 0x${series.toString(16).padStart(2, '0')}`,
  };
}

/** Name from the vendored database, or null if it predates/postdates the table. */
export function amiiboName(id) {
  return AMIIBO_NAMES[id] ?? null;
}

// The first four bytes of an amiibo ID identify the character, independent of
// series and figure type. Measured over the database: 827 distinct heads, 797
// of which carry exactly one character name; the 30 that vary are variants of
// one character (Mario / Mario - Gold Edition / Mario - Wedding).
//
// That makes an ID the database has never seen still nameable, as long as the
// character has appeared before — Kirby Air Riders' Meta Knight and King
// Dedede resolve this way from their v2 entries.
let headIndex = null;

function buildHeadIndex() {
  const heads = new Map();
  for (const [id, name] of Object.entries(AMIIBO_NAMES)) {
    // Strip the database's list decorations: "[AC] 001 - Isabelle" -> "Isabelle".
    const clean = name.replace(/^\[[^\]]+\]\s*/, '').replace(/^\d+\s*-\s*/, '').trim();
    const head = id.slice(0, 8);
    const current = heads.get(head);
    // Shortest wins, so a head shared by variants yields the base character.
    if (!current || clean.length < current.length) heads.set(head, clean);
  }
  return heads;
}

/** Character behind an ID, even when that exact ID is not in the database. */
export function characterName(id) {
  if (!id || id.length !== 16) return null;
  headIndex ??= buildHeadIndex();
  return headIndex.get(id.slice(0, 8)) ?? null;
}

export function describeAmiibo(id) {
  const decoded = decodeAmiiboId(id);
  if (!decoded) return null;
  return { ...decoded, name: amiiboName(id) };
}

/**
 * Build a per-series collection view over the whole known database.
 *
 * @param {Set<string>|Map<string,any>} ownedLocal   IDs present locally
 * @param {Set<string>|Map<string,any>} [ownedDevice] IDs present on the device
 */
export function buildCollection(ownedLocal, ownedDevice = null) {
  const localSet = ownedLocal instanceof Map ? new Set(ownedLocal.keys()) : new Set(ownedLocal);
  const deviceSet = ownedDevice
    ? ownedDevice instanceof Map
      ? new Set(ownedDevice.keys())
      : new Set(ownedDevice)
    : null;

  const seriesMap = new Map();
  const add = (id, name, known) => {
    const d = decodeAmiiboId(id);
    if (!d) return;
    if (!seriesMap.has(d.series)) {
      seriesMap.set(d.series, { series: d.series, seriesName: d.seriesName, items: [] });
    }
    seriesMap.get(d.series).items.push({
      id,
      // An ID absent from the database can still often be named through its
      // character head; only fall back to the raw ID when even that fails.
      name: name ?? characterName(id) ?? `Unknown (${id})`,
      inDatabase: known,
      typeName: d.typeName,
      hasLocal: localSet.has(id),
      hasDevice: deviceSet ? deviceSet.has(id) : null,
    });
  };

  for (const [id, name] of Object.entries(AMIIBO_NAMES)) add(id, name, true);
  // Anything owned but absent from the table — typically newer releases.
  for (const id of localSet) if (!AMIIBO_NAMES[id]) add(id, null, false);
  if (deviceSet) for (const id of deviceSet) if (!AMIIBO_NAMES[id] && !localSet.has(id)) add(id, null, false);

  const series = [...seriesMap.values()].sort((a, b) => a.series - b.series);
  for (const s of series) {
    s.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    s.ownedLocal = s.items.filter((i) => i.hasLocal).length;
    s.ownedDevice = deviceSet ? s.items.filter((i) => i.hasDevice).length : null;
    s.total = s.items.length;
  }

  const all = series.flatMap((s) => s.items);
  return {
    series,
    stats: {
      knownTotal: Object.keys(AMIIBO_NAMES).length,
      listed: all.length,
      ownedLocal: all.filter((i) => i.hasLocal).length,
      // Owned *and* in the database, so it reads sensibly against knownTotal.
      ownedKnown: all.filter((i) => i.hasLocal && i.inDatabase).length,
      ownedDevice: deviceSet ? all.filter((i) => i.hasDevice).length : null,
      missingLocal: all.filter((i) => !i.hasLocal && i.inDatabase).length,
      notInDatabase: all.filter((i) => !i.inDatabase).length,
    },
  };
}

export { AMIIBO_NAMES };
