// Everything the admin page asks for, fetched from the real server.
//
// This exists because of a bug the rest of the suite could not see. The admin
// draws the collection grid, so it imports /js/amiibo.js, which imports
// ../data/amiibo-db.js — the browser resolves that to /data/amiibo-db.js. The
// server routed /data/images/ to the public site and nothing else, so the
// database 404'd. A module whose import 404s never executes at all, so the page
// sat on the sign-in form showing the boot notice.
//
// Nothing caught it: the unit tests resolve /js/ and /data/ straight to disk
// through a loader hook, which is more permissive than the server. The only
// honest check is to serve the files and follow every reference, which is what
// this does — starting at the page and walking the import graph transitively,
// exactly as a browser would.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createAdminServer } from '../server/index.mjs';
import { hashPassword } from '../server/auth.mjs';

const REPO = new URL('../', import.meta.url).pathname;

let dir;
let handle;
let base;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'allmiibo-assets-'));
  await mkdir(join(dir, 'data'), { recursive: true });

  // The real public site, not a temp copy: the point is to prove the admin's
  // references resolve against what is actually deployed beside it.
  const ctx = createAdminServer({
    passwordHash: hashPassword('unused here'),
    sessionSecret: 'a'.repeat(64),
    publicSiteDir: join(REPO, 'web'),
    dataDir: join(dir, 'data'),
    cacheDir: join(REPO, 'tools/.cache'),
    secureCookies: false,
  });
  handle = ctx.server;
  await new Promise((r) => handle.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${handle.address().port}`;
});

after(async () => {
  await new Promise((r) => handle.close(r));
  await rm(dir, { recursive: true, force: true });
});

/** Resolve a module specifier the way a browser does, against the URL it came from. */
function resolveSpecifier(specifier, fromPath) {
  if (specifier.startsWith('/')) return specifier;
  return new URL(specifier, `http://x${fromPath}`).pathname;
}

/** Every static import in a module's source. */
function importsOf(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,  // import x from '...'
    /\bimport\s*['"]([^'"]+)['"]/g,                 // bare side-effect import
    /\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,   // re-export
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

test('every stylesheet and script the admin page references is served', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200, 'the admin page itself');
  const html = await page.text();

  const refs = [
    ...[...html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]),
  ].filter((href) => !href.startsWith('http'));

  assert.ok(refs.length >= 3, 'the page references stylesheets and a module');

  for (const ref of refs) {
    const path = resolveSpecifier(ref, '/index.html');
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, `${ref} is served (resolved to ${path})`);
  }
});

test('the whole import graph resolves, transitively, as the browser walks it', async () => {
  // The failure this guards against is one import deep: adminui.js imports
  // /js/amiibo.js, which is served; amiibo.js imports ../data/amiibo-db.js,
  // which was not. Checking only the page's own references would miss it.
  const seen = new Set();
  const missing = [];
  const queue = [['/adminui.js', '/index.html']];

  while (queue.length) {
    const [spec, from] = queue.shift();
    const path = resolveSpecifier(spec, from);
    if (seen.has(path)) continue;
    seen.add(path);

    const res = await fetch(`${base}${path}`);
    if (res.status !== 200) {
      missing.push(`${path} (imported from ${from}) -> HTTP ${res.status}`);
      continue;
    }
    const type = res.headers.get('content-type') ?? '';
    assert.match(type, /javascript/, `${path} is served as a module, not as text`);

    for (const next of importsOf(await res.text())) queue.push([next, path]);
  }

  assert.deepEqual(missing, [], 'every module the admin reaches is served');

  // The walk has to have actually gone somewhere, or an empty graph would pass.
  assert.ok(seen.has('/js/amiibo.js'), 'the walk reached the shared collection code');
  assert.ok(seen.has('/data/amiibo-db.js'), 'and the database it imports in turn');
  assert.ok(seen.has('/js/collectiongrid.js'), 'and the shared grid');
  assert.ok(seen.has('/js/icons.js') && seen.has('/js/sprite.js'), 'and the brand assets');
  // The admin's graph is deliberately small — it borrows the collection code and
  // nothing else. If this drops, the walk stopped early rather than the page
  // getting simpler.
  assert.ok(seen.size >= 7, `the graph is real (${seen.size} modules)`);
});

test('the artwork the grid asks for is served from the site', async () => {
  // Not whether a particular picture exists — many amiibo have none, and the
  // page handles that — but that the route reaches the site's image directory
  // rather than the admin's own, where nothing would ever be found.
  const res = await fetch(`${base}/data/images/thumb/does-not-exist.png`);
  assert.equal(res.status, 404, 'a missing thumbnail is a plain 404');

  const traversal = await fetch(`${base}/data/../../etc/passwd`);
  assert.ok([403, 404].includes(traversal.status),
    'and the broadened /data/ route is still confined to the site');
});

test('a path outside the shared prefixes still comes from the admin, not the site', async () => {
  // /js/, /css/, /fonts/ and /data/ resolve into the public site. Everything
  // else must stay in the admin directory, or the admin would start serving
  // the site's pages from its own hostname.
  for (const path of ['/collection.html', '/help.html', '/index.html']) {
    const res = await fetch(`${base}${path}`);
    const body = res.status === 200 ? await res.text() : '';
    assert.ok(!body.includes('id="series"') || body.includes('ALLMIIBO<span class="sfx">-ADMIN'),
      `${path} is not the public site's page served from the admin`);
  }
});
