// The admin's CSS, checked as text.
//
// linkedom has no layout engine, so nothing here can assert that two controls
// line up or that a gap has an effect. What it can assert is the thing that
// actually went wrong twice: the admin using a class name it does not own, and
// hand-rolling a rule the site already has.
//
// Both bugs were invisible in every other test and obvious on screen:
//
//   .fRow   — unqualified in app.css and owned by the site footer. The admin
//             used the same name for its form rows, so above 560px every field
//             became a horizontal flex row with its label, input and error side
//             by side. The login password field too.
//   .toolbar — defined only inline in collection.html. The admin rendered
//             class="toolbar" with a comment claiming it came from app.css, so
//             its toolbar had no gap, no bottom margin, and every control sat
//             at its own height.
//
// The last test in this file is the general form of both: a detector for any
// class the admin borrows that the site defines unqualified. It is the reason
// this file exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REPO = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, REPO), 'utf8');

const APP_CSS = read('web/css/app.css');
const COLLECTION_CSS = read('web/css/collection.css');
const ADMIN_HTML = read('admin/index.html');
const ADMIN_JS = read('admin/adminui.js');
const COLLECTION_HTML = read('web/collection.html');

/** CSS with comments removed, so an assertion reads rules and not prose. */
const rules = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The contents of a page's inline <style> blocks, concatenated. */
function inlineStyle(html) {
  return rules([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'));
}

const ADMIN_STYLE = inlineStyle(ADMIN_HTML);

// ---- the two rules that must live in a shared stylesheet ----------------

test('.toolbar is styled in the shared stylesheet, not inline on one page', () => {
  assert.match(COLLECTION_CSS, /^\.toolbar \{/m,
    '.toolbar belongs in collection.css, which the collection page and the admin both load');
  assert.match(COLLECTION_CSS, /--ctl-h:/,
    'including the custom property that equalises the control heights');

  assert.doesNotMatch(inlineStyle(COLLECTION_HTML), /^\s*\.toolbar\s*\{/m,
    'and must not be redefined inline, or the two pages drift again');
  assert.doesNotMatch(ADMIN_STYLE, /^\s*\.toolbar\s*\{/m);
});

test('the footer owns .fRow, and owns it explicitly', () => {
  assert.match(APP_CSS, /^\.siteFooter \.fRow \{/m,
    '.fRow is scoped to the footer that emits it');
  assert.doesNotMatch(APP_CSS, /^\.fRow\s*\{/m,
    'an unqualified .fRow is a name nobody owns; the admin picked it up by accident');
  assert.doesNotMatch(ADMIN_STYLE, /\.fRow/,
    'the admin uses .field now');
  assert.doesNotMatch(ADMIN_JS, /'fRow'|"fRow"/,
    'and emits .field too');
});

// ---- rules the admin should be inheriting rather than repeating ---------

test('the admin hand-rolls no panel, no focus ring and no input styling', () => {
  // The recipe, not the property: `box-shadow: none` removes an inherited
  // shadow, which is a legitimate override. What must not reappear is a
  // hand-rolled `Npx Npx 0 var(--shadow)`.
  assert.doesNotMatch(ADMIN_STYLE, /box-shadow:\s*\d+px/,
    'the panel recipe is .panel in app.css — a fourth hand-rolled copy is how they drift');
  assert.doesNotMatch(ADMIN_STYLE, /outline:\s*3px solid var\(--warn\)/,
    'there is one focus rule, in app.css, and repeating it made selection and focus identical');
  assert.doesNotMatch(ADMIN_STYLE, /\.field input \{[^}]*border:/,
    'inputs are already styled by app.css');

  assert.match(APP_CSS, /^\.panel \{/m, 'the shared panel exists');
  assert.match(APP_CSS, /^\.cap \{/m, 'and the shared caption');
  assert.match(ADMIN_HTML, /class="editor panel"/, 'and the editor uses it');
});

test('the wordmark is styled once, by app.css', () => {
  for (const rule of [/\.adminBar \.wm/, /\.signIn \.wm \{/, /\.adminBar svg/, /\.signIn svg/]) {
    assert.doesNotMatch(ADMIN_STYLE, rule,
      `${rule} duplicates app.css's .brand rules`);
  }
  assert.match(APP_CSS, /\.brand \.wm/, 'app.css is where the wordmark lives');
});

test('the admin binds its width to one property', () => {
  const widths = [...ADMIN_STYLE.matchAll(/72rem/g)];
  assert.equal(widths.length, 1,
    'the bar and the main column read one --admin-w, so they cannot drift apart');
  assert.match(ADMIN_STYLE, /--admin-w:/);
});

test('selection is a state, not a look that collides with focus', () => {
  assert.doesNotMatch(ADMIN_STYLE, /\.item\.picked/,
    'a class made style and semantics two things to keep in step');
  assert.match(ADMIN_STYLE, /\.item\[aria-pressed="true"\]/,
    'the cell is a button, so its selected state is a real one');
  assert.match(ADMIN_JS, /aria-pressed/);
});

test('a refused edit is visible where it happened', () => {
  // .why and .bad were emitted by the script and styled by nobody, so every
  // validation message rendered as an empty box.
  assert.match(ADMIN_STYLE, /\.field\.bad input/, 'a bad field is marked');
  assert.match(ADMIN_STYLE, /\.field \.why/, 'and its reason is styled');
  assert.match(ADMIN_JS, /showProblems/, 'and something actually sets them');
});

// ---- the general form of both bugs -------------------------------------

/** Every class the admin's markup and script put on an element. */
function adminClasses() {
  const names = new Set();
  for (const m of ADMIN_HTML.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) names.add(c);
  }
  for (const m of ADMIN_JS.matchAll(/className = ['"`]([^'"`]+)['"`]/g)) {
    for (const c of m[1].split(/\s+/)) if (c) names.add(c);
  }
  for (const m of ADMIN_JS.matchAll(/class="([^"]+)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) names.add(c);
  }
  return names;
}

/** Every class app.css styles on its own, with no ancestor to scope it. */
function unqualifiedClasses(css) {
  const names = new Set();
  // A rule head that is exactly one class, optionally with a pseudo, and
  // nothing else: `.foo {`, `.foo:hover {`. Not `.a .b {` and not `.a.b {`.
  for (const m of css.matchAll(/^\.([A-Za-z][\w-]*)((?::[\w-]+(?:\([^)]*\))?)*)\s*\{/gm)) {
    names.add(m[1]);
  }
  return names;
}

test('every class the admin borrows from app.css is one it means to borrow', () => {
  // This is the test that would have caught .fRow, and it is here to catch the
  // next one. The admin loads the site's stylesheets, so any single-class rule
  // in app.css applies to an admin element with the same class name — whether
  // or not either side knew about the other.
  //
  // The allow-list is the reviewed set: components the admin genuinely reuses.
  // Anything else appearing here is a collision, not a decision.
  const SHARED = new Set([
    // layout and text
    'row', 'grow', 'wide', 'panel', 'cap', 'ico', 'lbl', 'wm', 'sfx', 'brand',
    // components
    'status', 'note', 'caution', 'empty', 'eTitle', 'primary', 'danger',
    'searchBox', 'pillRow', 'pill', 'segCtl', 'thumb', 'statRow', 'statTile',
    'toolbar', 'drawer', 'clear', 'n',
    // the grid, from collection.css
    'series', 'items', 'item', 'cards', 'art', 'nm', 'nmWrap', 'tag', 'sPill',
    'subHead', 'seriesHead', 'seriesArt', 'chev', 'year',
    // the admin's own, which app.css must not define
    'field', 'why', 'was', 'bad', 'signIn', 'tagline', 'adminBar', 'editor',
    'editorCol', 'cols', 'eName', 'idLine', 'spacer', 'curated', 'authored',
  ]);

  const siteOwned = unqualifiedClasses(APP_CSS);
  const collisions = [...adminClasses()]
    .filter((c) => siteOwned.has(c) && !SHARED.has(c))
    .sort();

  assert.deepEqual(collisions, [],
    'the admin uses a class app.css styles unqualified; either scope the site\'s '
    + 'rule, rename the admin\'s, or add it to the reviewed list above');
});

test('these checks fail when the bugs that shipped are reintroduced', () => {
  // 1. The .fRow clash, in its general form: a class the admin uses that
  //    app.css styles unqualified and nobody reviewed.
  const siteOwned = unqualifiedClasses('.fRow { display: flex; }\n.hero { color: red; }\n');
  assert.ok(siteOwned.has('fRow'), 'the detector sees an unqualified rule');
  assert.throws(
    () => assert.deepEqual([...['fRow']].filter((c) => siteOwned.has(c)), []),
    /deep-equal/,
    'a borrowed unqualified class must fail the detector');

  // ...and that a scoped rule is correctly ignored.
  assert.equal(unqualifiedClasses('.siteFooter .fRow { display: flex; }').has('fRow'), false,
    'scoping the site\'s rule is what clears it');
  assert.equal(unqualifiedClasses('.a.b { color: red; }').has('a'), false,
    'a compound selector is not an unqualified single class');

  // 2. The .toolbar bug: a rule the admin needs, living inline on one page.
  assert.throws(
    () => assert.match('.pageHead { }', /^\.toolbar \{/m),
    /did not match/,
    'a stylesheet without .toolbar must fail the check above');
});
