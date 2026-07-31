// Where curated data lives on the server, and how it is written safely.
//
// The overlay is the only thing the admin can change, and it is the input the
// database is generated from. Losing it, or half-writing it, would be the worst
// failure this service has. So:
//
//   - every write goes to a temporary file and is renamed into place, which is
//     atomic on the same filesystem. A crash mid-write leaves the old file
//     intact rather than a truncated one.
//   - every write keeps a timestamped copy first, so a bad edit is recoverable
//     without a backup system, a database, or git.
//   - nothing is written unless it validates. The overlay is parsed and checked
//     before it can replace anything.
//
// No dependencies: node built-ins only, like everything else here.

import { readFile, writeFile, rename, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { EMPTY_OVERLAY, parseOverlay, serializeOverlay, validateOverlay } from '../web/js/overlay.js';

/** Keep this many backups; older ones are pruned oldest-first after a write. */
export const KEEP_BACKUPS = 50;

/**
 * What a backup file may be called: an ISO stamp with `:` and `.` replaced.
 *
 * Exported so the HTTP route and the store check the same thing. Two copies of
 * a filename whitelist that drift is how a path traversal gets in, and the
 * route's copy is the one that would be forgotten.
 */
export const BACKUP_NAME_RE = /^[0-9TZ-]+\.json$/;

export class Store {
  /**
   * @param {object} opts
   * @param {string} opts.overlayPath  the live overlay file
   * @param {string} opts.backupDir    where timestamped copies go
   */
  constructor({ overlayPath, backupDir }) {
    this.overlayPath = overlayPath;
    this.backupDir = backupDir;
  }

  /** The overlay as committed on disk. A missing file means "nothing curated yet". */
  async read() {
    const text = await readFile(this.overlayPath, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (text === null) return { ...EMPTY_OVERLAY };
    return parseOverlay(text);
  }

  /** The raw text, for an export that should be byte-for-byte what is on disk. */
  async readRaw() {
    return readFile(this.overlayPath, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return serializeOverlay(EMPTY_OVERLAY);
      throw err;
    });
  }

  /**
   * Validate, back up, then atomically replace the overlay.
   *
   * @returns {Promise<{backup: string|null, bytes: number}>}
   * @throws  {Error} with every validation problem listed, having written nothing
   */
  async write(overlay) {
    const errors = validateOverlay(overlay);
    if (errors.length) {
      const err = new Error('the overlay is not valid');
      err.details = errors;
      throw err;
    }

    const text = serializeOverlay(overlay);
    const backup = await this.backup();

    // Same directory, so the rename is atomic rather than a cross-device copy.
    await mkdir(dirname(this.overlayPath), { recursive: true });
    const tmp = `${this.overlayPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, this.overlayPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }

    await this.prune();
    return { backup, bytes: Buffer.byteLength(text) };
  }

  /**
   * Copy the current overlay aside. Returns the backup's name, or null when
   * there was nothing to copy yet.
   */
  async backup() {
    const current = await readFile(this.overlayPath, 'utf8').catch(() => null);
    if (current === null) return null;

    await mkdir(this.backupDir, { recursive: true });
    // Colons are legal on the filesystems this runs on but awkward everywhere
    // else, so the timestamp is flattened.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}.json`;
    await writeFile(join(this.backupDir, name), current, 'utf8');
    return name;
  }

  /** Backups, newest first. */
  async backups() {
    const names = await readdir(this.backupDir).catch(() => []);
    return names.filter((n) => n.endsWith('.json')).sort().reverse();
  }

  /** Drop the oldest backups beyond KEEP_BACKUPS. */
  async prune(keep = KEEP_BACKUPS) {
    const all = await this.backups();
    for (const name of all.slice(keep)) {
      await unlink(join(this.backupDir, name)).catch(() => {});
    }
    return all.length - Math.min(all.length, keep);
  }

  /** Read one backup back, for a restore. The name is checked, never joined raw. */
  async readBackup(name) {
    return parseOverlay(await this.readBackupRaw(name));
  }

  /**
   * One backup's bytes, for a download.
   *
   * Unparsed on purpose: a download should hand back exactly what is on disk,
   * including a backup too old to validate — which is precisely the one you
   * would want to inspect. Restoring it still goes through readBackup, so a
   * broken file can be looked at but not published.
   */
  async readBackupRaw(name) {
    if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name)) {
      throw new Error('not a backup name');
    }
    return readFile(join(this.backupDir, name), 'utf8');
  }

  /** When the overlay last changed, for the UI to show. */
  async modified() {
    const info = await stat(this.overlayPath).catch(() => null);
    return info ? info.mtime.toISOString() : null;
  }
}
