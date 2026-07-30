# All-in-one container formats

Two ways of shipping a whole amiibo library as a single file. Both are read;
only the first is written.

| | Flat 572 | FCA |
|---|---|---|
| Header | none | `"FCA"` + version byte |
| Record | fixed 572 bytes | length-prefixed entry |
| Identifies a record | position only | a type byte per entry |
| Air Riders vehicles | **cannot carry them** | yes, whole 2048-byte dump |
| This app | reads and writes | reads only |

---

## Flat 572-byte records

Not documented anywhere public. Reverse engineered from two real files
(949 records in total) produced by the Ally app; the notes below are what was
measured, not a specification anyone published.

A flat run of fixed-size records. No header, no index, no name table, no
checksum, no version field. `length % 572 == 0`.

```
record[0x000 .. 0x21B]   540 bytes  NTAG215 image (pages 0..134)
record[0x21C .. 0x23B]    32 bytes  0xFF padding
                         572 bytes  total, repeated to end of file
```

572 is a size the firmware already recognises (`DUMP_SIZES` calls it Thenaya),
so each record is an ordinary dump and its amiibo ID reads at byte 84 as usual.
The same 540 + 32 shape is what Amiibitz writes for a single dump, where the
standing advice is to strip the last 32 bytes before writing to an NTAG215.

Measured across both files:

- every record passes the amiibo structural checks (`0xA5` magic at `0x10`,
  capability container `F1 10 FF EE` at `0x0C`)
- the padding is 32 × `0xFF` in all 949, with no other variant
- a 943-record file was sorted ascending by amiibo ID from record 1 on, with one
  late arrival prepended out of order, so ordering is a convention rather than
  something to rely on
- 942 of those 943 were 532-byte dumps zero-extended to 540 (password and PACK
  zeroed, dynamic lock `0F BD`)

### Two things learned the hard way

**The UID check bytes are not safe to validate.** They hold for NTAG215, but a
Kirby Air Riders tag is NTAG I2C 2K with a different serial layout, and its
first nine bytes do not satisfy the NTAG21x formula. Testing them made this app
unable to read back a file it had just written: four such records in a
1037-record file were enough to reject the whole thing.

**So records are normalised on the way in.** Packing recomputes BCC0 and BCC1 so
every record is a well-formed NTAG215 image, which is what the Ally files
themselves contain — their Air Riders entries are re-generated NTAG215 tags with
fresh UIDs rather than truncated I2C dumps. Nothing is given up by this: the
vehicle is already lost the moment a 2048-byte dump becomes a 540-byte record.

### What this format cannot do

A record holds 540 bytes and an Air Riders vehicle lives at byte 979, past the
end. All four vehicle pairings of a character collapse into one vehicle-less
entry. A 2048-byte dump on disk is strictly better than any copy of it in one of
these files.

---

## FCA

A real archive rather than a bare run of records, and the format to prefer where
there is a choice: its type-2 entries carry whole 2048-byte v3 dumps, vehicles
included.

Specification and reference implementation by **fishybow**, MIT licensed:
<https://github.com/fishybow/fca> ([SPEC.md](https://github.com/fishybow/fca/blob/main/SPEC.md)).
The layout below is quoted from that specification. All multi-byte integers are
big-endian.

```
Global header
  Offset  Size  Description
  0       3     Magic bytes: "FCA" (ASCII)
  3       1     Version number (unsigned byte, 0-255)

Then N embedded files, N >= 0, each
  Offset  Size  Description
  0       4     Total size (big-endian) — the bytes following this field
  4       2     Header size (big-endian), H
  6       H     Header bytes, laid out by version
  6+H     E     Embedded file bytes, E = total size - 2 - H

Version 1 header
  Offset  Size  Description
  0       1     File type (unsigned byte)
  1       1     Reserved (unsigned byte)
```

File types:

| Value | Type | Description |
|---|---|---|
| 0 | Unknown | Unknown or unspecified |
| 1 | Amiibo v2 | Most amiibo since the beginning |
| 2 | Amiibo v3 | I2C 2K Plus, e.g. Kirby Air Riders |
| 3 | Skylander | Skylander dumps |
| 4 | Destiny Infinity | Destiny Infinity dumps |
| 5 | Lego Dimensions | Lego Dimensions dumps |
| 6-255 | Reserved | |

Types 1 and 2 are unpacked. **Type 0 is opened too**, because the specification
calls it "unknown or unspecified" and notes that a default implementation writes
`0x00` for both header bytes, so a lax packer can label a real dump this way.
Nothing is risked by trying: the payload still has to parse as a dump. Anything
else is reported and passed over rather than guessed at, so a Skylanders archive
is recognised as not this app's business instead of being torn apart.

Detection requires the magic bytes, entries that tile the file exactly with
nothing left over, and at least one entry that is an amiibo. The tiling check is
what makes it safe: a file that merely happens to begin with `FCA` will not
survive the walk.

**Reading only.** Nothing here writes FCA. `PACK FOLDER` and `PACK DEVICE`
produce the flat format, which is what the tooling around these devices expects.

### Measured against real archives

Four Flashiibo exports, all version 1 with 2-byte headers, confirm the layout
above and are pinned in `test/fca.test.mjs`:

| Archive | Entries | Read | Notes |
|---|---|---|---|
| `only ac.fca` | 525 | 525 | all type 1, 540 bytes each |
| `all others.fca` | 417 | 416 | one type-0 entry skipped |
| `all except air riders.fca` | 942 | 941 | one type-0 entry skipped |
| `only air riders.fca` | 16 | 16 | all type 2, **2048 bytes each** |

Two things the real files settled that the specification could not:

- **Vehicles do survive.** `only air riders.fca` is 4 characters × 4 vehicles,
  every entry a whole 2048-byte dump, and all four vehicle names decode. This is
  the concrete reason to prefer FCA over the flat format.
- **The type-0 entry is a README**, not an amiibo: 253 bytes of advice about
  registering Wolf Link before using it in Breath of the Wild. It is skipped on
  length, which is exactly why opening type 0 is safe.

---

## Where this lives in the code

| File | Role |
|---|---|
| [`web/js/bundle.js`](web/js/bundle.js) | flat format: detect, split, pack, normalise |
| [`web/js/fca.js`](web/js/fca.js) | FCA: detect, split |
| [`web/js/bundlesource.js`](web/js/bundlesource.js) | unpack either into the local index, gap-fill |
| [`test/bundle.test.mjs`](test/bundle.test.mjs), [`test/fca.test.mjs`](test/fca.test.mjs) | both |
