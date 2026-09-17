# Release plan: 1.0.4

Hop Star, Mineru's Construct, and the progress percentage fixes already on `main`.

## Hop Star

**The problem.** In the Hop Star dumps checked so far, Hop Star has the same signature as Tank Star: `PC6V28` at bytes 979 to 984, and `04` at byte 988. The app reads every Hop dump as Tank Star, and a rider's Hop and Tank dumps probably land on the same `KAR/<Name> (Tank).bin` path.

**What we know.** Hop and Tank differ only at:
- bytes 962 to 976
- byte 978: Hop `05`, Tank `09`
- bytes 1022 to 1023, which look like a checksum

xSke posted a second physical Warp Star in [AmiiboAPI#243](https://github.com/N3evin/AmiiboAPI/issues/243). Its bytes 962 to 976 differ from the Warp Star dumps checked here, while byte 978 (`01`) matches. So 962 to 976 is per tag, and byte 978 is probably the vehicle. That's one sample per vehicle, so it isn't proven.

Byte 978 by vehicle, in the dumps checked so far:

| Vehicle | Bytes 979-984 | Byte 988 | Byte 978 |
|---|---|---|---|
| Warp Star | `PB4W17` | `02` | `01` |
| Winged Star | `PB4W17` | `04` | `07` |
| Shadow Star | `PB5T42` | `04` | `05` |
| Tank Star | `PC6V28` | `04` | `09` |
| Hop Star | `PC6V28` | `04` | `05` |

**Get a second sample.** Dump a second physical Hop Star, seated on its rider, as a full 2048-byte file that includes the vehicle SRAM at bytes 960 to 1023. A second Tank Star helps too. Compare bytes 960 to 1023 against the table above.

**Decide from the result.**
- **Byte 978 is `05` and bytes 962 to 976 differ:** byte 978 identifies the vehicle. Match Hop Star on `PC6V28` plus byte 978.
- **Bytes 962 to 976 match as well:** that block is fixed per vehicle, and matching on it is safe too.
- **The signature isn't `PC6V28`:** one of the dumps is wrong, and the first sample needs another look.

**Code and docs to change.**
- `web/js/amiibo.js`: `VEHICLE_SIGNATURES` and how the signature is read. Update the comment above `KNOWN_VEHICLES`, which says Hop Star isn't there yet.
- `tools/fetch-amiibo-images.mjs`: add `hop-star` to `VEHICLE_SLUGS`, if Nintendo has the render at the same URL pattern.
- `PROTOCOL.md`: the vehicle table, and the line saying bytes 975 to 978 all vary per tag.
- `README.md`: "four machines" and the `n/4` tally in "Vehicles and card sets".
- Tests that list the four vehicles: `test/amiibo.test.mjs`, `test/amiibopanel.test.mjs`, `test/fca.test.mjs`, `test/bundle.test.mjs`.
- Check that `KAR/<Name> (Hop).bin` fits the 63-byte path limit for the longest rider name.

**Collision guard.** Whatever the signature turns out to be, make sure two different dumps that read as the same vehicle can't be given the same path.

## Mineru's Construct

Released 2026-09-17, but not in the upstream database yet (8bitDream AmiiboAPI).

1. `npm run update-db -- --dry-run` and check it shows up. Review any renames it also flags.
2. `npm run update-db`.

## Release

1. Add a 1.0.4 entry at the top of `RELEASES` in `web/data/changelog.js`:
   - Hop Star recognised.
   - Mineru's Construct added.
   - The collision fix, if it shipped.
   - Remove the 1.0.3 note that Hop Star isn't recognised.
   - Under `fixed`: the collection bar read 100% with amiibo still missing, and 0% with one owned. SYNCED read 100% with a file still to move (commits `ee67a2e`, `08ac4af`).
   - Under `changed`: collection and SYNCED percentages show one decimal, so 0.1% and 99.9% sit next to the ends.
2. `npm run build-changelog`.
3. Bump the version in `README.md` ("Currently **1.0.4**"), `package.json` and `package-lock.json`. Update the README counts.
4. `npm test`.
5. Commit and push after review.
