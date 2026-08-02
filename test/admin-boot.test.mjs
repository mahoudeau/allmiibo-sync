// The admin, actually run.
//
// admin-ui.test.mjs inspects the page without executing it. This file loads
// adminui.js for real against the real page, a real DOM and a stubbed API, and
// drives it: sign in, build the grid, search, filter, edit, revert.
//
// This is the file that would have caught the white screen. adminui.js is a
// module with top-level await — it fetches /api/session as it loads — so a
// broken import or a missing element throws here, at the import, exactly as it
// would in the browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { mountPage, stubFetch } from './helpers/dom.mjs';

register('./helpers/loader.mjs', import.meta.url);

const { AMIIBO_NAMES, AMIIBO_SERIES, AMIIBO_TYPES, AMIIBO_RELEASE, AMIIBO_SERIES_SHORT,
  AMIIBO_FILE_NAMES, AMIIBO_SHORT_NAMES } = await import('../web/data/amiibo-db.js');

/** What the server answers, shaped exactly like server/index.mjs does. */
const DB = {
  names: AMIIBO_NAMES,
  series: AMIIBO_SERIES,
  types: AMIIBO_TYPES,
  release: AMIIBO_RELEASE,
  seriesShort: AMIIBO_SERIES_SHORT,
  fileNames: AMIIBO_FILE_NAMES,
  shortNames: AMIIBO_SHORT_NAMES,
  categories: {}, paths: {}, notes: {}, authored: {}, upstream: {},
};

/**
 * Load the admin with a session already established, so it boots straight into
 * the app rather than the sign-in form.
 *
 * Each call gets its own module instance: adminui.js holds state at module
 * scope, so a shared one would leak edits between tests.
 */
const BACKUPS = [
  '2026-07-31T14-05-09-123Z.json',
  '2026-07-30T09-12-44-000Z.json',
];

// The preview the admin renders, produced by the real diff over a real
// database rather than written out by hand.
//
// A hand-built fixture is exactly how the old screen's tests stayed green while
// the screen was wrong: the fixture said what the test author believed, not
// what the module produces. This mutates the committed database the way
// upstream did — two amiibo in a brand new series — and lets dbdiff describe it.
const { readFileSync } = await import('node:fs');
const { diffDatabases } = await import('../web/js/dbdiff.js');

const LIVE = readFileSync(new URL('../web/data/amiibo-db.js', import.meta.url), 'utf8');
const GRACE = '3540000005032002';
const LEON = '3541000005042002';
const SERIES = 32;

// The BEFORE is the committed database with these entries taken OUT, and the
// AFTER is that same text with them put back. Removing first is what makes the
// pair independent of upstream: this exact update has since been applied, so
// building the AFTER by addition alone produced a database with duplicate keys
// and no difference to describe, and thirteen tests failed at once. A fixture
// that assumes what upstream does not yet have expires the moment it does.
const without = (text, ...lines) => text.split('\n')
  .filter((l) => !lines.some((n) => l.startsWith(n)))
  .join('\n');

const BEFORE_TEXT = without(LIVE,
  `  '${GRACE}'`, `  '${LEON}'`, `  ${SERIES}: `);

const AFTER_TEXT = BEFORE_TEXT
  .replace('export const AMIIBO_NAMES = Object.freeze({\n',
    'export const AMIIBO_NAMES = Object.freeze({\n'
    + `  '${GRACE}': "Grace Ashcroft",\n  '${LEON}': "Leon S. Kennedy",\n`)
  .replace('export const AMIIBO_RELEASE = Object.freeze({\n',
    'export const AMIIBO_RELEASE = Object.freeze({\n'
    + `  '${GRACE}': '2026-07-30',\n  '${LEON}': '2026-07-30',\n`)
  .replace('export const AMIIBO_SERIES = Object.freeze({\n',
    `export const AMIIBO_SERIES = Object.freeze({\n  ${SERIES}: "Resident Evil",\n`);

const PREVIEW = {
  pending: {
    fetchedAt: '2026-08-01T10-00-00-000Z',
    sources: [
      { name: 'db_amiibo.c', changed: true },
      { name: 'amiibo.json', changed: false },
    ],
  },
  ok: true,
  errors: [],
  fingerprint: 'fp-1',
  report: { entries: 948, mintedSeries: [] },
  diff: diffDatabases(BEFORE_TEXT, AFTER_TEXT),
};

// Artwork is compared against an image index rather than against the database,
// and by its own request — which is what lets the screen report honest progress
// instead of one long silence. The IDs come from the database being reviewed so
// the rows can show real names.
const ARTWORK = {
  added: [{ id: GRACE, sha: 'a'.repeat(40), size: 1234 }],
  changed: [{ id: '0000000000000002', sha: 'b'.repeat(40), was: 'c'.repeat(40), size: 4321 }],
  removed: [],
  unchanged: 945,
  held: 0,
  upstreamCount: 947,
  localCount: 946,
};

let instance = 0;
async function bootAdmin({
  overlay = { schema: 1, amiibos: {} },
  upstreamReady = true,
  preview = PREVIEW,
  artwork = ARTWORK,
  artworkRoute = null,
} = {}) {
  const page = mountPage('admin/index.html');
  const fetch = stubFetch({
    '/api/session': { csrf: 'test-token' },
    '/api/db': DB,
    '/api/overlay': { overlay, upstreamReady },
    'PUT /api/overlay': { entries: 946, backup: '2026-01-01T09-30-00-000Z.json', notices: [] },
    '/api/backups': { backups: BACKUPS },
    'POST /api/restore': { ok: true, entries: 946, restored: BACKUPS[0] },
    'POST /api/upstream/refresh': { ok: true, changed: true, fetchedAt: '2026-08-01T10-00-00-000Z' },
    'DELETE /api/upstream/pending': { ok: true },
    '/api/artwork': artworkRoute ?? { ok: true, artwork },
    'POST /api/artwork/apply': {
      ok: true,
      artwork: { fetched: 2, cached: 0, noArtwork: [], failed: [], tiers: { skipped: false } },
      artworkSummary: 'Artwork: 2 fetched.',
    },
    '/api/upstream/preview': preview,
    'POST /api/upstream/apply': {
      ok: true,
      entries: 947,
      applied: { pinsWritten: 0 },
      renames: [],
      artwork: { fetched: 2, cached: 0, noArtwork: [], failed: [], tiers: { skipped: false } },
      artworkSummary: 'Artwork: 2 fetched.',
    },
    'POST /api/logout': {},
  });
  globalThis.fetch = fetch;

  // Cache-busted so each test drives a fresh module, not the first one's state.
  await import(`../admin/adminui.js?t=${instance++}`);
  return { page, fetch };
}

test('the admin boots: session, database, overlay, and a grid on screen', async () => {
  const { page, fetch } = await bootAdmin();
  try {
    assert.equal(page.byId('login').hidden, true, 'the sign-in form steps aside');
    assert.equal(page.byId('app').hidden, false, 'and the app appears');
    assert.equal(document.documentElement.dataset.adminBooted, '1',
      'the watchdog mark is set, so the boot-failure notice stays hidden');

    const asked = fetch.calls.map((c) => c.path);
    assert.ok(asked.includes('/api/session'));
    assert.ok(asked.includes('/api/db'));
    assert.ok(asked.includes('/api/overlay'));
    assert.ok(asked.every((p) => p.startsWith('/api/')),
      'every request is relative, so the module never learns its own host');

    assert.ok(page.$$('details.series').length > 20, 'the grid has the series');
    assert.equal(page.$$('.item').length, Number(page.byId('statTotal').textContent),
      'the headline count is the number of cells actually drawn');
  } finally {
    page.restore();
  }
});

test('the mascot and the icons are drawn, not left as empty spans', async () => {
  const { page } = await bootAdmin();
  try {
    assert.ok(page.$('[data-pirate-mark] svg'), 'the brand bar has its mascot');
    for (const node of page.$$('[data-ico]')) {
      assert.match(node.innerHTML, /<svg/, `${node.dataset.ico} was hydrated`);
    }
  } finally {
    page.restore();
  }
});

test('the admin mounts the site bar with its own contents, and no nav', async () => {
  const { page } = await bootAdmin();
  try {
    const bar = page.$('header.appHeader .appBar');
    assert.ok(bar, 'the shared bar is mounted');
    assert.ok(bar.children.length > 1, 'and it has something for its gap to space');

    // The wordmark is the admin's, not the site's.
    assert.match(page.$('.brand .wm').textContent, /ALLMIIBO-ADMIN/);
    assert.equal(page.$('a.brand'), null,
      'the brand is not a link: it would point at the public site');

    assert.equal(page.$('nav'), null, 'no nav entries yet');
    assert.equal(page.$$('a[href$=".html"]').length, 0,
      'and nothing linking to a page this host does not serve');

    // The two preferences that mean something here, and not the three that do not.
    assert.ok(page.byId('themeRow'), 'the theme switcher is reachable from the admin');
    assert.ok(page.byId('pirateRow'), 'and the mascot colourway');
    assert.equal(page.byId('advToggle'), null, 'Advanced gates nothing in the admin');
    assert.equal(page.byId('showHhdToggle'), null, 'the HHD toggle is a collection concern');
    assert.equal(page.$('.dbgLink'), null, 'and DEBUG points at a page the admin does not serve');

    // The actions moved into the bar rather than being left behind.
    assert.ok(bar.contains(page.byId('save')), 'SAVE sits in the bar');
    assert.equal(page.byId('adminActions').hidden, false);
  } finally {
    page.restore();
  }
});

test('the filter pills count what they claim to', async () => {
  const ids = Object.keys(AMIIBO_NAMES).slice(0, 3);
  const overlay = {
    schema: 1,
    amiibos: {
      [ids[0]]: { kind: 'override', name: 'Renamed' },
      [ids[1]]: { kind: 'new', name: 'Invented' },
    },
  };
  const { page } = await bootAdmin({ overlay });
  try {
    const counts = Object.fromEntries(page.$$('#filters .pill').map((p) => [
      p.querySelector('input').value,
      Number(p.querySelector('.n').textContent),
    ]));
    assert.equal(counts.all, page.$$('.item').length);
    assert.equal(counts.curated, 2, 'both overlay entries are curated');
    assert.equal(counts.authored, 1, 'only the kind:new one is authored');
  } finally {
    page.restore();
  }
});

test('a curated entry shows its overlay name, not the upstream one', async () => {
  const id = Object.keys(AMIIBO_NAMES)[0];
  const upstream = AMIIBO_NAMES[id];
  const overlay = { schema: 1, amiibos: { [id]: { kind: 'override', name: 'Renamed Here' } } };
  const { page } = await bootAdmin({ overlay });
  try {
    const cell = page.$(`.item[data-id="${id}"]`);
    assert.ok(cell, 'the curated amiibo has a cell');
    assert.equal(cell.querySelector('.nm').textContent, 'Renamed Here',
      'the grid shows what a visitor will see once published');
    assert.notEqual(upstream, 'Renamed Here', 'the test is actually changing something');

    const tag = cell.querySelector('.tag');
    assert.equal(tag.hidden, false);
    assert.equal(tag.textContent, 'CURATED');
  } finally {
    page.restore();
  }
});

test('searching finds an amiibo by its curated name as well as its upstream one', async () => {
  const id = Object.keys(AMIIBO_NAMES)[0];
  const upstream = AMIIBO_NAMES[id];
  const overlay = { schema: 1, amiibos: { [id]: { kind: 'override', name: 'Zorblax' } } };
  const { page } = await bootAdmin({ overlay });
  try {
    // The typing path is debounced, so drive the undebounced one: setting the
    // field and pressing Escape clears, and the search runs on the sort change
    // and the clear button. Dispatching input then flushing the timer is what a
    // browser does; here the change event on #sortMode calls applyFilter
    // directly with whatever the field holds.
    const search = (q) => {
      page.byId('q').value = q;
      page.byId('sortMode').dispatchEvent(new page.window.Event('change'));
      return page.$$('.item').filter((c) => !c.hidden);
    };

    const byCurated = search('zorblax');
    assert.equal(byCurated.length, 1, 'the curated name is searchable');
    assert.equal(byCurated[0].dataset.id, id);

    const byUpstream = search(upstream.toLowerCase());
    assert.ok(byUpstream.some((c) => c.dataset.id === id),
      'and so is the upstream name, so a rename does not lose the amiibo');

    assert.equal(search('zzzznotanamiibo').length, 0);
    assert.equal(page.byId('emptyState').hidden, false, 'and it says so');
    assert.match(page.byId('emptyState').textContent, /NO AMIIBO MATCH/);

    assert.equal(search('').length, page.$$('.item').length, 'clearing restores everything');
    assert.equal(page.byId('emptyState').hidden, true);
  } finally {
    page.restore();
  }
});

test('a search hit opens its series, which is otherwise collapsed', async () => {
  const { page } = await bootAdmin();
  try {
    assert.equal(page.$$('details.series').filter((d) => d.open).length, 0,
      'everything starts collapsed');

    const id = page.$('.item').dataset.id;
    page.byId('q').value = id;
    page.byId('sortMode').dispatchEvent(new page.window.Event('change'));

    const showing = page.$$('details.series').filter((d) => !d.hidden);
    assert.equal(showing.length, 1);
    assert.equal(showing[0].open, true,
      'a match inside a closed series would look like no match at all');
  } finally {
    page.restore();
  }
});

test('editing a field marks the page dirty and enables SAVE', async () => {
  const { page } = await bootAdmin();
  try {
    assert.equal(page.byId('save').disabled, true, 'nothing to save on a clean load');
    assert.equal(page.byId('statState').textContent, 'SAVED');

    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));

    const input = page.byId('f-name');
    assert.ok(input, 'selecting an amiibo opens the editor with a NAME field');

    input.value = 'A New Name';
    input.dispatchEvent(new page.window.Event('input'));

    assert.equal(page.byId('save').disabled, false, 'SAVE is now available');
    assert.equal(page.byId('statState').textContent, 'UNSAVED');
    assert.equal(page.byId('statEdited').textContent, '1', 'one curated entry');
    assert.equal(page.$(`.item[data-id="${id}"] .nm`).textContent, 'A New Name',
      'the grid follows the edit without a rebuild');
  } finally {
    page.restore();
  }
});

test('clearing a field back to empty removes the entry rather than storing a blank', async () => {
  // The overlay is a sparse set of differences. An empty string stored as an
  // override would publish a nameless amiibo.
  const { page } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));

    const input = page.byId('f-name');
    input.value = 'Temporary';
    input.dispatchEvent(new page.window.Event('input'));
    assert.equal(page.byId('statEdited').textContent, '1');

    input.value = '';
    input.dispatchEvent(new page.window.Event('input'));
    assert.equal(page.byId('statEdited').textContent, '0', 'the entry is gone, not blank');
    assert.equal(page.$(`.item[data-id="${id}"] .tag`).hidden, true,
      'and the CURATED mark is gone with it');
  } finally {
    page.restore();
  }
});

test('REVERT drops an amiibo\'s edits and puts its upstream name back', async () => {
  const id = Object.keys(AMIIBO_NAMES)[0];
  const upstream = AMIIBO_NAMES[id];
  const overlay = { schema: 1, amiibos: { [id]: { kind: 'override', name: 'Wrong' } } };
  const { page } = await bootAdmin({ overlay });
  try {
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));
    const revert = page.$$('#editor button').find((b) => b.textContent.includes('REVERT'));
    assert.ok(revert, 'the editor offers a revert');
    assert.equal(revert.disabled, false, 'enabled, because this one is curated');

    revert.dispatchEvent(new page.window.Event('click'));
    assert.equal(page.$(`.item[data-id="${id}"] .nm`).textContent, upstream);
    assert.equal(page.byId('statEdited').textContent, '0');
  } finally {
    page.restore();
  }
});

test('an unbuilt upstream cache is said out loud rather than failing at save time', async () => {
  const { page } = await bootAdmin({ upstreamReady: false });
  try {
    const status = page.byId('status');
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /have not been fetched/i);
  } finally {
    page.restore();
  }
});

// ---- the detail preview -------------------------------------------------

test('selecting an amiibo shows the same panel a visitor sees', async () => {
  const { page } = await bootAdmin();
  try {
    assert.equal(page.$('.preview'), null, 'nothing previewed before a selection');

    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));

    const preview = page.$('.preview');
    assert.ok(preview, 'the panel is mounted');
    assert.ok(preview.querySelector('.portrait'), 'with the portrait');
    assert.ok(preview.querySelector('.facts h1'), 'the name');
    assert.ok(preview.querySelector('.badges'), 'and the badges');

    // The artwork comes from the admin's root, not the site's relative one.
    assert.match(preview.querySelector('.portrait img').getAttribute('src'),
      /^\/data\/images\/full\/[0-9a-f]{16}\.png$/);

    // Trimmed for a side panel: no scan here, and 91 tiles would not fit.
    assert.equal(preview.querySelector('.fileBlock'), null);
    assert.equal(preview.querySelector('.cardGrid'), null);
  } finally {
    page.restore();
  }
});

test('the preview follows an edit as it is typed, without a reselect', async () => {
  // This test used to reselect the amiibo before asserting, with a comment
  // explaining that the editor redraws on selection. That was not a caveat, it
  // was the bug: the heading kept the old name while the field beside it held
  // the new one, and the grid cell had already updated. The preview's whole
  // claim is that it shows the published result.
  const { page } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));

    const heading = () => page.$('.preview .facts h1').textContent.trim();
    const upstream = heading();
    assert.ok(upstream.length > 0);

    const input = page.byId('f-name');
    input.value = 'Curated Name';
    input.dispatchEvent(new page.window.Event('input'));

    assert.equal(heading(), 'Curated Name',
      'the preview updates on the edit itself, not on the next selection');
    assert.notEqual(heading(), upstream, 'the test is actually changing something');
    assert.equal(page.$(`.item[data-id="${id}"] .nm`).textContent, 'Curated Name',
      'and the grid agrees with it');

    // Clearing the field puts the upstream value back, both places.
    input.value = '';
    input.dispatchEvent(new page.window.Event('input'));
    assert.equal(heading(), upstream);
    assert.equal(page.$(`.item[data-id="${id}"] .nm`).textContent, upstream);
  } finally {
    page.restore();
  }
});

test('editing the release year updates the previewed subtitle too', async () => {
  const { page } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));

    const subtitle = () => page.$('.preview .facts .subtitle').textContent.trim();
    const before = subtitle();

    const input = page.byId('f-release');
    input.value = '1999-12-31';
    input.dispatchEvent(new page.window.Event('input'));

    assert.match(subtitle(), /1999/, 'the year in the subtitle follows the field');
    assert.notEqual(subtitle(), before);
    // The rest of the line is untouched: series and type do not come from here.
    assert.match(subtitle(), /·/);
  } finally {
    page.restore();
  }
});

test('the pencil survives an edit rather than being written over', async () => {
  // The previewed parts carry an appended button, so an update that used
  // textContent would silently delete it.
  const { page } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));
    assert.ok(page.$('.preview .facts h1 .editPart'), 'the heading has its pencil');

    const input = page.byId('f-name');
    input.value = 'Something Else';
    input.dispatchEvent(new page.window.Event('input'));

    assert.ok(page.$('.preview .facts h1 .editPart'), 'and still has it after an edit');
    assert.equal(page.$('.preview .facts h1').textContent.trim(), 'Something Else');
  } finally {
    page.restore();
  }
});

test('a previewed value carries a pencil that focuses the field behind it', async () => {
  const { page } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));

    const pencils = page.$$('.preview .editPart');
    assert.ok(pencils.length >= 1, 'at least the name has one');
    for (const p of pencils) {
      assert.match(p.innerHTML, /<svg/, 'and it is drawn, not an empty button');
      assert.match(p.title, /^Edit /);
    }
    // The parts with no editable field behind them get none.
    assert.equal(page.$('.preview .idRow .editPart'), null);
  } finally {
    page.restore();
  }
});

// ---- selection, validation and the confirm gate -------------------------

test('exactly one cell is marked selected, and it is a state not a class', async () => {
  const { page } = await bootAdmin();
  try {
    const cells = page.$$('.item');
    assert.ok(cells.every((c) => c.getAttribute('aria-pressed') === 'false'),
      'nothing is selected on load, and every cell says so');

    cells[0].dispatchEvent(new page.window.Event('click'));
    cells[5].dispatchEvent(new page.window.Event('click'));

    const pressed = cells.filter((c) => c.getAttribute('aria-pressed') === 'true');
    assert.equal(pressed.length, 1, 'the previous selection is cleared');
    assert.equal(pressed[0], cells[5]);
    assert.equal(page.$('.picked'), null, 'and no class shadows the state');
  } finally {
    page.restore();
  }
});

test('a refused value is explained under its own field, and blocks SAVE', async () => {
  const { page } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));

    const path = page.byId('f-path');
    path.value = '../escape.bin';
    path.dispatchEvent(new page.window.Event('input'));

    const field = path.closest('.field');
    assert.equal(field.classList.contains('bad'), true, 'the field is marked');
    const why = field.querySelector('.why');
    assert.equal(why.hidden, false, 'and says why, where it happened');
    assert.match(why.textContent, /\.\./, 'naming the actual problem');
    assert.equal(page.byId('save').disabled, true,
      'SAVE waits: the server would refuse this after a round trip');
    assert.equal(page.byId('statState').textContent, 'INVALID');

    path.value = 'SSB/Mario.bin';
    path.dispatchEvent(new page.window.Event('input'));
    assert.equal(field.classList.contains('bad'), false, 'and clears when corrected');
    assert.equal(why.hidden, true);
    assert.equal(page.byId('save').disabled, false);
  } finally {
    page.restore();
  }
});

test('a pin on an amiibo whose ID stands for many dumps is refused inline', async () => {
  // Kirby Air Riders characters have four vehicle pairings per ID, so one
  // pinned path would collapse them. The overlay module already knew; the
  // admin never showed it.
  const { page } = await bootAdmin();
  try {
    const airRider = page.$$('.item').map((c) => c.dataset.id)
      .find((id) => parseInt(id.slice(12, 14), 16) === 0x1e);
    assert.ok(airRider, 'the database has an Air Riders entry to test with');

    page.$(`.item[data-id="${airRider}"]`).dispatchEvent(new page.window.Event('click'));
    const path = page.byId('f-path');
    path.value = 'AIR/Kirby.bin';
    path.dispatchEvent(new page.window.Event('input'));

    assert.equal(path.closest('.field').classList.contains('bad'), true);
    assert.match(path.closest('.field').querySelector('.why').textContent, /collapse/);
    assert.equal(page.byId('save').disabled, true);
  } finally {
    page.restore();
  }
});

test('SAVE asks before it publishes, and CANCEL means nothing is published', async () => {
  // The assertion that matters is the cancel one. "A dialog appeared" passes
  // just as well when the answer is ignored, so it proves nothing on its own.
  const { page, fetch } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));
    const input = page.byId('f-name');
    input.value = 'Published Name';
    input.dispatchEvent(new page.window.Event('input'));

    const puts = () => fetch.calls.filter((c) => c.method === 'PUT').length;
    const settle = () => new Promise((r) => setTimeout(r, 0));

    // Ask, then decline.
    page.byId('save').dispatchEvent(new page.window.Event('click'));
    await settle();
    const dialog = page.$('dialog.nesDialog');
    assert.ok(dialog, 'a confirm is on screen');
    assert.match(dialog.textContent, /PUBLISH/);
    assert.equal(puts(), 0, 'nothing is published while it is open');

    dialog.querySelector('.dCancel').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(puts(), 0, 'declining publishes nothing at all');
    assert.equal(page.byId('save').disabled, false, 'and leaves the edit intact');

    // Ask again, and accept.
    page.byId('save').dispatchEvent(new page.window.Event('click'));
    await settle();
    page.$('dialog.nesDialog .dConfirm').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(puts(), 1, 'accepting publishes exactly once');
  } finally {
    page.restore();
  }
});

test('the grid is the collection page grid, with the same classes app.css styles', async () => {
  const { page } = await bootAdmin();
  try {
    const first = page.$('details.series');
    assert.ok(first.querySelector('summary .seriesHead'), 'series head');
    assert.ok(first.querySelector('.sPill'), 'and a completion pill');
    assert.ok(first.querySelector('.items .item .art img'), 'and cells with artwork');
    assert.ok(page.byId('series').classList.contains('cards'), 'cards view by default');

    const img = page.$('.item .art img');
    assert.match(img.src, /^\/data\/images\/thumb\/[0-9a-f]{16}\.png$/,
      'artwork comes from the site, by ID, and the path is not built from user input');
  } finally {
    page.restore();
  }
});

// ---- backups ------------------------------------------------------------

test('the backups drawer lists what the server has, newest first', async () => {
  const { page } = await bootAdmin();
  try {
    // Loaded on boot rather than on open: the count is the point of a
    // collapsed drawer.
    await new Promise((r) => setTimeout(r, 0));

    // The attribute, not the property: linkedom does not reflect `open`, and
    // the markup is what is under test here.
    assert.equal(page.byId('backupsDrawer').hasAttribute('open'), false,
      'collapsed by default');
    assert.equal(page.byId('backupCount').textContent, String(BACKUPS.length));

    const rows = page.$$('#backupList li');
    assert.equal(rows.length, BACKUPS.length);
    assert.equal(rows[0].querySelector('span').title, BACKUPS[0],
      'the raw name is kept for the request');
    assert.equal(rows[0].querySelector('span').textContent, '2026-07-31 14:05:09',
      'and a readable stamp is shown');

    for (const row of rows) {
      const labels = [...row.querySelectorAll('button')].map((b) => b.textContent);
      assert.deepEqual(labels, ['DOWNLOAD', 'RESTORE']);
    }
  } finally {
    page.restore();
  }
});

test('an empty backup list says so rather than showing nothing', async () => {
  const page = mountPage('admin/index.html');
  globalThis.fetch = stubFetch({
    '/api/session': { csrf: 't' },
    '/api/db': DB,
    '/api/overlay': { overlay: { schema: 1, amiibos: {} }, upstreamReady: true },
    '/api/backups': { backups: [] },
  });
  try {
    await import(`../admin/adminui.js?t=${instance++}`);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(page.byId('backupCount').textContent, '0');
    assert.match(page.byId('backupList').textContent, /No backups yet/);
  } finally {
    page.restore();
  }
});

test('RESTORE asks first, and declining restores nothing', async () => {
  const { page, fetch } = await bootAdmin();
  try {
    await new Promise((r) => setTimeout(r, 0));
    const settle = () => new Promise((r) => setTimeout(r, 0));
    const restores = () => fetch.calls.filter((c) => c.path === '/api/restore').length;

    const button = [...page.$$('#backupList button')].find((b) => b.textContent === 'RESTORE');
    button.dispatchEvent(new page.window.Event('click'));
    await settle();

    const dialog = page.$('dialog.nesDialog');
    assert.ok(dialog, 'a confirm is on screen');
    assert.match(dialog.textContent, /RESTORE THIS BACKUP/);
    assert.match(dialog.textContent, /can be undone/, 'and says it is reversible');
    assert.equal(restores(), 0);

    dialog.querySelector('.dCancel').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(restores(), 0, 'declining restores nothing');

    button.dispatchEvent(new page.window.Event('click'));
    await settle();
    page.$('dialog.nesDialog .dConfirm').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(restores(), 1, 'accepting restores once');
    assert.equal(fetch.calls.find((c) => c.path === '/api/restore').method, 'POST');
  } finally {
    page.restore();
  }
});

test('restoring over unsaved edits asks about them separately', async () => {
  const { page, fetch } = await bootAdmin();
  try {
    await new Promise((r) => setTimeout(r, 0));
    const settle = () => new Promise((r) => setTimeout(r, 0));

    // Make an edit, so the overlay in this tab differs from disk.
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));
    const input = page.byId('f-name');
    input.value = 'Unsaved';
    input.dispatchEvent(new page.window.Event('input'));

    const button = [...page.$$('#backupList button')].find((b) => b.textContent === 'RESTORE');
    button.dispatchEvent(new page.window.Event('click'));
    await settle();

    const dialog = page.$('dialog.nesDialog');
    assert.match(dialog.textContent, /DISCARD YOUR UNSAVED EDITS/,
      'the edits are asked about before the backup is');
    dialog.querySelector('.dCancel').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(fetch.calls.filter((c) => c.path === '/api/restore').length, 0);
    assert.equal(page.byId('save').disabled, false, 'and the edit survives');
  } finally {
    page.restore();
  }
});

test('EXPORT fetches rather than navigating, so a failure is a message', async () => {
  // The bug: location.href = '/api/export' bypasses the api() wrapper, so an
  // expired session saved the 401 body as a file called amiibo-overrides.json.
  const page = mountPage('admin/index.html');
  const fetch = stubFetch({
    '/api/session': { csrf: 't' },
    '/api/db': DB,
    '/api/overlay': { overlay: { schema: 1, amiibos: {} }, upstreamReady: true },
    '/api/backups': { backups: [] },
    '/api/export': { status: 401, body: { error: 'not signed in' } },
  });
  globalThis.fetch = fetch;
  const navigated = [];
  try {
    await import(`../admin/adminui.js?t=${instance++}`);
    await new Promise((r) => setTimeout(r, 0));

    // Anything that navigated would have set location.href.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: new Proxy({}, { set: (_, k, v) => { navigated.push(`${String(k)}=${v}`); return true; } }),
    });

    page.byId('export').dispatchEvent(new page.window.Event('click'));
    await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(navigated, [], 'the page did not navigate to the API');
    assert.ok(fetch.calls.some((c) => c.path === '/api/export'), 'it fetched instead');
    assert.equal(page.byId('status').hidden, false);
    assert.match(page.byId('status').textContent, /Download failed/,
      'and the failure is said out loud rather than saved as a file');
  } finally {
    page.restore();
  }
});

// ---- authoring a new amiibo ---------------------------------------------
//
// The schema, applyOverlay and the generator have supported kind:'new' since
// the overlay existed; there was simply no way to create one, so the AUTHORED
// filter could never be anything but zero.

const FREE_ID = 'ffff000000000002';        // decodes cleanly, upstream has it not
const UNLABELLED_SERIES_ID = 'ffff000000000802'; // series byte 08 has no name

/** Open the create form and return its fields. */
function openNewForm(page) {
  page.byId('newAmiibo').dispatchEvent(new page.window.Event('click'));
  return {
    id: page.byId('n-id'),
    name: page.byId('n-name'),
    create: [...page.$$('#editor button')].find((b) => b.textContent === 'CREATE'),
    cancel: [...page.$$('#editor button')].find((b) => b.textContent === 'CANCEL'),
    problem: (input) => {
      const why = input.closest('.field').querySelector('.why');
      return why.hidden ? null : why.textContent;
    },
  };
}

const type = (input, value, page) => {
  input.value = value;
  input.dispatchEvent(new page.window.Event('input'));
};

test('an authored amiibo appears in the grid before it is ever saved', async () => {
  const { page } = await bootAdmin();
  try {
    const before = page.$$('.item').length;
    assert.equal(page.$(`.item[data-id="${FREE_ID}"]`), null, 'not there to begin with');

    const form = openNewForm(page);
    type(form.id, FREE_ID, page);
    type(form.name, 'Invented Fighter', page);
    assert.equal(form.create.disabled, false);
    form.create.dispatchEvent(new page.window.Event('click'));

    const cell = page.$(`.item[data-id="${FREE_ID}"]`);
    assert.ok(cell, 'the new amiibo has a cell immediately');
    assert.equal(cell.querySelector('.nm').textContent, 'Invented Fighter');
    assert.equal(cell.querySelector('.tag').textContent, 'AUTHORED');
    assert.equal(page.$$('.item').length, before + 1);

    // It landed in the series its ID names, not in a bucket of its own.
    assert.equal(Number(cell.closest('details.series').dataset.series), 0);

    assert.equal(page.byId('save').disabled, false, 'and there is something to save');
    assert.equal(cell.getAttribute('aria-pressed'), 'true', 'and it is selected');
  } finally {
    page.restore();
  }
});

test('the AUTHORED filter finally counts something', async () => {
  const { page } = await bootAdmin();
  try {
    const count = () => Number(
      page.$('#filters input[value="authored"]').closest('.pill').querySelector('.n').textContent);
    assert.equal(count(), 0);

    const form = openNewForm(page);
    type(form.id, FREE_ID, page);
    type(form.name, 'Invented Fighter', page);
    form.create.dispatchEvent(new page.window.Event('click'));

    assert.equal(count(), 1, 'the filter is no longer permanently zero');
  } finally {
    page.restore();
  }
});

test('an ID that cannot work is refused with the reason, before saving', async () => {
  const { page } = await bootAdmin();
  try {
    const form = openNewForm(page);
    const upstreamId = Object.keys(AMIIBO_NAMES)[0];

    type(form.name, 'Something', page);

    type(form.id, 'nothex', page);
    assert.match(form.problem(form.id), /16 lowercase hex/);
    assert.equal(form.create.disabled, true);

    type(form.id, upstreamId, page);
    assert.match(form.problem(form.id), /Upstream already has this ID/);
    assert.equal(form.create.disabled, true);

    // The one that would otherwise fail at save time with an error about the
    // build rather than about the ID.
    type(form.id, UNLABELLED_SERIES_ID, page);
    assert.match(form.problem(form.id), /Series byte 08 has no name/);
    assert.equal(form.create.disabled, true);

    type(form.id, FREE_ID, page);
    assert.equal(form.problem(form.id), null);
    assert.equal(form.create.disabled, false);
  } finally {
    page.restore();
  }
});

test('the form shows what the ID means as it is typed', async () => {
  // Typing sixteen hex characters blind is how an amiibo ends up in the wrong
  // series, and the bytes are the only thing that decides it.
  const { page } = await bootAdmin();
  try {
    const form = openNewForm(page);
    const decoded = () => form.id.closest('.field').querySelector('.was').textContent;

    assert.equal(decoded(), '', 'nothing to say yet');
    type(form.id, FREE_ID, page);
    // Read from the table, not written out: a series name is curated data and
    // renaming one must not fail a test about decoding bytes.
    assert.ok(decoded().includes(AMIIBO_SERIES[0]), 'the series the bytes name');
    assert.ok(decoded().includes(AMIIBO_TYPES[0]), 'and the type');
  } finally {
    page.restore();
  }
});

test('an authored amiibo needs a name, and says so', async () => {
  const { page } = await bootAdmin();
  try {
    const form = openNewForm(page);
    type(form.id, FREE_ID, page);
    assert.equal(form.create.disabled, true, 'an ID alone is not enough');
    assert.match(form.problem(form.name), /needs a name/);

    type(form.name, 'Named', page);
    assert.equal(form.create.disabled, false);
    assert.equal(form.problem(form.name), null);
  } finally {
    page.restore();
  }
});

test('CANCEL leaves the overlay alone', async () => {
  const { page } = await bootAdmin();
  try {
    const before = page.$$('.item').length;
    const form = openNewForm(page);
    type(form.id, FREE_ID, page);
    type(form.name, 'Never Created', page);
    form.cancel.dispatchEvent(new page.window.Event('click'));

    assert.equal(page.$$('.item').length, before, 'nothing was added');
    assert.equal(page.byId('save').disabled, true, 'and nothing to save');
    assert.equal(page.byId('n-id'), null, 'the form is gone');
  } finally {
    page.restore();
  }
});

test('deleting an authored amiibo removes it, and asks first', async () => {
  // Reverting an override falls back to upstream. An authored entry has
  // nothing to fall back to, so the button says DELETE and confirms.
  const { page } = await bootAdmin();
  try {
    const before = page.$$('.item').length;
    const form = openNewForm(page);
    type(form.id, FREE_ID, page);
    type(form.name, 'Short Lived', page);
    form.create.dispatchEvent(new page.window.Event('click'));
    assert.equal(page.$$('.item').length, before + 1);

    const button = [...page.$$('#editor button')].find((b) => b.textContent.includes('DELETE'));
    assert.ok(button, 'the button says DELETE, not REVERT');
    assert.equal(button.classList.contains('danger'), true);

    const settle = () => new Promise((r) => setTimeout(r, 0));
    button.dispatchEvent(new page.window.Event('click'));
    await settle();
    page.$('dialog.nesDialog .dCancel').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(page.$$('.item').length, before + 1, 'declining keeps it');

    button.dispatchEvent(new page.window.Event('click'));
    await settle();
    page.$('dialog.nesDialog .dConfirm').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(page.$$('.item').length, before, 'accepting removes it entirely');
    assert.equal(page.$(`.item[data-id="${FREE_ID}"]`), null);
  } finally {
    page.restore();
  }
});

test('an existing amiibo still says REVERT, not DELETE', async () => {
  const { page } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));
    const button = [...page.$$('#editor button')].find((b) => b.textContent.includes('AMIIBO'));
    assert.match(button.textContent, /REVERT/);
    assert.equal(button.classList.contains('danger'), false);
  } finally {
    page.restore();
  }
});

// ---- series --------------------------------------------------------------
//
// A series is a byte in the amiibo ID, not a record. So "creating" one means
// naming a byte upstream has not named, and editing one covers the three
// things a curator controls: the label, the folder token that names a
// directory on every synced device, and which amiibo's artwork stands for it.

/** Open the series editor from a series header. */
function openSeries(page, byte = 0) {
  const head = page.$(`details.series[data-series="${byte}"] .seriesEdit`);
  head.dispatchEvent(new page.window.Event('click'));
  return {
    label: page.byId('s-label'),
    token: page.byId('s-short'),
    face: page.byId('s-face'),
    cost: page.$('#editor .tokenCost'),
    problem: (input) => {
      const why = input.closest('.field').querySelector('.why:not(.tokenCost)');
      return why?.hidden ? null : why?.textContent;
    },
  };
}

test('a series header opens its editor without toggling the group', async () => {
  const { page } = await bootAdmin();
  try {
    const group = page.$('details.series[data-series="0"]');
    const wasOpen = group.open;

    const form = openSeries(page);
    assert.ok(form.label, 'the editor is on screen');
    assert.ok(form.token);
    assert.ok(form.face);
    assert.equal(group.open, wasOpen,
      'clicking inside a <summary> would otherwise expand it as well');
  } finally {
    page.restore();
  }
});

test('renaming a series updates its header as it is typed', async () => {
  const { page } = await bootAdmin();
  try {
    const headText = () => page.$('details.series[data-series="0"] .seriesHead')
      .textContent.trim();
    const before = headText();

    const form = openSeries(page);
    form.label.value = 'Smash Bros';
    form.label.dispatchEvent(new page.window.Event('input'));

    assert.match(headText(), /Smash Bros/);
    assert.notEqual(headText(), before);
    assert.equal(page.byId('save').disabled, false);
  } finally {
    page.restore();
  }
});

test('changing the folder token says what it costs, in device paths', async () => {
  // The most expensive thing this screen can do, and invisible in a list of
  // edited names: it renames a directory on every device already synced.
  const { page } = await bootAdmin();
  try {
    const form = openSeries(page);
    assert.equal(form.cost.hidden, true, 'nothing said until it changes');

    form.token.value = 'SMASH';
    form.token.dispatchEvent(new page.window.Event('input'));

    assert.equal(form.cost.hidden, false);
    assert.match(form.cost.textContent, /E:\/amiibo\/SSB\//, 'the path it is now');
    assert.match(form.cost.textContent, /E:\/amiibo\/SMASH\//, 'and the path it becomes');
    assert.match(form.cost.textContent, /files move on the next sync/);
  } finally {
    page.restore();
  }
});

test('publishing a folder rename asks for it separately, and CANCEL stops it', async () => {
  const { page, fetch } = await bootAdmin();
  try {
    const form = openSeries(page);
    form.token.value = 'SMASH';
    form.token.dispatchEvent(new page.window.Event('input'));

    const settle = () => new Promise((r) => setTimeout(r, 0));
    const puts = () => fetch.calls.filter((c) => c.method === 'PUT').length;

    page.byId('save').dispatchEvent(new page.window.Event('click'));
    await settle();
    const dialog = page.$('dialog.nesDialog');
    assert.match(dialog.textContent, /RENAME/, 'the rename is asked about first');
    assert.match(dialog.textContent, /E:\/amiibo\/SSB\/ → E:\/amiibo\/SMASH\//);
    assert.equal(puts(), 0);

    dialog.querySelector('.dCancel').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(puts(), 0, 'declining publishes nothing');
  } finally {
    page.restore();
  }
});

test('a folder token that is not one folder is refused', async () => {
  const { page } = await bootAdmin();
  try {
    const form = openSeries(page);
    form.token.value = 'a/b';
    form.token.dispatchEvent(new page.window.Event('input'));

    assert.match(form.problem(form.token), /one folder name, not a path/);
    assert.equal(page.byId('save').disabled, true, 'and SAVE waits');

    form.token.value = 'SMASH';
    form.token.dispatchEvent(new page.window.Event('input'));
    assert.equal(form.problem(form.token), null);
    assert.equal(page.byId('save').disabled, false);
  } finally {
    page.restore();
  }
});

test('the series image is picked from that series, and only that series', async () => {
  const { page } = await bootAdmin();
  try {
    const form = openSeries(page, 0);
    const options = [...form.face.options].map((o) => o.value).filter(Boolean);
    assert.ok(options.length > 1, 'there are amiibo to choose from');
    for (const id of options) {
      assert.equal(parseInt(id.slice(12, 14), 16), 0,
        'every option belongs to this series, so the header cannot show a stranger');
    }
    assert.equal(form.face.options[0].value, '', 'and the default is the automatic pick');

    const chosen = options[1];
    form.face.value = chosen;
    form.face.dispatchEvent(new page.window.Event('change'));

    const headArt = page.$('details.series[data-series="0"] img.seriesArt');
    assert.match(headArt.getAttribute('src'), new RegExp(chosen),
      'the header shows the chosen amiibo');
    assert.equal(page.$('.facePreview').getAttribute('src').includes(chosen), true,
      'and so does the preview beside the picker');
  } finally {
    page.restore();
  }
});

test('REVERT THIS SERIES drops every override on it at once', async () => {
  const { page } = await bootAdmin();
  try {
    const headText = () => page.$('details.series[data-series="0"] .seriesHead').textContent.trim();
    const before = headText();

    const form = openSeries(page);
    form.label.value = 'Renamed';
    form.label.dispatchEvent(new page.window.Event('input'));
    form.token.value = 'REN';
    form.token.dispatchEvent(new page.window.Event('input'));
    assert.match(headText(), /Renamed/);

    const revert = [...page.$$('#editor button')].find((b) => b.textContent.includes('REVERT'));
    assert.equal(revert.disabled, false);
    revert.dispatchEvent(new page.window.Event('click'));

    assert.equal(headText(), before, 'the header is back to upstream');
    assert.equal(page.byId('s-label').value, '', 'and the fields are empty again');
    assert.equal(page.byId('s-short').value, '');
  } finally {
    page.restore();
  }
});

test('a series can be named where upstream has none, which unblocks authoring there', async () => {
  const { page } = await bootAdmin();
  try {
    // Authoring into an unnamed series is refused, and says what to do.
    let form = openNewForm(page);
    type(form.id, UNLABELLED_SERIES_ID, page);
    type(form.name, 'Pioneer', page);
    assert.match(form.problem(form.id), /has no name\. Name it first/);
    assert.equal(form.create.disabled, true);

    // Name the byte.
    page.byId('newSeries').dispatchEvent(new page.window.Event('click'));
    const byteSel = page.byId('ns-byte');
    assert.ok([...byteSel.options].some((o) => Number(o.value) === 0x08),
      'the unnamed byte is offered');
    byteSel.value = '8';
    const nameIn = page.byId('ns-label');
    nameIn.value = 'Invented Series';
    nameIn.dispatchEvent(new page.window.Event('input'));
    const create = [...page.$$('#editor button')].find((b) => b.textContent === 'CREATE');
    assert.equal(create.disabled, false);
    create.dispatchEvent(new page.window.Event('click'));

    // Now the amiibo can be authored into it.
    form = openNewForm(page);
    type(form.id, UNLABELLED_SERIES_ID, page);
    type(form.name, 'Pioneer', page);
    assert.equal(form.problem(form.id), null, 'the series now has a name');
    assert.equal(form.create.disabled, false);
    form.create.dispatchEvent(new page.window.Event('click'));

    const cell = page.$(`.item[data-id="${UNLABELLED_SERIES_ID}"]`);
    assert.ok(cell, 'and it lands in the grid');
    assert.match(cell.closest('details.series').textContent, /Invented Series/,
      'under the series that was just named');
  } finally {
    page.restore();
  }
});

// ---- the update review ---------------------------------------------------
//
// Track Changes, arranged by entity. The two failures being guarded against are
// the ones that made the old screen unreadable: counting fields instead of
// entities, so the summary and the rows disagreed; and asking questions with
// one possible answer, then blocking on them.

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Press UPDATE and answer the scope question.
 *
 * UPDATE asks what to cover before it fetches anything — data, pictures, or
 * both — because the two move on different schedules upstream and each has to
 * be reachable alone. Whichever is chosen lands on this same screen.
 */
async function openReview(page, scope = 'both') {
  page.byId('refresh').dispatchEvent(new page.window.Event('click'));
  await settle();

  const choice = page.$(`dialog.nesDialog .dChoice[data-value="${scope}"]`);
  assert.ok(choice, `the update offers a "${scope}" scope`);
  choice.dispatchEvent(new page.window.Event('click'));
  await settle();
  await settle();

  return {
    steps: () => page.$$('#reviewSteps button').map((b) => b.textContent.replace(/^\d+/, '')),
    rows: () => page.$$('#reviewPanel .entity'),
    row: (key) => page.$(`#reviewPanel .entity[data-key="${CSS.escape(key)}"]`),
    artRow: (id) => page.$(`#reviewPanel .entity[data-art="${id}"]`),
    next: page.byId('reviewNext'),
    back: page.byId('reviewBack'),
    apply: page.byId('reviewApply'),
    summary: () => page.byId('reviewSummary').textContent,
    risk: () => page.byId('reviewRisk').textContent,
  };
}

/**
 * Walk to the last step.
 *
 * Bounded, because an unbounded walk is a test that cannot fail: when NEXT
 * stopped hiding at the end this hung the whole run instead of reporting
 * anything, which is strictly worse than a red test.
 */
async function toConfirm(page, r) {
  for (let i = 0; i < 12; i++) {
    if (r.next.hidden) return;
    r.next.dispatchEvent(new page.window.Event('click'));
    await settle();
  }
  assert.fail(`NEXT never gave way to APPLY; stuck on step ${r.steps().join(' > ')}`);
}

test('a refresh opens the review, hiding the library rather than a dialog', async () => {
  const { page } = await bootAdmin();
  try {
    assert.equal(page.byId('review').hidden, true);
    const r = await openReview(page);
    assert.equal(page.byId('review').hidden, false);
    assert.equal(page.byId('library').hidden, true,
      'the grid steps aside: hundreds of rows do not belong in a dialog');
  } finally {
    page.restore();
  }
});

test('the summary counts exactly the rows the steps render', async () => {
  // THE regression. The old screen counted changes per group in the tiles and
  // required-changes in UNDECIDED, over a group that had no tile at all, so
  // "0 0 0 2 2 3" described nothing. Both numbers now come from the same array.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);

    // Counted per step, because the two populations are compared separately:
    // entities come from the diff, artwork from the image manifest. Adding them
    // into one number is how the previous screen ended up describing neither.
    let entityRows = 0;
    let artRows = 0;
    const titles = r.steps();
    for (let i = 0; i < titles.length; i++) {
      page.$$('#reviewSteps button')[i].dispatchEvent(new page.window.Event('click'));
      await settle();
      if (titles[i] === 'ARTWORK') artRows += r.rows().length;
      else entityRows += r.rows().length;
    }

    const s = PREVIEW.diff.summary;
    const expected = Object.values(s.amiibo).reduce((a, b) => a + b, 0)
      + Object.values(s.series).reduce((a, b) => a + b, 0)
      + Object.values(s.type).reduce((a, b) => a + b, 0);
    assert.equal(entityRows, expected,
      'every entity in the summary is on screen exactly once, and vice versa');
    assert.equal(entityRows, s.total);

    // Every picture in the comparison is a row, arrivals included — the same
    // invariant as the entity steps, and for the same reason.
    const a = ARTWORK;
    assert.equal(artRows, a.added.length + a.changed.length + a.removed.length);
  } finally {
    page.restore();
  }
});

test('an amiibo arriving with several fields is ONE row, not several', async () => {
  // Grace and Leon were each listed twice — once under NEW AMIIBO and once
  // under RELEASE DATES — because the field was the unit instead of the amiibo.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    const amiiboStep = r.steps().findIndex((t) => t === 'AMIIBO');
    page.$$('#reviewSteps button')[amiiboStep].dispatchEvent(new page.window.Event('click'));
    await settle();

    const rows = r.rows();
    const leon = rows.filter((n) => n.textContent.includes('Leon S. Kennedy'));
    assert.equal(leon.length, 1, 'Leon appears once');
    // …with his date nested inside that one row, not as a peer of it.
    assert.match(leon[0].querySelector('.fields').textContent, /released/);
    assert.match(leon[0].querySelector('.fields').textContent, /2026-07-30/);
  } finally {
    page.restore();
  }
});

test('the summary is a fixed sentence with named counts, zeros intact', async () => {
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    assert.match(r.summary(), /2 amiibo to add/);
    assert.match(r.summary(), /0 to change/, 'zeros are printed, as Terraform does');
    assert.match(r.summary(), /0 to remove/);
    assert.match(r.summary(), /1 series to add/);

    // The risk line is the only part that says whether this needs care.
    assert.match(r.risk(), /Nothing you have curated is affected/);
    assert.match(r.risk(), /No files move on your device/);
    assert.equal(page.byId('reviewRisk').className, 'summaryRisk',
      'and it is uncoloured when there is no risk');
  } finally {
    page.restore();
  }
});

test('steps run coarse to fine, and empty ones are not shown', async () => {
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    assert.deepEqual(r.steps(), ['SERIES', 'AMIIBO', 'ARTWORK', 'CONFIRM'],
      'series before the amiibo inside it, and the pictures after both; no '
      + 'TYPES or DEVICE step, because this update has neither');
  } finally {
    page.restore();
  }
});

test('an update with no artwork question shows no ARTWORK step', async () => {
  // The same rule as every other step: the numbering counts what there is to
  // look at, so a comparison that found nothing produces no step at all.
  const { page } = await bootAdmin({
    artwork: { ...ARTWORK, added: [], changed: [], removed: [] },
  });
  try {
    const r = await openReview(page);
    assert.deepEqual(r.steps(), ['SERIES', 'AMIIBO', 'CONFIRM']);
  } finally {
    page.restore();
  }
});

test('nothing blocks APPLY, and the confirm step says what will be taken', async () => {
  // The old screen refused to proceed until a row whose only answer was TAKE
  // had been clicked. NN/g: do not confirm routine actions.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toConfirm(page, r);

    assert.equal(r.apply.hidden, false);
    assert.equal(r.apply.disabled, false, 'reachable without touching anything');
    const text = page.byId('reviewPanel').textContent;
    assert.match(text, /3 changes applied/);
    assert.match(text, /3 left untouched, and will be accepted/,
      'the default is stated rather than left implicit');
  } finally {
    page.restore();
  }
});

test('a change nobody can decline has no buttons, and says why', async () => {
  // The Resident Evil series: brand new, so there is no previous name to keep,
  // and the build refuses a series byte without one. It arrives because the
  // amiibo need it.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    const series = r.row('series:32');
    assert.ok(series, 'the new series is shown');
    assert.equal(series.querySelector('.acts'), null, 'with nothing to click');
    assert.match(series.querySelector('.why').textContent, /nothing to decide/i);
  } finally {
    page.restore();
  }
});

test('ACCEPT and DECLINE mark the row, and say which is which', async () => {
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    page.$$('#reviewSteps button')[r.steps().indexOf('AMIIBO')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();

    const row = r.rows()[0];
    const key = row.dataset.key;
    const buttons = [...row.querySelectorAll('.acts button')].map((b) => b.textContent);
    assert.deepEqual(buttons, ['✓ ACCEPT', '✕ DECLINE']);

    row.querySelector('.acts button:last-child').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(r.row(key).classList.contains('declined'), true);
    assert.match(r.row(key).querySelector('.verdict').textContent, /DECLINED/);

    r.row(key).querySelector('.acts button').dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(r.row(key).classList.contains('accepted'), true);
    assert.match(r.row(key).querySelector('.verdict').textContent, /ACCEPTED/);
  } finally {
    page.restore();
  }
});

test('declining a new amiibo says it comes back, rather than leaving you to find out', async () => {
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    page.$$('#reviewSteps button')[r.steps().indexOf('AMIIBO')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    const decline = r.rows()[0].querySelector('.acts button:last-child');
    assert.match(decline.title, /offer it again/i);
  } finally {
    page.restore();
  }
});

test('declining every amiibo in a new series declines the series with them', async () => {
  // The cascade. A series exists because amiibo carry it; keeping it with
  // nothing in it would be a series that is not there.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    page.$$('#reviewSteps button')[r.steps().indexOf('AMIIBO')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();

    const rows = r.rows();
    rows[0].querySelector('.acts button:last-child').dispatchEvent(new page.window.Event('click'));
    await settle();
    // One still accepted, so the series stays.
    page.$$('#reviewSteps button')[r.steps().indexOf('SERIES')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(r.row('series:32').classList.contains('declined'), false,
      'one amiibo still needs it');

    page.$$('#reviewSteps button')[r.steps().indexOf('AMIIBO')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    r.rows()[1].querySelector('.acts button:last-child').dispatchEvent(new page.window.Event('click'));
    await settle();
    page.$$('#reviewSteps button')[r.steps().indexOf('SERIES')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(r.row('series:32').classList.contains('declined'), true,
      'now nothing needs it');
  } finally {
    page.restore();
  }
});

test('ACCEPT ALL decides a section and nothing else', async () => {
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    page.$$('#reviewSteps button')[r.steps().indexOf('AMIIBO')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();

    const bulk = [...page.$$('#reviewPanel h3 .bulk button')].find((b) => b.textContent === 'DECLINE ALL');
    assert.ok(bulk, 'a section with more than one decidable row offers a bulk answer');
    bulk.dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.ok(r.rows().every((n) => n.classList.contains('declined')));
  } finally {
    page.restore();
  }
});

test('APPLY sends one verdict per change, expanded from the rows', async () => {
  const { page, fetch } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toConfirm(page, r);
    r.apply.dispatchEvent(new page.window.Event('click'));
    await settle();

    const call = fetch.calls.find((c) => c.path === '/api/upstream/apply');
    assert.ok(call, 'the update was applied');
    const sent = JSON.parse(call.body);
    assert.equal(sent.fingerprint, 'fp-1');
    // The screen decides per entity; the server names flat changes. Every one
    // of them has to arrive with a verdict.
    assert.deepEqual(
      Object.keys(sent.decisions).sort(),
      PREVIEW.diff.changes.map((c) => c.key).sort());
    assert.ok(Object.values(sent.decisions).every((v) => v === 'keep'),
      'untouched means accepted');
  } finally {
    page.restore();
  }
});

// ---- artwork -------------------------------------------------------------

const MARIO_ART = '0000000000000002';

/** Open the review and stand on the ARTWORK step. */
async function toArtwork(page, r) {
  page.$$('#reviewSteps button')[r.steps().indexOf('ARTWORK')]
    .dispatchEvent(new page.window.Event('click'));
  await settle();
}

test('a changed picture is shown as a pair, because a hash is not a picture', async () => {
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toArtwork(page, r);

    const row = r.artRow(MARIO_ART);
    assert.ok(row, 'the changed picture has a row');
    const imgs = [...row.querySelectorAll('.artPair img')];
    assert.equal(imgs.length, 2, 'what it is now, and what it would become');
    assert.match(imgs[0].getAttribute('src'), /\/data\/images\/full\/0000000000000002\.png$/,
      'the left is the picture the site serves today');
    assert.match(imgs[1].getAttribute('src'), /\/api\/upstream\/art\/0000000000000002\.png$/,
      'the right comes from the review endpoint, which fetches it on first sight');
    assert.equal(imgs[1].loading, 'lazy',
      'so a step listing 300 changes costs one request until it is read');

    // Which amiibo it lands on, named the way every other row names one. A
    // picture is not identification on its own: several amiibo share a
    // character and a pose, and the series is what tells them apart.
    const top = row.querySelector('.top').textContent;
    assert.match(top, /Mario/, 'the name');
    assert.match(top, /0000000000000002/, 'the ID');
    assert.match(row.querySelector('.ref.inline').textContent, /\S/, 'and its series');
  } finally {
    page.restore();
  }
});

test('a picture arriving is a question too, not a decision taken for you', async () => {
  // An earlier version stated arrivals as a count and fetched them regardless,
  // on the grounds that there is no picture to keep. But "I do not want that
  // one" is a real answer, and deciding on the reviewer's behalf is the
  // opposite of a review.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toArtwork(page, r);

    const row = r.artRow(GRACE);
    assert.ok(row, 'the arrival has its own row');
    assert.equal(row.querySelectorAll('.acts button').length, 2, 'with both answers');

    // Still before → after, with the missing side drawn as an explicit empty
    // slot. An arrival and a replacement then read the same way, and "there is
    // nothing here today" is itself the thing worth seeing.
    const pair = row.querySelector('.artPair');
    const empty = pair.querySelector('.artNone');
    assert.ok(empty, 'the empty side is shown, not left out');
    assert.match(empty.textContent, /none yet/);
    const imgs = [...pair.querySelectorAll('img')];
    assert.equal(imgs.length, 1, 'and the one picture there is');
    assert.match(imgs[0].getAttribute('src'), /\/api\/upstream\/art\//);

    const decline = row.querySelector('.acts button:last-child');
    assert.match(decline.title, /offer it again/i,
      'and declining an arrival means not this time, as it does for data');
  } finally {
    page.restore();
  }
});

test('declining a picture says it will not be asked about again', async () => {
  // The difference from the data model, and the reason it is spelled out on the
  // button rather than left to be discovered: an addition declined comes back
  // next update, a CHANGE declined does not.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toArtwork(page, r);

    const decline = r.artRow(MARIO_ART).querySelector('.acts button:last-child');
    assert.match(decline.title, /not be asked again unless upstream changes it/i);

    decline.dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.ok(r.artRow(MARIO_ART).classList.contains('declined'));
  } finally {
    page.restore();
  }
});

test('an artwork verdict reaches the server with the version it was about', async () => {
  // The hash IS the record: without it the server could only note "this picture
  // was refused", and the refusal would outlive the version it was about.
  const { page, fetch } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toArtwork(page, r);
    r.artRow(MARIO_ART).querySelector('.acts button:last-child')
      .dispatchEvent(new page.window.Event('click'));
    await settle();

    await toConfirm(page, r);
    r.apply.dispatchEvent(new page.window.Event('click'));
    await settle();

    const sent = JSON.parse(fetch.calls.find((c) => c.path === '/api/upstream/apply').body);
    assert.deepEqual(sent.artwork[MARIO_ART], {
      verdict: 'skip',
      sha: ARTWORK.changed[0].sha,
      op: 'edit',
    });
    // Untouched means accepted here too, so every row is sent rather than only
    // the ones that were clicked — the server cannot infer what it never saw.
    assert.deepEqual(sent.artwork[GRACE], { verdict: 'keep', sha: null, op: 'add' });
  } finally {
    page.restore();
  }
});

test('the confirm step counts the pictures, including the ones left alone', async () => {
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toArtwork(page, r);
    r.artRow(MARIO_ART).querySelector('.acts button:last-child')
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    await toConfirm(page, r);

    const text = page.byId('reviewPanel').textContent;
    assert.match(text, /1 picture fetched/);
    assert.match(text, /1 picture kept as it is/);
    assert.doesNotMatch(text, /picture(s)? replaced/,
      'the only change was declined, so nothing is replaced');
  } finally {
    page.restore();
  }
});

test('an artwork check that failed is said out loud, not left as an absence', async () => {
  // "Could not check" and "nothing changed" look identical on screen otherwise,
  // and they mean opposite things.
  const { page } = await bootAdmin({
    artworkRoute: { status: 502, body: { error: 'the image index is rate-limited right now' } },
  });
  try {
    const r = await openReview(page);
    assert.match(r.risk(), /artwork not checked — the image index is rate-limited/);
    assert.deepEqual(r.steps(), ['SERIES', 'AMIIBO', 'CONFIRM'], 'and no step promises otherwise');

    await toConfirm(page, r);
    assert.match(page.byId('reviewPanel').textContent, /Artwork was not checked/);
  } finally {
    page.restore();
  }
});

test('UPDATE asks what to cover before fetching anything', async () => {
  // One update with options, not two buttons. Data and pictures move on
  // different schedules upstream, so each has to be reachable alone — but that
  // is a scope question, not a second feature.
  const { page, fetch } = await bootAdmin();
  try {
    page.byId('refresh').dispatchEvent(new page.window.Event('click'));
    await settle();

    const choices = page.$$('dialog.nesDialog .dChoice').map((b) => b.dataset.value);
    assert.deepEqual(choices, ['both', 'data', 'images']);
    assert.equal(fetch.calls.filter((c) => c.path === '/api/upstream/refresh').length, 0,
      'and nothing is fetched until the question is answered');
  } finally {
    page.restore();
  }
});

test('PICTURES ONLY reviews artwork without touching the sources', async () => {
  // The case this exists for: upstream ships the picture a month after the
  // database entry, so there is no data update to carry it. Fetching the
  // sources to find that out would be work for nothing.
  const { page, fetch } = await bootAdmin();
  try {
    const r = await openReview(page, 'images');

    assert.equal(fetch.calls.filter((c) => c.path === '/api/upstream/refresh').length, 0,
      'the sources are left alone');
    // pending=0: there is no candidate database, so the pictures are checked
    // against the one the site publishes.
    assert.ok(fetch.calls.some((c) => c.path === '/api/artwork?pending=0'));
    assert.deepEqual(r.steps(), ['ARTWORK', 'CONFIRM'], 'and only the picture steps');
    assert.match(r.risk(), /Pictures only — the database is not touched/);
  } finally {
    page.restore();
  }
});

test('the artwork check runs against the database the update would publish', async () => {
  // The two halves are one update. An amiibo the data half is adding has no
  // artwork yet, and checking the pictures against the PUBLISHED database would
  // never look for it — the arrival would be invisible until some later,
  // unrelated update happened to notice.
  const { page, fetch } = await bootAdmin();
  try {
    await openReview(page, 'both');
    assert.ok(fetch.calls.some((c) => c.path === '/api/artwork?pending=1'),
      'the candidate database, not the published one');

    // And the data step asks for no artwork, so each step is one job and the
    // progress it reports is real rather than inferred.
    assert.ok(fetch.calls.some((c) => c.path === '/api/upstream/preview?artwork=0'));
  } finally {
    page.restore();
  }
});

test('the update reports its progress step by step, not as one silence', async () => {
  // The artwork request is held open, so the panel can be inspected while the
  // last step is genuinely still running. What is asserted is that a step marked
  // done IS done: two requests have returned, the third has not.
  let release;
  const held = new Promise((r) => { release = r; });

  const { page } = await bootAdmin({
    artworkRoute: async () => { await held; return { ok: true, artwork: ARTWORK }; },
  });
  try {
    page.byId('refresh').dispatchEvent(new page.window.Event('click'));
    await settle();
    page.$('dialog.nesDialog .dChoice[data-value="both"]')
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    await settle();

    assert.equal(page.byId('progress').hidden, false, 'the panel is up while it works');
    const steps = page.$$('#pSteps li');
    assert.equal(steps.length, 3, 'fetch, build, artwork');
    assert.match(steps[0].textContent, /Fetching the upstream sources/);
    assert.ok(steps[0].classList.contains('done'), 'that request returned');
    assert.ok(steps[1].classList.contains('done'), 'and so did that one');
    assert.ok(steps[2].classList.contains('now'), 'the artwork is still in flight');

    // Two of three finished, so the bar is two thirds along — driven by work
    // that completed, never by a timer.
    assert.equal(page.byId('pFill').style.width, '67%');

    release();
    await settle();
    await settle();
    assert.equal(page.byId('progress').hidden, true, 'and it goes when the review arrives');
    assert.equal(page.byId('review').hidden, false);
  } finally {
    release();
    page.restore();
  }
});

test('a pictures-only apply goes to its own endpoint, not the database one', async () => {
  const { page, fetch } = await bootAdmin();
  try {
    const r = await openReview(page, 'images');
    await toConfirm(page, r);
    r.apply.dispatchEvent(new page.window.Event('click'));
    await settle();

    assert.equal(fetch.calls.filter((c) => c.path === '/api/upstream/apply').length, 0,
      'nothing rebuilds a database this update cannot change');
    const call = fetch.calls.find((c) => c.path === '/api/artwork/apply');
    assert.ok(call, 'the artwork verdicts are applied on their own');
    assert.ok(Object.keys(JSON.parse(call.body).artwork).length > 0);
  } finally {
    page.restore();
  }
});

test('pictures already up to date says so instead of an empty review', async () => {
  const { page } = await bootAdmin({
    artwork: { added: [], changed: [], removed: [], unchanged: 948, held: 3 },
  });
  try {
    page.byId('refresh').dispatchEvent(new page.window.Event('click'));
    await settle();
    page.$('dialog.nesDialog .dChoice[data-value="images"]')
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    await settle();

    assert.equal(page.byId('review').hidden, true, 'no review screen with nothing on it');
    assert.match(page.byId('status').textContent, /up to date: 948 pictures/);
    assert.match(page.byId('status').textContent, /3 held at the version you chose/,
      'and a decision still in force is visible, not silent');
  } finally {
    page.restore();
  }
});

test('applying reloads the page, because the database is a cached module', async () => {
  // The bug this fixes: apply rewrote web/data/amiibo-db.js on the server, the
  // admin re-fetched /api/db and redrew — and the list still showed the old
  // counts and the old rows. The grid is built through amiibo.js, which
  // statically imports that database, and an ES module is evaluated once per
  // DOCUMENT. Rewriting the file cannot reach a page that already loaded it, so
  // only a new document shows the new entries.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toConfirm(page, r);
    assert.equal(page.reloads, 0);
    r.apply.dispatchEvent(new page.window.Event('click'));
    await settle();
    assert.equal(page.reloads, 1, 'the page reloaded rather than re-rendering');
  } finally {
    page.restore();
  }
});

test('the receipt survives that reload, and names the artwork', async () => {
  // A reload would otherwise throw the result away, and "did anything happen?"
  // is the wrong thing to leave someone wondering after an update.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    await toConfirm(page, r);
    r.apply.dispatchEvent(new page.window.Event('click'));
    await settle();

    const parked = JSON.parse(sessionStorage.getItem('admin:sayAfterReload'));
    assert.match(parked.message, /947 amiibo/);
    assert.match(parked.message, /Artwork: 2 fetched/);
  } finally {
    page.restore();
  }
});

test('a decline reaches the server as a decline on every field it covers', async () => {
  const { page, fetch } = await bootAdmin();
  try {
    const r = await openReview(page);
    page.$$('#reviewSteps button')[r.steps().indexOf('AMIIBO')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    const key = r.rows()[0].dataset.key;
    r.rows()[0].querySelector('.acts button:last-child').dispatchEvent(new page.window.Event('click'));
    await settle();

    await toConfirm(page, r);
    r.apply.dispatchEvent(new page.window.Event('click'));
    await settle();

    const sent = JSON.parse(fetch.calls.find((c) => c.path === '/api/upstream/apply').body);
    const entity = PREVIEW.diff.entities.find((e) => e.key === key);
    for (const changeKey of entity.changeKeys) {
      assert.equal(sent.decisions[changeKey], 'skip',
        `${changeKey} carries the row's verdict`);
    }
  } finally {
    page.restore();
  }
});

test('CANCEL puts the library back', async () => {
  const { page } = await bootAdmin();
  try {
    await openReview(page);
    page.byId('reviewClose').dispatchEvent(new page.window.Event('click'));
    assert.equal(page.byId('review').hidden, true);
    assert.equal(page.byId('library').hidden, false);
  } finally {
    page.restore();
  }
});

test('the review checks fail on the mistakes they were written for', async () => {
  // Each of the three rules above is asserted here to be breakable — a check
  // that cannot fail is decoration, and this screen was rebuilt precisely
  // because its predecessor's checks passed while the screen made no sense.
  const { page } = await bootAdmin();
  try {
    const r = await openReview(page);
    const s = PREVIEW.diff.summary;
    const entities = PREVIEW.diff.entities;

    // 1. ARITHMETIC. The old screen counted flat CHANGES, so an amiibo arriving
    //    with a name and a date counted twice. Same update, different number —
    //    which is what "0 0 0 2 2 3" was.
    const fieldWise = PREVIEW.diff.changes.length;
    assert.ok(fieldWise > s.total, 'the fixture really does have multi-field entities');
    assert.throws(
      () => assert.equal(fieldWise, s.total, 'counting fields must not match counting rows'),
      /must not match/);

    // 2. NO SINGLE-ANSWER QUESTIONS. The new series is shown without buttons.
    //    Had it been rendered as decidable it would be a question with one
    //    answer — and, on the old screen, one that also blocked APPLY.
    page.$$('#reviewSteps button')[r.steps().indexOf('SERIES')]
      .dispatchEvent(new page.window.Event('click'));
    await settle();
    const series = r.row('series:32');
    assert.equal(series.querySelector('.acts'), null, 'no buttons today');
    assert.throws(
      () => assert.ok(series.querySelector('.acts'), 'a one-answer row must offer nothing'),
      /must offer nothing/);
    assert.equal(entities.find((e) => e.key === 'series:32').decidable, false);

    // 3. CASCADE. Without it, declining every amiibo in a new series leaves the
    //    series accepted — published, empty, and pointing at nothing.
    const users = entities.filter((e) => e.needs === 'series:32');
    assert.ok(users.length > 0, 'the fixture has amiibo depending on the series');
    const noCascade = Object.fromEntries(users.map((e) => [e.key, 'skip']));
    assert.throws(
      () => assert.equal(noCascade['series:32'], 'skip',
        'a decision that does not reach back must leave the series undeclined'),
      /must leave the series undeclined/);
  } finally {
    page.restore();
  }
});

test('a refresh with unsaved edits refuses rather than losing them', async () => {
  const { page, fetch } = await bootAdmin();
  try {
    const id = page.$('.item').dataset.id;
    page.$(`.item[data-id="${id}"]`).dispatchEvent(new page.window.Event('click'));
    const input = page.byId('f-name');
    input.value = 'Unsaved';
    input.dispatchEvent(new page.window.Event('input'));

    page.byId('refresh').dispatchEvent(new page.window.Event('click'));
    await settle();

    assert.match(page.$('dialog.nesDialog').textContent, /SAVE YOUR EDITS FIRST/);
    assert.equal(fetch.calls.filter((c) => c.path === '/api/upstream/refresh').length, 0,
      'and nothing was fetched');
    assert.equal(page.byId('review').hidden, true);
  } finally {
    page.restore();
  }
});
