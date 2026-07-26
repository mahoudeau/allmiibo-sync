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

import { mkdir, readdir, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { AMIIBO_NAMES } from '../web/data/amiibo-db.js';

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FULL_DIR = join(ROOT, 'web/data/images/full');
const THUMB_DIR = join(ROOT, 'web/data/images/thumb');
const MED_DIR = join(ROOT, 'web/data/images/med');
const BASE = 'https://raw.githubusercontent.com/8bitDream/AmiiboAPI/dev/images';
const CONCURRENCY = 10;

// Three tiers, three policies:
//   thumb  96 px  small list icons and the fresh-clone fallback
//   med   256 px  Retina-sharp lists and cards
//   full  original the per-amiibo detail page
// All three are gitignored — Nintendo's artwork, cached locally and deployed,
// never committed.
const THUMB_SIZE = 96;
const MED_SIZE = 256;

const ids = [...new Set([...Object.keys(AMIIBO_NAMES), ...process.argv.slice(2)])].filter((id) =>
  /^[0-9a-f]{16}$/.test(id)
);

await mkdir(FULL_DIR, { recursive: true });
await mkdir(THUMB_DIR, { recursive: true });
await mkdir(MED_DIR, { recursive: true });

const have = new Set(await readdir(FULL_DIR));
const pending = ids.filter((id) => !have.has(`${id}.png`));
console.log(`${ids.length} ids — ${ids.length - pending.length} cached, ${pending.length} to fetch`);

let done = 0;
let missing = 0;
const failed = [];

async function fetchOne(id) {
  const url = `${BASE}/icon_${id.slice(0, 8)}-${id.slice(8)}.png`;
  try {
    const res = await fetch(url);
    if (res.status === 404) {
      missing++;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(join(FULL_DIR, `${id}.png`), Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    failed.push(`${id}: ${err.message}`);
  } finally {
    done++;
    if (done % 50 === 0 || done === pending.length) {
      process.stdout.write(`\r  fetched ${done}/${pending.length}`);
    }
  }
}

// A tiny worker pool; no dependencies.
const queue = [...pending];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await fetchOne(queue.shift());
  })
);
if (pending.length) console.log();

// ---- resized tiers --------------------------------------------------------
// sips ships with macOS and reads the WebP-in-.png files some entries use.
// Only regenerate what is missing in each tier.

async function resizeTier(destDir, size, label) {
  const fulls = (await readdir(FULL_DIR)).filter((f) => f.endsWith('.png'));
  const have = new Set(await readdir(destDir));
  const todo = fulls.filter((f) => !have.has(f));
  console.log(`${label}: ${fulls.length - todo.length} cached, ${todo.length} to generate`);

  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50).map((f) => join(FULL_DIR, f));
    try {
      await run('sips', ['-s', 'format', 'png', '-Z', String(size), ...batch, '--out', destDir]);
    } catch {
      // sips batches fail atomically on one bad file; retry singly so one
      // unreadable image does not cost the other forty-nine.
      for (const file of batch) {
        try {
          await run('sips', ['-s', 'format', 'png', '-Z', String(size), file, '--out', destDir]);
        } catch (err) {
          failed.push(`${label} ${file}: ${err.message}`);
        }
      }
    }
    process.stdout.write(`\r  ${label} ${Math.min(i + 50, todo.length)}/${todo.length}`);
  }
  if (todo.length) console.log();
}

await resizeTier(THUMB_DIR, THUMB_SIZE, 'thumb');
await resizeTier(MED_DIR, MED_SIZE, 'med');

// ---- Kirby Air Riders vehicle art -----------------------------------------
// Nintendo's own marketing renders: vehicle-only, transparent PNG, resizable
// through their CDN. Same posture as the amiibo art: fetched locally, never
// committed (web/data/images/ is gitignored).
const VEHICLES_DIR = join(ROOT, 'web/data/images/vehicles');
const VEHICLE_SLUGS = ['warp-star', 'winged-star', 'shadow-star', 'tank-star'];
const VEHICLE_URL = (slug) =>
  `https://assets.nintendo.com/image/upload/f_png,w_256/Marketing/ms_j3gnc8ap1/riders-and-machines/gallery-machines/${slug}/machine-2x`;

await mkdir(VEHICLES_DIR, { recursive: true });
for (const slug of VEHICLE_SLUGS) {
  const dest = join(VEHICLES_DIR, `${slug}.png`);
  try {
    await stat(dest);
    continue; // already fetched
  } catch {}
  try {
    const res = await fetch(VEHICLE_URL(slug));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`vehicle: ${slug}`);
  } catch (err) {
    failed.push(`vehicle ${slug}: ${err.message}`);
  }
}

const fullCount = (await readdir(FULL_DIR)).length;
const thumbCount = (await readdir(THUMB_DIR)).length;
const medCount = (await readdir(MED_DIR)).length;
console.log(`\ndone: ${fullCount} full, ${medCount} med, ${thumbCount} thumb`);
if (missing) console.log(`${missing} id(s) have no artwork upstream (newer than the image set) — the page shows a placeholder`);
if (failed.length) {
  console.log(`${failed.length} failure(s):`);
  failed.slice(0, 10).forEach((f) => console.log(`  ${f}`));
  process.exitCode = 1;
}
