# allmiibo-sync

Folder sync for Allmiibo / PIXL NFC emulator devices over Bluetooth LE.

The stock web tools (`bt.allmiibo.com`, `pixl.amiibo.xyz`) only support manual,
one-file-at-a-time transfers and hand-made folders. This project keeps a local
directory tree — subfolders and all — in sync with the device, with explicit
control over which side is authoritative.

## Status

Early. The BLE protocol has been fully reverse-engineered from the official web
clients and is documented in [PROTOCOL.md](PROTOCOL.md). Implementation has not
started yet.

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

The device reports no modification times, so change detection uses file size
plus a content hash recorded in a local sync-state file. See
[PROTOCOL.md](PROTOCOL.md) for the full wire format and the open questions still
to be confirmed against hardware.

## Compatibility

Verified protocol-identical across the Allmiibo and PIXL web clients. Tested
against: *(nothing yet — hardware verification pending)*.

## Disclaimer

Unofficial. Not affiliated with Allmiibo, PIXL, or Nintendo. Reverse-engineered
from publicly served JavaScript for interoperability with hardware the author
owns.
