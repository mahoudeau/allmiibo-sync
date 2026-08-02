// The sync engine, shared by the Collection's everyday sync panel and the
// Advanced sync page. Scanning, planning and applying live here; the pages
// only render. No DOM in this module.

import {
  planSync, planDump, planReplace, planIdentitySync, planOrganise, planWipe,
  flattenPlan, driveFreeBytes, estimateSeconds, unenumeratedDirs, isExcluded,
  DEFAULT_EXCLUDES, devicePath,
} from './planner.js';
import { walkDevice, verifyDeviceHashes, hashDeviceIndex, applyPlan, ambiguousPaths } from './sync.js';
import * as localfs from './localfs.js';
import { expandBundles, ownedKey } from './bundlesource.js';
import { packBundle, isLossyInBundle } from './bundle.js';
import { parseAmiiboId, parseUid, parseVehicle, isHhdItemCards } from './amiibo.js';

// Operation catalogue: labels, one-liners and per-op options. Options are
// stored per-op (prefs syncOpts) so one op can never arm another's checkboxes.
export const OPS = [
  {
    value: 'dump', name: 'BACKUP', ico: 'download',
    desc: 'Copy the device into your folder.',
    opts: [
      { key: 'force', label: 'Re-download files I already have' },
      { key: 'includeDeviceFiles', label: 'Include system files' },
    ],
  },
  {
    value: 'smart', name: 'SYNC', ico: 'sync',
    desc: 'Send each side the other\u2019s changes.',
    opts: [
      { key: 'allowDelete', label: 'Also delete (removals carry over)' },
      { key: 'verify', label: 'Verify doubtful files (slow)' },
    ],
  },
  {
    value: 'identity', name: 'MATCH', ico: 'sparkles', advanced: true,
    desc: 'Fill gaps by amiibo, ignore folder layout.',
    opts: [],
  },
  {
    value: 'replace', name: 'REPLACE', ico: 'upload', advanced: true, danger: true,
    desc: 'Wipe the device, write your folder fresh.',
    opts: [],
  },
  {
    value: 'wipe', name: 'WIPE', ico: 'trash', advanced: true, danger: true,
    desc: 'Erase the device folder. Your folder is untouched.',
    opts: [],
  },
  {
    value: 'organise-device', name: 'ORGANISE DEVICE', ico: 'move', advanced: true,
    desc: 'Rename and refile the device tidily. Reads every file first.',
    opts: [],
  },
  {
    value: 'organise-local', name: 'ORGANISE FOLDER', ico: 'move', advanced: true,
    desc: 'Rename and refile your folder tidily. Touches no device.',
    opts: [],
  },
  {
    value: 'check', name: 'CHECK', ico: 'search', advanced: true,
    desc: 'Read every device file, report differences. Changes nothing.',
    opts: [],
  },
  {
    value: 'bundle-local', name: 'PACK FOLDER', ico: 'download', advanced: true,
    desc: 'Write your folder into one all-in-one file.',
    opts: [],
  },
  {
    value: 'bundle-device', name: 'PACK DEVICE', ico: 'download', advanced: true,
    desc: 'Read the device into one all-in-one file.',
    opts: [],
  },
];

/** Operations that produce a file rather than a plan to apply. */
export const PACK_OPS = ['bundle-local', 'bundle-device'];

export const OP_VERBS = {
  upload: '\u2191 sending', download: '\u2193 saving',
  deleteDevice: '\u2715 deleting (device)', deleteLocal: '\u2715 deleting (local)',
  mkdirDevice: 'creating folder', mkdirLocal: 'creating folder',
  moveDevice: 'renaming', rmdirDevice: 'removing folder',
  moveLocal: 'renaming', rmdirLocal: 'removing folder',
};

export function hasWork(p) {
  return flattenPlan(p).length > 0;
}

export function count(index) {
  let n = 0;
  for (const e of index.values()) if (!e.isDir) n++;
  return n;
}

export function countDirs(index) {
  let n = 0;
  for (const e of index.values()) if (e.isDir) n++;
  return n;
}

export function buildPlan({ op, local, device, state, deviceRoot, drive, opts = {} }) {
  // An all-in-one bundle in the folder is added to `excludes` so the container
  // itself is never sent; its contents are already in `local` as virtual
  // entries. Undefined means "use the defaults", which every planner handles.
  const excludes = opts.excludes;
  switch (op) {
    case 'dump':
      return planDump({
        device, local, state, deviceRoot,
        options: { includeDeviceFiles: !!opts.includeDeviceFiles, force: !!opts.force, excludes },
      });
    case 'replace':
      return planReplace({ local, device, deviceRoot, options: { drive, excludes } });
    case 'wipe':
      return planWipe({ device, deviceRoot, options: { excludes } });
    case 'smart':
      return planSync({
        local, device, state, deviceRoot,
        options: { mode: 'two-way', delete: !!opts.allowDelete, drive, excludes },
      });
    case 'identity':
      return planIdentitySync({
        local, device, deviceRoot, options: { direction: 'both', excludes },
      });
    // walkRoot/destRoot differ only after a rescue, when the files are parked
    // in a sibling of the device folder; the caller passes both.
    case 'organise-device':
      return planOrganise({
        index: device, side: 'device',
        walkRoot: opts.walkRoot ?? deviceRoot,
        destRoot: opts.destRoot ?? deviceRoot,
        options: { excludes },
      });
    case 'organise-local':
      return planOrganise({
        index: local, side: 'local', walkRoot: '', options: { excludes },
      });
    default:
      throw new Error(`unknown operation: ${op}`);
  }
}

// Scan both sides and build the plan for `op`. Callbacks:
//   on.status(text)            — human progress line
//   on.progress(done, total, label, detail) — determinate progress
//   on.log(level, message)     — run log
export async function scanAndPlan({
  client, rootHandle, deviceRoot, op, opts = {},
  on = {}, shouldStop = () => false, firmwareVersion = null,
}) {
  const status = on.status ?? (() => {});
  const progress = on.progress ?? (() => {});
  const log = on.log ?? (() => {});

  status('Reading your folder…');
  const state = await localfs.loadState(rootHandle);
  const local = await localfs.walkLocal(rootHandle, {
    onProgress: (n) => { if (n % 100 === 0) status(`Reading your folder… ${n}`); },
  });
  log('ok', `local: ${count(local)} files, ${countDirs(local)} folders`);

  const drives = await client.getDriveList();
  const drive = drives.drives.find((d) => `${d.label}:/` === (deviceRoot.match(/^[IE]:\//)?.[0] ?? 'E:/'))
    ?? drives.drives[0] ?? null;
  if (drive) {
    log('info', `drive ${drive.label}:/ — ${drive.usedSize} of ${drive.totalSize} bytes used, ` +
      `${driveFreeBytes(drive)} free`);
  }

  status('Reading the device…');
  let device = await walkDevice(client, deviceRoot, {
    shouldStop,
    onProgress: (n) => { if (n % 50 === 0) status(`Reading the device… ${n}`); },
  });
  if (shouldStop()) throw Object.assign(new Error('Stopped.'), { stopped: true });
  log('ok', `device: ${count(device)} files, ${countDirs(device)} folders under ${deviceRoot}`);

  // Identifying the device first, so that unpacking a bundle below can tell
  // which of its amiibos the device already holds. Organise needs it for a
  // different reason: a dump's identity is in its bytes, never its filename,
  // so it cannot know where a file belongs without reading it.
  if (op === 'identity' || op === 'organise-device') {
    const toRead = [...device.values()].filter((e) => !e.isDir).length;
    log('info', `identifying ${toRead} device files…`);
    const t0 = Date.now();
    device = await hashDeviceIndex(client, deviceRoot, device, {
      shouldStop,
      onProgress: (done, n) => {
        const rate = done / Math.max(1, (Date.now() - t0) / 1000);
        progress(done, n, 'Identifying device files',
          `${done}/${n} · ~${Math.round((n - done) / Math.max(rate, 0.01))}s left`);
      },
    });
  }

  // An all-in-one bundle is a whole library in one file. Unpack it into the
  // local index so its amiibos sync individually, and exclude the container so
  // it is never sent to a device that cannot read it.
  const bundle = await expandBundles({
    index: local,
    read: (relPath) => localfs.readLocalFile(rootHandle, relPath),
    deviceRoot,
    device,
    hash: localfs.sha256,
  });
  let planOpts = opts;
  if (bundle.excludes.length) {
    planOpts = { ...opts, excludes: [...DEFAULT_EXCLUDES, ...bundle.excludes] };
    for (const b of bundle.report.bundles) {
      log('info',
        `${b.relPath}: all-in-one file, ${b.count} records, ${b.unique} amiibos, ` +
        `${b.added} to transfer, ${b.haveLocally} already in your folder` +
        (b.onDevice ? `, ${b.onDevice} already on the device` : ''));
      if (b.error) log('warn', `${b.relPath}: ${b.error}`);
      for (const x of b.blocked) log('warn', `${b.relPath}: skipped ${x.amiiboId}: ${x.reason}`);
      if (b.unknown) {
        log('warn', `${b.relPath}: ${b.unknown} records carried no readable amiibo ID`);
      }
      if (b.added && !bundle.report.deviceIdentified) {
        log('info',
          `${b.relPath}: the device was matched by path, not by amiibo. MATCH reads every ` +
          'device file, so it would catch a copy filed under another name');
      }
    }
    for (const [p, e] of bundle.virtual) if (!local.has(p)) local.set(p, e);
    log('ok', `local: ${count(local)} files after unpacking`);
  }

  let plan = buildPlan({ op, local, device, state, deviceRoot, drive, opts: planOpts });

  if (plan.ambiguous.length > 0 && opts.verify) {
    const paths = ambiguousPaths(plan);
    log('info', `verifying ${paths.length} files by reading them back…`);
    const hashes = await verifyDeviceHashes(client, deviceRoot, paths, {
      onProgress: (done, total) => progress(done, total, 'Verifying', `${done}/${total}`),
    });
    for (const [p, h] of hashes) {
      const existing = device.get(p);
      if (existing) device.set(p, { ...existing, hash: h });
    }
    plan = buildPlan({ op, local, device, state, deviceRoot, drive, opts: planOpts });
  }

  const lastRun = {
    generatedAt: new Date().toISOString(),
    operation: op,
    deviceRoot,
    firmware: firmwareVersion,
    drive,
    localFiles: count(local),
    deviceFiles: count(device),
    plan: {
      stats: plan.stats,
      capacity: plan.capacity ?? null,
      deleteFirst: !!plan.deleteFirst,
      warnings: plan.warnings ?? [],
      blocked: plan.blocked,
      conflicts: plan.conflicts,
      ambiguous: plan.ambiguous,
      renamedLocally: plan.renamedLocally ?? [],
      unenumerated: plan.unenumerated ?? [],
    },
    bundles: bundle.report.bundles,
    apply: null,
  };

  return { plan, state, local, device, drive, lastRun, bundle };
}

// Selection transfer: an identity plan in one direction, filtered to the
// chosen amiibo ids. Membership filtering (missing on the target side) is the
// caller's job — it owns localIds/deviceIds.
export async function planSelection({
  client, rootHandle, deviceRoot, direction, ids,
  deviceIndex, localIndex = null, readFile = null,
  on = {}, shouldStop = () => false,
}) {
  const status = on.status ?? (() => {});
  const log = on.log ?? (() => {});
  const wanted = new Set(ids);

  // Deleting needs no source, so it skips the folder walk and the bundle
  // expansion entirely — both exist to find bytes to send, and there are none.
  // It also means removing amiibos from a device works with no local folder
  // chosen at all.
  if (direction === 'delete-device') {
    // Still load the sync state when there is a folder: applyPlan drops each
    // deleted path from it, and a stale entry would make the next sync believe
    // the device had lost a file it was told to remove.
    const delState = rootHandle ? await localfs.loadState(rootHandle) : { entries: {} };
    return {
      plan: planDeviceDeletes(deviceIndex, wanted, deviceRoot),
      state: delState,
      sources: null,
      readFile: null,
    };
  }

  // `localIndex` is a source with no folder behind it: loose .bin files picked
  // on their own. Already indexed and hashed by the caller, so there is nothing
  // to walk.
  const read = readFile ?? ((relPath) => localfs.readLocalFile(rootHandle, relPath));
  status('Reading your folder…');
  const state = await localfs.loadState(rootHandle);
  // Identity keys need hashes on both sides.
  const local = localIndex ?? await localfs.walkLocal(rootHandle, {
    hash: true,
    onProgress: (n) => { if (n % 100 === 0) status(`Reading your folder… ${n}`); },
  });
  log('ok', `local: ${count(local)} files`);

  // The chosen amiibo may live in an all-in-one file rather than as a dump of
  // its own, so unpack before matching by identity.
  const bundle = await expandBundles({
    index: local,
    read,
    deviceRoot,
    device: deviceIndex,
    hash: localfs.sha256,
  });
  for (const [p, e] of bundle.virtual) if (!local.has(p)) local.set(p, e);

  const full = planIdentitySync({
    local, device: deviceIndex, deviceRoot,
    options: {
      direction,
      excludes: bundle.excludes.length ? [...DEFAULT_EXCLUDES, ...bundle.excludes] : undefined,
    },
  });

  // Keep only the chosen amiibo; everything else in the plan is dropped.
  const plan = {
    ...full,
    upload: full.upload.filter((u) => wanted.has(u.amiiboId)),
    download: full.download.filter((d) => wanted.has(d.amiiboId)),
    deleteDevice: [], deleteLocal: [], rmdirDevice: [], moveDevice: [],
  };
  // Folder creations only where a kept transfer still needs them.
  const neededDirs = (items, key) => {
    const dirs = new Set();
    for (const it of items) {
      const p = it[key] ?? it.relPath;
      let idx = p.lastIndexOf('/');
      while (idx > 0) { dirs.add(p.slice(0, idx)); idx = p.lastIndexOf('/', idx - 1); }
    }
    return dirs;
  };
  const upDirs = neededDirs(plan.upload, 'relPath');
  const downDirs = neededDirs(plan.download, 'localPath');
  plan.mkdirDevice = full.mkdirDevice.filter((m) => upDirs.has(m.relPath));
  plan.mkdirLocal = full.mkdirLocal.filter((m) => downDirs.has(m.relPath));

  // `read` is what the caller should hand to applyThePlan: it already routes a
  // picked file to its File object and everything else to the folder.
  return { plan, state, sources: bundle.sources, readFile: readFile ? read : null };
}

// Remove every device file belonging to the chosen amiibo, then sweep whatever
// folders that emptied.
//
// One amiibo id is not one file. All 91 HHD item cards share a single
// fabricated id and Air Riders vehicles share one four ways, so a selection of
// "one amiibo" can be ninety-one deletions. The caller must confirm against
// deleteDevice.length, never against the number of amiibo selected.
export function planDeviceDeletes(deviceIndex, wanted, deviceRoot) {
  const plan = emptyPlan('delete-selection', deviceRoot);
  const protectedDirs = unenumeratedDirs(deviceIndex);
  const going = new Set();

  for (const [relPath, e] of deviceIndex) {
    if (e.isDir || isExcluded(relPath)) continue;
    if (!e.amiiboId || !wanted.has(e.amiiboId)) continue;
    plan.deleteDevice.push({ relPath, size: e.size, amiiboId: e.amiiboId });
    going.add(relPath);
  }

  const survivors = [...deviceIndex.keys()].filter(
    (p) => !deviceIndex.get(p).isDir && !going.has(p)
  );
  const emptied = [...deviceIndex]
    .filter(([p, e]) => e.isDir && !protectedDirs.has(p) && !isExcluded(p))
    .map(([p]) => p)
    .filter((dir) => [...going].some((p) => p.startsWith(`${dir}/`)))
    .filter((dir) => !survivors.some((p) => p.startsWith(`${dir}/`)));

  emptied.sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a));
  for (const relPath of emptied) plan.rmdirDevice.push({ relPath });

  plan.stats = {
    upload: 0, download: 0, moveDevice: 0, moveLocal: 0,
    deleteDevice: plan.deleteDevice.length, deleteLocal: 0,
    mkdirDevice: 0, mkdirLocal: 0,
    rmdirDevice: plan.rmdirDevice.length, rmdirLocal: 0,
    wouldDelete: 0, unchanged: 0, conflicts: 0, blocked: 0, ambiguous: 0,
    uploadBytes: 0, downloadBytes: 0,
  };
  plan.stats.estimatedSeconds = estimateSeconds(plan);
  return plan;
}

function emptyPlan(mode, deviceRoot) {
  return {
    mode, deviceRoot,
    mkdirDevice: [], mkdirLocal: [], upload: [], download: [],
    moveDevice: [], moveLocal: [],
    deleteDevice: [], deleteLocal: [], rmdirDevice: [], rmdirLocal: [],
    wouldDelete: [], conflicts: [], blocked: [], unchanged: [], ambiguous: [],
    warnings: [],
  };
}

// Apply with humanised callbacks. on.op(text, i, total), on.bytes(written,
// total), on.error(message).
export async function applyThePlan({
  client, rootHandle, deviceRoot, state, plan,
  sources = null, readFile = null,
  on = {}, shouldStop = () => false,
}) {
  const ops = flattenPlan(plan);
  const t0 = Date.now();
  const result = await applyPlan({
    client, rootHandle, deviceRoot, state, ops,
    // Three places bytes can come from, in order: memory, for anything unpacked
    // from an all-in-one file; a caller-supplied reader, for loose files picked
    // without a folder; and the folder itself for everything else.
    readFile: sources || readFile
      ? (relPath) => sources?.get(relPath)
          ?? (readFile ? readFile(relPath) : localfs.readLocalFile(rootHandle, relPath))
      : undefined,
    callbacks: {
      onOp: (o, i, total) => {
        const label = o.op === 'moveDevice' ? `${o.from} → ${o.to}` : o.relPath;
        on.op?.(`${OP_VERBS[o.op] ?? o.op} ${label}`, i, total, t0);
      },
      onProgress: (relPath, written, total) => on.bytes?.(written, total),
      onError: (message) => on.error?.(message),
      shouldStop,
    },
  });
  result.seconds = Math.round((Date.now() - t0) / 1000);
  return result;
}

// ---- packing a library into one all-in-one file --------------------------
//
// The reverse of unpacking, and the same caveat applies in the other direction:
// a bundle record holds 540 bytes, so a 2048-byte Kirby Air Riders dump loses
// its vehicle on the way in. Those are reported rather than quietly shrunk, and
// the four vehicle variants of one character necessarily become one record.

async function packFrom({ paths, read, on = {}, shouldStop = () => false }) {
  const progress = on.progress ?? (() => {});
  const log = on.log ?? (() => {});

  const dumps = new Map(); // dedupe key -> 540 bytes
  const report = { read: 0, records: 0, duplicates: 0, lossy: [], skipped: [] };

  for (const [i, relPath] of paths.entries()) {
    if (shouldStop()) break;
    progress(i + 1, paths.length, 'Packing', `${i + 1}/${paths.length}`);

    let bytes;
    try {
      bytes = await read(relPath);
    } catch (err) {
      report.skipped.push({ relPath, reason: err.message });
      continue;
    }
    report.read++;

    const amiiboId = parseAmiiboId(bytes);
    if (!amiiboId) {
      report.skipped.push({ relPath, reason: 'not an amiibo dump' });
      continue;
    }

    // One record per amiibo, except the Happy Home Designer cards, which all
    // share one ID and are told apart by UID.
    const key = ownedKey(amiiboId, isHhdItemCards(amiiboId) ? parseUid(bytes) : null);
    if (dumps.has(key)) {
      report.duplicates++;
      continue;
    }

    if (isLossyInBundle(bytes.length)) {
      const vehicle = parseVehicle(bytes);
      report.lossy.push({ relPath, amiiboId, vehicle: vehicle?.name ?? vehicle?.code ?? null });
    }
    dumps.set(key, bytes);
  }

  // Ascending by amiibo ID, which is what the bundles in the wild do and what
  // makes the output reproducible.
  const ordered = [...dumps].sort((a, b) => a[0].localeCompare(b[0])).map(([, b]) => b);
  const file = packBundle(ordered);
  report.records = file.length / 572;

  if (report.duplicates) log('info', `${report.duplicates} duplicate dumps collapsed`);
  if (report.lossy.length) {
    log('warn',
      `${report.lossy.length} Air Riders dumps lost their vehicle: an all-in-one record holds ` +
      '540 bytes and the vehicle sits past the end, so each character becomes one entry');
  }
  for (const s of report.skipped) log('warn', `skipped ${s.relPath}: ${s.reason}`);

  return { bytes: file, report };
}

/** Pack the sync folder, bundles in it included, into one all-in-one file. */
export async function packFolder({
  rootHandle, deviceRoot = 'E:/amiibo', on = {}, shouldStop = () => false,
}) {
  const status = on.status ?? (() => {});
  const log = on.log ?? (() => {});

  status('Reading your folder…');
  const index = await localfs.walkLocal(rootHandle, {
    hash: false,
    onProgress: (n) => { if (n % 100 === 0) status(`Reading your folder… ${n}`); },
  });

  // A bundle already in the folder contributes its contents, not itself.
  const bundle = await expandBundles({
    index, deviceRoot,
    read: (relPath) => localfs.readLocalFile(rootHandle, relPath),
  });
  for (const [p, e] of bundle.virtual) if (!index.has(p)) index.set(p, e);

  const excluded = new Set(bundle.excludes);
  const paths = [...index]
    .filter(([p, e]) => !e.isDir && !excluded.has(p) && (e.amiiboId || e.virtual))
    .map(([p]) => p);
  log('ok', `${paths.length} dumps to pack`);

  return packFrom({
    paths,
    read: (relPath) => bundle.sources.get(relPath) ?? localfs.readLocalFile(rootHandle, relPath),
    on, shouldStop,
  });
}

/** Pack everything under `deviceRoot` into one all-in-one file. */
export async function packDevice({
  client, deviceRoot, on = {}, shouldStop = () => false,
}) {
  const status = on.status ?? (() => {});
  const log = on.log ?? (() => {});

  status('Reading the device…');
  const device = await walkDevice(client, deviceRoot, {
    shouldStop,
    onProgress: (n) => { if (n % 50 === 0) status(`Reading the device… ${n}`); },
  });
  const paths = [...device].filter(([, e]) => !e.isDir).map(([p]) => p);
  // Every file has to be read back over BLE at ~2 kB/s, so say so up front
  // rather than letting a four-minute wait look like a hang.
  log('info', `reading ${paths.length} device files, around ${estimateReadSeconds(paths.length)}s`);

  return packFrom({
    paths,
    read: (relPath) => client.readFile(devicePath(deviceRoot, relPath)),
    on, shouldStop,
  });
}

// Measured at roughly 0.2 s per dump for a device read.
const estimateReadSeconds = (n) => Math.round(n * 0.2);

/** A filename for a packed bundle, e.g. "allmiibo-all-in-one-412.bin". */
export function packFileName(records) {
  return `allmiibo-all-in-one-${records}.bin`;
}
