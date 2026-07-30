// Turning an all-in-one bundle into something the planner can sync.
//
// A bundle in the sync folder is not a file you want on the device — the
// firmware cannot read it, and sending one costs about four and a half minutes
// of BLE for nothing. What you want is its contents, as individual dumps. So
// the bundle is excluded from the plan and its members are injected into the
// local index as ordinary-looking entries, each with a path chosen by
// amiiboRelPath. From there every existing operation works unchanged.
//
// Members are dropped rather than transferred when you already have that
// amiibo, and that check has to happen HERE rather than being left to the
// planner. planIdentitySync keys identity on the content hash as well as the
// ID — deliberately, so that the 91 Animal Crossing item cards and the four
// Air Riders vehicle pairings stay distinct — and a bundle's dumps carry
// freshly generated UIDs. Measured against two real bundles: not one of 943
// records matched any of 2,084 local dumps byte-for-byte. Left to the planner
// every member would therefore read as a new item and upload a duplicate of
// something already on the device.
//
// The dumps live in memory rather than being written to disk. A full library is
// 943 x 540 bytes, about 509 kB, so there is nothing to gain by streaming and
// a great deal to lose by writing 943 files the user did not ask for.

import { parseAmiiboId, parseUid, parseVehicle, isHhdItemCards } from './amiibo.js';
import { detectBundle, splitBundle } from './bundle.js';
import { amiiboRelPath } from './planner.js';

// What counts as "the same amiibo I already have". Normally the ID: one dump
// per amiibo is all a bundle can usefully give you. The Happy Home Designer
// item cards are the exception — all 91 share one fabricated ID — so for those
// the UID is the discriminator, exactly as localfs and hashDeviceIndex already
// treat it.
export function ownedKey(amiiboId, uid) {
  if (!amiiboId) return null;
  return isHhdItemCards(amiiboId) && uid ? `${amiiboId}:${uid}` : amiiboId;
}

function ownedKeysOf(index) {
  const keys = new Set();
  if (!index) return keys;
  for (const [, e] of index) {
    if (e.isDir || !e.amiiboId) continue;
    const key = ownedKey(e.amiiboId, e.uid);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Expand every bundle in a local index into virtual dump entries.
 *
 * @param {object}   input
 * @param {Map}      input.index      a walkLocal-shaped index
 * @param {Function} input.read       async (relPath) => Uint8Array
 * @param {string}   input.deviceRoot e.g. "E:/amiibo", to size the paths
 * @param {Map}      [input.device]   device index; only entries carrying an
 *   amiiboId count, which in practice means an identity scan has run. Without
 *   it a member already on the device under a different name cannot be
 *   recognised, and `report.deviceIdentified` says so rather than implying the
 *   check was thorough.
 * @param {Function} [input.hash]     async (bytes) => string, for entry hashes
 *
 * @returns {Promise<{virtual: Map, sources: Map, excludes: string[], report: object}>}
 */
export async function expandBundles({ index, read, deviceRoot, device = null, hash = null }) {
  const virtual = new Map();
  const sources = new Map();
  const excludes = [];
  const bundles = [];

  const bundleEntries = [...index].filter(([, e]) => !e.isDir && e.bundle);
  if (!bundleEntries.length) {
    return { virtual, sources, excludes, report: { bundles, deviceIdentified: false } };
  }

  // Everything already held, on either side. Local first: a real file on disk
  // is always preferable to a bundle's copy of the same amiibo, and for a
  // 2048-byte Air Riders dump it is strictly richer — the bundle's truncated
  // record has no vehicle at all.
  const localKeys = ownedKeysOf(index);
  const deviceKeys = ownedKeysOf(device);
  const owned = new Set([...localKeys, ...deviceKeys]);
  const taken = new Set(index.keys());

  for (const [relPath, entry] of bundleEntries) {
    excludes.push(relPath);
    const summary = {
      relPath,
      recordSize: entry.bundle.recordSize,
      count: entry.bundle.count,
      unique: 0,
      added: 0,
      haveLocally: 0,
      onDevice: 0,
      duplicates: 0,
      unknown: 0,
      blocked: [],
    };
    bundles.push(summary);

    let records;
    try {
      records = splitBundle(await read(relPath), { recordSize: entry.bundle.recordSize });
    } catch (err) {
      summary.error = err.message;
      continue;
    }

    // Duplicate records are real, and they come in two shapes: byte-identical
    // copies, and two different physical tags of one amiibo. One sample bundle
    // held six records for four amiibos, with both kinds present. The key
    // collapses both, since a second tag of an amiibo you are about to get adds
    // nothing.
    const seen = new Set();
    for (const rec of records) {
      const { amiiboId, uid, dump } = rec;
      if (!amiiboId) {
        summary.unknown++;
        continue;
      }
      const key = ownedKey(amiiboId, uid);
      if (seen.has(key)) {
        summary.duplicates++;
        continue;
      }
      seen.add(key);
      summary.unique++;

      if (localKeys.has(key)) {
        summary.haveLocally++;
        continue;
      }
      if (deviceKeys.has(key)) {
        summary.onDevice++;
        continue;
      }
      // Offered by an earlier bundle in the same folder. Not "already owned" —
      // it is coming, just from somewhere else.
      if (owned.has(key)) {
        summary.duplicates++;
        continue;
      }

      const relPathFor = amiiboRelPath(amiiboId, { deviceRoot, uid });
      if (!relPathFor) {
        summary.blocked.push({ amiiboId, reason: `no filename fits under ${deviceRoot}` });
        continue;
      }
      // Two members cannot land on one path: the database guarantees unique
      // names per series, but a path already used by a real file must win.
      if (taken.has(relPathFor)) {
        summary.blocked.push({ amiiboId, reason: `${relPathFor} is already taken` });
        continue;
      }
      taken.add(relPathFor);

      const vehicle = parseVehicle(dump);
      virtual.set(relPathFor, {
        size: dump.length,
        hash: hash ? await hash(dump) : null,
        amiiboId,
        vehicle: vehicle?.name ?? vehicle?.code ?? null,
        uid: isHhdItemCards(amiiboId) ? uid : null,
        isDir: false,
        lastModified: entry.lastModified ?? null,
        // Marks an entry with no file behind it. The planner must never plan a
        // local delete or move against one, and the executor reads its bytes
        // from `sources` instead of from disk.
        virtual: true,
        fromBundle: relPath,
      });
      sources.set(relPathFor, dump);
      // Owning it now stops a second bundle from offering the same amiibo again.
      owned.add(key);
      summary.added++;
    }
  }

  return {
    virtual,
    sources,
    excludes,
    report: { bundles, deviceIdentified: deviceKeys.size > 0 },
  };
}

/** Convenience: does this index hold any all-in-one bundle? */
export function hasBundles(index) {
  for (const [, e] of index) if (!e.isDir && e.bundle) return true;
  return false;
}

// Re-exported so callers that only deal in bundles need one import.
export { detectBundle, splitBundle, parseAmiiboId, parseUid };
