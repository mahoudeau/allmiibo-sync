// Advanced sync page: a thin controller over the shared engine in
// syncflow.js. Every operation and option lives here; the everyday sync is a
// panel on the Collection page.

import { BleTransport } from './ble.js';
import { AllmiiboClient } from './protocol.js';
import { compareByContent } from './planner.js';
import { walkDevice, hashDeviceIndex } from './sync.js';
import * as localfs from './localfs.js';
import * as prefs from './prefs.js';
import {
  OPS, PACK_OPS, hasWork, scanAndPlan, applyThePlan,
  packFolder, packDevice, packFileName,
} from './syncflow.js';
import { pickDeviceFolder } from './devicepicker.js';
import { toast, statusCtl, progressCtl, busy, idle, fmtBytes, fmtDuration } from './ui.js';
import { icon, ICONS } from './icons.js';
import { confirmDialog, chooseDialog } from './dialog.js';
import { findRescueStaging, stagingNotice, driveRootOf } from './rescue.js';

prefs.migrate();

const els = {};
for (const id of [
  'unsupported', 'step1', 'step2', 'step3', 'folderChip', 'deviceChip',
  'ops', 'scan', 'stop', 'review', 'warnBox', 'planCards',
  'capBar', 'capName', 'capText', 'drawers', 'rawPlanDrawer', 'planBox',
  'apply', 'back2', 'runPanel', 'runTitle', 'pbar', 'runErrs', 'stopRun',
  'errDrawer', 'errN', 'errList', 'status', 'logDrawer', 'log', 'saveLog', 'copyLog',
  'stepHelp',
]) els[id] = document.getElementById(id);

const status = statusCtl(els.status);
const pbar = progressCtl(els.pbar);

let transport = null;
let client = null;
let rootHandle = null;
let lapsedFolderName = null;
let deviceName = null;
let plan = null;
let state = null;
// Dumps unpacked from an all-in-one file in the folder: they have no file
// behind them, so the executor reads their bytes from here.
let bundleSources = null;
let bundleReport = null;
let stopRequested = false;
let lastRun = null;
let firmwareVersion = null;

const started = Date.now();
const deviceRoot = () => prefs.get(prefs.KEYS.deviceRoot, 'E:/amiibo');

function log(level, ...parts) {
  const line = document.createElement('div');
  line.className = `line ${level}`;
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6, ' ');
  line.textContent = `${t}s  ${parts.join(' ')}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function say(text, kind = '') {
  els.status.hidden = !text;
  if (text) status.set(text, kind);
}

// ---- operations UI ------------------------------------------------------------

function allOpts() { return prefs.get(prefs.KEYS.syncOpts, {}); }
function optsFor(op) { return allOpts()[op] ?? {}; }
function setOpt(op, key, value) {
  const all = allOpts();
  all[op] = { ...(all[op] ?? {}), [key]: value };
  prefs.set(prefs.KEYS.syncOpts, all);
}

function currentOp() {
  return document.querySelector('input[name=op]:checked')?.value ?? 'dump';
}

function renderOps() {
  const saved = prefs.get(prefs.KEYS.syncOp, 'dump');
  const active = OPS.some((o) => o.value === saved) ? saved : 'dump';
  els.ops.innerHTML = OPS.map((o) => {
    const opts = optsFor(o.value);
    return `<label class="op${o.advanced ? ' advanced-only' : ''}">
      <input type="radio" name="op" value="${o.value}" ${o.value === active ? 'checked' : ''}>
      <span class="oIco">${icon(o.ico)}</span>
      <span class="opName${o.danger ? ' danger' : ''}">${o.name}</span>
      <span class="opDesc">${o.desc}</span>
      <span class="opOpts">${o.opts.map((opt) =>
        `<label><input type="checkbox" data-opt="${opt.key}" ${opts[opt.key] ? 'checked' : ''}> ${opt.label}</label>`
      ).join('')}</span>
    </label>`;
  }).join('');

  for (const radio of els.ops.querySelectorAll('input[name=op]')) {
    radio.addEventListener('change', () => {
      prefs.set(prefs.KEYS.syncOp, radio.value);
      resetPlan();
      refresh();
    });
  }
  for (const box of els.ops.querySelectorAll('input[data-opt]')) {
    box.addEventListener('change', () => {
      const op = box.closest('.op').querySelector('input[name=op]').value;
      setOpt(op, box.dataset.opt, box.checked);
      resetPlan();
    });
  }
}

// If advanced mode turns off while an advanced op is selected, fall back to a
// visible one rather than leaving an invisible radio in charge.
new MutationObserver(() => {
  const op = OPS.find((o) => o.value === currentOp());
  const advancedOn = document.documentElement.dataset.mode === 'advanced';
  if (op?.advanced && !advancedOn) {
    prefs.set(prefs.KEYS.syncOp, 'dump');
    renderOps();
    resetPlan();
    refresh();
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });

// ---- gating --------------------------------------------------------------------

function refresh() {
  // Most operations need both sides. Packing needs only the side it reads, and
  // greying the button out for a device that is irrelevant just looks broken.
  const op = currentOp();
  const haveFolder = !!rootHandle;
  const haveDevice = !!transport?.connected;
  // Organise is one-sided too: it rearranges what is already there rather than
  // reconciling two sides, so requiring the other one would block a tidy-up
  // for no reason.
  const ready = op === 'bundle-local' || op === 'organise-local' ? haveFolder
    : op === 'bundle-device' || op === 'organise-device' || op === 'wipe' ? haveDevice
    : haveFolder && haveDevice;
  els.step2.classList.toggle('locked', !ready);
  els.scan.disabled = !ready;
}

// Everything a plan removes, counted once so the review tile and the confirm
// dialog can never disagree about how much is at stake. The `?? 0` covers
// planners that predate the local-move ops and never set those keys.
function deletions(p) {
  return p.deleteDevice.length + p.deleteLocal.length +
    p.rmdirDevice.length + (p.rmdirLocal?.length ?? 0);
}

function resetPlan() {
  plan = null;
  bundleSources = null;
  bundleReport = null;
  els.step3.hidden = true;
  els.review.hidden = false;
  els.runPanel.hidden = true;
}

// ---- source chips -----------------------------------------------------------------

function chipButton(html, onClick) {
  const b = document.createElement('button');
  b.className = 'srcChip';
  b.innerHTML = html;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function renderFolderChip() {
  const c = els.folderChip;
  c.textContent = '';
  if (rootHandle) {
    const span = document.createElement('span');
    span.className = 'srcChip';
    span.innerHTML = `${icon('folder')}<span>${rootHandle.name}</span>` +
      `<button data-act="swap" title="Choose another folder">${icon('sync')}</button>`;
    span.querySelector('[data-act="swap"]').addEventListener('click', pickFolder);
    c.append(span);
  } else if (lapsedFolderName) {
    const b = chipButton(`${icon('folder')}<span>${lapsedFolderName}</span><span class="sub">tap to reconnect</span>`, reconnectFolder);
    b.classList.add('warnState');
    c.append(b);
  } else {
    const b = chipButton(`${icon('folder')}<span>CHOOSE FOLDER</span>`, pickFolder);
    b.classList.add('primary');
    c.append(b);
  }
}

function renderDeviceChip() {
  const c = els.deviceChip;
  c.textContent = '';
  if (transport?.connected) {
    const span = document.createElement('span');
    span.className = 'srcChip';
    span.innerHTML = `${icon('bluetooth')}<span>${deviceName}</span>` +
      `<span class="sub">${deviceRoot()}</span>` +
      `<button data-act="dir" title="Choose device folder">${icon('folder')}</button>` +
      `<button data-act="dc" title="Disconnect">${icon('close')}</button>`;
    span.querySelector('[data-act="dir"]').addEventListener('click', async () => {
      const picked = await pickDeviceFolder({
        client, startPath: deviceRoot(),
        hint: 'The device folder to sync with — usually E:/amiibo.',
      });
      if (picked) {
        prefs.set(prefs.KEYS.deviceRoot, picked);
        renderDeviceChip();
        resetPlan();
      }
    });
    span.querySelector('[data-act="dc"]').addEventListener('click', () => transport?.disconnect());
    c.append(span);
  } else {
    c.append(chipButton(`${icon('bluetooth')}<span>CONNECT DEVICE</span>`, connectDevice));
  }
}

async function pickFolder() {
  try {
    rootHandle = await localfs.pickDirectory();
    lapsedFolderName = null;
    log('ok', `local folder: ${rootHandle.name}`);
    resetPlan();
  } catch (err) {
    if (err.name === 'AbortError') say('No folder chosen yet.');
    else say(err.message, 'err');
  }
  renderFolderChip();
  refresh();
}

async function reconnectFolder() {
  const restored = await localfs.restoreDirectory({ prompt: true });
  if (restored) {
    rootHandle = restored;
    lapsedFolderName = null;
  } else {
    say('Permission declined — choose the folder again.', 'warn');
    lapsedFolderName = null;
  }
  renderFolderChip();
  refresh();
}

// E:/r_ is a sibling of the device folder, so a scan rooted there never sees
// it and a half-finished recovery would sit unmentioned. One cheap listing on
// connect surfaces it. Asked once per page load, never suppressed for good:
// a half-migrated device is worth raising again next visit.
let stagingAsked = false;
async function offerStagingCleanup() {
  if (stagingAsked) return;
  stagingAsked = true;
  const found = await findRescueStaging(client, driveRootOf(deviceRoot())).catch(() => null);
  const notice = found && stagingNotice(found, { deviceRoot: deviceRoot() });
  if (!notice) return;
  log('warn', `${found.path} holds about ${found.files} rescued file(s)`);

  const choice = await chooseDialog({ ...notice, icon: 'warning', cancelLabel: 'LEAVE IT FOR NOW' });
  if (choice === 'organise') {
    prefs.set(prefs.KEYS.syncOp, 'organise-device');
    renderOps();
    resetPlan();
    refresh();
    say('ORGANISE DEVICE selected — scan to see what it would do.', 'ok');
  } else if (choice === 'backup') {
    prefs.set(prefs.KEYS.deviceRoot, found.path);
    prefs.set(prefs.KEYS.syncOp, 'dump');
    renderOps();
    resetPlan();
    renderDeviceChip();
    refresh();
    say(`Device folder set to ${found.path}, BACKUP selected — scan to copy them out.`, 'ok');
  } else if (choice === 'delete') {
    // chooseDialog resolves on one click by design, which must never be enough
    // to erase a few hundred files.
    const ok = await confirmDialog({
      title: `ERASE ${found.path}?`,
      body: `About ${found.files} rescued file(s) go. If you have not organised or backed them up, ` +
        `they are gone — these are the files a repair pulled out of a folder that would not list.`,
      detail: [`${found.path} and everything inside it`, 'This cannot be undone'],
      confirmLabel: 'ERASE',
      danger: true,
    });
    if (!ok) { log('warn', 'erase cancelled'); return; }
    try {
      await client.remove(found.path);
      log('ok', `removed ${found.path}`);
      toast(`${found.path} erased.`, { kind: 'ok' });
    } catch (err) {
      log('err', err.message);
      toast(`Could not erase ${found.path}: ${err.message}`, { kind: 'err' });
    }
  }
}

async function connectDevice() {
  try {
    say('Choose your device in the Bluetooth popup…');
    transport = new BleTransport();
    client = new AllmiiboClient(transport, { log });
    transport.addEventListener('disconnected', () => {
      say('Device disconnected — reconnect to continue.', 'warn');
      log('warn', 'device disconnected');
      renderDeviceChip();
      refresh();
    });
    deviceName = await transport.connect();
    const v = await client.getVersion();
    firmwareVersion = v.version;
    log('ok', `connected to "${deviceName}" (firmware ${v.version})`);
    say('');
    await offerStagingCleanup();
  } catch (err) {
    if (err.name === 'NotFoundError') say('No device selected.');
    else say(err.message, 'err');
  }
  renderDeviceChip();
  refresh();
}

// ---- scan & plan ---------------------------------------------------------------------

els.scan.addEventListener('click', async () => {
  const op = currentOp();
  if (op === 'check') return runAudit();
  if (PACK_OPS.includes(op)) return runPack(op);

  busy(els.scan, 'SCANNING');
  els.stop.hidden = false;
  stopRequested = false;
  resetPlan();

  try {
    const res = await scanAndPlan({
      client, rootHandle, deviceRoot: deviceRoot(), op, opts: optsFor(op),
      firmwareVersion,
      shouldStop: () => stopRequested,
      on: {
        status: (t) => say(t),
        progress: (done, total, label, detail) => pbar.set(done, total, label, detail),
        log,
      },
    });
    pbar.done();
    plan = res.plan;
    state = res.state;
    lastRun = res.lastRun;
    bundleSources = res.bundle?.sources ?? null;
    bundleReport = res.bundle?.report ?? null;
    els.saveLog.disabled = false;
    renderReview(plan, op);
    say('');
  } catch (err) {
    pbar.hide();
    say(err.stopped ? 'Scan stopped.' : `Scan failed: ${err.message}`, err.stopped ? 'warn' : 'err');
    if (!err.stopped) log('err', err.message);
  }
  els.stop.hidden = true;
  idle(els.scan);
  refresh();
});

// ---- review rendering -------------------------------------------------------------------

const SECTIONS = [
  { key: 'download', label: 'DOWNLOAD', ico: 'download', fmt: (d) => [d.relPath, fmtBytes(d.size)] },
  { key: 'upload', label: 'UPLOAD', ico: 'upload', fmt: (u) => [u.relPath, fmtBytes(u.size)] },
  { key: 'moveDevice', label: 'RENAME ON DEVICE', ico: 'move', fmt: (m) => [`${m.from} → ${m.to}`, ''] },
  { key: 'moveLocal', label: 'RENAME IN YOUR FOLDER', ico: 'move', fmt: (m) => [`${m.from} → ${m.to}`, ''] },
  { key: 'mkdirDevice', label: 'NEW DEVICE FOLDERS', ico: 'folderPlus', fmt: (m) => [m.relPath, ''] },
  { key: 'mkdirLocal', label: 'NEW LOCAL FOLDERS', ico: 'folderPlus', fmt: (m) => [m.relPath, ''] },
  { key: 'deleteDevice', label: 'DELETE ON DEVICE', ico: 'trash', tone: 'err', fmt: (d) => [d.relPath, ''] },
  { key: 'deleteLocal', label: 'DELETE LOCALLY', ico: 'trash', tone: 'err', fmt: (d) => [d.relPath, ''] },
  { key: 'rmdirDevice', label: 'REMOVE DEVICE FOLDERS', ico: 'trash', tone: 'err', fmt: (d) => [d.relPath, ''] },
  { key: 'rmdirLocal', label: 'REMOVE LOCAL FOLDERS', ico: 'trash', tone: 'err', fmt: (d) => [d.relPath, ''] },
  { key: 'unidentified', label: 'NOT RECOGNISED — LEFT ALONE', ico: 'eyeOff', fmt: (u) => [u.relPath, fmtBytes(u.size)] },
  { key: 'kept', label: 'KEPT — THE DEVICE NEEDS THESE', ico: 'eye', fmt: (k) => [k.relPath, fmtBytes(k.size)] },
  { key: 'wouldDelete', label: 'KEPT — DELETIONS ARE OFF', ico: 'eye', fmt: (d) => [d.relPath, d.side] },
  { key: 'conflicts', label: 'CONFLICT — LEFT ALONE', ico: 'warning', tone: 'warn', fmt: (c) => [c.relPath, ''] },
  { key: 'blocked', label: 'BLOCKED — WON\u2019T FIT', ico: 'cancel', tone: 'err', fmt: (b) => [b.relPath, ''] },
  { key: 'ambiguous', label: 'SKIPPED — UNVERIFIED', ico: 'eyeOff', tone: 'warn', fmt: (a) => [a.relPath, ''] },
  { key: 'renamedLocally', label: 'RENAMED FOR YOUR DISK', ico: 'move', fmt: (r) => [`${r.from} → ${r.to}`, ''] },
  { key: 'unenumerated', label: 'DEVICE FOLDERS NOT LISTED', ico: 'eyeOff', tone: 'warn', fmt: (u) => [u.relPath, u.reason] },
];

// What an all-in-one file in the folder contributed. Written to read as a
// result rather than a problem: "0 new" is the correct outcome for a library
// you already have in full, not a failure.
function renderBundleNotes() {
  for (const b of bundleReport?.bundles ?? []) {
    const card = document.createElement('div');
    card.className = b.error ? 'warnCard err' : 'warnCard';

    if (b.error) {
      card.textContent = `${b.relPath} could not be read: ${b.error}`;
      els.warnBox.append(card);
      continue;
    }

    const held = b.haveLocally + b.onDevice;
    const parts = [
      `${b.relPath} is an all-in-one file: ${b.count} records, ${b.unique} amiibo${b.unique === 1 ? '' : 's'}.`,
      b.added
        ? `${b.added} will transfer.`
        : 'Nothing to transfer. You already have all of them.',
    ];
    if (b.haveLocally) parts.push(`${b.haveLocally} already in your folder.`);
    if (b.onDevice) parts.push(`${b.onDevice} already on the device.`);
    if (b.duplicates) parts.push(`${b.duplicates} duplicate records skipped.`);
    if (b.unknown) parts.push(`${b.unknown} records carried no readable amiibo ID.`);
    if (held && b.added === 0) parts.push('The file itself is never sent, because the device cannot read it.');
    card.textContent = parts.join(' ');
    els.warnBox.append(card);

    for (const x of b.blocked) {
      const w = document.createElement('div');
      w.className = 'warnCard err';
      w.textContent = `Skipped ${x.amiiboId} from ${b.relPath}: ${x.reason}.`;
      els.warnBox.append(w);
    }
    if (b.added && bundleReport && !bundleReport.deviceIdentified) {
      const w = document.createElement('div');
      w.className = 'warnCard';
      w.textContent =
        'The device was matched by path, not by amiibo. MATCH reads every device file, so it ' +
        'would also spot a copy filed under a different name.';
      els.warnBox.append(w);
    }
  }
}

function renderReview(p, op) {
  els.step3.hidden = false;
  els.review.hidden = false;
  els.runPanel.hidden = true;

  els.warnBox.textContent = '';
  if (op === 'replace') {
    const w = document.createElement('div');
    w.className = 'warnCard err';
    w.textContent = `Replace wipes everything under ${p.deviceRoot} first — ${p.deleteDevice.length + p.rmdirDevice.length} deletions, then ${p.upload.length} uploads.`;
    els.warnBox.append(w);
  }
  for (const text of p.warnings ?? []) {
    const w = document.createElement('div');
    w.className = 'warnCard';
    w.textContent = text;
    els.warnBox.append(w);
  }
  renderBundleNotes();
  if (p.capacity && !p.capacity.fits) {
    const w = document.createElement('div');
    w.className = 'warnCard err';
    const possible = p.capacity.usableBytes ?? p.capacity.freeAfterDeletes ?? p.capacity.freeNow;
    w.textContent = `Won't fit — needs ${fmtBytes(p.capacity.uploadBytes)}, only ${fmtBytes(possible)} possible. Free space on the device first.`;
    els.warnBox.append(w);
  }

  const s = p.stats;
  const dl = p.download.length, ul = p.upload.length;
  const del = deletions(p);
  const renames = p.moveDevice.length + (p.moveLocal?.length ?? 0);
  const tiles = [
    dl ? { ico: 'download', n: dl, cap: 'DOWNLOAD', sub: fmtBytes(s.downloadBytes) } : null,
    ul ? { ico: 'upload', n: ul, cap: 'UPLOAD', sub: fmtBytes(s.uploadBytes) } : null,
    renames ? { ico: 'move', n: renames, cap: 'RENAME', cls: 'muted' } : null,
    del ? { ico: 'trash', n: del, cap: 'DELETE', cls: 'err' } : null,
    p.unidentified?.length ? { ico: 'eyeOff', n: p.unidentified.length, cap: 'NOT RECOGNISED', cls: 'muted' } : null,
    p.conflicts.length ? { ico: 'warning', n: p.conflicts.length, cap: 'CONFLICTS', cls: 'warn' } : null,
    p.blocked.length ? { ico: 'cancel', n: p.blocked.length, cap: 'BLOCKED', cls: 'err' } : null,
    p.ambiguous.length ? { ico: 'eyeOff', n: p.ambiguous.length, cap: 'UNVERIFIED', cls: 'warn' } : null,
    s.unenumerated ? { ico: 'eyeOff', n: s.unenumerated, cap: 'NOT LISTED', cls: 'warn' } : null,
    { ico: 'clock', n: fmtDuration(s.estimatedSeconds), cap: 'ESTIMATED', cls: 'muted' },
    s.unchanged ? { ico: 'checkDouble', n: s.unchanged, cap: 'UNCHANGED', cls: 'muted' } : null,
  ].filter(Boolean);

  els.planCards.innerHTML = hasWork(p)
    ? tiles.map((t) => `<div class="planCard ${t.cls ?? ''}"><b>${icon(t.ico)}${t.n}</b>` +
        `<span class="cap">${t.cap}</span>${t.sub ? `<span class="sub">${t.sub}</span>` : ''}</div>`).join('')
    : `<div class="empty" style="grid-column:1/-1">${icon('checkDouble')}
       <div class="eTitle">ALREADY IN SYNC</div><p>Both sides match. Nothing to write.</p></div>`;

  if (p.capacity) {
    const c = p.capacity;
    els.capBar.hidden = false;
    const usedPct = Math.round((c.usedSize / c.totalSize) * 100);
    els.capBar.querySelector('.fill').style.width = `${usedPct}%`;
    els.capBar.classList.toggle('warn', usedPct > 75 && usedPct <= 90);
    els.capBar.classList.toggle('err', usedPct > 90 || !c.fits);
    els.capBar.classList.toggle('overflow', !c.fits);
    els.capName.textContent = `DEVICE ${p.deviceRoot.slice(0, 2)}`;
    els.capText.textContent =
      `${fmtBytes(c.usedSize)} / ${fmtBytes(c.totalSize)}` +
      (c.uploadBytes ? ` · +${fmtBytes(c.uploadBytes)} planned` : '') +
      (c.freeingBytes ? ` · −${fmtBytes(c.freeingBytes)} freed` : '');
  } else {
    els.capBar.hidden = true;
  }

  els.drawers.textContent = '';
  for (const sec of SECTIONS) {
    const items = p[sec.key] ?? [];
    if (!items.length) continue;
    const d = document.createElement('details');
    d.className = 'drawer';
    if (sec.tone === 'err' && sec.key.startsWith('delete')) d.open = true;
    d.innerHTML = `<summary><span class="chev">${ICONS.chevronRight}</span>` +
      `<span style="${sec.tone ? `color:var(--${sec.tone})` : ''}">${icon(sec.ico)}</span>` +
      `${sec.label}<span class="n">${items.length}</span></summary><div class="body"></div>`;
    const fill = () => {
      const body = d.querySelector('.body');
      if (body.childElementCount) return;
      const ul = document.createElement('ul');
      ul.className = 'fileList';
      for (const item of items.slice(0, 200)) {
        const [path, sz] = sec.fmt(item);
        const li = document.createElement('li');
        li.innerHTML = `<span class="p"></span><span class="sz"></span>`;
        li.querySelector('.p').textContent = path;
        li.querySelector('.sz').textContent = sz;
        ul.append(li);
      }
      if (items.length > 200) {
        const li = document.createElement('li');
        li.textContent = `… and ${items.length - 200} more — full list in the run log`;
        ul.append(li);
      }
      body.append(ul);
    };
    d.addEventListener('toggle', () => { if (d.open) fill(); });
    if (d.open) fill();
    els.drawers.append(d);
  }

  els.rawPlanDrawer.hidden = false;
  els.planBox.textContent = JSON.stringify({
    stats: s, capacity: p.capacity ?? null, deleteFirst: !!p.deleteFirst, warnings: p.warnings,
  }, null, 2);

  els.apply.disabled = !hasWork(p) || (p.capacity && !p.capacity.fits);
  els.apply.classList.toggle('danger', del > 0);
  els.step3.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

els.back2.addEventListener('click', () => { resetPlan(); });

// ---- apply --------------------------------------------------------------------------------

els.apply.addEventListener('click', async () => {
  if (!plan) return;
  const op = currentOp();

  const del = deletions(plan);
  if (del > 0) {
    const ok = await confirmDialog({
      title: op === 'replace' ? 'WIPE DEVICE?'
        : op === 'wipe' ? `ERASE ${plan.deviceRoot}?`
        : `DELETE ${del} FILE${del === 1 ? '' : 'S'}?`,
      body: op === 'wipe'
        // A wipe writes nothing back, so nothing is recoverable from this app
        // afterwards. Better to say so than to lean on "can't be undone".
        ? `${plan.deleteDevice.length} file(s) erased and nothing written back. ` +
          `Anything you have not backed up is gone.`
        : op === 'replace'
        ? `${plan.deleteDevice.length} files erased, then ${plan.upload.length} written · ${fmtDuration(plan.stats.estimatedSeconds)}.`
        : 'This can\u2019t be undone.',
      detail: [
        plan.deleteDevice.length ? `${plan.deleteDevice.length} on the device` : null,
        plan.deleteLocal.length ? `${plan.deleteLocal.length} in your folder` : null,
        plan.rmdirDevice.length ? `${plan.rmdirDevice.length} device folders` : null,
        plan.rmdirLocal?.length ? `${plan.rmdirLocal.length} folders in your folder` : null,
        plan.kept?.length ? `${plan.kept.length} device file(s) kept — the device needs them` : null,
        plan.stats.unenumerated
          ? `${plan.stats.unenumerated} folder(s) left standing — they never listed`
          : null,
      ].filter(Boolean),
      confirmLabel: op === 'replace' ? 'WIPE & WRITE' : op === 'wipe' ? 'ERASE' : 'DELETE',
      danger: true,
    });
    if (!ok) { log('warn', 'apply cancelled'); return; }
  }

  stopRequested = false;
  els.review.hidden = true;
  els.runPanel.hidden = false;
  els.runTitle.textContent = op === 'dump' ? 'BACKING UP'
    : op === 'replace' ? 'REPLACING'
    : op === 'wipe' ? 'ERASING'
    : op.startsWith('organise') ? 'ORGANISING'
    : 'SYNCING';
  els.errDrawer.hidden = true;
  els.errList.textContent = '';
  els.runErrs.hidden = true;
  let errCount = 0;

  const result = await applyThePlan({
    client, rootHandle, deviceRoot: plan.deviceRoot, state, plan,
    sources: bundleSources,
    shouldStop: () => stopRequested,
    on: {
      op: (label, i, total, t0) => {
        const rate = (i + 1) / Math.max(1, (Date.now() - t0) / 1000);
        const left = Math.round((total - i - 1) / Math.max(rate, 0.01));
        pbar.set(i + 1, total, label, `${i + 1}/${total} · ${fmtDuration(left)} left`);
      },
      bytes: (written, total) => pbar.setFile(written, total),
      error: (message) => {
        errCount++;
        log('err', message);
        els.runErrs.hidden = false;
        els.runErrs.textContent = `${errCount} ERROR${errCount === 1 ? '' : 'S'}`;
        els.errDrawer.hidden = false;
        els.errN.textContent = String(errCount);
        const li = document.createElement('li');
        li.textContent = message;
        els.errList.append(li);
      },
    },
  });

  if (lastRun) {
    lastRun.apply = {
      seconds: result.seconds,
      completed: result.completed,
      failed: result.failed,
      stopped: result.stopped,
      errors: result.errors,
      operations: result.log,
    };
    els.saveLog.disabled = false;
  }
  pbar.done();
  if (errCount) els.errDrawer.open = true;

  const summary = `${result.completed} done${result.failed ? `, ${result.failed} failed` : ''} · ${fmtDuration(result.seconds)}`;
  if (result.stopped) {
    els.runTitle.textContent = 'STOPPED';
    say(`Stopped — ${summary}. Scan again to resume.`, 'warn');
    log('warn', `stopped by request — ${summary}`);
  } else if (result.failed > 0) {
    els.runTitle.textContent = 'FINISHED WITH ERRORS';
    say(`Finished with errors — ${summary}.`, 'err');
    log('err', `finished with errors — ${summary}`);
  } else {
    els.runTitle.textContent = 'DONE';
    say(`Sync complete — ${summary}.`, 'ok');
    log('ok', `sync complete — ${summary}`);
    toast(`Sync complete — ${summary}`, { iconName: 'party' });
  }
  els.stopRun.textContent = 'SCAN AGAIN';
  els.stopRun.onclick = () => {
    els.stopRun.textContent = 'STOP';
    els.stopRun.onclick = null;
    resetPlan();
    els.scan.click();
  };
  plan = null;
  refresh();
});

els.stopRun.addEventListener('click', () => {
  stopRequested = true;
  log('warn', 'stopping after the current operation…');
});

// ---- CHECK (compare by content, read-only) --------------------------------------------------

// ---- packing a library into one all-in-one file ---------------------------
//
// Not a plan, so it does not go through the review/apply path: it reads one side
// and hands back a file.

function saveBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function runPack(op) {
  const fromDevice = op === 'bundle-device';
  busy(els.scan, 'PACKING');
  els.stop.hidden = false;
  stopRequested = false;
  resetPlan();

  try {
    const on = {
      status: (t) => say(t),
      progress: (done, total, label, detail) => pbar.set(done, total, label, detail),
      log,
    };
    const { bytes, report } = fromDevice
      ? await packDevice({ client, deviceRoot: deviceRoot(), on, shouldStop: () => stopRequested })
      : await packFolder({ rootHandle, deviceRoot: deviceRoot(), on, shouldStop: () => stopRequested });
    pbar.done();

    if (!report.records) {
      say('Nothing to pack. No amiibo dumps found.', 'warn');
    } else {
      const name = packFileName(report.records);
      saveBytes(bytes, name);
      const summary = `${report.records} amiibos · ${fmtBytes(bytes.length)}`;
      say(
        stopRequested
          ? `Stopped early. Packed what was read so far: ${summary}.`
          : `Packed ${summary} into ${name}.`,
        stopRequested ? 'warn' : 'ok'
      );
      log('ok', `packed ${report.records} records from ${report.read} files into ${name}`);
      // Worth saying plainly: this is the one thing a bundle cannot carry.
      if (report.lossy.length) {
        const w = document.createElement('div');
        w.className = 'warnCard';
        w.textContent =
          `${report.lossy.length} Kirby Air Riders dumps lost their vehicle. An all-in-one ` +
          'record holds 540 bytes and the vehicle sits past the end, so all four vehicles for ' +
          'a character become one entry. Keep your original dumps.';
        els.step3.hidden = false;
        els.review.hidden = false;
        els.warnBox.append(w);
      }
      toast(`Packed ${summary}`, { iconName: 'download' });
    }
  } catch (err) {
    pbar.hide();
    say(err.stopped ? 'Packing stopped.' : `Packing failed: ${err.message}`, err.stopped ? 'warn' : 'err');
    if (!err.stopped) log('err', err.message);
  }
  els.stop.hidden = true;
  idle(els.scan);
  refresh();
}

async function runAudit() {
  busy(els.scan, 'CHECKING');
  els.stop.hidden = false;
  stopRequested = false;
  resetPlan();

  try {
    say('Reading your folder…');
    const local = await localfs.walkLocal(rootHandle, {
      onProgress: (n) => { if (n % 100 === 0) say(`Reading your folder… ${n}`); },
    });
    say('Listing the device…');
    let device = await walkDevice(client, deviceRoot(), {
      shouldStop: () => stopRequested,
      onProgress: (n) => { if (n % 50 === 0) say(`Listing the device… ${n}`); },
    });
    const toHash = [...device.values()].filter((e) => !e.isDir).length;
    log('info', `reading ${toHash} device files — roughly ${fmtDuration(Math.round(toHash * 0.22))}`);
    const t0 = Date.now();
    device = await hashDeviceIndex(client, deviceRoot(), device, {
      shouldStop: () => stopRequested,
      onProgress: (done, total) => {
        const rate = done / Math.max(1, (Date.now() - t0) / 1000);
        pbar.set(done, total, 'Reading device files', `${done}/${total} · ${fmtDuration(Math.round((total - done) / Math.max(rate, 0.01)))} left`);
      },
    });
    pbar.done();

    const report = compareByContent({ local, device });
    renderAudit(report, stopRequested);
    say(stopRequested ? 'Check stopped early — results are partial.' : 'Check complete.', stopRequested ? 'warn' : 'ok');
  } catch (err) {
    pbar.hide();
    say(`Check failed: ${err.message}`, 'err');
    log('err', err.message);
  }
  els.stop.hidden = true;
  idle(els.scan);
  refresh();
}

function renderAudit(r, partial) {
  els.step3.hidden = false;
  els.review.hidden = false;
  els.runPanel.hidden = true;
  els.warnBox.textContent = '';
  els.capBar.hidden = true;
  els.apply.disabled = true;
  els.rawPlanDrawer.hidden = true;

  if (partial) {
    const w = document.createElement('div');
    w.className = 'warnCard';
    w.textContent = 'Stopped early — this comparison is partial.';
    els.warnBox.append(w);
  }

  const clean = !r.missingLocally.length && !r.missingOnDevice.length;
  els.planCards.innerHTML = clean
    ? `<div class="empty" style="grid-column:1/-1">${icon('checkDouble')}
       <div class="eTitle">EVERYTHING MATCHES</div><p>Every dump exists on both sides, byte for byte.</p></div>`
    : [
        r.missingLocally.length ? `<div class="planCard warn"><b>${icon('download')}${r.missingLocally.length}</b><span class="cap">ONLY ON DEVICE</span></div>` : '',
        r.missingOnDevice.length ? `<div class="planCard warn"><b>${icon('upload')}${r.missingOnDevice.length}</b><span class="cap">ONLY IN FOLDER</span></div>` : '',
        r.variants.length ? `<div class="planCard muted"><b>${icon('sparkles')}${r.variants.length}</b><span class="cap">OTHER VARIANTS</span></div>` : '',
        r.relocated.length ? `<div class="planCard muted"><b>${icon('move')}${r.relocated.length}</b><span class="cap">MOVED</span></div>` : '',
      ].join('');

  els.drawers.textContent = '';
  const listDrawer = (label, ico, items, fmt) => {
    if (!items.length) return;
    const d = document.createElement('details');
    d.className = 'drawer';
    d.innerHTML = `<summary><span class="chev">${ICONS.chevronRight}</span>${icon(ico)}${label}<span class="n">${items.length}</span></summary><div class="body"><ul class="fileList"></ul></div>`;
    const ul = d.querySelector('ul');
    for (const item of items.slice(0, 300)) {
      const li = document.createElement('li');
      li.textContent = fmt(item);
      ul.append(li);
    }
    if (items.length > 300) {
      const li = document.createElement('li');
      li.textContent = `… and ${items.length - 300} more`;
      ul.append(li);
    }
    els.drawers.append(d);
  };
  listDrawer('ONLY ON DEVICE', 'download', r.missingLocally, (m) => `${m.relPath} · ${fmtBytes(m.size)}`);
  listDrawer('ONLY IN FOLDER', 'upload', r.missingOnDevice, (m) => `${m.relPath} · ${fmtBytes(m.size)}`);
  listDrawer('OTHER VARIANTS', 'sparkles', r.variants, (m) => `${m.id} — device: ${m.device.join(', ')} / local: ${m.local.join(', ')}`);
  listDrawer('MOVED', 'move', r.relocated, (m) => `device: ${m.device.join(', ')} / local: ${m.local.join(', ')}`);
  listDrawer('DUPLICATED ON DEVICE', 'copy', r.duplicateOnDevice, (d) => d.paths.join('  =  '));
  listDrawer('DUPLICATED LOCALLY', 'copy', r.duplicateLocally, (d) => d.paths.join('  =  '));
}

// ---- run log ---------------------------------------------------------------------------------

function runReport() {
  return JSON.stringify(lastRun ?? { error: 'nothing has been scanned yet' }, null, 2);
}

els.saveLog.addEventListener('click', () => {
  const blob = new Blob([runReport()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `allmiibo-sync-${lastRun?.operation ?? 'run'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

els.copyLog.addEventListener('click', async () => {
  if (!lastRun) { toast('Nothing scanned yet.', { kind: 'warn' }); return; }
  try {
    await navigator.clipboard.writeText(runReport());
    toast('Run log copied');
  } catch {
    toast("Couldn't copy — clipboard is blocked here.", { kind: 'err' });
  }
});

// Replays the tour on demand, whether or not it has been seen before.
els.stepHelp.addEventListener('click', async () => {
  const tour = await import('./tutorial.js');
  tour.start('sync');
});

els.stop.addEventListener('click', () => {
  stopRequested = true;
  log('warn', 'stopping…');
});

// The tour is a separate module loaded on demand, so a returning visitor never
// pays for it.
async function offerTour(page) {
  try {
    const tour = await import('./tutorial.js');
    tour.offer(page);
  } catch {
    // A tour that will not load is not worth a visible error.
  }
}

// ---- boot -------------------------------------------------------------------------------------

(async function boot() {
  for (const s of document.querySelectorAll('[data-ico]')) s.innerHTML = ICONS[s.dataset.ico] ?? '';

  const blocked =
    !window.isSecureContext ? 'OPEN OVER LOCALHOST OR HTTPS — Bluetooth is blocked on this address.'
    : !BleTransport.available ? 'SYNC NEEDS CHROME OR EDGE — Web Bluetooth isn\u2019t in this browser.'
    : !localfs.available() ? 'SYNC NEEDS CHROME OR EDGE — this browser can\u2019t read folders.'
    : null;
  if (blocked) {
    els.step1.hidden = true;
    els.step2.hidden = true;
    els.unsupported.hidden = false;
    els.unsupported.innerHTML = `<div class="empty">${icon('ship')}
      <div class="eTitle">${blocked.split(' — ')[0]}</div>
      <p>${blocked.split(' — ')[1]}</p>
      <button id="goBrowse">BROWSE THE COLLECTION</button></div>`;
    els.unsupported.querySelector('#goBrowse').addEventListener('click', () => { location.href = './collection.html'; });
    return;
  }

  renderOps();
  renderDeviceChip();

  const restored = await localfs.restoreDirectory();
  if (restored) {
    rootHandle = restored;
    log('info', `restored local folder: ${restored.name}`);
  } else {
    try {
      const cached = JSON.parse(sessionStorage.getItem('collectionScan'));
      if (cached?.folderName) lapsedFolderName = cached.folderName;
    } catch {}
  }
  renderFolderChip();
  refresh();

  // First visit only, and only once the page is usable — a spotlight over
  // controls behind an unsupported-browser notice would be worse than nothing,
  // which is why the blocked path above returns before reaching this.
  offerTour('sync');
})();
