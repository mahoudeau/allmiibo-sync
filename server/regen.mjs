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

  /** The database as it currently stands, or '' if there is none yet. */
  async currentText() {
    return readFile(this.dbPath, 'utf8').catch(() => '');
  }

  /**
   * Read the sources and build, without writing anything.
   *
   * `cacheDir` can be overridden so a candidate can be built from a pending
   * fetch while the live cache is left alone — which is what lets an upstream
   * refresh be reviewed before it is promoted.
   *
   * @throws {GenerateError} when the result would collide
   */
  async #build(overlay, cacheDir = this.cacheDir) {
    const firmware = await readFile(join(cacheDir, 'db_amiibo.c'), 'utf8').catch(() => {
      throw new Error(
        'the upstream sources have not been fetched yet. Run the upstream refresh first.'
      );
    });
    const api = await readFile(join(cacheDir, 'amiibo.json'), 'utf8').catch(() => null);
    // The previously generated file is where the stable series tokens live: a
    // token that changes renames a folder on every synced device, so it is read
    // back rather than re-derived.
    const previous = await this.currentText();
    const { contents, report } = generate({ firmware, api, previous, overlay });
    return { contents, report, previous };
  }

  /**
   * Build the database from the cached sources plus this overlay, and write it.
   *
   * @returns {Promise<{bytes: number, report: object}>}
   * @throws  {GenerateError} when the result would collide; nothing is written
   */
  /**
   * Write a database that has already been built.
   *
   * Generating over ~950 amiibo is not free, and an apply otherwise builds the
   * same overlay twice: once to check it and once to write it. The bytes the
   * check produced ARE the bytes to write.
   */
  async writeContents(contents) {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const tmp = `${this.dbPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, contents, 'utf8');
      await rename(tmp, this.dbPath);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
    return { bytes: Buffer.byteLength(contents) };
  }

  async run(overlay, { cacheDir } = {}) {
    const { contents, report } = await this.#build(overlay, cacheDir);

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
   *
   * `contents` is the candidate database and `previous` the one on disk — the
   * two sides of the diff a review screen shows. Discarding `contents` here
   * meant nothing could compare what a change would actually produce.
   */
  async dryRun(overlay, { cacheDir } = {}) {
    try {
      const { contents, report, previous } = await this.#build(overlay, cacheDir);
      return { ok: true, contents, previous, report, errors: [] };
    } catch (err) {
      const errors = err instanceof GenerateError ? [err.message, ...err.details] : [err.message];
      return { ok: false, contents: null, previous: null, report: null, errors };
    }
  }
}

/**
 * A report safe to send over HTTP.
 *
 * `report.seriesLabel` is a FUNCTION — the generator uses it to name a series
 * while printing. JSON.stringify drops it without complaint, so a client asking
 * for the report silently has nothing where the CLI prints "minted SSB for
 * Super Smash Bros.", and nothing anywhere says why. It is resolved here, at
 * the boundary, rather than by changing what generate() returns to the CLI.
 */
export function publicReport(report) {
  if (!report) return null;
  const { seriesLabel, mintedShort = [], ...rest } = report;
  return {
    ...rest,
    mintedShort,
    mintedSeries: mintedShort.map((byte) => ({
      byte,
      token: report.seriesShort?.[byte] ?? null,
      label: seriesLabel ? seriesLabel(byte) : null,
    })),
  };
}

export { GenerateError };
