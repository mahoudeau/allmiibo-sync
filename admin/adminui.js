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

const el = (id) => document.getElementById(id);

const state = {
  csrf: null,
  db: null,
  overlay: null,
  rows: [],        // { node, id, haystack }
  selected: null,
  dirty: false,
};

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
  buildRows();
  applyFilter();
  markClean();
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

function buildRows() {
  const frag = document.createDocumentFragment();
  state.rows = [];

  const ids = Object.keys(state.db.names).sort((a, b) => {
    const s = (state.db.names[a] ?? '').localeCompare(state.db.names[b] ?? '');
    return s || a.localeCompare(b);
  });

  for (const id of ids) {
    const name = state.db.names[id] ?? id;
    const seriesName = state.db.series[parseInt(id.slice(12, 14), 16)] ?? '';
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'aRow';
    node.dataset.id = id;
    node.innerHTML =
      `<span class="nm"></span><span class="sr"></span><span class="mk"></span>`;
    node.querySelector('.nm').textContent = name;
    node.querySelector('.sr').textContent = seriesName;
    node.addEventListener('click', () => select(id));
    frag.append(node);
    // Precomputed once so filtering is a substring test per row rather than a
    // rebuild.
    state.rows.push({ node, id, haystack: `${name} ${seriesName} ${id}`.toLowerCase() });
  }

  el('rows').textContent = '';
  el('rows').append(frag);
  for (const r of state.rows) markRow(r);
  el('count').textContent = `${state.rows.length} AMIIBO`;
}

function markRow(row) {
  const entry = state.overlay.amiibos[row.id];
  const mark = row.node.querySelector('.mk');
  mark.textContent = entry ? (entry.kind === 'new' ? 'NEW' : 'EDITED') : '';
}

function applyFilter() {
  const q = el('q').value.trim().toLowerCase();
  let shown = 0;
  for (const row of state.rows) {
    const hit = !q || row.haystack.includes(q);
    row.node.hidden = !hit;
    if (hit) shown++;
  }
  el('count').textContent = q ? `${shown} OF ${state.rows.length}` : `${state.rows.length} AMIIBO`;
}

// ---- the editor ---------------------------------------------------------

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
  for (const r of state.rows) r.node.classList.toggle('on', r.id === id);
  renderEditor();
}

function renderEditor() {
  const id = state.selected;
  const box = el('editor');
  if (!id) { box.innerHTML = '<p class="sub">Pick an amiibo to edit.</p>'; return; }

  const entry = state.overlay.amiibos[id] ?? {};
  box.textContent = '';

  const head = document.createElement('div');
  head.innerHTML = `<h2 style="margin:0 0 .2rem">${escape(state.db.names[id] ?? id)}</h2>` +
    `<p class="sub" style="margin:0">${id} · ${escape(state.db.series[parseInt(id.slice(12, 14), 16)] ?? '')}</p>`;
  box.append(head);

  for (const field of FIELDS) {
    const wrap = document.createElement('div');
    wrap.className = 'fRow';
    const inputId = `f-${field.key}`;
    wrap.innerHTML = `<label for="${inputId}">${field.label}</label>` +
      `<input id="${inputId}" type="text">` +
      `<div class="was"></div><div class="why" hidden></div>`;
    const input = wrap.querySelector('input');
    input.value = entry[field.key] ?? '';
    const upstream = field.upstream(id) ?? '';
    wrap.querySelector('.was').textContent = upstream ? `upstream: ${upstream}` : '';
    input.addEventListener('input', () => edit(id, field.key, input.value, wrap));
    box.append(wrap);
  }

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
    const row = state.rows.find((r) => r.id === id);
    if (row) markRow(row);
  });
  actions.append(revert);
  box.append(actions);
}

function edit(id, key, value, wrap) {
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

  wrap.classList.remove('bad');
  wrap.querySelector('.why').hidden = true;
  markDirty();
  const row = state.rows.find((r) => r.id === id);
  if (row) markRow(row);
}

// ---- saving -------------------------------------------------------------

function markDirty() {
  state.dirty = true;
  el('state').textContent = 'UNSAVED';
  el('state').className = 'badge dirty';
  el('save').disabled = false;
}

function markClean() {
  state.dirty = false;
  el('state').textContent = 'NO CHANGES';
  el('state').className = 'badge';
  el('save').disabled = true;
}

async function save() {
  el('save').disabled = true;
  say('Saving and rebuilding the site…');
  try {
    const result = await api('/overlay', { method: 'PUT', body: state.overlay });
    markClean();
    say(`Saved. The site now has ${result.entries} amiibo.` +
        (result.backup ? ` Previous version kept as ${result.backup}.` : ''), 'ok');
    for (const n of result.notices ?? []) say(`${n.id}: ${n.message}`, 'warn');
  } catch (err) {
    el('save').disabled = false;
    // The server refuses a save that would not build, so this is where a
    // collision or a bad pin shows up rather than after the fact.
    say([err.message, ...(err.details ?? [])].join(' · '), 'err');
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- boot ---------------------------------------------------------------

el('signIn').addEventListener('click', signIn);
el('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
el('signOut').addEventListener('click', signOut);
el('save').addEventListener('click', save);
el('export').addEventListener('click', () => { location.href = '/api/export'; });

let filterTimer = null;
el('q').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyFilter, 120);
});

// Leaving with unsaved edits loses them: the overlay only exists in this tab
// until it is saved.
addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// An existing session skips the login screen.
try {
  const s = await api('/session');
  state.csrf = s.csrf;
  await boot();
} catch {
  el('login').hidden = false;
}
