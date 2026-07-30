// Local folder access via the File System Access API, plus SHA-256 hashing.
// Browser-only (Chrome/Edge). No dependencies.

import { parseAmiiboId, parseVehicle, parseUid, isHhdItemCards } from './amiibo.js';
import { detectBundle } from './bundle.js';

const DB_NAME = 'allmiibo-sync';
const STORE = 'handles';
const HANDLE_KEY = 'syncRoot';

export const STATE_FILENAME = '.allmiibo-sync.json';

// One index entry, from bytes already in hand. Shared by both readers so the
// directory walk and the file-input fallback can never describe a file
// differently.
async function describeFile(buf, { size, lastModified, hash = true }) {
  // The bytes are already here — and this is the only reliable way to tell
  // which amiibo a dump actually is.
  const amiiboId = parseAmiiboId(buf);
  const vehicle = parseVehicle(buf);
  return {
    size,
    hash: hash ? await sha256(buf) : null,
    amiiboId,
    vehicle: vehicle?.name ?? vehicle?.code ?? null,
    // The HHD pack shares one amiibo ID; the UID tells the cards apart.
    uid: amiiboId && isHhdItemCards(amiiboId) ? parseUid(buf) : null,
    // Not a dump, but a whole library in one file. Recorded here because the
    // bytes are open anyway; bundlesource.js decides what to do about it.
    // Without this the planner would happily send the container itself to a
    // device that cannot read it — half a megabyte over a 2 kB/s link.
    bundle: amiiboId ? null : detectBundle(buf),
    isDir: false,
    lastModified,
  };
}

export function available() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await rememberHandle(handle);
  return handle;
}

// ---- handle persistence (so the folder survives a reload) ---------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function rememberHandle(handle) {
  try {
    await idb('readwrite', (s) => s.put(handle, HANDLE_KEY));
  } catch {
    // Persistence is a convenience; carry on without it.
  }
}

// Forget the remembered folder so the next load starts clean.
export async function forgetDirectory() {
  try {
    await idb('readwrite', (s) => s.delete(HANDLE_KEY));
  } catch {
    // Nothing to forget, or storage unavailable — either way, done.
  }
}

// Returns the previously chosen folder if permission is still granted, else null.
export async function restoreDirectory({ prompt = false } = {}) {
  let handle;
  try {
    handle = await idb('readonly', (s) => s.get(HANDLE_KEY));
  } catch {
    return null;
  }
  if (!handle) return null;

  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return handle;
  if (prompt && (await handle.requestPermission(opts)) === 'granted') return handle;
  return null;
}

// ---- read-only fallback (Firefox, Safari) --------------------------------

// Browsers without the File System Access API still have the old
// <input webkitdirectory> mechanism: a one-shot, read-only folder pick that
// hands over every file in the tree. Enough to scan and track a collection;
// not enough to write files back or remember the folder.
export function pickDirectoryFiles() {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('No folder chosen.'), { name: 'AbortError' }));
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.addEventListener('change', () => (input.files.length ? resolve([...input.files]) : abort()));
    input.addEventListener('cancel', abort);
    input.click();
  });
}

// Build the same index shape walkLocal produces, from a webkitdirectory file
// list. Paths arrive as "chosen-folder/sub/file.bin"; the leading segment is
// the chosen folder itself, so it is stripped to match walkLocal's relPaths.
export async function indexFromFiles(files, { onProgress = () => {}, hash = true } = {}) {
  const index = new Map();
  // Kept so a caller can read a file's bytes again later — unpacking an
  // all-in-one bundle needs them, and without a directory handle there is no
  // other way back to them.
  const byPath = new Map();
  let folderName = '';
  let count = 0;
  for (const f of files) {
    const full = f.webkitRelativePath || f.name;
    const cut = full.indexOf('/');
    if (cut !== -1 && !folderName) folderName = full.slice(0, cut);
    const relPath = cut === -1 ? full : full.slice(cut + 1);
    if (relPath.split('/').pop() === STATE_FILENAME) continue;
    const buf = new Uint8Array(await f.arrayBuffer());
    index.set(
      relPath,
      await describeFile(buf, { size: f.size, lastModified: f.lastModified, hash })
    );
    byPath.set(relPath, f);
    onProgress(++count, relPath);
  }
  return { folderName, index, byPath };
}

// ---- traversal ----------------------------------------------------------

// Walk the tree into the same shape the planner expects:
//   Map<relPath, {size, hash, isDir}>
// Files are hashed as they are read — local reads are cheap compared with the
// ~2 KB/s BLE link, and every amiibo dump is 540 bytes so size alone cannot
// detect a change.
// `hash` is skippable: the collection page only needs identity, and hashing
// ~1000 files it will never compare is pure wasted time. Sync keeps hashes.
export async function walkLocal(rootHandle, { onProgress = () => {}, hash = true } = {}) {
  const index = new Map();
  let count = 0;

  async function walk(dirHandle, prefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        index.set(relPath, { size: 0, isDir: true });
        await walk(handle, relPath);
      } else {
        if (name === STATE_FILENAME) continue;
        const f = await handle.getFile();
        const buf = new Uint8Array(await f.arrayBuffer());
        index.set(
          relPath,
          await describeFile(buf, { size: f.size, lastModified: f.lastModified, hash })
        );
        onProgress(++count, relPath);
      }
    }
  }

  await walk(rootHandle, '');
  return index;
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- file operations ----------------------------------------------------

async function resolveDir(rootHandle, relDir, { create = false } = {}) {
  let handle = rootHandle;
  if (!relDir) return handle;
  for (const part of relDir.split('/')) {
    handle = await handle.getDirectoryHandle(part, { create });
  }
  return handle;
}

function split(relPath) {
  const i = relPath.lastIndexOf('/');
  return i === -1 ? ['', relPath] : [relPath.slice(0, i), relPath.slice(i + 1)];
}

export async function readLocalFile(rootHandle, relPath) {
  const [dirPath, name] = split(relPath);
  const dir = await resolveDir(rootHandle, dirPath);
  const fh = await dir.getFileHandle(name);
  const f = await fh.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

export async function writeLocalFile(rootHandle, relPath, bytes) {
  const [dirPath, name] = split(relPath);
  const dir = await resolveDir(rootHandle, dirPath, { create: true });
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

export async function makeLocalDir(rootHandle, relPath) {
  await resolveDir(rootHandle, relPath, { create: true });
}

export async function removeLocalFile(rootHandle, relPath) {
  const [dirPath, name] = split(relPath);
  const dir = await resolveDir(rootHandle, dirPath);
  await dir.removeEntry(name);
}

// ---- sync state ---------------------------------------------------------

export async function loadState(rootHandle) {
  try {
    const fh = await rootHandle.getFileHandle(STATE_FILENAME);
    const f = await fh.getFile();
    const parsed = JSON.parse(await f.text());
    if (!parsed.entries) parsed.entries = {};
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

export async function saveState(rootHandle, state) {
  const fh = await rootHandle.getFileHandle(STATE_FILENAME, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(state, null, 2));
  await w.close();
}
