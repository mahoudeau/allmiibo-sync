# Contributing to allmiibo-sync

Thanks for contributing! This document covers how to set up the project, run
tests, and submit changes.

## Setup

```sh
git clone https://github.com/mahoudeau/allmiibo-sync.git
cd allmiibo-sync
npm install
```

The only dependency is [linkedom](https://github.com/WebReflection/linkedom),
used to give `node --test` a real DOM. The site itself ships zero dependencies.

Requires Node.js (any recent version). No build step, no bundler.

## Running tests

```sh
npm test               # all 782 tests
node --test test/collectionview.test.mjs  # single file
node --test --test-name-pattern="sort"    # by pattern
```

Tests use Node's built-in test runner. They do not reach the network — protocol
tests run against a simulated device, admin tests against an ephemeral HTTP
server, and UI tests against a real DOM via linkedom.

Some admin tests will skip with `# SKIP tools/.cache is empty` unless you run
`npm run update-db` first, which fetches the upstream amiibo database.

## Project structure

```
web/           Static site (the public-facing app)
  js/          ES modules — no bundler, just imports
  css/         Stylesheets
  data/        Generated amiibo database and changelog
server/        Private admin service (optional, not deployed with the site)
  index.mjs    Admin HTTP server
test/          Test files (one .test.mjs per concern)
  helpers/     Test utilities (custom ESM loader, DOM helpers)
  fixtures/    Test data
tools/         Build and maintenance scripts
admin/         Admin UI (served by the admin server)
```

## How the site works

The site is **static** — a directory of HTML, CSS, JS, and data files. No API
calls, no database, no runtime fetches. It works offline when cached.

The admin service (`server/`) is a separate Node.js app for curating the amiibo
database. The site never talks to it and works the same whether it's running or
not.

## Code conventions

- **ES modules** throughout (`import`/`export`), no CommonJS
- **No build step** — what's in `web/` is what ships
- **CSS custom properties** for theming (all three themes in `app.css`)
- **Press Start 2P** pixel font for chrome, system fonts for body text
- **8-bit icons** via Pixelarticons (inline SVG in `js/icons.js`)
- Test files mirror the module they test: `web/js/foo.js` → `test/foo.test.mjs`
- Changelog entries are written in `web/data/changelog.js` and regenerated into
  `CHANGELOG.md` via `npm run build-changelog`

## Before submitting

1. **Run the tests** — `npm test` should pass (admin-only failures are expected
   if you haven't run `npm run update-db`)
2. **Add tests** for new behaviour
3. **Keep the changelog** — add your entry to `web/data/changelog.js`, then run
   `npm run build-changelog` to regenerate `CHANGELOG.md`
4. **One PR per concern** — separate bug fixes from features

## Commit style

No strict format, but keep commits small and descriptive. Each commit should
stand alone — buildable and testable.

## Need help?

Open an issue or comment on an existing one. The project is small and
responsive.
