// The admin UI.
//
// Everything it knows comes from the API, and every URL it uses is relative, so
// this file never learns the hostname it is served from and the address cannot
// leak into the repository through it.
//
// The row list follows the contract collectionui.js documents and relies on: the
// DOM is built once, and searching only toggles [hidden] on prebuilt rows.
// Rebuilding 946 rows per keystroke is the obvious way to write this and it is
// the wrong one.

// The site's own mascot, icon set and collection grid, served from the public
// site so there is one copy of each rather than a second that drifts.
// Root-relative, so the admin still never names the host it is reachable at.
import { pirateMark } from '/js/sprite.js';
import { ICONS } from '/js/icons.js';
import { buildCollection, seriesRepresentative, describeAmiibo, isHhdItemCards } from '/js/amiibo.js';
import { AMIIBO_RELEASE } from '/data/amiibo-db.js';
import { sortSeries, seriesDate } from '/js/collectionview.js';
import { buildSeriesGrid, applyGridFilter, reorderGroups } from '/js/collectiongrid.js';
import { validateAmiiboEntry } from '/js/overlay.js';
import { confirmDialog } from '/js/dialog.js';
import { mountHeader, mountFooter, currentPirate } from '/js/chrome.js';
import { makeArt, dropBrokenArt } from '/js/artwork.js';
import { buildAmiiboDetail } from '/js/amiibopanel.js';

const el = (id) => document.getElementById(id);

/**
 * The admin's own bar, built by the site's builder.
 *
 * No nav yet — the array is empty rather than absent, so adding entries later
 * is one literal. No brand href either: a link would point at the public site,
 * and the admin deliberately links nowhere. The settings popover keeps only the
 * two preferences that mean anything here; Advanced gates nothing in the admin,
 * the HHD toggle is a collection-page concern, and DEBUG points at a page this
 * host does not serve.
 */
function mountChrome() {
  const actions = el('adminActions');
  actions.hidden = false;
  mountHeader({
    brand: { href: null, wordmark: 'ALLMIIBO', suffix: '-ADMIN', markSize: 30 },
    nav: [],
    settings: { theme: true, pirate: true, advanced: false, hhd: false, debug: null },
    extra: actions,
    host: el('app'),
  });
  mountFooter({ attrib: 'Curated data is served from this machine. The public site is a static copy.' });
}

function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-ico]')) {
    node.innerHTML = ICONS[node.dataset.ico] ?? '';
  }
}

const state = {
  csrf: null,
  db: null,
  overlay: null,
  collection: null,
  rows: [],           // the grid's flat index: { el, groupEl, item, group, text }
  groupEls: new Map(),
  selected: null,
  dirty: false,
  fields: new Map(),  // the open editor's field key -> its .field wrapper
  preview: null,      // the open editor's previewed parts, updated in place
  bad: new Set(),     // ids whose entry would not validate; SAVE waits on this
};

// What a CMS filters by. Not the collection page's owned/missing, which mean
// nothing here: there is no folder and no device, only what has been curated.
const FILTERS = [
  { value: 'all', label: 'ALL' },
  { value: 'curated', label: 'CURATED' },
  { value: 'authored', label: 'AUTHORED' },
];

let filter = 'all';

// ---- talking to the server ---------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(method === 'GET' ? {} : { 'x-csrf-token': state.csrf ?? '' }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON, e.g. the export */ }
  if (!res.ok) {
    const err = new Error(parsed?.error ?? `HTTP ${res.status}`);
    err.details = parsed?.details ?? [];
    err.status = res.status;
    throw err;
  }
  return parsed;
}

/**
 * Save a file the server hands back.
 *
 * Not `location.href = '/api/…'`, which was the bug: that navigates, bypassing
 * the api() wrapper, so an expired session downloaded the 401 error body under
 * the filename of a backup — a corrupt file you would not discover until you
 * needed it. Fetching first means a failure is a message, not a file.
 */
async function download(path, filename) {
  try {
    const res = await fetch(`/api${path}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* not JSON */ }
      throw new Error(parsed?.error ?? `HTTP ${res.status}`);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    say(`Downloaded ${filename}.`, 'ok');
  } catch (err) {
    say(`Download failed: ${err.message}`, 'err');
  }
}

function say(message, kind = '') {
  const box = el('status');
  box.hidden = !message;
  box.className = `status ${kind}`;
  box.textContent = message;
}

// ---- login --------------------------------------------------------------

async function signIn() {
  const box = el('loginStatus');
  const password = el('pw').value;
  if (!password) return;
  el('signIn').disabled = true;
  try {
    const { csrf } = await api('/login', { method: 'POST', body: { password } });
    state.csrf = csrf;
    el('pw').value = '';
    box.hidden = true;
    await boot();
  } catch (err) {
    box.hidden = false;
    box.className = 'status err';
    box.textContent = err.status === 429
      ? 'Too many attempts. Wait a few minutes.'
      : 'Wrong password.';
  } finally {
    el('signIn').disabled = false;
  }
}

async function signOut() {
  // The overlay only exists in this tab until it is saved, so signing out with
  // edits pending throws them away.
  if (state.dirty) {
    const ok = await confirmDialog({
      title: 'SIGN OUT WITH UNSAVED EDITS?',
      body: 'Your edits are only in this tab. Signing out loses them.',
      confirmLabel: 'DISCARD & SIGN OUT',
      danger: true,
    });
    if (!ok) return;
  }
  await api('/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

// ---- loading ------------------------------------------------------------

async function boot() {
  const [db, overlayRes] = await Promise.all([api('/db'), api('/overlay')]);
  state.db = db;
  state.overlay = normalise(overlayRes.overlay);
  el('login').hidden = true;
  el('app').hidden = false;
  mountChrome();
  hydrateIcons();
  buildRows();
  applyFilter();
  markClean();
  loadBackups();
  if (!overlayRes.upstreamReady) {
    say('The upstream sources have not been fetched yet, so saving cannot rebuild the site.', 'warn');
  }
}

/** Every optional container present, so the editor never has to check. */
function normalise(overlay) {
  return {
    schema: 1,
    series: {}, types: {}, categories: {},
    ...overlay,
    amiibos: { ...(overlay?.amiibos ?? {}) },
  };
}

// ---- the list -----------------------------------------------------------
//
// The same grid the collection page draws, from the same module. Only the cell
// differs: there it says whether you hold a dump, here it says whether the entry
// has been curated.

const artUrl = makeArt('/data/images');

/** The effective name: what a visitor will see once this overlay is published. */
function effectiveName(id, fallback) {
  return state.overlay.amiibos[id]?.name ?? fallback;
}

function sortedSeries() {
  return sortSeries(state.collection.series, el('sortMode').value, AMIIBO_RELEASE);
}

/**
 * One definition of what a row is searchable by, used when the grid is built
 * and again whenever a name changes. Two copies of this drifted once already:
 * the rebuilt one lower-cased only half of itself, so a curated name stopped
 * matching anything typed in lower case.
 */
function searchTextFor(item, group) {
  return [effectiveName(item.id, item.name), item.name, group.seriesName, item.id]
    .join(' ').toLowerCase();
}

function buildRows() {
  // Nothing is owned and no device exists, so every entry is drawn the same way
  // and the grouping is purely the database's.
  state.collection = buildCollection(new Set(), null, {});

  const { frag, rows, groupEls } = buildSeriesGrid(sortedSeries(), {
    cell: makeCell,
    pill: makeSeriesPill,
    art: (g) => artUrl(seriesRepresentative(g.series) ?? g.items[0].id),
    year: (g) => seriesDate(g, AMIIBO_RELEASE)?.slice(0, 4) ?? null,
    isOpen: () => false,
    chevron: ICONS.chevronRight,
    searchText: searchTextFor,
  });
  state.rows = rows;
  state.groupEls = groupEls;

  el('series').textContent = '';
  el('series').append(frag);
  // Now that every cell is indexed, mark the curated ones. Only those: walking
  // all ~950 to clear a mark none of them has would be work for nothing.
  for (const id of Object.keys(state.overlay.amiibos)) markCell(id);
  renderFilters();
  updateStats();
}

function makeCell(item) {
  // A button, not the collection page's link: clicking here opens the editor
  // beside the grid rather than navigating away from unsaved edits.
  const cell = document.createElement('button');
  cell.type = 'button';
  cell.setAttribute('aria-pressed', 'false');
  cell.className = 'item';
  cell.dataset.id = item.id;

  const art = document.createElement('span');
  art.className = 'art';
  art.dataset.initial = (item.name[0] ?? '?').toUpperCase();
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.src = artUrl(item.id);
  art.append(img);

  const nmWrap = document.createElement('span');
  nmWrap.className = 'nmWrap';
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = effectiveName(item.id, item.name);
  nmWrap.append(nm);

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.hidden = true;

  cell.append(art, nmWrap, tag);
  cell.addEventListener('click', () => select(item.id));
  // The mark is applied after the grid exists, not here: markCell works through
  // state.rows, and this cell is not in it until buildSeriesGrid returns.
  return cell;
}

/** One pill per series: how many of its entries have been curated. */
function makeSeriesPill(group) {
  const curated = group.items.filter((i) => state.overlay.amiibos[i.id]).length;
  const pill = document.createElement('span');
  pill.className = `sPill${curated === group.items.length ? ' done' : curated ? ' part' : ''}`;
  pill.dataset.series = String(group.series);
  pill.innerHTML = `<b>${curated}/${group.items.length}</b>`;
  pill.title = `${curated} of ${group.items.length} curated`;
  return pill;
}

/** Redraw one cell's name and mark after an edit, without rebuilding the grid. */
function markCell(id) {
  const row = state.rows.find((r) => r.item.id === id);
  if (!row) return;
  const entry = state.overlay.amiibos[id];
  const authored = entry?.kind === 'new';

  row.el.querySelector('.nm').textContent = effectiveName(id, row.item.name);

  const tag = row.el.querySelector('.tag');
  tag.hidden = !entry;
  tag.textContent = authored ? 'AUTHORED' : 'CURATED';
  tag.className = `tag ${authored ? 'authored' : 'curated'}`;
  tag.title = authored ? 'Added here, not upstream' : 'Edited here';

  // The row's own haystack has to follow the name, or searching for what is on
  // screen stops finding it. Both names are kept: a rename must not lose the
  // amiibo for anyone searching the name it actually shipped under.
  row.text = searchTextFor(row.item, row.group);

  const pill = el('series').querySelector(`.sPill[data-series="${row.group.series}"]`);
  if (pill) pill.replaceWith(makeSeriesPill(row.group));
}

function renderFilters() {
  const counts = {
    all: state.rows.length,
    curated: state.rows.filter((r) => state.overlay.amiibos[r.item.id]).length,
    authored: state.rows.filter(
      (r) => state.overlay.amiibos[r.item.id]?.kind === 'new').length,
  };
  el('filters').innerHTML = FILTERS.map((f) =>
    `<label class="pill${counts[f.value] === 0 && f.value !== 'all' ? ' zero' : ''}">` +
    `<input type="radio" name="filter" value="${f.value}"${f.value === filter ? ' checked' : ''}>` +
    `<span class="lbl">${f.label}</span><span class="n">${counts[f.value]}</span></label>`
  ).join('');
  for (const input of el('filters').querySelectorAll('input')) {
    input.addEventListener('change', () => { filter = input.value; applyFilter(); });
  }
}

/** The admin's filter predicate, in the shape applyGridFilter expects. */
function keep(item, text, { filter: mode, query }) {
  const entry = state.overlay.amiibos[item.id];
  if (mode === 'curated' && !entry) return false;
  if (mode === 'authored' && entry?.kind !== 'new') return false;
  if (query && !text.includes(query)) return false;
  return true;
}

function applyFilter() {
  if (!state.collection) return;
  const query = el('q').value.trim().toLowerCase();
  el('qClear').hidden = !query;

  const { shown } = applyGridFilter({
    rows: state.rows,
    groupEls: state.groupEls,
    root: el('series'),
    keep,
    filter,
    query,
  });

  el('emptyState').hidden = shown > 0;
  if (!shown) {
    el('emptyState').innerHTML =
      '<div class="empty"><div class="eTitle">NO AMIIBO MATCH</div>' +
      '<button id="clearFilters">CLEAR FILTERS</button></div>';
    el('clearFilters').addEventListener('click', () => {
      el('q').value = '';
      filter = 'all';
      renderFilters();
      applyFilter();
    });
  }
}

function updateStats() {
  el('statTotal').textContent = String(state.rows.length);
  const curated = Object.keys(state.overlay.amiibos).length;
  el('statEdited').textContent = String(curated);
  el('tileEdited').classList.toggle('ok', curated > 0);
}

// ---- backups ------------------------------------------------------------

/**
 * The timestamped copies, newest first.
 *
 * Every save takes one before it writes, so the list is also the undo history.
 * Loaded on boot rather than on open: the count in the summary is the point of
 * the collapsed drawer.
 */
async function loadBackups() {
  const list = el('backupList');
  let names = [];
  try {
    ({ backups: names } = await api('/backups'));
  } catch (err) {
    el('backupCount').textContent = '—';
    list.innerHTML = '';
    list.append(liText(`Could not list backups: ${err.message}`));
    return;
  }

  el('backupCount').textContent = String(names.length);
  list.textContent = '';
  if (!names.length) {
    list.append(liText('No backups yet. The first save will leave one.'));
    return;
  }

  for (const name of names) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = readableStamp(name);
    label.title = name;

    const acts = document.createElement('span');
    acts.className = 'acts';

    const get = document.createElement('button');
    get.type = 'button';
    get.textContent = 'DOWNLOAD';
    get.addEventListener('click', () => download(`/backups/${name}`, name));

    const put = document.createElement('button');
    put.type = 'button';
    put.textContent = 'RESTORE';
    put.addEventListener('click', () => restore(name));

    acts.append(get, put);
    li.append(label, acts);
    list.append(li);
  }
}

function liText(text) {
  const li = document.createElement('li');
  li.append(Object.assign(document.createElement('span'), { textContent: text }));
  return li;
}

/** `2026-07-31T12-34-56-789Z.json` back into something a person reads. */
function readableStamp(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name;
}

async function restore(name) {
  // Restoring over unsaved edits would lose them silently, and the confirm
  // below is about the backup, not about the edits — so they are asked
  // separately rather than buried in one dialog.
  if (state.dirty) {
    const discard = await confirmDialog({
      title: 'DISCARD YOUR UNSAVED EDITS?',
      body: 'Restoring replaces the overlay, including the edits you have not saved.',
      confirmLabel: 'DISCARD THEM',
      danger: true,
    });
    if (!discard) return;
  }

  const ok = await confirmDialog({
    title: 'RESTORE THIS BACKUP?',
    body: 'The overlay is replaced with this version and the site is rebuilt.',
    detail: [
      readableStamp(name),
      'What is there now is backed up first, so this can be undone.',
    ],
    confirmLabel: 'RESTORE',
    icon: 'back',
  });
  if (!ok) return;

  say('Restoring and rebuilding the site…');
  try {
    const result = await api('/restore', { method: 'POST', body: { name } });
    say(`Restored ${readableStamp(name)}. The site now has ${result.entries} amiibo.`, 'ok');
    // The overlay on the server is now something else entirely, so the whole
    // view is reloaded rather than patched.
    state.dirty = false;
    await boot();
  } catch (err) {
    say([err.message, ...(err.details ?? [])].join(' · '), 'err');
  }
}

// ---- the editor ---------------------------------------------------------

// Which field each previewed part is edited by. The pencil on a part focuses
// that input; parts not listed get no pencil.
const PREVIEW_FIELD = { title: 'name', subtitle: 'release', portrait: null, id: null };

const FIELDS = [
  { key: 'name', label: 'NAME', upstream: (id) => state.db.names[id] },
  { key: 'release', label: 'RELEASE (YYYY-MM-DD)', upstream: (id) => state.db.release[id] },
  { key: 'fileName', label: 'FILENAME ON THE DEVICE', upstream: (id) => state.db.fileNames[id] ?? state.db.names[id] },
  { key: 'shortName', label: 'ABBREVIATED FILENAME', upstream: (id) => state.db.shortNames[id] ?? '' },
  { key: 'path', label: 'PINNED PATH', upstream: () => '' },
  { key: 'blurb', label: 'NOTE (SHOWN IN THE APP)', upstream: () => '' },
];

function select(id) {
  state.selected = id;
  // aria-pressed rather than a class: the cell is a button, so its selected
  // state is a real state a screen reader can report, and style and semantics
  // cannot drift apart.
  for (const r of state.rows) {
    r.el.setAttribute('aria-pressed', String(r.item.id === id));
  }
  renderEditor();
}

function renderEditor() {
  const id = state.selected;
  const box = el('editor');
  if (!id) {
    box.innerHTML = '<div class="empty"><div class="eTitle">NOTHING SELECTED</div>' +
      '<p>Pick an amiibo from the list to edit it.</p></div>';
    return;
  }

  const entry = state.overlay.amiibos[id] ?? {};
  box.textContent = '';

  const cap = document.createElement('h2');
  cap.className = 'cap';
  cap.textContent = 'EDITING';
  box.append(cap);

  // The same panel a visitor sees, from the same module, showing the effective
  // values — what the site will say once this overlay is published. Read-only
  // on purpose: making it editable in place would fork the renderer into two
  // modes and bring paste and newline handling on an <h1> with it.
  //
  // Sections are trimmed to what a 24rem side panel can carry: no file list
  // (there is no scan here) and no 91 card tiles.
  const detail = buildAmiiboDetail(id, {
    art: artUrl,
    vehicleArt: artUrl.vehicle,
    ownership: null,
    sections: ['portrait', 'title', 'badges', 'id'],
    onCopy: async (value) => {
      try { await navigator.clipboard.writeText(value); say('ID copied', 'ok'); }
      catch { say("Couldn't copy — the clipboard is blocked here.", 'err'); }
    },
    // A pencil per previewed part, focusing the field that changes it. One
    // hook, rather than a second renderer that knows about editing.
    adorn: (part, node) => {
      const field = PREVIEW_FIELD[part];
      if (!field) return;
      const pencil = document.createElement('button');
      pencil.type = 'button';
      pencil.className = 'editPart';
      pencil.title = `Edit ${field}`;
      pencil.innerHTML = ICONS.cog ?? '';
      pencil.addEventListener('click', () => el(`f-${field}`)?.focus());
      node.append(pencil);
    },
  });

  const preview = document.createElement('div');
  preview.className = 'preview';
  preview.append(detail.frag);
  box.append(preview);

  // Kept so an edit can update the preview in place. Re-rendering the editor
  // on every keystroke would be simpler and wrong: it would replace the input
  // being typed into and take the caret with it.
  state.preview = detail.parts;
  refreshPreview(id);

  state.fields = new Map();
  for (const field of FIELDS) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const inputId = `f-${field.key}`;

    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = field.label;
    const input = document.createElement('input');
    input.id = inputId;
    input.type = 'text';
    input.value = entry[field.key] ?? '';
    const was = document.createElement('div');
    was.className = 'was';
    const upstream = field.upstream(id) ?? '';
    was.textContent = upstream ? `upstream: ${upstream}` : '';
    const why = document.createElement('div');
    why.className = 'why';
    why.hidden = true;

    wrap.append(label, input, was, why);
    input.addEventListener('input', () => edit(id, field.key, input.value));
    box.append(wrap);
    state.fields.set(field.key, wrap);
  }
  showProblems(id);

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.marginTop = '.8rem';
  const revert = document.createElement('button');
  revert.textContent = 'REVERT THIS AMIIBO';
  revert.disabled = !state.overlay.amiibos[id];
  revert.addEventListener('click', () => {
    delete state.overlay.amiibos[id];
    markDirty();
    renderEditor();
    markCell(id);
    renderFilters();
  });
  actions.append(revert);
  box.append(actions);
}

/**
 * Replace a part's text without disturbing anything else inside it.
 *
 * The previewed parts carry an appended pencil, so textContent would delete it.
 */
function setPartText(node, text) {
  if (!node) return;
  const existing = [...node.childNodes].find((n) => n.nodeType === 3);
  if (existing) existing.textContent = text;
  else node.prepend(document.createTextNode(text));
}

/**
 * Point the preview at the effective values — what the site will say once this
 * overlay is published, not what upstream says.
 *
 * Called on every edit, not only on selection. The preview's whole claim is
 * that it shows the published result; a heading that keeps the old name while
 * the field beside it holds the new one is the panel lying about its own
 * purpose, and the grid cell was already updating live.
 */
function refreshPreview(id) {
  const parts = state.preview;
  if (!parts || state.selected !== id) return;
  const entry = state.overlay.amiibos[id] ?? {};

  setPartText(parts.title, effectiveName(id, state.db.names[id] ?? id));

  if (parts.subtitle) {
    const d = describeAmiibo(id);
    const year = (entry.release ?? state.db.release[id] ?? '').slice(0, 4);
    setPartText(parts.subtitle, isHhdItemCards(id)
      ? 'Animal Crossing · Card set'
      : [d?.seriesName, d?.typeName, year].filter(Boolean).join(' · '));
  }
}

function edit(id, key, value) {
  const entry = state.overlay.amiibos[id] ?? { kind: 'override' };
  const trimmed = value.trim();
  // Deleting the key rather than storing an empty string is what keeps the
  // overlay a sparse set of differences instead of a second copy of the
  // database.
  if (trimmed === '') delete entry[key];
  else entry[key] = trimmed;

  const meaningful = Object.keys(entry).filter((k) => k !== 'kind');
  if (meaningful.length === 0 && entry.kind !== 'new') delete state.overlay.amiibos[id];
  else state.overlay.amiibos[id] = entry;

  refreshPreview(id);
  showProblems(id);
  markDirty();
  markCell(id);
  renderFilters();
}

/**
 * Put each problem under the field that caused it.
 *
 * The validator is the same one the server runs before it will write anything
 * (server/index.mjs dry-runs the whole overlay), so this is the identical
 * verdict arriving a round trip earlier. There is one definition of valid, in
 * overlay.js, and this does not add a second.
 */
function showProblems(id) {
  const entry = state.overlay.amiibos[id];
  const problems = entry ? validateAmiiboEntry(id, entry) : [];

  const byField = new Map();
  const loose = [];
  for (const p of problems) {
    if (p.field && state.fields?.has(p.field)) {
      byField.set(p.field, [...(byField.get(p.field) ?? []), p.message]);
    } else {
      loose.push(p.message);
    }
  }

  for (const [key, wrap] of state.fields ?? []) {
    const messages = byField.get(key) ?? [];
    wrap.classList.toggle('bad', messages.length > 0);
    const why = wrap.querySelector('.why');
    why.hidden = messages.length === 0;
    why.textContent = messages.join(' · ');
  }

  // A problem naming no field — an unknown key, a bad kind — still has to be
  // said somewhere, or SAVE stays disabled with nothing on screen to explain it.
  if (problems.length) state.bad.add(id);
  else state.bad.delete(id);
  if (loose.length) say(`${id}: ${loose.join(' · ')}`, 'err');

  refreshSaveState();
}

/**
 * SAVE is available only when every edited amiibo would validate.
 *
 * Without this the only feedback on a bad path is a 422 after a round trip, and
 * the button invites the trip.
 */
function refreshSaveState() {
  const blocked = state.bad.size > 0;
  el('save').disabled = !state.dirty || blocked;
  el('tileState').classList.toggle('err', blocked);
  if (blocked) el('statState').textContent = 'INVALID';
  else if (state.dirty) el('statState').textContent = 'UNSAVED';
}

// ---- saving -------------------------------------------------------------

function markDirty() {
  state.dirty = true;
  el('tileState').className = 'statTile warn';
  refreshSaveState();
  updateStats();
}

function markClean() {
  state.dirty = false;
  state.bad.clear();
  el('statState').textContent = 'SAVED';
  el('tileState').className = 'statTile ok';
  el('save').disabled = true;
  updateStats();
}

async function save() {
  // Publishing rewrites the live database, so it asks first. Every other
  // mutating action in this project already does.
  const edited = Object.keys(state.overlay.amiibos);
  const ok = await confirmDialog({
    title: 'PUBLISH?',
    body: 'The site\'s database is rebuilt immediately and visitors see the change on their next load.',
    detail: [
      `${edited.length} curated ${edited.length === 1 ? 'entry' : 'entries'}.`,
      ...edited.slice(0, 8).map((id) => `${id} · ${effectiveName(id, state.db.names[id] ?? id)}`),
      ...(edited.length > 8 ? [`and ${edited.length - 8} more`] : []),
    ],
    confirmLabel: 'SAVE & PUBLISH',
    icon: 'upload',
  });
  if (!ok) return;

  el('save').disabled = true;
  say('Saving and rebuilding the site…');
  try {
    const result = await api('/overlay', { method: 'PUT', body: state.overlay });
    markClean();
    say(`Saved. The site now has ${result.entries} amiibo.` +
        (result.backup ? ` Previous version kept as ${readableStamp(result.backup)}.` : ''), 'ok');
    for (const n of result.notices ?? []) say(`${n.id}: ${n.message}`, 'warn');
    // The save just took one, so the list is stale.
    loadBackups();
  } catch (err) {
    refreshSaveState();
    // The server refuses a save that would not build, so this is where a
    // collision or a bad pin shows up rather than after the fact.
    say([err.message, ...(err.details ?? [])].join(' · '), 'err');
  }
}

// ---- boot ---------------------------------------------------------------

el('signIn').addEventListener('click', signIn);
el('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
el('signOut').addEventListener('click', signOut);
el('save').addEventListener('click', save);
el('export').addEventListener('click', () => download('/export', 'amiibo-overrides.json'));

let filterTimer = null;
el('q').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilter, 120);
});
el('q').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { el('q').value = ''; applyFilter(); }
});
el('qClear').addEventListener('click', () => {
  el('q').value = '';
  applyFilter();
  el('q').focus();
});

// Sorting moves the existing groups; nothing is rebuilt.
el('sortMode').addEventListener('change', () => {
  reorderGroups(el('series'), sortedSeries(), state.groupEls);
  applyFilter();
});

for (const input of el('segView').querySelectorAll('input')) {
  input.addEventListener('change', () => {
    el('series').classList.toggle('cards', input.value === 'cards');
  });
}

// One capture-phase listener for every thumbnail, as on the collection page.
dropBrokenArt(el('series'));

// Leaving with unsaved edits loses them: the overlay only exists in this tab
// until it is saved.
addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// The module reached its end, so the page is not blank. The inline script in
// index.html watches for this and shows a notice if it never arrives.
document.documentElement.dataset.adminBooted = '1';

// An existing session skips the login screen; otherwise the form is already
// visible and just needs its mascot.
//
// The two failures are told apart deliberately. "No session" is the ordinary
// case and shows the form with nothing alarming on it. Anything else is a bug,
// and a bare catch here would render it as an innocent sign-in prompt — the
// same silent failure as the white screen, one layer further in.
let session = null;
try {
  session = await api('/session');
} catch {
  // Not signed in, or the server is not reachable. The form is already up.
}

el('loginMark').innerHTML = pirateMark(64, currentPirate());
if (session) {
  state.csrf = session.csrf;
  try {
    await boot();
  } catch (err) {
    el('login').hidden = false;
    const box = el('loginStatus');
    box.hidden = false;
    box.className = 'status err';
    box.textContent = `The admin loaded but could not start: ${err.message}`;
    throw err; // and leave it in the console, with its stack
  }
}
