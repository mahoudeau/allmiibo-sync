// The curated overlay: your corrections, sitting on top of the upstream sources.
//
// The database is generated, and `npm run update-db` rewrites it from scratch
// every time. So an edit made directly to web/data/amiibo-db.js survives exactly
// until the next refresh. Everything curated therefore lives here instead, in a
// file the generator merges, and the merge happens BEFORE the disambiguation and
// uniqueness checks so a corrected or authored entry is held to the same
// standard as an upstream one. A curated name cannot bypass the collision gate.
//
// Canonical location: content/amiibo-overrides.json, committed. It has to be
// committed for a clean clone to reproduce the database it ships with.
//
// Pure and dependency-free: the generator, the admin server and the admin UI all
// import this, and it must never import the database it helps build.

import { utf8Bytes, sanitizeLocalName, checkDestination, MAX_NAME_BYTES } from './devicepath.js';

export const OVERLAY_PATH = 'content/amiibo-overrides.json';
export const SCHEMA_VERSION = 1;

/** The device root paths are validated against. A longer real root still works;
 *  the runtime falls through to the ladder rather than breaking. */
export const REFERENCE_ROOT = 'E:/amiibo';

export const EMPTY_OVERLAY = Object.freeze({
  schema: SCHEMA_VERSION,
  series: {},
  types: {},
  categories: {},
  amiibos: {},
});

const ID_RE = /^[0-9a-f]{16}$/;
const CATEGORY_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ROOT_KEYS = new Set(['schema', 'series', 'types', 'categories', 'amiibos']);
const AMIIBO_KEYS = new Set([
  'kind', 'name', 'release', 'fileName', 'shortName', 'path', 'blurb', 'note',
  'upstreamWas', 'decidedAt',
]);
const SERIES_KEYS = new Set(['label', 'short', 'face', 'note', 'upstreamWas', 'decidedAt']);
const TYPE_KEYS = new Set(['label', 'note']);
const CATEGORY_KEYS = new Set(['label', 'order', 'members', 'note']);

// Series whose files are not one-to-one with the amiibo ID, so a pinned path
// would collapse many real dumps onto one filename. 0x1e is Kirby Air Riders:
// four vehicle pairings share a single ID.
const SERIES_KIRBY_AIR_RIDERS = 0x1e;
// The fan-made Happy Home Designer pack: 91 cards, one fabricated ID.
const HHD_HEAD = '026a0001';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check the record of what upstream said when a pin was written.
 *
 * `upstreamWas[field]` is what the build produced for that field at the moment
 * the line was drawn — upstream's own value where upstream has one, the derived
 * value where the build derives it, and null where it produced nothing. It is
 * what lets a later refresh tell a pin that is still holding from one upstream
 * has come round to, or moved past.
 *
 * The invariant that earns its keep: a record with no pin beside it is
 * dangling. That is what makes dropping a pin self-checking — the drop has to
 * remove the record too, and a half-applied one fails validation instead of
 * quietly rotting.
 */
function checkUpstreamWas(entry, pinnable, where, bad) {
  if (entry.upstreamWas === undefined) return;
  if (!isPlainObject(entry.upstreamWas)) {
    return bad(`${where}.upstreamWas must be an object`);
  }
  for (const [field, value] of Object.entries(entry.upstreamWas)) {
    if (!pinnable.has(field)) {
      bad(`${where}.upstreamWas: ${JSON.stringify(field)} is not a pinnable field`);
      continue;
    }
    if (value !== null && typeof value !== 'string') {
      bad(`${where}.upstreamWas.${field} must be a string or null`);
    }
    if (entry[field] === undefined) {
      bad(`${where}.upstreamWas.${field} records a value with no pin beside it`);
    }
  }
}

const checkDecidedAt = (entry, where, bad) => {
  if (entry.decidedAt !== undefined && !ISO_DATE_RE.test(entry.decidedAt)) {
    bad(`${where}.decidedAt must be YYYY-MM-DD`);
  }
};

/** Fields a pin can be written for, per table. */
const PINNABLE_AMIIBO = new Set(['name', 'release', 'fileName', 'shortName', 'path', 'blurb']);
const PINNABLE_SERIES = new Set(['label', 'short', 'face']);

/**
 * Check an overlay's shape. Returns a list of human-readable problems; empty
 * means it is safe to merge.
 *
 * Unknown keys are errors, not warnings. A mistyped "catagories" that silently
 * does nothing is the worst failure mode a curated file can have.
 */
export function validateOverlay(overlay) {
  const errors = [];
  const bad = (msg) => errors.push(msg);

  if (!isPlainObject(overlay)) return ['the overlay must be a JSON object'];
  if (overlay.schema !== SCHEMA_VERSION) {
    bad(`schema must be ${SCHEMA_VERSION}, found ${JSON.stringify(overlay.schema)}`);
  }
  for (const key of Object.keys(overlay)) {
    if (!ROOT_KEYS.has(key)) bad(`unknown top-level key ${JSON.stringify(key)}`);
  }

  const byteTable = (name, table, allowed) => {
    if (table === undefined) return;
    if (!isPlainObject(table)) return bad(`${name} must be an object`);
    for (const [k, v] of Object.entries(table)) {
      const n = Number(k);
      if (!Number.isInteger(n) || n < 0 || n > 255) bad(`${name}: ${JSON.stringify(k)} is not a byte`);
      if (!isPlainObject(v)) { bad(`${name}[${k}] must be an object`); continue; }
      for (const key of Object.keys(v)) {
        if (!allowed.has(key)) bad(`${name}[${k}]: unknown key ${JSON.stringify(key)}`);
      }
      if (v.label !== undefined && (typeof v.label !== 'string' || !v.label.trim())) {
        bad(`${name}[${k}].label must be a non-empty string`);
      }
      if (v.short !== undefined && (typeof v.short !== 'string' || !v.short.trim())) {
        bad(`${name}[${k}].short must be a non-empty string`);
      }
      // A folder token is one path segment on the device, so it faces the same
      // rules a filename does: no separators, and nothing the sanitiser would
      // rewrite behind your back.
      if (typeof v.short === 'string' && v.short.trim()) {
        if (v.short.includes('/') || v.short.includes('\\')) {
          bad(`${name}[${k}].short ${JSON.stringify(v.short)} must be one folder name, not a path`);
        } else if (sanitizeLocalName(v.short) !== v.short) {
          bad(`${name}[${k}].short ${JSON.stringify(v.short)} is not a safe folder name`);
        }
      }
      // The face is the amiibo whose artwork stands for the series. It has to
      // belong to the series it represents, or the header shows a character
      // from somewhere else entirely.
      if (v.face !== undefined) {
        if (typeof v.face !== 'string' || !ID_RE.test(v.face)) {
          bad(`${name}[${k}].face must be a 16-character lowercase hex ID`);
        } else if (parseInt(v.face.slice(12, 14), 16) !== n) {
          bad(`${name}[${k}].face ${v.face} is not in that series`);
        }
      }
      checkUpstreamWas(v, PINNABLE_SERIES, `${name}[${k}]`, bad);
      checkDecidedAt(v, `${name}[${k}]`, bad);
    }
  };
  byteTable('series', overlay.series, SERIES_KEYS);
  byteTable('types', overlay.types, TYPE_KEYS);

  if (overlay.categories !== undefined) {
    if (!isPlainObject(overlay.categories)) bad('categories must be an object');
    else {
      for (const [id, cat] of Object.entries(overlay.categories)) {
        if (!CATEGORY_ID_RE.test(id)) bad(`category ${JSON.stringify(id)}: id must be lowercase a-z0-9 and dashes`);
        if (!isPlainObject(cat)) { bad(`category ${id} must be an object`); continue; }
        for (const key of Object.keys(cat)) {
          if (!CATEGORY_KEYS.has(key)) bad(`category ${id}: unknown key ${JSON.stringify(key)}`);
        }
        if (typeof cat.label !== 'string' || !cat.label.trim()) bad(`category ${id}: label is required`);
        if (cat.order !== undefined && !Number.isInteger(cat.order)) bad(`category ${id}: order must be an integer`);
        if (cat.members !== undefined) {
          if (!Array.isArray(cat.members)) bad(`category ${id}: members must be an array`);
          else {
            const seen = new Set();
            for (const m of cat.members) {
              if (typeof m !== 'string' || !ID_RE.test(m)) bad(`category ${id}: ${JSON.stringify(m)} is not an amiibo ID`);
              else if (seen.has(m)) bad(`category ${id}: ${m} listed twice`);
              seen.add(m);
            }
          }
        }
      }
    }
  }

  if (overlay.amiibos !== undefined) {
    if (!isPlainObject(overlay.amiibos)) bad('amiibos must be an object');
    else for (const [id, entry] of Object.entries(overlay.amiibos)) {
      for (const p of validateAmiiboEntry(id, entry)) bad(`${id}: ${p.message}`);
    }
  }

  return errors;
}

/**
 * Problems with one amiibo's overlay entry, each tagged with the field it
 * belongs to.
 *
 * Split out of validateOverlay so the admin can put an error under the input
 * that caused it. The alternative — matching the assembled `${id}: ...` strings
 * with a regex — works until someone rewords a message, and several of these
 * name no field at all ("Kirby Air Riders amiibo have four vehicle pairings").
 * Tagging at the source is the only version that stays true.
 *
 * `field` is null for problems about the entry as a whole.
 *
 * @returns {{ field: string|null, message: string }[]}
 */
export function validateAmiiboEntry(id, entry) {
  const problems = [];
  const bad = (field, message) => problems.push({ field, message });

  // Lowercase is enforced so a pasted uppercase ID fails loudly rather than
  // shadowing nothing at all.
  if (!ID_RE.test(id)) return [{ field: null, message: 'not a 16-character lowercase hex ID' }];
  if (!isPlainObject(entry)) return [{ field: null, message: 'must be an object' }];

  for (const key of Object.keys(entry)) {
    if (!AMIIBO_KEYS.has(key)) bad(null, `unknown key ${JSON.stringify(key)}`);
  }
  if (entry.kind !== 'override' && entry.kind !== 'new') {
    bad('kind', 'kind must be "override" or "new"');
  }
  if (entry.kind === 'new' && (typeof entry.name !== 'string' || !entry.name.trim())) {
    bad('name', 'an authored amiibo needs a name');
  }
  if (entry.release !== undefined && entry.release !== null && !ISO_DATE_RE.test(entry.release)) {
    bad('release', 'release must be YYYY-MM-DD or null');
  }
  for (const field of ['name', 'fileName', 'shortName', 'blurb', 'note']) {
    if (entry[field] !== undefined && typeof entry[field] !== 'string') {
      bad(field, `${field} must be a string`);
    }
  }
  for (const field of ['fileName', 'shortName']) {
    const v = entry[field];
    if (typeof v !== 'string' || !v) continue;
    // A filename is one path segment. sanitizeLocalName strips illegal
    // characters but not separators, so "a/b" would sail through it and
    // then quietly create a folder. Check separators explicitly.
    if (v.includes('/') || v.includes('\\')) {
      bad(field, `${field} ${JSON.stringify(v)} must be a filename, not a path`);
    }
    // A pin the sanitiser would rewrite is a lie about what lands on disk.
    if (sanitizeLocalName(v) !== v) bad(field, `${field} ${JSON.stringify(v)} is not a safe filename`);
    if (utf8Bytes(`${v}.bin`) > MAX_NAME_BYTES) {
      bad(field, `${field} is ${utf8Bytes(`${v}.bin`)} bytes with .bin, over the ${MAX_NAME_BYTES}-byte limit`);
    }
  }
  if (entry.shortName && entry.fileName &&
      utf8Bytes(entry.shortName) >= utf8Bytes(entry.fileName)) {
    bad('shortName', 'shortName must be shorter than fileName');
  }
  if (entry.path !== undefined) {
    // validatePinnedPath prefixes the id, because it is also called on its own.
    for (const message of validatePinnedPath(id, entry.path)) {
      bad('path', message.startsWith(`${id}: `) ? message.slice(id.length + 2) : message);
    }
  }
  checkUpstreamWas(entry, PINNABLE_AMIIBO, 'entry', (m) =>
    bad(null, m.replace(/^entry\./, '')));
  checkDecidedAt(entry, 'entry', (m) => bad(null, m.replace(/^entry\./, '')));
  return problems;
}

/** Problems with a pinned device path, or an empty list. */
export function validatePinnedPath(id, path) {
  const errors = [];
  if (typeof path !== 'string' || !path) return [`${id}: path must be a non-empty string`];
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) {
    errors.push(`${id}: path must be relative to the device folder`);
  }
  if (path.split('/').includes('..')) errors.push(`${id}: path must not contain ".."`);
  if (!path.toLowerCase().endsWith('.bin')) errors.push(`${id}: path must end in .bin`);
  for (const seg of path.split('/')) {
    if (!seg) errors.push(`${id}: path has an empty segment`);
    else if (sanitizeLocalName(seg) !== seg) errors.push(`${id}: path segment ${JSON.stringify(seg)} is not safe`);
  }
  const why = checkDestination(REFERENCE_ROOT, path);
  if (why) errors.push(`${id}: at ${REFERENCE_ROOT}, ${why}`);

  // The one case a pin must never be allowed: an ID that stands for more than
  // one physical dump. Air Riders characters have four vehicle pairings and the
  // 91 HHD cards share a fabricated ID, so a single pinned path would collapse
  // them all onto one filename and keep the last.
  if (ID_RE.test(id)) {
    if (parseInt(id.slice(12, 14), 16) === SERIES_KIRBY_AIR_RIDERS) {
      errors.push(`${id}: Kirby Air Riders amiibo have four vehicle pairings per ID, so a pinned path would collapse them`);
    }
    if (id.slice(0, 8) === HHD_HEAD) {
      errors.push(`${id}: the Happy Home Designer cards share one ID, so a pinned path would collapse them`);
    }
  }
  return errors;
}

/**
 * Fold the overlay into the merged upstream data.
 *
 * Mutates nothing: returns fresh maps and objects, plus the notices the build
 * and `update-db` report. Upstream moving underneath an override is a warning,
 * never a failure — a routine refresh must not break because a third party
 * edited their repo. A bad hand edit is a different matter and fails validation
 * above.
 */
export function applyOverlay({ names, series, types, releases }, overlay = EMPTY_OVERLAY) {
  const out = {
    names: new Map(names),
    series: { ...series },
    types: { ...types },
    releases: new Map(releases),
  };
  const notices = [];
  const authored = [];
  const upstreamWas = new Map();

  for (const [b, v] of Object.entries(overlay.series ?? {})) {
    if (v.label !== undefined) out.series[b] = v.label;
  }
  for (const [b, v] of Object.entries(overlay.types ?? {})) {
    if (v.label !== undefined) out.types[b] = v.label;
  }

  for (const [id, entry] of Object.entries(overlay.amiibos ?? {})) {
    const existed = names.has(id);

    if (entry.kind === 'new') {
      if (existed) {
        // Two independent sources now claim to name one ID and the tool cannot
        // choose. One word fixes it, and the message says which.
        notices.push({
          level: 'error', id,
          message: `authored as "new" but upstream now has this ID. Change kind to "override".`,
        });
        continue;
      }
      out.names.set(id, entry.name);
      authored.push(id);
    } else {
      if (!existed) {
        notices.push({
          level: 'warn', id, code: 'orphaned',
          message: `overrides an ID upstream no longer has. It does nothing; delete it, or change kind to "new" to keep the entry.`,
        });
        continue;
      }
      if (entry.name !== undefined) {
        const was = names.get(id);
        if (was === entry.name) {
          notices.push({
            level: 'warn', id, code: 'redundant',
            message: `upstream now says "${was}" itself. The name override is a no-op; delete it.`,
          });
        } else {
          upstreamWas.set(id, was);
        }
        out.names.set(id, entry.name);
      }
    }

    if (entry.release !== undefined) {
      if (entry.release === null) out.releases.delete(id);
      else out.releases.set(id, entry.release);
    }
  }

  return { ...out, notices, authored, upstreamWas };
}

/** The pins the generator applies after deriving names. */
export function overlayPins(overlay = EMPTY_OVERLAY) {
  const seriesShort = {};
  const seriesFace = {};
  for (const [b, v] of Object.entries(overlay.series ?? {})) {
    if (v.short !== undefined) seriesShort[b] = v.short;
    if (v.face !== undefined) seriesFace[b] = v.face;
  }
  const fileNames = new Map();
  const shortNames = new Map();
  const paths = new Map();
  const notes = new Map();
  for (const [id, entry] of Object.entries(overlay.amiibos ?? {})) {
    if (entry.fileName !== undefined) fileNames.set(id, entry.fileName);
    if (entry.shortName !== undefined) shortNames.set(id, entry.shortName);
    if (entry.path !== undefined) paths.set(id, entry.path);
    if (entry.blurb !== undefined) notes.set(id, entry.blurb);
  }
  return { seriesShort, seriesFace, fileNames, shortNames, paths, notes };
}

/**
 * Categories, with members that no longer exist dropped and reported.
 * `note` is editorial and is deliberately not carried through.
 */
export function overlayCategories(overlay = EMPTY_OVERLAY, names = new Map()) {
  const categories = {};
  const notices = [];
  const sorted = Object.entries(overlay.categories ?? {}).sort((a, b) => {
    const byOrder = (a[1].order ?? 0) - (b[1].order ?? 0);
    return byOrder || a[1].label.localeCompare(b[1].label);
  });
  for (const [id, cat] of sorted) {
    const members = [];
    for (const m of cat.members ?? []) {
      if (names.size && !names.has(m)) {
        notices.push({
          level: 'warn', id: m, code: 'orphaned',
          message: `category "${id}" lists an ID that is not in the database; dropped.`,
        });
        continue;
      }
      members.push(m);
    }
    categories[id] = { label: cat.label, order: cat.order ?? 0, members };
  }
  return { categories, notices };
}

/** Stable, diff-friendly serialisation: sorted keys, two-space indent, newline. */
export function serializeOverlay(overlay) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v;
    if (!isPlainObject(v)) return v;
    return Object.fromEntries(
      Object.keys(v).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .map((k) => [k, sortKeys(v[k])])
    );
  };
  return `${JSON.stringify(sortKeys(overlay), null, 2)}\n`;
}

/** Parse and validate in one step. Throws with every problem listed. */
export function parseOverlay(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${OVERLAY_PATH} is not valid JSON: ${err.message}`);
  }
  const errors = validateOverlay(parsed);
  if (errors.length) {
    throw new Error(`${OVERLAY_PATH} is invalid:\n  ${errors.join('\n  ')}`);
  }
  return { ...EMPTY_OVERLAY, ...parsed };
}
