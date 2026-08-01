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

import { OVERLAY_PATH, parseOverlay, EMPTY_OVERLAY } from '../web/js/overlay.js';
import { parseGenerated, diffDatabases } from '../web/js/dbdiff.js';

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

// ---- snapshot what we have, fetch sources, regenerate ---------------------

const beforeText = await readFile(DB_FILE, 'utf8');
const before = parseGenerated(beforeText);
console.log(`current database: ${before.names.size} entries`);

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
//
// The comparison itself is web/js/dbdiff.js, shared with the admin's review
// screen. Two reports of what upstream changed would drift, and the drift would
// be invisible until one of them said a device-wide rename was harmless.

const afterText = await readFile(DB_FILE, 'utf8');
const after = parseGenerated(afterText);

const overlayForDiff = await readFile(join(ROOT, OVERLAY_PATH), 'utf8')
  .then(parseOverlay)
  .catch(() => EMPTY_OVERLAY);
const diff = diffDatabases(beforeText, afterText, { overlay: overlayForDiff });

const of = (group) => diff.changes.filter((c) => c.group === group);
const list = (rows, fmt) => { for (const c of rows) console.log(`  ${fmt(c)}`); };

console.log(`\ndatabase: ${before.names.size} -> ${after.names.size} entries`);

const added = of('added');
if (added.length) {
  console.log(`added (${added.length}):`);
  list(added, (c) => `${c.subject}  ${c.after}`);
}
const renamed = of('renamed');
if (renamed.length) {
  console.log(`renamed (${renamed.length}):`);
  list(renamed, (c) => `${c.subject}  ${c.before} -> ${c.after}`);
}
const removed = of('removed');
if (removed.length) {
  console.log(`REMOVED (${removed.length}) — upstream dropping entries is unusual, review before committing:`);
  list(removed, (c) => `${c.subject}  ${c.before}`);
}
const released = of('release');
if (released.length) {
  console.log(`release dates (${released.length}):`);
  list(released, (c) => `${c.subject}  ${c.before ?? '(none)'} -> ${c.after ?? '(none)'}  ${c.label}`);
}
const labels = of('label');
if (labels.length) {
  console.log(`series/type labels (${labels.length}):`);
  list(labels, (c) => `${c.kind} ${c.subject}  ${c.before ?? '(none)'} -> ${c.after}`);
}
if (!diff.counts.total) console.log('no changes');

// ---- naming: where these amiibos will land on a device ---------------------
//
// A changed folder token or filename renames something on the device, and the
// next sync then moves everything inside it. Reported as loudly as a removal.

const churn = of('naming');
if (churn.length) {
  console.log(
    `\nNAMING CHANGED (${churn.length}) — each of these renames a folder or file on every ` +
      'device already synced, and the next sync will move its contents. Review before committing:'
  );
  for (const c of churn) {
    console.log(`  ${c.kind} ${c.subject}: ${c.before} -> ${c.after}`);
    if (c.device) console.log(`      ${c.device.before} -> ${c.device.after}`);
  }
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

  const wasUpstream = before.upstream;
  const nowUpstream = after.upstream;
  const problems = [];

  // Orphans come from the shared diff, which also checks category members.
  for (const o of diff.orphans) {
    problems.push(o.kind === 'category'
      ? `ORPHANED  ${o.id}: ${o.why}.`
      : `ORPHANED  ${o.id}: ${o.why}. The override does nothing.`);
  }

  for (const [id, entry] of amiibos) {
    if (entry.kind !== 'override' || entry.name === undefined) continue;
    if (!after.names.has(id)) continue;   // already reported as orphaned
    if (!nowUpstream.has(id)) {
      problems.push(`REDUNDANT ${id}: upstream now says "${after.names.get(id)}" itself. Delete the override.`);
    } else if (wasUpstream.has(id) && wasUpstream.get(id) !== nowUpstream.get(id)) {
      problems.push(
        `STALE     ${id}: upstream renamed "${wasUpstream.get(id)}" -> "${nowUpstream.get(id)}". ` +
          `Your override still says "${entry.name}". Confirm it is still the correction you want.`
      );
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
