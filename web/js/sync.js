// Sync executor: walks the device, builds an index, and applies a plan.
//
// State is saved after every successful operation, so a disconnect part-way
// through a long push does not restart from zero — at ~2 KB/s a full library
// push is around seven minutes.

import { joinPath } from './protocol.js';
import { devicePath, isExcluded, DEFAULT_EXCLUDES } from './planner.js';
import {
  readLocalFile,
  writeLocalFile,
  makeLocalDir,
  removeLocalFile,
  saveState,
  sha256,
} from './localfs.js';

// Walk the device below `deviceRoot` into the planner's index shape:
//   Map<relPath, {size, isDir}>
// Sizes only — hashing would cost a full read per file.
export async function walkDevice(client, deviceRoot, { onProgress = () => {}, maxDepth = 8 } = {}) {
  const index = new Map();
  let files = 0;

  async function walk(relDir, depth) {
    const full = devicePath(deviceRoot, relDir);
    const entries = await client.readDir(full);
    for (const e of entries) {
      if (e.name === '.' || e.name === '..') continue;
      const relPath = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDir) {
        index.set(relPath, { size: 0, isDir: true, meta: e.meta });
        if (depth + 1 < maxDepth) await walk(relPath, depth + 1);
      } else {
        index.set(relPath, { size: e.size, isDir: false, meta: e.meta });
        onProgress(++files, relPath);
      }
    }
  }

  await walk('', 0);
  return index;
}

// Hash every file on the device by reading it back. At ~0.2 s per dump this
// is minutes for a full library, so it is only ever run on request. Returns a
// copy of the index with hashes filled in; already-hashed entries are skipped
// so an interrupted run can be resumed cheaply.
export async function hashDeviceIndex(client, deviceRoot, index, { onProgress = () => {}, shouldStop = () => false } = {}) {
  const out = new Map(index);
  const pending = [...index].filter(([, e]) => !e.isDir && !e.hash);
  let done = 0;

  for (const [relPath, entry] of pending) {
    if (shouldStop()) break;
    try {
      const bytes = await client.readFile(devicePath(deviceRoot, relPath));
      out.set(relPath, { ...entry, hash: await sha256(bytes) });
    } catch (err) {
      out.set(relPath, { ...entry, hashError: err.message });
    }
    onProgress(++done, pending.length, relPath);
  }
  return out;
}

// Read and hash selected device files so same-size files can be compared.
// Each costs a full read (~0.2 s for a dump), so the caller decides which.
export async function verifyDeviceHashes(client, deviceRoot, relPaths, { onProgress = () => {} } = {}) {
  const hashes = new Map();
  let done = 0;
  for (const relPath of relPaths) {
    const bytes = await client.readFile(devicePath(deviceRoot, relPath));
    hashes.set(relPath, await sha256(bytes));
    onProgress(++done, relPaths.length, relPath);
  }
  return hashes;
}

/**
 * Apply a flattened plan.
 *
 * @param {object} ctx
 * @param {AllmiiboClient} ctx.client
 * @param {FileSystemDirectoryHandle} ctx.rootHandle
 * @param {string} ctx.deviceRoot
 * @param {object} ctx.state          mutated and persisted as work completes
 * @param {Array}  ctx.ops            from flattenPlan()
 * @param {object} [ctx.callbacks]    {onOp, onProgress, onError, shouldStop}
 */
export async function applyPlan({
  client,
  rootHandle,
  deviceRoot,
  state,
  ops,
  callbacks = {},
}) {
  const { onOp = () => {}, onProgress = () => {}, onError = () => {}, shouldStop = () => false } = callbacks;

  const result = { completed: 0, failed: 0, stopped: false, errors: [] };
  let sinceSave = 0;

  const persist = async (force = false) => {
    sinceSave++;
    if (force || sinceSave >= 10) {
      sinceSave = 0;
      await saveState(rootHandle, state).catch((err) => onError(`saving state: ${err.message}`));
    }
  };

  for (const [i, op] of ops.entries()) {
    if (shouldStop()) {
      result.stopped = true;
      break;
    }
    onOp(op, i, ops.length);

    try {
      await runOp(op);
      result.completed++;
      await persist();
    } catch (err) {
      result.failed++;
      const message = `${op.op} ${op.relPath ?? op.from ?? ''}: ${err.message}`;
      result.errors.push(message);
      onError(message);
    }
  }

  await persist(true);
  return result;

  async function runOp(op) {
    const full = (rel) => devicePath(deviceRoot, rel);

    switch (op.op) {
      case 'mkdirDevice':
        await client.createFolder(full(op.relPath));
        return;

      case 'mkdirLocal':
        await makeLocalDir(rootHandle, op.relPath);
        return;

      case 'upload': {
        const bytes = await readLocalFile(rootHandle, op.relPath);
        await client.writeFile(full(op.relPath), bytes, (written, total) =>
          onProgress(op.relPath, written, total)
        );
        state.entries[op.relPath] = {
          size: bytes.length,
          hash: op.hash || (await sha256(bytes)),
        };
        return;
      }

      case 'download': {
        const bytes = await client.readFile(full(op.relPath));
        await writeLocalFile(rootHandle, op.relPath, bytes);
        state.entries[op.relPath] = { size: bytes.length, hash: await sha256(bytes) };
        onProgress(op.relPath, bytes.length, bytes.length);
        return;
      }

      case 'moveDevice': {
        await client.rename(full(op.from), full(op.to));
        const carried = state.entries[op.from];
        delete state.entries[op.from];
        if (carried) state.entries[op.to] = carried;
        return;
      }

      case 'deleteDevice':
        await client.remove(full(op.relPath));
        delete state.entries[op.relPath];
        return;

      case 'deleteLocal':
        await removeLocalFile(rootHandle, op.relPath);
        delete state.entries[op.relPath];
        return;

      case 'rmdirDevice':
        // remove() is recursive on the device, so only ever call it on a
        // folder the plan has already emptied.
        await client.remove(full(op.relPath));
        return;

      default:
        throw new Error(`unknown operation: ${op.op}`);
    }
  }
}

// Paths present on both sides with no recorded hash — the cases where size
// alone cannot decide, since every dump is 540 bytes.
export function ambiguousPaths(plan) {
  return plan.ambiguous.map((a) => a.relPath);
}

export { joinPath, isExcluded, DEFAULT_EXCLUDES };
