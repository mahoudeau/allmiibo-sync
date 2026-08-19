// Sync executor: walks the device, builds an index, and applies a plan.
//
// State is saved after every successful operation, so a disconnect part-way
// through a long push does not restart from zero — at ~2 KB/s a full library
// push is around seven minutes.

import { joinPath, MAX_PATH_BYTES } from './protocol.js';
import { parseAmiiboId, parseVehicle, parseUid, isHhdItemCards } from './amiibo.js';
import { devicePath, isExcluded, DEFAULT_EXCLUDES } from './planner.js';
import {
  readLocalFile,
  writeLocalFile,
  makeLocalDir,
  removeLocalFile,
  removeLocalDir,
  moveLocalFile,
  saveState,
  sha256,
} from './localfs.js';

// Why a directory in this index may carry `unenumerated`, and what it means.
//
// A folder is recorded before its contents are read, so a folder we never
// managed to list looks exactly like an empty one. That distinction is not
// cosmetic: remove() is recursive (PROTOCOL.md §9.4), so a planner that reads
// "no children" as "safe to remove" would erase a subtree nobody has seen.
//
// So the flag goes on when the entry is created and comes off only once the
// listing has been consumed to the very end. Every early exit — a stop, a
// throw from deeper down, some future `break` — therefore leaves it set by
// construction, and the invariant holds for reasons nobody has thought of yet.
export const UNENUMERATED = {
  pending: 'not-listed',   // never reached; only seen if the walk exits early
  deep: 'too-deep',        // its children cannot be addressed within 63 bytes
  failed: 'unlistable',    // read_dir failed twice
  stopped: 'stopped',      // the user stopped the walk
};

// Walk the device below `deviceRoot` into the planner's index shape:
//   Map<relPath, {size, isDir}>
// Sizes only — hashing would cost a full read per file.
//
// The only descent limit is the device's own: VFS_MAX_PATH_LEN caps every
// addressable path at MAX_PATH_BYTES, so a subtree whose path cannot fit is
// unreachable for the firmware too. (FAT has no symlinks, so cycles cannot
// occur.)
export async function walkDevice(client, deviceRoot, { onProgress = () => {}, shouldStop = () => false } = {}) {
  const index = new Map();
  const encoder = new TextEncoder();
  let files = 0;

  const mark = (relPath, reason, error = null) => {
    const e = index.get(relPath);
    if (e) index.set(relPath, { ...e, unenumerated: reason, listError: error });
  };
  // Absent, not false: every consumer tests truthiness, and a stray `false`
  // in the index would be one more thing to remember to look at.
  const clear = (relPath) => {
    const e = index.get(relPath);
    if (!e) return; // the root itself has no entry
    const { unenumerated, listError, ...rest } = e;
    index.set(relPath, rest);
  };

  async function walk(relDir) {
    if (shouldStop()) return;
    const full = devicePath(deviceRoot, relDir);
    // One retry, the same idiom hashDeviceIndex uses below: over a link slow
    // enough to take minutes on one folder, a single late or dropped reply is
    // not evidence that a folder is unreadable.
    const entries = await client.readDir(full).catch(() => client.readDir(full));

    for (const e of entries) {
      if (shouldStop()) return; // relDir stays marked
      if (e.name === '.' || e.name === '..') continue;
      const relPath = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDir) {
        index.set(relPath, { size: 0, isDir: true, meta: e.meta, unenumerated: UNENUMERATED.pending });
        // Entering the folder means addressing children at path + "/x" at
        // minimum; if even that cannot fit, the subtree is out of reach.
        if (encoder.encode(devicePath(deviceRoot, relPath)).length + 2 <= MAX_PATH_BYTES) {
          // One unreadable folder must not cost the other eight hundred files.
          try {
            await walk(relPath);
          } catch (err) {
            mark(relPath, UNENUMERATED.failed, err.message);
          }
        } else {
          mark(relPath, UNENUMERATED.deep);
        }
      } else {
        index.set(relPath, { size: e.size, isDir: false, meta: e.meta });
        onProgress(++files, relPath);
      }
    }
    clear(relDir);
  }

  // No try/catch at the root. A device we could not list at all is not a
  // partial truth, it is no truth: an empty index would read as "the device is
  // empty", turning a failed scan into a silent empty backup or a full
  // re-upload of a library that is already there.
  await walk('');
  if (shouldStop()) {
    for (const [p, e] of index) {
      if (e.unenumerated === UNENUMERATED.pending) mark(p, UNENUMERATED.stopped);
    }
  }
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
      // One retry: a 15-minute BLE session hits transient errors, and a
      // file skipped here silently vanishes from the collection count.
      const bytes = await client.readFile(devicePath(deviceRoot, relPath))
        .catch(() => client.readFile(devicePath(deviceRoot, relPath)));
      const v = parseVehicle(bytes);
      const amiiboId = parseAmiiboId(bytes);
      out.set(relPath, {
        ...entry,
        hash: await sha256(bytes),
        amiiboId,
        vehicle: v?.name ?? v?.code ?? null,
        uid: amiiboId && isHhdItemCards(amiiboId) ? parseUid(bytes) : null,
      });
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
 * @param {Function} [ctx.readFile]   async (relPath) => Uint8Array, for uploads.
 *   Defaults to reading the sync folder. Overridden when some of what is being
 *   uploaded has no file behind it — the members of an all-in-one bundle live
 *   in memory, not on disk.
 */
export async function applyPlan({
  client,
  rootHandle,
  deviceRoot,
  state,
  ops,
  callbacks = {},
  readFile = (relPath) => readLocalFile(rootHandle, relPath),
}) {
  const { onOp = () => {}, onProgress = () => {}, onError = () => {}, shouldStop = () => false } = callbacks;

  // Every operation is recorded, not just the failures, so a run that goes
  // wrong can be examined afterwards rather than reconstructed from a scrolled
  // log. Timings included: they are what reveal a device slowing down or a
  // command class that is unusually expensive.
  const result = { completed: 0, failed: 0, stopped: false, errors: [], log: [] };
  const startedAt = Date.now();
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

    const opStarted = Date.now();
    const record = {
      n: i + 1,
      at: opStarted - startedAt,
      op: op.op,
      path: op.relPath ?? op.from ?? null,
      to: op.to ?? op.localPath ?? null,
      size: op.size ?? null,
    };

    try {
      await runOp(op);
      result.completed++;
      record.ok = true;
      record.ms = Date.now() - opStarted;
      result.log.push(record);
      await persist();
    } catch (err) {
      result.failed++;
      const message = `${op.op} ${op.relPath ?? op.from ?? ''}: ${err.message}`;
      result.errors.push(message);
      record.ok = false;
      record.ms = Date.now() - opStarted;
      record.error = err.message;
      // A protocol failure carries its command and status; both matter when
      // working out why the device refused.
      if (err.cmd !== undefined) record.cmd = err.cmd;
      if (err.status !== undefined) record.status = err.status;
      result.log.push(record);
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
        // localPath, not relPath: the device permits names the browser will
        // not create, such as a folder ending in a space.
        await makeLocalDir(rootHandle, op.localPath ?? op.relPath);
        return;

      case 'upload': {
        const bytes = await readFile(op.relPath);
        // One retry, the walkDevice/hashDeviceIndex idiom: over a session long
        // enough to move a library, one transient BLE failure is not evidence
        // the file cannot transfer — and without this, it costs the run a file.
        await client.writeFile(full(op.relPath), bytes, (written, total) =>
          onProgress(op.relPath, written, total)
        ).catch(() => client.writeFile(full(op.relPath), bytes, (written, total) =>
          onProgress(op.relPath, written, total)
        ));
        state.entries[op.relPath] = {
          size: bytes.length,
          hash: op.hash || (await sha256(bytes)),
        };
        return;
      }

      case 'download': {
        // Same single retry as upload above.
        const bytes = await client.readFile(full(op.relPath))
          .catch(() => client.readFile(full(op.relPath)));
        await writeLocalFile(rootHandle, op.localPath ?? op.relPath, bytes);
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

      case 'moveLocal': {
        await moveLocalFile(rootHandle, op.from, op.to);
        const carried = state.entries[op.from];
        delete state.entries[op.from];
        if (carried) state.entries[op.to] = carried;
        return;
      }

      case 'deleteLocal':
        await removeLocalFile(rootHandle, op.relPath);
        delete state.entries[op.relPath];
        return;

      case 'rmdirLocal':
        // Only ever called on a folder the plan has already emptied, and
        // removeLocalDir is not recursive, so a mistake fails loudly here
        // rather than taking a subtree with it.
        await removeLocalDir(rootHandle, op.relPath);
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
