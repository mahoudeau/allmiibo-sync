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
  '.DS_Store',
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

      // No record and no verified device hash: sizes match but every amiibo
      // dump is 540 bytes, so equal size proves nothing. Do not guess.
      if (!s && knownDeviceHash === undefined) {
        plan.ambiguous.push({
          relPath,
          reason: 'present on both sides with no sync record; content not verified',
        });
        continue;
      }

      if (localChanged && deviceChanged) {
        plan.conflicts.push({ relPath, reason: 'changed on both sides since the last sync' });
        continue;
      }

      if (mode === 'push') {
        addUpload(plan, relPath, l, deviceRoot, deviceDirs, localDirs);
      } else if (mode === 'pull') {
        plan.download.push({ relPath, size: d.size });
        queueLocalDirs(plan, relPath, localDirs);
      } else if (localChanged) {
        addUpload(plan, relPath, l, deviceRoot, deviceDirs, localDirs);
      } else if (deviceChanged) {
        plan.download.push({ relPath, size: d.size });
        queueLocalDirs(plan, relPath, localDirs);
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

      // A file that vanished from one path and appeared at another is a move.
      const from = l.hash ? moveCandidates.get(l.hash) : undefined;
      if (from && !movedFrom.has(from)) {
        const why = checkDestination(deviceRoot, relPath);
        if (why) {
          plan.blocked.push({ relPath, action: 'move', reason: why });
        } else {
          movedFrom.add(from);
          queueDeviceDirs(plan, relPath, deviceDirs, deviceRoot);
          plan.moveDevice.push({ from, to: relPath });
        }
        continue;
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
          if (allowDelete) plan.deleteDevice.push({ relPath });
          else plan.ambiguous.push({ relPath, reason: 'removed locally; --delete is off' });
        } else {
          plan.conflicts.push({
            relPath,
            reason: 'removed locally but modified on the device',
          });
        }
        continue;
      }

      plan.download.push({ relPath, size: d.size });
      queueLocalDirs(plan, relPath, localDirs);
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
    plan.mkdirLocal.push({ relPath: dir });
  }
}

// Rough wall-clock estimate from the measured ~2 KB/s and ~60 ms per command
// (PROTOCOL.md §9.6). Uploads cost open + ceil(size/242) writes + close.
export function estimateSeconds(plan) {
  const CMD_MS = 60;
  const WRITE_CHUNK_MS = 118;
  const CHUNK = 242;
  let ms = 0;
  for (const u of plan.upload) ms += 2 * CMD_MS + Math.ceil(u.size / CHUNK) * WRITE_CHUNK_MS;
  for (const d of plan.download) ms += 3 * CMD_MS;
  ms += plan.moveDevice.length * CMD_MS;
  ms += plan.deleteDevice.length * CMD_MS;
  ms += plan.mkdirDevice.length * CMD_MS;
  ms += plan.rmdirDevice.length * CMD_MS;
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
  for (const m of plan.mkdirLocal) ops.push({ op: 'mkdirLocal', ...m });
  for (const m of plan.mkdirDevice) ops.push({ op: 'mkdirDevice', ...m });
  for (const m of plan.moveDevice) ops.push({ op: 'moveDevice', ...m });
  for (const u of plan.upload) ops.push({ op: 'upload', ...u });
  for (const d of plan.download) ops.push({ op: 'download', ...d });
  for (const d of plan.deleteDevice) ops.push({ op: 'deleteDevice', ...d });
  for (const d of plan.deleteLocal) ops.push({ op: 'deleteLocal', ...d });
  for (const d of plan.rmdirDevice) ops.push({ op: 'rmdirDevice', ...d });
  return ops;
}
