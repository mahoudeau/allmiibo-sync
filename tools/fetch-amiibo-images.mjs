#!/usr/bin/env node
// Downloads amiibo artwork from the AmiiboAPI repository into a local,
// gitignored cache, and generates small thumbnails for the collection page.
//
//   node tools/fetch-amiibo-images.mjs [extraId ...]
//
// Images are keyed by the same 16-hex amiibo ID the tool already reads out of
// every dump: id 0181000100440502 lives at
//   https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/images/icon_01810001-00440502.png
//
// The artwork is Nintendo's, so it is fetched to your machine rather than
// committed to the repository — web/data/images/ is gitignored. After one run
// the page loads everything from localhost; nothing external at runtime.
//
// Already-downloaded images are skipped, so re-running only fetches what is
// new. Extra IDs (e.g. amiibos newer than the database) can be passed as
// arguments; a 404 there is normal and reported, not fatal.
//
// The work is a MODULE — fetchArtwork() below — and this file's CLI is a thin
// wrapper around it, because the admin server calls the same function when an
// update is applied. That is why the IDs and the destination are arguments
// rather than imports: a long-lived server that imported AMIIBO_NAMES would
// keep using the table it read at startup, which has already caused two bugs
// in this project.

import { mkdir, mkdtemp, readdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const IMAGES_BASE = 'https://raw.githubusercontent.com/8bitDream/AmiiboAPI/dev/images';
const CONCURRENCY = 10;

// Three tiers, three policies:
//   thumb  96 px  small list icons and the fresh-clone fallback
//   med   256 px  Retina-sharp lists and cards
//   full  original the per-amiibo detail page
// All three are gitignored — Nintendo's artwork, cached locally and deployed,
// never committed.
export const TIERS = Object.freeze([
  { dir: 'thumb', size: 96 },
  { dir: 'med', size: 256 },
]);

/** Where one amiibo's artwork lives upstream. */
export const artUrl = (id, base = IMAGES_BASE) =>
  `${base}/icon_${id.slice(0, 8)}-${id.slice(8)}.png`;

/** CRC-32, for writing the probe PNG. Table built once, on first use. */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/**
 * A real PNG, written from scratch: 8x8 RGBA, no dependencies.
 *
 * The probe below needs an image it is certain about. Copying one from the
 * cache would test whatever happened to be there — including the WebP-in-.png
 * files some entries use, which is a different question — and on a fresh
 * install there is nothing to copy.
 */
function probePng(size = 8) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  // 10..12 = compression, filter, interlace: all 0

  // Each row is a filter byte followed by RGBA pixels. A diagonal, so a resize
  // that silently returns the input unchanged is still a valid image either
  // way — the check is on the OUTPUT's dimensions, not on it merely existing.
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const p = row + 1 + x * 4;
      raw[p] = x === y ? 255 : 0;
      raw[p + 1] = 0;
      raw[p + 2] = 255;
      raw[p + 3] = 255;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Which image tool this machine has, PROVEN by resizing a real image.
 *
 * `sips` ships with macOS; ImageMagick covers a Linux server, where `sips` does
 * not exist at all. Which is present cannot be assumed, and neither can it
 * working: `--version` exiting 0 says a binary is on PATH, not that it can
 * decode a PNG — an ImageMagick built without the PNG delegate does exactly
 * that, and a policy.xml can forbid the format outright. Both fail only when
 * a real image is handed to them, which is what this does.
 *
 * @returns {Promise<{tool: string|null, ok: boolean, reason: string|null,
 *                    tried: {tool: string, error: string}[]}>}
 */
export async function probeResizer(exec = run) {
  const tried = [];
  const dir = await mkdtemp(join(tmpdir(), 'artprobe-'));
  const src = join(dir, 'probe.png');
  const out = join(dir, 'out');

  try {
    await mkdir(out, { recursive: true });
    await writeFile(src, probePng(8));

    for (const tool of ['sips', 'magick', 'convert']) {
      try {
        const [cmd, args] = resizeCommand(tool, 4, [src], out);
        await exec(cmd, args);

        const written = await readFile(join(out, 'probe.png')).catch(() => null);
        if (!written) throw new Error('ran, but produced no output file');
        if (written.length === 0) throw new Error('produced an empty file');

        // The header is the proof. A tool that copied the input through, or
        // wrote an error page, does not come back 4 pixels wide.
        //
        // Checked in this order deliberately: reading the width out of a file
        // too short to have one throws a RangeError about byte offsets, which
        // tells whoever reads the report nothing about what went wrong.
        const isPng = written.length >= 24 && written.subarray(0, 8)
          .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if (!isPng) throw new Error('output is not a PNG');
        const width = written.readUInt32BE(16);
        if (width !== 4) throw new Error(`output is ${width}px wide, expected 4`);

        return { tool, ok: true, reason: null, tried };
      } catch (err) {
        tried.push({ tool, error: err.message });
        await rm(join(out, 'probe.png'), { force: true }).catch(() => {});
      }
    }

    return {
      tool: null,
      ok: false,
      reason: 'no working image tool (tried sips, magick, convert)',
      tried,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Backwards-compatible name: the tool only, or null. */
export async function findResizer(exec = run) {
  return (await probeResizer(exec)).tool;
}

/** One batch resize, in whichever dialect the available tool speaks. */
function resizeCommand(tool, size, files, destDir) {
  if (tool === 'sips') {
    return ['sips', ['-s', 'format', 'png', '-Z', String(size), ...files, '--out', destDir]];
  }
  // ImageMagick's batch form is `mogrify -path <dir>`, which writes each input
  // into the destination under its own name. `>` keeps images already smaller
  // than the target untouched rather than upscaling them.
  const args = ['-resize', `${size}x${size}>`, '-path', destDir, ...files];
  return tool === 'magick' ? ['magick', ['mogrify', ...args]] : ['mogrify', args];
}

/**
 * Fetch artwork for a set of IDs, and build the resized tiers.
 *
 * Never throws for one bad image: artwork is not the database, and a picture
 * that 404s or a tool that chokes must not take an update down with it. What
 * went wrong comes back in the report instead.
 *
 * @param {object} opts
 * @param {string[]} opts.ids       amiibo IDs to ensure artwork for
 * @param {string} opts.imagesDir   the images root; full/, med/, thumb/ live under it
 * @param {string} [opts.base]      upstream image base URL
 * @param {Function} [opts.fetch]
 * @param {Function} [opts.exec]    child-process runner, so tests need no tools
 * @param {AbortSignal} [opts.signal]  stops between items, never mid-write
 * @param {(p: {phase: string, done: number, total: number}) => void} [opts.onProgress]
 *   Structured rather than a string: this drives a progress bar on the other
 *   side of an HTTP poll, and a caller should not have to parse "fetched 7/10"
 *   back into numbers.
 */
export async function fetchArtwork({
  ids,
  imagesDir,
  base = IMAGES_BASE,
  fetch: fetchImpl = globalThis.fetch,
  exec = run,
  signal = null,
  onProgress = () => {},
} = {}) {
  const wanted = [...new Set(ids)].filter((id) => /^[0-9a-f]{16}$/.test(id));
  const fullDir = join(imagesDir, 'full');
  await mkdir(fullDir, { recursive: true });
  for (const t of TIERS) await mkdir(join(imagesDir, t.dir), { recursive: true });

  const have = new Set(await readdir(fullDir));
  const pending = wanted.filter((id) => !have.has(`${id}.png`));

  const report = {
    considered: wanted.length,
    cached: wanted.length - pending.length,
    fetched: 0,
    // Not an error: upstream publishes pictures on its own schedule, so an
    // entry newer than the image set simply has none yet and gets one later.
    noArtwork: [],
    failed: [],
    tiers: { built: 0, skipped: false, tool: null, reason: null },
  };

  let settled = 0;
  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      // Between items, never mid-write: a half-written PNG on disk would be
      // treated as "already have it" by the next run and never repaired.
      if (signal?.aborted) return;
      const id = queue.shift();
      try {
        const res = await fetchImpl(artUrl(id, base), signal ? { signal } : undefined);
        if (res.status === 404) {
          report.noArtwork.push(id);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(join(fullDir, `${id}.png`), Buffer.from(await res.arrayBuffer()));
        report.fetched++;
      } catch (err) {
        report.failed.push(`${id}: ${err.message}`);
      } finally {
        // Counted whatever the outcome, so the bar reaches the end even when
        // half of upstream has no picture yet.
        settled++;
        onProgress({ phase: 'fetch', done: settled, total: pending.length });
      }
    }
  };
  onProgress({ phase: 'fetch', done: 0, total: pending.length });
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  report.aborted = Boolean(signal?.aborted);

  // ---- resized tiers ------------------------------------------------------

  const probe = await probeResizer(exec);
  report.tiers.probe = probe.tried;
  if (!probe.ok) {
    report.tiers.skipped = true;
    report.tiers.reason = probe.reason;
    return report;
  }
  const tool = probe.tool;
  report.tiers.tool = tool;

  for (const tier of TIERS) {
    const destDir = join(imagesDir, tier.dir);
    const fulls = (await readdir(fullDir)).filter((f) => f.endsWith('.png'));
    const done = new Set(await readdir(destDir));
    const todo = fulls.filter((f) => !done.has(f));

    onProgress({ phase: tier.dir, done: 0, total: todo.length });
    for (let i = 0; i < todo.length; i += 50) {
      if (signal?.aborted) { report.aborted = true; return report; }
      const batch = todo.slice(i, i + 50).map((f) => join(fullDir, f));
      const [cmd, args] = resizeCommand(tool, tier.size, batch, destDir);
      try {
        await exec(cmd, args);
      } catch {
        // A batch fails atomically on one bad file, so retry singly rather than
        // let one unreadable image cost the other forty-nine.
        for (const file of batch) {
          const [c, a] = resizeCommand(tool, tier.size, [file], destDir);
          try {
            await exec(c, a);
          } catch (err) {
            report.failed.push(`${tier.dir} ${file}: ${err.message}`);
          }
        }
      }
      onProgress({ phase: tier.dir, done: Math.min(i + 50, todo.length), total: todo.length });
    }
    report.tiers.built += todo.length;
  }

  return report;
}

/**
 * Remove one amiibo's artwork from every tier.
 *
 * The ID is held to the hex shape first, so a caller cannot use it to walk out
 * of the images directory.
 */
export async function removeArtwork(id, imagesDir) {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`not an amiibo ID: ${id}`);
  let removed = 0;
  for (const dir of ['full', ...TIERS.map((t) => t.dir)]) {
    await unlink(join(imagesDir, dir, `${id}.png`)).then(() => { removed++; }, () => {});
  }
  return removed;
}

/** One line summarising a report, for the CLI, the admin and the tests alike. */
export function describeArtwork(report) {
  if (!report) return 'Artwork: nothing to do.';
  const bits = [`${report.fetched} fetched`];
  if (report.replaced) bits.push(`${report.replaced} replaced`);
  if (report.deleted) bits.push(`${report.deleted} file(s) deleted`);
  if (report.declined) bits.push(`${report.declined} declined`);
  if (report.cached) bits.push(`${report.cached} already had art`);
  if (report.noArtwork.length) bits.push(`${report.noArtwork.length} have none upstream yet`);
  if (report.failed.length) bits.push(`${report.failed.length} failed`);
  let text = `Artwork: ${bits.join(', ')}.`;
  if (report.tiers.skipped) {
    text += ` Tiers NOT generated — ${report.tiers.reason}.`
      + ' Run `npm run fetch-images` locally and redeploy to build them.';
  }
  return text;
}

// ---- Kirby Air Riders vehicle art -----------------------------------------
// Nintendo's own marketing renders: vehicle-only, transparent PNG, resizable
// through their CDN. Same posture as the amiibo art: fetched locally, never
// committed (web/data/images/ is gitignored).

const VEHICLE_SLUGS = ['warp-star', 'winged-star', 'shadow-star', 'tank-star'];
const VEHICLE_URL = (slug) =>
  `https://assets.nintendo.com/image/upload/f_png,w_256/Marketing/ms_j3gnc8ap1/riders-and-machines/gallery-machines/${slug}/machine-2x`;

export async function fetchVehicles(imagesDir, fetchImpl = globalThis.fetch) {
  const dir = join(imagesDir, 'vehicles');
  await mkdir(dir, { recursive: true });
  const have = new Set(await readdir(dir).catch(() => []));
  const out = { fetched: 0, failed: [] };
  for (const slug of VEHICLE_SLUGS) {
    if (have.has(`${slug}.png`)) continue;
    try {
      const res = await fetchImpl(VEHICLE_URL(slug));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(join(dir, `${slug}.png`), Buffer.from(await res.arrayBuffer()));
      out.fetched++;
    } catch (err) {
      out.failed.push(`vehicle ${slug}: ${err.message}`);
    }
  }
  return out;
}

// ---- CLI ------------------------------------------------------------------

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  // Imported here rather than at the top so the module itself never pulls in
  // the generated database — see the note at the top of the file.
  const { AMIIBO_NAMES } = await import('../web/data/amiibo-db.js');
  const imagesDir = join(ROOT, 'web/data/images');
  const ids = [...Object.keys(AMIIBO_NAMES), ...process.argv.slice(2)];

  const report = await fetchArtwork({
    ids,
    imagesDir,
    onProgress: ({ phase, done, total }) => {
      if (total) process.stdout.write(`\r  ${phase} ${done}/${total}   `);
    },
  });
  const vehicles = await fetchVehicles(imagesDir);

  console.log(`\n${describeArtwork(report)}`);
  if (vehicles.fetched) console.log(`vehicles: ${vehicles.fetched} fetched`);

  const counts = await Promise.all(
    ['full', ...TIERS.map((t) => t.dir)].map(async (d) =>
      `${(await readdir(join(imagesDir, d))).length} ${d}`));
  console.log(`done: ${counts.join(', ')}`);

  if (report.noArtwork.length) {
    console.log(`${report.noArtwork.length} id(s) have no artwork upstream `
      + '(newer than the image set) — the page shows a placeholder');
  }
  const failures = [...report.failed, ...vehicles.failed];
  if (failures.length) {
    console.log(`${failures.length} failure(s):`);
    failures.slice(0, 10).forEach((f) => console.log(`  ${f}`));
    process.exitCode = 1;
  }
}
