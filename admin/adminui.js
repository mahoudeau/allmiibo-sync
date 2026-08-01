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
import { validateAmiiboEntry, validateOverlay, REFERENCE_ROOT } from '/js/overlay.js';
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
  review: null,       // the open upstream review: { pending, diff, decisions, fingerprint }
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
    // A route this page knows about that the server does not is not a missing
    // feature — it is a version mismatch, and always in the same direction.
    // The server serves this file fresh from disk on every request but runs
    // its own routes from the module graph it loaded at startup, so editing
    // server/ gives you a new interface talking to an old API. "No such
    // endpoint" is the least useful way to say that.
    const stale = res.status === 404 && parsed?.error === 'no such endpoint';
    const err = new Error(stale
      ? `the admin service does not have ${path}. It is running older code than `
        + 'this page — restart it (npm run admin:local) and reload.'
      : parsed?.error ?? `HTTP ${res.status}`);
    err.details = parsed?.details ?? [];
    err.status = res.status;
    err.stale = stale;
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

/** Amiibo authored here that the published database does not have yet. */
function pendingAuthored() {
  const extra = new Map();
  for (const [id, entry] of Object.entries(state.overlay.amiibos)) {
    if (entry.kind === 'new' && !state.db.names[id]) extra.set(id, entry.name);
  }
  return extra;
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
  // and the grouping is purely the database's — plus anything authored here
  // that has not been published yet, which would otherwise be invisible until
  // after a save.
  state.collection = buildCollection(new Set(), null, { extra: pendingAuthored() });

  // buildCollection names each group from the published database, so a series
  // renamed here would keep its old name in the header — and, worse, in the
  // search index, so searching for what is on screen would not find it. The
  // same reason the cells show the effective amiibo name.
  for (const group of state.collection.series) {
    group.seriesName = seriesLabel(group.series);
  }

  const { frag, rows, groupEls } = buildSeriesGrid(sortedSeries(), {
    cell: makeCell,
    pill: (g) => {
      const wrap = document.createElement('span');
      wrap.className = 'seriesActions';
      wrap.append(makeSeriesPill(g), makeSeriesEdit(g));
      return wrap;
    },
    art: (g) => artUrl(seriesFace(g) ?? g.items[0].id),
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
/**
 * The edit affordance on a series header.
 *
 * A <summary> toggles its <details> on any click inside it, so this has to stop
 * the event as well as handle it — otherwise editing a series would always
 * expand or collapse it at the same time.
 */
function makeSeriesEdit(group) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'editPart seriesEdit';
  b.title = `Edit ${group.seriesName}`;
  b.innerHTML = ICONS.cog ?? '';
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    renderSeriesEditor(group.series);
  });
  return b;
}

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

// ---- the upstream review -------------------------------------------------
//
// Track Changes, arranged by entity. Every modification is individually
// ACCEPT or DECLINE, and DECLINE means "not this time" — the change is not
// applied and the next update offers it again.
//
// Two rules the previous version broke, both worth stating because both are
// what made it unreadable:
//
//   The unit is the ENTITY, not the field. An amiibo arriving with a name and
//   a release date is one arrival, one row. Counting fields as peers is why the
//   old summary and the old row list disagreed.
//
//   Nothing is required. Anything left alone is accepted, and the confirm step
//   says how many that is. A row whose only possible answer is "yes" is not a
//   question, and the old screen had them — and blocked on them.
//
// Steps run coarse to fine: a series is decided before the amiibo inside it,
// so the cascade resolves in the order you meet it.

const STEPS = [
  { key: 'series', title: 'SERIES', of: (e) => e.kind === 'series' },
  { key: 'type', title: 'TYPES', of: (e) => e.kind === 'type' },
  { key: 'amiibo', title: 'AMIIBO', of: (e) => e.kind === 'amiibo' && !e.device },
  { key: 'device', title: 'ON YOUR DEVICE', of: (e) => Boolean(e.device) },
  { key: 'confirm', title: 'CONFIRM', of: () => false },
];

// Sections within a step, in a fixed order.
const OPS = [
  { op: 'add', title: 'ADDED' },
  { op: 'remove', title: 'REMOVED' },
  { op: 'edit', title: 'CHANGED' },
];

const FIELD_LABEL = {
  name: 'name', released: 'released', folder: 'device folder',
  fileName: 'filename', shortName: 'short name',
};

async function openReview() {
  if (state.dirty) {
    const ok = await confirmDialog({
      title: 'SAVE YOUR EDITS FIRST?',
      body: 'Applying a refresh writes the overlay, so it cannot run alongside '
        + 'unsaved edits. Save or revert them, then try again.',
      confirmLabel: 'OK',
      cancelLabel: 'CLOSE',
    });
    return void ok;
  }

  say('Checking for updates…');
  el('refresh').disabled = true;
  try {
    await api('/upstream/refresh', { method: 'POST' });
    // Deliberately NOT short-circuiting on "the sources are byte-identical to
    // what is cached". That answers a different question. The sources can be
    // unchanged while the published database is still behind them — a cache
    // fetched but never applied, or a database regenerated from an older pair
    // — and there is plenty to review in that case. What matters is whether
    // the DATABASE would change, which only the preview knows.
    await loadPreview();
  } catch (err) {
    say([err.message, ...(err.details ?? [])].join(' · '), 'err');
  } finally {
    el('refresh').disabled = false;
  }
}

async function loadPreview() {
  const preview = await api('/upstream/preview');
  if (!preview.pending) {
    say('There is no pending refresh.', 'warn');
    return;
  }
  if (!preview.ok) {
    // The new sources introduce something the build refuses. There is no
    // candidate to diff, so say that plainly rather than showing an empty
    // review.
    say(`This refresh will not build: ${preview.errors.join(' · ')}`, 'err');
    return;
  }
  if (preview.diff.counts.total === 0) {
    // Nothing to decide. Worth one line rather than an empty review screen —
    // and the fetch is thrown away so it does not sit there looking pending.
    say('No update available: the site already matches upstream.', 'ok');
    await api('/upstream/pending', { method: 'DELETE' }).catch(() => {});
    return;
  }

  // Verdicts are per ENTITY — the thing on screen — and expanded to the flat
  // change keys the server names only when the update is applied.
  state.review = { ...preview, verdicts: {}, steps: [], step: 0 };
  renderReview();
  say('');
}

function renderReview() {
  const r = state.review;
  el('library').hidden = true;
  el('review').hidden = false;

  el('reviewWhen').textContent = `fetched ${readableStamp(r.pending.fetchedAt)}`;

  // Only steps that have something in them, so the numbering counts what there
  // actually is to look at rather than promising empty screens.
  r.steps = STEPS.filter((s) => s.key === 'confirm' || r.diff.entities.some(s.of));
  r.step = 0;

  renderSummary();
  renderStepper();
  renderStep();
}

function closeReview() {
  state.review = null;
  el('review').hidden = true;
  el('library').hidden = false;
  el('refresh').disabled = false;
}

/**
 * The headline: named counts over the rows on screen, zeros intact.
 *
 * Counted from `diff.summary`, which is derived from the same entity array the
 * steps render — so the number here and the number of rows cannot disagree.
 * That is the specific failure being fixed.
 */
function renderSummary() {
  const s = state.review.diff.summary;
  const part = (n, noun, verb) => `${n} ${noun}${n === 1 ? '' : n && noun.endsWith('s') ? '' : ''} to ${verb}`;

  const bits = [];
  if (s.amiibo.add || s.amiibo.edit || s.amiibo.remove) {
    bits.push(`${part(s.amiibo.add, 'amiibo', 'add')}, ${s.amiibo.edit} to change, `
      + `${s.amiibo.remove} to remove`);
  }
  for (const [kind, noun] of [['series', 'series'], ['type', 'type']]) {
    const k = s[kind];
    if (k.add) bits.push(`${k.add} ${noun} to add`);
    if (k.edit) bits.push(`${k.edit} ${noun} to change`);
    if (k.remove) bits.push(`${k.remove} ${noun} to remove`);
  }
  el('reviewSummary').textContent = `Update: ${bits.join(' · ')}`;

  // The only line that changes colour, because it is the only one that says
  // whether this update needs care.
  const risk = el('reviewRisk');
  const notes = [];
  notes.push(s.yours
    ? `${s.yours} of these collide with something you curated`
    : 'Nothing you have curated is affected');
  notes.push(s.device
    ? `${s.device} would rename files on your device`
    : 'No files move on your device');
  risk.textContent = notes.join(' · ');
  risk.className = `summaryRisk${s.device ? ' err' : s.yours ? ' warn' : ''}`;
}

function renderStepper() {
  const r = state.review;
  const box = el('reviewSteps');
  box.textContent = '';
  r.steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = i === r.step ? 'on' : i < r.step ? 'done' : '';
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="n">${i + 1}</span>`;
    b.append(document.createTextNode(step.title));
    b.addEventListener('click', () => gotoStep(i));
    li.append(b);
    box.append(li);
  });
}

function gotoStep(i) {
  const r = state.review;
  r.step = Math.max(0, Math.min(i, r.steps.length - 1));
  renderStepper();
  renderStep();
}

function renderStep() {
  const r = state.review;
  const step = r.steps[r.step];
  const panel = el('reviewPanel');
  panel.textContent = '';

  const last = r.step === r.steps.length - 1;
  el('reviewBack').disabled = r.step === 0;
  el('reviewNext').hidden = last;
  el('reviewApply').hidden = !last;

  if (step.key === 'confirm') return renderConfirm(panel);

  const rows = r.diff.entities.filter(step.of);
  const body = document.createElement('div');
  body.className = 'stepBody panel';

  for (const { op, title } of OPS) {
    const inOp = rows.filter((e) => e.op === op);
    if (!inOp.length) continue;

    const h = document.createElement('h3');
    h.append(document.createTextNode(`${title} (${inOp.length})`));

    // Bulk answers only where there is something to answer.
    const decidable = inOp.filter((e) => e.decidable);
    if (decidable.length > 1) {
      const bulk = document.createElement('span');
      bulk.className = 'bulk';
      for (const [verdict, label] of [['keep', 'ACCEPT ALL'], ['skip', 'DECLINE ALL']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => {
          for (const e of decidable) decide(e, verdict);
          renderStep();
        });
        bulk.append(b);
      }
      h.append(bulk);
    }
    body.append(h);
    for (const e of inOp) body.append(renderEntityRow(e));
  }

  panel.append(body);
}

function renderEntityRow(entity) {
  const r = state.review;
  const verdict = r.verdicts[entity.key];

  const row = document.createElement('div');
  row.className = `entity${entity.danger ? ' danger' : ''}`
    + (verdict === 'keep' ? ' accepted' : verdict === 'skip' ? ' declined' : '');
  row.dataset.key = entity.key;

  const top = document.createElement('div');
  top.className = 'top';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entity.label;
  top.append(name);
  if (entity.kind === 'amiibo' && entity.series) {
    const s = document.createElement('span');
    s.className = 'ref';
    s.textContent = entity.series;
    top.append(s);
  }
  if (verdict) {
    const v = document.createElement('span');
    v.className = 'verdict';
    v.textContent = verdict === 'keep' ? '✓ ACCEPTED' : '✕ DECLINED';
    top.append(v);
  }
  row.append(top);

  // The fields, old on the left and new on the right. Where you have an
  // override there are three values, not two, because two cannot say which is
  // yours — the same reason git's diff3 shows the base.
  const fields = document.createElement('div');
  fields.className = 'fields';
  for (const f of entity.fields) {
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = FIELD_LABEL[f.field] ?? f.field;
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = f.published ?? '—';
    const to = document.createElement('span');
    to.className = 'to';
    to.textContent = `→  ${f.upstream ?? '—'}`;
    fields.append(k, from, to);

    if (f.yours !== null) {
      const yk = document.createElement('span');
      yk.className = 'k';
      const yv = document.createElement('span');
      yv.className = 'yours';
      yv.textContent = f.yours;
      const note = document.createElement('span');
      note.className = 'yours';
      note.textContent = '← yours';
      fields.append(yk, yv, note);
    }
  }
  row.append(fields);

  if (entity.device) {
    const dev = document.createElement('div');
    dev.className = 'why';
    dev.textContent = `${entity.device.before}  →  ${entity.device.after}`;
    row.append(dev);
  }

  if (!entity.decidable) {
    // Shown so you know it happened, with no buttons, because there is only one
    // possible outcome. A brand-new series has no previous name to fall back
    // to, and the build refuses a series byte without one.
    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = entity.op === 'add' && entity.kind !== 'amiibo'
      ? 'Comes with the amiibo that need it — nothing to decide.'
      : 'No previous value to keep, so this cannot be declined.';
    row.append(why);
    return row;
  }

  const acts = document.createElement('div');
  acts.className = 'acts';
  for (const [v, label, title] of [
    ['keep', '✓ ACCEPT', 'Take this change.'],
    ['skip', '✕ DECLINE', entity.op === 'add'
      ? 'Leave it out for now. The next update will offer it again.'
      : 'Keep what the site shows today.'],
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    if (verdict === v) b.className = 'primary';
    b.addEventListener('click', () => { decide(entity, v); renderStep(); });
    acts.append(b);
  }
  row.append(acts);
  return row;
}

/**
 * Record a verdict, and carry it to whatever depends on it.
 *
 * Declining an amiibo whose series is also new leaves the series with nothing
 * in it; accepting one requires its series. The step order puts series first,
 * but a decision taken later still has to reach back.
 */
function decide(entity, verdict) {
  const r = state.review;
  r.verdicts[entity.key] = verdict;

  if (entity.needs) {
    const needed = r.diff.entities.find((e) => e.key === entity.needs);
    if (needed) {
      const users = r.diff.entities.filter((e) => e.needs === entity.needs);
      // The series follows its amiibo: kept if any of them is, dropped if none.
      r.verdicts[needed.key] = users.some((e) => r.verdicts[e.key] !== 'skip') ? 'keep' : 'skip';
    }
  }
}

function renderConfirm(panel) {
  const r = state.review;
  const body = document.createElement('div');
  body.className = 'stepBody panel';

  const decided = Object.keys(r.verdicts).length;
  const declined = r.diff.entities.filter((e) => r.verdicts[e.key] === 'skip');
  const accepted = r.diff.entities.filter((e) => r.verdicts[e.key] !== 'skip');
  const renames = r.diff.entities.filter(
    (e) => e.device && r.verdicts[e.key] !== 'skip');

  const h = document.createElement('h3');
  h.textContent = 'WHAT WILL HAPPEN';
  body.append(h);

  const list = document.createElement('ul');
  list.className = 'confirmList';
  const say_ = (text) => {
    const li = document.createElement('li');
    li.textContent = text;
    list.append(li);
  };

  say_(`${accepted.length} change${accepted.length === 1 ? '' : 's'} applied.`);
  if (declined.length) {
    say_(`${declined.length} declined — left out for now, offered again next update.`);
  }
  if (renames.length) {
    say_(`${renames.length} file${renames.length === 1 ? '' : 's'} renamed on every device you sync.`);
  }
  if (decided < r.diff.entities.length) {
    // Said out loud rather than left implicit: this is the trade for not
    // blocking on rows nobody can act on.
    say_(`${r.diff.entities.length - decided} left untouched, and will be accepted.`);
  }
  body.append(list);
  panel.append(body);
}

/** Verdicts per entity, expanded to the flat change keys the server names. */
function reviewDecisions() {
  const r = state.review;
  const out = {};
  for (const e of r.diff.entities) {
    const verdict = r.verdicts[e.key] ?? 'keep';
    for (const key of e.changeKeys) out[key] = verdict;
  }
  return out;
}

async function applyReview() {
  const r = state.review;
  const renames = r.diff.entities.filter((e) => e.device && r.verdicts[e.key] !== 'skip');

  if (renames.length) {
    const ok = await confirmDialog({
      title: `RENAME ${renames.length === 1 ? 'A FILE' : `${renames.length} FILES`} ON EVERY DEVICE?`,
      body: 'The next sync moves them. This is what the review is for.',
      detail: renames.slice(0, 20).map((e) => `${e.device.before} → ${e.device.after}`),
      confirmLabel: 'RENAME THEM',
      danger: true,
    });
    if (!ok) return;
  }

  el('reviewApply').disabled = true;
  say('Applying and rebuilding the site…');
  try {
    const result = await api('/upstream/apply', {
      method: 'POST',
      body: { fingerprint: r.fingerprint, decisions: reviewDecisions() },
    });
    closeReview();
    say(`Applied. The site now has ${result.entries} amiibo`
      + (result.applied.pinsWritten ? `, holding ${result.applied.pinsWritten} value(s) back` : '')
      + (result.renames.length ? `, renaming ${result.renames.length} file(s) on the device` : '')
      + '.', 'ok');
    await boot();
  } catch (err) {
    el('reviewApply').disabled = false;
    if (err.status === 409) {
      // The world moved underneath the preview. Reload it rather than trying
      // to reconcile decisions against a diff that no longer exists.
      say('Something changed while you were reviewing. Reloading the preview.', 'warn');
      await loadPreview();
      return;
    }
    say([err.message, ...(err.details ?? [])].join(' · '), 'err');
  }
}

// ---- series --------------------------------------------------------------
//
// A series is a byte in the amiibo ID, not a record: it exists because amiibo
// carry it. So "creating" one means naming a byte upstream has not named —
// which is what unblocks authoring an amiibo into it — and everything else is
// editing the three things a curator controls: the label, the folder token
// that names a directory on every device, and which amiibo's artwork stands
// for it.

/** The effective values for a series byte, overlay first. */
function seriesLabel(byte) {
  return state.overlay.series?.[byte]?.label ?? state.db.series[byte] ?? `Series 0x${byte.toString(16)}`;
}
function seriesToken(byte) {
  return state.overlay.series?.[byte]?.short ?? state.db.seriesShort[byte] ?? '';
}
function seriesFace(group) {
  const pinned = state.overlay.series?.[group.series]?.face;
  if (pinned && group.items.some((i) => i.id === pinned)) return pinned;
  return seriesRepresentative(group.series);
}

/** Set one field on a series, dropping the entry when nothing is left on it. */
function editSeries(byte, key, value) {
  const table = state.overlay.series ?? (state.overlay.series = {});
  const entry = table[byte] ?? {};
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '' || trimmed == null) delete entry[key];
  else entry[key] = trimmed;

  if (Object.keys(entry).length === 0) delete table[byte];
  else table[byte] = entry;
  markDirty();
}

function renderSeriesEditor(byte) {
  state.selected = null;
  state.fields = new Map();
  state.preview = null;
  for (const r of state.rows) r.el.setAttribute('aria-pressed', 'false');

  const group = state.collection.series.find((s) => s.series === byte);
  // Declared up here because the field handlers below keep it in step, and
  // they are wired before it is built.
  let revert = null;
  const box = el('editor');
  box.textContent = '';

  const cap = document.createElement('h2');
  cap.className = 'cap';
  cap.textContent = 'EDITING SERIES';
  const name = document.createElement('div');
  name.className = 'eName';
  name.textContent = seriesLabel(byte);
  const idLine = document.createElement('p');
  idLine.className = 'idLine';
  idLine.textContent = `byte 0x${byte.toString(16).padStart(2, '0')} · `
    + `${group ? group.items.length : 0} amiibo`;
  box.append(cap, name, idLine);

  const field = (key, label, value, hint) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lab = document.createElement('label');
    lab.htmlFor = `s-${key}`;
    lab.textContent = label;
    const input = document.createElement('input');
    input.id = `s-${key}`;
    input.type = 'text';
    input.value = value;
    const was = document.createElement('div');
    was.className = 'was';
    was.textContent = hint ?? '';
    const why = document.createElement('div');
    why.className = 'why';
    why.hidden = true;
    wrap.append(lab, input, was, why);
    box.append(wrap);
    return { wrap, input, why, was };
  };

  const labelF = field('label', 'SERIES NAME', state.overlay.series?.[byte]?.label ?? '',
    state.db.series[byte] ? `upstream: ${state.db.series[byte]}` : 'upstream has no name for this byte');

  const token = seriesToken(byte);
  const tokenF = field('short', 'FOLDER ON THE DEVICE', state.overlay.series?.[byte]?.short ?? '',
    state.db.seriesShort[byte] ? `derived: ${state.db.seriesShort[byte]}` : '');

  // The one field with a cost attached. Say it where it is being changed.
  const cost = document.createElement('div');
  cost.className = 'why tokenCost';
  cost.hidden = true;
  tokenF.wrap.append(cost);

  const sampleName = group?.items[0] ? effectiveName(group.items[0].id, group.items[0].name) : 'Amiibo';
  const showCost = () => {
    const next = tokenF.input.value.trim() || state.db.seriesShort[byte] || '';
    const changed = next && next !== token;
    cost.hidden = !changed;
    if (changed) {
      cost.textContent = `${REFERENCE_ROOT}/${token}/${sampleName}.bin`
        + ` → ${REFERENCE_ROOT}/${next}/${sampleName}.bin`
        + ` · ${group?.items.length ?? 0} files move on the next sync.`;
    }
  };

  // Whether there is anything to revert changes with every edit, so it cannot
  // be decided once at render time — the same staleness that left the preview
  // showing an old name.
  const syncRevert = () => { if (revert) revert.disabled = !state.overlay.series?.[byte]; };

  const problems = () => {
    const errs = validateOverlay({ ...state.overlay, amiibos: {} })
      .filter((m) => m.startsWith(`series[${byte}]`));
    for (const [f, wrap] of [['label', labelF], ['short', tokenF]]) {
      const mine = errs.filter((m) => m.includes(`.${f} `) || m.includes(`.${f} must`));
      wrap.wrap.classList.toggle('bad', mine.length > 0);
      wrap.why.hidden = mine.length === 0;
      wrap.why.textContent = mine.join(' · ');
    }
    const blocked = errs.length > 0;
    if (blocked) state.bad.add(`series:${byte}`); else state.bad.delete(`series:${byte}`);
    refreshSaveState();
  };

  labelF.input.addEventListener('input', () => {
    editSeries(byte, 'label', labelF.input.value);
    name.textContent = seriesLabel(byte);
    problems();
    syncRevert();
    refreshSeriesHeader(byte);
  });
  tokenF.input.addEventListener('input', () => {
    editSeries(byte, 'short', tokenF.input.value);
    showCost();
    problems();
    syncRevert();
  });

  // The representative: any amiibo in this series, by name.
  const faceWrap = document.createElement('div');
  faceWrap.className = 'field';
  const faceLab = document.createElement('label');
  faceLab.htmlFor = 's-face';
  faceLab.textContent = 'SERIES IMAGE';
  const faceSel = document.createElement('select');
  faceSel.id = 's-face';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '(pick automatically)';
  faceSel.append(auto);
  for (const item of [...(group?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    const o = document.createElement('option');
    o.value = item.id;
    o.textContent = effectiveName(item.id, item.name);
    faceSel.append(o);
  }
  faceSel.value = state.overlay.series?.[byte]?.face ?? '';
  const faceHint = document.createElement('div');
  faceHint.className = 'was';
  faceHint.textContent = 'The artwork shown on the series header. There is no series '
    + 'logo anywhere, so this is one of its amiibo.';
  const facePreview = document.createElement('img');
  facePreview.className = 'facePreview';
  facePreview.alt = '';
  const drawFace = () => {
    const chosen = faceSel.value || (group ? seriesRepresentative(byte) : null) || group?.items[0]?.id;
    if (chosen) facePreview.src = artUrl(chosen, 'med');
  };
  faceSel.addEventListener('change', () => {
    editSeries(byte, 'face', faceSel.value);
    drawFace();
    syncRevert();
    refreshSeriesHeader(byte);
  });
  faceWrap.append(faceLab, faceSel, facePreview, faceHint);
  box.append(faceWrap);
  drawFace();

  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.marginTop = '.8rem';
  revert = document.createElement('button');
  revert.textContent = 'REVERT THIS SERIES';
  revert.addEventListener('click', () => {
    delete state.overlay.series[byte];
    markDirty();
    renderSeriesEditor(byte);
    refreshSeriesHeader(byte);
  });
  actions.append(revert);
  box.append(actions);

  showCost();
  problems();
  syncRevert();
  labelF.input.focus();
}

/** Redraw one series header after its label or face changed. */
function refreshSeriesHeader(byte) {
  const group = state.collection.series.find((s) => s.series === byte);
  const node = state.groupEls.get(byte)?.el;
  if (!group || !node) return;
  const head = node.querySelector('.seriesHead');
  const text = [...head.childNodes].find(
    (n) => n.nodeType === 1 && !n.classList.contains('seriesArt') && !n.classList.contains('year'));
  if (text) text.textContent = seriesLabel(byte);
  const img = head.querySelector('img.seriesArt');
  if (img) img.src = artUrl(seriesFace(group) ?? group.items[0].id);
}

// ---- authoring a new amiibo ---------------------------------------------

/**
 * Why an ID cannot be authored, or null if it can.
 *
 * The last check is the one that saves a confusing round trip: the generator
 * hard-fails on a series or type byte it has no label for, so an ID with an
 * unknown series byte would be refused at save time with an error about the
 * build rather than about the ID that caused it.
 */
function whyNotAuthorable(id) {
  if (!/^[0-9a-f]{16}$/.test(id)) return 'An amiibo ID is 16 lowercase hex characters.';
  if (state.db.names[id]) return `Upstream already has this ID: ${state.db.names[id]}.`;
  if (state.overlay.amiibos[id]) return 'This ID is already in the overlay.';
  const d = describeAmiibo(id);
  if (!d) return 'That is not a decodable amiibo ID.';
  // A byte with no name fails the build. It can be named here, though, which
  // is what "creating a series" means — so say that rather than just refusing.
  const sByte = parseInt(id.slice(12, 14), 16);
  if (!state.db.series[sByte] && !state.overlay.series?.[sByte]?.label) {
    return `Series byte ${id.slice(12, 14)} has no name. Name it first — NEW SERIES below.`;
  }
  if (!state.db.types[parseInt(id.slice(6, 8), 16)]) {
    return `Type byte ${id.slice(6, 8)} has no name, so the database would not build.`;
  }
  return null;
}

/**
 * Name a series byte upstream has not named.
 *
 * A series is not a record you create — it is a byte amiibo carry — so this is
 * the whole of "creating" one, and its only real purpose is to unblock
 * authoring an amiibo into a series the database does not know yet.
 */
function renderNewSeries() {
  state.selected = null;
  state.fields = new Map();
  state.preview = null;

  const box = el('editor');
  box.textContent = '';
  const cap = document.createElement('h2');
  cap.className = 'cap';
  cap.textContent = 'NEW SERIES';
  const blurb = document.createElement('p');
  blurb.className = 'idLine';
  blurb.textContent = 'A series is a byte in the amiibo ID, so this names one the '
    + 'database has no name for yet. Amiibo can then be authored into it.';
  box.append(cap, blurb);

  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lab = document.createElement('label');
  lab.htmlFor = 'ns-byte';
  lab.textContent = 'UNNAMED SERIES BYTE';
  const sel = document.createElement('select');
  sel.id = 'ns-byte';
  for (let b = 0; b < 256; b++) {
    if (state.db.series[b] || state.overlay.series?.[b]?.label) continue;
    const o = document.createElement('option');
    o.value = String(b);
    o.textContent = `0x${b.toString(16).padStart(2, '0')}`;
    sel.append(o);
  }
  wrap.append(lab, sel);
  box.append(wrap);

  const nameWrap = document.createElement('div');
  nameWrap.className = 'field';
  const nameLab = document.createElement('label');
  nameLab.htmlFor = 'ns-label';
  nameLab.textContent = 'SERIES NAME';
  const nameIn = document.createElement('input');
  nameIn.id = 'ns-label';
  nameIn.type = 'text';
  nameWrap.append(nameLab, nameIn);
  box.append(nameWrap);

  const actions = document.createElement('div');
  actions.className = 'row';
  const create = document.createElement('button');
  create.className = 'primary';
  create.textContent = 'CREATE';
  create.disabled = true;
  const cancel = document.createElement('button');
  cancel.textContent = 'CANCEL';
  cancel.addEventListener('click', () => renderEditor());
  actions.append(create, cancel);
  box.append(actions);

  nameIn.addEventListener('input', () => { create.disabled = !nameIn.value.trim(); });
  create.addEventListener('click', () => {
    const byte = Number(sel.value);
    editSeries(byte, 'label', nameIn.value);
    // A series with no amiibo in it has no group in the grid yet, so there is
    // nothing to redraw — it appears when something is authored into it.
    say(`Named series 0x${byte.toString(16).padStart(2, '0')} "${nameIn.value.trim()}". `
      + 'Author an amiibo into it with NEW AMIIBO.', 'ok');
    renderSeriesEditor(byte);
  });

  if (!sel.options.length) {
    create.disabled = true;
    say('Every series byte already has a name.', 'warn');
  }
}

/**
 * The create form, rendered into the editor column.
 *
 * Not a dialog: it reuses the field styling, the validation vocabulary and the
 * same column the editor occupies, so creating and editing look like one
 * screen rather than two.
 */
function renderNewForm() {
  state.selected = null;
  state.fields = new Map();
  state.preview = null;
  for (const r of state.rows) r.el.setAttribute('aria-pressed', 'false');

  const box = el('editor');
  box.textContent = '';

  const cap = document.createElement('h2');
  cap.className = 'cap';
  cap.textContent = 'NEW AMIIBO';
  const blurb = document.createElement('p');
  blurb.className = 'idLine';
  blurb.textContent = 'For an amiibo upstream does not list yet. It rides the '
    + 'fan-made toggle on the site, alongside the HHD cards.';
  box.append(cap, blurb);

  const field = (key, label, placeholder) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lab = document.createElement('label');
    lab.htmlFor = `n-${key}`;
    lab.textContent = label;
    const input = document.createElement('input');
    input.id = `n-${key}`;
    input.type = 'text';
    input.placeholder = placeholder;
    const why = document.createElement('div');
    why.className = 'why';
    why.hidden = true;
    wrap.append(lab, input, why);
    box.append(wrap);
    return { wrap, input, why };
  };

  const idF = field('id', 'AMIIBO ID (16 HEX)', '0000000000000002');
  const decoded = document.createElement('div');
  decoded.className = 'was';
  idF.wrap.insertBefore(decoded, idF.why);
  const nameF = field('name', 'NAME', 'What it is called');

  const actions = document.createElement('div');
  actions.className = 'row';
  const create = document.createElement('button');
  create.className = 'primary';
  create.textContent = 'CREATE';
  create.disabled = true;
  const cancel = document.createElement('button');
  cancel.textContent = 'CANCEL';
  cancel.addEventListener('click', () => renderEditor());
  actions.append(create, cancel);
  box.append(actions);

  const check = () => {
    const id = idF.input.value.trim().toLowerCase();
    const name = nameF.input.value.trim();

    // Show what the ID decodes to as it is typed: the series and type are the
    // whole meaning of those bytes, and typing them blind is how you author an
    // amiibo into the wrong series.
    const d = /^[0-9a-f]{16}$/.test(id) ? describeAmiibo(id) : null;
    decoded.textContent = d
      ? `${state.db.series[d.series] ?? `series ${d.series}`} · ${d.typeName}`
      : '';

    const problem = id ? whyNotAuthorable(id) : null;
    idF.wrap.classList.toggle('bad', !!problem);
    idF.why.hidden = !problem;
    idF.why.textContent = problem ?? '';

    const needsName = !name;
    nameF.wrap.classList.toggle('bad', needsName && !!id);
    nameF.why.hidden = !(needsName && !!id);
    nameF.why.textContent = needsName ? 'An authored amiibo needs a name.' : '';

    create.disabled = !id || !!problem || needsName;
  };

  idF.input.addEventListener('input', check);
  nameF.input.addEventListener('input', check);

  create.addEventListener('click', () => {
    const id = idF.input.value.trim().toLowerCase();
    if (whyNotAuthorable(id)) return;
    state.overlay.amiibos[id] = { kind: 'new', name: nameF.input.value.trim() };
    markDirty();
    // The grid is built from the published database plus pending authored
    // entries, so it has to be rebuilt rather than patched.
    buildRows();
    applyFilter();
    select(id);
    say(`Created ${state.overlay.amiibos[id].name}. It is not published until you save.`, 'ok');
  });

  idF.input.focus();
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
  // For an override, dropping the entry falls back to upstream. For an
  // authored one there is nothing to fall back to — the amiibo ceases to
  // exist — so the button says that, and asks.
  const authored = entry.kind === 'new';
  const revert = document.createElement('button');
  revert.textContent = authored ? 'DELETE THIS AMIIBO' : 'REVERT THIS AMIIBO';
  revert.className = authored ? 'danger' : '';
  revert.disabled = !state.overlay.amiibos[id];
  revert.addEventListener('click', async () => {
    if (authored) {
      const ok = await confirmDialog({
        title: 'DELETE THIS AMIIBO?',
        body: 'It exists only in the overlay, so this removes it entirely rather than '
          + 'restoring an upstream value.',
        detail: [effectiveName(id, id), id],
        confirmLabel: 'DELETE',
        danger: true,
      });
      if (!ok) return;
    }
    delete state.overlay.amiibos[id];
    markDirty();
    if (authored) {
      // Its cell only existed because the overlay did.
      state.selected = null;
      buildRows();
      applyFilter();
      renderEditor();
    } else {
      renderEditor();
      markCell(id);
      renderFilters();
    }
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

/**
 * Folder tokens this save would change, with what it costs.
 *
 * Renaming one renames a directory on every device already synced, and the
 * next sync then moves every file inside it. That is the most expensive thing
 * this screen can do, and it is invisible in a list of edited names.
 */
function pendingRenames() {
  const out = [];
  for (const [byte, entry] of Object.entries(state.overlay.series ?? {})) {
    if (entry.short === undefined) continue;
    const b = Number(byte);
    const was = state.db.seriesShort[b];
    if (!was || was === entry.short) continue;
    const group = state.collection.series.find((s) => s.series === b);
    out.push({
      label: seriesLabel(b),
      from: was,
      to: entry.short,
      files: group?.items.length ?? 0,
    });
  }
  return out;
}

async function save() {
  // Publishing rewrites the live database, so it asks first. Every other
  // mutating action in this project already does.
  const edited = Object.keys(state.overlay.amiibos);
  const renames = pendingRenames();

  // A folder rename is a different order of consequence from a name change, so
  // it gets its own dialog rather than a line inside the ordinary one.
  if (renames.length) {
    const moved = renames.reduce((n, r) => n + r.files, 0);
    const ok = await confirmDialog({
      title: `RENAME ${renames.length === 1 ? 'A FOLDER' : `${renames.length} FOLDERS`} ON EVERY DEVICE?`,
      body: 'The next sync moves every file inside them.',
      detail: renames.map((r) =>
        `${REFERENCE_ROOT}/${r.from}/ → ${REFERENCE_ROOT}/${r.to}/  (${r.label}, ${r.files} files)`),
      confirmLabel: `RENAME AND MOVE ${moved} FILES`,
      danger: true,
    });
    if (!ok) return;
  }

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
el('newAmiibo').addEventListener('click', renderNewForm);
el('newSeries').addEventListener('click', renderNewSeries);
el('refresh').addEventListener('click', openReview);
el('reviewClose').addEventListener('click', closeReview);
el('reviewApply').addEventListener('click', applyReview);
el('reviewBack').addEventListener('click', () => gotoStep(state.review.step - 1));
el('reviewNext').addEventListener('click', () => gotoStep(state.review.step + 1));

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
