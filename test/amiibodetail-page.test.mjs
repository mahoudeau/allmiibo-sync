// The detail page, rendered and snapshotted.
//
// This exists to make a refactor safe, and it was written against the page
// BEFORE any of it moved. web/js/amiibodetail.js was 309 lines of rendering
// with no test of any kind: the only way to know a change to it was safe was to
// open a browser and look at three or four amiibo, which is exactly the process
// this project keeps finding to be unreliable.
//
// The snapshots are not here to be pretty. They are here so that when the
// renderer is pulled out into a module the admin can also mount, the public
// page can be shown to draw byte-for-byte what it drew before. If one of them
// changes, either the change was intended — in which case update the file and
// say so — or the refactor broke something.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

import { mountPage } from './helpers/dom.mjs';

register('./helpers/loader.mjs', import.meta.url);

// Captured from the page before the renderer moved. Committed, so the
// comparison survives across runs and across the refactor — an in-memory
// snapshot only ever proves a run agrees with itself.
const EXPECTED = JSON.parse(
  readFileSync(new URL('./fixtures/amiibodetail-snapshots.json', import.meta.url), 'utf8'));

const PAGE = 'web/amiibo.html';

// Three amiibo that between them exercise every branch of render():
//   Mario  — a plain figure: portrait, badges, files, ID, format, both strips
//   Kirby  — Kirby Air Riders: the vehicles block, four pairings per ID
//   HHD    — the fan-made card set: our own mark, 91 tiles, no artwork
const MARIO = '0000000000000002';
const KIRBY = '1f00000004c41e03';
const HHD = '026a000100000002';

/** A scan cache shaped exactly as collectionui.js's saveScanCache writes it. */
function scanCache({ local = [], device = null, names = [], vehicles = [], hhdLocal = [], hhdDevice = [] } = {}) {
  return JSON.stringify({
    localIds: local,
    deviceIds: device,
    namesById: names,
    vehiclesById: vehicles,
    hhdLocalUids: hhdLocal,
    hhdDeviceUids: hhdDevice,
  });
}

let run = 0;

/**
 * Load the detail page for one amiibo and return what it rendered.
 *
 * The module is cache-busted per call because it does all its work at import
 * time — the same trick server/index.mjs uses on the regenerated database.
 */
async function renderDetail(id, { cache = null, order = null, search = '' } = {}) {
  const storage = {};
  if (cache) storage.collectionScan = cache;
  if (order) storage['allmiibo:s:order'] = JSON.stringify(order);

  const page = mountPage(PAGE, {
    url: `http://localhost/amiibo.html?id=${id}${search}`,
    storage,
  });
  // sessionStorage is where the detail page reads the scan from; the harness
  // gives both stores the same backing, so seed it explicitly.
  globalThis.sessionStorage = {
    getItem: (k) => storage[k] ?? null,
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };

  await import(`../web/js/amiibodetail.js?v=${run++}`);

  return {
    page,
    title: globalThis.document.title,
    content: page.byId('content').innerHTML,
    seriesStrip: {
      hidden: page.byId('seriesStrip').hidden,
      title: page.byId('stripTitle').textContent,
      cells: page.byId('stripRow').children.length,
    },
    variantStrip: {
      hidden: page.byId('variantStrip').hidden,
      cells: page.byId('variantRow').children.length,
    },
    sequence: {
      prev: page.byId('prevBtn').hidden,
      next: page.byId('nextBtn').hidden,
      pos: page.byId('pos').textContent,
    },
  };
}

// ---- the snapshots ------------------------------------------------------
//
// Captured from the page as it stood before the extraction. Compared as whole
// strings: a diff in any of them is the signal.

const SNAPSHOTS = new Map();

test('a plain figure renders its portrait, facts, badges and both strips', async () => {
  const r = await renderDetail(MARIO, {
    cache: scanCache({ local: [MARIO], device: [MARIO], names: [[MARIO, ['Mario.bin', 'mario-copy.bin']]] }),
  });
  try {
    SNAPSHOTS.set('mario', r.content);

    assert.equal(r.title, 'Mario · allmiibo');
    assert.match(r.content, /<div class="portrait">/);
    assert.match(r.content, /<h1>Mario<\/h1>/);
    assert.match(r.content, /class="tag ok-tag">OWNED</);
    assert.match(r.content, /ON DEVICE/);
    assert.match(r.content, /YOUR FILES \(2\)/);
    assert.match(r.content, /Mario\.bin/);
    assert.match(r.content, /00000000 00000002/, 'the ID is split for readability');
    assert.match(r.content, /Format v/);

    // The tier ladder starts at the largest.
    assert.match(r.content, /src="\.\/data\/images\/full\/0000000000000002\.png"/);

    assert.equal(r.seriesStrip.hidden, false);
    assert.ok(r.seriesStrip.cells > 1, 'the series strip is populated');
    assert.match(r.seriesStrip.title, /^MORE IN .+ \(\d+\)$/);
    assert.equal(r.variantStrip.hidden, false, 'Mario has variants');
    assert.ok(r.variantStrip.cells > 1);
  } finally {
    r.page.restore();
  }
});

test('an Air Riders amiibo lists every vehicle, marking the ones held', async () => {
  const r = await renderDetail(KIRBY, {
    cache: scanCache({
      local: [KIRBY],
      vehicles: [[KIRBY, [['Warp Star', { local: true }], ['Winged Star', { local: false }]]]],
    }),
  });
  try {
    SNAPSHOTS.set('kirby', r.content);

    assert.match(r.content, /class="vehiclesBlock"/);
    assert.match(r.content, /VEHICLES/);
    assert.match(r.content, /class="vCard have"/, 'a held pairing is solid');
    assert.match(r.content, /class="vCard"/, 'an unheld one is not');
    assert.match(r.content, /vehicles\/warp-star\.png/, 'the slug is lowercased and hyphenated');
    assert.match(r.content, /Every rider fits every machine/);
  } finally {
    r.page.restore();
  }
});

test('the fan-made card set draws our own mark and all 91 tiles', async () => {
  const { HHD_CARDS } = await import('../web/data/hhd-cards.js');
  const held = HHD_CARDS.slice(0, 3).map((c) => c.uid);
  const r = await renderDetail(HHD, {
    cache: scanCache({ local: [HHD], hhdLocal: held, hhdDevice: [HHD_CARDS[0].uid] }),
  });
  try {
    SNAPSHOTS.set('hhd', r.content);

    assert.match(r.content, /class="portrait hhdMark"/, 'no official artwork, so no <img>');
    assert.doesNotMatch(r.content, /<img/, 'and nothing to 404');
    assert.match(r.content, /<h1>Happy Home Designer cards<\/h1>/);
    assert.match(r.content, new RegExp(`THE CARDS \\(3/${HHD_CARDS.length}\\)`));
    assert.match(r.content, /not official Nintendo cards/);

    const tiles = (r.content.match(/class="cTile/g) ?? []).length;
    assert.equal(tiles, HHD_CARDS.length, 'one tile per card');
    const have = (r.content.match(/class="cTile have"/g) ?? []).length;
    assert.equal(have, 3, 'and the three held ones are marked');
  } finally {
    r.page.restore();
  }
});

// ---- the states that are easy to get wrong ------------------------------

test('with no scan at all the page says so rather than guessing', async () => {
  const r = await renderDetail(MARIO);
  try {
    assert.match(r.content, /class="tag unknown">NOT SCANNED</);
    assert.doesNotMatch(r.content, /OWNED/);
    assert.doesNotMatch(r.content, /YOUR FILES/);
  } finally {
    r.page.restore();
  }
});

test('a link opened in a fresh tab falls back to the URL', async () => {
  const r = await renderDetail(MARIO, { search: '&owned=1' });
  try {
    assert.match(r.content, /class="tag ok-tag">OWNED</);
    assert.doesNotMatch(r.content, /NOT SCANNED/);
  } finally {
    r.page.restore();
  }
});

test('an id that is not an amiibo renders the empty state and nothing else', async () => {
  const r = await renderDetail('nonsense');
  try {
    assert.match(r.content, /class="empty"/);
    assert.match(r.content, /THAT'S NOT AN AMIIBO/);
    assert.match(r.content, /BROWSE THE COLLECTION/);
    assert.doesNotMatch(r.content, /class="portrait"/);
    assert.equal(r.seriesStrip.hidden, true, 'and no strips under it');
    assert.equal(r.variantStrip.hidden, true);
  } finally {
    r.page.restore();
  }
});

test('prev and next follow the collection order, and appear only where they can', async () => {
  const order = ['aaaaaaaaaaaaaaaa', MARIO, 'bbbbbbbbbbbbbbbb'];
  const middle = await renderDetail(MARIO, { order });
  try {
    assert.equal(middle.sequence.prev, false, 'both arrows in the middle');
    assert.equal(middle.sequence.next, false);
    assert.equal(middle.sequence.pos, '2 / 3');
  } finally {
    middle.page.restore();
  }

  const first = await renderDetail(MARIO, { order: [MARIO, 'bbbbbbbbbbbbbbbb'] });
  try {
    assert.equal(first.sequence.prev, true, 'no previous at the start');
    assert.equal(first.sequence.next, false);
    assert.equal(first.sequence.pos, '1 / 2');
  } finally {
    first.page.restore();
  }

  const absent = await renderDetail(MARIO, { order: ['cccccccccccccccc'] });
  try {
    assert.equal(absent.sequence.prev, true, 'an amiibo outside the order gets no sequence');
    assert.equal(absent.sequence.next, true);
    assert.equal(absent.sequence.pos, '');
  } finally {
    absent.page.restore();
  }
});

// ---- the snapshot itself ------------------------------------------------

test('the page renders byte-for-byte what it rendered before the refactor', async () => {
  // The acceptance test for the whole extraction. The fixture was captured from
  // the page as it stood; if this passes after the renderer moves into a shared
  // module, the public page draws exactly what it drew.
  //
  // A diff here means one of two things, and it is worth being honest about
  // which: the refactor changed the output, or the output was changed on
  // purpose and the fixture needs regenerating. It is never "just update it".
  assert.deepEqual([...SNAPSHOTS.keys()].sort(), ['hhd', 'kirby', 'mario'],
    'all three fixtures were rendered by the tests above');

  for (const [name, html] of SNAPSHOTS) {
    assert.ok(EXPECTED[name], `${name} has a committed snapshot`);
    assert.equal(html, EXPECTED[name].content, `${name} renders identically`);
    assert.ok(html.length > 400, `${name} is a real page, not an empty div`);
  }
});

test('the snapshot can actually fail', () => {
  // A snapshot compared against itself proves nothing. Perturb one and require
  // the comparison to notice.
  const real = EXPECTED.mario.content;
  const tampered = real.replace('<h1>Mario</h1>', '<h1>Marlo</h1>');
  assert.notEqual(tampered, real, 'the fixture contains what the test thinks it does');
  assert.throws(
    () => assert.equal(tampered, real),
    /strictly equal/,
    'a one-character difference must fail the comparison above');
});
