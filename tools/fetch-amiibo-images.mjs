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

import { mkdir, readdir, writeFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
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

/**
 * The first image tool on PATH, or null.
 *
 * `sips` ships with macOS and reads the WebP-in-.png files some entries use;
 * ImageMagick covers the Linux server, where `sips` does not exist at all. When
 * none is present the full-size images are still fetched and the caller is told
 * the tiers were skipped — the site steps full -> med -> thumb and falls back
 * to a placeholder, so this degrades rather than breaks.
 */
export async function findResizer(exec = run) {
  for (const [cmd, args] of [
    ['sips', ['--version']],
    ['magick', ['-version']],
    ['convert', ['-version']],
  ]) {
    try {
      await exec(cmd, args);
      return cmd;
    } catch {}
  }
  return null;
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
 * @param {(text: string) => void} [opts.onProgress]
 */
export async function fetchArtwork({
  ids,
  imagesDir,
  base = IMAGES_BASE,
  fetch: fetchImpl = globalThis.fetch,
  exec = run,
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

  const queue = [...pending];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const res = await fetchImpl(artUrl(id, base));
        if (res.status === 404) {
          report.noArtwork.push(id);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(join(fullDir, `${id}.png`), Buffer.from(await res.arrayBuffer()));
        report.fetched++;
        onProgress(`fetched ${report.fetched}/${pending.length}`);
      } catch (err) {
        report.failed.push(`${id}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ---- resized tiers ------------------------------------------------------

  const tool = await findResizer(exec);
  if (!tool) {
    report.tiers.skipped = true;
    report.tiers.reason = 'no image tool on this machine (looked for sips, magick, convert)';
    return report;
  }
  report.tiers.tool = tool;

  for (const tier of TIERS) {
    const destDir = join(imagesDir, tier.dir);
    const fulls = (await readdir(fullDir)).filter((f) => f.endsWith('.png'));
    const done = new Set(await readdir(destDir));
    const todo = fulls.filter((f) => !done.has(f));

    for (let i = 0; i < todo.length; i += 50) {
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
      onProgress(`${tier.dir} ${Math.min(i + 50, todo.length)}/${todo.length}`);
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
    onProgress: (text) => process.stdout.write(`\r  ${text}`),
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
