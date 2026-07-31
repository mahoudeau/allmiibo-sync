// Reading the upstream amiibo sources, and deriving names from them.
//
// This is the logic the database is built from: parsing the two upstream files,
// merging them, and working out the folder tokens and collision-free filenames
// that decide where an amiibo lands on a device.
//
// It lives here, in web/js/, rather than inside the generator because three
// callers need to agree exactly:
//
//   tools/build-amiibo-db.mjs   builds the committed database
//   the admin server            regenerates it when an edit is saved
//   the admin's preview screen  shows what an upstream refresh WOULD change
//
// If the preview ran its own copy of these rules it would drift from the build,
// and the drift would be invisible until a device ended up with two amiibos on
// one path. One implementation, three importers.
//
// DOM-free and dependency-free on purpose: Node imports it directly, and it must
// never import the database it helps generate.

import { utf8Bytes, sanitizeLocalName } from './devicepath.js';

/** Rows of the firmware table, e.g. `{0x01810001, 0x00440502, "name", "..."}`. */
export const FIRMWARE_ROW =
  /\{\s*0x([0-9a-fA-F]{8})\s*,\s*0x([0-9a-fA-F]{8})\s*,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

/** Sort an object with numeric-ish keys into ascending numeric order. */
export function sortNum(o) {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0])
  );
}

/** Series byte of an amiibo ID (byte 6). */
export const seriesByteOf = (id) => parseInt(id.slice(12, 14), 16);

/**
 * Names from solosky/pixl.js `db_amiibo.c`.
 *
 * Its names are more specific than the alternative ("[AC] 001 - Isabelle"
 * rather than "Isabelle"), which is why it wins over AmiiboAPI.
 *
 * @returns {Map<string, string>} 16-hex ID -> display name
 */
export function parseFirmwareTable(text) {
  const names = new Map();
  // matchAll on a /g regex is stateless per call, but the literal is shared, so
  // reset lastIndex rather than trusting the previous caller.
  FIRMWARE_ROW.lastIndex = 0;
  for (const m of text.matchAll(FIRMWARE_ROW)) {
    names.set(`${m[1].toLowerCase()}${m[2].toLowerCase()}`, m[3].replace(/\\"/g, '"'));
  }
  return names;
}

/**
 * Series and type labels, release dates, and any amiibo the firmware table
 * lacks, from 8bitDream/AmiiboAPI `amiibo.json`.
 *
 * @returns {{series: object, types: object, names: Map, releases: Map, count: number}}
 */
export function parseAmiiboApi(json) {
  const series = {};
  const types = {};
  const names = new Map();
  const releases = new Map();
  let count = 0;

  const byte = (k) => parseInt(k.replace(/^0x/, ''), 16);

  for (const [k, v] of Object.entries(json.amiibo_series ?? {})) series[byte(k)] = v;
  for (const [k, v] of Object.entries(json.types ?? {})) types[byte(k)] = v;

  // The earliest regional release date is what lets the UI order series
  // chronologically.
  for (const [k, v] of Object.entries(json.amiibos ?? {})) {
    const id = k.replace(/^0x/, '').toLowerCase();
    count++;
    names.set(id, v.name);
    const dates = Object.values(v.release ?? {}).filter(Boolean).sort();
    if (dates.length) releases.set(id, dates[0]);
  }

  return { series, types, names, releases, count };
}

/**
 * Combine the two sources. The firmware table wins on names; AmiiboAPI fills
 * any ID it does not carry, and supplies every label and date.
 */
export function mergeSources(firmwareNames, api) {
  const names = new Map(firmwareNames);
  if (api) {
    for (const [id, name] of api.names) if (!names.has(id)) names.set(id, name);
  }
  return {
    names,
    series: sortNum(api?.series ?? {}),
    types: sortNum(api?.types ?? {}),
    releases: api?.releases ?? new Map(),
    apiCount: api?.count ?? 0,
  };
}

// ---- deriving names -----------------------------------------------------

// Only names long enough to ever threaten the path limit get an abbreviation;
// tabulating the other ~600 would add 25 kB nobody reads.
export const SHORT_NAME_MIN_BYTES = 20;

// Initials of a label's words, digits kept whole: "Mario Sports Superstars" ->
// "MSS", "Street Fighter 6" -> "SF6". Null for a single word, because "S" for
// Splatoon helps nobody and collides with Skylanders.
export function initialism(label) {
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length < 2) return null;
  return words.map((w) => (/^[0-9]/.test(w) ? w : w[0].toUpperCase())).join('');
}

// A short folder token per series.
//
// Stability outranks prettiness: a token that changes between database updates
// renames a folder on the device, and the next sync then moves every file
// inside it. So a token already committed is kept as-is — even if upstream has
// since reworded the label — and only genuinely new series mint one. Where a
// newcomer's initialism is already taken it is the newcomer that gives way.
//
// `pins` lets curated data override even that, which is the one way to correct a
// token that was minted badly. Use it knowingly: it renames a device folder.
export function assignSeriesShort(series, previous = {}, pins = {}) {
  const short = {};
  const taken = new Set();

  for (const [b, token] of Object.entries(pins)) {
    if (series[b] === undefined) continue;
    short[b] = token;
    taken.add(token);
  }
  for (const b of Object.keys(series)) {
    if (short[b] !== undefined || previous[b] === undefined) continue;
    short[b] = previous[b];
    taken.add(previous[b]);
  }
  for (const [b, label] of Object.entries(series)) {
    if (short[b] !== undefined) continue;
    const ini = initialism(label);
    short[b] = ini && !taken.has(ini) ? ini : label;
    taken.add(short[b]);
  }
  return sortNum(short);
}

// Abbreviate the segment after the last " - ": "Pink Gold Peach - Horse
// Racing" -> "Pink Gold Peach - HR". Null when there is nothing to gain.
export function abbreviate(name) {
  const cut = name.lastIndexOf(' - ');
  if (cut === -1) return null;
  const ini = initialism(name.slice(cut + 3));
  if (!ini) return null;
  const out = `${name.slice(0, cut)} - ${ini}`;
  return utf8Bytes(out) < utf8Bytes(name) ? out : null;
}

// Two amiibos in one series folder cannot share a filename. Every clash in the
// database has something real to name it by, so none of them need a bare
// counter: figure type, then character variant, then — for two printings of the
// same card, which differ in nothing else — the model number.
export function disambiguate(entries, { types = {}, series = {} } = {}) {
  const seriesLabel = (b) => series[b] ?? `Series ${b}`;
  const groups = new Map();
  for (const [id, name] of entries) {
    const key = `${seriesByteOf(id)} ${name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }

  const suffixes = new Map(); // id -> suffix, '' for most
  const rules = [];           // what resolved each clash, for the build log
  for (const ids of groups.values()) {
    if (ids.length === 1) {
      suffixes.set(ids[0], '');
      continue;
    }
    const typeOf = (id) => parseInt(id.slice(6, 8), 16);
    const variantOf = (id) => parseInt(id.slice(4, 6), 16);
    const distinct = (fn) => new Set(ids.map(fn)).size === ids.length;

    let rule;
    if (distinct(typeOf)) {
      rule = 'figure type';
      // A Figure keeps the plain name; the card or yarn version is the one
      // that carries a qualifier.
      for (const id of ids) {
        const t = typeOf(id);
        suffixes.set(id, t === 0 ? '' : ` (${types[t] ?? `Type ${t}`})`);
      }
    } else if (distinct(variantOf)) {
      rule = 'character variant';
      for (const id of ids) {
        const v = variantOf(id);
        suffixes.set(id, v === 0 ? '' : ` v${v + 1}`);
      }
    } else {
      rule = 'model number';
      for (const id of ids) suffixes.set(id, ` ${id.slice(8, 12)}`);
    }
    const name = entries.find(([id]) => id === ids[0])?.[1];
    rules.push({ rule, name, series: seriesLabel(seriesByteOf(ids[0])), ids });
  }
  return { suffixes, rules };
}

/**
 * The filename and abbreviated-name delta tables, given merged entries and the
 * disambiguation suffixes. Only rows that differ from the display name appear.
 */
export function buildNameTables(entries, suffixes) {
  const fileNames = new Map();
  const shortNames = new Map();

  for (const [id, name] of entries) {
    const suffix = suffixes.get(id) ?? '';
    const fileName = `${name}${suffix}`;
    if (fileName !== name) fileNames.set(id, fileName);

    if (utf8Bytes(fileName) <= SHORT_NAME_MIN_BYTES) continue;
    const abbreviated = abbreviate(name);
    if (!abbreviated) continue;
    const shortName = `${abbreviated}${suffix}`;
    if (shortName !== fileName) shortNames.set(id, shortName);
  }

  return { fileNames, shortNames };
}

/**
 * Every (series folder, filename) pair that two amiibos must not share.
 *
 * Returns a list of clashes rather than throwing, so the generator can fail the
 * build and the admin can show them as errors before anything is written.
 */
export function findNameCollisions(entries, { fileNames, shortNames, names }) {
  // Written as two explicit passes rather than a loop over selector functions.
  // The reference check in test/ui-modules.test.mjs cannot tell a destructured
  // local from a function that was deleted, and it is worth more as a blunt
  // instrument than this is as a clever one.
  const clashes = [];

  const seenFull = new Map();
  for (const [id] of entries) {
    const value = fileNames.get(id) ?? names.get(id);
    const key = `${seriesByteOf(id)} ${value}`;
    if (seenFull.has(key)) clashes.push({ kind: 'filename', a: seenFull.get(key), b: id, value });
    seenFull.set(key, id);
  }

  const seenShort = new Map();
  for (const [id] of entries) {
    const value = shortNames.get(id) ?? fileNames.get(id) ?? names.get(id);
    const key = `${seriesByteOf(id)} ${value}`;
    if (seenShort.has(key)) clashes.push({ kind: 'short name', a: seenShort.get(key), b: id, value });
    seenShort.set(key, id);
  }

  return clashes;
}

export { utf8Bytes, sanitizeLocalName };
