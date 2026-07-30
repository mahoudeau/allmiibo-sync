// FCA: a second all-in-one container, read only.
//
// Where the flat 572-byte format is a bare run of tag images, FCA is a real
// archive with a header and length-prefixed entries. Published specification:
// https://github.com/fishybow/fca/blob/main/SPEC.md
//
//   Global header
//     0   3   Magic bytes "FCA" (ASCII)
//     3   1   Version number (unsigned byte)
//
//   Then N embedded files, each
//     0   4   Total size, big-endian: the bytes following this field
//     4   2   Header size, big-endian (H)
//     6   H   Header bytes, laid out by version
//     6+H E   The file itself, E = total size - 2 - H
//
//   Version 1 header
//     0   1   File type
//     1   1   Reserved
//
//   File types: 0 unknown, 1 Amiibo v2, 2 Amiibo v3 (I2C 2K Plus, e.g. Kirby
//   Air Riders), 3 Skylander, 4 Destiny Infinity, 5 Lego Dimensions.
//
// The one thing worth knowing next to the flat format: a type-2 entry holds a
// whole 2048-byte I2C dump, so an FCA file CAN carry Kirby Air Riders vehicles.
// A 572-byte record cannot, since the vehicle sits at byte 979.
//
// Reading only. Nothing here writes FCA: the app packs the flat format, which
// is what the device-side tooling around it expects.

import { parseAmiiboId, parseUid, parseVehicle } from './amiibo.js';

export const FCA_MAGIC = 'FCA';
const GLOBAL_HEADER = 4;
const ENTRY_PREFIX = 6; // the 4-byte total size and the 2-byte header size

export const FCA_TYPES = Object.freeze({
  0: 'Unknown',
  1: 'Amiibo v2',
  2: 'Amiibo v3',
  3: 'Skylander',
  4: 'Destiny Infinity',
  5: 'Lego Dimensions',
});

// The types worth opening. 1 and 2 say "amiibo" outright.
//
// 0 is included because the specification defines it as "unknown or
// unspecified" and notes that a default implementation writes 0x00 for both
// header bytes, so a lax packer can label a real dump this way. Trying it costs
// nothing: the payload still has to parse as a dump, which is what rejects the
// type-0 entries that occur in practice. Two real archives carry one, and it is
// a 253-byte README about registering Wolf Link.
//
// Anything else is somebody else's toy, and is passed over rather than guessed
// at: a Skylanders archive is not this app's business.
const AMIIBO_TYPES = new Set([0, 1, 2]);

const u8 = (bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
const u32 = (u, at) => ((u[at] << 24) | (u[at + 1] << 16) | (u[at + 2] << 8) | u[at + 3]) >>> 0;
const u16 = (u, at) => ((u[at] << 8) | u[at + 1]) >>> 0;

function hasMagic(u) {
  return u.length >= GLOBAL_HEADER && u[0] === 0x46 && u[1] === 0x43 && u[2] === 0x41;
}

/**
 * Walk the entries. Returns null if the file is not a well-formed archive.
 *
 * Every entry must land inside the file and the entries must tile it exactly,
 * with nothing left over. That is what makes detection safe: a file that merely
 * happens to start with "FCA" will not survive the walk.
 */
function walk(bytes) {
  const u = u8(bytes);
  if (!hasMagic(u)) return null;

  const version = u[3];
  const entries = [];
  let at = GLOBAL_HEADER;

  while (at < u.length) {
    if (at + ENTRY_PREFIX > u.length) return null; // truncated prefix
    const totalSize = u32(u, at);
    const headerSize = u16(u, at + 4);
    // totalSize covers the header-size field, its header, and the payload.
    if (totalSize < 2 || headerSize > totalSize - 2) return null;
    const end = at + 4 + totalSize;
    if (end > u.length) return null; // runs past the end

    const header = u.subarray(at + ENTRY_PREFIX, at + ENTRY_PREFIX + headerSize);
    entries.push({
      index: entries.length,
      offset: at,
      type: headerSize >= 1 ? header[0] : 0,
      header: header.slice(),
      bytes: u.subarray(at + ENTRY_PREFIX + headerSize, end),
    });
    at = end;
  }

  // An empty archive is legal per the spec but is not a library.
  return { version, entries };
}

/**
 * Is this an FCA archive holding amiibo?
 *
 * @returns {{version: number, count: number, amiibos: number}|null}
 */
export function detectFca(bytes) {
  const walked = walk(bytes);
  if (!walked || !walked.entries.length) return null;

  let amiibos = 0;
  for (const e of walked.entries) {
    if (AMIIBO_TYPES.has(e.type) && parseAmiiboId(e.bytes)) amiibos++;
  }
  // A Skylanders-only archive parses perfectly well and is still not something
  // this app has any business unpacking.
  if (!amiibos) return null;

  return { version: walked.version, count: walked.entries.length, amiibos };
}

/**
 * The amiibo dumps inside an archive, in the same shape `splitBundle` returns
 * so callers can treat both containers alike.
 *
 * Entries that are not amiibo, or whose bytes are not a readable dump, are left
 * out and reported through `skipped` rather than silently dropped.
 */
export function splitFca(bytes) {
  const walked = walk(bytes);
  if (!walked) return { records: [], skipped: [], version: null };

  const records = [];
  const skipped = [];
  for (const e of walked.entries) {
    const typeName = FCA_TYPES[e.type] ?? `type ${e.type}`;
    if (!AMIIBO_TYPES.has(e.type)) {
      skipped.push({ index: e.index, reason: `${typeName} is not an amiibo` });
      continue;
    }
    // Copied, not a view: a view would pin the whole archive in memory for one
    // dump, exactly as in the flat reader.
    const dump = e.bytes.slice();
    const amiiboId = parseAmiiboId(dump);
    if (!amiiboId) {
      skipped.push({
        index: e.index,
        reason: `${typeName}, ${dump.length} bytes, is not a readable dump`,
      });
      continue;
    }
    const vehicle = parseVehicle(dump);
    records.push({
      index: e.index,
      offset: e.offset,
      dump,
      amiiboId,
      uid: parseUid(dump),
      // Only ever set for a type-2 entry, which is the whole reason FCA is
      // worth reading: the flat format cannot carry this.
      vehicle: vehicle?.name ?? vehicle?.code ?? null,
      type: e.type,
      typeName,
    });
  }
  return { records, skipped, version: walked.version };
}
