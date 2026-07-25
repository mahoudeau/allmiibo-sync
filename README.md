# allmiibo-sync

Folder sync for Allmiibo / PIXL NFC emulator devices over Bluetooth LE.

The stock web tools (`bt.allmiibo.com`, `pixl.amiibo.xyz`) only support manual,
one-file-at-a-time transfers and hand-made folders. This project keeps a local
directory tree — subfolders and all — in sync with the device, with explicit
control over which side is authoritative.

## Self-contained by design

No CDNs, no npm dependencies, no build step, no telemetry. Everything the tool
needs lives in this repository and runs on browser and Node built-ins alone.
The BLE protocol is documented in [PROTOCOL.md](PROTOCOL.md) rather than being
pulled from someone else's script at runtime.

## Status

- **Protocol** — reverse-engineered, cross-checked against the open-source
  firmware, and verified on hardware. ✅
- **Client library** — implemented, with 17 tests against a simulated device. ✅
- **Read-only hardware probe** — verified against Pixl.js 2.11.2: full walk of
  862 files across 44 folders, 0 errors, file read matching byte-for-byte. ✅
- **Write test** — verified: filenames stored verbatim, content round-trips
  exactly, and every remaining protocol question answered. ✅
- **Sync engine** — implemented, planner fully tested. Not yet run against
  hardware.
- **Collection view** — every amiibo in the database, per series, marked owned
  or missing. Identity comes from the amiibo ID in each dump.

Three hardware findings shape the sync design:

- **~2 KB/s.** A 540-byte dump costs ~0.5 s; a full 862-file push is ~7 minutes.
  Transfer the minimum, show progress, make long runs resumable.
- **`remove` deletes folders recursively**, with no "not empty" guard. Deleting
  files individually is the only safe approach.
- **`rename` moves between folders**, so a relocated file need not be re-uploaded.

## Quick start

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
folder, pick a direction, and press **Scan & plan**.

| Direction | Meaning |
|---|---|
| `push` | local is master; the device mirrors it |
| `pull` | device is master; the local folder mirrors it |
| `two-way` | reconcile both sides against the last sync |

**Every run is a dry run until you press Apply.** The plan lists exactly what
would be uploaded, downloaded, moved, deleted, skipped or blocked, with a time
estimate. Deletions are off by default and, when enabled, always ask for
confirmation.

**`push` and `pull` mirror; `two-way` reconciles.** In `push`, anything on the
device that is not in your local folder is surplus and will be removed when
deletions are enabled — the same on the first run as on the hundredth, without
consulting the sync state. `pull` does the reverse. `two-way` is different by
necessity: a file missing from one side there is ambiguous (never synced, or
deleted since), so only the recorded state can decide, and anything unrecognised
is left alone.

Even with deletions **off**, the plan still lists what *would* be removed under
`NOT DELETED`. Surplus files are never silently folded into the "unchanged"
count — you see the list before choosing whether to enable deletion.

Safety properties, each following from a verified device behaviour:

- **Files are deleted individually, never by removing their folder.** On this
  firmware `remove` deletes a non-empty folder recursively with no guard.
- **Folders are only created when the scan shows them missing**, because
  `create_folder` errors on an existing path and status is binary — so
  "already exists" is indistinguishable from a real failure.
- **A file that only moved is renamed on the device** rather than re-uploaded.
- **Destination paths are validated before anything is transferred**, so an
  over-long path is reported up front rather than failing mid-copy.
- **Device-managed files are excluded**: `settings.bin`, `key_retail.bin`.
- **State is saved as it goes**, so a disconnect part-way through a long push
  resumes rather than restarting.

### Collection view

Open <http://localhost:8080/collection.html> and choose the folder holding your
dumps. It lists every amiibo in the bundled database, grouped by series, and
marks which you have — with filters for owned / missing / not-on-device, a
search box, and a "copy missing list" button.

Optionally connect the device and press **Add device contents** to also show
what is on the device. That reads every file, so it takes a few minutes and can
be stopped part-way.

Identity comes from the **amiibo ID** at bytes 84–91 of each dump, not from the
filename and not from a content hash — see below.

### Why not compare by hash

Two dumps of the same character are not byte-identical: UID and save data
differ. Measured on a real collection: **1035 files, 1035 distinct SHA-256
hashes, but only 943 distinct amiibo IDs.** Hashing reported 92 re-dumps of
characters already held as brand-new figures.

The amiibo ID is the stable identity, so that is what the collection view and
the content comparison both use. Two caveats, both real:

- The ID identifies a *model*, not always a distinct figure. Skylanders light
  and dark variants share an ID, as do all 91 Animal Crossing Happy Home item
  cards, and all four vehicle pairings of a Kirby Air Riders character. "Same
  ID, different bytes" is reported rather than collapsed.
- Newer amiibo (Kirby Air Riders onward) are **v3**: 2048-byte NTAG I2C 2K
  dumps whose ID ends in `03` rather than `02`. They parse, and their vehicle
  is decoded from the tag's SRAM buffer — see PROTOCOL.md §10.6.
- The bundled table has 932 entries and predates the newest releases, so a
  dump can be recognised as an amiibo yet have no name. Those are listed as
  *unlisted* rather than hidden.

### About the database

`web/data/amiibo-db.js` is generated by `tools/build-amiibo-db.mjs` from two
public sources and vendored — nothing is fetched at runtime:

- **[solosky/pixl.js](https://github.com/solosky/pixl.js)** `db_amiibo.c` — the
  table the device itself uses. Its names are more specific than the
  alternative (`[AC] 001 - Isabelle` rather than `Isabelle`), which matters for
  a collection list: 67 of its names are ambiguous against 160 of AmiiboAPI's.
- **[N3evin/AmiiboAPI](https://github.com/N3evin/AmiiboAPI)** `amiibo.json`
  (MIT) — authoritative amiibo-series and figure-type labels.

The two carry an **identical set of 932 IDs** — the firmware table is an
AmiiboAPI snapshot — so the merge buys label quality, not coverage. AmiiboAPI
is the most current public database and was last updated December 2025; if a
dump is newer than that, no public source will name it.

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
per file — roughly 0.2 s each, so about three minutes for an 860-file library.

Validated offline against two real libraries of the same collection filed
completely differently: **zero shared paths across 1033 files, yet all 943
amiibo IDs matched**, and the two genuine differences were surfaced as
variants.

### Why "verify same-size files" exists

Every amiibo dump is exactly 540 bytes, so file size cannot detect a content
change. The tool records a SHA-256 per path at the end of each sync and uses
that. On the *first* run there is no record, so files present on both sides
with the same size are genuinely undecidable — they are listed as skipped
rather than guessed at.

Ticking **Verify** reads each such file back off the device to compare hashes.
That is correct but slow: roughly 0.2 s per file, so about three minutes for a
860-file library. Leave it off if you know which side is authoritative and just
want a `push`.

## Tests

```sh
npm test
```

No hardware needed. Protocol tests run against a simulated device covering
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
PROTOCOL.md              reverse-engineered wire protocol
serve.mjs                zero-dependency static server (Node built-ins only)

web/collection.html      collection UI
web/sync.html            sync UI
web/index.html           read-only probe UI
web/write-test.html      write-test UI
web/css/app.css          shared styles

web/data/amiibo-db.js    932 amiibo IDs -> names (generated, vendored)
tools/build-amiibo-db.mjs regenerates that table from the firmware source

web/js/amiibo.js         amiibo ID parsing, series/type decoding, collection
web/js/bytes.js          little-endian codecs, string and metadata TLV
web/js/ble.js            Web Bluetooth transport (Nordic UART Service)
web/js/protocol.js       framing, reassembly, command queue, VFS commands
web/js/planner.js        reconciliation logic — pure, no I/O
web/js/localfs.js        local folder access, hashing, sync state
web/js/sync.js           device walk and plan executor
web/js/syncui.js         sync page logic
web/js/probe.js          read-only probe logic
web/js/writetest.js      write-test logic

test/protocol.test.mjs   protocol tests against a simulated device
test/planner.test.mjs    reconciliation and safety tests
test/amiibo.test.mjs     amiibo ID parsing and collection tests
```

## Keep dumps and keys out of git

If you sync into a folder inside a clone of this repo, note that a device also
holds `key_retail.bin` (the amiibo signing keys) alongside your dumps. The
included `.gitignore` excludes `*.bin` and common sync-target folder names for
that reason — check `git status` before committing if you change it.

## Compatibility

Protocol verified identical across the Allmiibo and PIXL web clients. Verified
on hardware: **Pixl.js 2.11.2** (nRF52832, external flash).

## Disclaimer

Unofficial. Not affiliated with Allmiibo, PIXL, or Nintendo. Reverse-engineered
from publicly served JavaScript for interoperability with hardware the author
owns.
