# Allmiibo / PIXL BLE VFS Protocol

Reverse-engineered from the official Web Bluetooth clients:

- `https://bt.allmiibo.com/` — Vue app, bundle `/js/app.5be9472d.js`
- `https://pixl.amiibo.xyz/` — bundle `/index.js?815c0d29c8e2d63e8fcc`

Both clients speak the **identical** wire protocol. The PIXL bundle additionally
implements `vfs_read_file` (opcode 20), which the allmiibo page never calls —
this is the missing half that makes device→local sync possible.

The device firmware is open source, which makes it the authority for anything
the clients left ambiguous:

- [`solosky/pixl.js`](https://github.com/solosky/pixl.js)
- `fw/application/src/mod/df/df_proto_vfs.c` — command handlers
- `fw/application/src/mod/vfs/vfs.h` — limits, mode flags, error codes

Everything below has been cross-checked against that firmware. Confirmed
against hardware running **Pixl.js 2.11.2 and 2.16.0** — the wire protocol is
unchanged across those five releases (October 2024 to January 2026), including
the addition of v3 amiibo emulation in 2.16.0.

---

## 1. Objectives

The stock web UI only allows manual, one-file-at-a-time transfers and manual
folder creation. This project replaces it with a folder-level sync tool.

Goals:

1. Keep a local directory tree (subfolders + files) in sync with the device's
   internal filesystem.
2. Explicit direction control:
   - `push` — local is master; device mirrors local.
   - `pull` — device is master; local mirrors device.
   - `two-way` — reconcile both sides against a stored sync state.
3. Recursive: create/remove folders on the device as needed, not by hand.
4. Idempotent: re-running a sync with no changes transfers nothing.
5. Dry-run mode that prints the full plan before touching either side.
6. Deletion propagation as an explicit opt-in (`--delete`), never by default.

Non-goals: firmware updates (DFU), amiibo key handling, tag emulation logic.

---

## 2. Transport

Nordic UART Service (NUS):

| Role | UUID | Properties |
|---|---|---|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | — |
| RX (host → device) | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write |
| TX (device → host) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify |

The client scans with `filters: [{ services: [NUS] }]`, connects, subscribes to
notifications on TX, and writes requests to RX.

Sizing constants from the client:

```
MTU          = 247
HEADER_LEN   = 4
MAX_PAYLOAD  = MTU - HEADER_LEN        = 243
WRITE_CHUNK  = MAX_PAYLOAD - 1         = 242   // minus 1 byte for file_id
```

**All integers are little-endian.**

---

## 3. Framing

### 3.1 Header (4 bytes, both directions)

| Offset | Type | Field |
|---|---|---|
| 0 | u8 | `cmd` |
| 1 | u8 | `status` |
| 2 | u16 | `chunk` |

### 3.2 Request (host → device)

A request is a single GATT write: header with `status = 0`, `chunk = 0`,
followed by the command payload. Requests are never split — every command's
payload fits within `MAX_PAYLOAD`.

### 3.3 Response (device → host)

Responses arrive as one or more notifications.

- If `chunk & 0x8000` is set, more notifications follow.
- The final notification has bit 15 clear.

Reassembly (mirroring the client's accumulator):

1. First notification of a multi-part response: append the **entire buffer,
   including its 4-byte header**.
2. Subsequent notifications: append **payload only** (skip the 4-byte header).
3. On the final notification: append payload, then parse the accumulated buffer
   — its leading 4 bytes are the header from step 1.

A single-notification response is parsed directly.

`status` is binary — the firmware only ever emits these two values:

```c
typedef enum { DF_STATUS_OK = 0, DF_STATUS_ERR = 1 } df_status_t;
```

There is no detailed error reporting on the wire. Internally the VFS layer has
a richer set (`VFS_ERR_NOOBJ = -90`, `VFS_ERR_NOSPC = -91`,
`VFS_ERR_OBJEX = -4`, `VFS_ERR_UNSUPT = -99`, …) but `df_proto_vfs.c` collapses
them all to `DF_STATUS_ERR`; the source even carries a `// TODO mapping error`
where that happens. A failed command therefore says *that* it failed, never
*why*.

### 3.4 Concurrency

The client keeps a FIFO queue with **strictly one command in flight**. The next
request is only written after the previous response fully arrives. Do not
pipeline — the device has no request IDs to correlate replies.

---

## 4. Type codecs

### 4.1 String

```
u16  byte_length
u8[] utf8_bytes
```

(The client encodes via `encodeURIComponent`, i.e. plain UTF-8.)

### 4.2 Metadata TLV

Used by `vfs_read_dir` (read) and `vfs_update_meta` (write).

```
u8 total_length          // 0 => no metadata
  then, repeated until consumed:
  u8 tag
    tag 1 (notes):  u8 length, u8[length] utf8_bytes
    tag 2 (flags):  u8 flags       // bit 0 = hidden
```

Constraint: notes must be **≤ 90 bytes** (client throws above that).

### 4.3 Directory entry

```
string name
u32    size
u8     type        // 0 = regular file, non-zero = directory
meta   metadata
```

### 4.4 Paths and constraints

Every path is drive-prefixed and the firmware validates the prefix strictly:

```c
static bool validate_path(char *path) {
    if (path[0] != 'I' && path[0] != 'E') return false;
    if (path[1] != ':' || path[2] != '/')  return false;
    return true;
}
```

So a path looks like `E:/folder/file.bin`. The two drive labels are fixed:

| Label | Root | Drive |
|---|---|---|
| `I` | `I:/` | internal flash |
| `E` | `E:/` | external flash |

**The root must be built from the drive's `label`, not its `name`.** The `name`
field is a human-readable string such as `"External Flash"`. The official UI
gets away with `name.substr(0, 3)` only because it renders its own drive rows;
applying that to the value returned by `vfs_get_drive_list` yields `"Ext"`,
which fails `validate_path`. See §7.1.

The firmware strips the first two bytes (`VFS_DRIVE_LABEL_LEN`) and passes the
remainder — `/folder/file.bin` — to the filesystem driver.

Size limits, from `vfs.h` (these include the NUL terminator, hence the
clients' 47/63):

| Constant | Value | Effective limit |
|---|---|---|
| `VFS_MAX_NAME_LEN` | 48 | filename ≤ 47 bytes |
| `VFS_MAX_PATH_LEN` | 64 | path ≤ 63 bytes |
| `VFS_MAX_META_LEN` | 128 | — |
| `VFS_MAX_FOLDER_SIZE` | 32 | entries per folder |

### 4.5 Over-long paths are silently truncated — enforce client-side

**This is the single most important reason to validate paths before sending.**
An over-long path does not produce an error. `buff_get_string` in
`df_buffer.h` clamps and carries on:

```c
static inline void buff_get_string(buffer_t *buffer, char *string, size_t max_length) {
    uint16_t length = buff_get_u16(buffer);
    ...
    max_length = max_length - 1;                                   // exclude '\0'
    uint16_t min_length = max_length > length ? length : max_length;
    buff_get_byte_array(buffer, string, min_length);
    string[min_length] = '\0';
    buffer->pos += length - min_length;                            // discard the excess
}
```

Handlers read into `char path[VFS_MAX_FULL_PATH_LEN]` (66 bytes), so anything
longer than 65 bytes is truncated and the command then executes **against the
truncated path**, reporting `DF_STATUS_OK`.

Consequences, worst first:

- **`vfs_remove` deletes the wrong entry.** Truncation can land the path on a
  different file, or on a *directory* — and removal is recursive (§9.4). An
  unvalidated remove can therefore destroy an entire subtree while reporting
  success.
- **`vfs_open_file` in write mode creates a file at the truncated path**,
  typically losing the `.bin` extension, and silently.
- `vfs_rename` moves to the wrong destination.

There is no memory-safety issue — the clamp is correct and NUL-termination is
guaranteed. The hazard is purely that the device does something other than what
was asked, without saying so.

**Enforce every path client-side, on every path-taking command**, including the
destructive ones.

### 4.6 Why 63 and not 65

The firmware's own ceiling is 65 bytes for a full path: a 66-byte buffer less
the NUL. After `get_file_path` strips the 2-byte drive label, the driver sees
≤ 63 characters, which matches `SPIFFS_OBJ_NAME_LEN` (64). SPIFFS is flat — the
whole path *is* the object name.

Both official clients nonetheless enforce **63 bytes**, two below what the
firmware would accept. This project keeps 63, for two reasons:

1. Files created outside the official clients' limit could not be managed by
   the stock web UI, which refuses to send such paths at all.
2. Two bytes of headroom is not worth being the only tool that can address a
   given file.

The filename cap of 47 bytes is enforced only by the clients — the firmware
does not check it separately on the request path, though `vfs_obj_t.name` is a
48-byte field that directory listings `strncpy` into, so a longer name would be
truncated in listings regardless.

---

## 5. Command reference

| Opcode | Name | Request payload | Response payload |
|---|---|---|---|
| 1 | `get_version` | — | `string ver`, optional `string ble_addr` |
| 2 | `enter_dfu` | — | — |
| 16 | `vfs_get_drive_list` | — | `u8 count`, then entries (see 5.1) |
| 17 | `vfs_drive_format` | `u8 label_char` | — |
| 18 | `vfs_open_file` | `string path`, `u8 mode` | `u8 file_id` |
| 19 | `vfs_close_file` | `u8 file_id` | — |
| 20 | `vfs_read_file` | `u8 file_id` | `u8[] contents` (all remaining bytes) |
| 21 | `vfs_write_file` | `u8 file_id`, `u8[] data` | — |
| 22 | `vfs_read_dir` | `string path` | repeated dir entries until exhausted |
| 23 | `vfs_create_folder` | `string path` | — |
| 24 | `vfs_remove` | `string path` | — |
| 25 | `vfs_rename` | `string from`, `string to` | — |
| 26 | `vfs_update_meta` | `string path`, `meta` | — |

Opcodes 3–15 are unused by both clients.

### 5.1 Drive list entry

```
u8     status       // 0 = available, 1 = unavailable
u8     label        // 'I' or 'E'
string name         // human-readable, e.g. "External Flash"
u32    total_size
u32    used_size
```

`count` is `vfs_drive_enabled(INT) + vfs_drive_enabled(EXT)`, so it can be 2.
The official client reads only the first entry; parse all of them.

Observed on hardware (Pixl.js 2.11.2): `count = 1`, `status = 0`,
`label = 'E'`, `name = "External Flash"`, 966,601 of 1,920,401 bytes used.

> **Firmware quirk.** In the internal-drive branch, `df_proto_vfs.c` calls
> `vfs_get_driver(VFS_DRIVE_EXT)` where it plainly means `VFS_DRIVE_INT`, so a
> device with internal flash enabled reports the *external* drive's stats under
> label `'I'`. Do not trust `total_size`/`used_size` for the `I` drive.

### 5.2 Open modes

The mode is a **u32**, read by the firmware with `buff_get_u32`. Both official
clients write a single byte and get away with it only because the frame buffer
is zeroed beneath them — send all four bytes.

Flags are `enum vfs_mode_t` in `vfs.h`:

| Flag | Value |
|---|---|
| `VFS_MODE_APPEND` | 1 |
| `VFS_MODE_TRUNC` | 2 |
| `VFS_MODE_CREATE` | 4 |
| `VFS_MODE_READONLY` | 8 |
| `VFS_MODE_WRITEONLY` | 16 |

The combinations the clients use:

| Mode | Value | Meaning |
|---|---|---|
| `"r"` | `8` | `READONLY` |
| `"w"` | `22` | `WRITEONLY \| CREATE \| TRUNC` — creates if absent, truncates if present |

Note that `"w"` **truncates an existing file**, so a failed write leaves the
destination empty rather than untouched.

Only one file is open at a time: opening a new file while another is open
silently closes the previous handle.

---

## 6. Flows

### 6.1 List a directory

```
vfs_read_dir(path) -> [{ name, size, type, meta }, ...]
```

Recurse into entries with `type != 0`.

### 6.2 Read a file (device → host)

```
r = vfs_open_file(path, "r")     // r.status must be 0
data = vfs_read_file(r.file_id)  // single command; response is chunked
vfs_close_file(r.file_id)
```

The whole file returns in one logical response — the chunking layer reassembles
it. Always close, including on error.

### 6.3 Write a file (host → device)

```
r = vfs_open_file(path, "w")     // r.status must be 0
offset = 0
while offset < size:
    n = min(242, size - offset)
    vfs_write_file(r.file_id, data[offset : offset+n])
    offset += n
vfs_close_file(r.file_id)
```

242 bytes per write (`WRITE_CHUNK`). Sequential, one in flight. On any write
error, still issue `vfs_close_file`.

### 6.4 Create a folder

```
vfs_create_folder(path)
```

Not recursive — create parents first, one level at a time. The handler is a
thin wrapper over the driver's `create_dir`, returning `DF_STATUS_ERR` on any
failure. Whether an already-existing folder counts as a failure is left to the
filesystem driver and is still unconfirmed on hardware.

### 6.5 Remove

`vfs_remove` first calls `stat_file`, then dispatches to `remove_dir` or
`remove_file` based on the entry type — so one command handles both. A missing
path returns `DF_STATUS_ERR`. Whether `remove_dir` succeeds on a non-empty
folder depends on the driver (LittleFS refuses; SPIFFS has no real
directories) and is still unconfirmed.

---

## 7. Notes for the sync engine

### 7.1 Deriving the root path

Build the root as `` `${drive.label}:/` ``. Reusing the official UI's
`name.substr(0, 3)` against the drive-list response produces `"Ext"` from
`"External Flash"`, which fails `validate_path`.

The failure mode is quiet: `open_dir` fails, the handler returns
`DF_STATUS_ERR`, and a client that treats an error as "empty directory" reports
a perfectly healthy device as having no files. Confirmed on hardware — a walk
from `"Ext"` returned zero entries against a drive with 966 KB in use.

### 7.2 Observed layout (Pixl.js 2.11.2, external flash)

Full read-only walk: **862 files, 44 folders, 45 `read_dir` calls, 0 errors**,
465 KB of content.

```
E:/amiibolink/          00.bin … 25.bin     AmiiboLink slot emulation
E:/amiibo/<cat>/[<sub>/] <name>.bin         browsable library, up to 3 levels
E:/amiibo/fav/          (empty)
E:/amiibo/data/         (empty)
E:/chameleon/slots/     00.bin, 01.bin, config.bin
E:/key_retail.bin       160 B — amiibo signing keys
E:/settings.bin          17 B — device settings, hidden
```

846 files are exactly 540 bytes (NTAG215) and 10 are 572; the rest are device
state, not dumps.

Findings that constrain the sync engine:

**`VFS_MAX_FOLDER_SIZE` is not a per-folder entry cap.** Two folders hold 100
entries each and listed without error. Large folders are safe.

**The path budget is the binding constraint.** The 63-byte cap covers the whole
path including the `E:/` prefix. Observed maxima: longest full path **exactly
63 bytes** (`E:/amiibo/others/Monster Hunter/Palamute _Canyne Malzeno X_.bin`),
with four files in the 60–63 range and none over. The longest *filename* is
only 39 bytes against a 47-byte cap — so paths run out of room long before
names do, and nesting is what costs you. A sync tool must validate each
destination path before transferring and report what will not fit, rather than
failing partway through a copy.

**Not everything on the drive is a dump.** `settings.bin` is device
configuration (and flagged hidden), `key_retail.bin` holds the amiibo signing
keys, and `chameleon/` is separate emulator state.

A firmware upgrade from 2.11.2 to 2.16.0 changed exactly one thing on the
drive: `settings.bin` grew from 17 to 24 bytes. Every one of the 862 dumps was
untouched. Had `settings.bin` been syncable, a `pull` taken before the upgrade
would have cached the old layout and a later `push` could have written it back
over the new one. A whole-drive `pull` would
sweep these up, and a whole-drive `push` with `--delete` could destroy them.
Sync should be scoped to a subtree such as `E:/amiibo` and treat device-managed
files as excluded by default.

**Metadata is real but rare.** Two entries out of 862 carry it, and between
them they exercise both TLV tags: `E:/chameleon/slots/00.bin` has
`notes = "Slot 01wee"`, and `E:/settings.bin` has the `hide` flag set. Both
decoded correctly, so the TLV parser is confirmed against hardware.

**The firmware does NOT sanitise filenames.** Twelve names contain `_` where
the source clearly had something else — `Mr. Game _ Watch.bin`,
`Banjo _ Kazooie.bin`, `Rosalina _ Luma.bin`, `Zelda _ Loftwing.bin` (`&`);
`Link (Majora_s Mask).bin` (`'`); `[MOD _ MAX LEVEL] Wolf Link.bin` (`/`).

That looks like device-side rewriting, but it is not. The same drive also
holds, stored literally:

| Path | Character |
|---|---|
| `E:/amiibo/Animal/Figures/13 - Timmy & Tommy.bin` | `&` |
| `E:/amiibo/Animal/Series 4/390 - O'Hare.bin` | `'` |
| `E:/amiibo/Animal/Figures/15 - Kapp'n.bin` | `'` |
| `E:/amiibo/others/Yoshi's` (folder) | `'` |

`&` and `'` survive verbatim on this device, while other files on the *same*
device have those characters replaced. A filesystem cannot be selectively
lossy — so the substitution happened in the dump packs before upload, not in
the firmware.

**Consequence: sync needs no name-mapping layer.** Compare names byte-for-byte.
(The one character that genuinely cannot appear in a name is `/`, since it is
the path separator.)

Non-ASCII survives intact — `Link (Link’s Awakening).bin` (U+2019, 29 bytes /
27 characters), `Tatsuhisa “Luke” Kamijō.bin`, `Gakuto Sōgetsu.bin`. Names are
plain UTF-8 with no transliteration, but multi-byte characters cost more against
the byte caps than their character count suggests.

### 7.2.1 Read performance

A 160-byte file took **176 ms** end to end (open + read + close, three
round-trips). At roughly 60 ms per command, hashing all 862 files to detect
changes would cost on the order of two and a half minutes. Size-first
comparison, with content hashing reserved for ambiguous cases, matters more
than it would on a faster link.

### 7.3 Change detection

- **No modification times.** `vfs_read_dir` returns name, size, type and
  metadata only. Change detection cannot use mtime on the device side.
- Consequence: the tool keeps a local state file recording, per synced path,
  the size and content hash last seen on each side. Size is the fast
  pre-filter; a content hash requires reading the file back from the device.
- Amiibo dumps are small (540 / 572 bytes), so full-tree hashing is cheap in
  bytes but costs one open/read/close round-trip per file.
- Two-way conflicts (both sides changed since last sync) cannot be resolved by
  timestamp. Default: report the conflict and skip, with
  `--prefer local|device` to force.
- `vfs_rename` exists, so detected moves can avoid a re-upload.
- The `hidden` metadata flag and `notes` are device-side state with no local
  filesystem equivalent — preserved on update, not synced, unless a sidecar
  file is introduced later.

---

## 8. Open questions

Resolved against firmware and hardware:

- ~~Meaning of non-zero `status` values~~ — binary only, `OK = 0`, `ERR = 1` (§3.3).
- ~~Open-mode flag semantics~~ — `enum vfs_mode_t`, and the field is a u32 (§5.2).
- ~~Whether more than one drive is reported~~ — up to 2, labels `I` and `E` (§5.1).
- ~~Root path format~~ — `E:/` / `I:/`, built from `label` (§4.4).
- ~~Directory type value~~ — `VFS_TYPE_REG = 0`, `VFS_TYPE_DIR = 1`.

- ~~Whether `VFS_MAX_FOLDER_SIZE` (32) caps entries per folder~~ — it does not;
  100-entry folders list fine (§7.2).
- ~~Whether `read_file` returns exactly the size `read_dir` reported~~ — yes,
  verified byte-for-byte on a 160-byte file.

- ~~Does the firmware sanitise filenames on write?~~ — no. Confirmed twice:
  by inference from the library (§7.2) and directly by writing `&`, `'`, `"`,
  `*`, `?` and `:` and reading every one back byte-for-byte (§9).
- ~~`vfs_create_folder` on an existing path~~ — returns `DF_STATUS_ERR` (§9).
- ~~`vfs_remove` on a non-empty directory~~ — **succeeds, recursively** (§9).
- ~~Can `vfs_rename` move between folders?~~ — yes (§9).
- ~~Practical throughput~~ — ~2 KB/s (§9).

Still open:

- Whether the device tolerates write-without-response, which is the obvious
  lever for improving on 2 KB/s.
- Whether a larger ATT MTU is negotiable.

---

## 9. Write semantics (verified on hardware)

Measured on Pixl.js 2.11.2 by writing to a scratch folder and reading back.

### 9.1 Filenames are stored verbatim

All five probes round-tripped byte-for-byte:

| Written | Stored exactly |
|---|---|
| `Mr. Game & Watch.bin` | yes |
| `Majora's Mask.bin` | yes |
| `Quote "X".bin` | yes |
| `Star*Q?.bin` | yes |
| `Colon:Test.bin` | yes |

Characters that are illegal on FAT (`*`, `?`, `:`, `"`) are accepted — the
underlying filesystem is not FAT. Only `/` is unavailable, being the separator.

### 9.2 Content round-trips exactly

540 bytes written and read back identical.

### 9.3 `create_folder` is not idempotent

Creating an existing folder returns `DF_STATUS_ERR`. Since status is binary
(§3.3), "already exists" is indistinguishable from a real failure.

**Implication:** list the parent with `read_dir` and create only when absent.
Do not create-and-ignore-the-error, or genuine failures pass silently.

### 9.4 `remove` deletes directories recursively

`vfs_remove` on a **non-empty** folder succeeds and takes the contents with it.
There is no "directory not empty" guard.

**Implication:** this is the most dangerous call in the protocol. A single
mistargeted `remove` can erase an entire library. A sync tool must never remove
a directory as a shortcut for removing its contents — delete files
individually, and treat directory removal as a separate, explicitly confirmed
step.

### 9.5 `rename` moves between folders

`rename("E:/a/x.bin", "E:/a/sub/moved.bin")` succeeded and the entry appeared
in the subfolder.

**Implication:** a file that moved between folders can be relocated with one
command instead of a re-upload. At 2 KB/s that is the difference between
~0.3 s and ~0.5 s for a 540-byte dump, and far more for anything larger — a
move detector keyed on content hash is worth having.

### 9.6 Throughput is ~2 KB/s

16,384 bytes took 8,010 ms — **2.00 KB/s**, about 118 ms per 242-byte chunk.
That is dominated by per-command latency, not bandwidth: each chunk is a
separate acknowledged write, and the device commits to external SPI flash
between them.

Practical consequences for a 540-byte dump (open + 3 writes + close ≈ 5
round-trips): roughly **0.5 s per file**.

| Operation | Estimate |
|---|---|
| One 540-byte dump | ~0.5 s |
| The observed 862-file library | ~7 minutes |
| Its 465 KB, data only | ~4 minutes |

**Implications:** transfer the minimum. Never re-upload unchanged files; prefer
`rename` over re-upload for moves; report progress continuously; and make a
long push resumable, since a disconnect seven minutes in should not restart
from zero.

---

## 10. Amiibo identity inside a dump

Not part of the BLE protocol, but essential for any tool that reasons about
*which amiibo* a file holds.

### 10.1 The amiibo ID is at bytes 84–91

```c
// fw/application/src/amiibo_helper.c
uint32_t head = to_little_endian_int32(&ntag->data[84]);
uint32_t tail = to_little_endian_int32(&ntag->data[88]);
const db_amiibo_t *amd = get_amiibo_by_id(head, tail);
```

The firmware also defines `AMII_ID_OFFSET 476` and writes the ID to *both* 84
and 476 when generating a tag, but in retail dumps offset 476 falls inside
encrypted data and reads as noise. Measured across 1035 real dumps: offset 84
yields a valid ID in every case, offset 476 in none.

### 10.2 Field layout

16 hex characters, e.g. `0181000100440502`:

| Bytes | Field | Notes |
|---|---|---|
| 0–1 | game / character | |
| 2 | variant | |
| 3 | figure type | `00` figure, `01` card, `02` yarn, `03` band |
| 4–5 | model number | |
| 6 | amiibo series | see below |
| 7 | constant | `0x02` in all 1035 dumps measured |

Byte 7 being invariably `0x02` makes a useful validity check when locating the
ID in a dump of unknown format.

Series byte values, derived by correlating against a verified collection:

| | | | |
|---|---|---|---|
| `00` Super Smash Bros. | `01` Super Mario | `02` Chibi-Robo | `03` Yoshi's Woolly World |
| `04` Splatoon | `05` Animal Crossing | `06` 8-bit Mario | `07` Skylanders |
| `09` Legend of Zelda | `0a` Shovel Knight | `0c` Kirby | `0d` Pokémon |
| `0e` Mario Sports Superstars | `0f` Monster Hunter Stories | `10` BoxBoy! | `11` Pikmin |
| `12` Fire Emblem | `13` Metroid | `15` Mega Man | `16` Diablo |
| `17` Power Pro Baseball | `18` Monster Hunter Rise | `19` Yu-Gi-Oh! | `1a` Donkey Kong |
| `1b` Xenoblade | `1d` Street Fighter | `21` Pragmata | |

### 10.3 Why content hashing cannot identify an amiibo

Two dumps of the same character differ in UID and save data, so they hash
differently. Measured on one collection: **1035 files, 1035 distinct SHA-256
hashes, but only 943 distinct amiibo IDs.** Byte comparison reported 92
re-dumps of characters already held as brand-new figures.

Match on the amiibo ID instead.

### 10.4 Where the ID is not enough

The ID identifies a *model*, not always a distinct figure:

- Skylanders light and dark variants share an ID and differ only in data —
  `Hammer Slam Bowser` and `Dark Hammer Slam Bowser` are both
  `0005ff00023a0702`.
- Animal Crossing Happy Home Designer item cards share a single ID
  (`026a000100000502`) across 91 distinct files.

So "same ID, different bytes" is a real and meaningful state. Report it rather
than collapsing it.

### 10.5 Dump sizes

From `ntag_def.h`, all seen in the wild:

| Bytes | Format |
|---|---|
| 540 | NTAG215, the standard full dump |
| 532 | TagMo |
| 572 | Thenaya |

532 is a truncation, so offset 84 still holds. 572 carries 32 extra bytes; the
tool tries offset 84 first and then 84 + 32, accepting whichever gives a
trailing ID byte of `0x02`.

### 10.6 v3 amiibo (NTAG I2C 2K)

Releases from Kirby Air Riders (November 2025) onward use a different tag —
**NXP NTAG I²C Plus 2K**, dumping to **2048 bytes**. The firmware already
anticipates the size as `NTAG_I2C_2K_DATA_SIZE`.

Two things break naive parsers:

**The trailing ID byte is not always `0x02`.** These carry `0x03`; it is an
amiibo *format version*, not a constant. Of the 932 database entries, 930 are
v2 and 2 are v3. A validity check of `id[7] === 0x02` silently rejects the
entire series — use the dump length instead.

**The ID is still at byte 84.** Confirmed against real dumps and against xSke's
page-level analysis, where pages `0x15`–`0x16` (= bytes 84–91) hold
`1f030100 04c91e03`. The 64 bytes of new data sit at `0x80`–`0xA0`, after the
ID, so the offset is unaffected.

#### Vehicle identity lives outside the amiibo ID

An Air Riders amiibo is two pieces: the character figure carries the tag, the
vehicle acts as its antenna. **The amiibo ID identifies the character only** —
all four vehicles for one character share an ID.

The vehicle is in the tag's SRAM buffer at pages `0xF0`–`0xFF`. Measured across
16 dumps (4 characters × 4 vehicles), files for one character differ *only*
within that range — 21–22 bytes — and the signature is identical across
characters:

| Bytes 979–984 | Byte 988 | Vehicle |
|---|---|---|
| `PB4W17` | `0x02` | Warp Star |
| `PB4W17` | `0x04` | Winged Star |
| `PB5T42` | `0x04` | Shadow Star |
| `PC6V28` | `0x04` | Tank Star |

Bytes 975–978 vary per physical tag, so they are not part of the signature.

Consequences: four dumps of one character are **not duplicates** — they are
distinct vehicle pairings sharing an ID. Any tool matching purely on amiibo ID
must report same-ID-different-bytes rather than collapsing it.

Background and credit: [AmiiboAPI issue
#243](https://github.com/N3evin/AmiiboAPI/issues/243), particularly xSke's
write-up of the memory layout and SRAM protocol.
