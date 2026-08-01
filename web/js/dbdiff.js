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
    excluded: parseIds(block(text, 'AMIIBO_EXCLUDED')),
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
  // An entry declined last time is offered again, because declining an addition
  // means "not this time" rather than "never". Without this the exclusion would
  // silence it forever: the candidate omits it too, so there would be no
  // difference to notice.
  for (const [id, name] of after.excluded) {
    if (before.names.has(id)) continue;   // it is published; nothing to offer
    push({
      key: `added:${id}`, group: 'added', subject: id, label: name,
      before: null, after: name, declinedBefore: true,
    });
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
    // KEEP is offered only where there is something to keep. A value upstream
    // has only just introduced has no previous version to hold on to, so the
    // choice is not between three answers but between taking it and taking it.
    // An addition can be declined now — it is held out by an exclusion and
    // offered again next time — so it has two real answers like everything
    // else. What still cannot be declined is a value with no previous version:
    // a brand-new series label has nothing to fall back to and the build
    // hard-fails without one.
    const holdable = c.group === 'added' || skipRecipe(c) !== null;
    c.choices = ['keep', ...(c.mine ? ['discard'] : []), ...(holdable ? ['skip'] : [])];
    // Nothing is required: anything left untouched is accepted, and the confirm
    // step says so. Asking a question whose only answer is "yes" is what made
    // the old screen block on a row nobody could act on.
    c.required = false;
  }

  const counts = { added: 0, removed: 0, renamed: 0, naming: 0, label: 0, release: 0 };
  for (const c of changes) counts[c.group]++;
  counts.total = changes.length;
  counts.danger = changes.filter((c) => c.danger).length;
  counts.orphans = orphans.length;

  const entities = groupByEntity(changes, { before, after, overlay });

  return { counts, changes, orphans, entities, summary: summarise(entities) };
}

// ---- entities: what a person is actually deciding about -------------------
//
// A change to a field is not a thing you decide about. An amiibo is. Upstream
// adding one produces a name, a release date and possibly a whole new series —
// three rows in the flat list, one event in the world. Listing them as peers is
// what made the review screen unreadable and its counts disagree: the summary
// counted rows per group while the blocking count was over something else.
//
// So the flat `changes` list stays (the apply path names changes by key), and
// this is the view a screen renders: one row per amiibo or series, with the
// fields it brings nested underneath.

const KIND_OF = { series: 'series', types: 'type' };

/** Which entity a flat change belongs to, and what it says about it. */
function entityOf(change) {
  switch (change.group) {
    case 'added':
      return { kind: 'amiibo', id: change.subject, op: 'add', field: 'name' };
    case 'removed':
      return { kind: 'amiibo', id: change.subject, op: 'remove', field: 'name' };
    case 'renamed':
      return { kind: 'amiibo', id: change.subject, op: 'edit', field: 'name' };
    case 'release':
      return { kind: 'amiibo', id: change.subject, op: 'edit', field: 'released' };
    case 'label':
      return { kind: KIND_OF[change.kind], id: String(change.subject), op: 'edit', field: 'name' };
    case 'naming':
      return change.kind === 'seriesFolder'
        ? { kind: 'series', id: String(change.subject), op: 'edit', field: 'folder' }
        : { kind: 'amiibo', id: change.subject, op: 'edit', field: change.kind };
    default:
      return null;
  }
}

function groupByEntity(changes, { before, after, overlay }) {
  const byKey = new Map();

  for (const change of changes) {
    const where = entityOf(change);
    if (!where) continue;
    const key = `${where.kind}:${where.id}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        kind: where.kind,
        id: where.id,
        op: where.op,
        label: '',
        fields: [],
        changeKeys: [],
        device: null,
        danger: false,
        // A change nobody can decline is shown as a consequence rather than as
        // a question. A brand-new series label is the case: the build hard-fails
        // on a series byte with no name, so "decline" would mean "refuse to
        // build" rather than "leave it as it was".
        decidable: true,
      });
    }
    const e = byKey.get(key);

    // add and remove outrank edit: an amiibo that arrives with a date is being
    // added, not edited.
    if (where.op !== 'edit') e.op = where.op;

    e.fields.push({
      field: where.field,
      published: change.before,
      yours: change.mine?.value ?? null,
      upstream: change.after,
    });
    e.changeKeys.push(change.key);
    if (change.danger) e.danger = true;
    if (change.device) e.device = change.device;
    if (!change.choices.includes('skip') && change.group !== 'added') e.decidable = false;
  }

  // Names, and the link between a new amiibo and the new series it needs.
  const newSeries = new Set(
    [...byKey.values()].filter((e) => e.kind === 'series' && e.op === 'edit'
      && e.fields.some((f) => f.field === 'name' && f.published === null))
      .map((e) => e.id));

  for (const e of byKey.values()) {
    if (e.kind === 'amiibo') {
      e.label = after.names.get(e.id) ?? before.names.get(e.id)
        ?? after.excluded.get(e.id) ?? e.id;
      const seriesByte = String(parseInt(e.id.slice(12, 14), 16));
      e.series = after.series.get(seriesByte) ?? before.series.get(seriesByte) ?? null;
      // Its series is new too, so the two decisions move together.
      if (newSeries.has(seriesByte)) e.needs = `series:${seriesByte}`;
    } else {
      const table = e.kind === 'series' ? 'series' : 'types';
      e.label = after[table].get(e.id) ?? before[table].get(e.id) ?? `0x${Number(e.id).toString(16)}`;
      // A series that exists only because upstream added amiibo in it is a
      // consequence of accepting them, not an independent question.
      if (newSeries.has(e.id)) {
        e.op = 'add';
        e.decidable = false;
      }
    }
    // An overlay entry means one of the values on offer is yours.
    e.mine = e.fields.some((f) => f.yours !== null);
  }

  const order = { amiibo: 2, series: 0, type: 1 };
  return [...byKey.values()].sort((a, b) =>
    order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
}

/**
 * The headline, in the shape Terraform uses: named counts, zeros intact, over
 * ENTITIES rather than fields — so the number in the summary is the number of
 * rows on screen, and the two cannot disagree.
 */
function summarise(entities) {
  const of = (kind, op) => entities.filter((e) => e.kind === kind && e.op === op).length;
  return {
    amiibo: { add: of('amiibo', 'add'), edit: of('amiibo', 'edit'), remove: of('amiibo', 'remove') },
    series: { add: of('series', 'add'), edit: of('series', 'edit'), remove: of('series', 'remove') },
    type: { add: of('type', 'add'), edit: of('type', 'edit'), remove: of('type', 'remove') },
    // The two facts that decide whether this update deserves attention.
    yours: entities.filter((e) => e.mine).length,
    device: entities.filter((e) => e.device).length,
    total: entities.length,
  };
}

// ---- turning decisions into an overlay -----------------------------------

/**
 * What SKIP has to pin to hold a change back, or null if nothing can.
 *
 * SKIP means "the app keeps showing what it shows today", so it writes the
 * BEFORE value — the one currently published — as an override.
 */
function skipRecipe(change) {
  // Nothing to hold. A brand-new series label, or a release date upstream has
  // only just published, had no previous value — "keep what the site shows
  // today" would mean pinning nothing, and pinning null fails validation.
  // Release is the exception: null there is meaningful, it means no date.
  if (change.before === null && change.group !== 'release') return null;

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
    excluded: [...(overlay.excluded ?? [])],
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

  // Walked over the CHANGES rather than the decisions, because a change nobody
  // touched is accepted — and accepting has work to do when a previous decline
  // is still holding an entry out. Reading only the decisions left such an
  // entry excluded for good, turning "not this time" into "never" by silence.
  // Keys naming no change are still honoured as a no-op, as before.
  const answered = new Map(diff.changes.map((c) => [c.key, decisions[c.key] ?? 'keep']));
  for (const [key, verdict] of answered) {
    const change = byKey.get(key);
    if (!change) continue;

    if (verdict === 'keep') {
      // Free, except where a previous decline is still holding the entry out:
      // accepting it has to lift that, or nothing happens.
      if (change.group === 'added' && (next.excluded ?? []).includes(String(change.subject))) {
        next.excluded = next.excluded.filter((id) => id !== String(change.subject));
      }
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
      // Declining an addition is the one case with nowhere to pin: the entry
      // comes from the sources, so keeping it out needs an exclusion. It is
      // re-offered on the next update, which is what "not this time" means.
      if (change.group === 'added') {
        const list = new Set(next.excluded ?? []);
        list.add(String(change.subject));
        next.excluded = [...list].sort();
        applied.skipped++;
        continue;
      }
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
