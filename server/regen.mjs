// Rebuilding the public site's database after an edit.
//
// This is what makes the admin a CMS rather than an editor: on save, the server
// regenerates web/data/amiibo-db.js and writes it into the public site's
// directory. Visitors keep loading a plain static file with no API call and no
// dependency on this service being up. If the admin process dies, the site does
// not notice.
//
// It calls the same generate() the command line calls, so a save is held to the
// same invariants as `npm run update-db`. A save that would put two amiibos on
// one device path is refused and nothing is written, with the reason surfaced in
// the UI instead of on a terminal.

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { generate, GenerateError } from '../tools/build-amiibo-db.mjs';

/** Upstream sources, cached on disk so a save does not depend on the network. */
export class Regenerator {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir   holds db_amiibo.c and amiibo.json
   * @param {string} opts.dbPath     the database to write, inside the public site
   */
  constructor({ cacheDir, dbPath }) {
    this.cacheDir = cacheDir;
    this.dbPath = dbPath;
  }

  /** Whether the upstream sources have been fetched at least once. */
  async ready() {
    const firmware = await readFile(join(this.cacheDir, 'db_amiibo.c'), 'utf8').catch(() => null);
    return firmware !== null;
  }

  /**
   * Build the database from the cached sources plus this overlay, and write it.
   *
   * @returns {Promise<{bytes: number, report: object}>}
   * @throws  {GenerateError} when the result would collide; nothing is written
   */
  async run(overlay) {
    const firmware = await readFile(join(this.cacheDir, 'db_amiibo.c'), 'utf8').catch(() => {
      throw new Error(
        'the upstream sources have not been fetched yet. Run the upstream refresh first.'
      );
    });
    const api = await readFile(join(this.cacheDir, 'amiibo.json'), 'utf8').catch(() => null);
    // The previously generated file is where the stable series tokens live: a
    // token that changes renames a folder on every synced device, so it is read
    // back rather than re-derived.
    const previous = await readFile(this.dbPath, 'utf8').catch(() => '');

    const { contents, report } = generate({ firmware, api, previous, overlay });

    await mkdir(dirname(this.dbPath), { recursive: true });
    // Atomic: a visitor loading the site mid-write gets the old file or the new
    // one, never half of either.
    const tmp = `${this.dbPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, contents, 'utf8');
      await rename(tmp, this.dbPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }

    return { bytes: Buffer.byteLength(contents), report };
  }

  /**
   * Build without writing, to check an overlay before committing to it.
   * Returns the problems rather than throwing, for a UI that wants to list them.
   */
  async dryRun(overlay) {
    try {
      const firmware = await readFile(join(this.cacheDir, 'db_amiibo.c'), 'utf8');
      const api = await readFile(join(this.cacheDir, 'amiibo.json'), 'utf8').catch(() => null);
      const previous = await readFile(this.dbPath, 'utf8').catch(() => '');
      const { report } = generate({ firmware, api, previous, overlay });
      return { ok: true, report, errors: [] };
    } catch (err) {
      if (err instanceof GenerateError) return { ok: false, report: null, errors: [err.message, ...err.details] };
      return { ok: false, report: null, errors: [err.message] };
    }
  }
}

export { GenerateError };
