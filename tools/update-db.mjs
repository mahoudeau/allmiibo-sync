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

await run('node', [
  join(ROOT, 'tools/build-amiibo-db.mjs'),
  join(CACHE, 'db_amiibo.c'),
  join(CACHE, 'amiibo.json'),
]).then(({ stdout }) => process.stdout.write(stdout));

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

// ---- artwork for anything new ----------------------------------------------

if (!skipImages) {
  console.log('');
  const { stdout } = await run('node', [join(ROOT, 'tools/fetch-amiibo-images.mjs')]);
  process.stdout.write(stdout);
}

console.log('\nReview with `git diff web/data/amiibo-db.js`, run `npm test`, then commit.');
