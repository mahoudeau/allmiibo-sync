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
//   - measured against 1035 real dumps, where byte 7 of the ID is 0x02 in
//     every single one.
//
// The firmware also defines AMII_ID_OFFSET 476, and writes the ID to both 84
// and 476 when *generating* a tag. In retail dumps 476 falls inside encrypted
// data and reads as noise, so 84 is the one to use.

import { AMIIBO_NAMES } from '../data/amiibo-db.js';

export const AMIIBO_ID_OFFSET = 84;
export const AMIIBO_ID_SIZE = 8;

// Known dump lengths, from the firmware's ntag_def.h.
export const DUMP_SIZES = {
  540: 'NTAG215',
  532: 'TagMo',
  572: 'Thenaya',
};

// Figure type, byte 3 of the ID.
export const TYPE_NAMES = {
  0x00: 'Figure',
  0x01: 'Card',
  0x02: 'Yarn',
  0x03: 'Band',
  0x04: 'Other',
};

// Series, byte 6 of the ID. Labels derived by correlating the series byte
// against a verified 1035-dump collection; unlisted values fall back to the
// raw byte rather than being guessed at.
export const SERIES_NAMES = {
  0x00: 'Super Smash Bros.',
  0x01: 'Super Mario',
  0x02: 'Chibi-Robo',
  0x03: "Yoshi's Woolly World",
  0x04: 'Splatoon',
  0x05: 'Animal Crossing',
  0x06: '8-bit Mario',
  0x07: 'Skylanders',
  0x09: 'The Legend of Zelda',
  0x0a: 'Shovel Knight',
  0x0b: 'Tekken',
  0x0c: 'Kirby',
  0x0d: 'Pokémon',
  0x0e: 'Mario Sports Superstars',
  0x0f: 'Monster Hunter Stories',
  0x10: 'BoxBoy!',
  0x11: 'Pikmin',
  0x12: 'Fire Emblem',
  0x13: 'Metroid',
  0x14: 'Others',
  0x15: 'Mega Man',
  0x16: 'Diablo',
  0x17: 'Jikkyou Powerful Pro Baseball',
  0x18: 'Monster Hunter Rise',
  0x19: 'Yu-Gi-Oh!',
  0x1a: 'Donkey Kong',
  0x1b: 'Xenoblade Chronicles',
  0x1c: 'Super Mario (recent)',
  0x1d: 'Street Fighter',
  0x1e: 'Kirby (recent)',
  0x21: 'Pragmata',
  0xff: 'Unclassified',
};

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Extract the amiibo ID from a dump. Returns a 16-character lowercase hex
 * string, or null if the bytes do not look like an amiibo dump.
 *
 * Thenaya dumps are 32 bytes longer than a plain NTAG215 image; the extra
 * bytes could sit at either end, so both placements are tried and the one
 * whose trailing ID byte is 0x02 wins.
 */
export function parseAmiiboId(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const candidates = [AMIIBO_ID_OFFSET];
  if (u.length > 540) candidates.push(AMIIBO_ID_OFFSET + (u.length - 540));

  for (const offset of candidates) {
    if (offset + AMIIBO_ID_SIZE > u.length) continue;
    const id = u.subarray(offset, offset + AMIIBO_ID_SIZE);
    if (id[7] === 0x02) return hex(id);
  }
  return null;
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
      name: name ?? `Unknown (${id})`,
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
      ownedDevice: deviceSet ? all.filter((i) => i.hasDevice).length : null,
      missingLocal: all.filter((i) => !i.hasLocal && i.inDatabase).length,
      notInDatabase: all.filter((i) => !i.inDatabase).length,
    },
  };
}

export { AMIIBO_NAMES };
