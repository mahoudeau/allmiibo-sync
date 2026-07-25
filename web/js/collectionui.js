// Collection view: every amiibo in the vendored database, grouped by series,
// marked with whether you hold a dump of it locally and (optionally) whether
// it is on the device.

import { BleTransport } from './ble.js';
import { AllmiiboClient } from './protocol.js';
import { walkDevice, hashDeviceIndex } from './sync.js';
import { buildCollection, describeAmiibo, DUMP_SIZES, KNOWN_VEHICLES, hasVehicles } from './amiibo.js';
import { isExcluded } from './planner.js';
import * as localfs from './localfs.js';

const els = {};
for (const id of [
  'pickFolder', 'scan', 'connect', 'scanDevice', 'stop', 'folderName',
  'status', 'progress', 'stats', 'series', 'overview', 'skipped', 'search', 'copyMissing',
  'mOwned', 'mMissing', 'mDevice', 'mExtra', 'mTotal',
]) els[id] = document.getElementById(id);

let rootHandle = null;
let transport = null;
let client = null;
let localIds = new Set();
let filesById = new Map(); // how many dumps you hold per amiibo
// v3 amiibo carry a vehicle that is not part of the amiibo ID, so one ID can
// stand for several distinct products. Tracked separately per side.
let vehiclesById = new Map(); // id -> Map<vehicle, {local:bool, device:bool}>
let namesById = new Map();    // id -> filenames you gave its dumps
let deviceIds = null;
let collection = null;
let stopRequested = false;

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function refresh() {
  els.scan.disabled = !rootHandle;
  els.scanDevice.disabled = !(transport?.connected && rootHandle);
}

// ---- sources ------------------------------------------------------------

els.pickFolder.addEventListener('click', async () => {
  try {
    rootHandle = await localfs.pickDirectory();
    els.folderName.textContent = rootHandle.name;
    refresh();
    els.scan.click();
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(err.message, 'err');
  }
});

els.scan.addEventListener('click', async () => {
  els.scan.disabled = true;
  try {
    setStatus('Reading dumps…');
    const index = await localfs.walkLocal(rootHandle, {
      onProgress: (n) => { if (n % 100 === 0) setStatus(`Reading dumps… ${n}`); },
    });

    localIds = new Set();
    filesById = new Map();
    namesById = new Map();
    for (const v of vehiclesById.values()) for (const e of v.values()) e.local = false;
    let files = 0;
    let folders = 0;
    let dumps = 0;
    const ignored = [];
    const unrecognised = [];

    for (const [relPath, e] of index) {
      if (e.isDir) {
        folders++;
        continue;
      }
      files++;
      if (e.amiiboId) {
        dumps++;
        localIds.add(e.amiiboId);
        filesById.set(e.amiiboId, (filesById.get(e.amiiboId) ?? 0) + 1);
        if (e.vehicle) markVehicle(e.amiiboId, e.vehicle, 'local');
        if (!namesById.has(e.amiiboId)) namesById.set(e.amiiboId, []);
        namesById.get(e.amiiboId).push(relPath.slice(relPath.lastIndexOf('/') + 1));
      } else if (isExcluded(relPath)) {
        ignored.push({ relPath, size: e.size });
      } else {
        unrecognised.push({ relPath, size: e.size });
      }
    }

    render();
    renderSkipped(ignored, unrecognised);
    setStatus(
      `${dumps} dumps in ${folders} folders — ${localIds.size} distinct amiibos` +
        (unrecognised.length ? `, ${unrecognised.length} file(s) not recognised` : '') +
        (ignored.length ? `, ${ignored.length} system file(s) ignored` : ''),
      'ok'
    );
  } catch (err) {
    setStatus(err.message, 'err');
  }
  refresh();
});

els.connect.addEventListener('click', async () => {
  try {
    setStatus('Requesting device…');
    transport = new BleTransport();
    client = new AllmiiboClient(transport, { log: () => {} });
    transport.addEventListener('disconnected', () => { setStatus('Device disconnected', 'warn'); refresh(); });
    const name = await transport.connect();
    setStatus(`Connected: ${name}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
  refresh();
});

els.scanDevice.addEventListener('click', async () => {
  els.scanDevice.disabled = true;
  els.stop.disabled = false;
  stopRequested = false;

  try {
    setStatus('Listing device…');
    let index = await walkDevice(client, 'E:/', {
      onProgress: (n) => { if (n % 50 === 0) setStatus(`Listing device… ${n} files`); },
    });

    const total = [...index.values()].filter((e) => !e.isDir).length;
    setStatus(`Reading ${total} device files — this takes a few minutes`);

    const t0 = Date.now();
    index = await hashDeviceIndex(client, 'E:/', index, {
      shouldStop: () => stopRequested,
      onProgress: (done, n) => {
        els.progress.value = (done / n) * 100;
        if (done % 10 === 0 || done === n) {
          const rate = done / Math.max(1, (Date.now() - t0) / 1000);
          const left = Math.round((n - done) / Math.max(rate, 0.01));
          setStatus(`Reading device ${done}/${n} — about ${left > 90 ? `${Math.round(left / 60)} min` : `${left}s`} left`);
        }
      },
    });
    els.progress.value = 0;

    deviceIds = new Set();
    for (const v of vehiclesById.values()) for (const e of v.values()) e.device = false;
    for (const e of index.values()) {
      if (e.isDir || !e.amiiboId) continue;
      deviceIds.add(e.amiiboId);
      if (e.vehicle) markVehicle(e.amiiboId, e.vehicle, 'device');
    }

    render();
    setStatus(
      stopRequested
        ? `Stopped early — ${deviceIds.size} amiibos identified on the device so far`
        : `Device holds ${deviceIds.size} distinct amiibos`,
      stopRequested ? 'warn' : 'ok'
    );
  } catch (err) {
    setStatus(err.message, 'err');
  }
  els.stop.disabled = true;
  refresh();
});

els.stop.addEventListener('click', () => { stopRequested = true; });

function markVehicle(id, vehicle, side) {
  if (!vehiclesById.has(id)) vehiclesById.set(id, new Map());
  const forId = vehiclesById.get(id);
  if (!forId.has(vehicle)) forId.set(vehicle, { local: false, device: false });
  forId.get(vehicle)[side] = true;
}

// ---- rendering ----------------------------------------------------------

// Turn the filenames you gave a group of dumps into one label. With several
// dumps under one ID their shared prefix is the useful part: 91 files called
// "hhd items 01.bin" … "hhd items 91.bin" yield "hhd items".
function labelFromFilenames(names) {
  const clean = names
    .map((n) => n.replace(/\.bin$/i, '').replace(/^\[[^\]]*\]\s*/, '').replace(/^\d+\s*-\s*/, '').trim())
    .filter(Boolean);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];

  let prefix = clean[0];
  for (const n of clean.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < n.length && prefix[i].toLowerCase() === n[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  prefix = prefix.replace(/[\s\-_#.]*\d*$/, '').trim();
  return prefix.length >= 3 ? prefix : clean[0];
}

function render() {
  const nameHints = new Map();
  for (const [id, names] of namesById) {
    const label = labelFromFilenames(names);
    if (label) nameHints.set(id, label);
  }
  collection = buildCollection(localIds, deviceIds, { nameHints, dumpCounts: filesById });
  const s = collection.stats;

  els.stats.hidden = false;
  els.mOwned.textContent = `${s.ownedKnown} / ${s.knownTotal}`;
  els.mMissing.textContent = s.missingLocal;
  els.mDevice.textContent = s.ownedDevice ?? '–';
  els.mExtra.textContent = s.notInDatabase;
  els.mTotal.textContent = s.ownedLocal;

  renderOverview();
  paint();
}

// One chip per series: completion at a glance, and a shortcut into it.
function renderOverview() {
  els.overview.textContent = '';
  els.overview.hidden = false;

  for (const group of collection.series) {
    const known = group.items.filter((i) => i.inDatabase).length;
    const owned = group.items.filter((i) => i.hasLocal && i.inDatabase).length;
    const complete = known > 0 && owned === known;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `sChip${complete ? ' done' : known ? ' part' : ''}`;
    chip.title = complete
      ? `${group.seriesName} — complete`
      : `${group.seriesName} — ${known - owned} missing`;

    const nm = document.createElement('span');
    nm.textContent = group.seriesName;
    const n = document.createElement('b');
    n.textContent = known ? `${owned}/${known}` : `${group.ownedLocal}`;
    chip.append(nm, n);

    // Jump to the series and open it.
    chip.addEventListener('click', () => {
      const target = [...els.series.querySelectorAll('details')].find(
        (d) => d.querySelector('summary span')?.textContent === group.seriesName
      );
      if (!target) return;
      target.open = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    els.overview.append(chip);
  }
}

// Files that are not amiibo dumps, split into harmless system clutter and
// anything genuinely unexpected — the latter is worth seeing.
function renderSkipped(ignored, unrecognised) {
  els.skipped.textContent = '';
  if (!ignored.length && !unrecognised.length) {
    els.skipped.hidden = true;
    return;
  }
  els.skipped.hidden = false;

  const block = (title, items, note) => {
    if (!items.length) return;
    const d = document.createElement('details');
    const sm = document.createElement('summary');
    sm.textContent = `${title} (${items.length})`;
    d.append(sm);
    const pre = document.createElement('pre');
    pre.textContent =
      (note ? `${note}\n\n` : '') +
      items.map((i) => `${String(i.size).padStart(8)} B  ${i.relPath}`).join('\n');
    d.append(pre);
    els.skipped.append(d);
  };

  block(
    'Not recognised as amiibo dumps',
    unrecognised,
    `Recognised dump sizes: ${Object.entries(DUMP_SIZES).map(([n, l]) => `${n} (${l})`).join(', ')}.`
  );
  block('System files, ignored by sync too', ignored);
}

function currentFilter() {
  return document.querySelector('input[name=filter]:checked').value;
}

function paint() {
  if (!collection) return;
  const filter = currentFilter();
  const q = els.search.value.trim().toLowerCase();

  const keep = (item) => {
    if (filter === 'owned' && !item.hasLocal) return false;
    if (filter === 'missing' && item.hasLocal) return false;
    if (filter === 'notondevice' && (item.hasDevice !== false)) return false;
    if (q && !item.name.toLowerCase().includes(q) && !item.id.includes(q)) return false;
    return true;
  };

  els.series.textContent = '';
  let shown = 0;

  for (const group of collection.series) {
    const items = group.items.filter(keep);
    if (!items.length) continue;
    shown += items.length;

    const details = document.createElement('details');
    details.open = filter !== 'all' || !!q;

    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = group.seriesName;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent =
      group.ownedDevice === null
        ? `${group.ownedLocal} / ${group.total}`
        : `${group.ownedLocal} / ${group.total} local · ${group.ownedDevice} on device`;
    summary.append(label, count);
    details.append(summary);

    const box = document.createElement('div');
    box.className = 'items';
    for (const item of items) {
      // A v3 amiibo is a character plus a vehicle, and only the character is
      // in the amiibo ID. You own each pairing separately, so list them
      // separately — while completion against the database stays per
      // character, which is all the database records.
      box.append(makeRow(item, item.name, item.hasLocal, item.hasDevice));
    }
    details.append(box);
    els.series.append(details);
  }

  if (!shown) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = 'Nothing matches that filter.';
    els.series.append(p);
  }

  function makeRow(item, label, hasLocal, hasDevice) {
    const row = document.createElement('div');
    row.className = `item${hasLocal ? '' : ' missing'}`;
    row.title = `${item.id}  ${item.typeName}`;

    const dot = document.createElement('span');
    dot.className = 'dot';

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = label;

    row.append(dot, nm);

    if (hasDevice) {
      const t = document.createElement('span');
      t.className = 'tag dev';
      t.textContent = 'device';
      row.append(t);
    }
    if (!item.inDatabase) {
      const t = document.createElement('span');
      t.className = 'tag new';
      t.textContent = 'unlisted';
      t.title = 'Not in the amiibo database — newer than it, most likely';
      row.append(t);
    }
    // Where the name came from. Anything but the database is a guess and says
    // so: filenames can have been written by anyone, and the character-head
    // heuristic misreads the Animal Crossing item cards as Stinky.
    if (item.nameSource === 'filename' || item.nameSource === 'inferred') {
      const t = document.createElement('span');
      t.className = 'tag guess';
      t.textContent = item.nameSource === 'filename' ? 'from filename' : 'guessed';
      t.title =
        item.nameSource === 'filename'
          ? `Taken from your filenames, not the database — ${item.id}`
          : `Guessed from the character in the ID, which can be wrong — ${item.id}`;
      row.append(t);
    }
    // Several dumps can share one amiibo ID even without vehicles — the 91
    // Animal Crossing item cards do. Show the count so the totals add up.
    // Vehicle rows are one dump each, so it is only useful on a plain row.
    const held = filesById.get(item.id) ?? 0;
    if (held > 1 && label === item.name) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = `×${held} dumps`;
      row.append(t);
    }

    const ty = document.createElement('span');
    ty.className = 'tag';
    ty.textContent = item.typeName;
    row.append(ty);

    if (!hasVehicles(item.id)) return row;

    // An Air Riders amiibo is a character plus a vehicle, and only the
    // character is in the amiibo ID. Keep one row per character — that is what
    // completion is measured against — and show the whole vehicle line-up
    // beneath it, since every character takes every vehicle.
    const owned = vehiclesById.get(item.id) ?? new Map();
    const all = [...new Set([...KNOWN_VEHICLES, ...owned.keys()])].sort();

    const wrap = document.createElement('div');
    wrap.className = 'withVehicles';

    const tally = document.createElement('span');
    tally.className = 'tag';
    tally.textContent = `${[...owned.values()].filter((w) => w.local).length} / ${all.length} vehicles`;
    row.append(tally);
    wrap.append(row);

    const chips = document.createElement('div');
    chips.className = 'vehicles';
    for (const vehicle of all) {
      const where = owned.get(vehicle);
      const chip = document.createElement('span');
      chip.className = `chip${where?.local ? ' have' : ''}${where?.device ? ' dev' : ''}`;
      chip.textContent = vehicle;
      chip.title = where?.device
        ? `${vehicle} — held, and on the device`
        : where?.local
          ? `${vehicle} — held`
          : `${vehicle} — not in your dumps`;
      chips.append(chip);
    }
    wrap.append(chips);
    return wrap;
  }
}

for (const radio of document.querySelectorAll('input[name=filter]')) {
  radio.addEventListener('change', paint);
}
els.search.addEventListener('input', paint);

els.copyMissing.addEventListener('click', async () => {
  if (!collection) return;
  const lines = [];
  for (const group of collection.series) {
    const missing = group.items.filter((i) => !i.hasLocal && i.inDatabase);
    if (!missing.length) continue;
    lines.push(`${group.seriesName} (${missing.length})`);
    for (const m of missing) lines.push(`  ${m.name}  [${m.id}]`);
    lines.push('');
  }
  const text = lines.join('\n') || 'Nothing missing.';
  await navigator.clipboard.writeText(text);
  els.copyMissing.textContent = 'Copied';
  setTimeout(() => (els.copyMissing.textContent = 'Copy missing list'), 1500);
});

// ---- boot ---------------------------------------------------------------

(async function boot() {
  if (!localfs.available()) {
    setStatus('File System Access API unavailable — use Chrome or Edge over http://localhost', 'err');
    els.pickFolder.disabled = true;
    return;
  }
  if (!BleTransport.available) els.connect.disabled = true;

  const restored = await localfs.restoreDirectory();
  if (restored) {
    rootHandle = restored;
    els.folderName.textContent = restored.name;
    refresh();
    els.scan.click();
  } else {
    refresh();
  }
})();

export { describeAmiibo };
