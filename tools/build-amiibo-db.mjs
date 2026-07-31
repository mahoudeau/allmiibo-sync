#!/usr/bin/env node
// Regenerates web/data/amiibo-db.js by merging two public sources.
//
//   node tools/build-amiibo-db.mjs <db_amiibo.c> [amiibo.json]
//
// Sources
// -------
// 1. solosky/pixl.js — fw/application/src/amiidb/db_amiibo.c
//    The table the device itself uses. Its names are more specific than
//    AmiiboAPI's ("[AC] 001 - Isabelle" rather than "Isabelle"), which matters
//    for a collection list.
//
// 2. N3evin/AmiiboAPI — database/amiibo.json (MIT)
//    Authoritative amiibo-series and figure-type labels, keyed by the series
//    and type bytes of the amiibo ID.
//
// Vendored deliberately: nothing is fetched at runtime.
//
// This file is both a CLI and a library. `generate()` returns the file contents
// as a string and touches no disk, so the admin server can call it to rebuild
// the database when an edit is saved, and get the same invariants — including
// the collision check that refuses to write — as the command line.
//
// The parsing and the name derivation live in web/js/dbsource.js so the admin's
// preview screen runs exactly what the build runs. See the note at the top of
// that file.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  parseFirmwareTable,
  parseAmiiboApi,
  mergeSources,
  assignSeriesShort,
  disambiguate,
  buildNameTables,
  findNameCollisions,
} from '../web/js/dbsource.js';
import {
  EMPTY_OVERLAY,
  OVERLAY_PATH,
  applyOverlay,
  overlayPins,
  overlayCategories,
  parseOverlay,
} from '../web/js/overlay.js';

export const DB_PATH = 'web/data/amiibo-db.js';
export { OVERLAY_PATH };

/** Thrown when the inputs would produce a database that must not be written. */
export class GenerateError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'GenerateError';
    this.details = details;
  }
}

/**
 * Pull the committed short-token table back out of a previously generated file.
 *
 * The tokens are stable by design: one that changes renames a folder on every
 * synced device. The generated file is where that decision is recorded, so it is
 * read back rather than re-derived.
 */
export function parsePreviousShort(text) {
  const block = text?.split('AMIIBO_SERIES_SHORT = Object.freeze({')[1]?.split('});')[0] ?? '';
  return Object.fromEntries(
    [...block.matchAll(/(\d+):\s*("(?:[^"\\]|\\.)*")/g)].map((m) => [m[1], JSON.parse(m[2])])
  );
}

/**
 * Build the database file.
 *
 * @param {object}  input
 * @param {string}  input.firmware   contents of db_amiibo.c
 * @param {string}  [input.api]      contents of amiibo.json
 * @param {string}  [input.previous] the previously generated file, for stable tokens
 * @returns {{contents: string, report: object}}
 * @throws  {GenerateError} when the result would collide; nothing is written
 */
export function generate({ firmware, api = null, previous = '', overlay = EMPTY_OVERLAY }) {
  const firmwareNames = parseFirmwareTable(firmware);
  const parsedApi = api ? parseAmiiboApi(JSON.parse(api)) : null;
  const upstream = mergeSources(firmwareNames, parsedApi);
  const apiCount = upstream.apiCount;

  // The overlay is folded in HERE: after the sources merge, before anything is
  // derived from the names. That is what subjects a corrected or authored entry
  // to the same disambiguation and collision checks as an upstream one, with no
  // special-casing further down. A curated name cannot bypass the gate.
  const merged = applyOverlay(upstream, overlay);
  const { names, series, types, releases, notices, authored, upstreamWas } = merged;

  const fatal = notices.filter((n) => n.level === 'error');
  if (fatal.length) {
    throw new GenerateError(
      `${fatal.length} problem(s) in ${OVERLAY_PATH}. Nothing written.`,
      fatal.map((n) => `${n.id}: ${n.message}`)
    );
  }

  const entries = [...names].sort((a, b) => a[0].localeCompare(b[0]));

  const pins = overlayPins(overlay);
  const previousShort = parsePreviousShort(previous);
  const seriesShort = assignSeriesShort(series, previousShort, pins.seriesShort);
  const mintedShort = Object.keys(seriesShort).filter(
    (b) => previousShort[b] === undefined && pins.seriesShort[b] === undefined
  );

  const { suffixes, rules } = disambiguate(entries, { types, series });
  const derived = buildNameTables(entries, suffixes);

  // Curated names replace the derived ones, then go through the same collision
  // check below. A pin that duplicates what was derived anyway is dropped, so
  // the delta tables stay deltas.
  const fileNames = new Map(derived.fileNames);
  const shortNames = new Map(derived.shortNames);
  for (const [id, v] of pins.fileNames) {
    if (v === names.get(id)) fileNames.delete(id);
    else fileNames.set(id, v);
  }
  for (const [id, v] of pins.shortNames) {
    if (v === (fileNames.get(id) ?? names.get(id))) shortNames.delete(id);
    else shortNames.set(id, v);
  }

  const { categories, notices: catNotices } = overlayCategories(overlay, names);
  notices.push(...catNotices);

  // Every series and type byte an ID uses must have a label. This was previously
  // only checked by the test suite, which is too late now that an authored entry
  // can introduce a byte upstream has never heard of.
  const missing = [];
  for (const [id] of entries) {
    const s = parseInt(id.slice(12, 14), 16);
    const t = parseInt(id.slice(6, 8), 16);
    if (series[s] === undefined) missing.push(`${id}: series byte 0x${id.slice(12, 14)} has no label`);
    if (types[t] === undefined) missing.push(`${id}: type byte 0x${id.slice(6, 8)} has no label`);
  }
  if (missing.length) {
    throw new GenerateError(
      `${missing.length} entr(ies) use a series or type with no label. Nothing written.`,
      [...new Set(missing)].slice(0, 20)
    );
  }

  // Fail rather than ship a database that lets two amiibos land on one path.
  // Checked for both the full and the abbreviated form, since the path ladder
  // may fall back to either.
  const clashes = findNameCollisions(entries, { fileNames, shortNames, names });
  if (clashes.length) {
    throw new GenerateError(
      `${clashes.length} name collision(s) that no rule resolved. Nothing written.`,
      clashes.map((c) => `${c.kind}: ${c.a} and ${c.b} both want ${JSON.stringify(c.value)}`)
    );
  }

  const shortValues = Object.values(seriesShort);
  if (new Set(shortValues).size !== shortValues.length) {
    throw new GenerateError('AMIIBO_SERIES_SHORT is not unique; nothing written.');
  }

  const seriesLabel = (b) => series[b] ?? `Series ${b}`;

  const contents = `// Generated by tools/build-amiibo-db.mjs — do not edit by hand.
//
// LICENSE: GPL-2.0. The amiibo name table below is derived from solosky/pixl.js
// (fw/application/src/amiidb/db_amiibo.c), which is GPL-2.0; this generated file
// inherits that license. See LICENSE.GPL-2.0. Series/type labels and release
// dates are from 8bitDream/AmiiboAPI (fork of N3evin/AmiiboAPI), MIT.
//
// Sources:
//   - solosky/pixl.js       fw/application/src/amiidb/db_amiibo.c  (names, GPL-2.0)
//   - 8bitDream/AmiiboAPI   database/amiibo.json                   (series, types, dates, MIT)
//
// ${entries.length} amiibo IDs, ${Object.keys(series).length} series, ${Object.keys(types).length} types.

// amiibo ID (16 hex chars, bytes 84..91 of a dump) -> display name.
export const AMIIBO_NAMES = Object.freeze({
${entries.map(([id, name]) => `  '${id}': ${JSON.stringify(name)},`).join('\n')}
});

// Byte 6 of the ID -> amiibo series.
export const AMIIBO_SERIES = Object.freeze({
${Object.entries(series).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n')}
});

// Byte 3 of the ID -> figure type.
export const AMIIBO_TYPES = Object.freeze({
${Object.entries(types).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n')}
});

// amiibo ID -> earliest regional release date (YYYY-MM-DD).
export const AMIIBO_RELEASE = Object.freeze({
${[...releases].sort((a, b) => a[0].localeCompare(b[0])).map(([id, d]) => `  '${id}': '${d}',`).join('\n')}
});

// Byte 6 of the ID -> short folder token, for when the full series label will
// not fit the device's 63-byte path limit. Initials of the label's words, or the
// label itself where initials would be useless or already taken.
//
// These are STABLE: a token here is never re-derived once committed, because
// changing one renames a folder on the device and the next sync then moves
// every file inside it. tools/build-amiibo-db.mjs preserves what it finds and
// only mints tokens for new series.
export const AMIIBO_SERIES_SHORT = Object.freeze({
${Object.entries(seriesShort).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`).join('\n')}
});

// amiibo ID -> filename base, where the display name is not unique within its
// series folder. Only the ${fileNames.size} ambiguous IDs appear; for every other ID the
// filename is AMIIBO_NAMES[id]. Generation fails rather than emit a collision.
export const AMIIBO_FILE_NAMES = Object.freeze({
${[...fileNames].map(([id, n]) => `  '${id}': ${JSON.stringify(n)},`).join('\n')}
});

// amiibo ID -> abbreviated filename base, for paths that will not otherwise
// fit. Abbreviates the segment after the last " - ": "Pink Gold Peach - Horse
// Racing" -> "Pink Gold Peach - HR". Only the ${shortNames.size} names long enough to matter
// appear.
export const AMIIBO_SHORT_NAMES = Object.freeze({
${[...shortNames].map(([id, n]) => `  '${id}': ${JSON.stringify(n)},`).join('\n')}
});
${curatedTables({ categories, paths: pins.paths, notes: pins.notes, authored, upstreamWas })}`;

  return {
    contents,
    report: {
      entries: entries.length,
      series: Object.keys(series).length,
      types: Object.keys(types).length,
      releases: releases.size,
      apiCount,
      seriesShort,
      mintedShort,
      fileNames: fileNames.size,
      shortNames: shortNames.size,
      rules,
      seriesLabel,
      notices,
      authored,
      categories: Object.keys(categories).length,
      paths: pins.paths.size,
      notes: pins.notes.size,
    },
  };
}

/**
 * The tables that carry curated data.
 *
 * Always emitted, empty or not. They are part of the file's shape, so consumers
 * can import them by name without every importer having to cope with a database
 * built before the overlay existed.
 */
function curatedTables({ categories, paths, notes, authored, upstreamWas }) {
  const idTable = (name, map, comment) => `
// ${comment}
export const ${name} = Object.freeze({${map.size ? `
${[...map].sort((a, b) => a[0].localeCompare(b[0])).map(([id, v]) => `  '${id}': ${JSON.stringify(v)},`).join('\n')}
` : ''}});
`;

  return `
// Curated groupings, from ${OVERLAY_PATH}. Nothing upstream has these.
export const AMIIBO_CATEGORIES = Object.freeze({${Object.keys(categories).length ? `
${Object.entries(categories).map(([id, c]) =>
  `  ${JSON.stringify(id)}: Object.freeze({ label: ${JSON.stringify(c.label)}, order: ${c.order}, members: Object.freeze([${c.members.map((m) => `'${m}'`).join(', ')}]) }),`
).join('\n')}
` : ''}});
${idTable('AMIIBO_PATHS', paths,
  'amiibo ID -> a curated device-relative path, tried before the generated name.')}${idTable('AMIIBO_NOTES', notes,
  "amiibo ID -> a curator's note, shown in the UI.")}
// IDs that exist only because ${OVERLAY_PATH} says so. Not official products, so
// the UI lists them with the other fan-made entries behind the same setting and
// the headline completion figure stays comparable.
export const AMIIBO_AUTHORED = Object.freeze([${authored.length ? `
${authored.slice().sort().map((id) => `  '${id}',`).join('\n')}
` : ''}]);
${idTable('AMIIBO_UPSTREAM', upstreamWas,
  'amiibo ID -> the upstream value an override replaced. Not for display: it is\n// how update-db notices upstream changing underneath a correction.')}`;
}

// ---- CLI ----------------------------------------------------------------

const isCli = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isCli) {
  const [firmwareSrc, apiSrc] = process.argv.slice(2);
  if (!firmwareSrc) {
    console.error('usage: node tools/build-amiibo-db.mjs <db_amiibo.c> [amiibo.json]');
    process.exit(1);
  }

  const root = fileURLToPath(new URL('..', import.meta.url));
  const dest = join(root, DB_PATH);
  const firmware = await readFile(firmwareSrc, 'utf8');
  const api = apiSrc ? await readFile(apiSrc, 'utf8') : null;
  // Missing on a first run, or when there is no database yet.
  const previous = await readFile(dest, 'utf8').catch(() => '');

  // Absent is fine and means "no curated data"; present but malformed is not,
  // and says exactly what is wrong rather than being quietly skipped.
  const overlayText = await readFile(join(root, OVERLAY_PATH), 'utf8').catch(() => null);
  let overlay = EMPTY_OVERLAY;
  if (overlayText !== null) {
    try {
      overlay = parseOverlay(overlayText);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  let built;
  try {
    built = generate({ firmware, api, previous, overlay });
  } catch (err) {
    if (!(err instanceof GenerateError)) throw err;
    console.error(err.message);
    for (const d of err.details) console.error(`  ${d}`);
    process.exit(1);
  }

  const r = built.report;
  await writeFile(dest, built.contents);
  console.log(
    `wrote ${r.entries} names, ${r.series} series, ` +
      `${r.types} types, ${r.releases} release dates ` +
      `(AmiiboAPI contributed ${r.apiCount} entries)`
  );
  console.log(
    `naming: ${Object.keys(r.seriesShort).length} series tokens ` +
      `(${r.mintedShort.length} minted, ${Object.keys(r.seriesShort).length - r.mintedShort.length} preserved), ` +
      `${r.fileNames} disambiguated filenames, ${r.shortNames} abbreviated names`
  );
  for (const b of r.mintedShort) console.log(`  minted ${r.seriesShort[b]} for ${r.seriesLabel(b)}`);
  for (const rule of r.rules) {
    console.log(`  ${rule.series} "${rule.name}" x${rule.ids.length} by ${rule.rule}`);
  }

  if (r.authored.length || r.categories || r.paths || r.notes) {
    console.log(
      `overlay: ${r.authored.length} authored, ${r.categories} categories, ` +
        `${r.paths} pinned paths, ${r.notes} notes`
    );
  }
  // Upstream moving underneath a correction is a warning, never a failure: a
  // routine refresh must not break because a third party edited their repo.
  for (const n of r.notices) console.warn(`  ${n.level}: ${n.id}: ${n.message}`);
}
