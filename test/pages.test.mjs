// Static integrity checks over the HTML pages: every deployable page must
// carry the full head kit (viewport, icons, manifest, OG tags), load the
// shared header/footer, and not regrow a hand-written <nav>. These are the
// "stupid mistake" guards for a site with no build step — nothing assembles
// the pages, so nothing else notices a missing tag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const read = (f) => readFile(new URL(f, `file://${WEB}`), 'utf8');

const PAGES = ['index.html', 'collection.html', 'sync.html', 'debug.html', 'help.html', 'amiibo.html', 'legal.html', 'changelog.html'];

const HEAD_KIT = [
  'name="viewport"',
  'name="description"',
  'name="theme-color"',
  'href="./favicon.svg" type="image/svg+xml"',
  'href="./icons/favicon-32.png"',
  'rel="apple-touch-icon"',
  'rel="manifest"',
  'property="og:title"',
  'property="og:description"',
  'property="og:image"',
  'name="twitter:card"',
  'href="./css/app.css"',
  "localStorage.getItem('allmiibo:mode')", // pre-paint preference script
];

test('every page carries the full head kit', async () => {
  for (const page of PAGES) {
    const src = await read(page);
    for (const marker of HEAD_KIT) {
      assert.ok(src.includes(marker), `${page} is missing ${marker}`);
    }
  }
});

test('shared header and footer are wired correctly', async () => {
  for (const page of PAGES) {
    const src = await read(page);
    assert.ok(src.includes('js/footer.js'), `${page} is missing the footer`);
    if (page === 'index.html') {
      // The title screen deliberately has no header — and renders its own mascot.
      assert.ok(!src.includes('js/header.js'), 'index.html must not load the header');
      assert.ok(src.includes('data-pirate-mark'), 'index.html lost its mascot placeholder');
      assert.ok(src.includes("from './js/sprite.js'"), 'index.html must render the mascot itself');
    } else {
      assert.ok(src.includes('js/header.js'), `${page} is missing the shared header`);
    }
  }
});

test('no page regrows a hand-written nav (amiibo keeps its back-link)', async () => {
  for (const page of PAGES) {
    const navs = (await read(page)).match(/<nav[ >]/g) ?? [];
    const allowed = page === 'amiibo.html' ? 1 : 0;
    assert.equal(navs.length, allowed, `${page} has ${navs.length} hand-written <nav> blocks`);
  }
});

test('sync page keeps its expert controls behind advanced mode', async () => {
  // The op cards render from JS now; the page itself gates the device-root
  // input, the raw plan and the log, and the JS marks the expert ops.
  const src = await read('sync.html');
  assert.ok((src.match(/advanced-only/g) ?? []).length >= 2,
    'raw plan and log should be advanced-only');
  const js = await readFile(new URL('../web/js/syncflow.js', import.meta.url), 'utf8');
  assert.ok((js.match(/advanced: true/g) ?? []).length >= 3,
    'match/replace/check ops should be advanced');
});

function pngSize(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('manifest and icon assets exist with the right shapes', async () => {
  const manifest = JSON.parse(await read('manifest.webmanifest'));
  for (const icon of manifest.icons) {
    const buf = await readFile(new URL(icon.src, `file://${WEB}`));
    const { width } = pngSize(buf);
    assert.equal(`${width}x${width}`, icon.sizes, `${icon.src} size mismatch`);
  }
  const og = await readFile(new URL('./icons/og.png', `file://${WEB}`));
  assert.deepEqual(pngSize(og), { width: 1200, height: 630 }, 'og.png must be 1200x630');
  const fav = await readFile(new URL('./icons/favicon-32.png', `file://${WEB}`));
  assert.equal(pngSize(fav).width, 32);
  assert.ok((await read('favicon.svg')).includes('<svg'), 'favicon.svg must be an SVG');
});


test('the old probe/write-test URLs redirect to the debug page', async () => {
  for (const stub of ['probe.html', 'write-test.html']) {
    const src = await read(stub);
    assert.match(src, /http-equiv="refresh"[^>]*debug\.html/, `${stub} must redirect`);
    assert.ok(src.includes('href="./debug.html'), `${stub} needs a fallback link`);
  }
});

test('the header nav offers exactly collection and sync', async () => {
  const js = await readFile(new URL('../web/js/header.js', import.meta.url), 'utf8');
  const pagesBlock = js.match(/const PAGES = \[([\s\S]*?)\];/)[1];
  assert.ok(pagesBlock.includes('collection.html') && pagesBlock.includes('sync.html'));
  assert.ok(!pagesBlock.includes('probe') && !pagesBlock.includes('write-test'),
    'dev tools must not be in the nav');
});

test('every page has a distinct tab title', async () => {
  const titles = [];
  for (const page of PAGES) {
    const m = (await read(page)).match(/<title>([^<]*)<\/title>/);
    titles.push(m?.[1] ?? '');
  }
  assert.equal(new Set(titles).size, titles.length, `titles collide: ${titles.join(' | ')}`);
});
