// All-in-one bundles: one file holding a whole amiibo library.
//
// Some tools ship libraries as a single .bin and expand it on the way to the
// device. The container is as simple as it gets — a flat run of fixed-size
// records, no header, no index, no name table, no checksum, no version field:
//
//   record[0x000 .. 0x21B]   540 bytes  NTAG215 image (pages 0..134)
//   record[0x21C .. 0x23B]    32 bytes  0xFF padding
//
// 572 is already a size the firmware recognises (DUMP_SIZES calls it Thenaya),
// so every record is a perfectly ordinary dump and parseAmiiboId reads its ID
// at byte 84 unchanged. The container is the only new thing here.
//
// Measured across two real bundles, 949 records in total:
//   - every record passes the NTAG structural checks below;
//   - the padding is 32 x 0xFF in all 949, with no other variant;
//   - a 943-record bundle was sorted ascending by amiibo ID from record 1 on,
//     with one late arrival prepended out of order — so ordering is a
//     convention, not something to rely on;
//   - 942 of those 943 were 532-byte dumps zero-extended to 540 (password and
//     PACK zeroed, dynamic lock 0F BD). Harmless: most retail dumps in the
//     wild have the same zeroed tail, and the firmware never reads it.
//
// One real limitation, and it cannot be worked around: a 572-byte record cannot
// hold a Kirby Air Riders tag. Those are NTAG I2C 2K and the vehicle lives at
// byte 979, well past the end of a record, so all four vehicles for a character
// collapse into one vehicle-less entry. See VEHICLE_CODE_OFFSET in amiibo.js.

import { parseAmiiboId, parseUid, DUMP_SIZES } from './amiibo.js';
import { AMIIBO_NAMES } from '../data/amiibo-db.js';

export const BUNDLE_RECORD_SIZE = 572;
export const BUNDLE_DUMP_SIZE = 540;
export const BUNDLE_PAD = 0xff;

// The size that actually occurs in the wild is 572; the others cost nothing to
// try and would cover a variant bundle built from unpadded dumps.
export const BUNDLE_RECORD_SIZES = [572, 540, 532, 2048];

// A single dump is a dump, not a one-record library.
const MIN_RECORDS = 2;

// Detection has to be strict in one direction above all: mistaking a real dump
// for a bundle would replace one amiibo with a phantom library. Requiring most
// records to name a known amiibo is what makes that essentially impossible.
const MIN_KNOWN_RATIO = 0.9;

const u8 = (bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

// The NTAG215 header fields a genuine dump always has. Cheap, and enough to
// reject a file whose length happens to divide evenly.
function looksLikeTag(rec) {
  if (rec.length < BUNDLE_DUMP_SIZE) return false;
  // Amiibo magic, and the capability container every amiibo carries.
  if (rec[0x10] !== 0xa5) return false;
  if (rec[0x0c] !== 0xf1 || rec[0x0d] !== 0x10 || rec[0x0e] !== 0xff || rec[0x0f] !== 0xee) {
    return false;
  }
  // Both UID check bytes, per NXP's NTAG21x datasheet.
  if ((0x88 ^ rec[0] ^ rec[1] ^ rec[2]) !== rec[3]) return false;
  if ((rec[4] ^ rec[5] ^ rec[6] ^ rec[7]) !== rec[8]) return false;
  return true;
}

// The dump to hand downstream. A 572-byte record loses its padding and becomes
// the plain 540-byte NTAG215 image the rest of the codebase expects; every
// other size is already a dump and passes through whole, which keeps the
// vehicle data of a 2048-byte record intact.
function dumpOf(rec, recordSize) {
  return recordSize === BUNDLE_RECORD_SIZE ? rec.subarray(0, BUNDLE_DUMP_SIZE) : rec;
}

/**
 * Is this file an all-in-one bundle?
 *
 * @returns {{recordSize: number, count: number, known: number}|null}
 */
export function detectBundle(bytes) {
  if (!bytes) return null;
  const u = u8(bytes);
  let best = null;

  for (const recordSize of BUNDLE_RECORD_SIZES) {
    if (u.length === 0 || u.length % recordSize !== 0) continue;
    const count = u.length / recordSize;
    if (count < MIN_RECORDS) continue;

    let known = 0;
    let ok = true;
    for (let i = 0; i < count; i++) {
      const rec = u.subarray(i * recordSize, (i + 1) * recordSize);
      const id = looksLikeTag(rec) ? parseAmiiboId(dumpOf(rec, recordSize)) : null;
      if (!id) {
        ok = false;
        break;
      }
      if (AMIIBO_NAMES[id]) known++;
    }
    if (!ok || known / count < MIN_KNOWN_RATIO) continue;

    // Record sizes are not coprime — 77,220 bytes divides by both 540 and 572 —
    // so when more than one fits, the reading that recognises more amiibos wins.
    if (!best || known > best.known) best = { recordSize, count, known };
  }

  return best;
}

/**
 * Split a bundle into its dumps. Assumes `detectBundle` said yes; pass its
 * `recordSize` to avoid detecting twice.
 *
 * @returns {Array<{index, offset, dump: Uint8Array, amiiboId: string|null, uid: string|null}>}
 */
export function splitBundle(bytes, { recordSize } = {}) {
  const u = u8(bytes);
  const size = recordSize ?? detectBundle(u)?.recordSize;
  if (!size || u.length % size !== 0) return [];

  const out = [];
  for (let i = 0; i < u.length / size; i++) {
    const offset = i * size;
    // Copied, not a view: callers hold these while the bundle goes out of scope,
    // and a view would pin the whole 539 kB file in memory for one 540-byte dump.
    const dump = dumpOf(u.subarray(offset, offset + size), size).slice();
    out.push({ index: i, offset, dump, amiiboId: parseAmiiboId(dump), uid: parseUid(dump) });
  }
  return out;
}

/**
 * A dump as a bundle record's 540 bytes, or null if the length is not a dump.
 *
 * 2048-byte dumps are truncated and lose their vehicle — see the note at the
 * top of this file. The caller is expected to say so rather than let it pass
 * unremarked; `isLossyInBundle` is there to make that easy.
 */
export function normalizeDump(bytes) {
  const u = u8(bytes);
  if (!DUMP_SIZES[u.length]) return null;
  if (u.length === BUNDLE_DUMP_SIZE) return u.slice();
  // 532-byte dumps stop before the password and PACK; zero-extending is exactly
  // what the real bundles did with theirs.
  const out = new Uint8Array(BUNDLE_DUMP_SIZE);
  out.set(u.subarray(0, Math.min(u.length, BUNDLE_DUMP_SIZE)));
  return out;
}

/** Whether packing a dump of this size into a bundle throws information away. */
export function isLossyInBundle(size) {
  return size > BUNDLE_DUMP_SIZE && size !== BUNDLE_RECORD_SIZE;
}

/**
 * Concatenate dumps into a bundle. The reverse of `splitBundle`, and a
 * round-trip of any 540-byte dump is byte-for-byte exact.
 */
export function packBundle(dumps) {
  const records = [];
  for (const bytes of dumps) {
    const dump = normalizeDump(bytes);
    if (dump) records.push(dump);
  }

  const out = new Uint8Array(records.length * BUNDLE_RECORD_SIZE);
  out.fill(BUNDLE_PAD);
  for (const [i, dump] of records.entries()) out.set(dump, i * BUNDLE_RECORD_SIZE);
  return out;
}
