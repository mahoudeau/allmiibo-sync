// Collection view: every amiibo in the vendored database, grouped by series,
// marked with whether you hold a dump of it locally and (optionally) whether
// it is on the device.

import { BleTransport } from './ble.js';
import { AllmiiboClient } from './protocol.js';
import { walkDevice, hashDeviceIndex } from './sync.js';
import { buildCollection, describeAmiibo } from './amiibo.js';
import * as localfs from './localfs.js';

const els = {};
for (const id of [
  'pickFolder', 'scan', 'connect', 'scanDevice', 'stop', 'folderName',
  'status', 'progress', 'stats', 'series', 'search', 'copyMissing',
  'mOwned', 'mMissing', 'mDevice', 'mExtra', 'mTotal',
]) els[id] = document.getElementById(id);

let rootHandle = null;
let transport = null;
let client = null;
let localIds = new Set();
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
    let unreadable = 0;
    for (const e of index.values()) {
      if (e.isDir) continue;
      if (e.amiiboId) localIds.add(e.amiiboId);
      else unreadable++;
    }

    render();
    setStatus(
      `Read ${index.size} entries — ${localIds.size} distinct amiibos` +
        (unreadable ? `, ${unreadable} file(s) with no readable amiibo ID` : ''),
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
    for (const e of index.values()) if (!e.isDir && e.amiiboId) deviceIds.add(e.amiiboId);

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

// ---- rendering ----------------------------------------------------------

function render() {
  collection = buildCollection(localIds, deviceIds);
  const s = collection.stats;

  els.stats.hidden = false;
  els.mOwned.textContent = s.ownedLocal;
  els.mMissing.textContent = s.missingLocal;
  els.mDevice.textContent = s.ownedDevice ?? '–';
  els.mExtra.textContent = s.notInDatabase;
  els.mTotal.textContent = s.knownTotal;

  paint();
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
      const row = document.createElement('div');
      row.className = `item${item.hasLocal ? '' : ' missing'}`;
      row.title = `${item.id}  ${item.typeName}`;

      const dot = document.createElement('span');
      dot.className = 'dot';

      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = item.name;

      row.append(dot, nm);

      if (item.hasDevice) {
        const t = document.createElement('span');
        t.className = 'tag dev';
        t.textContent = 'device';
        row.append(t);
      }
      if (!item.inDatabase) {
        const t = document.createElement('span');
        t.className = 'tag new';
        t.textContent = 'unlisted';
        row.append(t);
      }
      const ty = document.createElement('span');
      ty.className = 'tag';
      ty.textContent = item.typeName;
      row.append(ty);

      box.append(row);
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
