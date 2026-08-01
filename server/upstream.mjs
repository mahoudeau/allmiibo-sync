// Fetching the upstream sources, without letting them take effect.
//
// A refresh writes into cacheDir/pending/ and NEVER over the live pair. That is
// the one structural decision in this file and it earns its keep three times:
//
//   1. A bad fetch cannot destroy a working cache, because it never touches it.
//   2. A generate() that fails afterwards needs no rollback — nothing was
//      promoted, so there is nothing to undo.
//   3. The one that actually matters: an ordinary save calls regen.run()
//      against the live cache. If a refresh had overwritten it, the NEXT
//      UNRELATED SAVE would silently publish unreviewed upstream data — which
//      is precisely the failure the review screen exists to prevent.
//
// The live pair is replaced only by promote(), at the end of a successful
// apply.

import { readFile, writeFile, mkdir, rename, unlink, rm, cp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { parseFirmwareTable, parseAmiiboApi } from '../web/js/dbsource.js';

/** The two sources, and what the generator calls them on disk. */
export const SOURCES = Object.freeze({
  'db_amiibo.c':
    'https://raw.githubusercontent.com/solosky/pixl.js/main/fw/application/src/amiidb/db_amiibo.c',
  'amiibo.json':
    'https://raw.githubusercontent.com/8bitDream/AmiiboAPI/dev/database/amiibo.json',
});

/**
 * The smallest entry count a source has to have to be believed.
 *
 * This is the check that actually protects the cache — far more than atomicity
 * does. GitHub can answer 200 with an HTML error page, a proxy can truncate a
 * response, and both would be written perfectly atomically. The real database
 * has ~950 entries; anything under this is not a database.
 */
export const MIN_PLAUSIBLE_ENTRIES = 500;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export class Upstream {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir    where the live pair lives
   * @param {object} [opts.sources]   name -> URL; overridable so tests can point
   *                                  at a local origin instead of the network
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxBytes]  per source
   * @param {Function} [opts.fetch]
   */
  constructor({
    cacheDir,
    sources = SOURCES,
    timeoutMs = 15_000,
    maxBytes = 16 * 1024 * 1024,
    fetch: fetchImpl = globalThis.fetch,
  }) {
    this.cacheDir = cacheDir;
    this.pendingDir = join(cacheDir, 'pending');
    this.previousDir = join(cacheDir, 'previous');
    this.sources = sources;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.fetch = fetchImpl;
  }

  /** What is on disk: the live pair, and any fetch waiting to be reviewed. */
  async status() {
    const live = [];
    for (const name of Object.keys(this.sources)) {
      const text = await readFile(join(this.cacheDir, name), 'utf8').catch(() => null);
      live.push(text === null
        ? { name, present: false }
        : { name, present: true, bytes: Buffer.byteLength(text), sha256: sha256(text) });
    }
    return { live, pending: await this.pending() };
  }

  /** The pending fetch's metadata, or null if there is none. */
  async pending() {
    const raw = await readFile(join(this.pendingDir, 'meta.json'), 'utf8').catch(() => null);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /** The pending sources as text, or null. */
  async readPending() {
    const meta = await this.pending();
    if (!meta) return null;
    const out = {};
    for (const name of Object.keys(this.sources)) {
      out[name] = await readFile(join(this.pendingDir, name), 'utf8').catch(() => null);
      if (out[name] === null) return null;
    }
    return out;
  }

  /**
   * One source, fetched and checked before it is believed.
   *
   * Streamed rather than buffered whole, so the size cap can be enforced as the
   * bytes arrive: `res.arrayBuffer()` has already allocated everything by the
   * time you could check it.
   */
  async #fetchOne(name, url, now) {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`);

    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new Error(`${name}: ${declared} bytes, over the ${this.maxBytes}-byte cap`);
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > this.maxBytes) throw new Error(`${name}: over the ${this.maxBytes}-byte cap`);
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');

    // Plausibility, using the same parsers the build uses. A 200 carrying an
    // HTML error page parses to nothing and would otherwise be written happily.
    const count = name === 'amiibo.json'
      ? countApi(text)
      : parseFirmwareTable(text).size;
    if (count < MIN_PLAUSIBLE_ENTRIES) {
      throw new Error(
        `${name}: only ${count} entries — that is not the database, it is probably an error page`);
    }

    return { name, text, bytes: Buffer.byteLength(text), sha256: sha256(text), url, count, fetchedAt: now };
  }

  /**
   * Fetch both sources into pending/. The live pair is untouched.
   *
   * Nothing lands unless BOTH succeed, and meta.json is written last so a
   * half-finished directory has no marker and pending() reports nothing.
   */
  async refresh({ now = null } = {}) {
    const stamp = now ?? new Date().toISOString();
    const fetched = [];
    for (const [name, url] of Object.entries(this.sources)) {
      fetched.push(await this.#fetchOne(name, url, stamp));
    }

    await mkdir(this.pendingDir, { recursive: true });
    const written = [];
    try {
      for (const f of fetched) {
        const tmp = join(this.pendingDir, `${f.name}.${randomUUID()}.tmp`);
        await writeFile(tmp, f.text, 'utf8');
        await rename(tmp, join(this.pendingDir, f.name));
        written.push(join(this.pendingDir, f.name));
      }
    } catch (err) {
      for (const p of written) await unlink(p).catch(() => {});
      throw err;
    }

    // Which of them actually differ from what is live, so "nothing moved
    // upstream" is one glance rather than a diff.
    const live = await this.status();
    const meta = {
      fetchedAt: stamp,
      sources: fetched.map((f) => ({
        name: f.name,
        bytes: f.bytes,
        sha256: f.sha256,
        entries: f.count,
        changed: live.live.find((l) => l.name === f.name)?.sha256 !== f.sha256,
      })),
    };
    meta.changed = meta.sources.some((s) => s.changed);

    await writeFile(join(this.pendingDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  /**
   * Make the pending pair live, keeping the outgoing one in previous/.
   *
   * Called at the end of a successful apply, after the overlay has been written
   * — see the ordering note on the apply route.
   */
  async promote() {
    const meta = await this.pending();
    if (!meta) throw new Error('there is no pending fetch to promote');

    await rm(this.previousDir, { recursive: true, force: true });
    await mkdir(this.previousDir, { recursive: true });
    for (const name of Object.keys(this.sources)) {
      await cp(join(this.cacheDir, name), join(this.previousDir, name)).catch(() => {});
    }

    for (const name of Object.keys(this.sources)) {
      await rename(join(this.pendingDir, name), join(this.cacheDir, name));
    }
    await rm(this.pendingDir, { recursive: true, force: true });
    return meta;
  }

  /** Throw the pending fetch away. The live pair was never touched. */
  async discard() {
    await rm(this.pendingDir, { recursive: true, force: true });
  }

  /** When the live pair was last replaced, or null. */
  async promotedAt() {
    const info = await stat(join(this.cacheDir, 'db_amiibo.c')).catch(() => null);
    return info ? info.mtime.toISOString() : null;
  }
}

/**
 * Amiibo count in an API payload, without throwing on rubbish.
 *
 * Rubbish is the expected input here — an HTML error page, a truncated body —
 * so a parse failure means "zero entries", not an exception.
 */
function countApi(text) {
  try {
    return parseAmiiboApi(JSON.parse(text)).count ?? 0;
  } catch {
    return 0;
  }
}
