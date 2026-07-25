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

- **Protocol** — fully reverse-engineered and documented. ✅
- **Client library** — implemented, with 15 tests against a simulated device. ✅
- **Read-only hardware probe** — ready to run, pending verification on a device.
- **Sync engine** — not started.

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

## Tests

```sh
npm test
```

Runs against a simulated device using `node:test`. Covers request framing,
multi-notification reassembly, command serialisation, chunked file writes,
error-status propagation, path/notes limits, and disconnect handling.

## Planned usage

```sh
allmiibo-sync push ./my-amiibo        # local is master
allmiibo-sync pull ./my-amiibo        # device is master
allmiibo-sync sync ./my-amiibo        # two-way, reconciled against sync state
allmiibo-sync push ./my-amiibo --dry-run --delete
```

- `--dry-run` prints the full plan without touching either side.
- `--delete` propagates deletions; off by default.
- Re-running with no changes transfers nothing.

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
PROTOCOL.md            reverse-engineered wire protocol
serve.mjs              zero-dependency static server (Node built-ins only)
web/index.html         probe UI, styles inline
web/js/bytes.js        little-endian codecs, string and metadata TLV
web/js/ble.js          Web Bluetooth transport (Nordic UART Service)
web/js/protocol.js     framing, reassembly, command queue, VFS commands
web/js/probe.js        read-only probe UI logic
test/protocol.test.mjs protocol tests against a simulated device
```

## Compatibility

Protocol verified identical across the Allmiibo and PIXL web clients. Tested
against hardware: *(pending)*.

## Disclaimer

Unofficial. Not affiliated with Allmiibo, PIXL, or Nintendo. Reverse-engineered
from publicly served JavaScript for interoperability with hardware the author
owns.
