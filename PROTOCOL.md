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
against hardware running **Pixl.js 2.11.2**.

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

### 7.2 Change detection

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

Still open:

- Behaviour of `vfs_create_folder` on an existing path.
- Whether `vfs_remove` succeeds on a non-empty directory.
- Whether `VFS_MAX_FOLDER_SIZE` (32) is a hard cap on entries per folder, and
  what happens on overflow.
- Maximum practical throughput, and whether the device tolerates
  write-without-response.
- Whether `vfs_rename` can move an entry between folders or only rename in
  place.
