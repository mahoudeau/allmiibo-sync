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

import { MAX_PATH_BYTES, MAX_NAME_BYTES } from './protocol.js';

const encoder = new TextEncoder();

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

export function utf8Bytes(s) {
  return encoder.encode(s).length;
}

// Full device path for a relative path under the sync root, e.g.
// devicePath("E:/amiibo", "Zelda/Link.bin") === "E:/amiibo/Zelda/Link.bin"
export function devicePath(deviceRoot, relPath) {
  const root = deviceRoot.endsWith('/') ? deviceRoot.slice(0, -1) : deviceRoot;
  return relPath ? `${root}/${relPath}` : root;
}

// Returns null if the destination fits, or a human-readable reason if not.
export function checkDestination(deviceRoot, relPath) {
  const full = devicePath(deviceRoot, relPath);
  const bytes = utf8Bytes(full);
  if (bytes > MAX_PATH_BYTES) {
    return `path is ${bytes} bytes, over the ${MAX_PATH_BYTES}-byte limit`;
  }
  const name = full.slice(full.lastIndexOf('/') + 1);
  const nameBytes = utf8Bytes(name);
  if (nameBytes > MAX_NAME_BYTES) {
    return `filename is ${nameBytes} bytes, over the ${MAX_NAME_BYTES}-byte limit`;
  }
  return null;
}

// The device filesystem accepts names the browser will not create locally.
// Chrome's File System Access API enforces Windows naming rules on every
// platform, so a folder called "Dark Souls " — with a trailing space, which
// the device is perfectly happy with — fails with "Name is not allowed".
//
// Observed on a real device: two folders with trailing spaces, which killed
// four operations of an 870-operation backup.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ILLEGAL_LOCAL_CHARS = /[<>:"|?*\u0000-\u001f]/g;

/** A single path segment made safe for the local filesystem. */
export function sanitizeLocalName(name) {
  let out = name.replace(ILLEGAL_LOCAL_CHARS, '_');
  // Trailing spaces and dots are the ones that actually bite.
  out = out.replace(/[ .]+$/, '').replace(/^\s+/, '');
  if (WINDOWS_RESERVED.test(out)) out = `_${out}`;
  return out || '_';
}

/** A device-relative path made safe for the local filesystem. */
export function sanitizeLocalRelPath(relPath) {
  return relPath.split('/').map(sanitizeLocalName).join('/');
}

// A file costs far more than its bytes, and the margin matters: a replace
// planned on raw content bytes looked like it fit in 963 kB of free space and
// died 320 uploads into a 48-minute run.
//
// Two measurements, and they disagree:
//   - the drive reports 966,601 bytes used for 862 files holding 464,979 bytes
//     of content, which averages 1,121 bytes per file
//   - a real push filled 963,589 bytes of free space after 729 uploads of
//     540-byte dumps, i.e. 1,322 bytes each
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

  const overlap = [...localFiles.keys()].filter((p) => deviceFiles.has(p)).length;
  if (localFiles.size > 0 && deviceFiles.size > 0 && overlap === 0) {
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
  const drive = options.drive ?? null;

  if (drive && Number.isFinite(drive.totalSize) && Number.isFinite(drive.usedSize)) {
    const freeNow = drive.totalSize - drive.usedSize;
    // A replacement deletes first by default. Local is the source of truth, so
    // nothing unique is lost, and it avoids needing room for both copies at
    // once — which is what actually broke a full replace on this hardware.
    plan.deleteFirst = options.preferDeleteFirst
      ? freeingBytes > 0
      : uploadBytes > freeNow && freeingBytes > 0;
    plan.capacity = {
      totalSize: drive.totalSize,
      usedSize: drive.usedSize,
      freeNow,
      uploadBytes,
      freeingBytes,
      freeAfterDeletes: freeNow + freeingBytes,
      fits: uploadBytes <= freeNow + freeingBytes,
    };

    if (!plan.capacity.fits) {
      plan.warnings.push(
        `Not enough room: the uploads need about ${uploadBytes} bytes once filesystem overhead ` +
          `is counted (~${STORAGE_OVERHEAD_PER_FILE} bytes per file on top of its contents), and ` +
          `only ${freeNow + freeingBytes} bytes are free even after the planned deletions. ` +
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

  plan.stats = {
    overlap,
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

  plan.stats = {
    onBothSides,
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

  plan.stats = {
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

  // Everything on the device goes, except what the device owns.
  const deviceDirs = [];
  for (const [relPath, e] of device) {
    if (isExcluded(relPath, excludes)) continue;
    if (e.isDir) deviceDirs.push(relPath);
    else plan.deleteDevice.push({ relPath, size: e.size });
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
    // The device is empty by the time the uploads run, so the whole drive is
    // what has to hold them.
    plan.capacity = {
      totalSize: drive.totalSize,
      usedSize: drive.usedSize,
      freeNow: drive.totalSize - drive.usedSize,
      uploadBytes,
      freeingBytes: plan.deleteDevice.reduce((n, d) => n + storedSize(d.size ?? 0), 0),
      freeAfterDeletes: drive.totalSize,
      fits: uploadBytes <= drive.totalSize,
    };
    if (!plan.capacity.fits) {
      plan.warnings.push(
        `Will not fit: the uploads need about ${uploadBytes} bytes once filesystem overhead is ` +
          `counted, and the drive holds ${drive.totalSize}. Sync a smaller folder.`
      );
    }
  }

  plan.warnings.push(
    `Everything under ${deviceRoot} is deleted first, then the whole local folder is written ` +
      `back — ${plan.upload.length} file(s), nothing skipped. The device is empty in between. ` +
      `Use Smart sync instead to transfer only what differs.`
  );

  plan.stats = {
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
