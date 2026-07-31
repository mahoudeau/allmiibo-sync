#!/usr/bin/env node
// Refreshes the vendored amiibo database (and artwork cache) from upstream.
// A development-time tool: the website itself never fetches anything.
//
//   npm run update-db            fetch sources, regenerate, fetch new images
//   npm run update-db -- --no-images    skip the artwork pass
//
// Sources, the same two the generator documents:
//   solosky/pixl.js      fw/application/src/amiidb/db_amiibo.c  (names)
//   8bitDream/AmiiboAPI  database/amiibo.json                   (series, types,
//     release dates) — an actively maintained superset of N3evin/AmiiboAPI,
//     verified to add newer amiibos (Air Riders v3, Mario Wonder, Splatoon
//     Raiders, Pragmata…) without dropping or corrupting upstream entries.
//
// Prints exactly what changed, because a silent regeneration is how a bad
// upstream edit would slip into the committed database unreviewed.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { OVERLAY_PATH, parseOverlay } from '../web/js/overlay.js';

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(ROOT, 'tools/.cache');
const DB_FILE = join(ROOT, 'web/data/amiibo-db.js');

const SOURCES = {
  'db_amiibo.c':
    'https://raw.githubusercontent.com/solosky/pixl.js/main/fw/application/src/amiidb/db_amiibo.c',
  'amiibo.json':
    'https://raw.githubusercontent.com/8bitDream/AmiiboAPI/dev/database/amiibo.json',
};

const skipImages = process.argv.includes('--no-images');

// One `export const NAME = Object.freeze({...})` block, or '' if absent.
function block(text, name) {
  return text.split(`${name} = Object.freeze({`)[1]?.split('});')[0] ?? '';
}

function parseIds(text) {
  const out = new Map();
  for (const m of text.matchAll(/'([0-9a-f]{16})': ("(?:[^"\\]|\\.)*")/g)) {
    out.set(m[1], JSON.parse(m[2]));
  }
  return out;
}

function parseBytes(text) {
  const out = new Map();
  for (const m of text.matchAll(/(\d+): ("(?:[^"\\]|\\.)*")/g)) out.set(m[1], JSON.parse(m[2]));
  return out;
}

// Everything that decides where an amiibo lands on a device. Tracked separately
// from the names because a change here means device-side renames, not just a
// different label in the UI.
function parseNaming(text) {
  return {
    short: parseBytes(block(text, 'AMIIBO_SERIES_SHORT')),
    files: parseIds(block(text, 'AMIIBO_FILE_NAMES')),
    abbrev: parseIds(block(text, 'AMIIBO_SHORT_NAMES')),
  };
}

// ---- snapshot what we have, fetch sources, regenerate ---------------------

const beforeText = await readFile(DB_FILE, 'utf8');
const before = parseIds(block(beforeText, 'AMIIBO_NAMES'));
const beforeNaming = parseNaming(beforeText);
console.log(`current database: ${before.size} entries`);

await mkdir(CACHE, { recursive: true });
for (const [name, url] of Object.entries(SOURCES)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`);
  await writeFile(join(CACHE, name), Buffer.from(await res.arrayBuffer()));
  console.log(`fetched ${name} (${res.headers.get('content-length') ?? '?'} bytes)`);
}

// The generator refuses to write on a collision or a bad overlay, and everything
// explaining why goes to stderr. Discarding it turned the one failure that
// matters into an unhandled rejection and a stack trace, which is precisely the
// moment you need the list of clashing IDs instead.
try {
  const { stdout, stderr } = await run('node', [
    join(ROOT, 'tools/build-amiibo-db.mjs'),
    join(CACHE, 'db_amiibo.c'),
    join(CACHE, 'amiibo.json'),
  ]);
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
} catch (err) {
  process.stdout.write(err.stdout ?? '');
  process.stderr.write(err.stderr ?? `${err.message}\n`);
  console.error('\nThe database was not regenerated. Nothing has been changed.');
  process.exit(1);
}

// ---- report the difference -------------------------------------------------

const afterText = await readFile(DB_FILE, 'utf8');
const after = parseIds(block(afterText, 'AMIIBO_NAMES'));
const afterNaming = parseNaming(afterText);
const added = [...after].filter(([id]) => !before.has(id));
const removed = [...before].filter(([id]) => !after.has(id));
const renamed = [...after].filter(([id, name]) => before.has(id) && before.get(id) !== name);

console.log(`\ndatabase: ${before.size} -> ${after.size} entries`);
if (added.length) {
  console.log(`added (${added.length}):`);
  for (const [id, name] of added) console.log(`  ${id}  ${name}`);
}
if (renamed.length) {
  console.log(`renamed (${renamed.length}):`);
  for (const [id, name] of renamed) console.log(`  ${id}  ${before.get(id)} -> ${name}`);
}
if (removed.length) {
  console.log(`REMOVED (${removed.length}) — upstream dropping entries is unusual, review before committing:`);
  for (const [id, name] of removed) console.log(`  ${id}  ${name}`);
}
if (!added.length && !removed.length && !renamed.length) console.log('no changes');

// ---- naming: where these amiibos will land on a device ---------------------
//
// A new short token or filename is routine. A *changed* one is not: it renames a
// folder or a file on the device, and the next sync then moves everything inside
// it. So changes are reported as loudly as a removal.

const naming = [
  ['series folder', beforeNaming.short, afterNaming.short],
  ['filename', beforeNaming.files, afterNaming.files],
  ['abbreviated name', beforeNaming.abbrev, afterNaming.abbrev],
];

const churn = [];
for (const [label, was, now] of naming) {
  const fresh = [...now].filter(([k]) => !was.has(k));
  const gone = [...was].filter(([k]) => !now.has(k));
  const changed = [...now].filter(([k, v]) => was.has(k) && was.get(k) !== v);

  if (fresh.length) {
    console.log(`\nnew ${label}s (${fresh.length}):`);
    for (const [k, v] of fresh) console.log(`  ${k}  ${v}`);
  }
  for (const [k, v] of changed) churn.push(`${label} ${k}: ${was.get(k)} -> ${v}`);
  for (const [k, v] of gone) churn.push(`${label} ${k}: ${v} -> (dropped, back to the display name)`);
}

if (churn.length) {
  console.log(
    `\nNAMING CHANGED (${churn.length}) — each of these renames a folder or file on every ` +
      'device already synced, and the next sync will move its contents. Review before committing:'
  );
  for (const c of churn) console.log(`  ${c}`);
} else {
  console.log('\nnaming: unchanged (no device-side renames)');
}

// ---- the curated overlay ---------------------------------------------------
//
// Upstream moving underneath a correction is the case worth surfacing: without
// AMIIBO_UPSTREAM it is undetectable, because the generated file alone cannot
// show a value that an override was masking.

const overlayText = await readFile(join(ROOT, OVERLAY_PATH), 'utf8').catch(() => null);
if (overlayText !== null) {
  let overlay = null;
  try {
    overlay = parseOverlay(overlayText);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }

  const amiibos = Object.entries(overlay.amiibos ?? {});
  const authored = amiibos.filter(([, e]) => e.kind === 'new').length;
  const pinnedPaths = amiibos.filter(([, e]) => e.path !== undefined).length;
  console.log(
    `\noverlay: ${amiibos.length - authored} corrections, ${authored} authored, ` +
      `${Object.keys(overlay.categories ?? {}).length} categories, ${pinnedPaths} pinned paths`
  );

  const wasUpstream = parseIds(block(beforeText, 'AMIIBO_UPSTREAM'));
  const nowUpstream = parseIds(block(afterText, 'AMIIBO_UPSTREAM'));
  const problems = [];

  for (const [id, entry] of amiibos) {
    if (entry.kind !== 'override') continue;
    if (!after.has(id)) {
      problems.push(`ORPHANED  ${id}: upstream no longer has this ID. The override does nothing.`);
      continue;
    }
    if (entry.name === undefined) continue;
    if (!nowUpstream.has(id)) {
      problems.push(`REDUNDANT ${id}: upstream now says "${after.get(id)}" itself. Delete the override.`);
    } else if (wasUpstream.has(id) && wasUpstream.get(id) !== nowUpstream.get(id)) {
      problems.push(
        `STALE     ${id}: upstream renamed "${wasUpstream.get(id)}" -> "${nowUpstream.get(id)}". ` +
          `Your override still says "${entry.name}". Confirm it is still the correction you want.`
      );
    }
  }

  for (const [catId, cat] of Object.entries(overlay.categories ?? {})) {
    for (const m of cat.members ?? []) {
      if (!after.has(m)) problems.push(`ORPHANED  ${m}: category "${catId}" lists an ID upstream dropped.`);
    }
  }

  if (problems.length) {
    console.log(`\nOVERLAY NEEDS ATTENTION (${problems.length}):`);
    for (const p of problems) console.log(`  ${p}`);
  }
}

// ---- artwork for anything new ----------------------------------------------

if (!skipImages) {
  console.log('');
  const { stdout } = await run('node', [join(ROOT, 'tools/fetch-amiibo-images.mjs')]);
  process.stdout.write(stdout);
}

console.log('\nReview with `git diff web/data/amiibo-db.js`, run `npm test`, then commit.');
