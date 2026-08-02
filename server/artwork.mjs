// Noticing that artwork upstream has changed, without downloading it.
//
// The naive way to answer "has this picture changed?" is to fetch it and
// compare. For ~950 images that is tens of megabytes every time you look, which
// is enough to make nobody look.
//
// GitHub's git trees API answers the whole question in one request:
//
//   GET /repos/8bitDream/AmiiboAPI/git/trees/dev:images
//   -> { tree: [ { path: 'icon_00000000-00000002.png', sha, size }, … ] }
//
// That `sha` is git's blob hash — sha1 over `blob <bytes>\0<content>` — which
// is computable from a local file with no network at all. So the comparison is
// a hash of what is on disk against a list that arrived in one response, and
// not one image byte is transferred until you ask to look at a specific
// picture. Verified against the real set: 948 entries, 946 identical, 2 missing.
//
// Like `Upstream`, nothing here writes over a live file. Candidates land in
// pending/images/ and become real only on promote().

import { readFile, writeFile, mkdir, readdir, rename, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { artUrl, IMAGES_BASE, TIERS } from '../tools/fetch-amiibo-images.mjs';

/** Where the manifest comes from. One request, no pagination, no auth. */
export const MANIFEST_URL =
  'https://api.github.com/repos/8bitDream/AmiiboAPI/git/trees/dev:images';

/**
 * The smallest manifest worth believing.
 *
 * Same reasoning as MIN_PLAUSIBLE_ENTRIES in upstream.mjs: an API can answer
 * 200 with an error document, and a manifest parsed to a handful of entries
 * would read as "upstream deleted almost everything" — which, acted on, deletes
 * almost everything.
 */
export const MIN_PLAUSIBLE_IMAGES = 500;

/** Git's blob hash for a buffer: sha1('blob <len>\0' + bytes). */
export function blobSha(buf) {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]))
    .digest('hex');
}

/** `icon_00000000-00000002.png` -> `0000000000000002`, or null. */
export function idFromImageName(name) {
  const m = /^icon_([0-9a-fA-F]{8})-([0-9a-fA-F]{8})\.png$/.exec(name);
  return m ? (m[1] + m[2]).toLowerCase() : null;
}

export class Artwork {
  /**
   * @param {object} opts
   * @param {string} opts.imagesDir      the live images root (full/, med/, thumb/)
   * @param {string} opts.pendingDir     where candidates are staged
   * @param {string} [opts.manifestUrl]  overridable so tests use a local origin
   * @param {string} [opts.base]         where the images themselves live
   * @param {Function} [opts.fetch]
   * @param {number} [opts.timeoutMs]
   */
  constructor({
    imagesDir,
    pendingDir,
    manifestUrl = MANIFEST_URL,
    base = IMAGES_BASE,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
  }) {
    this.imagesDir = imagesDir;
    this.fullDir = join(imagesDir, 'full');
    this.pendingDir = pendingDir;
    this.manifestUrl = manifestUrl;
    this.base = base;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * What upstream has: amiibo ID -> { sha, size }.
   *
   * A rate-limited or unreachable API throws rather than returning an empty
   * map. "Cannot check right now" and "nothing has changed" look identical from
   * the outside and mean opposite things, and the quiet one is how a feature
   * stops working without anyone noticing.
   */
  async manifest() {
    const res = await this.fetch(this.manifestUrl, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 403 || res.status === 429) {
      throw new Error(
        'the image index is rate-limited right now (GitHub allows 60 requests an hour). Try again later.');
    }
    if (!res.ok) throw new Error(`the image index answered HTTP ${res.status}`);

    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error('the image index was not JSON');
    }
    if (!Array.isArray(body?.tree)) throw new Error('the image index had no file list');

    const out = new Map();
    for (const entry of body.tree) {
      if (entry.type !== 'blob') continue;
      const id = idFromImageName(entry.path ?? '');
      if (id) out.set(id, { sha: entry.sha, size: entry.size ?? null });
    }
    if (out.size < MIN_PLAUSIBLE_IMAGES) {
      throw new Error(
        `the image index listed only ${out.size} pictures — that is not the image set`);
    }
    // `truncated` means GitHub capped the response, so absences in it are an
    // artefact of the transport rather than upstream deleting anything. Acting
    // on it would propose removing artwork that is still there.
    if (body.truncated) throw new Error('the image index came back truncated; not comparing against a partial list');
    return out;
  }

  /** Blob hashes of what is on disk: amiibo ID -> sha. */
  async local() {
    const files = await readdir(this.fullDir).catch(() => []);
    const out = new Map();
    for (const file of files) {
      if (!file.endsWith('.png')) continue;
      const id = file.slice(0, -4);
      if (!/^[0-9a-f]{16}$/.test(id)) continue;
      out.set(id, blobSha(await readFile(join(this.fullDir, file))));
    }
    return out;
  }

  /**
   * What would change, per amiibo the database knows about.
   *
   * @param {string[]} ids        the IDs the database carries
   * @param {object} [declined]   overlay artwork records: id -> { declined: sha }
   * @returns {Promise<object>} { added, changed, removed, unchanged, checkedAt }
   */
  async compare(ids, declined = {}) {
    const [upstream, local] = await Promise.all([this.manifest(), this.local()]);
    const known = new Set(ids);

    const added = [];
    const changed = [];
    const removed = [];
    let unchanged = 0;
    let held = 0;

    for (const id of known) {
      const up = upstream.get(id);
      const mine = local.get(id);

      if (up && !mine) {
        added.push({ id, sha: up.sha, size: up.size });
      } else if (up && mine && up.sha !== mine) {
        // A change refused earlier stays refused until upstream moves again.
        // Re-offering it every check would be nagging rather than review — the
        // opposite of an ADDITION, where "not this time" is the right meaning
        // because you probably do want the picture eventually.
        if (declined[id]?.declined === up.sha) { held++; continue; }
        changed.push({ id, sha: up.sha, was: mine, size: up.size });
      } else if (!up && mine) {
        removed.push({ id, was: mine });
      } else if (up && mine) {
        unchanged++;
      }
    }

    return {
      added, changed, removed, unchanged, held,
      upstreamCount: upstream.size,
      localCount: local.size,
    };
  }

  /**
   * Download one candidate into pending/, and return the bytes.
   *
   * Lazy on purpose: a review of 300 changed pictures costs one request until
   * someone actually looks at one, and anything looked at is already on disk
   * when it is accepted.
   */
  async stage(id) {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`not an amiibo ID: ${id}`);
    const dest = join(this.pendingDir, `${id}.png`);
    const cached = await readFile(dest).catch(() => null);
    if (cached) return cached;

    const res = await this.fetch(artUrl(id, this.base), {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`artwork for ${id}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    await mkdir(this.pendingDir, { recursive: true });
    const tmp = join(this.pendingDir, `${id}.${randomUUID()}.tmp`);
    await writeFile(tmp, buf);
    await rename(tmp, dest);
    return buf;
  }

  /**
   * Make staged candidates live, keeping the outgoing ones in previous/.
   *
   * The tiers are NOT rebuilt here — that needs an image tool and belongs with
   * the fetcher, which knows how to degrade when there is none. This moves the
   * full-size file and deletes the stale tiers so the next tier build notices
   * them as missing rather than leaving an old thumbnail beside a new portrait.
   */
  async promote(ids) {
    const previousDir = join(this.pendingDir, 'previous');
    await mkdir(previousDir, { recursive: true });
    await mkdir(this.fullDir, { recursive: true });

    const moved = [];
    for (const id of ids) {
      if (!/^[0-9a-f]{16}$/.test(id)) continue;
      const staged = join(this.pendingDir, `${id}.png`);
      const live = join(this.fullDir, `${id}.png`);
      const buf = await readFile(staged).catch(() => null);
      if (!buf) continue;

      await cp(live, join(previousDir, `${id}.png`)).catch(() => {});
      await writeFile(live, buf);
      await rm(staged, { force: true });
      // The resized copies are of the OLD picture now, so they have to go.
      for (const t of TIERS) {
        await rm(join(this.imagesDir, t.dir, `${id}.png`), { force: true });
      }
      moved.push(id);
    }
    return moved;
  }

  /** Throw the staged candidates away. Nothing live was ever touched. */
  async discard() {
    await rm(this.pendingDir, { recursive: true, force: true });
  }
}
