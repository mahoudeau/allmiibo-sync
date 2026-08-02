// Sync planner: pure reconciliation logic, no I/O.
//
// Takes an index of each side plus the state recorded at the end of the last
// sync, and returns an ordered plan. Nothing here talks to BLE or the
// filesystem, so it is fully testable — see test/planner.test.mjs.
//
// Hardware constraints this encodes (see PROTOCOL.md §9):
//   - remove() deletes folders recursively, so folders are never removed as a
//     shortcut for their contents; files are deleted individually and folder
//     removal is emitted separately, deepest-first.
//   - create_folder() is not idempotent, so folders are only created when the
//     index shows them absent.
//   - rename() moves between folders, so a file that only changed location is
//     moved rather than re-uploaded (~0.5 s saved per dump, more for anything
//     larger).
//   - Paths cap at 63 bytes total and names at 47, so destinations are
//     validated up front and reported rather than failing mid-transfer.

import { seriesFolder, amiiboFileName, isHhdItemCards, vehicleTag, amiiboPath } from './amiibo.js';
import {
  utf8Bytes,
  devicePath,
  checkDestination,
  sanitizeLocalName,
  sanitizeLocalRelPath,
} from './devicepath.js';

// Re-exported so every existing call site keeps importing them from here. They
// live in devicepath.js because the database generator needs them too and cannot
// import this file: planner -> amiibo -> the database being generated.
export { utf8Bytes, devicePath, checkDestination, sanitizeLocalName, sanitizeLocalRelPath };

export const MODES = ['push', 'pull', 'two-way'];

// Device-managed files that must never be written, deleted or pulled.
// settings.bin is device configuration and key_retail.bin holds the amiibo
// signing keys; chameleon/ is separate emulator state.
export const DEFAULT_EXCLUDES = [
  'settings.bin',
  'key_retail.bin',
  '.allmiibo-sync.json',
  // Operating-system metadata. Without these a push uploads Finder and
  // Explorer droppings to the device.
  '.DS_Store',
  'desktop.ini',
  'Thumbs.db',
  '._.DS_Store',
];

export function isExcluded(relPath, excludes = DEFAULT_EXCLUDES) {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  return excludes.includes(name) || excludes.includes(relPath);
}

// ---- choosing a path for an amiibo that has no home yet ------------------
//
// Everything else here reconciles paths the user already chose. This picks one,
// which two things need: a bundle's members, which arrive as bare dumps with no
// filenames at all, and a loose .bin picked on its own, which has a name but no
// folder around it.
//
// Those two are not treated the same. A bundle member has no name to keep, so
// one is built from the database. A file you picked has a name you chose, so it
// keeps it and only gains a folder.
//
// How much room there is depends on the device root, so the fit is measured
// rather than assumed, and the name is shortened in steps until it passes
// checkDestination. Measured over all 946 database entries, the series
// initialism alone is enough: at "E:/amiibo" only 9 of them need even that,
// and the last two rungs are never reached. They stay in because a future
// series label could be long enough to need them.

/**
 * A device-relative path for an amiibo ID, or null if no form of the name fits
 * under `deviceRoot`.
 *
 * @param {string} id          16-char amiibo ID
 * @param {string} deviceRoot  e.g. "E:/amiibo"
 * @param {string} [uid]       NFC UID, needed only for the Happy Home Designer
 *   cards, which all carry one fabricated ID and would otherwise collide
 * @param {string} [vehicle]   decoded Air Riders vehicle. All four vehicles of a
 *   character share one ID, so without this four real dumps land on one path
 * @param {string} [keepName]  an existing filename to preserve, with or without
 *   its extension. Used for a file picked on its own: it gains a series folder
 *   but is not renamed
 */
export function amiiboRelPath(id, { deviceRoot, uid = null, vehicle = null, keepName = null }) {
  const series = parseInt(id.slice(12, 14), 16);
  const long = seriesFolder(series);
  const short = seriesFolder(series, { short: true });

  // A curated path, if one was set. It is tried through the same fits() check as
  // every other rung and is never truncated, so a pin that does not fit under a
  // longer device root falls through to the ladder rather than breaking. The
  // build has already refused to pin an ID that stands for more than one dump,
  // which is what makes it safe to try this early.
  const pinned = amiiboPath(id);
  if (pinned) {
    const relPath = fits(deviceRoot, pinned);
    if (relPath) return relPath;
  }

  // A name the user chose is kept as-is; only the folder is added. Trying the
  // full series label first and the initialism second is the same ladder the
  // generated names use, so a long filename still has a chance of fitting.
  if (keepName) {
    const base = sanitizeLocalName(keepName.replace(/\.bin$/i, ''));
    if (base) {
      for (const folder of [long, short]) {
        const relPath = fits(deviceRoot, `${sanitizeLocalName(folder)}/${base}.bin`);
        if (relPath) return relPath;
      }
      // Too long with any folder. Fall through and build a name instead.
    }
  }

  // All 91 HHD item cards share one amiibo ID, so the ID cannot name them —
  // asking it to would file 91 cards at one path and keep the last. The UID is
  // what tells them apart, and it is what the collection page already keys them
  // by; the pretty card number is a display concern, resolved from
  // data/hhd-cards.js at render time, so it does not belong in a filename.
  if (isHhdItemCards(id) && uid) {
    const folder = sanitizeLocalName(seriesFolder(series, { short: true }));
    return fits(deviceRoot, `${folder}/HHD ${uid}.bin`) ?? fits(deviceRoot, `HHD ${uid}.bin`);
  }

  const full = amiiboFileName(id);
  // An ID the database has never seen still needs somewhere to go, and the ID
  // is the one name certain to be unique.
  if (!full) return fits(deviceRoot, `Unknown/${id}.bin`);

  const abbreviated = amiiboFileName(id, { short: true });

  // Every vehicle of a character carries the same ID, so the name has to say
  // which one or four dumps collapse onto one path. The short tag is what fits:
  // the full vehicle name pushes the longest Air Riders path to 72 bytes.
  const tag = vehicleTag(vehicle);
  const tagged = (name) => (tag ? `${name} (${tag})` : name);

  for (const [folder, name] of [
    [long, tagged(full)],
    [short, tagged(full)],
    [short, tagged(abbreviated)],
  ]) {
    const relPath = fits(deviceRoot, `${sanitizeLocalName(folder)}/${sanitizeLocalName(name)}.bin`);
    if (relPath) return relPath;
  }

  // No form of the name fits. Fall back to the ID rather than a truncated
  // name: two amiibos trimmed to the same prefix would overwrite each other on
  // the device, and a silent collision is far worse than an ugly filename. The
  // collection list labels dumps from the database anyway, so this shows up as
  // the right name in the UI regardless.
  // The ID alone is not unique across vehicles either, so it carries the tag too.
  const last = tag ? `${id} (${tag})` : id;
  return fits(deviceRoot, `${sanitizeLocalName(short)}/${last}.bin`) ?? fits(deviceRoot, `${last}.bin`);
}

const fits = (deviceRoot, relPath) => (checkDestination(deviceRoot, relPath) ? null : relPath);

// A file costs far more than its bytes, and the margin matters: a replace
// planned on raw content bytes looked like it fit in 963 kB of free space and
// died 320 uploads into a 48-minute run.
//
// Two measurements, and they disagree:
//   - the drive holds 862 files with 464,979 bytes of content in 953,800 bytes
//     of used space, which averages 1,106 bytes per file
//   - a real push filled 963,589 bytes of free space after 729 uploads of
//     540-byte dumps, i.e. 1,322 bytes each
//
// (The first figure came out of the drive list, whose second u32 is free space
// rather than used — the difference of the two totals, so the average moved
// once that was corrected. The second is a delta and was never affected.)
//
// The second is the one that counts: it measures what an upload actually
// consumes rather than averaging over a drive whose history is unknown. The
// figure below is rounded up from it, because underestimating fails a run part
// way through while overestimating only declines one that might have fit.
export const STORAGE_OVERHEAD_PER_FILE = 800;

/** What a file of this size actually costs on the device. */
export function storedSize(size) {
  return size + STORAGE_OVERHEAD_PER_FILE;
}

// The drive list reports total and *free* bytes; usedSize is derived from them
// in protocol.js. Free is what the capacity check needs, so take it directly
// where it is available and fall back to the subtraction for callers — tests,
// saved runs — that only carry the derived figure.
export function driveFreeBytes(drive) {
  if (!drive) return NaN;
  if (Number.isFinite(drive.freeSize)) return drive.freeSize;
  if (Number.isFinite(drive.totalSize) && Number.isFinite(drive.usedSize)) {
    return drive.totalSize - drive.usedSize;
  }
  return NaN;
}

function parentDirs(relPath) {
  const parts = relPath.split('/');
  parts.pop();
  const out = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

function depth(relPath) {
  return relPath.split('/').length;
}

// Folders whose listing was never completed, plus every ancestor of one.
//
// walkDevice records a directory before reading it, so one it could not list
// is in the index with no children — indistinguishable from an empty folder by
// shape alone. remove() is recursive on the firmware (PROTOCOL.md §9.4), so
// removing any of these would erase a subtree nobody has ever seen. A childless
// directory here means "never looked", not "empty".
export function unenumeratedDirs(device) {
  const out = new Set();
  for (const [relPath, e] of device) {
    if (!e.isDir || !e.unenumerated) continue;
    out.add(relPath);
    for (const parent of parentDirs(relPath)) out.add(parent);
  }
  return out;
}

// True for a path living inside a folder we could not list: the device may or
// may not still hold it, and the index cannot say which.
function shadowedBy(protectedDirs) {
  if (protectedDirs.size === 0) return () => false;
  return (relPath) => {
    for (const dir of protectedDirs) if (relPath.startsWith(`${dir}/`)) return true;
    return false;
  };
}

// The folders actually flagged, for the UI and the saved run log. Ancestors
// are an implementation detail of the guard and are deliberately not here.
export function unenumeratedList(device) {
  return [...device]
    .filter(([, e]) => e.isDir && e.unenumerated)
    .map(([relPath, e]) => ({ relPath, reason: e.unenumerated, error: e.listError ?? null }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// The named folders only — ancestors would just be noise in a warning.
function unenumeratedWarning(device, extra = '') {
  const dirs = [...device].filter(([, e]) => e.isDir && e.unenumerated).map(([p]) => p).sort();
  if (dirs.length === 0) return null;
  const shown = dirs.slice(0, 3).join(', ') + (dirs.length > 3 ? `, +${dirs.length - 3} more` : '');
  return `${dirs.length} device folder${dirs.length === 1 ? '' : 's'} could not be listed, so this ` +
    `plan is incomplete: ${shown}. Nothing inside them was counted, and nothing inside them will be ` +
    `removed — removing a folder on the device deletes everything under it, and no one has seen ` +
    `what is in there.${extra} Scan again to retry those folders — a slow Bluetooth link is the ` +
    `usual cause.`;
}

/**
 * @param {object} input
 * @param {Map<string, {size:number, hash?:string, isDir:boolean}>} input.local
 * @param {Map<string, {size:number, hash?:string, isDir:boolean}>} input.device
 * @param {object} input.state       entries recorded after the previous sync
 * @param {string} input.deviceRoot  e.g. "E:/amiibo"
 * @param {object} [input.options]   {mode, delete, excludes}
 */
export function planSync({ local, device, state = { entries: {} }, deviceRoot, options = {} }) {
  const mode = options.mode || 'push';
  if (!MODES.includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const allowDelete = !!options.delete;
  const excludes = options.excludes || DEFAULT_EXCLUDES;
  const prev = state.entries || {};
  const protectedDirs = unenumeratedDirs(device);
  const shadowed = shadowedBy(protectedDirs);

  const plan = {
    mode,
    deviceRoot,
    mkdirDevice: [],
    mkdirLocal: [],
    upload: [],
    download: [],
    moveDevice: [],
    deleteDevice: [],
    deleteLocal: [],
    rmdirDevice: [],
    // What deletion would remove if it were enabled — always computed, so the
    // plan shows it rather than hiding it behind the checkbox.
    wouldDelete: [],
    conflicts: [],
    blocked: [],
    unchanged: [],
    ambiguous: [],
  };

  const localFiles = new Map();
  const deviceFiles = new Map();
  const localDirs = new Set();
  const deviceDirs = new Set();

  for (const [p, e] of local) {
    if (isExcluded(p, excludes)) continue;
    if (e.isDir) localDirs.add(p);
    else localFiles.set(p, e);
  }
  for (const [p, e] of device) {
    if (isExcluded(p, excludes)) continue;
    if (e.isDir) deviceDirs.add(p);
    else deviceFiles.set(p, e);
  }

  const paths = new Set([...localFiles.keys(), ...deviceFiles.keys()]);

  // Files the device has but local does not, that the state says we synced
  // before: candidates for a move rather than a delete + re-upload.
  const moveCandidates = new Map(); // hash -> device relPath
  for (const p of deviceFiles.keys()) {
    if (localFiles.has(p)) continue;
    const known = prev[p]?.hash;
    if (known) moveCandidates.set(known, p);
  }
  const movedFrom = new Set();

  // Moves are decided before anything else. Deciding them inside the main loop
  // made the outcome depend on sort order: renaming "Street fighter" to
  // "street fighter" put the device-only path first, which scheduled a delete,
  // and the local-only path later, which scheduled a move of the file that
  // delete had already claimed. With deletions running first, the rename then
  // failed against a source that no longer existed.
  const plannedMoves = new Map(); // local relPath -> device relPath it comes from
  if (mode === 'push' || mode === 'two-way') {
    for (const [relPath, l] of localFiles) {
      if (deviceFiles.has(relPath) || !l.hash) continue;
      // In two-way a local-only file that has a record was deleted on the
      // device; that is a deletion to reconcile, not a move.
      if (mode === 'two-way' && prev[relPath]) continue;
      const from = moveCandidates.get(l.hash);
      if (!from || movedFrom.has(from)) continue;
      if (checkDestination(deviceRoot, relPath)) continue; // handled as blocked below
      movedFrom.add(from);
      plannedMoves.set(relPath, from);
    }
  }

  for (const relPath of [...paths].sort()) {
    const l = localFiles.get(relPath);
    const d = deviceFiles.get(relPath);
    const s = prev[relPath];

    // ---- present on both sides -----------------------------------------
    if (l && d) {
      const knownDeviceHash = d.hash ?? (d.size === s?.size ? s?.hash : undefined);
      const localChanged = s ? l.hash !== s.hash : undefined;
      const deviceChanged = s ? knownDeviceHash !== s.hash : undefined;

      if (knownDeviceHash !== undefined && l.hash === knownDeviceHash) {
        plan.unchanged.push(relPath);
        continue;
      }

      // Different sizes settle it without needing a hash: the contents cannot
      // match. This is the state a failed upload leaves behind — vfs_open_file
      // creates the file before vfs_write_file fills it, so a push that runs
      // out of room leaves a 0-byte file where a 540-byte dump should be, and
      // treating that as unknowable would strand it there permanently.
      const sizeDiffers = l.size !== d.size;

      // Same size, no record: equal size proves nothing, since every amiibo
      // dump is 540 bytes. Do not guess.
      if (!s && knownDeviceHash === undefined && !sizeDiffers) {
        plan.ambiguous.push({
          relPath,
          reason: 'present on both sides with no sync record; content not verified',
        });
        continue;
      }

      if (sizeDiffers && !s) {
        // No record to say which side moved, so direction decides.
        if (mode === 'pull') {
          queueLocalDirs(plan, relPath, localDirs);
          addDownload(plan, relPath, d);
        } else {
          addUpload(plan, relPath, l, deviceRoot, deviceDirs, localDirs);
        }
        continue;
      }

      if (localChanged && deviceChanged) {
        plan.conflicts.push({ relPath, reason: 'changed on both sides since the last sync' });
        continue;
      }

      if (mode === 'push') {
        addUpload(plan, relPath, l, deviceRoot, deviceDirs, localDirs);
      } else if (mode === 'pull') {
        queueLocalDirs(plan, relPath, localDirs);
        addDownload(plan, relPath, d);
      } else if (localChanged) {
        addUpload(plan, relPath, l, deviceRoot, deviceDirs, localDirs);
      } else if (deviceChanged) {
        queueLocalDirs(plan, relPath, localDirs);
        addDownload(plan, relPath, d);
      } else {
        plan.unchanged.push(relPath);
      }
      continue;
    }

    // ---- local only ------------------------------------------------------
    if (l && !d) {
      const deletedOnDevice = !!s; // we synced it before, so the device lost it

      // A virtual entry has no file behind it — it is a dump held in memory,
      // unpacked from an all-in-one bundle. There is nothing on disk to delete,
      // and asking would fail the operation, so leave it out of the mirror
      // entirely: dropping it from the bundle is the user's job, not sync's.
      if (l.virtual && (mode === 'pull' || (mode === 'two-way' && deletedOnDevice))) {
        plan.unchanged.push(relPath);
        continue;
      }

      // A file under a folder we could not list only *looks* device-only. The
      // device may well still hold it, so mirroring the device onto your disk
      // here would delete a local copy on the strength of a listing that never
      // happened. Uploads are untouched: this blocks deletions, not transfers.
      if (shadowed(relPath) && (mode === 'pull' || (mode === 'two-way' && deletedOnDevice))) {
        plan.ambiguous.push({
          relPath,
          reason: 'its folder on the device could not be listed, so we cannot tell whether the device still has it',
        });
        continue;
      }

      // pull mirrors in the other direction: the device is master.
      if (mode === 'pull') {
        if (allowDelete) plan.deleteLocal.push({ relPath, size: l.size });
        else plan.wouldDelete.push({ relPath, side: 'local', size: l.size });
        continue;
      }
      if (mode === 'two-way' && deletedOnDevice) {
        if (l.hash === s.hash) {
          if (allowDelete) plan.deleteLocal.push({ relPath });
          else plan.ambiguous.push({ relPath, reason: 'removed on device; --delete is off' });
        } else {
          plan.conflicts.push({
            relPath,
            reason: 'removed on the device but modified locally',
          });
        }
        continue;
      }

      // A file that vanished from one path and appeared at another is a move,
      // decided in the pre-pass above.
      const from = plannedMoves.get(relPath);
      if (from) {
        queueDeviceDirs(plan, relPath, deviceDirs, deviceRoot);
        plan.moveDevice.push({ from, to: relPath });
        continue;
      }
      if (l.hash && moveCandidates.has(l.hash)) {
        const why = checkDestination(deviceRoot, relPath);
        if (why) {
          plan.blocked.push({ relPath, action: 'move', reason: why });
          continue;
        }
      }

      addUpload(plan, relPath, l, deviceRoot, deviceDirs, localDirs);
      continue;
    }

    // ---- device only -----------------------------------------------------
    if (d && !l) {
      if (movedFrom.has(relPath)) continue; // already accounted for as a move
      const deletedLocally = !!s;

      // push mirrors: local is master, so anything the device holds that local
      // does not is surplus. This does not consult the sync state — "mirror my
      // folder" must behave the same on the first run as on the hundredth.
      if (mode === 'push') {
        if (allowDelete) plan.deleteDevice.push({ relPath, size: d.size });
        else plan.wouldDelete.push({ relPath, side: 'device', size: d.size });
        continue;
      }
      if (mode === 'two-way' && deletedLocally) {
        const knownDeviceHash = d.hash ?? (d.size === s.size ? s.hash : undefined);
        if (knownDeviceHash !== undefined && knownDeviceHash === s.hash) {
          if (allowDelete) plan.deleteDevice.push({ relPath, size: d.size });
          else plan.ambiguous.push({ relPath, reason: 'removed locally; --delete is off' });
        } else {
          plan.conflicts.push({
            relPath,
            reason: 'removed locally but modified on the device',
          });
        }
        continue;
      }

      queueLocalDirs(plan, relPath, localDirs);
      addDownload(plan, relPath, d);
    }
  }

  // Empty folders that exist on one side only, so an intentionally empty
  // folder still round-trips.
  if (mode === 'push' || mode === 'two-way') {
    for (const dir of localDirs) {
      if (deviceDirs.has(dir) || isExcluded(dir, excludes)) continue;
      const why = checkDestination(deviceRoot, dir);
      if (why) plan.blocked.push({ relPath: dir, action: 'mkdir', reason: why });
      else queueDeviceDirs(plan, `${dir}/x`, deviceDirs, deviceRoot);
    }
  }
  if (mode === 'pull' || mode === 'two-way') {
    for (const dir of deviceDirs) {
      if (localDirs.has(dir) || isExcluded(dir, excludes)) continue;
      queueLocalDirs(plan, `${dir}/x`, localDirs);
    }
  }

  // Folders left empty by deletions. Emitted deepest-first and only when the
  // folder is genuinely gone from the source side — never as a shortcut for
  // deleting contents, because remove() is recursive.
  if (allowDelete && (mode === 'push' || mode === 'two-way')) {
    const deleting = new Set(plan.deleteDevice.map((d) => d.relPath));

    // Everything that will still be on the device afterwards. Excluded files
    // were filtered out of deviceFiles, so consult the raw index for them —
    // a folder containing one must never be removed.
    const survivors = [...deviceFiles.keys()].filter((p) => !deleting.has(p));
    for (const [p, e] of device) if (!e.isDir && isExcluded(p, excludes)) survivors.push(p);

    const candidates = new Set();
    for (const dir of deviceDirs) {
      if (localDirs.has(dir) || isExcluded(dir, excludes)) continue;
      // A folder we never listed is not empty, it is unread — and remove() is
      // recursive. The surviving-subfolder rule below would also spare it once
      // a flagged child is out of `candidates`, but that only holds while the
      // child is present in deviceDirs; this does not depend on it.
      if (protectedDirs.has(dir)) continue;
      // In two-way a folder we have never seen is not ours to remove; push is
      // an explicit mirror, so it removes surplus folders either way.
      if (mode === 'two-way' && !prev[dir] && !hasStateUnder(prev, dir)) continue;
      candidates.add(dir);
    }

    // remove() deletes recursively, so a folder may only go once nothing
    // beneath it survives — no surviving file, and no surviving subfolder.
    const doomed = [...candidates].filter((dir) => {
      const prefix = `${dir}/`;
      if (survivors.some((p) => p.startsWith(prefix))) return false;
      for (const other of deviceDirs) {
        if (other !== dir && other.startsWith(prefix) && !candidates.has(other)) return false;
      }
      return true;
    });

    doomed.sort((a, b) => depth(b) - depth(a) || b.localeCompare(a));
    for (const dir of doomed) plan.rmdirDevice.push({ relPath: dir });
  }

  // A local folder that shares no paths at all with the device usually means
  // the device root is wrong — e.g. pointing at "E:/amiibo" while the local
  // folder itself contains an "amiibo" directory, which shifts every relative
  // path by one level and makes a sync look like a full replacement.
  plan.warnings = [];

  // Scope is whatever root is configured. At a bare drive root the sweep
  // includes device-managed trees such as amiibolink/ and chameleon/, which
  // are only protected by being outside the default root.
  if (allowDelete && /^[IE]:\/?$/.test(deviceRoot.trim())) {
    plan.warnings.push(
      `Device folder is the whole drive (${deviceRoot}) and deletions are enabled. ` +
        `That puts amiibolink/, chameleon/ and anything else on the drive in scope. ` +
        `Point at a subfolder such as E:/amiibo unless you really mean to mirror the entire drive.`
    );
  }

  const unlisted = unenumeratedWarning(device, ' Files still transfer normally.');
  if (unlisted) plan.warnings.push(unlisted);

  const overlap = [...localFiles.keys()].filter((p) => deviceFiles.has(p)).length;
  // With a folder unlisted the two sides genuinely cannot overlap much, and
  // the warning above is the right diagnosis. Blaming the device root would
  // send the user off re-pointing a setting that was never wrong.
  if (localFiles.size > 0 && deviceFiles.size > 0 && overlap === 0 && protectedDirs.size === 0) {
    plan.warnings.push(
      `No path is shared between the ${localFiles.size} local and ${deviceFiles.size} device files. ` +
        `Check that the device folder matches your local folder's contents — if your local folder ` +
        `*contains* a subfolder mirroring the device root, point at that subfolder instead.`
    );
  }

  // Uploading before deleting means the device briefly holds both copies. On a
  // 1.9 MB drive that can simply not fit, so when the incoming data does not
  // fit in the free space as it stands, delete first and reclaim the room.
  //
  // Upload-first is preferred where it fits: nothing is destroyed until the
  // new copy is safely on the device.
  // Costed as the device stores them, not as raw content.
  const uploadBytes = plan.upload.reduce((n, u) => n + storedSize(u.size), 0);
  const freeingBytes = plan.deleteDevice.reduce((n, d) => n + storedSize(d.size ?? 0), 0);

  // An upload onto a path the device already holds needs no room for a second
  // copy: vfs_open_file opens with TRUNC, so the old contents go before the new
  // ones arrive, and the space is reclaimed as each file is written rather than
  // all at once at the end. Charging those uploads full price made a refresh of
  // files already on the device look like it needed the whole library again.
  const replacingBytes = plan.upload.reduce(
    (n, u) => n + (deviceFiles.has(u.relPath) ? storedSize(deviceFiles.get(u.relPath).size ?? 0) : 0),
    0
  );
  const drive = options.drive ?? null;

  if (drive && Number.isFinite(drive.totalSize) && Number.isFinite(driveFreeBytes(drive))) {
    const freeNow = driveFreeBytes(drive);
    const roomForUploads = freeNow + replacingBytes;
    // A replacement deletes first by default. Local is the source of truth, so
    // nothing unique is lost, and it avoids needing room for both copies at
    // once — which is what actually broke a full replace on this hardware.
    plan.deleteFirst = options.preferDeleteFirst
      ? freeingBytes > 0
      : uploadBytes > roomForUploads && freeingBytes > 0;
    const usableBytes = roomForUploads + freeingBytes;
    plan.capacity = {
      totalSize: drive.totalSize,
      usedSize: drive.totalSize - freeNow,
      freeNow,
      uploadBytes,
      freeingBytes,
      replacingBytes,
      freeAfterDeletes: freeNow + freeingBytes,
      usableBytes,
      fits: uploadBytes <= usableBytes,
    };

    if (!plan.capacity.fits) {
      plan.warnings.push(
        `Not enough room: the uploads need about ${uploadBytes} bytes once filesystem overhead ` +
          `is counted (~${STORAGE_OVERHEAD_PER_FILE} bytes per file on top of its contents), and ` +
          `only ${usableBytes} bytes are available even after the planned deletions` +
          (replacingBytes ? ` and the files being overwritten` : '') + `. ` +
          `Sync a smaller folder, or remove something from the device first.`
      );
    } else if (plan.deleteFirst) {
      plan.warnings.push(
        `Deleting before uploading, to make room: about ${uploadBytes} bytes are going on and ` +
          `${freeNow} bytes are free now, ${freeingBytes} more once the deletions run. The device ` +
          `is short of files until the uploads finish — everything removed is in your local folder.`
      );
    }
  }

  plan.unenumerated = unenumeratedList(device);
  plan.stats = {
    overlap,
    unenumerated: plan.unenumerated.length,
    upload: plan.upload.length,
    download: plan.download.length,
    moveDevice: plan.moveDevice.length,
    deleteDevice: plan.deleteDevice.length,
    deleteLocal: plan.deleteLocal.length,
    mkdirDevice: plan.mkdirDevice.length,
    mkdirLocal: plan.mkdirLocal.length,
    rmdirDevice: plan.rmdirDevice.length,
    wouldDelete: plan.wouldDelete.length,
    unchanged: plan.unchanged.length,
    conflicts: plan.conflicts.length,
    blocked: plan.blocked.length,
    ambiguous: plan.ambiguous.length,
    uploadBytes: plan.upload.reduce((n, u) => n + u.size, 0),
    downloadBytes: plan.download.reduce((n, u) => n + u.size, 0),
  };
  plan.stats.estimatedSeconds = estimateSeconds(plan);
  return plan;
}

function hasStateUnder(prev, dir) {
  const prefix = `${dir}/`;
  return Object.keys(prev).some((p) => p.startsWith(prefix));
}

function addUpload(plan, relPath, entry, deviceRoot, deviceDirs, localDirs) {
  const why = checkDestination(deviceRoot, relPath);
  if (why) {
    plan.blocked.push({ relPath, action: 'upload', reason: why });
    return;
  }
  queueDeviceDirs(plan, relPath, deviceDirs, deviceRoot);
  plan.upload.push({ relPath, size: entry.size, hash: entry.hash });
}

// create_folder is not idempotent, so only queue folders the index shows are
// absent, and only once.
function queueDeviceDirs(plan, relPath, deviceDirs, deviceRoot) {
  for (const dir of parentDirs(relPath)) {
    if (deviceDirs.has(dir)) continue;
    const why = checkDestination(deviceRoot, dir);
    if (why) {
      plan.blocked.push({ relPath: dir, action: 'mkdir', reason: why });
      return;
    }
    deviceDirs.add(dir);
    plan.mkdirDevice.push({ relPath: dir });
  }
}

function queueLocalDirs(plan, relPath, localDirs) {
  for (const dir of parentDirs(relPath)) {
    if (localDirs.has(dir)) continue;
    localDirs.add(dir);
    plan.mkdirLocal.push({ relPath: dir, localPath: sanitizeLocalRelPath(dir) });
  }
}

// Records a download destination, noting when the local filesystem forces a
// different name than the device uses.
function addDownload(plan, relPath, entry) {
  const localPath = sanitizeLocalRelPath(relPath);
  if (localPath !== relPath) {
    plan.renamedLocally ??= [];
    plan.renamedLocally.push({ from: relPath, to: localPath });
  }
  plan.download.push({
    relPath,
    localPath,
    size: entry.size,
    amiiboId: entry.amiiboId ?? null,
  });
}

// Wall-clock estimate, calibrated against two real runs rather than from the
// per-chunk throughput figure, which turned out to be five times optimistic:
//
//   a full download    866 files in ~370 s   ->  427 ms each
//   a full push        729 dumps in ~1850 s  -> 2538 ms each
//   its deletions      831 files in ~197 s   ->  237 ms each
//
// An upload costs far more than its chunks suggest because open and close are
// themselves round-trips, and it is that fixed cost that dominates a library
// of 540-byte files.
const OPEN_CLOSE_MS = 2200;
const WRITE_CHUNK_MS = 100;
const DOWNLOAD_MS = 430;
const COMMAND_MS = 240;
const CHUNK = 242;

export function estimateSeconds(plan) {
  let ms = 0;
  for (const u of plan.upload) ms += OPEN_CLOSE_MS + Math.ceil(u.size / CHUNK) * WRITE_CHUNK_MS;
  ms += plan.download.length * DOWNLOAD_MS;
  ms += (plan.moveDevice.length + plan.deleteDevice.length + plan.mkdirDevice.length +
         plan.rmdirDevice.length) * COMMAND_MS;
  return Math.round(ms / 1000);
}

/**
 * Compare the two sides by content alone, ignoring names and folders.
 *
 * Path-based sync cannot answer "is this dump on the device anywhere?" once a
 * file has been renamed or refiled. This groups both sides by content hash
 * instead, so a dump counts as present if its bytes exist anywhere on the
 * other side.
 *
 * Every device entry must carry a `hash`, which means reading each file back
 * (~0.2 s each) — the caller decides when that is worth it.
 *
 * Note that two dumps of the same character are not necessarily identical:
 * UID and save data differ, so this finds byte-identical copies, not "do I
 * have this character somewhere".
 */
export function compareByContent({ local, device, excludes = DEFAULT_EXCLUDES, identity = 'amiibo' }) {
  // Identity by amiibo ID, not by bytes. Two dumps of the same character
  // differ in UID and save data, so byte comparison reports them as different
  // figures — measured at 1035 local dumps collapsing to 943 amiibo IDs.
  // Files with no readable ID (not amiibo dumps) fall back to their hash.
  const keyOf = (e) =>
    identity === 'amiibo' ? e.amiiboId ?? (e.hash ? `bytes:${e.hash}` : null) : e.hash ?? null;

  const byHash = (index) => {
    const map = new Map();
    for (const [relPath, e] of index) {
      if (e.isDir || isExcluded(relPath, excludes)) continue;
      const key = keyOf(e);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ relPath, size: e.size, hash: e.hash, amiiboId: e.amiiboId });
    }
    return map;
  };

  const localByHash = byHash(local);
  const deviceByHash = byHash(device);

  const missingLocally = [];
  const missingOnDevice = [];
  const relocated = [];
  const variants = [];
  const duplicateOnDevice = [];
  const duplicateLocally = [];

  for (const [hash, entries] of deviceByHash) {
    const localEntries = localByHash.get(hash);
    if (!localEntries) {
      for (const e of entries) missingLocally.push({ ...e, hash });
    } else {
      if (!entries.some((d) => localEntries.some((l) => l.relPath === d.relPath))) {
        // Same amiibo on both sides, but filed somewhere else.
        relocated.push({ hash, device: entries.map((e) => e.relPath), local: localEntries.map((e) => e.relPath) });
      }
      // The amiibo matches but the device holds a dump whose bytes are absent
      // locally. Real case: Skylanders light and dark variants share one ID,
      // so an ID-only view would call the dark figure "already held".
      if (identity === 'amiibo') {
        const localBytes = new Set(localEntries.map((e) => e.hash).filter(Boolean));
        const extra = entries.filter((e) => e.hash && !localBytes.has(e.hash));
        if (extra.length && localBytes.size) {
          variants.push({
            id: entries[0].amiiboId ?? hash,
            device: extra.map((e) => e.relPath),
            local: localEntries.map((e) => e.relPath),
          });
        }
      }
    }
    if (entries.length > 1) duplicateOnDevice.push({ hash, paths: entries.map((e) => e.relPath) });
  }

  for (const [hash, entries] of localByHash) {
    if (!deviceByHash.has(hash)) {
      for (const e of entries) missingOnDevice.push({ ...e, hash });
    }
    if (entries.length > 1) duplicateLocally.push({ hash, paths: entries.map((e) => e.relPath) });
  }

  const sortByPath = (a, b) => a.relPath.localeCompare(b.relPath);
  missingLocally.sort(sortByPath);
  missingOnDevice.sort(sortByPath);

  return {
    missingLocally,
    missingOnDevice,
    relocated,
    variants,
    duplicateOnDevice,
    duplicateLocally,
    stats: {
      deviceFiles: [...deviceByHash.values()].reduce((n, e) => n + e.length, 0),
      localFiles: [...localByHash.values()].reduce((n, e) => n + e.length, 0),
      deviceUnique: deviceByHash.size,
      localUnique: localByHash.size,
      missingLocally: missingLocally.length,
      missingOnDevice: missingOnDevice.length,
      relocated: relocated.length,
      variants: variants.length,
    },
  };
}

// Flat, ordered list of operations for the executor: folders before the files
// that need them, uploads and downloads next, deletions last (files before the
// folders that contained them).
export function flattenPlan(plan) {
  const ops = [];
  const deviceDeletes = [
    ...plan.deleteDevice.map((d) => ({ op: 'deleteDevice', ...d })),
    ...plan.rmdirDevice.map((d) => ({ op: 'rmdirDevice', ...d })),
  ];

  for (const m of plan.mkdirLocal) ops.push({ op: 'mkdirLocal', ...m });

  // Normally the device only loses files once their replacements are safely
  // on it. When the incoming data will not fit alongside what is there, that
  // order is impossible and deletions have to come first.
  if (plan.deleteFirst) ops.push(...deviceDeletes);

  for (const m of plan.mkdirDevice) ops.push({ op: 'mkdirDevice', ...m });
  for (const m of plan.moveDevice) ops.push({ op: 'moveDevice', ...m });
  for (const u of plan.upload) ops.push({ op: 'upload', ...u });
  for (const d of plan.download) ops.push({ op: 'download', ...d });

  if (!plan.deleteFirst) ops.push(...deviceDeletes);
  for (const d of plan.deleteLocal) ops.push({ op: 'deleteLocal', ...d });
  return ops;
}

/**
 * Plan a sync by amiibo identity rather than by path.
 *
 * Path matching is useless across libraries that are organised differently —
 * two copies of one collection can share zero paths — so this asks "is this
 * amiibo on the other side at all, under any name?".
 *
 * Identity is the amiibo ID, plus the vehicle for Air Riders, falling back to
 * the content hash when neither distinguishes two dumps. That keeps all 91
 * Animal Crossing item cards and all four vehicle pairings, which an ID-only
 * rule would collapse into one.
 *
 * Destinations mirror the source layout: a push keeps your local folder
 * structure on the device. Anything that will not fit the device's 63-byte
 * path limit is reported rather than truncated, since the firmware truncates
 * silently (PROTOCOL.md §4.5).
 */
export function planIdentitySync({ local, device, deviceRoot, options = {} }) {
  const direction = options.direction ?? 'both'; // 'push' | 'pull' | 'both'
  const excludes = options.excludes || DEFAULT_EXCLUDES;

  const identityOf = (e) => {
    if (!e.amiiboId) return null;
    return `${e.amiiboId}:${e.vehicle ?? e.hash ?? ''}`;
  };

  const index = (map) => {
    const byIdentity = new Map();
    for (const [relPath, e] of map) {
      if (e.isDir || isExcluded(relPath, excludes)) continue;
      const key = identityOf(e);
      if (!key) continue;
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push({ relPath, ...e });
    }
    return byIdentity;
  };

  const localBy = index(local);
  const deviceBy = index(device);

  const plan = {
    mode: `identity-${direction}`,
    deviceRoot,
    mkdirDevice: [],
    mkdirLocal: [],
    upload: [],
    download: [],
    moveDevice: [],
    deleteDevice: [],
    deleteLocal: [],
    rmdirDevice: [],
    wouldDelete: [],
    conflicts: [],
    blocked: [],
    unchanged: [],
    ambiguous: [],
    warnings: [],
  };

  const deviceDirs = new Set();
  const localDirs = new Set();
  for (const [p, e] of device) if (e.isDir) deviceDirs.add(p);
  for (const [p, e] of local) if (e.isDir) localDirs.add(p);

  let onBothSides = 0;

  if (direction === 'push' || direction === 'both') {
    for (const [key, entries] of localBy) {
      if (deviceBy.has(key)) {
        onBothSides++;
        plan.unchanged.push(entries[0].relPath);
        continue;
      }
      // One dump per identity is enough; the rest are copies of it.
      const source = entries[0];
      const why = checkDestination(deviceRoot, source.relPath);
      if (why) {
        plan.blocked.push({ relPath: source.relPath, action: 'upload', reason: why, identity: key });
        continue;
      }
      queueDeviceDirs(plan, source.relPath, deviceDirs, deviceRoot);
      plan.upload.push({
        relPath: source.relPath,
        size: source.size,
        hash: source.hash,
        amiiboId: source.amiiboId,
        vehicle: source.vehicle ?? null,
      });
    }
  }

  if (direction === 'pull' || direction === 'both') {
    for (const [key, entries] of deviceBy) {
      if (localBy.has(key)) {
        if (direction === 'pull') {
          onBothSides++;
          plan.unchanged.push(entries[0].relPath);
        }
        continue;
      }
      const source = entries[0];
      queueLocalDirs(plan, source.relPath, localDirs);
      addDownload(plan, source.relPath, source);
    }
  }

  const unidentified = [...local, ...device].filter(
    ([p, e]) => !e.isDir && !isExcluded(p, excludes) && !e.amiiboId
  ).length;
  if (unidentified) {
    plan.warnings.push(
      `${unidentified} file(s) carry no readable amiibo ID and are left alone — ` +
        `identity sync can only move what it can identify.`
    );
  }

  // No deletions to guard here, but an amiibo sitting in a folder we could not
  // list reads as absent — so this can re-upload a copy the device already has.
  const unlisted = unenumeratedWarning(
    device,
    ' An amiibo inside one reads as missing, so it may be sent again.'
  );
  if (unlisted) plan.warnings.push(unlisted);

  plan.unenumerated = unenumeratedList(device);
  plan.stats = {
    onBothSides,
    unenumerated: plan.unenumerated.length,
    upload: plan.upload.length,
    download: plan.download.length,
    moveDevice: 0,
    deleteDevice: 0,
    deleteLocal: 0,
    mkdirDevice: plan.mkdirDevice.length,
    mkdirLocal: plan.mkdirLocal.length,
    rmdirDevice: 0,
    wouldDelete: 0,
    unchanged: plan.unchanged.length,
    conflicts: 0,
    blocked: plan.blocked.length,
    ambiguous: 0,
    localIdentities: localBy.size,
    deviceIdentities: deviceBy.size,
    uploadBytes: plan.upload.reduce((n, u) => n + u.size, 0),
    downloadBytes: plan.download.reduce((n, d) => n + d.size, 0),
  };
  plan.stats.estimatedSeconds = estimateSeconds(plan);
  return plan;
}

/**
 * Plan a full download of the device into the local folder.
 *
 * This is a backup, not a reconciliation: it takes everything under the device
 * root, mirroring the device's own layout. Nothing is written to the device and
 * nothing is deleted on either side.
 *
 * Files already held locally at the same path are skipped only when their
 * content is known to match — size alone will not do, since every amiibo dump
 * is 540 bytes. Without a recorded hash the file is fetched again, because a
 * backup that quietly skips a changed file is not a backup.
 */
export function planDump({ device, local = new Map(), state = { entries: {} }, deviceRoot, options = {} }) {
  const excludes = options.excludes || DEFAULT_EXCLUDES;
  const includeDeviceFiles = !!options.includeDeviceFiles;
  const force = !!options.force;
  const prev = state.entries || {};

  const plan = {
    mode: 'dump',
    deviceRoot,
    mkdirDevice: [],
    mkdirLocal: [],
    upload: [],
    download: [],
    moveDevice: [],
    deleteDevice: [],
    deleteLocal: [],
    rmdirDevice: [],
    wouldDelete: [],
    conflicts: [],
    blocked: [],
    unchanged: [],
    ambiguous: [],
    warnings: [],
  };

  const localDirs = new Set();
  for (const [p, e] of local) if (e.isDir) localDirs.add(p);

  let skippedDeviceFiles = 0;

  for (const [relPath, entry] of device) {
    if (entry.isDir) {
      if (!localDirs.has(relPath)) {
        localDirs.add(relPath);
        plan.mkdirLocal.push({ relPath, localPath: sanitizeLocalRelPath(relPath) });
      }
      continue;
    }
    // settings.bin and key_retail.bin are device state. They are included only
    // on request, since a backup of the drive arguably wants them.
    if (isExcluded(relPath, excludes)) {
      if (!includeDeviceFiles) {
        skippedDeviceFiles++;
        continue;
      }
    }

    // The local copy lives at the sanitised path, which is not always the
    // device's path.
    const here = local.get(sanitizeLocalRelPath(relPath));
    const record = prev[relPath];

    // Skipping needs evidence that the local copy is still the device's copy.
    // Two ways to have it:
    //   - the device entry carries a hash, which only happens when the caller
    //     has already read the files
    //   - this path was downloaded before, the local file still hashes to what
    //     was written, and the device file is still that size
    // Size alone is never enough: every dump is 540 bytes.
    const verified = here && entry.hash && here.hash && entry.hash === here.hash;
    const recorded =
      here && record && here.hash === record.hash && entry.size === record.size;

    if (!force && (verified || recorded)) {
      plan.unchanged.push(relPath);
      continue;
    }

    queueLocalDirs(plan, relPath, localDirs);
    addDownload(plan, relPath, entry);
  }

  if (plan.unchanged.length && !force) {
    plan.warnings.push(
      `${plan.unchanged.length} file(s) skipped: already downloaded, unchanged locally, and ` +
        `still the same size on the device. A device-side edit that kept the size would not be ` +
        `noticed — tick "download everything again" to re-fetch regardless.`
    );
  }

  if (skippedDeviceFiles) {
    plan.warnings.push(
      `${skippedDeviceFiles} device file(s) skipped as device state (settings.bin, key_retail.bin). ` +
        `Enable "include device files" to back those up too.`
    );
  }

  // A backup that silently omits a subtree is the worst outcome here: nothing
  // is destroyed, but the user believes they have a copy they do not have.
  const unlisted = unenumeratedWarning(device, ' Nothing inside them was backed up.');
  if (unlisted) plan.warnings.push(unlisted);

  plan.unenumerated = unenumeratedList(device);
  plan.stats = {
    unenumerated: plan.unenumerated.length,
    upload: 0,
    download: plan.download.length,
    moveDevice: 0,
    deleteDevice: 0,
    deleteLocal: 0,
    mkdirDevice: 0,
    mkdirLocal: plan.mkdirLocal.length,
    rmdirDevice: 0,
    wouldDelete: 0,
    unchanged: plan.unchanged.length,
    conflicts: 0,
    blocked: 0,
    ambiguous: 0,
    uploadBytes: 0,
    downloadBytes: plan.download.reduce((n, d) => n + d.size, 0),
  };
  plan.stats.estimatedSeconds = estimateSeconds(plan);
  return plan;
}

/**
 * Plan a genuine replacement: clear the device root, then write the local
 * folder onto it.
 *
 * Distinct from a mirror, which skips files it believes are already correct.
 * That belief rests on recorded hashes and on sizes, and every amiibo dump is
 * 540 bytes — so a device file that is the right size and the wrong content
 * would survive a mirror indefinitely. A replacement does not ask: everything
 * goes, everything is written again.
 *
 * The cost is the whole library over a ~2 KB/s link, and the device is empty
 * in between. The local folder is the source of truth throughout, so an
 * interrupted run loses nothing that is not still on disk.
 */
export function planReplace({ local, device, deviceRoot, options = {} }) {
  const excludes = options.excludes || DEFAULT_EXCLUDES;

  const plan = {
    mode: 'replace',
    deviceRoot,
    mkdirDevice: [],
    mkdirLocal: [],
    upload: [],
    download: [],
    moveDevice: [],
    deleteDevice: [],
    deleteLocal: [],
    rmdirDevice: [],
    wouldDelete: [],
    conflicts: [],
    blocked: [],
    unchanged: [],
    ambiguous: [],
    warnings: [],
    deleteFirst: true, // a replacement always clears before it writes
  };

  // Everything on the device goes, except what the device owns — and except
  // what we could not see. A replacement may wipe what it showed the user; a
  // folder that never listed was never shown, and remove() would take its
  // unread contents with it.
  const protectedDirs = unenumeratedDirs(device);
  const deviceDirs = [];
  for (const [relPath, e] of device) {
    if (isExcluded(relPath, excludes)) continue;
    if (e.isDir) {
      if (!protectedDirs.has(relPath)) deviceDirs.push(relPath);
    } else {
      plan.deleteDevice.push({ relPath, size: e.size });
    }
  }
  deviceDirs.sort((a, b) => depth(b) - depth(a) || b.localeCompare(a));
  for (const relPath of deviceDirs) plan.rmdirDevice.push({ relPath });

  // Then the local folder is written onto the empty root.
  const created = new Set();
  for (const [relPath, e] of local) {
    if (e.isDir || isExcluded(relPath, excludes)) continue;
    const why = checkDestination(deviceRoot, relPath);
    if (why) {
      plan.blocked.push({ relPath, action: 'upload', reason: why });
      continue;
    }
    queueDeviceDirs(plan, relPath, created, deviceRoot);
    plan.upload.push({ relPath, size: e.size, hash: e.hash, amiiboId: e.amiiboId ?? null });
  }

  const uploadBytes = plan.upload.reduce((n, u) => n + storedSize(u.size), 0);
  const drive = options.drive ?? null;
  if (drive && Number.isFinite(drive.totalSize)) {
    const freeingBytes = plan.deleteDevice.reduce((n, d) => n + storedSize(d.size ?? 0), 0);
    // Normally the device is empty by the time the uploads run, so the whole
    // drive is what has to hold them. Not so when a folder could not be
    // listed: its contents stay put, and planning against the full drive would
    // promise room that is still occupied — the run would then die hundreds of
    // uploads in, on a device it had already cleared.
    const cleared = protectedDirs.size === 0;
    const usableBytes = cleared ? drive.totalSize : driveFreeBytes(drive) + freeingBytes;
    plan.capacity = {
      totalSize: drive.totalSize,
      usedSize: drive.totalSize - driveFreeBytes(drive),
      freeNow: driveFreeBytes(drive),
      uploadBytes,
      freeingBytes,
      // Nothing is overwritten in place: the root is emptied first.
      replacingBytes: 0,
      freeAfterDeletes: cleared ? drive.totalSize : driveFreeBytes(drive) + freeingBytes,
      usableBytes,
      fits: uploadBytes <= usableBytes,
    };
    if (!plan.capacity.fits) {
      plan.warnings.push(
        `Will not fit: the uploads need about ${uploadBytes} bytes once filesystem overhead is ` +
          `counted, and ${cleared ? `the drive holds ${drive.totalSize}` :
            `only ${usableBytes} can be freed — folders that could not be listed stay as they are`}. ` +
          `Sync a smaller folder.`
      );
    }
  }

  plan.warnings.push(
    `Everything under ${deviceRoot} is deleted first, then the whole local folder is written ` +
      `back — ${plan.upload.length} file(s), nothing skipped. The device is empty in between. ` +
      `Use Smart sync instead to transfer only what differs.`
  );

  const unlisted = unenumeratedWarning(
    device,
    ' So this is not a complete replacement: those folders and everything under them are left exactly as they are.'
  );
  if (unlisted) plan.warnings.push(unlisted);

  plan.unenumerated = unenumeratedList(device);
  plan.stats = {
    unenumerated: plan.unenumerated.length,
    upload: plan.upload.length,
    download: 0,
    moveDevice: 0,
    deleteDevice: plan.deleteDevice.length,
    deleteLocal: 0,
    mkdirDevice: plan.mkdirDevice.length,
    mkdirLocal: 0,
    rmdirDevice: plan.rmdirDevice.length,
    wouldDelete: 0,
    unchanged: 0,
    conflicts: 0,
    blocked: plan.blocked.length,
    ambiguous: 0,
    uploadBytes,
    downloadBytes: 0,
  };
  plan.stats.estimatedSeconds = estimateSeconds(plan);
  return plan;
}
