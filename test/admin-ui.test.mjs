// The admin page, run against a real DOM.
//
// This is the first test in the project that executes UI code. It exists
// because every UI bug here has been of a kind nothing could catch: a selector
// matching nothing, an element styled through a container with one child, a page
// that renders blank because a module failed to load. `npm test` said everything
// passed each time.
//
// The bar for this file is not coverage. It is that it fails on the specific
// mistakes that shipped, which is asserted directly at the bottom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { mountPage, mountHtml, pageHtml } from './helpers/dom.mjs';

// The admin imports the site's shared modules as /js/..., which is right in a
// browser and unresolvable in Node without this.
register('./helpers/loader.mjs', import.meta.url);

const ADMIN = 'admin/index.html';

// ---- the page can be understood without running anything ----------------

test('the sign-in form is visible before any script runs', () => {
  // The white screen: every panel started hidden, so a module that failed to
  // load left a blank page that could not report its own failure.
  const page = mountPage(ADMIN);
  try {
    const login = page.byId('login');
    assert.ok(login, 'the sign-in section exists');
    assert.equal(login.hasAttribute('hidden'), false,
      'sign-in must not start hidden, or a broken script renders nothing');
    assert.equal(page.byId('app').hasAttribute('hidden'), true,
      'the editor does start hidden, until a session says otherwise');
  } finally {
    page.restore();
  }
});

test('a failed script is announced rather than left blank', () => {
  const page = mountPage(ADMIN);
  try {
    const fail = page.byId('bootFail');
    assert.ok(fail, 'there is a notice for the case the module never runs');
    assert.equal(fail.hasAttribute('hidden'), true, 'hidden until the watchdog fires');
    assert.match(fail.textContent, /did not load/i);
  } finally {
    page.restore();
  }
});

test('every element the script reaches for actually exists', () => {
  // The class of bug a reference check cannot see: getElementById returning
  // null and the failure surfacing later as "cannot set property of null".
  const page = mountPage(ADMIN);
  try {
    const source = pageHtml('admin/adminui.js');
    const ids = [...source.matchAll(/\bel\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
    assert.ok(ids.length > 5, 'found the element lookups to check');

    // Some elements the script looks up are ones the script itself wrote — the
    // CLEAR FILTERS button inside the empty state, for instance. Those are not
    // in the markup and should not be: what matters is that every id is either
    // on the page or created by the module, and never simply invented.
    const created = new Set(
      [...source.matchAll(/\bid=["']([A-Za-z0-9_-]+)["']/g)].map((m) => m[1]));

    const missing = [...new Set(ids)].filter((id) => !page.byId(id) && !created.has(id));
    assert.deepEqual(missing, [], 'ids used by adminui.js but absent from the page');
  } finally {
    page.restore();
  }
});

test('every data-ico on the page names a real icon', async () => {
  const page = mountPage(ADMIN);
  try {
    const { ICONS } = await import('../web/js/icons.js');
    const names = page.$$('[data-ico]').map((n) => n.dataset.ico);
    for (const name of names) {
      assert.ok(ICONS[name], `data-ico="${name}" is not in the icon set`);
    }
  } finally {
    page.restore();
  }
});

test('the sign-in mascot renders into the page rather than into nothing', async () => {
  // The bar's mascot is drawn by chrome.js once a session exists, so only the
  // sign-in one is in the static markup. admin-boot.test.mjs covers the other.
  const page = mountPage(ADMIN);
  try {
    const { pirateMark } = await import('../web/js/sprite.js');
    const slot = page.byId('loginMark');
    assert.ok(slot, 'loginMark exists for the mascot');
    slot.innerHTML = pirateMark(64);
    assert.ok(slot.querySelector('svg'), 'loginMark received an svg');
  } finally {
    page.restore();
  }
});

// ---- styling that depends on structure ----------------------------------

test('a styled container actually contains what it is meant to space', () => {
  // The .hSlot bug: a gap was put on a flex container whose only child was the
  // wrapper holding the two buttons, so there was nothing for it to space. The
  // check that would have caught it is "does this selector's target have more
  // than one child".
  const page = mountPage(ADMIN);
  try {
    const actions = page.byId('adminActions');
    assert.ok(actions, 'the bar actions exist in the markup');
    assert.ok(actions.children.length > 1,
      'several buttons, so the bar\'s gap has something to space');

    const row = page.$('.aRow');
    assert.equal(row, null, 'rows are built by script, not present in the markup');
  } finally {
    page.restore();
  }
});

test('the page never grows a nav, and never advertises itself', () => {
  const page = mountPage(ADMIN);
  try {
    assert.equal(page.$$('nav').length, 0);
    assert.equal(page.$('meta[property^="og:"]'), null, 'a preview card would publish the URL');
    assert.equal(page.$('link[rel="manifest"]'), null);
    assert.match(page.$('meta[name="robots"]')?.content ?? '', /noindex/);
  } finally {
    page.restore();
  }
});

test('the admin draws the collection page toolbar, not a second one', () => {
  // The list used to be a bespoke flat .rowList with its own search box. It is
  // now the collection page's grid, so the two must present the same controls
  // with the same ids and classes or app.css styles only one of them.
  const admin = mountHtml(pageHtml(ADMIN));
  const collection = mountHtml(pageHtml('web/collection.html'));
  try {
    for (const sel of ['.toolbar', '.searchBox', '.pillRow', 'select#sortMode', '.segCtl']) {
      assert.ok(admin.$(sel), `the admin has ${sel}`);
      assert.ok(collection.$(sel), `and so does the collection page`);
    }

    const sorts = (page) => page.$$('#sortMode option').map((o) => o.value);
    assert.deepEqual(sorts(admin), sorts(collection),
      'both offer the same sort modes, so sortSeries handles both');

    const views = (page) => page.$$('#segView input').map((i) => i.value);
    assert.deepEqual(views(admin), views(collection), 'and the same cards/list toggle');

    assert.ok(admin.byId('series'), 'the grid renders into #series, as app.css expects');
    assert.equal(admin.$('.rowList'), null, 'and the bespoke list is gone');
  } finally {
    admin.restore();
    collection.restore();
  }
});

test('the page pulls its skin from the site, not a copy', () => {
  const page = mountPage(ADMIN);
  try {
    const hrefs = page.$$('link[rel="stylesheet"]').map((l) => l.getAttribute('href'));
    assert.deepEqual(hrefs, ['/css/app.css', '/css/collection.css', '/css/amiibodetail.css'],
      'every stylesheet is the site\'s own, served from it rather than copied');
    assert.ok(hrefs.every((h) => h.startsWith('/css/')),
      'root-relative, so the admin still never names the host it is served from');
  } finally {
    page.restore();
  }
});

test('the grid is styled in one place, not once per page', () => {
  // The grid CSS used to live in collection.html's inline <style>, which is why
  // the admin could not reuse it. It now lives in css/collection.css. If a rule
  // for it reappears inline, the two pages have started to drift again.
  const shared = pageHtml('web/css/collection.css');
  const inline = pageHtml('web/collection.html').match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

  for (const sel of ['details.series', '.items', '.item', '.subHead', '.sPill', '.seriesHead']) {
    assert.ok(shared.includes(`${sel} {`) || shared.includes(`${sel}{`),
      `${sel} is defined in the shared stylesheet`);
  }
  // The page keeps its own concerns — selection mode, the victory overlay — and
  // those legitimately mention .item. What it must not do is redefine the cell.
  assert.doesNotMatch(inline, /^\s*\.item\s*\{/m, '.item is not restyled inline');
  assert.doesNotMatch(inline, /^\s*\.items\s*\{/m, '.items is not restyled inline');
  assert.doesNotMatch(inline, /^\s*details\.series\s*\{/m, 'nor the series group');
  assert.doesNotMatch(inline, /^\s*\.sPill\s*\{/m, 'nor the series pill');
});

// ---- the harness has to be able to fail ---------------------------------

test('these checks fail when the bugs that shipped are reintroduced', () => {
  // A test file that cannot fail is decoration. Each case below is a real
  // regression from this project's history, replayed against the same
  // assertions the tests above use.

  const broken = (body) => mountHtml(`<!doctype html><html><body>${body}</body></html>`);

  // 1. The white screen: sign-in hidden by default, so a failed module left
  //    nothing on screen and no way to say why.
  let page = broken('<section id="login" hidden></section><div id="app" hidden></div>');
  assert.throws(
    () => assert.equal(page.byId('login').hasAttribute('hidden'), false),
    /strictly equal/,
    'a hidden sign-in must fail'
  );
  page.restore();

  // 2. A script reaching for an element the page does not have.
  page = broken('<div id="present"></div>');
  assert.throws(
    () => assert.deepEqual(['absent'].filter((id) => !page.byId(id)), []),
    /deep-equal/,
    'a missing id must fail'
  );
  page.restore();

  // 3. The .hSlot shape: a gap on a container with one child does nothing.
  page = broken('<div class="adminBar"><div class="inner"><span>only</span></div></div>');
  assert.throws(
    () => assert.ok(page.$('.adminBar .inner').children.length > 1),
    'a single-child container must fail the spacing check'
  );
  page.restore();
});
