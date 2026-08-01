// What an upstream refresh would change, and what to do about it.
//
// The database is generated from scratch on every run, so upstream is never
// "merged" — it is re-derived, and the overlay is re-applied on top. That makes
// the interesting question not "what changed" but "what happens to my
// corrections when it does".
//
// Three answers, per amiibo or applied to a whole group:
//
//   KEEP     take the new upstream values; my overrides sit on top as always.
//            Writes nothing — it is what already happens.
//   DISCARD  take upstream and drop my overrides for this entry.
//   SKIP     freeze what the app shows today, whatever upstream now says.
//            Pins the current effective value.
//
// The useful property is that the safe answer is free: KEEP writes nothing at
// all, because re-applying the overlay is what the build already does. Only
// SKIP grows the overlay, and it grows it with exactly the pins needed to hold
// the line.
//
// Diffing is done on GENERATED TEXT against GENERATED TEXT — the file on disk
// against the candidate the generator just produced. Re-deriving the "after"
// side independently would duplicate the pin application and delta
// normalisation inside the generator, and drift there is invisible until two
// amiibo land on one device path.
//
// Pure and DOM-free: the CLI, the admin server and the admin UI all import it.

import { REFERENCE_ROOT } from './overlay.js';

/** One `export const NAME = Object.freeze({...})` block, or '' if absent. */
function block(text, name) {
  return text?.split(`${name} = Object.freeze({`)[1]?.split('});')[0] ?? '';
}

/**
 * `'<16 hex>': <value>` pairs.
 *
 * Both quote styles. The generator emits names with double quotes and release
 * dates with single ones, and a parser that only knew about double quotes read
 * every release table as empty — silently, so the CLI has been reporting no
 * date changes at all rather than none happening.
 */
function parseIds(text) {
  const out = new Map();
  for (const m of text.matchAll(/'([0-9a-f]{16})':\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) {
    out.set(m[1], m[2] !== undefined ? JSON.parse(`"${m[2]}"`) : m[3]);
  }
  return out;
}

/** `<byte>: <value>` pairs, keyed by the number as a string. */
function parseBytes(text) {
  const out = new Map();
  for (const m of text.matchAll(/(\d+):\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) {
    out.set(m[1], m[2] !== undefined ? JSON.parse(`"${m[2]}"`) : m[3]);
  }
  return out;
}

/** A generated database, read back into maps. */
export function parseGenerated(text) {
  return {
    names: parseIds(block(text, 'AMIIBO_NAMES')),
    releases: parseIds(block(text, 'AMIIBO_RELEASE')),
    series: parseBytes(block(text, 'AMIIBO_SERIES')),
    types: parseBytes(block(text, 'AMIIBO_TYPES')),
    seriesShort: parseBytes(block(text, 'AMIIBO_SERIES_SHORT')),
    fileNames: parseIds(block(text, 'AMIIBO_FILE_NAMES')),
    shortNames: parseIds(block(text, 'AMIIBO_SHORT_NAMES')),
    upstream: parseIds(block(text, 'AMIIBO_UPSTREAM')),
  };
}

// ---- effective values ----------------------------------------------------
//
// The delta tables carry only what differs from the display name, so a raw
// key-wise diff of them says the wrong thing twice: a row APPEARING for an ID
// that already existed is a device-side rename (the file was named by
// AMIIBO_NAMES and now gets a disambiguating suffix), and a row DISAPPEARING is
// a rename back. Both read as "new filename" if you only compare keys.
//
// So churn is computed on what a file is actually called, over the IDs present
// on both sides.

const effectiveFile = (db, id) => db.fileNames.get(id) ?? db.names.get(id) ?? null;
const effectiveShort = (db, id) => db.shortNames.get(id) ?? effectiveFile(db, id);
const effectiveFolder = (db, byte) => db.seriesShort.get(byte) ?? db.series.get(byte) ?? null;

const NAMING = [
  { kind: 'fileName', label: 'filename', of: effectiveFile },
  {
    kind: 'shortName',
    label: 'abbreviated name',
    of: effectiveShort,
    // The abbreviated name falls back to the filename, so a filename change
    // drags it along. Reporting both would be two rows for one physical
    // rename. It is only its own change when the delta table has an entry for
    // the ID on one side or the other.
    independent: (before, after, id) => before.shortNames.has(id) || after.shortNames.has(id),
  },
];

/**
 * Every reviewable difference between two generated databases.
 *
 * @param {string} beforeText  the database currently on disk
 * @param {string} afterText   the candidate the generator just produced
 * @param {object} [opts]
 * @param {object} [opts.overlay]  to say which changes you have an edit on
 * @returns {{ counts: object, changes: Change[], orphans: object[] }}
 */
export function diffDatabases(beforeText, afterText, { overlay = null } = {}) {
  const before = parseGenerated(beforeText);
  const after = parseGenerated(afterText);
  const amiibos = overlay?.amiibos ?? {};
  const seriesOverrides = overlay?.series ?? {};

  const changes = [];
  const push = (c) => changes.push({ danger: false, mine: null, ...c });

  // ---- entries appearing and disappearing -------------------------------
  for (const [id, name] of after.names) {
    if (!before.names.has(id)) {
      push({
        key: `added:${id}`, group: 'added', subject: id, label: name,
        before: null, after: name,
      });
    }
  }
  for (const [id, name] of before.names) {
    if (!after.names.has(id)) {
      push({
        key: `removed:${id}`, group: 'removed', subject: id, label: name,
        before: name, after: null, danger: true,
        mine: amiibos[id] ? { ...amiibos[id] } : null,
      });
    }
  }

  // ---- a name upstream changed ------------------------------------------
  for (const [id, name] of after.names) {
    const was = before.names.get(id);
    if (was === undefined || was === name) continue;
    push({
      key: `renamed:${id}`, group: 'renamed', subject: id, label: name,
      before: was, after: name,
      mine: amiibos[id]?.name !== undefined ? { field: 'name', value: amiibos[id].name } : null,
    });
  }

  // ---- release dates -----------------------------------------------------
  for (const id of new Set([...before.releases.keys(), ...after.releases.keys()])) {
    if (!after.names.has(id) && !before.names.has(id)) continue;
    const was = before.releases.get(id) ?? null;
    const now = after.releases.get(id) ?? null;
    if (was === now) continue;
    push({
      key: `release:${id}`, group: 'release', subject: id,
      label: after.names.get(id) ?? before.names.get(id) ?? id,
      before: was, after: now,
      mine: amiibos[id]?.release !== undefined ? { field: 'release', value: amiibos[id].release } : null,
    });
  }

  // ---- series and type labels -------------------------------------------
  for (const [table, group] of [['series', 'label'], ['types', 'label']]) {
    for (const byte of new Set([...before[table].keys(), ...after[table].keys()])) {
      const was = before[table].get(byte) ?? null;
      const now = after[table].get(byte) ?? null;
      if (was === now || now === null) continue;
      push({
        key: `${table}Label:${byte}`, group, kind: table, subject: byte,
        label: now, before: was, after: now,
        mine: table === 'series' && seriesOverrides[byte]?.label !== undefined
          ? { field: 'label', value: seriesOverrides[byte].label } : null,
      });
    }
  }

  // ---- naming churn: what moves on the device ---------------------------
  for (const byte of new Set([...before.series.keys(), ...after.series.keys()])) {
    if (!before.series.has(byte) || !after.series.has(byte)) continue;
    const was = effectiveFolder(before, byte);
    const now = effectiveFolder(after, byte);
    if (!was || !now || was === now) continue;
    push({
      key: `naming:seriesFolder:${byte}`, group: 'naming', kind: 'seriesFolder',
      subject: byte, label: after.series.get(byte),
      before: was, after: now, danger: true,
      device: { before: `${REFERENCE_ROOT}/${was}/`, after: `${REFERENCE_ROOT}/${now}/` },
      mine: seriesOverrides[byte]?.short !== undefined
        ? { field: 'short', value: seriesOverrides[byte].short } : null,
    });
  }

  for (const { kind, label, of, independent } of NAMING) {
    for (const id of after.names.keys()) {
      if (!before.names.has(id)) continue;   // a new amiibo is not a rename
      const was = of(before, id);
      const now = of(after, id);
      if (!was || !now || was === now) continue;
      if (independent && !independent(before, after, id)) continue;
      const folder = effectiveFolder(after, String(parseInt(id.slice(12, 14), 16)));
      push({
        key: `naming:${kind}:${id}`, group: 'naming', kind,
        subject: id, label: `${after.names.get(id)} (${label})`,
        before: was, after: now, danger: true,
        device: folder
          ? { before: `${REFERENCE_ROOT}/${folder}/${was}.bin`,
            after: `${REFERENCE_ROOT}/${folder}/${now}.bin` }
          : null,
        mine: amiibos[id]?.[kind] !== undefined
          ? { field: kind, value: amiibos[id][kind] } : null,
      });
    }
  }

  // ---- overlay entries left pointing at nothing -------------------------
  const orphans = [];
  for (const [id, entry] of Object.entries(amiibos)) {
    if (entry.kind === 'new') continue;
    if (!after.names.has(id)) {
      orphans.push({ id, kind: 'amiibo', why: 'upstream no longer has this ID' });
    }
  }
  for (const [catId, cat] of Object.entries(overlay?.categories ?? {})) {
    for (const m of cat.members ?? []) {
      if (!after.names.has(m)) {
        orphans.push({ id: m, kind: 'category', why: `category "${catId}" lists an ID upstream dropped` });
      }
    }
  }

  // Which of the three answers each change can actually offer. DISCARD only
  // means something where there is an edit of mine to discard.
  for (const c of changes) {
    c.choices = c.group === 'added'
      ? ['keep']
      : c.mine ? ['keep', 'discard', 'skip'] : ['keep', 'skip'];
    c.required = c.group !== 'added';
  }

  const counts = { added: 0, removed: 0, renamed: 0, naming: 0, label: 0, release: 0 };
  for (const c of changes) counts[c.group]++;
  counts.total = changes.length;
  counts.danger = changes.filter((c) => c.danger).length;
  counts.orphans = orphans.length;

  return { counts, changes, orphans };
}

// ---- turning decisions into an overlay -----------------------------------

/**
 * What SKIP has to pin to hold a change back, or null if nothing can.
 *
 * SKIP means "the app keeps showing what it shows today", so it writes the
 * BEFORE value — the one currently published — as an override.
 */
function skipRecipe(change) {
  switch (change.group) {
    case 'renamed':
      return { scope: 'amiibo', field: 'name', value: change.before };
    case 'release':
      return { scope: 'amiibo', field: 'release', value: change.before };
    case 'removed':
      // Upstream dropped it; keeping it means authoring it.
      return { scope: 'amiibo', field: 'kind', value: 'new', name: change.before };
    case 'naming':
      return change.kind === 'seriesFolder'
        ? { scope: 'series', field: 'short', value: change.before }
        : { scope: 'amiibo', field: change.kind, value: change.before };
    case 'label':
      return change.kind === 'series'
        ? { scope: 'series', field: 'label', value: change.before }
        : null;   // type labels are not overridable per-byte in the UI yet
    default:
      return null;
  }
}

/**
 * Apply a set of decisions to an overlay, returning a new one.
 *
 * The input is never mutated. Decisions naming a key the diff does not have are
 * ignored rather than guessed at — apply re-derives the diff server-side and
 * checks the keys separately, so a stale one is a refusal, not a silent write.
 *
 * @param {object} overlay
 * @param {object} diff       from diffDatabases
 * @param {object} decisions  key -> 'keep' | 'discard' | 'skip'
 * @param {string} [today]    ISO date recorded on a pin; omitted if absent
 * @returns {{ overlay: object, applied: object }}
 */
export function applyDecisions(overlay, diff, decisions, today = null) {
  const next = {
    ...overlay,
    series: { ...(overlay.series ?? {}) },
    types: { ...(overlay.types ?? {}) },
    categories: { ...(overlay.categories ?? {}) },
    amiibos: { ...(overlay.amiibos ?? {}) },
  };
  const applied = { kept: 0, discarded: 0, skipped: 0, pinsWritten: 0, pinsDropped: 0 };
  const byKey = new Map(diff.changes.map((c) => [c.key, c]));

  const entryFor = (table, subject) => {
    next[table] = { ...next[table], [subject]: { ...(next[table][subject] ?? {}) } };
    return next[table][subject];
  };
  const dropIfEmpty = (table, subject) => {
    const e = next[table][subject];
    const meaningful = Object.keys(e).filter((k) => k !== 'kind' && k !== 'upstreamWas' && k !== 'decidedAt');
    if (meaningful.length === 0 && e.kind !== 'new') {
      const copy = { ...next[table] };
      delete copy[subject];
      next[table] = copy;
    }
  };

  for (const [key, verdict] of Object.entries(decisions)) {
    const change = byKey.get(key);
    if (!change) continue;

    if (verdict === 'keep') {
      // The default, and free: re-applying the overlay is what the build does.
      applied.kept++;
      continue;
    }

    if (verdict === 'discard') {
      if (!change.mine) continue;
      const table = change.group === 'naming' && change.kind === 'seriesFolder' ? 'series'
        : change.group === 'label' ? 'series' : 'amiibos';
      const subject = String(change.subject);
      if (!next[table][subject]) continue;
      const entry = entryFor(table, subject);
      delete entry[change.mine.field];
      delete entry.upstreamWas?.[change.mine.field];
      if (entry.upstreamWas && Object.keys(entry.upstreamWas).length === 0) delete entry.upstreamWas;
      dropIfEmpty(table, subject);
      applied.discarded++;
      applied.pinsDropped++;
      continue;
    }

    if (verdict === 'skip') {
      const recipe = skipRecipe(change);
      if (!recipe) continue;
      const table = recipe.scope === 'series' ? 'series' : 'amiibos';
      const subject = String(change.subject);
      const entry = entryFor(table, subject);

      if (recipe.field === 'kind') {
        entry.kind = 'new';
        entry.name = recipe.name;
      } else {
        if (table === 'amiibos' && !entry.kind) entry.kind = 'override';
        entry[recipe.field] = recipe.value;
        // What upstream said when the line was drawn, so a later refresh can
        // tell a pin still holding from one upstream has come round to.
        entry.upstreamWas = { ...(entry.upstreamWas ?? {}), [recipe.field]: change.after };
      }
      if (today) entry.decidedAt = today;
      applied.skipped++;
      applied.pinsWritten++;
    }
  }

  return { overlay: next, applied };
}

/**
 * A decision for every change in a scope.
 *
 * `safe` deliberately leaves the dangerous groups undecided: the only way to
 * accept a device-wide rename or a removal is to look at it.
 */
export function bulkDecide(diff, scope, verdict = 'keep') {
  const out = {};
  for (const c of diff.changes) {
    if (scope === 'safe') {
      if (c.danger) continue;
      out[c.key] = 'keep';
    } else if (scope === 'all' || c.group === scope) {
      out[c.key] = verdict;
    }
  }
  return out;
}

/** Changes still without a verdict. Apply refuses while any remain. */
export function undecided(diff, decisions) {
  return diff.changes.filter((c) => c.required && !decisions[c.key]).map((c) => c.key);
}
