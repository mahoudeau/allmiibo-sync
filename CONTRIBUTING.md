# Contributing

Contributions are welcome, from a typo fix to a feature. This page covers how
to get the project running, how to test a change, and what a pull request
should look like. The [README](README.md) explains what the project actually
is; read at least [Self-contained by design](README.md#self-contained-by-design)
first, because most conventions below follow from it.

## Setup

```sh
git clone https://github.com/mahoudeau/allmiibo-sync.git
cd allmiibo-sync
npm install
```

There is no build step and no bundler. The one dependency, `linkedom`, is a
devDependency: it gives `npm test` a real DOM so the pages can be executed
rather than only read. The site itself ships nothing.

To try the site locally: `npm run serve` and open the printed address. Device
features need a Chromium browser; everything else runs anywhere.

## Running tests

```sh
npm test                                   # the whole suite
node --test test/collectionview.test.mjs   # one file
node --test --test-name-pattern="sort"     # by name
```

Tests use Node's built-in runner and never reach the network: protocol tests
run against a simulated device, admin tests against a real HTTP server on an
ephemeral port, and UI tests against a real DOM via linkedom.

Two groups of tests skip themselves when their inputs are missing, and a
skipped test is not a passing test:

- Tests that need the upstream database cache skip until you run
  `npm run update-db` once (it fills `tools/.cache/`).
- One bundle test needs a large sample file that is not in the repository.

The admin suite is the one that bites: the admin reuses the site's own grid and
toolbar, and tests assert the two stay identical. A change to the collection
page can fail an admin test you never ran. If your change touches `web/`, run
`npm run update-db` first so the whole suite actually executes.

## Layout

```
web/       The static site: HTML, CSS, ES modules, and generated data
server/    The private admin service (optional; never deployed with the site)
admin/     The admin UI, served by that service
test/      One .test.mjs per concern, mirroring the module it tests
tools/     Database, artwork and changelog generators
```

## Conventions

- ES modules everywhere; no CommonJS, no build step. What is in `web/` is what
  ships.
- A module's tests live in the file that mirrors it: `web/js/foo.js` is tested
  by `test/foo.test.mjs`.
- User-visible changes get a changelog entry. Entries are written once, in
  `web/data/changelog.js`; then `npm run build-changelog` regenerates
  `CHANGELOG.md`, and a test fails if the two drift. The comment at the top of
  that file is the style guide for entries; it is short and worth reading.
- The site works in every browser and says so; only device sync needs the
  Bluetooth and file-system APIs that exist in Chromium browsers. Copy and
  code should keep that line sharp.

## Pull requests

- One concern per pull request. A bug fix and a feature are two PRs; a feature
  and a refactor are two PRs. Small PRs get reviewed quickly and merged whole;
  large mixed ones tend to get taken apart.
- `npm test` passes, with the cache populated if your change touches `web/`.
- New behaviour comes with tests, in the voice of the tests around them.
- Keep commits self-contained: each one buildable, testable, and described in
  a sentence.

Not sure whether something would be welcome? Open an issue and ask before
building it. That costs a day of waiting; building the wrong thing costs a
week of work.
