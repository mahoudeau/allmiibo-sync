// The changelog, and the guard that keeps its two outputs honest.
//
// Entries live in one data file. The site renders it and tools/build-changelog
// turns it into CHANGELOG.md, so the failure this suite exists to catch is an
// edit to the data that never reached the markdown. Same reasoning as
// db.test.mjs: the generator enforces what it can at write time, and these
// enforce the same things on the file that is actually committed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { RELEASES, CATEGORIES, INTERNAL } from '../web/data/changelog.js';
import { render } from '../tools/build-changelog.mjs';
import { renderChangelog, inlineHtml, formatDate } from '../web/js/changelogui.js';
import { mountHtml } from './helpers/dom.mjs';

const PAGE = '<!doctype html><html><body><div id="out"></div></body></html>';

/** Every entry of a release, flattened out of its groups. */
function itemsOf(release, key) {
  const raw = release[key] ?? [];
  return raw.flatMap((item) => (typeof item === 'string' ? [item] : item.items));
}

const allKeys = [...CATEGORIES.map((c) => c.key), INTERNAL.key];

// ---- the sync guard ------------------------------------------------------

test('CHANGELOG.md is what the data generates', async () => {
  const committed = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

  // The whole point of a single source. If this fails, run
  // `npm run build-changelog` and commit the result.
  assert.equal(committed, render(),
    'CHANGELOG.md is out of date with web/data/changelog.js');
});

test('the generator writes nothing when imported', () => {
  // render() is pure so this suite can call it; the CLI half is guarded by an
  // argv check. If that guard went, importing the module would rewrite the
  // file being compared above and this suite could never fail.
  const once = render();
  const twice = render();
  assert.equal(once, twice);
});

// ---- the two audiences ---------------------------------------------------

test('nothing marked internal reaches the page', () => {
  const page = mountHtml(PAGE);
  renderChangelog(page.document.getElementById('out'));
  const html = page.document.getElementById('out').innerHTML;

  const internal = RELEASES.flatMap((r) => itemsOf(r, INTERNAL.key));
  assert.ok(internal.length > 0, 'no internal entries to check against');

  for (const entry of internal) {
    // inlineHtml is exactly what the page would contain if it rendered this,
    // so comparing against it tests the right thing rather than the raw source.
    assert.ok(!html.includes(inlineHtml(entry)),
      `internal entry rendered on the page: ${entry.slice(0, 50)}`);
  }
  assert.ok(!html.includes(INTERNAL.label));
});

test('everything not marked internal does reach the page', () => {
  const page = mountHtml(PAGE);
  renderChangelog(page.document.getElementById('out'));
  const html = page.document.getElementById('out').innerHTML;

  for (const release of RELEASES) {
    for (const cat of CATEGORIES) {
      for (const entry of itemsOf(release, cat.key)) {
        assert.ok(html.includes(inlineHtml(entry)),
          `missing from the page: ${entry.slice(0, 50)}`);
      }
    }
  }
});

test('CHANGELOG.md carries the internal half', () => {
  const md = render();
  assert.ok(md.includes(INTERNAL.label));
  for (const entry of RELEASES.flatMap((r) => itemsOf(r, INTERNAL.key))) {
    assert.ok(md.includes(entry), `missing from the markdown: ${entry.slice(0, 40)}`);
  }
});

// ---- shape ---------------------------------------------------------------

test('versions are unique, semver, and strictly descending', () => {
  const versions = RELEASES.map((r) => r.version);
  assert.equal(new Set(versions).size, versions.length, 'duplicate version');

  const parts = versions.map((v) => {
    assert.match(v, /^\d+\.\d+\.\d+$/, `not semver: ${v}`);
    return v.split('.').map(Number);
  });
  for (let i = 1; i < parts.length; i++) {
    const [a, b] = [parts[i - 1], parts[i]];
    assert.ok(a.some((n, j) => n > b[j] && a.slice(0, j).every((m, k) => m === b[k])),
      `${versions[i - 1]} does not come after ${versions[i]}`);
  }
});

test('dates are real, descending, and not in the future', () => {
  const today = new Date().toISOString().slice(0, 10);
  let previous = null;
  for (const r of RELEASES) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `not a date: ${r.date}`);
    assert.ok(!Number.isNaN(Date.parse(r.date)), `unparseable: ${r.date}`);
    assert.ok(r.date <= today, `${r.version} is dated in the future`);
    if (previous) assert.ok(r.date < previous, `${r.version} is not older than the one above`);
    previous = r.date;
  }
});

test('every release has a version, a date, a title and some entries', () => {
  for (const r of RELEASES) {
    assert.ok(r.version && r.date && r.title, `incomplete release: ${r.version}`);
    const total = allKeys.reduce((n, k) => n + itemsOf(r, k).length, 0);
    assert.ok(total > 0, `${r.version} has no entries at all`);
  }
});

test('no empty categories or groups, which would leave a bare heading', () => {
  for (const r of RELEASES) {
    for (const key of allKeys) {
      if (!(key in r)) continue;
      assert.ok(Array.isArray(r[key]) && r[key].length > 0,
        `${r.version}.${key} is present but empty; drop the key instead`);
      for (const item of r[key]) {
        if (typeof item === 'string') {
          assert.ok(item.trim().length > 0, `${r.version}.${key} has a blank entry`);
        } else {
          assert.ok(item.group?.trim(), `${r.version}.${key} has a group with no heading`);
          assert.ok(item.items?.length > 0, `${r.version}.${key} group "${item.group}" is empty`);
        }
      }
    }
  }
});

test('a release carries no key the renderer would silently ignore', () => {
  const known = new Set(['version', 'date', 'title', ...allKeys]);
  for (const r of RELEASES) {
    for (const key of Object.keys(r)) {
      // A mistyped category is the worst failure here: the entries simply
      // vanish from both outputs and nothing says so.
      assert.ok(known.has(key), `${r.version} has an unknown key: ${key}`);
    }
  }
});

test('entries use only the inline markup both outputs understand', () => {
  for (const r of RELEASES) {
    for (const key of allKeys) {
      for (const entry of itemsOf(r, key)) {
        assert.equal((entry.match(/\*\*/g) ?? []).length % 2, 0, `unclosed bold: ${entry}`);
        assert.equal((entry.match(/`/g) ?? []).length % 2, 0, `unclosed code: ${entry}`);
        assert.ok(!entry.includes('—'), `em dash in an entry: ${entry}`);
        assert.ok(!/\[.+\]\(.+\)/.test(entry), `markdown link, which the page will not render: ${entry}`);
      }
    }
  }
});

// ---- rendering -----------------------------------------------------------

test('the newest release is what the footer shows', async () => {
  const footer = await readFile(new URL('../web/js/footer.js', import.meta.url), 'utf8');
  assert.match(footer, /RELEASES\[0\]\.version/,
    'the footer should read the release from the data, not repeat it');
  assert.match(footer, /changelog\.html/);
});

test('the README states the current release', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const stated = /^Currently \*\*(\d+\.\d+\.\d+)\*\*/m.exec(readme);
  assert.ok(stated, 'the README should open by saying which release it documents');

  // The footer reads the version from the data. The README cannot, being
  // markdown, so it repeats the number by hand and it went stale for two
  // releases before anyone noticed. This is the only thing that would.
  assert.equal(stated[1], RELEASES[0].version,
    'README.md is behind web/data/changelog.js; update the version line');
});

test('the page renders one panel per release, newest first', () => {
  const page = mountHtml(PAGE);
  renderChangelog(page.document.getElementById('out'));

  const sections = [...page.document.querySelectorAll('.helpSec')];
  assert.equal(sections.length, RELEASES.length);
  assert.deepEqual(sections.map((s) => s.id), RELEASES.map((r) => `v${r.version}`));
});

test('the index table carries every release, and links to each one', () => {
  const page = mountHtml(PAGE);
  renderChangelog(page.document.getElementById('out'));

  const rows = [...page.document.querySelectorAll('.clIndex tbody tr')];
  assert.equal(rows.length, RELEASES.length);

  rows.forEach((row, i) => {
    const release = RELEASES[i];
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.trim());
    assert.deepEqual(cells, [release.version, formatDate(release.date), release.title]);
    assert.equal(row.querySelector('a').getAttribute('href'), `#v${release.version}`);
  });

  // Every link has a section to land on.
  for (const a of page.document.querySelectorAll('.clIndex a')) {
    const id = a.getAttribute('href').slice(1);
    assert.ok(page.document.getElementById(id), `nothing to jump to: ${id}`);
  }
  assert.equal(page.document.querySelectorAll('nav').length, 0);
});

test('inline markup becomes html, and angle brackets never do', () => {
  assert.equal(inlineHtml('**bold** and `code`'), '<b>bold</b> and <code>code</code>');
  assert.equal(inlineHtml('a < b & c'), 'a &lt; b &amp; c');
  // An entry is authored, not user input, but escaping first means a stray
  // bracket renders as text rather than eating the rest of the line.
  assert.equal(inlineHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
});

test('dates read as prose without shifting by timezone', () => {
  assert.equal(formatDate('2026-08-02'), '2 August 2026');
  assert.equal(formatDate('2026-07-26'), '26 July 2026');
  // Parsed by hand for this reason: new Date('2026-01-01') is UTC midnight,
  // which is the 31st of December anywhere west of Greenwich.
  assert.equal(formatDate('2026-01-01'), '1 January 2026');
});
