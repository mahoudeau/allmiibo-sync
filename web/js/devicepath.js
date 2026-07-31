// Device path rules: byte limits, safe names, and the two coordinate systems.
//
// These live apart from planner.js for one structural reason. The database
// generator needs them — a curated filename or a pinned path has to be checked
// against the same limits the app enforces, or the two drift and a device ends
// up with a truncated name. But planner.js imports amiibo.js, which imports the
// database being generated, so the generator importing planner.js would validate
// against the *previous* database and would fail outright on a corrupt one.
//
// Nothing here imports anything but the two protocol constants, so it is safe
// from Node, from the browser, and from the generator.
//
// planner.js re-exports every one of these, so no existing call site changes.

import { MAX_PATH_BYTES, MAX_NAME_BYTES } from './protocol.js';

const encoder = new TextEncoder();

export { MAX_PATH_BYTES, MAX_NAME_BYTES };

/** Length in UTF-8 bytes, which is what the device counts. */
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
