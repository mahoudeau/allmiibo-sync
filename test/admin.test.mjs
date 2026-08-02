// Guards against the admin leaking itself.
//
// The repository is public. The code being readable is fine and expected; a
// secret ending up in it is not. These are the mistakes that are catastrophic
// and invisible, so they are checked mechanically rather than remembered.
//
// Note what this file does NOT contain: the admin's hostname. A test that names
// the thing it is protecting has published it. The subdomain check below works
// by pattern, so it catches any subdomain of the public site without knowing
// which one is real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every text file that is committed OR is about to be.
 *
 * `--others --exclude-standard` is the load-bearing part: a plain `git ls-files`
 * sees only tracked files, so a brand new file — the very place a fresh secret
 * is most likely to be — would go unchecked until the commit that leaks it had
 * already happened. Ignored files are still excluded, since .env and deploy.sh
 * are supposed to exist locally and hold exactly these values.
 */
function trackedTextFiles() {
  const out = execFileSync(
    'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8' }
  );
  const binary = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.bin', '.fca', '.docx']);
  return out.split('\0').filter(Boolean)
    .filter((f) => !binary.has(extname(f).toLowerCase()))
    .filter((f) => existsSync(join(REPO, f)));
}

const read = (f) => readFileSync(join(REPO, f), 'utf8');

// ---- the hostname -------------------------------------------------------

/**
 * Every host under the site's domain in a piece of text, as the label(s) in
 * front of it.
 *
 * An ALLOWLIST rather than a pattern describing the admin, for the reason this
 * file exists: a rule that spells out what it is hiding has published it. So
 * the names that may appear are named, and anything else is a leak.
 *
 * The capture is greedy across dots, so a multi-level host comes back whole —
 * two labels in front are reported as both, not just the nearest. An earlier
 * version matched only children of the public site, which described one SHAPE
 * of admin hostname and stopped protecting anything the moment the admin moved
 * to a sibling instead. The shape was never the point.
 *
 * Note that no example appears in this comment. Written out, one would be
 * caught by the very rule below — as happened while this was being changed.
 */
const HOSTS = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.mathieu\.dev\b/gi;
const ALLOWED_HOSTS = new Set(['allmiibo', 'ziip']);

const leakedHosts = (text) => [...text.matchAll(HOSTS)]
  .map((m) => m[1].toLowerCase())
  .filter((prefix) => !ALLOWED_HOSTS.has(prefix));

test('no committed file names a host other than the public site', () => {
  // allmiibo.mathieu.dev legitimately appears in every page's og:url. Any other
  // host under that domain does not, and that is where the admin lives.
  for (const file of trackedTextFiles()) {
    const hits = leakedHosts(read(file));
    assert.deepEqual(hits, [], `${file} names a host it must not: ${hits.join(', ')}`);
  }
});

test('the guard would actually catch a leak', () => {
  // A guard that cannot fail is not a guard. This pins the behaviour in both
  // directions, and specifically over both shapes an admin hostname has taken:
  // a child of the public site, and a sibling of it.
  //
  // The examples are assembled at runtime rather than written out, because this
  // file is checked by the very rule above: a literal would make the guard fail
  // on itself. Exempting this file instead would leave a blind spot in exactly
  // the file that must not have one.
  const domain = ['mathieu', 'dev'].join('.');
  const site = `allmiibo.${domain}`;

  assert.deepEqual(leakedHosts(`https://example.${site}/`), ['example.allmiibo'],
    'a child of the public site');
  assert.deepEqual(leakedHosts(`https://example-allmiibo.${domain}/`), ['example-allmiibo'],
    'a sibling of it, which the previous pattern missed entirely');
  assert.deepEqual(leakedHosts(`ADMIN_HOST=secret.${domain}`), ['secret']);

  assert.deepEqual(leakedHosts(`https://${site}/help.html`), [], 'the public site is fine');
  assert.deepEqual(leakedHosts(`see ${domain} for details`), [], 'so is the bare domain');
});

// ---- secrets ------------------------------------------------------------

test('no committed file contains a secret value', () => {
  // The names may appear, in documentation and in code that reads them. An
  // assignment with something after the equals sign may not.
  const ASSIGNED = /\b(ADMIN_PASSWORD_HASH|SESSION_SECRET|FTP_PASS|ADMIN_PASS)\s*=\s*\S/;
  for (const file of trackedTextFiles()) {
    const line = read(file).split('\n').find((l) => ASSIGNED.test(l) && !l.trim().startsWith('//'));
    assert.equal(line, undefined, `${file} assigns a secret: ${line?.trim()}`);
  }
});

test('no committed file contains a password hash', () => {
  const HASH = /scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{16,}\$[0-9a-f]{16,}/;
  for (const file of trackedTextFiles()) {
    assert.doesNotMatch(read(file), HASH, `${file} contains a real password hash`);
  }
});

test('deployment and environment files are still ignored', () => {
  // Asked of git rather than of .gitignore's text. Matching literal lines
  // checked the spelling of the rule instead of its effect: it passed on a
  // mention in a comment, and broke when `deploy.sh` became `deploy*.sh` to
  // cover the admin's own deploy script — a change that made the protection
  // STRONGER while failing the test meant to protect it.
  const ignored = (path) => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: REPO });
      return true;
    } catch {
      return false;
    }
  };

  for (const path of [
    'deploy.sh', 'deploy-admin.sh', 'deploy-anything.sh',
    '.env', '.env.local',
    'web/data/images/full/0000000000000002.png',
    'dump.bin', 'library.fca',
  ]) {
    assert.ok(ignored(path), `git would commit ${path} — it must be ignored`);
  }

  // The example is the deliberate exception: it exists to be committed.
  assert.equal(ignored('.env.example'), false, '.env.example is meant to be tracked');

  const tracked = new Set(trackedTextFiles());
  for (const f of ['deploy.sh', 'deploy-admin.sh', '.env']) {
    assert.equal(tracked.has(f), false, `${f} is tracked and must not be`);
  }
});

// ---- the admin does not advertise itself --------------------------------

test('nothing on the public site links to the admin', () => {
  // The nav, the manifest and the footer are the three places a link would
  // plausibly be added by habit.
  assert.doesNotMatch(read('web/js/header.js'), /admin/i, 'the nav must not mention it');
  assert.doesNotMatch(read('web/manifest.webmanifest'), /admin/i);
  assert.doesNotMatch(read('web/js/footer.js'), /admin/i);
});

test('the admin page cannot publish its own URL', () => {
  const html = read('admin/index.html');
  assert.match(html, /name="robots"[^>]*noindex/, 'must ask not to be indexed');
  assert.doesNotMatch(html, /property="og:/, 'a preview card would publish the URL');
  assert.doesNotMatch(html, /rel="manifest"/, 'a manifest would publish the URL');
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.equal((html.match(/<nav[ >]/g) ?? []).length, 0, 'no nav, like every other page');
});

test('the admin uses only relative URLs, so it never learns its own host', () => {
  const js = read('admin/adminui.js');
  assert.doesNotMatch(js, /https?:\/\/[a-z0-9-]+\./i, 'an absolute URL would hardcode a host');
});

test('the admin is not part of the public site and cannot be deployed by accident', () => {
  // deploy.sh mirrors web/. Anything outside it is not published by that path.
  assert.equal(existsSync(join(REPO, 'web/admin')), false, 'the admin must not live under web/');
  assert.equal(existsSync(join(REPO, 'admin/index.html')), true);
});

test('the admin page is not in the public page list', () => {
  // pages.test.mjs gates the public pages on a head kit full of og:* tags. The
  // admin must not join that list: the requirements are the opposite.
  assert.doesNotMatch(read('test/pages.test.mjs'), /admin/i);
});

// ---- the server refuses to run unprotected -------------------------------

test('the server will not start without a password and a session secret', () => {
  const src = read('server/index.mjs');
  assert.match(src, /Refusing to start unprotected/,
    'an unconfigured admin must refuse, not run open');
  assert.match(src, /ADMIN_PASSWORD_HASH/);
  assert.match(src, /SESSION_SECRET/);
});

test('secrets are read from the environment, never from a file in the repo', () => {
  const src = read('server/index.mjs');
  assert.match(src, /process\.env\.ADMIN_PASSWORD_HASH/);
  assert.match(src, /process\.env\.SESSION_SECRET/);
});
