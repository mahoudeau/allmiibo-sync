# allmiibo-sync

Folder sync and collection tracking for Pixl.js / AmiiboLink-compatible NFC
emulator devices over Bluetooth LE.

The stock web tools (`bt.allmiibo.com`, `pixl.amiibo.xyz`) support only manual,
one-file-at-a-time transfers and hand-made folders. This project keeps a local
directory tree, subfolders and all, in sync with the device, with explicit
control over which side is authoritative, and tracks a collection against the
full amiibo database while it is at it.

> **Unofficial fan project.** Not affiliated with, endorsed by, or connected to
> Nintendo, the Pixl.js / AmiiboLink projects, or any device vendor. It ships no
> Nintendo data, no amiibo dumps, and no cryptographic keys. It only moves and
> catalogues the files already present on a connected device. See
> [Legal and licensing](#legal-and-licensing).

## Self-contained by design

No CDNs, no npm dependencies, no build step, no telemetry. Everything the tool
needs lives in this repository and runs on browser and Node built-ins alone.
The BLE protocol is documented in [PROTOCOL.md](PROTOCOL.md) rather than being
pulled from someone else's script at runtime.

## Status

Everything below is verified on hardware: **Pixl.js 2.11.2 and 2.16.0**
(nRF52832, external flash); the protocol is unchanged across those releases,
and 2.16.0 (January 2026) added on-device emulation for v3 amiibo.

- **Protocol**: reverse-engineered, cross-checked against the open-source
  firmware, verified on hardware. ✅
- **Sync engine**: five named operations, shared by two surfaces. A full
  1914-operation replace of a 1049-dump library completed with zero failures. ✅
- **The Collection**: the app's home: browse all 947 amiibo, scan a local
  folder and a folder on the device, sync them, or transfer a hand-picked
  selection. ✅
- **Interface**: an 8-bit skin with three themes, an original pirate mascot
  in twelve colourways, and an Advanced toggle that keeps the expert layer out
  of the way until asked for. ✅
- **Tests**: 176 across seven files; the protocol suite runs against a
  simulated device, the rest are pure. ✅

Three hardware findings shape the sync design:

- **~2 KB/s, and slower as the drive fills**: 1.0 s per dump onto an empty
  drive, 2.5 s onto a full one. Transfer the minimum; long runs are resumable
  and every operation is logged.
- **`remove` deletes folders recursively**, with no "not empty" guard. Files
  are deleted individually.
- **`rename` moves between folders**, so a relocated file need not be re-uploaded.

## Quick start

All commands are collected in [COMMANDS.md](COMMANDS.md).

Requires Node (any recent version) and Chrome or Edge. Web Bluetooth needs a
secure context, so the page must be served over `http://localhost`;
opening it as a `file://` URL will not work.

```sh
npm run serve          # or: node serve.mjs [port]
```

Then open <http://localhost:8080/>. An 8-bit title screen leads into the
Collection, which is the whole app. The in-app **HOW TO** page covers every
feature from the user's side; this README covers the same ground from the
repository's side.

The chosen folder's handle is remembered (IndexedDB), so the Collection
reconnects it on the next visit; if the browser has let the permission lapse,
the folder chip offers **tap to reconnect** instead of silently forgetting.
Theme, mascot colour, view, sort, filters, operation choices, the device
folder and the fan-made-cards toggle all persist across reloads and sessions.

Close any other tab connected to the device first: it accepts one BLE
connection at a time.

### The Collection

The page renders the full database immediately: 947 amiibo across 31 series
(946 database entries plus the curated Happy Home Designer card set),
greyed out until a source says otherwise. Two sources, either or both:

- **Your folder**: the OS directory picker, then a scan. Owned amiibo light
  up; identity comes from the bytes, so filenames are irrelevant.
- **Your device**: connect over Bluetooth, pick the folder to read in a
  browser-of-the-device dialog (default `E:/amiibo`), and every file is read
  back and identified. That costs ~0.2 s per file, so a few minutes for a full
  library; it shows live progress and can be stopped part-way.

Both sources live in one **SOURCES** panel. Each source is a chip with its
controls (rescan, change folder, forget) and its own detail line right below:
the folder shows owned count, completion bar and dump-file total; the device
shows its amiibo count and a bar for how much of the union is synced. One
line at the panel's foot gives the verdict: **ALL SYNCED** when the two
sides are identical, otherwise the synced percentage with what's left
(`15 to send · 5 to fetch`). The first time a state reaches identical, an
old-game victory overlay plays once; the counts under each source double as
filter shortcuts.
The toolbar has search (press `/`), filter pills with live counts, three
sorts (release, name, completion), a **CARDS** / **LIST** toggle, and a `⋯`
menu (**COPY MISSING LIST**, **SCAN REPORT**, expand/collapse all). Every
series row carries one tally pill: owned/total, a check when complete, a
bluetooth mark once a device is scanned, ▲/▼ deltas for what still needs to
move, and a sparkle count for dumps newer than the database. Each
amiibo opens a detail page with full-resolution artwork, your actual
filenames, a copy-able ID, prev/next navigation (arrow keys work), the rest
of its series, and its character variants. Scans are cached per tab, so
returning from a detail page is instant.

With both sources connected:

- **SYNC** fills the gaps in both directions: it downloads what only the device
  has, uploads what only the folder has, deletes nothing, and leaves the two
  sides identical. You review counts, sizes, a time estimate and the device's
  capacity before anything is written.
- **SELECT** turns the grid into a picker: choose amiibo, then **SEND TO
  DEVICE** or **DOWNLOAD** moves exactly those. Only amiibo missing on the
  receiving side are transferred.

### Vehicles and card sets

Two products break the one-ID-one-amiibo rule, and each gets a tailored
presentation instead of 90-odd duplicate rows:

- **Kirby Air Riders vehicles.** Every rider can be paired with four
  machines (Warp Star, Winged Star, Shadow Star, Tank Star), and each pairing
  is its own dump under the same ID. The collection cell shows a `n/4` tally;
  the detail page shows the four machines as image cards, official renders
  fetched locally by `fetch-images`, greyed until you hold that pairing.
- **The fan-made Happy Home Designer cards.** A community-made pack of 91
  item-unlock cards for the 3DS game, not official Nintendo cards. All 91
  carry one fabricated amiibo ID, so the collection shows them as a single
  curated entry (with original card-stack pixel art and a `n/91` pill), and
  the detail page lists every card with its item count and a taste of what it
  unlocks. Individual cards are recognised by their NFC UID against a small
  vendored index (`web/data/hhd-cards.js`).

The set is shown by default; collectors who track only official amiibo can
switch it off in Settings → **COLLECTION**, which removes it from the list
and every total (947 becomes 946), so an official-only collection can read
complete. The switch is display-only: sync still treats the card files like
any other files.

### Advanced sync

You only need this page if the Collection's SYNC is too polite. The
**Advanced** toggle (header → Settings) adds it to the navigation; it walks
three steps (connect, choose, review) and offers all five operations:

| Operation | Direction | Deletes | Matches on | Visible |
|---|---|---|---|---|
| **BACKUP** | device → local | no | nothing, takes it all | always |
| **SYNC** | both | opt-in | path, against the last sync | always |
| **MATCH** | both | no | amiibo identity | Advanced |
| **REPLACE** | local → device | **yes** | path | Advanced |
| **CHECK** | read-only report | no | file content | Advanced |

Options live inside the operation they belong to and are remembered per
operation:

- **BACKUP**: *Re-download files I already have* and *Include system files*.
  A second run skips what it already holds: a file is skipped when it was
  downloaded before, the local copy still hashes to what was written, and the
  device file is still the same size. Every dump is 540 bytes, so a
  device-side edit that kept the size is the one case this cannot notice;
  the first option re-fetches regardless, and the plan says how many were
  skipped and why.
- **SYNC**: *Also delete (removals carry over)* and *Verify doubtful files
  (slow)*. It uses the record of the last sync to tell an edit from a
  deletion, and matches on path, so it works best when both sides are laid
  out the same way.
- **MATCH** ignores folders and filenames and asks only whether each amiibo
  is on the other side. It is the right choice when the two layouts differ.
  Identity is the amiibo ID plus the vehicle for Air Riders, falling back to
  file content, so the 91 Happy Home Designer item cards (one shared ID) and
  the four vehicle pairings of an Air Riders character transfer individually.
  It reads every device file first, which takes a few minutes, and never
  deletes.
- **REPLACE really does replace.** Everything under the device folder is
  deleted, then the whole local folder is written back: nothing skipped,
  nothing trusted. A mirror that skips files it believes correct is a
  different operation, and that belief cannot be checked: a device file of
  the right size and the wrong contents is indistinguishable without reading
  it back at 2 KB/s. If you want only the differences moved, use **SYNC**.
  It confirms first, with counts, in a hold-to-think dialog.
- **CHECK** answers "is this amiibo on the device *anywhere*?" once files
  have been renamed or refiled: it reads every device file and matches on
  content, reporting what each side is missing, variants (the same amiibo
  where the device holds bytes you do not have. This is what catches
  Skylanders dark figures), files relocated under different names, and
  duplicates within each side. Validated against two copies of one collection
  filed completely differently: zero shared paths, yet every amiibo matched,
  and the only genuine differences surfaced as variants.

**Every operation is a dry run until you press APPLY.** The review shows
summary tiles, warnings in plain language, a capacity meter, and per-action
file lists; deletions ask again. The **RUN LOG** drawer (Advanced) keeps the
whole run. **SAVE JSON** exports the plan, the capacity figures, and every
operation with its duration, outcome and, where the device refused, the
command and status it returned. Useful when something fails 300 operations
into a 48-minute push.

### Debug tools

Settings → **DEBUG TOOLS** opens the device-internals page (the old
`probe.html` / `write-test.html` URLs redirect there):

- The **probe** is strictly read-only: firmware version, drive capacity, a
  full directory walk, optionally one file read back to confirm sizes are
  honest. It produces a JSON report, useful against the open questions at the
  end of PROTOCOL.md.
- The **write test** writes only inside `E:/_synctest`, aborts if that folder
  is not empty, and cleans up after itself even when a check fails.

### The interface

The skin is deliberate 8-bit: square corners, hard shadows, a vendored pixel
font for chrome and system stacks for data, steps()-eased micro-animations
that respect `prefers-reduced-motion`, and inline-SVG pixel icons. Three
switchable themes (console-shell grey, CRT indigo, near-black) and an
original pirate mascot in twelve colourways live under Settings; the
**ADVANCED** toggle there is the app's single progressive-disclosure axis:
default mode stays lean, Advanced reveals the expert operations and details.
Settings also holds the **COLLECTION** toggle for the fan-made HHD card set,
on by default and switched off by official-only collectors.

If you are curious how the look was chosen,
[`web/design-lab.html`](web/design-lab.html) is the actual moodboard used to
pick the theme, the font pairing, and the pirate (from a line-up that at
various points included a snail, a viking that was supposed to be a pirate,
and a rice farmer that was also supposed to be a pirate). It ships in the
repo, works offline, and is best enjoyed by clicking every pirate.

## How amiibo are identified

The collection needs each dump to map to a catalogued amiibo, and a content
hash cannot do that: the same amiibo dumped twice differs in UID and save
data, so it hashes differently. Measured on one real library, **1035 dumps
produced 1035 distinct SHA-256 hashes but only 943 distinct amiibo IDs**:
hashing would have treated re-scans of amiibos already owned as brand-new,
unrecognised blobs. So identity is the **amiibo ID** inside each dump, with
file content as the tiebreaker where one ID covers several products.

Three caveats, all real:

- The ID identifies a *model*, not always a distinct file. The clearest case
  is the fan-made **Animal Crossing: Happy Home Designer** item-card pack: 91
  community-crafted cards (not official Nintendo products) that all carry one
  fabricated figure ID, so the individual cards are told apart by the 7-byte
  NFC UID inside each dump. Skylanders light/dark variants, and the four
  vehicle pairings of a Kirby Air Riders character, likewise share one ID.
  The tool falls back to vehicle bytes or file content to keep all of these
  distinct rather than collapsing them.
- Newer amiibo (Kirby Air Riders onward) are **v3**: 2048-byte NTAG I2C 2K
  dumps whose ID ends in `03` rather than `02`. They parse, and their vehicle
  is decoded from the tag's SRAM buffer (see PROTOCOL.md §10.6).
- A dump can be recognised as an amiibo yet be newer than the database, so it
  has no name. Those are marked as new, named by their character where the
  character is already known from an earlier figure.

**The database** (`web/data/amiibo-db.js`, 946 entries across 31 series and
5 types) is generated by `tools/build-amiibo-db.mjs` from two public sources
and vendored; nothing is fetched at runtime:

- **[solosky/pixl.js](https://github.com/solosky/pixl.js)** `db_amiibo.c`:
  the table the device itself uses. Its names are more specific than the
  alternative (`[AC] 001 - Isabelle` rather than `Isabelle`), which matters
  for a collection list.
- **[8bitDream/AmiiboAPI](https://github.com/8bitDream/AmiiboAPI)**
  `amiibo.json` (MIT): an actively maintained fork of
  [N3evin/AmiiboAPI](https://github.com/N3evin/AmiiboAPI), providing
  amiibo-series and figure-type labels plus release dates. Chosen over the
  upstream because the fork adds the newest releases (Kirby Air Riders v3,
  Mario Wonder, Splatoon Raiders, Pragmata…) while remaining a verified
  strict superset (no upstream entries dropped or corrupted).

`npm run update-db` re-fetches both sources, regenerates the file, prints
every added, renamed or removed entry, so a bad upstream edit can't slip
into a commit unreviewed, and fetches artwork for anything new.

**Artwork** (`npm run fetch-images`) downloads official artwork from
AmiiboAPI into three tiers: 96 px thumbnails, 256 px for Retina-sharp lists,
and full-size for the detail page, plus the four Air Riders vehicle renders
from Nintendo's asset CDN. It is Nintendo's artwork, so **no tier is
committed to the repository**: everything is cached locally and deployed to
your own host. A fresh clone shows letter placeholders until you run
`fetch-images`; the page uses the sharpest tier present and never fetches
anything at runtime.

## Design notes

- **Speed.** A full replace of a ~1000-dump library (clear the device, then
  re-upload everything) took about **26 minutes** on real hardware; a push
  onto an already-full drive is slower still (~2.5 s per dump). Every plan
  shows a time estimate before you commit, calibrated against real runs
  rather than the per-chunk figure, which proved five times optimistic.
- **Capacity.** Deleting comes first, so only the final state has to fit
  rather than both copies at once. Capacity is checked against what a file
  actually *occupies*, not its contents: a 540-byte dump costs about 1.3 kB
  once filesystem overhead is counted, so a 1049-dump library needs ~1.4 MB
  rather than the 590 kB its bytes suggest.
- **Why "verify doubtful files" exists.** Every dump is exactly 540 bytes, so
  size cannot detect a content change. A SHA-256 per path is recorded at the
  end of each sync; on the *first* run there is no record, so files present
  on both sides at the same size are genuinely undecidable: they are listed
  as unverified rather than guessed at. The option reads each one back to
  compare hashes: correct but slow, at roughly 0.2 s per file.
- **No modification times.** The device reports none, so change detection is
  file size plus the recorded hash (see [PROTOCOL.md](PROTOCOL.md)).

## How it works

The device exposes a small virtual-filesystem RPC over the Nordic UART
Service: `vfs_read_dir`, `vfs_open_file`, `vfs_read_file`, `vfs_write_file`,
`vfs_create_folder`, `vfs_remove`, `vfs_rename`. Files move in 242-byte
chunks with one command in flight at a time. The full wire format is in
[PROTOCOL.md](PROTOCOL.md).

## Tests

```sh
npm test
```

176 tests, no hardware needed:

- `protocol.test.mjs`: against a simulated device: framing,
  multi-notification reassembly, command serialisation, chunked writes,
  error-status propagation, disconnects.
- `planner.test.mjs`: the reconciliation rules and safety properties:
  folders are never removed as a shortcut for their contents, deletions
  require opt-in, equal size is never mistaken for equal content, over-long
  paths are blocked rather than attempted.
- `amiibo.test.mjs`: ID parsing and the collection model, including the
  curated HHD entry, its UID-keyed card manifest, and the hide toggle.
- `ui-modules.test.mjs`: static checks over the page modules, which touch
  `document` and cannot be imported under `node:test`: every function called
  must be defined or imported. Exists because a refactor once deleted a
  render function and left its call site, and nothing caught it until the
  page threw.
- `pages.test.mjs`: the "stupid mistake" guards for a site with no build
  step: every page carries the full head kit, wiring, and assets it claims.
- `sprite.test.mjs`: the mascot's pixel maps stay rectangular and its
  colourways stay sound.
- `prefs.test.mjs`: preference storage, defaults, and the one-shot legacy
  migration.

## Layout

```
PROTOCOL.md               reverse-engineered wire protocol
COMMANDS.md               every command in one place
serve.mjs                 zero-dependency static server (Node built-ins only)
package.json              scripts only, no dependencies to install
LICENSE / LICENSE.GPL-2.0 MIT for the source, GPL-2.0 for the generated DB

web/index.html            8-bit title screen (home)
web/collection.html       the app: collection + everyday sync
web/amiibo.html           per-amiibo detail page
web/sync.html             Advanced sync (every operation and option)
web/help.html             HOW TO page: every feature explained in-app
web/legal.html            legal & licensing, the README's Legal section in-app
web/debug.html            device internals: probe + write test on one page
web/probe.html            redirect stub -> debug.html (old links keep working)
web/write-test.html       redirect stub -> debug.html
web/design-lab.html       the design moodboard the NES skin was picked from,
                          kept in the repo for fun, never deployed
web/css/app.css           shared styles: three NES themes, pixel components
web/fonts/press-start-2p/ vendored Press Start 2P (SIL OFL) + its licence
web/favicon.svg           the pirate mascot, generated from js/sprite.js
web/icons/                PNG icons + OG share image, all rendered from the mascot
web/manifest.webmanifest  pinned-to-home-screen metadata (Android/iOS)

web/data/amiibo-db.js     946 amiibo IDs -> name/series/type/date (generated)
web/data/hhd-cards.js     index of the fan-made HHD card pack (91 UIDs, no tag data)
web/data/images/          artwork tiers + vehicle renders, all gitignored,
                          fetched + deployed

web/js/amiibo.js          amiibo ID parsing, series/type/faces, collection model
web/js/bytes.js           little-endian codecs, string and metadata TLV
web/js/ble.js             Web Bluetooth transport (Nordic UART Service)
web/js/protocol.js        framing, reassembly, command queue, VFS commands
web/js/planner.js         reconciliation logic (pure, no I/O)
web/js/localfs.js         local folder access, hashing, sync state
web/js/syncflow.js        the sync engine both surfaces share (scan/plan/apply)
web/js/devicepicker.js    folder browser for the device side
web/js/sync.js            device walk and plan executor
web/js/syncui.js          Advanced sync page logic
web/js/collectionui.js    collection page logic
web/js/amiibodetail.js    detail page logic
web/js/header.js          shared header: nav, Settings (theme/mascot/advanced)
web/js/prefs.js           every stored preference behind one tiny surface
web/js/ui.js              shared UI kit: toasts, status, progress, dialogs,
                          debounce, counters, formatters
web/js/dialog.js          themed confirm on native <dialog>
web/js/footer.js          shared footer
web/js/icons.js           8-bit UI icons (Pixelarticons, inlined)
web/js/sprite.js          the pirate mascot as pixel-map -> SVG
web/js/probe.js           read-only probe logic
web/js/writetest.js       write-test logic

tools/build-amiibo-db.mjs regenerate the database from source files
tools/update-db.mjs        fetch upstream sources + regenerate + report the diff
tools/fetch-amiibo-images.mjs  download artwork, build the three tiers

test/                     seven files, see Tests above
```

## Hosting

The site is static files: the bundled Node server exists only to give Web
Bluetooth the secure context it requires during local development. To host it
elsewhere, serve the contents of `web/` from any HTTPS server; HTTPS is what
Web Bluetooth requires. A deployment is a plain mirror of `web/`: the
artwork tiers are gitignored but do get deployed, and `design-lab.html` stays
home.

## Keep dumps and keys out of git

If you sync into a folder inside a clone of this repo, note that a device also
holds `key_retail.bin` (the amiibo signing keys) alongside your dumps. The
included `.gitignore` excludes `*.bin` and common sync-target folder names for
that reason; check `git status` before committing if you change it. It also
excludes the per-folder sync state (`.allmiibo-sync.json`), the debug page's
report exports, and all amiibo artwork: it is Nintendo's and is never
committed.

## Legal and licensing

Everything in this section is also published in-app at
[`/legal.html`](web/legal.html), linked from every page's footer.

This is a non-commercial, community fan project provided as-is, without warranty
of any kind. Use it at your own risk; the author accepts no liability for data
loss, damage to a device, or any other consequence of its use.

**No affiliation.** Not affiliated with, authorised by, or endorsed by Nintendo,
the Pixl.js or AmiiboLink projects, or any hardware vendor. "amiibo" and all
game, character, and product names are trademarks of their respective owners,
used here only descriptively to identify the files a user is managing. No
trademark claim is made or implied.

**What this project does not contain or distribute.** No amiibo dumps
(`.bin` files), no NTAG contents, and no cryptographic keys (e.g.
`key_retail.bin`). They are excluded by `.gitignore` and must never be
committed. The tool neither generates, decrypts, nor modifies amiibo data; it
only moves and catalogues the files already present on a connected device.

**Interoperability.** The Bluetooth protocol in [PROTOCOL.md](PROTOCOL.md) was
determined from the device firmware, which is published as open source by its
authors, and from the vendors' own publicly served web clients, for the sole
purpose of interoperating with a compatible device over Bluetooth.

**Nintendo artwork.** amiibo images shown by the collection view, and the
Air Riders vehicle renders on detail pages, are © Nintendo. They are fetched
at the user's request for personal, local use and are **not** redistributed
by this repository: the entire `web/data/images/` tree is gitignored, at
every resolution.

**The pirate mascot and logo** are original pixel art made for this project.
They depict no Nintendo character or mark.

### Third-party data and code

| Source | Used for | Licence |
|---|---|---|
| [8bitDream/AmiiboAPI](https://github.com/8bitDream/AmiiboAPI) (fork of [N3evin/AmiiboAPI](https://github.com/N3evin/AmiiboAPI)) | amiibo series/type labels, release dates, artwork URLs | MIT |
| [solosky/pixl.js](https://github.com/solosky/pixl.js) | wire protocol reference; amiibo name table | GPL-2.0 |
| [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P) (vendored in `web/fonts/`) | pixel display font | SIL OFL 1.1 |
| [Pixelarticons](https://pixelarticons.com) by Gerrit Halfmann (inlined in `web/js/icons.js`) | 8-bit UI icons | MIT |
| amiibo artwork + vehicle renders (fetched locally, never committed) | collection and detail images | © Nintendo |
| fan-made HHD card pack (community, authors unknown) | factual index only: card number, NFC UID, item count, teaser (`web/data/hhd-cards.js`); no tag data | facts, compiled for this project |

### Licences in this repository

- The author's own source, everything except `web/data/amiibo-db.js`, is
  **MIT** (`LICENSE`).
- The generated `web/data/amiibo-db.js` embeds the amiibo name table from
  pixl.js and is therefore **GPL-2.0** (`LICENSE.GPL-2.0`); its series/type
  labels and dates come from AmiiboAPI (MIT).
- `package.json` declares `MIT AND GPL-2.0-only` to reflect both.

Attribution to every source is retained in the generator, the generated file's
header, and the site footer.
