// The sync engine, shared by the Collection's everyday sync panel and the
// Advanced sync page. Scanning, planning and applying live here; the pages
// only render. No DOM in this module.

import { planSync, planDump, planReplace, planIdentitySync, flattenPlan } from './planner.js';
import { walkDevice, verifyDeviceHashes, hashDeviceIndex, applyPlan, ambiguousPaths } from './sync.js';
import * as localfs from './localfs.js';

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
      { key: 'allowDelete', label: 'Also delete — removals carry over' },
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
    value: 'check', name: 'CHECK', ico: 'search', advanced: true,
    desc: 'Read every device file, report differences. Changes nothing.',
    opts: [],
  },
];

export const OP_VERBS = {
  upload: '\u2191 sending', download: '\u2193 saving',
  deleteDevice: '\u2715 deleting (device)', deleteLocal: '\u2715 deleting (local)',
  mkdirDevice: 'creating folder', mkdirLocal: 'creating folder',
  moveDevice: 'renaming', rmdirDevice: 'removing folder',
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
  switch (op) {
    case 'dump':
      return planDump({
        device, local, state, deviceRoot,
        options: { includeDeviceFiles: !!opts.includeDeviceFiles, force: !!opts.force },
      });
    case 'replace':
      return planReplace({ local, device, deviceRoot, options: { drive } });
    case 'smart':
      return planSync({
        local, device, state, deviceRoot,
        options: { mode: 'two-way', delete: !!opts.allowDelete, drive },
      });
    case 'identity':
      return planIdentitySync({ local, device, deviceRoot, options: { direction: 'both' } });
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
  if (drive) log('info', `drive ${drive.label}:/ — ${drive.usedSize} of ${drive.totalSize} bytes used`);

  status('Reading the device…');
  let device = await walkDevice(client, deviceRoot, {
    shouldStop,
    onProgress: (n) => { if (n % 50 === 0) status(`Reading the device… ${n}`); },
  });
  if (shouldStop()) throw Object.assign(new Error('Stopped.'), { stopped: true });
  log('ok', `device: ${count(device)} files, ${countDirs(device)} folders under ${deviceRoot}`);

  let plan = buildPlan({ op, local, device, state, deviceRoot, drive, opts });

  if (op === 'identity') {
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
    plan = buildPlan({ op, local, device, state, deviceRoot, drive, opts });
  }

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
    plan = buildPlan({ op, local, device, state, deviceRoot, drive, opts });
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
    },
    apply: null,
  };

  return { plan, state, local, device, drive, lastRun };
}

// Selection transfer: an identity plan in one direction, filtered to the
// chosen amiibo ids. Membership filtering (missing on the target side) is the
// caller's job — it owns localIds/deviceIds.
export async function planSelection({
  client, rootHandle, deviceRoot, direction, ids,
  deviceIndex, on = {}, shouldStop = () => false,
}) {
  const status = on.status ?? (() => {});
  const log = on.log ?? (() => {});
  const wanted = new Set(ids);

  status('Reading your folder…');
  const state = await localfs.loadState(rootHandle);
  // Identity keys need hashes on both sides.
  const local = await localfs.walkLocal(rootHandle, {
    hash: true,
    onProgress: (n) => { if (n % 100 === 0) status(`Reading your folder… ${n}`); },
  });
  log('ok', `local: ${count(local)} files`);

  const full = planIdentitySync({
    local, device: deviceIndex, deviceRoot, options: { direction },
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

  return { plan, state };
}

// Apply with humanised callbacks. on.op(text, i, total), on.bytes(written,
// total), on.error(message).
export async function applyThePlan({
  client, rootHandle, deviceRoot, state, plan,
  on = {}, shouldStop = () => false,
}) {
  const ops = flattenPlan(plan);
  const t0 = Date.now();
  const result = await applyPlan({
    client, rootHandle, deviceRoot, state, ops,
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
