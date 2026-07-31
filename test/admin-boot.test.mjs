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

let instance = 0;
async function bootAdmin({ overlay = { schema: 1, amiibos: {} }, upstreamReady = true } = {}) {
  const page = mountPage('admin/index.html');
  const fetch = stubFetch({
    '/api/session': { csrf: 'test-token' },
    '/api/db': DB,
    '/api/overlay': { overlay, upstreamReady },
    'PUT /api/overlay': { entries: 946, backup: '2026-01-01T09-30-00-000Z.json', notices: [] },
    '/api/backups': { backups: BACKUPS },
    'POST /api/restore': { ok: true, entries: 946, restored: BACKUPS[0] },
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
