#!/usr/bin/env node
// Refreshes the vendored amiibo database (and artwork cache) from upstream.
// A development-time tool: the website itself never fetches anything.
//
//   npm run update-db            fetch sources, regenerate, fetch new images
//   npm run update-db -- --no-images    skip the artwork pass
//
// Sources, the same two the generator documents:
//   solosky/pixl.js    fw/application/src/amiidb/db_amiibo.c   (names)
//   N3evin/AmiiboAPI   database/amiibo.json                    (series, types)
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
    'https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json',
};

const skipImages = process.argv.includes('--no-images');

function parseDb(text) {
  const names = new Map();
  for (const m of text.matchAll(/'([0-9a-f]{16})': ("(?:[^"\\]|\\.)*")/g)) {
    names.set(m[1], JSON.parse(m[2]));
  }
  return names;
}

// ---- snapshot what we have, fetch sources, regenerate ---------------------

const before = parseDb(await readFile(DB_FILE, 'utf8'));
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

const after = parseDb(await readFile(DB_FILE, 'utf8'));
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

// ---- artwork for anything new ----------------------------------------------

if (!skipImages) {
  console.log('');
  const { stdout } = await run('node', [join(ROOT, 'tools/fetch-amiibo-images.mjs')]);
  process.stdout.write(stdout);
}

console.log('\nReview with `git diff web/data/amiibo-db.js`, run `npm test`, then commit.');
