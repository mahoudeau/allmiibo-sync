// Recapture the detail-page snapshots.
//
// test/amiibodetail-page.test.mjs compares three rendered pages against a
// committed fixture. That fixture pins the RENDERED OUTPUT, which depends on
// both the code and the database — so curating a series or amiibo name in the
// admin legitimately changes it, and the test will say so.
//
// This is how you accept such a change, after reading what actually moved:
//
//   npm test                 # see the diff and understand it
//   npm run snapshots        # accept it
//   git diff test/fixtures   # confirm only what you expected changed
//
// It is deliberately a separate command rather than an env flag on the test
// run: a snapshot that updates itself as a side effect of running the suite is
// not a snapshot, and this is the one file in the project whose whole value is
// that it refuses to change quietly.

import { register } from 'node:module';
import { writeFileSync } from 'node:fs';

register('../test/helpers/loader.mjs', import.meta.url);

const { mountPage } = await import('../test/helpers/dom.mjs');
const { HHD_CARDS } = await import('../web/data/hhd-cards.js');

const MARIO = '0000000000000002';
const KIRBY = '1f00000004c41e03';
const HHD = '026a000100000002';

/** A scan cache shaped as collectionui.js's saveScanCache writes it. */
const cache = (o) => JSON.stringify({
  localIds: o.local ?? [],
  deviceIds: o.device ?? null,
  namesById: o.names ?? [],
  vehiclesById: o.vehicles ?? [],
  hhdLocalUids: o.hhdLocal ?? [],
  hhdDeviceUids: o.hhdDevice ?? [],
});

// The same three fixtures the test renders, with the same inputs.
const FIXTURES = [
  ['mario', MARIO, cache({
    local: [MARIO], device: [MARIO],
    names: [[MARIO, ['Mario.bin', 'mario-copy.bin']]],
  })],
  ['kirby', KIRBY, cache({
    local: [KIRBY],
    vehicles: [[KIRBY, [['Warp Star', { local: true }], ['Winged Star', { local: false }]]]],
  })],
  ['hhd', HHD, cache({
    local: [HHD],
    hhdLocal: HHD_CARDS.slice(0, 3).map((c) => c.uid),
    hhdDevice: [HHD_CARDS[0].uid],
  })],
];

const out = {};
let n = 0;
for (const [name, id, scan] of FIXTURES) {
  const storage = { collectionScan: scan };
  const page = mountPage('web/amiibo.html', {
    url: `http://localhost/amiibo.html?id=${id}`,
    storage,
  });
  globalThis.sessionStorage = {
    getItem: (k) => storage[k] ?? null,
    setItem() {},
    removeItem() {},
  };
  // Cache-busted: the module does all its work at import time.
  await import(`../web/js/amiibodetail.js?snapshot=${n++}`);
  out[name] = { title: globalThis.document.title, content: page.byId('content').innerHTML };
  page.restore();
}

const path = new URL('../test/fixtures/amiibodetail-snapshots.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);

for (const [name, v] of Object.entries(out)) {
  console.log(`${name.padEnd(6)} ${String(v.content.length).padStart(6)} bytes  ${v.title}`);
}
console.log('\nWritten. Check `git diff test/fixtures` before committing.');
