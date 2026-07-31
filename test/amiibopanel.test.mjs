// The detail panel, built against a real DOM and the real database.
//
// amiibodetail-page.test.mjs proves the public page still draws what it drew.
// This file is about the module underneath it: that it takes everything
// page-specific through hooks, so the admin can mount it at a different URL
// root, with no scan, and without 91 card tiles in a 24rem side panel.
//
// The check that matters most is "every image URL comes from the hook". Four
// inline literals were the reason the renderer could not be shared at all: the
// site is served from './' and the admin from '/', so a path that is correct on
// one is broken on the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountHtml } from './helpers/dom.mjs';
import {
  buildAmiiboDetail, buildAmiiboStrip, DETAIL_SECTIONS, nameOf,
} from '../web/js/amiibopanel.js';
import { seriesSiblings, characterVariants, KNOWN_VEHICLES } from '../web/js/amiibo.js';
import { AMIIBO_NAMES, AMIIBO_RELEASE } from '../web/data/amiibo-db.js';
import { HHD_CARDS } from '../web/data/hhd-cards.js';

const PAGE = '<!doctype html><html><body><div id="content"></div></body></html>';

const MARIO = '0000000000000002';
const KIRBY = '1f00000004c41e03';
const HHD = '026a000100000002';

/** A sentinel art hook: anything it produces is unmistakably from the hook. */
const ART = (id, tier = 'thumb') => `SENTINEL/${tier}/${id}.png`;
ART.vehicle = (name) => `SENTINEL/vehicles/${name}.png`;

function build(id, opts = {}) {
  const page = mountHtml(PAGE);
  const detail = buildAmiiboDetail(id, { art: ART, doc: page.document, ...opts });
  page.byId('content').append(detail.frag);
  return { page, detail };
}

// ---- what it draws ------------------------------------------------------

test('a plain amiibo gets a portrait, a name and a subtitle', () => {
  const { page, detail } = build(MARIO);
  try {
    assert.equal(detail.valid, true);
    assert.equal(detail.name, 'Mario');
    assert.ok(page.$('.portrait img'), 'the portrait is an image');
    assert.equal(page.$('.facts h1').textContent, 'Mario');
    assert.match(page.$('.facts .subtitle').textContent, /·/, 'series · type · year');
    assert.match(page.$('.idmono').textContent, /^00000000 00000002$/);
  } finally {
    page.restore();
  }
});

test('every image URL comes from the hook, and none from a literal path', () => {
  // The bug this guards: `./data/images/...` inlined in the renderer, correct
  // on the site and broken in the admin.
  for (const id of [MARIO, KIRBY, HHD]) {
    const { page } = build(id, { vehicleArt: ART.vehicle });
    try {
      const srcs = page.$$('img').map((i) => i.getAttribute('src'));
      for (const src of srcs) {
        assert.match(src, /^SENTINEL\//, `${id} drew ${src} without the hook`);
      }
    } finally {
      page.restore();
    }
  }

  // And the strip, which had its own literal.
  const page = mountHtml(PAGE);
  try {
    const strip = buildAmiiboStrip(seriesSiblings(MARIO).slice(0, 5), {
      art: ART,
      href: (id) => `HREF/${id}`,
      doc: page.document,
    });
    page.byId('content').append(strip.frag);
    for (const img of page.$$('img')) {
      assert.match(img.getAttribute('src'), /^SENTINEL\//);
    }
    for (const a of page.$$('a')) {
      assert.match(a.getAttribute('href'), /^HREF\//, 'the detail URL is a hook too');
    }
  } finally {
    page.restore();
  }
});

test('the portrait starts at the largest tier and steps down on error', () => {
  const { page } = build(MARIO);
  try {
    const img = page.$('.portrait img');
    assert.equal(img.getAttribute('src'), `SENTINEL/full/${MARIO}.png`);

    img.dispatchEvent(new page.window.Event('error'));
    assert.equal(img.getAttribute('src'), `SENTINEL/med/${MARIO}.png`);
    img.dispatchEvent(new page.window.Event('error'));
    assert.equal(img.getAttribute('src'), `SENTINEL/thumb/${MARIO}.png`);

    // Out of tiers: the image goes and its initial takes over.
    img.dispatchEvent(new page.window.Event('error'));
    assert.equal(page.$('.portrait img'), null);
    assert.equal(page.$('.portrait .noArt').textContent, 'M');
  } finally {
    page.restore();
  }
});

// ---- ownership is injected, never inferred ------------------------------

test('no ownership means NOT SCANNED, which is not the same as not owned', () => {
  const { page } = build(MARIO, { ownership: null });
  try {
    assert.equal(page.$('.badges .tag.unknown').textContent, 'NOT SCANNED');
    assert.equal(page.$('.tag.ok-tag'), null);
  } finally {
    page.restore();
  }

  const scanned = build(MARIO, { ownership: { owned: false, onDevice: false } });
  try {
    assert.equal(scanned.page.$('.tag.unknown'), null, 'a scan that found nothing is not "unknown"');
    assert.equal(scanned.page.$('.tag.ok-tag'), null, 'and it is not owned either');
  } finally {
    scanned.page.restore();
  }
});

test('ownership drives the badges and the file list', () => {
  const { page } = build(MARIO, {
    ownership: { owned: true, onDevice: true, files: ['Mario.bin', 'spare.bin'] },
  });
  try {
    assert.equal(page.$('.tag.ok-tag').textContent, 'OWNED');
    assert.match(page.$('.tag.dev').textContent, /ON DEVICE/);
    assert.match(page.$('.fileBlock h2').textContent, /YOUR FILES \(2\)/);
    assert.equal(page.$$('.fileBlock li').length, 2);
  } finally {
    page.restore();
  }
});

test('a long file list is capped, and says how many it left out', () => {
  const files = Array.from({ length: 20 }, (_, i) => `dump-${i}.bin`);
  const { page } = build(MARIO, { ownership: { owned: true, files } });
  try {
    const items = page.$$('.fileBlock li');
    assert.equal(items.length, 13, '12 files plus the tally line');
    assert.match(items.at(-1).textContent, /and 8 more/);
    assert.match(page.$('.fileBlock h2').textContent, /\(20\)/, 'the heading still counts them all');
  } finally {
    page.restore();
  }
});

test('the module never reads storage or the URL for itself', async () => {
  const { readFileSync } = await import('node:fs');
  // Comments stripped: the module's own header names these things in order to
  // say it does not use them, and a check that reads prose is not a check.
  const src = readFileSync(new URL('../web/js/amiibopanel.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  for (const forbidden of [/sessionStorage/, /localStorage/, /\blocation\b/, /document\.title/,
    /getElementById/, /scrollIntoView/, /navigator\./]) {
    assert.doesNotMatch(src, forbidden,
      `${forbidden} belongs to a page, not to a renderer the admin also mounts`);
  }
  // And the check is capable of failing.
  assert.match('const x = sessionStorage.getItem("a");'.replace(/^\s*\/\/.*$/gm, ''), /sessionStorage/);
});

// ---- sections -----------------------------------------------------------

test('a caller gets only the sections it asks for', () => {
  const { page } = build(HHD, { sections: ['portrait', 'title'] });
  try {
    assert.ok(page.$('.portrait'), 'what was asked for');
    assert.ok(page.$('.facts h1'));
    assert.equal(page.$('.badges'), null, 'and nothing that was not');
    assert.equal(page.$('.idRow'), null);
    assert.equal(page.$('.cardGrid'), null, '91 tiles do not belong in a side panel');
  } finally {
    page.restore();
  }
  assert.ok(DETAIL_SECTIONS.includes('cards'), 'the full page does draw them');
});

test('the COPY button exists only when there is somewhere to copy to', () => {
  const without = build(MARIO);
  try {
    assert.ok(without.page.$('.idmono'), 'the ID is always shown');
    assert.equal(without.page.$('.idRow button'), null, 'the button is not');
  } finally {
    without.page.restore();
  }

  const copied = [];
  const withHook = build(MARIO, { onCopy: (id) => copied.push(id) });
  try {
    withHook.page.$('.idRow button').dispatchEvent(new withHook.page.window.Event('click'));
    assert.deepEqual(copied, [MARIO], 'and it calls the hook, not the clipboard');
  } finally {
    withHook.page.restore();
  }
});

test('adorn is called for each part that was drawn, and only those', () => {
  const seen = [];
  const { page } = build(MARIO, {
    sections: ['portrait', 'title', 'id'],
    adorn: (part, node) => { seen.push(part); assert.ok(node, `${part} has a node`); },
  });
  try {
    assert.deepEqual(seen.sort(), ['id', 'portrait', 'subtitle', 'title']);
    assert.equal(seen.includes('cards'), false);
  } finally {
    page.restore();
  }
});

// ---- the two special products -------------------------------------------

test('the fan-made set draws our own mark and every card', () => {
  const held = new Set(HHD_CARDS.slice(0, 4).map((c) => c.uid));
  const { page, detail } = build(HHD, {
    ownership: { owned: true, hhdLocal: held, hhdDevice: new Set([HHD_CARDS[0].uid]) },
  });
  try {
    assert.equal(detail.name, 'Happy Home Designer cards');
    assert.ok(page.$('.portrait.hhdMark svg'), 'our mark, not artwork');
    assert.equal(page.$('.portrait img'), null, 'so nothing to 404');

    assert.equal(page.$$('.cTile').length, HHD_CARDS.length);
    assert.equal(page.$$('.cTile.have').length, 4);
    assert.match(page.$('.cardsBlock h2').textContent, new RegExp(`\\(4/${HHD_CARDS.length}\\)`));
    assert.equal(page.$$('.cDev').length, 1, 'one card is on the device');
  } finally {
    page.restore();
  }
});

test('an Air Riders amiibo lists every pairing, marking the ones held', () => {
  const { page } = build(KIRBY, {
    vehicleArt: ART.vehicle,
    ownership: { owned: true, vehicles: new Set(['Warp Star']) },
  });
  try {
    assert.equal(page.$$('.vCard').length, KNOWN_VEHICLES.length);
    assert.equal(page.$$('.vCard.have').length, 1);
    assert.equal(page.$$('.vArt img').length, KNOWN_VEHICLES.length);

    // The help note toggles rather than being always on.
    const note = page.$('.vNote');
    assert.equal(note.classList.contains('open'), false);
    page.$('.vehiclesBlock .why').dispatchEvent(new page.window.Event('click'));
    assert.equal(note.classList.contains('open'), true);
  } finally {
    page.restore();
  }
});

test('vehicle images are omitted rather than broken when there is no hook', () => {
  const { page } = build(KIRBY, { ownership: { owned: true, vehicles: new Set() } });
  try {
    assert.equal(page.$$('.vCard').length, KNOWN_VEHICLES.length, 'the pairings still show');
    assert.equal(page.$$('.vArt img').length, 0, 'without a src that could not resolve');
  } finally {
    page.restore();
  }
});

// ---- the empty state ----------------------------------------------------

test('a bad id renders the empty state and nothing else', () => {
  const { page, detail } = build('not-an-amiibo');
  try {
    assert.equal(detail.valid, false);
    assert.equal(detail.portrait, null);
    assert.equal(detail.facts, null);
    assert.match(page.$('.empty .eTitle').textContent, /NOT AN AMIIBO/);
    assert.equal(page.$('.portrait'), null);
    assert.equal(page.$('.idRow'), null);
    assert.equal(page.$('.empty button'), null, 'and no action without a hook to run');
  } finally {
    page.restore();
  }

  const acted = [];
  const withAction = build('zzz', { onEmptyAction: () => acted.push(1) });
  try {
    withAction.page.$('.empty button').dispatchEvent(new withAction.page.window.Event('click'));
    assert.equal(acted.length, 1);
  } finally {
    withAction.page.restore();
  }
});

// ---- strips -------------------------------------------------------------

test('a strip marks the current amiibo and hands the node back for scrolling', () => {
  const page = mountHtml(PAGE);
  try {
    const ids = seriesSiblings(MARIO);
    const strip = buildAmiiboStrip(ids, {
      current: MARIO,
      art: ART,
      href: (id) => `./amiibo.html?id=${id}`,
      isOwned: (id) => id === ids[0],
      doc: page.document,
    });
    page.byId('content').append(strip.frag);

    assert.equal(page.$$('#content > a').length, ids.length, 'one cell per sibling');
    assert.equal(page.$$('a.current').length, 1);
    assert.equal(strip.current, page.$('a.current'), 'returned rather than scrolled to');
    assert.equal(page.$$('a.owned').length, 1);
    assert.equal(page.$('a .sNm').textContent, nameOf(ids[0]));
  } finally {
    page.restore();
  }
});

test('the sibling and variant lookups match a full scan, and are computed once', () => {
  // They replaced a filter over ~950 keys run on every render. This asserts the
  // replacement is equivalent for every amiibo in the database, not just one.
  const ids = Object.keys(AMIIBO_NAMES);
  const scanSiblings = (byte) => ids
    .filter((x) => x.slice(12, 14) === byte)
    .sort((a, b) => (AMIIBO_RELEASE[a] ?? '9999').localeCompare(AMIIBO_RELEASE[b] ?? '9999')
      || a.localeCompare(b));
  const scanVariants = (head) => ids.filter((x) => x.slice(0, 8) === head);

  for (const id of ids) {
    assert.deepEqual(seriesSiblings(id), scanSiblings(id.slice(12, 14)), `siblings of ${id}`);
    assert.deepEqual(characterVariants(id), scanVariants(id.slice(0, 8)), `variants of ${id}`);
  }
  assert.equal(seriesSiblings(MARIO), seriesSiblings(MARIO), 'the same array, not a rebuild');
});

// ---- the contract -------------------------------------------------------

test('these checks fail when the bugs that made the split necessary come back', () => {
  const page = mountHtml(PAGE);
  try {
    // 1. A missing hook fails loudly rather than drawing broken images.
    assert.throws(() => buildAmiiboDetail(MARIO, { doc: page.document }), /art hook/);
    assert.throws(() => buildAmiiboStrip([], { doc: page.document }), /art hook/);
    assert.throws(() => buildAmiiboStrip([], { art: ART, doc: page.document }), /href hook/);

    // 2. A hard-coded path must fail the "everything from the hook" check.
    const img = page.document.createElement('img');
    img.src = './data/images/full/x.png';
    assert.throws(
      () => assert.match(img.getAttribute('src'), /^SENTINEL\//),
      /did not match/,
      'a literal path must fail');

    // 3. Treating "not scanned" as "not owned" must fail the tri-state check.
    const guessed = buildAmiiboDetail(MARIO, {
      art: ART, doc: page.document, ownership: { owned: false },
    });
    page.byId('content').append(guessed.frag);
    assert.equal(page.$('.tag.unknown'), null,
      'an actual scan says nothing, which is right');
    assert.throws(
      () => assert.equal(page.$('.tag.unknown').textContent, 'NOT SCANNED'),
      /Cannot read properties of null/,
      'and conflating the two would fail the check above');
  } finally {
    page.restore();
  }
});
