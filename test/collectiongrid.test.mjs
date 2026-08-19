// The collection grid, built against a real DOM and the real database.
//
// This is the structure both the collection page and the admin draw. It used to
// live inside collectionui.js where nothing could reach it: the only way to know
// a change to buildDom was safe was to open a browser and look. Here it is built
// for all 31 series and inspected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountHtml } from './helpers/dom.mjs';
import { buildSeriesGrid, applyGridFilter, reorderGroups } from '../web/js/collectiongrid.js';
import { matchesFilter, sortSeries, seriesDate } from '../web/js/collectionview.js';
import { buildCollection } from '../web/js/amiibo.js';
import { AMIIBO_RELEASE } from '../web/data/amiibo-db.js';

const PAGE = '<!doctype html><html><body><div id="series"></div></body></html>';

/** A grid over the whole database, drawn into a mounted page. */
function grid({ owned = new Set(), device = null, hooks = {} } = {}) {
  const page = mountHtml(PAGE);
  const collection = buildCollection(owned, device, {});
  const groups = sortSeries(collection.series, 'release', AMIIBO_RELEASE);
  const built = buildSeriesGrid(groups, {
    cell: (item) => {
      const el = page.document.createElement('a');
      el.className = 'item';
      el.dataset.id = item.id;
      el.textContent = item.name;
      return el;
    },
    art: (g) => `img/${g.items[0].id}.png`,
    year: (g) => seriesDate(g, AMIIBO_RELEASE)?.slice(0, 4) ?? null,
    chevron: '<svg></svg>',
    doc: page.document,
    ...hooks,
  });
  page.byId('series').append(built.frag);
  return { page, collection, groups, ...built };
}

test('every series becomes a group and every amiibo a cell', () => {
  const g = grid();
  try {
    assert.equal(g.page.$$('details.series').length, g.groups.length);
    assert.ok(g.groups.length > 20, 'the real database has many series');

    const cells = g.page.$$('.item').length;
    const expected = g.groups.reduce((n, s) => n + s.items.length, 0);
    assert.equal(cells, expected, 'no amiibo is dropped between the data and the DOM');
    assert.equal(g.rows.length, expected, 'the filter index covers every cell');
  } finally {
    g.page.restore();
  }
});

test('each group carries the series it is for, so sorting can move it', () => {
  const g = grid();
  try {
    const attrs = g.page.$$('details.series').map((d) => Number(d.dataset.series));
    assert.deepEqual(attrs, g.groups.map((s) => s.series));
    assert.equal(new Set(attrs).size, attrs.length, 'one group per series, no duplicates');
    assert.equal(g.groupEls.size, g.groups.length);
  } finally {
    g.page.restore();
  }
});

test('a summary has its art, its name, its year and its chevron', () => {
  const g = grid();
  try {
    const first = g.page.$('details.series');
    const head = first.querySelector('.seriesHead');
    assert.ok(head, 'the summary has a head');
    assert.ok(head.querySelector('img.seriesArt')?.src, 'with artwork');
    // Property, not attribute: linkedom does not reflect `loading`. See the
    // note on reflection in helpers/dom.mjs.
    assert.equal(head.querySelector('img.seriesArt').loading, 'lazy',
      '~31 head images must not all load at once');
    assert.match(head.textContent, /\S/, 'and the series name');
    assert.ok(first.querySelector('.chev svg'), 'and a chevron');
  } finally {
    g.page.restore();
  }
});

test('groups start collapsed unless the page says otherwise', () => {
  // `open` is a property here, not an attribute — linkedom does not reflect it,
  // so [open] selectors match nothing. See helpers/dom.mjs.
  const g = grid();
  let first;
  try {
    assert.equal(g.page.$$('details.series').filter((d) => d.open).length, 0);
    first = g.groups[0].series;
  } finally {
    g.page.restore();
  }

  const open = grid({ hooks: { isOpen: (s) => s.series === first } });
  try {
    const opened = open.page.$$('details.series').filter((d) => d.open);
    assert.equal(opened.length, 1, 'only the series the hook named');
    assert.equal(Number(opened[0].dataset.series), first);
  } finally {
    open.page.restore();
  }
});

test('a large mixed series gets sub-headers and every other series does not', () => {
  const g = grid();
  try {
    const withSubs = g.page.$$('details.series').filter((d) => d.querySelector('.subHead'));
    for (const d of withSubs) {
      const group = g.groups.find((s) => s.series === Number(d.dataset.series));
      assert.ok(group.items.length > 100, `${group.seriesName} is large enough for sub-headers`);
      assert.ok(new Set(group.items.map((i) => i.typeName)).size > 1,
        `${group.seriesName} mixes types, so the headers say something`);
    }
    // Sub-headers claim a count; it has to be the real one.
    for (const sh of g.page.$$('.subHead')) {
      const [label, n] = sh.textContent.split(' · ');
      const group = g.groups.find(
        (s) => s.series === Number(sh.closest('details').dataset.series));
      const actual = group.items.filter(
        (i) => `${i.typeName.toUpperCase()}S` === label).length;
      assert.equal(Number(n), actual, `${label} sub-header counts its own type`);
    }
  } finally {
    g.page.restore();
  }
});

test('sub-headers do not reorder the series that do not use them', () => {
  const g = grid();
  try {
    for (const d of g.page.$$('details.series')) {
      if (d.querySelector('.subHead')) continue;
      const group = g.groups.find((s) => s.series === Number(d.dataset.series));
      const drawn = [...d.querySelectorAll('.item')].map((c) => c.dataset.id);
      assert.deepEqual(drawn, group.items.map((i) => i.id),
        `${group.seriesName} keeps the database's order`);
    }
  } finally {
    g.page.restore();
  }
});

// ---- filtering ----------------------------------------------------------

test('filtering hides cells rather than rebuilding them', () => {
  const g = grid();
  try {
    const before = g.page.$$('.item');
    const { shown } = applyGridFilter({
      rows: g.rows,
      groupEls: g.groupEls,
      root: g.page.byId('series'),
      keep: matchesFilter,
      filter: 'missing',
    });
    const after = g.page.$$('.item');
    assert.equal(after.length, before.length, 'the same nodes are still there');
    assert.equal(after[0], before[0], 'and they are the same objects, not replacements');
    assert.equal(shown, before.length, 'nothing is owned, so everything is missing');
  } finally {
    g.page.restore();
  }
});

test('owning something moves it out of MISSING and into OWNED', () => {
  const g = grid();
  const target = g.rows[0].item.id;
  g.page.restore();

  const owned = grid({ owned: new Set([target]) });
  try {
    const root = owned.page.byId('series');
    const args = { rows: owned.rows, groupEls: owned.groupEls, root, keep: matchesFilter };

    const isOwned = applyGridFilter({ ...args, filter: 'owned' });
    assert.equal(isOwned.shown, 1);
    assert.deepEqual(isOwned.order, [target]);

    const missing = applyGridFilter({ ...args, filter: 'missing' });
    assert.equal(missing.shown, owned.rows.length - 1);
    assert.equal(missing.order.includes(target), false);

    const all = applyGridFilter({ ...args, filter: 'all' });
    assert.equal(all.shown, owned.rows.length);
  } finally {
    owned.page.restore();
  }
});

test('a group with nothing visible hides itself, and a match forces its group open', () => {
  const g = grid();
  try {
    const wanted = g.rows[Math.floor(g.rows.length / 2)];
    const { shown } = applyGridFilter({
      rows: g.rows,
      groupEls: g.groupEls,
      root: g.page.byId('series'),
      keep: matchesFilter,
      query: wanted.item.id.toLowerCase(),
    });
    assert.equal(shown, 1, 'an ID matches exactly one amiibo');

    const open = g.page.$$('details.series:not([hidden])');
    assert.equal(open.length, 1, 'every other series is hidden');
    assert.equal(open[0].open, true,
      'a match inside a collapsed series would otherwise look like no match');
    assert.equal(open[0], wanted.groupEl);
  } finally {
    g.page.restore();
  }
});

test('sub-headers are hidden while filtering, because their counts stop being true', () => {
  const g = grid();
  try {
    const root = g.page.byId('series');
    const args = { rows: g.rows, groupEls: g.groupEls, root, keep: matchesFilter };
    assert.ok(g.page.$$('.subHead').length > 0, 'there are sub-headers to check');

    applyGridFilter({ ...args, query: 'mario' });
    assert.ok(g.page.$$('.subHead').every((s) => s.hidden), 'hidden while searching');

    applyGridFilter({ ...args, filter: 'all', query: '' });
    assert.ok(g.page.$$('.subHead').every((s) => !s.hidden), 'and back when cleared');
  } finally {
    g.page.restore();
  }
});

test('a search that matches nothing reports nothing, and clearing restores everything', () => {
  const g = grid();
  try {
    const root = g.page.byId('series');
    const args = { rows: g.rows, groupEls: g.groupEls, root, keep: matchesFilter };

    const none = applyGridFilter({ ...args, query: 'zzzznotanamiibo' });
    assert.equal(none.shown, 0);
    assert.deepEqual(none.order, []);
    assert.ok(g.page.$$('details.series').every((d) => d.hidden), 'nothing is left showing');

    const back = applyGridFilter({ ...args, query: '' });
    assert.equal(back.shown, g.rows.length);
    assert.ok(g.page.$$('details.series').every((d) => !d.hidden));
  } finally {
    g.page.restore();
  }
});

// ---- reordering ---------------------------------------------------------

test('changing sort moves the existing groups instead of rebuilding them', () => {
  const g = grid();
  try {
    const root = g.page.byId('series');
    const nodes = new Map(g.page.$$('details.series').map((d) => [d.dataset.series, d]));

    const byName = sortSeries(g.collection.series, 'name', AMIIBO_RELEASE);
    reorderGroups(root, byName, g.groupEls);

    const after = g.page.$$('details.series');
    assert.deepEqual(
      after.map((d) => Number(d.dataset.series)),
      byName.map((s) => s.series),
      'the DOM order follows the sort');
    assert.equal(after.length, nodes.size, 'no group was added or lost');
    for (const d of after) {
      assert.equal(d, nodes.get(d.dataset.series), 'the same node, moved rather than remade');
    }
  } finally {
    g.page.restore();
  }
});

// ---- the contract itself ------------------------------------------------

test('a grid without a cell hook fails loudly rather than drawing an empty list', () => {
  const page = mountHtml(PAGE);
  try {
    assert.throws(() => buildSeriesGrid([], { doc: page.document }), /cell hook/);
  } finally {
    page.restore();
  }
});

test('these checks fail if the grid drops amiibo or forgets to hide a group', () => {
  // The two failures that would matter and would look fine on a screenshot: a
  // cell quietly missing, and a filtered-out group left visible with no rows.
  const page = mountHtml(PAGE);
  try {
    const groups = [{
      series: 1,
      seriesName: 'Test',
      items: [
        { id: 'a', name: 'A', typeName: 'Figure', hasLocal: true },
        { id: 'b', name: 'B', typeName: 'Figure', hasLocal: false },
      ],
    }];

    // A cell hook that drops one: the count check must catch it.
    let n = 0;
    const dropping = buildSeriesGrid(groups, {
      doc: page.document,
      cell: () => {
        const el = page.document.createElement('a');
        el.className = n++ === 0 ? 'item' : 'oops';
        return el;
      },
    });
    page.byId('series').append(dropping.frag);
    assert.throws(
      () => assert.equal(page.$$('.item').length, 2),
      /strictly equal/,
      'a dropped cell must fail the count check');

    // A group whose every row is filtered out must end up hidden.
    const { shown } = applyGridFilter({
      rows: dropping.rows,
      groupEls: dropping.groupEls,
      root: page.byId('series'),
      keep: () => false,
    });
    assert.equal(shown, 0);
    assert.equal(page.$('details.series').hidden, true,
      'an empty group left visible would show a series header with nothing under it');
  } finally {
    page.restore();
  }
});

test('the SELECT ALL button exists only where a page asks for it', () => {
  // The grid is shared with the admin, which has no selection mode; only the
  // collection page passes `selectable`, so only it may carry the buttons.
  const plain = grid();
  try {
    assert.equal(plain.page.$$('summary .selAll').length, 0, 'the admin grew selection buttons');
  } finally {
    plain.page.restore();
  }

  const selectable = grid({ hooks: { selectable: true } });
  try {
    const buttons = selectable.page.$$('summary .selAll');
    assert.equal(buttons.length, selectable.groups.length, 'one per series');
    assert.ok(buttons.every((b) => b.getAttribute('type') === 'button'),
      'a bare <button> in a form context would submit it');
    assert.equal(buttons[0].textContent, 'SELECT ALL');
  } finally {
    selectable.page.restore();
  }
});
