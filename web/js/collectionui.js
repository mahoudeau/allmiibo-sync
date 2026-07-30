// Collection view: every amiibo in the vendored database, grouped by series,
// marked with whether you hold a dump of it and whether it is on the device.
//
// Rendering contract: the DOM is built ONCE per data change (buildDom), and
// search/filter only toggle [hidden] on prebuilt cells (applyFilter). Sorting
// reorders the 31 group nodes. Nothing rebuilds per keystroke.

import { BleTransport } from './ble.js';
import { AllmiiboClient } from './protocol.js';
import { walkDevice, hashDeviceIndex } from './sync.js';
import { buildCollection, describeAmiibo, DUMP_SIZES, KNOWN_VEHICLES, hasVehicles, seriesRepresentative } from './amiibo.js';
import { AMIIBO_NAMES, AMIIBO_RELEASE } from '../data/amiibo-db.js';
import { isExcluded } from './planner.js';
import * as localfs from './localfs.js';
import * as prefs from './prefs.js';
import { debounce, motionOK, toast, statusCtl, progressCtl, burst, segCtl, fmtBytes, fmtDuration } from './ui.js';
import { icon, ICONS } from './icons.js';
import { confirmDialog } from './dialog.js';
import { scanAndPlan, applyThePlan, planSelection, hasWork } from './syncflow.js';
import { expandBundles, hasBundles } from './bundlesource.js';
import { hhdMark } from './sprite.js';
import { HHD_CARDS } from '../data/hhd-cards.js';
import { pickDeviceFolder } from './devicepicker.js';

prefs.migrate();

const els = {};
for (const id of [
  'srcStrip',
  'pageMeta', 'folderChip', 'deviceChip', 'stop', 'hero', 'collProg', 'status', 'pbar',
  'search', 'searchClear', 'searchIco', 'filters', 'sortMode', 'segView',
  'moreMenu', 'moreIco', 'copyMissing', 'showReport', 'exportLog', 'expandAll', 'collapseAll',
  'skipped', 'series', 'emptyState',
  'syncBtn', 'syncPanel', 'spReview', 'spWarn', 'spCards', 'spCap', 'spCapName',
  'spCapText', 'spApply', 'spCancel', 'spRun', 'spPbar', 'spErrs', 'spStop',
  'selectBtn', 'selBar', 'selN', 'selSend', 'selDown', 'selCancel',
]) els[id] = document.getElementById(id);

const status = statusCtl(els.status);
const pbar = progressCtl(els.pbar);

let rootHandle = null;
let lapsedFolderName = null; // remembered folder whose permission expired
let roName = null; // read-only fallback (Firefox/Safari): folder name, no handle
let transport = null;
let client = null;
let localIds = new Set();
let filesById = new Map();
let vehiclesById = new Map(); // id -> Map<vehicle, {local, device}>
let namesById = new Map();    // id -> filenames you gave its dumps
let deviceIds = null;
let deviceName = null;
let deviceIndex = null; // full hashed device index — selection ops need it
let hhdLocalUids = new Set();  // fan-made HHD pack cards, identified by UID
let hhdDeviceUids = new Set();
let devRoot = prefs.get(prefs.KEYS.deviceRoot, 'E:/amiibo');
let collection = null;
let stopRequested = false;
let skippedReport = { ignored: [], unrecognised: [], deviceUnrecognised: [], deviceErrors: [] };
let localFileLog = []; // every file of the last folder scan, for the export

// Built by buildDom, consumed by applyFilter.
let rowIndex = [];   // { el, groupEl, item, text }
let groupEls = new Map(); // series -> { el, countEl }

const CACHE_KEY = 'collectionScan';
const Q_KEY = 'allmiibo:s:q';
const SCROLL_KEY = 'allmiibo:s:scroll';
const ORDER_KEY = 'allmiibo:s:order';

// ---- status helper: the chip only exists while it has something to say ----
function say(text, kind = '') {
  els.status.hidden = !text;
  if (text) status.set(text, kind);
}

// ---- scan cache -----------------------------------------------------------

function saveScanCache() {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
      folderName: rootHandle?.name ?? lapsedFolderName ?? roName ?? '',
      localIds: [...localIds],
      filesById: [...filesById],
      namesById: [...namesById],
      vehiclesById: [...vehiclesById].map(([id, m]) => [id, [...m]]),
      deviceIds: deviceIds ? [...deviceIds] : null,
      deviceName,
      devRoot,
      hhdLocalUids: [...hhdLocalUids],
      hhdDeviceUids: [...hhdDeviceUids],
      deviceIndex: deviceIndex
        ? [...deviceIndex].map(([k, e]) => [k, {
            size: e.size, isDir: e.isDir, hash: e.hash ?? null,
            amiiboId: e.amiiboId ?? null, vehicle: e.vehicle ?? null,
            uid: e.uid ?? null,
          }])
        : null,
      skipped: skippedReport,
    }));
  } catch {}
}

function restoreScanCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const c = JSON.parse(raw);
    localIds = new Set(c.localIds);
    filesById = new Map(c.filesById);
    namesById = new Map(c.namesById);
    vehiclesById = new Map(c.vehiclesById.map(([id, m]) => [id, new Map(m)]));
    deviceIds = c.deviceIds ? new Set(c.deviceIds) : null;
    deviceName = c.deviceName ?? null;
    devRoot = c.devRoot ?? devRoot;
    hhdLocalUids = new Set(c.hhdLocalUids ?? []);
    hhdDeviceUids = new Set(c.hhdDeviceUids ?? []);
    deviceIndex = c.deviceIndex ? new Map(c.deviceIndex) : null;
    skippedReport = { ignored: [], unrecognised: [], deviceUnrecognised: [], deviceErrors: [], ...(c.skipped ?? {}) };
    return localIds.size > 0 || !!deviceIds;
  } catch {
    return false;
  }
}

// ---- artwork tier ----------------------------------------------------------

let artDir = './data/images/thumb';

// ---- source chips: folder + device state machines ---------------------------

function chipHtml({ label, sub, icons, primary, warnState, asButton, title }) {
  const cls = `srcChip${primary ? ' primary' : ''}${warnState ? ' warnState' : ''}`;
  const inner = `${icons ?? ''}<span>${label}</span>${sub ? `<span class="sub">${sub}</span>` : ''}`;
  return asButton
    ? `<button class="${cls}" ${title ? `title="${title}"` : ''}>${inner}</button>`
    : `<span class="${cls}">${inner}</span>`;
}

function renderFolderChip(state = {}) {
  const c = els.folderChip;
  const ro = !localfs.available(); // Firefox/Safari: webkitdirectory fallback

  if (state.scanning) {
    c.innerHTML = chipHtml({ icons: icon('folder'), label: rootHandle?.name ?? roName ?? 'FOLDER', sub: state.scanning });
    return;
  }
  if (rootHandle || (ro && roName)) {
    const name = rootHandle?.name ?? roName;
    c.innerHTML = `<span class="srcChip">${icon('folder')}<span>${name}</span>` +
      `<span class="sub">${[...localIds].length ? `${countDumps()} dumps` : ''}</span>` +
      `<button data-act="rescan" title="${ro ? 'Pick the folder again to rescan' : 'Rescan folder'}">${icon('sync')}</button>` +
      `<button data-act="forget" title="Forget folder">${icon('close')}</button></span>`;
  } else if (lapsedFolderName) {
    c.innerHTML = chipHtml({
      icons: icon('folder'), label: lapsedFolderName, sub: 'tap to reconnect',
      warnState: true, asButton: true,
    });
    c.querySelector('button').addEventListener('click', reconnectFolder);
    return;
  } else {
    c.innerHTML = chipHtml({ icons: icon('folder'), label: 'CHOOSE FOLDER', primary: !localIds.size, asButton: true });
    c.querySelector('button').addEventListener('click', ro ? pickFolderReadOnly : pickFolder);
    return;
  }
  c.querySelector('[data-act="rescan"]')?.addEventListener('click', ro ? pickFolderReadOnly : scanFolder);
  c.querySelector('[data-act="forget"]')?.addEventListener('click', forgetFolder);
}

function renderDeviceChip(state = {}) {
  const c = els.deviceChip;
  if (!BleTransport.available) { c.innerHTML = ''; return; }

  if (state.scanning) {
    c.innerHTML = `<span class="srcChip scanning"><span class="chipSpin">${icon('loader')}</span>` +
      `<span>${deviceName ?? 'DEVICE'}</span><span class="sub">${state.scanning}</span></span>`;
    return;
  }
  if (deviceIds) {
    const devFiles = deviceIndex ? [...deviceIndex.values()].filter((e) => !e.isDir).length : 0;
    const filesNote = devFiles > deviceIds.size ? ` (${devFiles} files)` : '';
    c.innerHTML = `<span class="srcChip">${icon('bluetooth')}<span>${deviceName ?? 'DEVICE'}</span>` +
      `<span class="sub">${devRoot} · ${deviceIds.size} amiibo${filesNote}</span>` +
      `<button data-act="dir" title="Choose device folder">${icon('folder')}</button>` +
      `<button data-act="rescan" title="Rescan device">${icon('sync')}</button>` +
      `<button data-act="clear" title="Clear device data">${icon('close')}</button></span>`;
    c.querySelector('[data-act="dir"]').addEventListener('click', addDevice);
    c.querySelector('[data-act="rescan"]').addEventListener('click', () => scanDevice());
    c.querySelector('[data-act="clear"]').addEventListener('click', clearDevice);
    return;
  }
  c.innerHTML = chipHtml({ icons: icon('bluetooth'), label: 'ADD DEVICE', asButton: true, title: 'Reads every file over Bluetooth — takes a few minutes' });
  c.querySelector('button').addEventListener('click', addDevice);
}

function countDumps() {
  let n = 0;
  for (const v of filesById.values()) n += v;
  return n;
}

// ---- folder actions ---------------------------------------------------------

async function pickFolder() {
  try {
    rootHandle = await localfs.pickDirectory();
    lapsedFolderName = null;
    renderFolderChip();
    await scanFolder();
  } catch (err) {
    if (err.name === 'AbortError') say('No folder chosen yet.');
    else say(err.message, 'err');
  }
}

async function reconnectFolder() {
  const restored = await localfs.restoreDirectory({ prompt: true });
  if (restored) {
    rootHandle = restored;
    lapsedFolderName = null;
    renderFolderChip();
    await scanFolder();
  } else {
    say('Permission declined — choose the folder again.', 'warn');
    lapsedFolderName = null;
    renderFolderChip();
  }
}

async function scanFolder() {
  if (!rootHandle) return;
  try {
    renderFolderChip({ scanning: 'reading…' });
    const index = await localfs.walkLocal(rootHandle, {
      hash: false,
      onProgress: (n) => { if (n % 100 === 0) renderFolderChip({ scanning: `reading… ${n}` }); },
    });
    await unpackBundles(index, (relPath) => localfs.readLocalFile(rootHandle, relPath));
    ingestLocalIndex(index, rootHandle.name);
  } catch (err) {
    say(err.message, 'err');
  }
  renderFolderChip();
}

// Read-only browsers: the picker hands over the files directly; everything
// after the walk is the same as a handle-based scan.
async function pickFolderReadOnly() {
  try {
    const files = await localfs.pickDirectoryFiles();
    renderFolderChip({ scanning: 'reading…' });
    const { folderName, index, byPath } = await localfs.indexFromFiles(files, {
      hash: false,
      onProgress: (n) => { if (n % 100 === 0) renderFolderChip({ scanning: `reading… ${n}` }); },
    });
    await unpackBundles(index, async (relPath) =>
      new Uint8Array(await byPath.get(relPath).arrayBuffer()));
    roName = folderName || 'FOLDER';
    ingestLocalIndex(index, roName);
  } catch (err) {
    if (err.name === 'AbortError') say('No folder chosen yet.');
    else say(err.message, 'err');
  }
  renderFolderChip();
}

// An all-in-one file holds a whole library. Counting the container as one
// unrecognised file — which is what it looked like before — would report a
// folder holding 943 amiibos as holding none, and disagree with what the sync
// panel is about to transfer.
async function unpackBundles(index, read) {
  if (!hasBundles(index)) return;
  try {
    const { virtual, report } = await expandBundles({ index, read, deviceRoot: devRoot });
    for (const [p, e] of virtual) if (!index.has(p)) index.set(p, e);
    for (const b of report.bundles) {
      if (b.error) say(`${b.relPath}: ${b.error}`, 'warn');
    }
  } catch (err) {
    say(`Could not read the all-in-one file: ${err.message}`, 'warn');
  }
}

function ingestLocalIndex(index, name) {
  const before = new Set(localIds);
  {
    localIds = new Set();
    filesById = new Map();
    namesById = new Map();
    hhdLocalUids = new Set();
    for (const v of vehiclesById.values()) for (const e of v.values()) e.local = false;
    let dumps = 0;
    const ignored = [];
    const unrecognised = [];

    localFileLog = [];
    for (const [relPath, e] of index) {
      if (e.isDir) continue;
      localFileLog.push({ relPath, size: e.size, amiiboId: e.amiiboId, vehicle: e.vehicle ?? null, uid: e.uid ?? null });
      if (e.amiiboId) {
        dumps++;
        localIds.add(e.amiiboId);
        filesById.set(e.amiiboId, (filesById.get(e.amiiboId) ?? 0) + 1);
        if (e.vehicle) markVehicle(e.amiiboId, e.vehicle, 'local');
        if (e.uid) hhdLocalUids.add(e.uid);
        if (!namesById.has(e.amiiboId)) namesById.set(e.amiiboId, []);
        namesById.get(e.amiiboId).push(relPath.slice(relPath.lastIndexOf('/') + 1));
      } else if (isExcluded(relPath)) {
        ignored.push({ relPath, size: e.size });
      } else {
        unrecognised.push({ relPath, size: e.size });
      }
    }
    skippedReport = { ...skippedReport, ignored, unrecognised };

    render();
    saveScanCache();

    const fresh = [...localIds].filter((id) => !before.has(id));
    if (dumps === 0) {
      say(`No dumps found in "${name}" — pick the folder that holds your .bin files.`, 'warn');
    } else if (unrecognised.length) {
      say(`${unrecognised.length} files skipped — see Scan report`, 'warn');
    } else {
      say('');
    }
    if (fresh.length && motionOK()) {
      celebrate(fresh);
      if (before.size) toast(`${fresh.length} new!`, { iconName: 'party' });
    }
    maybeCelebrateAllSynced();
  }
}

async function forgetFolder() {
  const ok = await confirmDialog({
    title: 'FORGET THIS FOLDER?',
    body: 'Your files are untouched. The device scan is kept.',
    confirmLabel: 'FORGET',
    cancelLabel: 'KEEP',
    icon: 'folder',
  });
  if (!ok) return;
  await localfs.forgetDirectory();
  // Folder-side state only — the device is its own source and survives.
  rootHandle = null;
  lapsedFolderName = null;
  roName = null;
  localIds = new Set();
  filesById = new Map();
  namesById = new Map();
  hhdLocalUids = new Set();
  for (const v of vehiclesById.values()) for (const e of v.values()) e.local = false;
  skippedReport = { ...skippedReport, ignored: [], unrecognised: [] };
  els.skipped.hidden = true;
  saveScanCache();
  render();
  renderFolderChip();
  renderDeviceChip();
  say(deviceIds ? 'Folder forgotten — device data kept.' : 'Folder forgotten — browsing the full database.');
}

// ---- device actions ----------------------------------------------------------

async function connect() {
  if (transport?.connected) return true;
  say('Choose your device in the Bluetooth popup…');
  transport = new BleTransport();
  client = new AllmiiboClient(transport, { log: () => {} });
  transport.addEventListener('disconnected', () => say('Device disconnected.', 'warn'));
  deviceName = await transport.connect();
  say('');
  return true;
}

// The DEVICE source flow: connect, pick the folder on the device, scan it.
async function addDevice() {
  try {
    await connect();
  } catch (err) {
    if (err.name === 'NotFoundError') say('No device selected.');
    else say(err.message, 'err');
    renderDeviceChip();
    return;
  }
  const picked = await pickDeviceFolder({ client, startPath: devRoot });
  if (!picked) { renderDeviceChip(); return; }
  devRoot = picked;
  prefs.set(prefs.KEYS.deviceRoot, picked);
  await scanDevice();
}

async function scanDevice() {
  stopRequested = false;
  try {
    await connect();
    els.stop.hidden = false;
    renderDeviceChip({ scanning: 'listing…' });
    pbar.busy(`Listing ${devRoot}…`);
    const deepFolders = [];
    let index = await walkDevice(client, devRoot, {
      shouldStop: () => stopRequested,
      onDeep: (relPath) => deepFolders.push(relPath),
      onProgress: (n) => {
        if (n % 50 === 0) {
          renderDeviceChip({ scanning: `listing ${n}` });
          pbar.busy(`Listing ${devRoot}…`, `${n} files`);
        }
      },
    });

    const total = [...index.values()].filter((e) => !e.isDir).length;
    const t0 = Date.now();
    index = await hashDeviceIndex(client, devRoot, index, {
      shouldStop: () => stopRequested,
      onProgress: (done, n) => {
        const rate = done / Math.max(1, (Date.now() - t0) / 1000);
        const left = Math.round((n - done) / Math.max(rate, 0.01));
        pbar.set(done, n, `Reading ${deviceName ?? 'device'}`, `${done}/${n} · ${fmtDuration(left)} left`);
        if (done % 10 === 0 || done === n) renderDeviceChip({ scanning: `${done}/${n} · ${Math.round((done / n) * 100)}%` });
      },
    });
    pbar.done();

    deviceIndex = index;
    deviceIds = new Set();
    hhdDeviceUids = new Set();
    const devUnrecognised = [];
    const devErrors = [];
    const devIgnored = [];
    for (const v of vehiclesById.values()) for (const e of v.values()) e.device = false;
    for (const [relPath, e] of index) {
      if (e.isDir) continue;
      if (e.amiiboId) {
        deviceIds.add(e.amiiboId);
        if (e.vehicle) markVehicle(e.amiiboId, e.vehicle, 'device');
        if (e.uid) hhdDeviceUids.add(e.uid);
      } else if (e.hashError) {
        devErrors.push({ relPath, size: e.size, error: e.hashError });
      } else if (isExcluded(relPath)) {
        devIgnored.push({ relPath, size: e.size });
      } else {
        devUnrecognised.push({ relPath, size: e.size });
      }
    }
    skippedReport = {
      ...skippedReport,
      deviceUnrecognised: devUnrecognised,
      deviceErrors: devErrors,
      deviceDeep: deepFolders,
      deviceIgnored: devIgnored,
    };

    render();
    saveScanCache();
    const skipped = devUnrecognised.length + devErrors.length + deepFolders.length;
    say(stopRequested
      ? `Stopped — ${deviceIds.size} read so far. Results partial.`
      : skipped
        ? `${skipped} device files not identified — see SCAN REPORT`
        : '', stopRequested || skipped ? 'warn' : '');
    if (!stopRequested) maybeCelebrateAllSynced();
  } catch (err) {
    pbar.hide();
    if (err.name === 'NotFoundError') say('No device selected.');
    else say(err.message, 'err');
  }
  els.stop.hidden = true;
  renderDeviceChip();
}

function clearDevice() {
  deviceIds = null;
  deviceName = null;
  deviceIndex = null;
  hhdDeviceUids = new Set();
  for (const v of vehiclesById.values()) for (const e of v.values()) e.device = false;
  render();
  saveScanCache();
  renderDeviceChip();
}

els.stop.addEventListener('click', () => { stopRequested = true; });

function markVehicle(id, vehicle, side) {
  if (!vehiclesById.has(id)) vehiclesById.set(id, new Map());
  const forId = vehiclesById.get(id);
  if (!forId.has(vehicle)) forId.set(vehicle, { local: false, device: false });
  forId.get(vehicle)[side] = true;
}

// ---- naming -------------------------------------------------------------------

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

// ---- stats band ------------------------------------------------------------------

// The fan-made-cards toggle in Settings flips data-show-fanmade on <html>;
// re-render so totals, filters and sync numbers follow without a reload.
new MutationObserver(() => {
  if (collection) render();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-show-fanmade'] });

function syncDeltas() {
  let up = 0;
  let down = 0;
  let matched = 0;
  if (deviceIds && collection) {
    for (const g of collection.series) {
      for (const i of g.items) {
        if (i.hasLocal && i.hasDevice === false) up++;
        if (i.hasDevice && !i.hasLocal) down++;
        if (i.hasLocal && i.hasDevice) matched++;
      }
    }
  }
  return { up, down, matched };
}

function renderStats() {
  renderHero();
  renderProgress();
}

// The collection's completion, hero-sized, between the sources panel and
// the filters: one global number over both sources.
function renderProgress() {
  const stats = collection?.stats;
  const show = !!stats && (localIds.size > 0 || !!deviceIds);
  els.collProg.hidden = !show;
  if (!show) { els.collProg.innerHTML = ''; return; }

  const pct = stats.knownTotal ? Math.round((stats.ownedKnown / stats.knownTotal) * 100) : 0;
  const showSplit = stats.ownedDeviceOnly > 0 && localIds.size > 0;
  const split = showSplit
    ? `title="${stats.ownedLocalKnown} in your folder · ${stats.ownedDeviceOnly} only on the device"`
    : '';
  els.collProg.innerHTML = `<div class="heroProg">
    <div class="hpTop">
      <button class="hpOwned" data-filter="owned" ${split}><b>${stats.ownedKnown}</b><span class="of"> / ${stats.knownTotal}</span></button>
      <span class="hpLbl">OWNED</span>
      ${showSplit ? `<span class="hStat dev" title="On the device but not in your folder — SYNC or DOWNLOAD brings them over">${icon('bluetooth')}<b>${stats.ownedDeviceOnly}</b> ONLY ON DEVICE</span>` : ''}
      <b class="hpPct">${pct}%</b>
    </div>
    <div class="hpBar"><span class="fill" style="width:${pct}%"></span></div>
  </div>`;
  const b = els.collProg.querySelector('button[data-filter]');
  b.addEventListener('click', () => setFilter(b.dataset.filter === currentFilter() ? 'all' : b.dataset.filter));
}

// The old-game moment: shown once per state when the folder and the device
// hold exactly the same amiibo. Dismissed by any key or click.
function maybeCelebrateAllSynced() {
  if (!deviceIds || !localIds.size || !collection) return;
  let up = 0;
  let down = 0;
  for (const g of collection.series) {
    for (const i of g.items) {
      if (i.hasLocal && i.hasDevice === false) up++;
      if (i.hasDevice && !i.hasLocal) down++;
    }
  }
  if (up || down) return;
  const s = collection.stats;
  const fingerprint = `${localIds.size}:${deviceIds.size}:${s.ownedKnown}`;
  try {
    if (sessionStorage.getItem('allmiibo:winShown') === fingerprint) return;
    sessionStorage.setItem('allmiibo:winShown', fingerprint);
  } catch {}

  const complete = s.ownedKnown === s.knownTotal;
  const overlay = document.createElement('div');
  overlay.className = 'winOverlay';
  overlay.innerHTML = `<div class="winPanel"><div class="scanfx"></div>
    <span data-win-pirate></span>
    <div class="stars">★ ★ ★</div>
    <div class="big">ALL SYNCED!</div>
    <div class="sub">${complete ? 'COLLECTION COMPLETE · ' : ''}DEVICE MATCHES FOLDER</div>
    <div class="nums">${s.ownedKnown} / ${s.knownTotal} OWNED · ${deviceIds.size} ON DEVICE</div>
    <div class="press">▸ PRESS ANY KEY</div></div>`;
  document.body.append(overlay);
  import('./sprite.js').then(({ pirateMark, FINISHES, DEFAULT_FINISH }) => {
    let finish = DEFAULT_FINISH;
    try {
      const i = Number(localStorage.getItem('allmiibo:pirate'));
      if (Number.isInteger(i) && i >= 0 && i < FINISHES.length) finish = i;
    } catch {}
    const slot = overlay.querySelector('[data-win-pirate]');
    if (slot) slot.innerHTML = pirateMark(88, finish);
  });
  if (motionOK()) burst(overlay.querySelector('.winPanel'));
  const dismiss = () => {
    overlay.remove();
    removeEventListener('keydown', dismiss, true);
  };
  overlay.addEventListener('click', dismiss);
  addEventListener('keydown', dismiss, true);
}

function celebrate(freshIds) {
  const freshSet = new Set(freshIds.slice(0, 24));
  let shown = 0;
  for (const r of rowIndex) {
    if (shown >= 24) break;
    if (freshSet.has(r.item.id) && !r.el.hidden) {
      r.el.classList.add('pop');
      r.el.addEventListener('animationend', () => r.el.classList.remove('pop'), { once: true });
      shown++;
    }
  }
  const track = els.collProg.querySelector('.hpBar') ?? els.hero.querySelector('.hBar');
  if (track) burst(track);
}

// ---- hero (cold / browse-only) ------------------------------------------------

function renderHero() {
  const step1Done = !!rootHandle || !!lapsedFolderName || !!roName || localIds.size > 0;
  const step2Done = !!deviceIds;
  const ble = BleTransport.available;
  const cold = !step1Done && !step2Done;

  // The source panel is permanent: it always shows the per-source state and
  // hosts the actions (SYNC, STOP, more options). Only the stats below swap
  // to the ALL SYNCED banner.
  els.hero.hidden = false;


  // One shared OWNED progression for the whole collection, then the two
  // sources as identical rows, each with only its own facts beneath it.
  const stats = collection?.stats;
  const scannedFolder = localIds.size > 0;

  const { up, down, matched } = syncDeltas();
  const syncDenom = matched + up + down;
  const syncPct = syncDenom ? Math.round((matched / syncDenom) * 100) : 0;

  let folderDetail = '';
  if (stats && scannedFolder) {
    folderDetail = `<div class="hDetail">
      <span class="hStat">${icon('copy')}<b>${countDumps()}</b> DUMP FILES</span>
      ${stats.notInDatabase > 0 ? `<span class="hStat warn">${icon('sparkles')}<b>${stats.notInDatabase}</b> NOT IN DB</span>` : ''}
    </div>`;
  }

  let deviceDetail = '';
  if (stats && step2Done) {
    deviceDetail = `<div class="hDetail">
      <button class="hStat ok" data-filter="notondevice">${icon('bluetooth')}<b>${stats.ownedDevice ?? deviceIds.size}</b> ON DEVICE</button>
      ${scannedFolder ? `<span class="hBar"><span class="fill" style="width:${syncPct}%"></span></span>
      <b class="hPct">${syncPct}%</b> <span class="hStat">SYNCED</span>` : ''}
    </div>`;
  }

  let syncLine = '';
  if (scannedFolder && step2Done) {
    if (up === 0 && down === 0) {
      const complete = stats.ownedKnown === stats.knownTotal;
      syncLine = `<div class="syncLine ok">${icon('check')}
        <span class="slTitle">ALL SYNCED</span>
        <span class="slSub">${complete ? 'collection complete — ' : ''}folder and device are identical</span></div>`;
    } else {
      const parts = [up ? `${up} to send` : '', down ? `${down} to fetch` : ''].filter(Boolean).join(' · ');
      syncLine = `<div class="syncLine">${icon('sync')}
        <span class="slTitle">${syncPct}% SYNCED</span>
        <span class="slSub">${parts}</span></div>`;
    }
  }

  els.hero.innerHTML = `<div class="hero"><span data-pirate-mark="72"></span><div class="hBody">
    <div class="hTitle">${cold ? 'ADD A SOURCE' : 'SOURCES'}</div>
    ${cold ? '<p class="hNote">One is enough to browse. Add both to sync them.</p>' : ''}
    <div class="hStep${step1Done ? ' done' : ''}">
      <span class="hStepN">${step1Done ? icon('check') : icon('folder')}</span>
      <span class="hStepLbl">YOUR FOLDER</span>
      <span class="hSlot" id="heroSlot1"></span>
    </div>
    ${folderDetail}
    ${ble ? `<div class="hStep${step2Done ? ' done' : ''}">
      <span class="hStepN">${step2Done ? icon('check') : icon('bluetooth')}</span>
      <span class="hStepLbl">YOUR DEVICE</span>
      <span class="hSlot" id="heroSlot2"></span>
    </div>` : ''}
    ${deviceDetail}
    ${syncLine}
    <span class="hActions" id="heroActions"></span>
    ${cold ? '<p class="hNote">Stays on this computer. Nothing uploads.</p>' : ''}
    ${!localfs.available() ? '<p class="hNote">Read-only in this browser: track your collection here, syncing needs Chrome or Edge.</p>' : ''}
  </div>
  <button type="button" class="advToggle heroHelp" id="heroHelp">${icon('info')}NEED HELP?</button>
  </div>`;

  els.hero.querySelector('#heroSlot1').append(els.folderChip);
  if (ble) els.hero.querySelector('#heroSlot2').append(els.deviceChip);
  // the action strip (SYNC / STOP / more options) lives in the panel footer
  els.srcStrip.hidden = false;
  els.hero.querySelector('#heroActions').append(els.srcStrip);

  for (const b of els.hero.querySelectorAll('button[data-filter]')) {
    b.addEventListener('click', () => setFilter(b.dataset.filter === currentFilter() ? 'all' : b.dataset.filter));
  }

  // Replays the tour on demand, whether or not it has been seen before.
  els.hero.querySelector('#heroHelp').addEventListener('click', async () => {
    const tour = await import('./tutorial.js');
    tour.start('collection');
  });

  import('./sprite.js').then(({ pirateMark, FINISHES, DEFAULT_FINISH }) => {
    let finish = DEFAULT_FINISH;
    try {
      const i = Number(localStorage.getItem('allmiibo:pirate'));
      if (Number.isInteger(i) && i >= 0 && i < FINISHES.length) finish = i;
    } catch {}
    const slot = els.hero.querySelector('[data-pirate-mark]');
    if (slot) slot.innerHTML = pirateMark(72, finish);
  });
}

// ---- filters / sort / view -------------------------------------------------------

const FILTERS = [
  { value: 'all', label: 'ALL' },
  { value: 'owned', label: 'OWNED' },
  { value: 'missing', label: 'MISSING' },
  { value: 'notondevice', label: 'NOT ON DEVICE', needsDevice: true },
];

function currentFilter() {
  const stored = prefs.get(prefs.KEYS.filter, 'all');
  if (stored === 'notondevice' && !deviceIds) return 'all';
  return FILTERS.some((f) => f.value === stored) ? stored : 'all';
}

function setFilter(value) {
  prefs.set(prefs.KEYS.filter, value);
  renderFilters();
  applyFilter();
}

function filterCounts() {
  const counts = { all: 0, owned: 0, missing: 0, notondevice: 0 };
  if (!collection) return counts;
  for (const g of collection.series) {
    for (const i of g.items) {
      counts.all++;
      if (i.hasLocal || i.hasDevice) counts.owned++;
      else counts.missing++;
      if (i.hasDevice === false) counts.notondevice++;
    }
  }
  return counts;
}

function renderFilters() {
  const active = currentFilter();
  const counts = filterCounts();
  els.filters.innerHTML = FILTERS
    .filter((f) => !f.needsDevice || deviceIds)
    .map((f) =>
      `<label class="pill${counts[f.value] === 0 && f.value !== 'all' ? ' zero' : ''}">` +
      `<input type="radio" name="filter" value="${f.value}" ${f.value === active ? 'checked' : ''}>` +
      `<span class="lbl">${f.label}</span><span class="n">${counts[f.value]}</span></label>`
    ).join('');
  for (const input of els.filters.querySelectorAll('input')) {
    input.addEventListener('change', () => setFilter(input.value));
  }
}

// ---- series ordering ---------------------------------------------------------------

function seriesDate(group) {
  if (group._date === undefined) {
    const dates = group.items.map((i) => AMIIBO_RELEASE[i.id]).filter(Boolean).sort();
    group._date = dates[0] ?? null;
  }
  return group._date;
}

function completionRatio(group) {
  const known = group.items.filter((i) => i.inDatabase || i.special).length;
  if (!known) return -1;
  return group.items.filter((i) => (i.hasLocal || i.hasDevice) && (i.inDatabase || i.special)).length / known;
}

function sortedSeries() {
  const groups = [...collection.series];
  const mode = els.sortMode.value;
  if (mode === 'name') {
    groups.sort((a, b) => a.seriesName.localeCompare(b.seriesName));
  } else if (mode === 'completion') {
    groups.sort((a, b) => completionRatio(b) - completionRatio(a) || a.seriesName.localeCompare(b.seriesName));
  } else {
    groups.sort((a, b) => {
      const da = seriesDate(a), db = seriesDate(b);
      if (da && db && da !== db) return da.localeCompare(db);
      if (!da !== !db) return da ? -1 : 1;
      return a.series - b.series;
    });
  }
  return groups;
}

// ---- DOM build (once per data change) ------------------------------------------------

function render() {
  refreshSyncButton?.();
  const nameHints = new Map();
  for (const [id, names] of namesById) {
    const label = labelFromFilenames(names);
    if (label) nameHints.set(id, label);
  }
  collection = buildCollection(localIds, deviceIds, {
    nameHints,
    dumpCounts: filesById,
    hideHhd: prefs.get(prefs.KEYS.showHhd, true) === false,
  });
  els.pageMeta.textContent = `${collection.stats.knownTotal} AMIIBO`;
  renderStats();
  renderFilters();
  buildDom();
  applyFilter();
}

function buildDom() {
  rowIndex = [];
  groupEls = new Map();
  // Collapsed by default; openSeries remembers the ones the user opened.
  const opened = new Set(prefs.get(prefs.KEYS.openSeries, []));
  const frag = document.createDocumentFragment();

  for (const group of sortedSeries()) {
    const details = document.createElement('details');
    details.className = 'series';
    details.dataset.series = String(group.series);
    details.open = opened.has(group.series);
    details.addEventListener('toggle', onGroupToggle);

    const summary = document.createElement('summary');
    const head = document.createElement('span');
    head.className = 'seriesHead';
    const headArt = document.createElement('img');
    headArt.className = 'seriesArt';
    headArt.loading = 'lazy';
    headArt.alt = '';
    headArt.width = 28; headArt.height = 28;
    headArt.src = `${artDir}/${seriesRepresentative(group.series) ?? (group.items.find((i) => i.hasLocal) ?? group.items[0]).id}.png`;
    const label = document.createElement('span');
    label.textContent = group.seriesName;
    head.append(headArt, label);
    const year = seriesDate(group)?.slice(0, 4);
    if (year) {
      const y = document.createElement('span');
      y.className = 'year';
      y.textContent = year;
      head.append(y);
    }

    const grow = document.createElement('span');
    grow.className = 'grow';
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.innerHTML = ICONS.chevronRight;
    summary.append(head, grow, makeSeriesPill(group), chev);
    details.append(summary);

    const box = document.createElement('div');
    box.className = 'items';

    // A giant mixed series (Animal Crossing) gets type sub-headers so the
    // card flood is skimmable.
    const types = [...new Set(group.items.map((i) => i.typeName))];
    const useSubheads = group.items.length > 100 && types.length > 1;

    let currentType = null;
    const itemsSorted = useSubheads
      ? [...group.items].sort((a, b) => a.typeName.localeCompare(b.typeName) || a.name.localeCompare(b.name))
      : group.items;

    for (const item of itemsSorted) {
      if (useSubheads && item.typeName !== currentType) {
        currentType = item.typeName;
        const n = itemsSorted.filter((i) => i.typeName === currentType).length;
        const sh = document.createElement('div');
        sh.className = 'subHead';
        sh.textContent = `${currentType.toUpperCase()}S · ${n}`;
        box.append(sh);
      }
      const el = makeCell(item);
      box.append(el);
      rowIndex.push({
        el,
        groupEl: details,
        item,
        text: `${item.name} ${group.seriesName} ${item.id}`.toLowerCase(),
      });
    }
    details.append(box);
    groupEls.set(group.series, { el: details });
    frag.append(details);
  }

  els.series.textContent = '';
  els.series.append(frag);
}

// One capture-phase image-error delegate for all ~950 imgs.
els.series.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.remove();
}, true);

function makeCell(item) {
  const hasLocal = item.hasLocal;
  const hasDevice = item.hasDevice;

  const row = document.createElement('a');
  const q = new URLSearchParams({ id: item.id });
  row.href = `./amiibo.html?${q}`;
  row.className = `item${hasLocal || hasDevice ? '' : ' missing'}`;

  const art = document.createElement('span');
  art.className = 'art';
  art.dataset.initial = (item.name[0] ?? '?').toUpperCase();
  if (item.special === 'hhd-items') {
    // our own pixel mark — the fan-made set has no official artwork
    art.innerHTML = hhdMark(30);
    art.dataset.initial = '';
  } else {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = `${artDir}/${item.id}.png`;
    art.append(img);
  }

  const tick = document.createElement('span');
  tick.className = 'selTick';
  row.append(tick);

  const nmWrap = document.createElement('span');
  nmWrap.className = 'nmWrap';
  const nm = document.createElement('span');
  nm.className = `nm${item.nameSource === 'filename' || item.nameSource === 'inferred' ? ' guessName' : ''}`;
  nm.textContent = item.name;
  nmWrap.append(nm);

  // List view: the filename is the "where is my dump" answer.
  const files = namesById.get(item.id);
  if (files?.length) {
    const f = document.createElement('span');
    f.className = 'fname';
    f.textContent = files.length === 1 ? files[0] : `${files.length} files`;
    nmWrap.append(f);
  }

  row.append(art, nmWrap);

  if (hasDevice) {
    const d = document.createElement('span');
    d.className = 'devIco';
    d.title = 'On the device';
    d.innerHTML = ICONS.bluetooth;
    row.append(d);
  }
  if (!item.inDatabase && !item.special) {
    const t = document.createElement('span');
    t.className = 'tag new';
    t.textContent = 'NEW';
    t.title = 'Not in the database yet';
    row.append(t);
  }
  if (item.special === 'hhd-items') {
    const have = hhdLocalUids.size;
    const pill = document.createElement('span');
    pill.className = `vPill${have ? ' some' : ''}`;
    pill.innerHTML = `<span class="ico">${ICONS.copy}</span>${have}/${HHD_CARDS.length}`;
    pill.title = `${have} of ${HHD_CARDS.length} cards — see the detail page`;
    row.append(pill);
  }
  const held = filesById.get(item.id) ?? 0;
  if (held > 1 && !hasVehicles(item.id) && !item.special) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = `×${held}`;
    t.title = `${held} dump files`;
    row.append(t);
  }

  if (hasVehicles(item.id)) {
    // Just the tally here — the vehicle line-up (with images) lives on the
    // detail page.
    const owned = vehiclesById.get(item.id) ?? new Map();
    const all = [...new Set([...KNOWN_VEHICLES, ...owned.keys()])].sort();
    const have = [...owned.values()].filter((w) => w.local).length;
    const pill = document.createElement('span');
    pill.className = `vPill${have ? ' some' : ''}`;
    pill.innerHTML = `<span class="ico">${ICONS.star}</span>${have}/${all.length}`;
    pill.title = `${have} of ${all.length} vehicles — see the detail page`;
    row.append(pill);
  }

  return row;
}

// One pill per series: owned/known coloured by completion, a bluetooth glyph
// when device data exists, ▲n to send, ▼n to download, ✨+n unlisted extras.
function makeSeriesPill(group) {
  const known = group.items.filter((i) => i.inDatabase || i.special).length;
  const owned = group.items.filter((i) => (i.hasLocal || i.hasDevice) && (i.inDatabase || i.special)).length;
  const extra = group.items.filter((i) => !i.inDatabase && !i.special && i.hasLocal).length;
  const hasDev = deviceIds !== null;
  const up = hasDev ? group.items.filter((i) => i.hasLocal && i.hasDevice === false).length : 0;
  const down = hasDev ? group.items.filter((i) => i.hasDevice && !i.hasLocal).length : 0;
  const complete = known > 0 && owned === known;
  const synced = hasDev && up === 0 && down === 0;

  const pill = document.createElement('span');
  pill.className = `sPill${complete && (!hasDev || synced) ? ' done'
    : complete ? ' full' : owned > 0 ? ' part' : ''}`;
  const bits = [];
  if (complete && (!hasDev || synced)) bits.push(`<span class="ico">${ICONS.check}</span>`);
  bits.push(`<b>${known ? `${owned}/${known}` : group.ownedLocal}</b>`);
  if (hasDev) bits.push(`<span class="ico">${ICONS.bluetooth}</span>`);
  if (up) bits.push(`<span class="delta">▲${up}</span>`);
  if (down) bits.push(`<span class="delta">▼${down}</span>`);
  if (extra) bits.push(`<span class="extra"><span class="ico">${ICONS.sparkles}</span>+${extra}</span>`);
  pill.innerHTML = bits.join('');
  pill.title = [
    known ? `${owned} of ${known} owned` : `${group.ownedLocal} owned, none in the database`,
    hasDev ? (synced ? 'device matches your folder' : null) : 'device not scanned',
    up ? `${up} only in your folder — send with SELECT` : null,
    down ? `${down} only on the device — download with SELECT` : null,
    extra ? `${extra} not in the database` : null,
  ].filter(Boolean).join(' · ');
  return pill;
}

function onGroupToggle(e) {
  const opened = new Set(prefs.get(prefs.KEYS.openSeries, []));
  const series = Number(e.target.dataset.series);
  if (e.target.open) opened.add(series);
  else opened.delete(series);
  prefs.set(prefs.KEYS.openSeries, [...opened]);
}

// ---- filtering (cheap, no rebuild) -----------------------------------------------

function applyFilter() {
  if (!collection) return;
  const filter = currentFilter();
  const q = els.search.value.trim().toLowerCase();
  els.searchClear.hidden = !q;
  try { sessionStorage.setItem(Q_KEY, q); } catch {}

  const keep = (item, text) => {
    if (filter === 'owned' && !item.hasLocal && !item.hasDevice) return false;
    if (filter === 'missing' && (item.hasLocal || item.hasDevice)) return false;
    if (filter === 'notondevice' && item.hasDevice !== false) return false;
    if (q && !text.includes(q)) return false;
    return true;
  };

  const visibleByGroup = new Map();
  const order = [];
  for (const r of rowIndex) {
    const show = keep(r.item, r.text);
    r.el.hidden = !show;
    if (show) {
      order.push(r.item.id);
      visibleByGroup.set(r.groupEl, (visibleByGroup.get(r.groupEl) ?? 0) + 1);
    }
  }

  let shown = 0;
  const filtering = filter !== 'all' || !!q;
  for (const { el } of groupEls.values()) {
    const n = visibleByGroup.get(el) ?? 0;
    el.hidden = n === 0;
    shown += n;
    if (filtering && n > 0) el.open = true;
  }

  // Sub-headers make no sense over a filtered subset.
  for (const sh of els.series.querySelectorAll('.subHead')) sh.hidden = filtering;

  try { sessionStorage.setItem(ORDER_KEY, JSON.stringify(order)); } catch {}

  els.emptyState.hidden = shown > 0;
  if (!shown) {
    els.emptyState.innerHTML = `<div class="empty">${icon('trex')}
      <div class="eTitle">NO AMIIBO MATCH</div>
      <button id="clearFilters">CLEAR FILTERS</button></div>`;
    els.emptyState.querySelector('#clearFilters').addEventListener('click', () => {
      els.search.value = '';
      setFilter('all');
    });
  }
}

const applyFilterDebounced = debounce(applyFilter, 150);

// ---- sort / view / search wiring ---------------------------------------------------

els.sortMode.addEventListener('change', () => {
  prefs.set(prefs.KEYS.sort, els.sortMode.value);
  // Re-append existing group nodes in the new order — 31 moves, no rebuilds.
  for (const group of sortedSeries()) {
    const g = groupEls.get(group.series);
    if (g) els.series.append(g.el);
  }
  applyFilter();
});

const viewCtl = segCtl(els.segView, {
  onChange: (mode) => {
    els.series.classList.toggle('cards', mode === 'cards');
    prefs.set(prefs.KEYS.view, mode);
  },
});

els.search.addEventListener('input', applyFilterDebounced);
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { els.search.value = ''; applyFilterDebounced.flush(); }
});
els.searchClear.addEventListener('click', () => {
  els.search.value = '';
  applyFilterDebounced.flush();
  els.search.focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input, textarea, select')) {
    e.preventDefault();
    els.search.focus();
  }
});


// ---- everyday sync (panel on the source strip) -----------------------------

const spPbar = progressCtl(els.spPbar);
let spPlan = null;
let spState = null;
// Bytes for anything unpacked from an all-in-one file: those entries have no
// file on disk for the executor to read.
let spSources = null;
let spStop = false;

function refreshSyncButton() {
  const ready = !!rootHandle && !!transport?.connected && !!deviceIds;
  els.syncBtn.hidden = !ready;
}

function closeSyncPanel() {
  els.syncPanel.hidden = true;
  spPlan = null;
}

els.spCancel.addEventListener('click', closeSyncPanel);
els.spStop.addEventListener('click', () => { spStop = true; });

function renderPanelReview(p) {
  els.syncPanel.hidden = false;
  els.spReview.hidden = false;
  els.spRun.hidden = true;

  els.spWarn.textContent = '';
  for (const text of p.warnings ?? []) {
    const w = document.createElement('div');
    w.className = 'warnCard';
    w.textContent = text;
    els.spWarn.append(w);
  }
  if (p.capacity && !p.capacity.fits) {
    const w = document.createElement('div');
    w.className = 'warnCard err';
    w.textContent = `Won't fit — needs ${fmtBytes(p.capacity.uploadBytes)}. Free space on the device first.`;
    els.spWarn.append(w);
  }

  const st = p.stats;
  const tiles = [
    p.download.length ? { ico: 'download', n: p.download.length, cap: 'DOWNLOAD', sub: fmtBytes(st.downloadBytes) } : null,
    p.upload.length ? { ico: 'upload', n: p.upload.length, cap: 'UPLOAD', sub: fmtBytes(st.uploadBytes) } : null,
    p.conflicts.length ? { ico: 'warning', n: p.conflicts.length, cap: 'CONFLICTS', cls: 'warn' } : null,
    p.ambiguous.length ? { ico: 'eyeOff', n: p.ambiguous.length, cap: 'UNVERIFIED', cls: 'warn' } : null,
    { ico: 'clock', n: fmtDuration(st.estimatedSeconds), cap: 'ESTIMATED', cls: 'muted' },
  ].filter(Boolean);

  els.spCards.innerHTML = hasWork(p)
    ? tiles.map((t) => `<div class="planCard ${t.cls ?? ''}"><b>${icon(t.ico)}${t.n}</b>` +
        `<span class="cap">${t.cap}</span>${t.sub ? `<span class="sub">${t.sub}</span>` : ''}</div>`).join('')
    : `<div class="empty" style="grid-column:1/-1">${icon('checkDouble')}
       <div class="eTitle">ALREADY IN SYNC</div><p>Both sides match. Nothing to write.</p></div>`;

  if (p.capacity) {
    const c = p.capacity;
    els.spCap.hidden = false;
    const usedPct = Math.round((c.usedSize / c.totalSize) * 100);
    els.spCap.querySelector('.fill').style.width = `${usedPct}%`;
    els.spCap.classList.toggle('warn', usedPct > 75 && usedPct <= 90);
    els.spCap.classList.toggle('err', usedPct > 90 || !c.fits);
    els.spCapName.textContent = `DEVICE ${p.deviceRoot.slice(0, 2)}`;
    els.spCapText.textContent = `${fmtBytes(c.usedSize)} / ${fmtBytes(c.totalSize)}` +
      (c.uploadBytes ? ` · +${fmtBytes(c.uploadBytes)} planned` : '');
  } else {
    els.spCap.hidden = true;
  }

  els.spApply.disabled = !hasWork(p) || (p.capacity && !p.capacity.fits);
  els.syncPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

els.syncBtn.addEventListener('click', async () => {
  spStop = false;
  els.syncBtn.disabled = true;
  try {
    const res = await scanAndPlan({
      client, rootHandle, deviceRoot: devRoot, op: 'smart', opts: {},
      shouldStop: () => spStop,
      on: { status: (t) => say(t), log: () => {} },
    });
    spPlan = res.plan;
    spState = res.state;
    spSources = res.bundle?.sources ?? null;
    say('');
    renderPanelReview(spPlan);
  } catch (err) {
    say(err.stopped ? 'Stopped.' : err.message, err.stopped ? 'warn' : 'err');
  }
  els.syncBtn.disabled = false;
});

async function runPanelApply() {
  if (!spPlan) return;
  els.spReview.hidden = true;
  els.spRun.hidden = false;
  els.spErrs.hidden = true;
  let errCount = 0;
  spStop = false;

  const uploadedIds = new Set(spPlan.upload.map((u) => u.amiiboId).filter(Boolean));
  const result = await applyThePlan({
    client, rootHandle, deviceRoot: spPlan.deviceRoot, state: spState, plan: spPlan,
    sources: spSources,
    shouldStop: () => spStop,
    on: {
      op: (label, i, total, t0) => {
        const rate = (i + 1) / Math.max(1, (Date.now() - t0) / 1000);
        const left = Math.round((total - i - 1) / Math.max(rate, 0.01));
        spPbar.set(i + 1, total, label, `${i + 1}/${total} · ${fmtDuration(left)} left`);
      },
      bytes: (written, total) => spPbar.setFile(written, total),
      error: () => {
        errCount++;
        els.spErrs.hidden = false;
        els.spErrs.textContent = `${errCount} ERROR${errCount === 1 ? '' : 'S'}`;
      },
    },
  });
  spPbar.done();

  const summary = `${result.completed} done${result.failed ? `, ${result.failed} failed` : ''} · ${fmtDuration(result.seconds)}`;
  if (result.stopped) say(`Stopped — ${summary}.`, 'warn');
  else if (result.failed > 0) say(`Finished with errors — ${summary}.`, 'err');
  else {
    say(`Sync complete — ${summary}.`, 'ok');
    toast(`Sync complete — ${summary}`, { iconName: 'party' });
  }

  closeSyncPanel();
  // Refresh both sides' truth: rescan the folder, merge the uploads into the
  // device sets (a full device rescan would cost minutes for nothing).
  for (const id of uploadedIds) deviceIds?.add(id);
  spPlan = null;
  if (rootHandle) await scanFolder();
  else { render(); saveScanCache(); }
  maybeCelebrateAllSynced();
}

els.spApply.addEventListener('click', runPanelApply);

// ---- selection mode ---------------------------------------------------------

let selecting = false;
const selected = new Set();

function setSelecting(on) {
  selecting = on;
  selected.clear();
  els.series.classList.toggle('selecting', on);
  els.selBar.hidden = !on;
  els.selectBtn.classList.toggle('primary', on);
  for (const r of rowIndex) r.el.classList.remove('selected');
  updateSelBar();
}

function updateSelBar() {
  els.selN.textContent = `${selected.size} SELECTED`;
  const canSend = transport?.connected && deviceIndex &&
    [...selected].some((id) => localIds.has(id) && !deviceIds?.has(id));
  const canDown = rootHandle && deviceIndex && transport?.connected &&
    [...selected].some((id) => deviceIds?.has(id) && !localIds.has(id));
  els.selSend.disabled = !canSend;
  els.selDown.disabled = !canDown;
}

els.selectBtn.addEventListener('click', () => setSelecting(!selecting));
els.selCancel.addEventListener('click', () => setSelecting(false));

// In selection mode, cells toggle instead of navigating.
els.series.addEventListener('click', (e) => {
  if (!selecting) return;
  const cell = e.target.closest('a.item');
  if (!cell) return;
  e.preventDefault();
  const idx = rowIndex.find((r) => r.el === cell);
  if (!idx) return;
  const id = idx.item.id;
  if (selected.has(id)) { selected.delete(id); cell.classList.remove('selected'); }
  else { selected.add(id); cell.classList.add('selected'); }
  updateSelBar();
});

async function runSelection(direction) {
  const eligible = [...selected].filter((id) => direction === 'push'
    ? localIds.has(id) && !deviceIds?.has(id)
    : deviceIds?.has(id) && !localIds.has(id));
  if (!eligible.length) return;
  try {
    await connect();
  } catch (err) {
    say(err.message, 'err');
    return;
  }
  try {
    const { plan: selPlan, state: selState, sources: selSources } = await planSelection({
      client, rootHandle, deviceRoot: devRoot, direction, ids: eligible,
      deviceIndex,
      on: { status: (t) => say(t), log: () => {} },
    });
    say('');
    if (!hasWork(selPlan)) {
      toast('Nothing to transfer — already on both sides.', { kind: 'warn' });
      return;
    }
    spPlan = selPlan;
    spState = selState;
    spSources = selSources ?? null;
    setSelecting(false);
    renderPanelReview(selPlan);
  } catch (err) {
    say(err.message, 'err');
  }
}

els.selSend.addEventListener('click', () => runSelection('push'));
els.selDown.addEventListener('click', () => runSelection('pull'));

// ---- more menu ----------------------------------------------------------------------

document.addEventListener('click', (e) => {
  if (els.moreMenu.open && !e.target.closest('#moreMenu')) els.moreMenu.open = false;
});

els.copyMissing.addEventListener('click', async () => {
  els.moreMenu.open = false;
  if (!collection || !localIds.size) {
    toast('Scan a folder first.', { kind: 'warn' });
    return;
  }
  const lines = [];
  let n = 0;
  for (const group of collection.series) {
    const missing = group.items.filter((i) => !i.hasLocal && !i.hasDevice && i.inDatabase);
    if (!missing.length) continue;
    n += missing.length;
    lines.push(`${group.seriesName} (${missing.length})`);
    for (const m of missing) lines.push(`  ${m.name}  [${m.id}]`);
    lines.push('');
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n') || 'Nothing missing.');
    toast(`Missing list copied — ${n} amiibo`);
  } catch {
    toast("Couldn't copy — clipboard is blocked here.", { kind: 'err' });
  }
});

els.showReport.addEventListener('click', () => {
  els.moreMenu.open = false;
  renderSkipped();
  els.skipped.hidden = !els.skipped.hidden;
  if (!els.skipped.hidden) els.skipped.scrollIntoView({ block: 'nearest' });
});

els.exportLog.addEventListener('click', () => {
  els.moreMenu.open = false;
  const { up, down, matched } = syncDeltas();
  const log = {
    generatedAt: new Date().toISOString(),
    page: location.href,
    userAgent: navigator.userAgent,
    prefs: {
      mode: localStorage.getItem('allmiibo:mode'),
      showHhd: prefs.get(prefs.KEYS.showHhd, true),
    },
    stats: collection?.stats ?? null,
    deltas: { up, down, matched },
    folder: {
      name: rootHandle?.name ?? lapsedFolderName ?? roName ?? null,
      files: localFileLog,
      skipped: { ignored: skippedReport.ignored, unrecognised: skippedReport.unrecognised },
    },
    device: {
      name: deviceName,
      root: devRoot,
      files: deviceIndex
        ? [...deviceIndex].filter(([, e]) => !e.isDir).map(([relPath, e]) => ({
            relPath, size: e.size, amiiboId: e.amiiboId ?? null,
            vehicle: e.vehicle ?? null, uid: e.uid ?? null, error: e.hashError ?? null,
          }))
        : null,
      skipped: {
        unrecognised: skippedReport.deviceUnrecognised,
        errors: skippedReport.deviceErrors,
        tooDeep: skippedReport.deviceDeep ?? [],
        system: skippedReport.deviceIgnored ?? [],
      },
    },
  };
  try {
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `allmiibo-scanlog-${new Date().toISOString().slice(0, 10)}.json`;
    // In the DOM before the click (some browsers require it), and the URL
    // outlives the click — revoking synchronously can cancel the download.
    document.body.append(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 2000);
    toast('Scan log saved — filenames and sizes only, no file contents.');
  } catch (err) {
    toast(`Couldn't save the log: ${err.message}`, { kind: 'err' });
  }
});

els.expandAll.addEventListener('click', () => {
  els.moreMenu.open = false;
  const opened = [];
  for (const { el } of groupEls.values()) { el.open = true; opened.push(Number(el.dataset.series)); }
  prefs.set(prefs.KEYS.openSeries, opened);
});
els.collapseAll.addEventListener('click', () => {
  els.moreMenu.open = false;
  for (const { el } of groupEls.values()) el.open = false;
  prefs.set(prefs.KEYS.openSeries, []);
});

function renderSkipped() {
  const { ignored, unrecognised, deviceUnrecognised = [], deviceErrors = [], deviceDeep = [], deviceIgnored = [] } = skippedReport;
  els.skipped.textContent = '';

  // The arithmetic first: how many files became how many distinct amiibo.
  // Duplicate dumps of the same amiibo are the usual gap between the two.
  const sums = [];
  if (localFileLog.length || localIds.size) {
    const dumps = countDumps();
    sums.push(`Folder: ${localFileLog.length || dumps} files → ${dumps} dumps → ${localIds.size} distinct amiibo.`);
  }
  if (deviceIndex) {
    const devFiles = [...deviceIndex.values()].filter((e) => !e.isDir).length;
    const devDumps = [...deviceIndex.values()].filter((e) => !e.isDir && e.amiiboId).length;
    sums.push(`Device: ${devFiles} files → ${devDumps} dumps → ${deviceIds?.size ?? 0} distinct amiibo.`);
  }
  if (sums.length) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = sums.join(' ');
    els.skipped.append(p);
  }
  if (!ignored.length && !unrecognised.length && !deviceUnrecognised.length && !deviceErrors.length && !deviceDeep.length) {
    const p = document.createElement('p');
    p.className = 'sub';
    p.textContent = localIds.size ? 'Every file was recognised.' : 'Nothing scanned yet.';
    els.skipped.append(p);
    return;
  }
  const block = (title, items, note) => {
    if (!items.length) return;
    const d = document.createElement('details');
    d.open = true;
    const sm = document.createElement('summary');
    sm.textContent = `${title} (${items.length})`;
    d.append(sm);
    const pre = document.createElement('pre');
    pre.textContent = (note ? `${note}\n\n` : '') +
      items.map((i) => `${String(i.size).padStart(8)} B  ${i.relPath}`).join('\n');
    d.append(pre);
    els.skipped.append(d);
  };
  const sizesNote = `Recognised dump sizes: ${Object.entries(DUMP_SIZES).map(([n, l]) => `${n} (${l})`).join(', ')}.`;
  block('Not recognised as amiibo dumps', unrecognised, sizesNote);
  block('System files (sync skips these too)', ignored);
  block('Device files not recognised as amiibo dumps', deviceUnrecognised, sizesNote);
  block('Device files that could not be read', deviceErrors.map((e) => ({
    size: e.size, relPath: `${e.relPath}   (${e.error})`,
  })), 'Read over Bluetooth failed twice for these. Rescan to retry them.');
  block('Device folders out of reach', deviceDeep.map((relPath) => ({ size: 0, relPath })),
    'Their full path exceeds the 63 bytes the device itself can address, so nothing inside them is reachable.');
  block('Device system files (sync skips these too)', deviceIgnored);
}

// ---- scroll persistence ---------------------------------------------------------------

addEventListener('pagehide', () => {
  try { sessionStorage.setItem(SCROLL_KEY, String(scrollY)); } catch {}
});

// Loaded on demand — a returning visitor never pays for the tour.
async function offerTour(page) {
  try {
    const tour = await import('./tutorial.js');
    tour.offer(page);
  } catch {
    // A tour that will not load is not worth a visible error.
  }
}

// ---- boot ------------------------------------------------------------------------------

(async function boot() {
  // render() keeps pageMeta in sync with the visible universe
  els.searchIco.innerHTML = ICONS.search;
  els.searchClear.innerHTML = ICONS.close;
  els.moreIco.innerHTML = ICONS.settings;
  for (const el of document.querySelectorAll('[data-ico]')) el.innerHTML = ICONS[el.dataset.ico] ?? '';

  // restore prefs
  const savedSort = prefs.get(prefs.KEYS.sort, 'release');
  if (['release', 'name', 'completion'].includes(savedSort)) els.sortMode.value = savedSort;
  const view = prefs.get(prefs.KEYS.view, 'cards');
  viewCtl.set(view);
  els.series.classList.toggle('cards', view === 'cards');
  try { els.search.value = sessionStorage.getItem(Q_KEY) ?? ''; } catch {}

  // one request decides the artwork tier for the whole page
  try {
    const probe = await fetch('./data/images/med/0000000000000002.png', { method: 'HEAD' });
    if (probe.ok) artDir = './data/images/med';
  } catch {}

  renderDeviceChip();

  const restored = localfs.available() ? await localfs.restoreDirectory() : null;
  if (restored) rootHandle = restored;

  const hadCache = restoreScanCache();
  if (!restored && hadCache) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (localfs.available()) {
        // handle still in IndexedDB but permission lapsed — offer one-tap re-grant
        lapsedFolderName = cached?.folderName || null;
      } else {
        roName = cached?.folderName || null;
      }
    } catch {}
  }

  render();
  renderFolderChip();
  renderDeviceChip();

  if (hadCache) {
    say(`${localIds.size} owned (cached) — rescan with ${'↻'} on the folder chip.`, 'ok');
    els.status.hidden = true; // the chips already say it; stay quiet
    try {
      const y = Number(sessionStorage.getItem(SCROLL_KEY));
      if (y > 0) requestAnimationFrame(() => scrollTo(0, y));
    } catch {}
    applyFilter();
  } else if (restored) {
    await scanFolder();
  }

  // First visit only. Offered after the folder scan so the tour describes the
  // page the visitor is actually looking at rather than an empty one.
  offerTour('collection');
})();

export { describeAmiibo };
