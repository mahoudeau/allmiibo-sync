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

No CDNs, no build step, no telemetry. Everything the tool needs lives in this
repository and runs on browser and Node built-ins alone. The BLE protocol is
documented in [PROTOCOL.md](PROTOCOL.md) rather than being pulled from someone
else's script at runtime.

The one dependency is `linkedom`, and it is a **devDependency**: it gives
`npm test` a real DOM so the pages can be executed rather than only read. The
site ships nothing, the admin service ships nothing, and only running the tests
needs an install.

**The site people visit is static and has no server.** It is a directory of
files: no API call, no database, no runtime fetch of anything. That is
unchanged, and it is the property the rest of this document assumes.

There is one exception, and it is not part of the site. [`server/`](server/) is a
private admin service for curating the amiibo database (see
[Admin](#admin)), which regenerates the site's data file when something is
edited. The site never talks to it, does not know it exists, and works exactly
the same whether it is running or not. It is optional, it is not deployed with
the site, and it too has no dependencies.

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
- **Tests**: 497 across twenty-three files; the protocol suite runs against a
  simulated device, the admin suite against a real HTTP server on an ephemeral
  port, the UI suites against a real DOM, the rest are pure. ✅

Three hardware findings shape the sync design:

- **~2 KB/s, and slower as the drive fills**: 1.0 s per dump onto an empty
  drive, 2.5 s onto a full one. Transfer the minimum; long runs are resumable
  and every operation is logged.
- **`remove` deletes folders recursively**, with no "not empty" guard. Files
  are deleted individually.
- **`rename` moves between folders**, so a relocated file need not be re-uploaded.

## Quick start

All commands are collected in [COMMANDS.md](COMMANDS.md).

Requires Node (any recent version) and, for syncing, Chrome or Edge. Web
Bluetooth needs a secure context, so the page must be served over
`http://localhost`; opening it as a `file://` URL will not work. Firefox and
Safari can browse the database and scan a folder read-only to track a
collection; Bluetooth and writable folder access are Chrome/Edge only.

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

Both sources live in one **SOURCES** panel as identical rows, each a chip
with its controls (rescan, change folder, forget) and only its own facts
beneath: the folder shows its dump-file total, the device its amiibo count
and a bar for how much of the union is synced. One line at the panel's foot
gives the verdict: **ALL SYNCED** when the two sides are identical,
otherwise the synced percentage with what's left (`15 to send · 5 to
fetch`). Below the panel sits the collection's completion, hero-sized:
owned out of total with a chunky bar, where owned counts both sources, so
an amiibo that lives only on the device still counts; when that happens the
stat carries an **ONLY ON DEVICE** sub-count. The first time a state reaches identical, an
old-game victory overlay plays once; the counts under each source double as
filter shortcuts.
The toolbar has search (press `/`), filter pills with live counts, three
sorts (release, name, completion), a **CARDS** / **LIST** toggle, and a `⋯`
menu (**COPY MISSING LIST**, **SCAN REPORT**, **EXPORT SCAN LOG** for bug
reports (filenames, sizes and IDs as JSON, never file contents), and
expand/collapse all). Every
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
| **PACK FOLDER** | local → one file | no | amiibo identity | Advanced |
| **PACK DEVICE** | device → one file | no | amiibo identity | Advanced |

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

- **Loose `.bin` files** can stand in for a folder: pick dumps directly, or a
  single all-in-one file. They are a read-only source, since a folder is also
  where downloads land and where `.allmiibo-sync.json` is written, so they can be
  browsed and pushed but not pulled into. Picking files replaces a connected
  folder.
- **PACK FOLDER** and **PACK DEVICE** write a library out as a single
  all-in-one `.bin` (see below). They read one side and hand back a file, so
  neither has a plan to apply. `PACK FOLDER` needs no device and `PACK DEVICE`
  needs no folder, and the button is enabled accordingly.

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

A **guided tour** runs once on a first visit to the Collection and to Advanced
sync: a spotlight over one control at a time, ending on the HOW TO page. It is
remembered as soon as it is closed, however it is closed (finished, skipped,
Escape, or a click outside), and after that only replays on request from
**NEED HELP?**, in the corner of the sources card on the Collection and at the
end of the connect row on Advanced sync. Steps whose target is hidden
are skipped rather than shown pointing at nothing, which matters because half
the controls live behind Advanced and the review panels do not exist until a
scan has run.

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

### The curated overlay

Upstream is not always right, and it is not always current. Corrections live in
[`content/amiibo-overrides.json`](content/amiibo-overrides.json), which the
generator merges on top of the two sources. It can correct any upstream field,
add amiibo upstream does not have yet, pin a filename or a device path, and
define categories and notes.

It exists because **the database is generated**: `npm run update-db` rewrites
`web/data/amiibo-db.js` from scratch, so an edit made directly to that file
survives exactly until the next refresh. The overlay is an input, so it does not.

The merge happens **after the two sources combine and before anything is derived
from the names**. That ordering is the whole safety argument: a corrected or
authored entry then goes through the same disambiguation, the same 47-byte name
check and the same collision gate as an upstream one, with no special-casing
anywhere downstream. A curated name cannot bypass the check that stops two
amiibos landing on one device path.

Precedence, highest first:

| Output | 1 | 2 | 3 |
|---|---|---|---|
| the ID exists | overlay `kind:"new"` | `db_amiibo.c` | `amiibo.json` |
| `AMIIBO_NAMES` | overlay `name` | firmware table | API |
| `AMIIBO_SERIES` / `_TYPES` | overlay `label` | API | `Series ${b}` |
| `AMIIBO_RELEASE` | overlay `release` (`null` deletes) | earliest regional | absent |
| `AMIIBO_SERIES_SHORT` | overlay `short` | the committed token | minted |
| `AMIIBO_FILE_NAMES` / `_SHORT_NAMES` | overlay pin | derived | omitted |
| device path | a filename you chose on disk | overlay `path` | the ladder above |

Five more generated tables carry it: `AMIIBO_CATEGORIES`, `AMIIBO_PATHS`,
`AMIIBO_NOTES`, `AMIIBO_AUTHORED` and `AMIIBO_UPSTREAM` (what an override
replaced, which is how `update-db` notices upstream moving underneath a
correction, since the generated file alone cannot show a value an override was
masking). All are emitted whether or not anything is curated, so importers need
no fallback.

**Upstream can only warn; the overlay author can fail.** A routine refresh must
not break because a third party edited their repository, so an override for an ID
upstream dropped warns, and one upstream has caught up with is reported as
redundant. Authoring an ID that upstream now has is fatal: two sources claim to
name it and the tool cannot choose. So is an unknown key, because a mistyped
`"catagories"` that silently does nothing is the worst failure a curated file can
have.

A path cannot be pinned on an ID that stands for more than one physical dump.
Kirby Air Riders characters have four vehicle pairings per ID and the 91 Happy
Home Designer cards share a fabricated one, so a single pinned path would
collapse them and keep the last.

Authored entries appear behind the same Settings switch as the fan-made card set.
Neither is an official product, so with it off the headline completion figure
stays comparable.

### Naming a file for an amiibo

Sync normally moves files whose names you chose, and folder names are never
used for identity. But an amiibo can arrive without a home: as a member of an
all-in-one bundle, which has no filename at all, or as a loose `.bin` picked on
its own, which has a name but no folder. Then a path has to be worked out.

The two are not treated alike. A bundle member gets a name built from the
database. A picked file keeps the name you gave it and gains only a series
folder, so `K+WarpStar.bin` becomes `Kirby Air Riders/K+WarpStar.bin`; a name
too long for the device is the only case that falls back to a built one.

Air Riders needs one more thing. All four vehicles of a character share a single
amiibo ID, so a database-built name puts four real dumps on one path and keeps
the last. Where the app names one itself it adds the vehicle, shortened:
`KAR/Kirby (Warp).bin`. The full name does not fit, pushing the longest Air
Riders path to 72 bytes against a 63-byte limit. Bundles never hit this, since a
572-byte record cannot carry a vehicle at all. Where it
goes is decided at generation time rather than at sync time, in three extra
tables the generator emits:

| Table | Holds | Rows |
|---|---|---|
| `AMIIBO_SERIES_SHORT` | series byte → short folder token | 31 |
| `AMIIBO_FILE_NAMES` | ID → filename unique within its series | 21 |
| `AMIIBO_SHORT_NAMES` | ID → abbreviated filename | 46 |

The last two carry only the rows that differ from `AMIIBO_NAMES`, so 21 and 46
rather than 946 apiece.

Deciding it at build time is what makes it checkable. **The generator exits
non-zero and writes nothing if any `(series, filename)` pair is not unique.**
A silent fallback here would surface much later as two amiibos overwriting each
other on a device. `test/db.test.mjs` asserts the same invariants against the
committed file, since the header forbids hand edits but cannot prevent them.

Raw database names collide 13 times, and every clash has something real to name
it by, so none of them need a bare counter:

| What differs | Rule | Example | Count |
|---|---|---|---|
| figure type | append the type | `Luke (Card)` | 3 |
| character variant | append the variant | `Palico v2` | 2 |
| model number only | append the model | `Terry 04e8` | 8 |

The eight model-only pairs are two printings of one Street Fighter 6 card that
differ in nothing else. The 91 Happy Home Designer cards share a single ID, so
they are filed by UID instead (`AC/HHD 04ab17fc2e4080.bin`).

`AMIIBO_SERIES_SHORT` holds initials (`Mario Sports Superstars` → `MSS`,
`Street Fighter 6` → `SF6`), falling back to the full label where initials
would be useless or already taken. **These are stable**: a token already
committed is never re-derived, because changing one renames a folder on every
synced device and the next sync then moves everything inside it. The generator
reads what is already there and mints tokens only for new series, and
`npm run update-db` reports any change to one as loudly as it reports a removal.

Paths are then assembled by `amiiboRelPath` (in `planner.js`, next to
`checkDestination`), which shortens in steps until the path fits the device's
63-byte limit: full series label, then its initials, then the abbreviated name,
then the ID as a last resort. It measures against the real device root, because
how much shortening is needed depends on the root's depth. Measured over all 946
entries:

| Device root | Full label | Initials | Abbreviated | ID | Collisions |
|---|---|---|---|---|---|
| `E:/amiibo` | 937 | 9 | 0 | 0 | 0 |
| `E:/amiibo/library` | 878 | 68 | 0 | 0 | 0 |
| `E:/a/very/deep/nested/root` | 577 | 357 | 6 | 6 | 0 |

The last two rungs are never reached in normal use and stay as a guard. The ID
fallback replaced an earlier truncating version, which produced a collision at a
deep root: two amiibos trimmed to the same prefix would have overwritten each
other, and an ugly filename is much better than a silent loss.

## All-in-one bundles

Some tools distribute a whole amiibo library as a **single file**. Two such
containers are read; both are specified in full in
[`FORMATS.md`](FORMATS.md).

- **Flat 572**, the one written as well as read, produced by `PACK FOLDER` and
  `PACK DEVICE`. Reverse engineered, described below.
- **FCA**, read only, to the [published specification](https://github.com/fishybow/fca/blob/main/SPEC.md)
  by fishybow (MIT). A real archive with a header and length-prefixed typed
  entries, and the better of the two where there is a choice: its type-2 entries
  carry whole 2048-byte v3 dumps, so **Kirby Air Riders vehicles survive**, which
  the flat format cannot manage. Detection needs the `FCA` magic bytes, entries
  that tile the file exactly, and at least one amiibo among them; a Skylanders
  archive is recognised as none of this app's business rather than torn apart.
  Verified against four real Flashiibo exports: 525, 417, 942 and 16 entries,
  the last being 4 characters × 4 vehicles as whole 2048-byte dumps. Those
  numbers are pinned in `test/fca.test.mjs`.

The flat container is as simple as it gets: a run of fixed-size records, no
header, no index, no name table, no checksum, no version field.

```
record[0x000 .. 0x21B]   540 bytes  NTAG215 image (pages 0..134)
record[0x21C .. 0x23B]    32 bytes  0xFF padding
                         572 bytes  total, repeated to end of file
```

572 is already a size the firmware recognises (`DUMP_SIZES` calls it Thenaya),
so every record is an ordinary dump and `parseAmiiboId` reads its ID at byte 84
unchanged. Reverse engineered from two real bundles, 949 records in total:

- every record passes the NTAG structural checks (`0xA5` magic, capability
  container `F1 10 FF EE`, both UID check bytes);
- the padding is 32 × `0xFF` in all 949, with no other variant;
- a 943-record bundle was sorted ascending by amiibo ID from record 1 on, with
  one late arrival prepended out of order, so ordering is a convention rather
  than something to rely on;
- 942 of those 943 were 532-byte dumps zero-extended to 540 (password and PACK
  zeroed, dynamic lock `0F BD`). Harmless: 2044 of 2084 dumps in one real
  library have the same zeroed tail, and the firmware never reads it.

A bundle in your sync folder is detected during the normal scan, unpacked in
memory (943 × 540 bytes is about 509 kB, so there is nothing to stream) and its
amiibos planned individually. **The container itself is excluded from every
plan.** Before this existed the planner treated it as an ordinary foreign file
and would have pushed half a megabyte to a device that cannot read it, about
four and a half minutes at 2 kB/s.

Detection is deliberately strict, because mistaking a real dump for a bundle
would replace one amiibo with a phantom library: the length must divide evenly,
there must be at least two records, every record must pass the structural
checks, and at least 90% must name an amiibo in the database. Record sizes are
not coprime (77,220 bytes divides by both 540 and 572), so when more than one
reading fits, the one recognising more amiibos wins.

**Only what is missing transfers.** A record is dropped when you already hold
that amiibo locally, when the device already has it, when an earlier bundle in
the same folder offered it, or when it duplicates an earlier record, either
byte-identically or as a second tag of the same character. That check lives in
`bundlesource.js` rather than in the planner on purpose: `planIdentitySync` keys
identity on content hash as well as ID, deliberately, so that the 91 item cards
and the four vehicle pairings stay distinct. Bundle dumps carry freshly
generated UIDs (not one of 943 records matched any of 2084 local dumps
byte-for-byte), so left to the planner every member would read as a new item and
duplicate something already on the device.

Matching against the device by amiibo rather than by path requires **MATCH**,
which reads every device file. A plain **SYNC** compares paths only, and the
scan says which of the two it did rather than implying the check was thorough.

**What a bundle cannot carry.** A record holds 540 bytes. Kirby Air Riders
amiibo are 2048-byte NTAG I2C 2K dumps whose vehicle lives at byte 979, well
past the end of a record, so all four vehicle pairings for a character collapse
into one vehicle-less entry. The bundles' Air Riders records are re-generated
NTAG215 tags with UIDs unrelated to the real figures. **A 2048-byte local dump
is strictly better than any bundle copy of the same amiibo**, which is why one
is never dropped in favour of a bundle's version.

**Artwork** (`npm run fetch-images`) downloads official artwork from
AmiiboAPI into three tiers: 96 px thumbnails, 256 px for Retina-sharp lists,
and full-size for the detail page, plus the four Air Riders vehicle renders
from Nintendo's asset CDN. It is Nintendo's artwork, so **no tier is
committed to the repository**: everything is cached locally and deployed to
your own host. A fresh clone shows letter placeholders until you run
`fetch-images`; the page uses the sharpest tier present and never fetches
anything at runtime.

## Admin

An optional private service for curating the database from a browser, without
git and without a deploy. It is **not part of the site**: it lives outside
`web/`, is not deployed by the site's deploy path, and nothing links to it.

```
you ──▶ the admin (Node)          the site (Apache, static)
            │                            ▲
            │ writes content/…json        │
            └─ regenerates ───────────────┘  web/data/amiibo-db.js
```

Saving writes the overlay, then regenerates the site's database, so an edit is
live immediately. Both writes are atomic, a temporary file renamed into place,
so a crash leaves the previous version intact rather than a truncated one, and a
visitor loading the site mid-save gets the old file or the new one, never half of
either. Every save keeps a timestamped copy of the previous overlay first, in
`content/backups/` (gitignored: the overlay itself is committed, and git is the
history).

Regeneration calls the same `generate()` the command line calls, and is tried as
a dry run before anything is written. A save that would put two amiibos on one
device path is refused with the reason, and neither file is touched.

### Backups, restore and export

The BACKUPS drawer lists those timestamped copies, newest first, and offers each
one for download or restore. **A restore is a save**: it runs the same dry run,
is refused the same way if the result would not build, and takes its own backup
of what it replaces before writing — so restoring the wrong one is itself
undoable. Both go through one function in the server for exactly that reason;
two code paths to the same file is how one of them quietly loses a gate.

Restoring over unsaved edits asks about the edits first, separately, rather than
burying "you will lose your work" inside "restore this backup?".

EXPORT downloads the live overlay. It fetches it rather than navigating to the
URL: navigation bypasses the error handling, so an expired session used to save
the 401 response body under the name of a backup — a corrupt file you would not
discover until you needed it.

Only a file whose name is a backup stamp can be read from the backup directory.
The pattern is defined once, in `server/store.mjs`, and imported by the route;
two copies of a filename whitelist drifting apart is how the interesting bugs
get in.

### Running it

Secrets live in the environment and never in the repository.

Hash a password once:

```sh
node -e "import('./server/auth.mjs').then(m=>console.log(m.hashPassword('your password')))"
```

Then set these in the environment, wherever your host keeps them. They are
written out here as names only, deliberately: the leak guard in
`test/admin.test.mjs` fails on anything in the repository that looks like one of
these being assigned a value, and documentation is not worth an exception.

| Variable | Value |
|---|---|
| `ADMIN_PASSWORD_HASH` | the output of the command above |
| `SESSION_SECRET` | 32 bytes of hex, e.g. from `openssl rand -hex 32` |
| `PUBLIC_SITE_DIR` | where the site's files are served from |
| `DATA_DIR` | where the overlay and its backups live |
| `CACHE_DIR` | the fetched upstream sources |
| `PORT`, `HOST` | optional; default `8081` on `127.0.0.1` |

Then `node server/index.mjs`.

With no password and no session secret it refuses every request and will not
start from the command line. It fails closed rather than running open.

### Security

The repository is public, so the code describes the whole scheme; the security is
in the secrets, which are only ever in the environment. The password is
scrypt-hashed and compared in constant time. Sessions are signed, stateless and
expiring, with an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Every mutating
request needs a CSRF token belonging to that session. Failed logins are rate
limited per client. Request bodies are capped as they arrive rather than trusting
the declared length. The one place a request string reaches the filesystem is
normalised and checked to be inside its root. Errors never carry a stack.

The hostname it answers on is treated as a secret too, which mostly means the
code never needs it: the UI uses relative URLs and the server reads its host from
the environment. The admin page carries no `og:*`, no manifest and no canonical
link, any of which would publish the address in a preview card. A test enforces
all of this over every committed *and uncommitted* file, without itself naming
the host.

Worth being plain about: **a secret hostname is obscurity, not security.** It
appears in DNS and in Certificate Transparency logs the moment TLS is issued for
it, which makes subdomains publicly enumerable. The password and the session
handling are what actually protect this.

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

The protocol has no heartbeat, and an idle device can power itself off, so
after ten seconds of silence the client sends a `get_version` as a
keep-alive: the cheapest command there is, and it never interleaves with
real work.

## Tests

```sh
npm test
```

497 tests, no hardware needed:

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
- `bundle.test.mjs`: the all-in-one format. Detection accepts a real bundle and
  rejects a single dump, a wrong length, and right-length noise; pack and split
  round-trip byte for byte; path assignment stays unique and inside the device's
  limits across all 946 entries at several device roots; unpacking drops what you
  already hold, collapses duplicates, keeps the 91 UID-keyed cards apart, and
  never steals a path a real file occupies. Everything is asserted against
  synthetic bundles built to the spec, since `amiibos/` is not committed; the two
  real samples are checked behind an `existsSync` guard.
- `dbsource.test.mjs`: the upstream parsers and the name derivation, against
  tiny committed fixtures. This logic built the database for months with no
  direct test, because it lived inside the generator where nothing could reach
  it. Covers escaped quotes and non-ASCII names, malformed rows being skipped
  without throwing, the earliest release winning, and each disambiguation rule
  in turn.
- `overlay.test.mjs`: the curated overlay. Mostly about what it refuses:
  unknown keys, uppercase IDs, a filename that is really a path, a pin that
  would not fit the device, and a pinned path on an ID that stands for many
  physical dumps.
- `auth.test.mjs`: passwords, sessions, cookies, CSRF and rate limiting.
  Includes the cases that are easy to get wrong: a malformed hash refusing
  everyone rather than everyone, and garbage tokens failing rather than throwing.
- `server.test.mjs`: the admin over real HTTP on an ephemeral port. Refuses
  without a session, without a CSRF token, and with another session's token;
  refuses a save that would not build, leaving both files untouched; caps body
  size; blocks four shapes of path traversal. Also the backup routes: a restore
  meets the same gate as a save and is itself undoable, and only a file whose
  name is a backup stamp can be read from the backup directory — asserted by
  planting one that is not and requiring it to stay unreadable, since Node's
  URL parser never decodes `%2F` and so a traversal string cannot reach that
  code to begin with.
- `admin.test.mjs`: the leak guards. No committed *or uncommitted* file may name
  a subdomain of the public site, assign a secret, or contain a password hash;
  nothing may link to the admin. The file does not name the host it protects.
- `db.test.mjs`: invariants of the generated database, enforced on the committed
  file as well as at generation: every `(series, filename)` pair unique, short
  tokens present and unique, the delta tables carrying only real deltas, and no
  filename over the device's 47-byte limit.

The last seven run the interface itself, against a real DOM from `linkedom`.
They exist because every UI bug in this project's history lived in a gap
`ui-modules.test.mjs` cannot see: a selector matching nothing, a container
styled through a child it does not have, a page that renders blank because a
module failed to load. `npm test` said everything passed each time.

- `collectionview.test.mjs` and `collectiongrid.test.mjs`: the collection, split
  into what it decides and what it draws. The grid is built for all 31 series
  and inspected: no amiibo is dropped between the data and the DOM, filtering
  hides prebuilt cells rather than rebuilding them, a match forces its series
  open, and changing the sort moves the existing nodes instead of remaking them.
- `admin-ui.test.mjs`: the admin page read without executing it. Every element
  the script reaches for exists, every `data-ico` names a real icon, the
  sign-in form is visible before any script runs, and the grid is styled in one
  place rather than once per page.
- `admin-boot.test.mjs`: the admin actually run — `adminui.js` imported against
  the real page with a stubbed API, then driven: sign in, search, filter, edit,
  revert, publish. This is the file that would have caught the white screen.
- `admin-style.test.mjs`: the CSS as text, since there is no layout engine. Its
  centrepiece is a class-clash detector — every class the admin borrows checked
  against every class `app.css` styles unqualified. It exists because `.fRow`
  was such a class, owned by the site footer, and the admin's form rows
  inherited a flex row that put each label, input and error side by side.
- `amiibodetail-page.test.mjs`: the detail page rendered for three fixtures — a
  plain figure, the Kirby Air Riders vehicle set and the 91-card HHD entry —
  and compared against a committed snapshot. It was written against the page
  *before* its renderer moved into `amiibopanel.js`, so it is the acceptance
  test for that extraction: the public page draws byte-for-byte what it drew.
- `amiibopanel.test.mjs`: the renderer underneath it. Chiefly that every image
  URL comes from the injected hook — four inline `./data/images/...` literals
  were the reason the panel could not be shared, since the site is served from
  `./` and the admin from `/`. Also that "nothing scanned" stays distinct from
  "scanned, and not owned", which a boolean would collapse.

Each of these files ends with a test whose only job is to prove the file can
fail: it replays the real regressions against the same assertions and requires
them to throw. A test that cannot fail is decoration.

Two limits worth knowing: there is no layout engine, so anything about pixels,
sizes or overflow is still invisible and needs a human; and `linkedom` does not
reflect every IDL property onto an attribute (`open` and `loading` are
properties only), so assertions use the property unless the markup carries the
attribute.

## Layout

```
PROTOCOL.md               reverse-engineered wire protocol
FORMATS.md                the two all-in-one container formats, in full
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
web/css/collection.css    the collection grid and its toolbar, shared with
                          the admin so both draw the same list
web/css/amiibodetail.css  the detail panel, shared with the admin
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
web/js/planner.js         reconciliation logic + path assignment (pure, no I/O)
web/js/dbsource.js        upstream parsers + name derivation, shared by the
                          generator, the admin server and the browser
web/js/devicepath.js      device byte limits and safe names, with no DB import
web/js/overlay.js         the curated overlay: schema, validation, merge
web/js/bundle.js          flat 572 all-in-one format: detect, split, pack
web/js/fca.js             FCA all-in-one archive: detect, split (read only)
web/js/bundlesource.js    unpack either into the local index, gap-fill dedupe
web/js/localfs.js         local folder access, hashing, sync state
web/js/syncflow.js        the sync engine both surfaces share (scan/plan/apply)
web/js/devicepicker.js    folder browser for the device side
web/js/sync.js            device walk and plan executor
web/js/syncui.js          Advanced sync page logic
web/js/collectionui.js    collection page logic
web/js/collectionview.js  filtering, counting and ordering a collection (pure)
web/js/collectiongrid.js  the series/cards grid, shared with the admin
web/js/amiibopanel.js     one amiibo drawn, shared with the admin
web/js/amiibodetail.js    detail page: the URL, the scan cache, prev/next
web/js/artwork.js         where the artwork lives: tiers, URLs, error fallback
web/js/chrome.js          the header bar and footer as builders, seeded by the
                          page that mounts them
web/js/header.js          the site's header contents: nav, Settings sections
web/js/prefs.js           every stored preference behind one tiny surface
web/js/ui.js              shared UI kit: toasts, status, progress, dialogs,
                          debounce, counters, formatters
web/js/dialog.js          themed confirm on native <dialog>
web/js/footer.js          the site's footer contents
web/js/version.js         build id shown in the footer ('dev' in the repo,
                          stamped with the commit at deploy time)
web/js/icons.js           8-bit UI icons (Pixelarticons, inlined)
web/js/sprite.js          the pirate mascot as pixel-map -> SVG
web/js/tutorial.js        the guided tour: spotlight overlay + per-page steps
web/js/probe.js           read-only probe logic
web/js/writetest.js       write-test logic

content/amiibo-overrides.json  curated corrections, merged by the generator
content/backups/          the admin's timestamped saves (gitignored)

server/index.mjs          the admin service: routing, sessions, static UI
server/auth.mjs           scrypt password, signed cookie, rate limit, CSRF
server/store.mjs          atomic overlay writes and backups
server/regen.mjs          rebuild the site database after an edit
admin/                    the admin UI (not part of the public site)

tools/build-amiibo-db.mjs regenerate the database; also importable as generate()
tools/update-db.mjs        fetch upstream sources + regenerate + report the diff
tools/fetch-amiibo-images.mjs  download artwork, build the three tiers

test/                     twenty-three files, see Tests above
```

## Hosting

The site is static files: the bundled Node server exists only to give Web
Bluetooth the secure context it requires during local development. To host it
elsewhere, serve the contents of `web/` from any HTTPS server; HTTPS is what
Web Bluetooth requires. A deployment is a plain mirror of `web/`: the
artwork tiers are gitignored but do get deployed, and `design-lab.html` stays
home.

The [admin](#admin) is not part of that mirror. It lives outside `web/`, so a
deploy neither carries it nor exposes it. If you run one, it needs its own site
and its own hostname, and the deploy must stop overwriting `web/data/`. The
admin owns that directory once it is regenerating the database, and a mirror
would put the repository's copy back over your edits.

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
| [fishybow/fca](https://github.com/fishybow/fca) ([SPEC.md](https://github.com/fishybow/fca/blob/main/SPEC.md)) | published specification for the FCA all-in-one container, implemented as a reader in `web/js/fca.js` | MIT |
| amiibo artwork + vehicle renders (fetched locally, never committed) | collection and detail images | © Nintendo |
| fan-made HHD card pack (community, authors unknown) | factual index only: card number, NFC UID, item count, teaser (`web/data/hhd-cards.js`); no tag data | facts, compiled for this project |

### Licences in this repository

- The author's own source, everything except `web/data/amiibo-db.js`, is
  **MIT** (`LICENSE`). That includes `content/amiibo-overrides.json`: it is
  independently authored corrections, not a modification of the GPL-2.0 name
  table, and it embeds none of it. Only the generated combination is GPL-2.0.
- The generated `web/data/amiibo-db.js` embeds the amiibo name table from
  pixl.js and is therefore **GPL-2.0** (`LICENSE.GPL-2.0`); its series/type
  labels and dates come from AmiiboAPI (MIT).
- `package.json` declares `MIT AND GPL-2.0-only` to reflect both.

Attribution to every source is retained in the generator, the generated file's
header, and the site footer.
