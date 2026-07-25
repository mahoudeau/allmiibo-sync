# Allmiibo / PIXL BLE VFS Protocol

Reverse-engineered from the official Web Bluetooth clients:

- `https://bt.allmiibo.com/` — Vue app, bundle `/js/app.5be9472d.js`
- `https://pixl.amiibo.xyz/` — bundle `/index.js?815c0d29c8e2d63e8fcc`

Both clients speak the **identical** wire protocol. The PIXL bundle additionally
implements `vfs_read_file` (opcode 20), which the allmiibo page never calls —
this is the missing half that makes device→local sync possible.

Everything below is derived from reading those bundles. Items marked
**[unverified]** have not yet been confirmed against real hardware.

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

`status == 0` means success; any non-zero value is an error. The client only
ever checks `!= 0`, so specific error codes are **[unverified]**.

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

### 4.4 Path constraints

Enforced client-side before sending:

- Full path: **≤ 63 bytes**
- Final path component (filename): **≤ 47 bytes**

Paths are drive-prefixed, e.g. `0:/folder/file.bin`; the drive `label` is a
single ASCII character and the UI builds the root as `name.substr(0, 3)`.

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
u8     status
u8     label        // single ASCII char, e.g. '0'
string name
u32    total_size
u32    used_size
```

The client reads at most one entry even when `count > 1`.

### 5.2 Open modes

`vfs_open_file` mode byte, exactly as the client sends it:

| Mode | Byte |
|---|---|
| `"r"` (read) | `8` (0x08) |
| `"w"` (write) | `22` (0x16) |

These look like FatFs-style flag bits but the mapping is **[unverified]**;
send the literal values above.

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

Not recursive — create parents first, one level at a time. **[unverified]**
whether creating an existing folder returns non-zero status.

---

## 7. Notes for the sync engine

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

- Meaning of non-zero `status` values.
- Behaviour of `vfs_create_folder` on an existing path.
- Whether `vfs_remove` works on non-empty directories.
- Maximum practical throughput and whether the device tolerates
  write-without-response.
- Whether more than one drive is ever reported.
