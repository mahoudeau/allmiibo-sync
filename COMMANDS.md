# Commands

Everything runs on Node built-ins — no `npm install`, there are no dependencies.
Run all commands from the repository root.

## Day to day

```sh
npm run serve                # start the local server on http://localhost:8080
node serve.mjs 9000          # same, on another port
```

Web Bluetooth requires a secure context, so the pages must be opened via
`http://localhost` — opening the HTML files directly (`file://`) will not work.
Use Chrome or Edge, and close any other tab connected to the device first: it
accepts one BLE connection at a time.

| Page | What it does |
|---|---|
| <http://localhost:8080/> | 8-bit title screen — leads into collection and sync |
| <http://localhost:8080/collection.html> | the app: collection tracker + everyday sync (scan folder/device, send/download selections, two-way sync) |
| <http://localhost:8080/sync.html> | Advanced sync: every operation and option (backup, replace, match, check) |
| <http://localhost:8080/help.html> | how-to: every feature explained |
| <http://localhost:8080/debug.html> | device internals: read-only probe + sandboxed write test |
| <http://localhost:8080/design-lab.html> | the design moodboard the NES skin was chosen from (not deployed) |

The Debug page is reached from header → Settings → DEBUG TOOLS (the old
probe.html / write-test.html URLs redirect there). The **Advanced** toggle in
Settings reveals extra options on the collection and sync pages.

## Tests

```sh
npm test                     # full suite (protocol, planner, amiibo, UI checks)
node --test test/planner.test.mjs        # one file
node --test --test-name-pattern="replace"   # tests matching a name
```

No hardware needed — protocol tests run against a simulated device.

## Updating the amiibo database (dev-time only; the site never fetches)

```sh
npm run update-db            # fetch upstream sources, regenerate, report the
                             # diff, fetch artwork for anything new
npm run update-db -- --no-images   # same, without the artwork pass
```

Sources: `solosky/pixl.js` `db_amiibo.c` (names) and `8bitDream/AmiiboAPI (fork of N3evin/AmiiboAPI)`
`amiibo.json` (series and type labels). The command prints exactly what was
added, renamed or removed. Afterwards:

```sh
git diff web/data/amiibo-db.js   # review what changed
npm test                         # make sure nothing regressed
git commit ...                   # commit the reviewed database
```

Downloaded sources land in `tools/.cache/` (gitignored).

## Artwork

```sh
npm run fetch-images                     # download missing artwork + thumbnails
npm run fetch-images -- <id16> <id16>    # also try extra amiibo IDs
```

Images come from the AmiiboAPI repository, keyed by the 16-hex amiibo ID, into
three tiers: `web/data/images/full/`, 256 px `med/` for Retina-sharp lists and
96 px thumbnails in `thumb/`. The same run fetches the four Air Riders vehicle
renders into `web/data/images/vehicles/`. All of it is **gitignored** — it is
Nintendo's artwork, cached locally, never committed. Already-downloaded files
are skipped, so re-runs are cheap. A 404 for a new amiibo just means no
artwork upstream yet; the page shows a placeholder.

Requires macOS (`sips` generates the thumbnails).

## Regenerating the database by hand

Normally `update-db` does this. To run the generator against files you already
have:

```sh
node tools/build-amiibo-db.mjs path/to/db_amiibo.c path/to/amiibo.json
```

Writes `web/data/amiibo-db.js`.

## Useful one-offs

```sh
# What would be committed? (dumps and artwork must never appear here)
git status --short

# Why is a file ignored / not ignored?
git check-ignore -v Allmiibo/some/file.bin

# Count dumps and distinct amiibos in a local folder
node --input-type=module -e "
import { parseAmiiboId } from './web/js/amiibo.js';
import fs from 'node:fs'; import path from 'node:path';
const ids=new Set(); let n=0;
(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
  if(e.isDirectory())w(p); else if(e.name.toLowerCase().endsWith('.bin')){n++;
    const id=parseAmiiboId(fs.readFileSync(p)); if(id)ids.add(id);}}})('Allmiibo');
console.log(n,'dumps,',ids.size,'distinct amiibos');"

# Identify one dump
node --input-type=module -e "
import { parseAmiiboId, describeAmiibo, parseVehicle } from './web/js/amiibo.js';
import fs from 'node:fs';
const b=fs.readFileSync(process.argv[1]);
const id=parseAmiiboId(b);
console.log(JSON.stringify({...describeAmiibo(id), vehicle:parseVehicle(b)},null,2));
" 'Allmiibo/loz/botw/mipha.bin'
```

## Where things live

| Path | Contents | Committed? |
|---|---|---|
| `web/data/amiibo-db.js` | generated ID→name/series/type database | yes — review diffs |
| `web/data/images/` | artwork cache + thumbnails | no (gitignored) |
| `tools/.cache/` | downloaded upstream sources | no (gitignored) |
| `.allmiibo-sync.json` | per-folder sync state, written next to your dumps | no (gitignored) |
| local dump folders (`Amiibo/`, `Allmiibo/`, …) | your library | no (gitignored) |

## Troubleshooting

- **"Web Bluetooth unavailable"** — use Chrome or Edge via `http://localhost`,
  not Safari and not `file://`.
- **Device won't connect** — close every other tab or app holding a connection
  (including the official web tools); the device accepts exactly one.
- **A run failed midway** — use **RUN LOG drawer (SAVE JSON)** on the sync page and read the
  JSON: every operation is recorded with timing, outcome, and the command and
  status behind any device refusal.
- **Everything shows as an upload after choosing a folder** — the device root
  and local folder are probably offset by one level (e.g. local folder
  *contains* `amiibo/` while the device root is already `E:/amiibo`); the plan
  header warns when the two sides share no paths.
