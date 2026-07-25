# allmiibo-sync

Folder sync and collection tracking for Pixl.js / AmiiboLink-compatible NFC
emulator devices over Bluetooth LE.

The stock web tools (`bt.allmiibo.com`, `pixl.amiibo.xyz`) support only manual,
one-file-at-a-time transfers and hand-made folders. This project keeps a local
directory tree — subfolders and all — in sync with the device, with explicit
control over which side is authoritative.

> **Unofficial fan project.** Not affiliated with, endorsed by, or connected to
> Nintendo, the Pixl.js / AmiiboLink projects, or any device vendor. It ships no
> Nintendo data, no amiibo dumps, and no cryptographic keys — it only moves and
> catalogues the files already present on a connected device. See
> [Legal and licensing](#legal-and-licensing).

## Self-contained by design

No CDNs, no npm dependencies, no build step, no telemetry. Everything the tool
needs lives in this repository and runs on browser and Node built-ins alone.
The BLE protocol is documented in [PROTOCOL.md](PROTOCOL.md) rather than being
pulled from someone else's script at runtime.

## Status

Everything below is verified on hardware (Pixl.js 2.11.2 and 2.16.0).

- **Protocol** — reverse-engineered, cross-checked against the open-source
  firmware, verified on hardware. ✅
- **Client library** — 150+ tests against a simulated device. ✅
- **Read-only probe** — walks the entire device filesystem, 0 errors, reads
  byte-exact. ✅
- **Write test** — filenames stored verbatim, content round-trips exactly. ✅
- **Sync engine** — all four operations run against a real device. A full
  1914-operation replace of a 1049-dump library completed with zero failures. ✅
- **Collection view** — every known amiibo with artwork, per-series completion,
  release-sorted, compact/card views, and a per-amiibo detail page. ✅

Three hardware findings shape the sync design:

- **~2 KB/s, and slower as the drive fills** — 1.0 s per dump onto an empty
  drive, 2.5 s onto a full one. Transfer the minimum; long runs are resumable
  and every operation is logged.
- **`remove` deletes folders recursively**, with no "not empty" guard. Files
  are deleted individually.
- **`rename` moves between folders**, so a relocated file need not be re-uploaded.

## Hosting

The site is static files — the bundled Node server exists only to give Web
Bluetooth the secure context it requires during local development. To host it
elsewhere, serve the contents of `web/` from any HTTPS server; HTTPS is what
Web Bluetooth requires.

## Quick start

All commands are collected in [COMMANDS.md](COMMANDS.md).

Requires Node (any recent version) and Chrome or Edge. Web Bluetooth needs a
secure context, so the page must be served over `http://localhost` —
opening it as a `file://` URL will not work.

```sh
npm run serve          # or: node serve.mjs [port]
```

Then open <http://localhost:8080/> and press **Connect**.

Close any other tab connected to the device first — it accepts one BLE
connection at a time.

### The probe

**The probe is strictly read-only.** It issues no writes: nothing is created,
renamed, deleted, formatted, or flashed. It will:

1. Read the firmware version and BLE address.
2. List the drive and its used/total capacity.
3. Walk the whole directory tree (depth configurable).
4. Optionally read one file back to exercise the download path and confirm the
   size reported by `read_dir` matches the bytes actually returned.

It then produces a JSON report you can save or copy — useful for confirming the
open questions listed at the end of PROTOCOL.md.

### Syncing

Open <http://localhost:8080/sync.html>, connect the device, choose a local
folder, pick an operation, and press **Scan & plan**.

| Operation | Direction | Deletes | Matches on |
|---|---|---|---|
| **Download everything** | device → local | no | nothing — takes it all |
| **Replace device with local** | local → device | **yes** | path |
| **Smart sync** | both | optional | path, against the last sync |
| **Sync by amiibo** | both | no | amiibo identity |

**Download everything** is a backup: it copies the whole device into your
folder, keeping the device's layout, and writes nothing back.

Run it a second time and it skips what it already has, so only new or changed
files cost you time. A file is skipped when it was downloaded before, the local
copy still hashes to what was written, and the device file is still the same
size. Every dump is 540 bytes, so a device-side edit that kept the size is the
one case this cannot notice — tick **download everything again** to re-fetch
regardless. The plan says how many were skipped and why.

**Replace device with local** makes the device match your folder exactly,
including deletions. It always confirms first, with counts.

**It really does replace.** Everything under the device folder is deleted, then
the whole local folder is written back — nothing skipped, nothing trusted. A
mirror that skips files it believes are already correct is a different
operation, and that belief cannot be checked: a device file of the right size
and the wrong contents is indistinguishable from a good one without reading it
back at 2 kB/s. If you want only the differences moved, use **Smart sync**.

Deleting comes first, so only the final state has to fit rather than both
copies at once. Capacity is checked against what a file actually *occupies*,
not its contents: a 540-byte dump costs about 1.3 kB once filesystem overhead
is counted, so a 1049-dump library needs ~1.4 MB rather than the 590 kB its
bytes suggest.

Expect it to be slow. A full replace of a ~1000-dump library — clear the
device, then re-upload everything — took about **26 minutes** on real hardware;
a push onto an already-full drive is slower still (~2.5 s per dump). The plan
shows a time estimate before you commit.

**Smart sync** sends each side the other's changes, using the record of the
last sync to tell an edit from a deletion. It matches on path, so it works best
when both sides are laid out the same way.

**Sync by amiibo** ignores folders and filenames and asks only whether each
amiibo is on the other side — the right choice when the two layouts differ.
Identity is the amiibo ID plus the vehicle for Air Riders, falling back to file
content — so the 91 Happy Home Designer item cards (all one ID) and the four
vehicle pairings of each Air Riders character transfer individually rather than
collapsing to one each. It reads every device file first to identify it, which
takes a few minutes, and never deletes.

**Every operation is a dry run until you press Apply.** The plan lists exactly
what would be uploaded, downloaded, moved, deleted, skipped or blocked, with a
time estimate.

**Save run log** writes the whole run to JSON: the plan, the capacity figures,
and every operation with its duration, outcome, and — where the device refused
— the command and status it returned. Useful when something fails 300
operations into a 48-minute push.

### Collection view

Open <http://localhost:8080/collection.html> and choose the folder holding your
dumps. It lists every amiibo in the database, grouped by series, and marks
which you have — with:

- **artwork** on every entry, greyed out when unowned
- a curated figure per series on the header, with the series' release year
- **sort** by release date or name, and a **compact / card** view toggle
- filters for owned / missing / not-on-device, a search box, and a
  "copy missing list" button
- per-series completion counts and a top-line owned/missing summary

Each amiibo links to a **detail page** (`amiibo.html`) with its full-resolution
artwork, character, series, release date, format (v2/v3), raw ID, and — for
Kirby Air Riders — the vehicle line-up. The scan is cached per tab, so
returning from a detail page is instant; **Scan collection** refreshes it.

Optionally connect the device and press **Add device contents** to also mark
what is on the device. That reads every file, so it takes a few minutes and can
be stopped part-way.

**Artwork** (`npm run fetch-images`) downloads official artwork from AmiiboAPI
into three tiers: 96 px thumbnails, 256 px for Retina-sharp lists, and
full-size for the detail page. It is Nintendo's artwork, so **no tier is
committed to the repository** — all three are cached locally and deployed to
your own host. A fresh clone therefore shows letter placeholders until you run
`fetch-images`; the page uses the sharpest tier present and never fetches
anything at runtime.

**Keeping the database current** (`npm run update-db`) re-fetches both upstream
sources, regenerates `web/data/amiibo-db.js`, prints exactly what was added,
renamed or removed, and fetches artwork for anything new. See below.

Identity comes from the **amiibo ID** at bytes 84–91 of each dump, not from the
filename and not from a content hash — see below.

### Why identity is the amiibo ID, not a content hash

The collection needs each dump to map to a catalogued amiibo, and a content
hash cannot do that: the same amiibo dumped twice differs in UID and save data,
so it hashes differently. Measured on one real library, **1035 dumps produced
1035 distinct SHA-256 hashes but only 943 distinct amiibo IDs** — hashing would
have treated re-scans of amiibos already owned as brand-new, unrecognised
blobs. So both the collection view and the content comparison key on the amiibo
ID.

Three caveats, all real:

- The ID identifies a *model*, not always a distinct file. The clearest case is
  **Animal Crossing: Happy Home Designer** (the Nintendo 3DS game), which
  shipped 91 item-unlock cards that all carry a single shared figure ID — those
  account for almost all of the ~90 shared-ID dumps in the measurement above.
  Skylanders light/dark variants, and the four vehicle pairings of a Kirby Air
  Riders character, likewise share one ID. The tool falls back to file content
  to keep these distinct and reports "same ID, different bytes" rather than
  collapsing them.
- Newer amiibo (Kirby Air Riders onward) are **v3**: 2048-byte NTAG I2C 2K
  dumps whose ID ends in `03` rather than `02`. They parse, and their vehicle
  is decoded from the tag's SRAM buffer — see PROTOCOL.md §10.6.
- A dump can be recognised as an amiibo yet be newer than the database, so it
  has no name. Those are listed as *unlisted*, named by their character where
  the character is already known from an earlier figure.

### About the database

`web/data/amiibo-db.js` is generated by `tools/build-amiibo-db.mjs` from two
public sources and vendored — nothing is fetched at runtime:

- **[solosky/pixl.js](https://github.com/solosky/pixl.js)** `db_amiibo.c` — the
  table the device itself uses. Its names are more specific than the
  alternative (`[AC] 001 - Isabelle` rather than `Isabelle`), which matters for
  a collection list.
- **[8bitDream/AmiiboAPI](https://github.com/8bitDream/AmiiboAPI)** `amiibo.json`
  (MIT) — an actively maintained fork of
  [N3evin/AmiiboAPI](https://github.com/N3evin/AmiiboAPI), providing
  amiibo-series and figure-type labels plus release dates. Chosen over the
  upstream because the fork adds the newest releases (Kirby Air Riders v3,
  Mario Wonder, Splatoon Raiders, Pragmata…) while remaining a verified strict
  superset — no upstream entries dropped or corrupted.

**946 entries.** `update-db` prints every added, renamed or removed entry, so a
bad upstream edit can't slip into a commit unreviewed.

### Compare by content

Path-based sync cannot answer "is this amiibo on the device anywhere?" once a
file has been renamed or refiled. **Compare by content** reads every file off
the device and matches on amiibo ID, ignoring names and folders. It reports:

- amiibos on the device you do not hold locally
- local amiibos not on the device
- **variants**: the same amiibo ID where the device holds a dump whose bytes
  you do not have — this is what catches Skylanders dark figures
- files present on both sides under different names or folders
- duplicates within each side

It is strictly read-only and can be stopped part-way, but it costs a full read
per file — roughly 0.2 s each, so a few minutes for a full library.

Validated offline against two copies of one collection filed completely
differently: **zero shared paths, yet every amiibo ID matched**, and the only
genuine differences were surfaced as variants.

### Why "verify same-size files" exists

Every amiibo dump is exactly 540 bytes, so file size cannot detect a content
change. The tool records a SHA-256 per path at the end of each sync and uses
that. On the *first* run there is no record, so files present on both sides
with the same size are genuinely undecidable — they are listed as skipped
rather than guessed at.

Ticking **Verify** reads each such file back off the device to compare hashes.
That is correct but slow: roughly 0.2 s per file, so a few minutes for a full
library. Leave it off if you know which side is authoritative and just want a
`push`.

## Tests

```sh
npm test
```

No hardware needed. A static check guards the page modules, which touch
`document` and so cannot be imported under `node:test`: every function they
call must be defined or imported. That exists because a refactor deleted a
render function and left its call site, and nothing caught it until the page
threw.

Protocol tests run against a simulated device covering
framing, multi-notification reassembly, command serialisation, chunked writes,
error-status propagation and disconnect handling. Planner tests cover the
reconciliation rules and the safety properties listed above — that folders are
never removed as a shortcut for their contents, that deletions require opt-in,
that equal size is not mistaken for equal content, and that over-long paths are
blocked rather than attempted.

## How it works

The device exposes a small virtual-filesystem RPC over the Nordic UART Service:
`vfs_read_dir`, `vfs_open_file`, `vfs_read_file`, `vfs_write_file`,
`vfs_create_folder`, `vfs_remove`, `vfs_rename`. Files move in 242-byte chunks
with one command in flight at a time.

The device reports **no modification times**, so change detection uses file size
plus a content hash recorded in a local sync-state file. See
[PROTOCOL.md](PROTOCOL.md) for the full wire format.

## Layout

```
PROTOCOL.md               reverse-engineered wire protocol
COMMANDS.md               every command in one place
serve.mjs                 zero-dependency static server (Node built-ins only)

web/collection.html       collection UI
web/amiibo.html           per-amiibo detail page
web/sync.html             sync UI
web/index.html            read-only probe UI
web/write-test.html       write-test UI
web/css/app.css           shared styles

web/data/amiibo-db.js     946 amiibo IDs -> name/series/type/date (generated)
web/data/images/          artwork tiers, all gitignored, fetched + deployed

web/js/amiibo.js          amiibo ID parsing, series/type/faces, collection model
web/js/bytes.js           little-endian codecs, string and metadata TLV
web/js/ble.js             Web Bluetooth transport (Nordic UART Service)
web/js/protocol.js        framing, reassembly, command queue, VFS commands
web/js/planner.js         reconciliation logic — pure, no I/O
web/js/localfs.js         local folder access, hashing, sync state
web/js/sync.js            device walk and plan executor
web/js/syncui.js          sync page logic
web/js/collectionui.js    collection page logic
web/js/amiibodetail.js    detail page logic
web/js/footer.js          shared footer
web/js/probe.js           read-only probe logic
web/js/writetest.js       write-test logic

tools/build-amiibo-db.mjs regenerate the database from source files
tools/update-db.mjs        fetch upstream sources + regenerate + report the diff
tools/fetch-amiibo-images.mjs  download artwork, build the three tiers

test/protocol.test.mjs    protocol tests against a simulated device
test/planner.test.mjs     reconciliation and safety tests
test/amiibo.test.mjs      amiibo ID parsing and collection tests
test/ui-modules.test.mjs  static checks over the browser-only modules
```

## Keep dumps and keys out of git

If you sync into a folder inside a clone of this repo, note that a device also
holds `key_retail.bin` (the amiibo signing keys) alongside your dumps. The
included `.gitignore` excludes `*.bin` and common sync-target folder names for
that reason — check `git status` before committing if you change it. All amiibo
artwork is gitignored too — it is Nintendo's and is never committed.

## Compatibility

Protocol verified identical across the Allmiibo and PIXL web clients. Verified
on hardware: **Pixl.js 2.11.2 and 2.16.0** (nRF52832, external flash) — the
protocol is unchanged across those releases.

Firmware **2.16.0** (January 2026) added v3 amiibo emulation, so Kirby Air
Riders dumps work on-device from that version onward.

## Legal and licensing

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
`key_retail.bin`) — these are excluded by `.gitignore` and must never be
committed. The tool neither generates, decrypts, nor modifies amiibo data; it
only moves and catalogues the files already present on a connected device.

**Interoperability.** The Bluetooth protocol in [PROTOCOL.md](PROTOCOL.md) was
determined from the device firmware, which is published as open source by its
authors, and from the vendors' own publicly served web clients, for the sole
purpose of interoperating with a compatible device over Bluetooth.

**Nintendo artwork.** amiibo images shown by the collection view are © Nintendo.
They are fetched at the user's request for personal, local use and are **not**
redistributed by this repository — the entire `web/data/images/` tree is
gitignored, at every resolution.

### Third-party data and code

| Source | Used for | Licence |
|---|---|---|
| [8bitDream/AmiiboAPI](https://github.com/8bitDream/AmiiboAPI) (fork of [N3evin/AmiiboAPI](https://github.com/N3evin/AmiiboAPI)) | amiibo series/type labels, release dates, artwork URLs | MIT |
| [solosky/pixl.js](https://github.com/solosky/pixl.js) | wire protocol reference; amiibo name table | GPL-2.0 |
| amiibo artwork (fetched locally, never committed) | collection images | © Nintendo |

### Licences in this repository

- The author's own source — everything except `web/data/amiibo-db.js` — is
  **MIT** (`LICENSE`).
- The generated `web/data/amiibo-db.js` embeds the amiibo name table from
  pixl.js and is therefore **GPL-2.0** (`LICENSE.GPL-2.0`); its series/type
  labels and dates come from AmiiboAPI (MIT).
- `package.json` declares `MIT AND GPL-2.0-only` to reflect both.

Attribution to every source is retained in the generator, the generated file's
header, and the site footer.
