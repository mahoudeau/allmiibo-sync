// Sync page: scan both sides, show a plan, then apply it on confirmation.
// Nothing is written until the plan has been reviewed and "Apply" is pressed.

import { BleTransport } from './ble.js';
import { AllmiiboClient } from './protocol.js';
import { planSync, flattenPlan } from './planner.js';
import { walkDevice, verifyDeviceHashes, applyPlan, ambiguousPaths } from './sync.js';
import * as localfs from './localfs.js';

const els = {};
for (const id of [
  'connect', 'disconnect', 'pickFolder', 'scan', 'apply', 'stop',
  'deviceRoot', 'mode', 'allowDelete', 'verify',
  'status', 'folderName', 'planBox', 'log', 'progress',
]) els[id] = document.getElementById(id);

let transport = null;
let client = null;
let rootHandle = null;
let plan = null;
let state = null;
let stopRequested = false;

const started = Date.now();

function log(level, ...parts) {
  const line = document.createElement('div');
  line.className = `line ${level}`;
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6, ' ');
  line.textContent = `${t}s  ${parts.join(' ')}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function refreshButtons() {
  const connected = !!transport?.connected;
  els.connect.disabled = connected;
  els.disconnect.disabled = !connected;
  els.scan.disabled = !(connected && rootHandle);
  els.apply.disabled = !(plan && hasWork(plan));
}

function hasWork(p) {
  return flattenPlan(p).length > 0;
}

function fmtDuration(seconds) {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

// ---- connection ---------------------------------------------------------

els.connect.addEventListener('click', async () => {
  try {
    setStatus('Requesting device…');
    transport = new BleTransport();
    client = new AllmiiboClient(transport, { log });
    transport.addEventListener('disconnected', () => {
      setStatus('Disconnected', 'warn');
      log('warn', 'device disconnected');
      refreshButtons();
    });
    const name = await transport.connect();
    const v = await client.getVersion();
    log('ok', `connected to "${name}" (firmware ${v.version})`);
    setStatus(`Connected: ${name} — firmware ${v.version}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
    log('err', err.message);
  }
  refreshButtons();
});

els.disconnect.addEventListener('click', () => transport?.disconnect());

// ---- local folder -------------------------------------------------------

els.pickFolder.addEventListener('click', async () => {
  try {
    rootHandle = await localfs.pickDirectory();
    els.folderName.textContent = rootHandle.name;
    log('ok', `local folder: ${rootHandle.name}`);
  } catch (err) {
    if (err.name !== 'AbortError') log('err', err.message);
  }
  refreshButtons();
});

// ---- scan and plan ------------------------------------------------------

els.scan.addEventListener('click', async () => {
  els.scan.disabled = true;
  plan = null;
  els.planBox.textContent = '';

  try {
    const deviceRoot = els.deviceRoot.value.trim() || 'E:/amiibo';
    const mode = els.mode.value;

    setStatus('Reading local folder…');
    state = await localfs.loadState(rootHandle);
    const local = await localfs.walkLocal(rootHandle, {
      onProgress: (n) => { if (n % 100 === 0) setStatus(`Reading local folder… ${n} files`); },
    });
    log('ok', `local: ${count(local)} files, ${countDirs(local)} folders`);

    setStatus('Reading device…');
    const device = await walkDevice(client, deviceRoot, {
      onProgress: (n) => { if (n % 50 === 0) setStatus(`Reading device… ${n} files`); },
    });
    log('ok', `device: ${count(device)} files, ${countDirs(device)} folders under ${deviceRoot}`);

    const options = { mode, delete: els.allowDelete.checked };
    plan = planSync({ local, device, state, deviceRoot, options });

    // Same-size files with no sync record cannot be compared without reading
    // the device copy. Only do that when asked — it costs ~0.2 s each.
    if (plan.ambiguous.length > 0 && els.verify.checked) {
      const paths = ambiguousPaths(plan);
      log('info', `verifying ${paths.length} files by reading them back…`);
      const hashes = await verifyDeviceHashes(client, deviceRoot, paths, {
        onProgress: (done, total) => setStatus(`Verifying ${done}/${total}…`),
      });
      for (const [p, h] of hashes) {
        const existing = device.get(p);
        if (existing) device.set(p, { ...existing, hash: h });
      }
      plan = planSync({ local, device, state, deviceRoot, options });
    }

    renderPlan(plan);
    setStatus(hasWork(plan) ? 'Plan ready — review, then Apply' : 'Already in sync', hasWork(plan) ? '' : 'ok');
  } catch (err) {
    setStatus(`Scan failed: ${err.message}`, 'err');
    log('err', err.message);
  }
  refreshButtons();
});

function count(index) {
  let n = 0;
  for (const e of index.values()) if (!e.isDir) n++;
  return n;
}
function countDirs(index) {
  let n = 0;
  for (const e of index.values()) if (e.isDir) n++;
  return n;
}

function renderPlan(p) {
  const lines = [];
  const section = (title, items, fmt) => {
    if (!items.length) return;
    lines.push(`${title} (${items.length})`);
    for (const item of items.slice(0, 200)) lines.push(`   ${fmt(item)}`);
    if (items.length > 200) lines.push(`   … and ${items.length - 200} more`);
    lines.push('');
  };

  lines.push(`mode: ${p.mode}   device root: ${p.deviceRoot}`);
  lines.push(`estimated time: ${fmtDuration(p.stats.estimatedSeconds)} at the measured ~2 KB/s`);
  lines.push('');

  for (const w of p.warnings) {
    lines.push(`WARNING  ${w}`);
    lines.push('');
  }

  section('CREATE FOLDER on device', p.mkdirDevice, (m) => m.relPath);
  section('CREATE FOLDER locally', p.mkdirLocal, (m) => m.relPath);
  section('MOVE on device (rename, no re-upload)', p.moveDevice, (m) => `${m.from}  →  ${m.to}`);
  section('UPLOAD to device', p.upload, (u) => `${u.relPath}  (${u.size} B)`);
  section('DOWNLOAD to local', p.download, (d) => `${d.relPath}  (${d.size} B)`);
  section('DELETE on device', p.deleteDevice, (d) => d.relPath);
  section('DELETE locally', p.deleteLocal, (d) => d.relPath);
  section('REMOVE FOLDER on device', p.rmdirDevice, (d) => d.relPath);
  section(
    `NOT DELETED — enable "Propagate deletions" to remove these`,
    p.wouldDelete,
    (d) => `${d.relPath}  (on ${d.side})`
  );
  section('CONFLICT — nothing will be changed', p.conflicts, (c) => `${c.relPath}  — ${c.reason}`);
  section('BLOCKED — will not fit on the device', p.blocked, (b) => `${b.relPath}  — ${b.reason}`);
  section('SKIPPED — cannot tell without verifying', p.ambiguous, (a) => `${a.relPath}  — ${a.reason}`);

  lines.push(`unchanged: ${p.stats.unchanged}`);
  if (!hasWork(p)) lines.push('\nNothing to do.');

  els.planBox.textContent = lines.join('\n');
}

// ---- apply --------------------------------------------------------------

els.apply.addEventListener('click', async () => {
  if (!plan) return;

  const destructive = plan.deleteDevice.length + plan.deleteLocal.length + plan.rmdirDevice.length;
  if (destructive > 0) {
    const detail = [
      `${plan.deleteDevice.length} file(s) deleted on the device`,
      `${plan.deleteLocal.length} file(s) deleted locally`,
      `${plan.rmdirDevice.length} folder(s) removed on the device`,
    ].join('\n');
    if (!confirm(`This will permanently delete:\n\n${detail}\n\nThis cannot be undone. Continue?`)) {
      log('warn', 'apply cancelled');
      return;
    }
  }

  const ops = flattenPlan(plan);
  stopRequested = false;
  els.apply.disabled = true;
  els.scan.disabled = true;
  els.stop.disabled = false;

  log('info', `applying ${ops.length} operations…`);
  const t0 = Date.now();

  const result = await applyPlan({
    client,
    rootHandle,
    deviceRoot: plan.deviceRoot,
    state,
    ops,
    callbacks: {
      onOp: (op, i, total) => {
        const label = op.op === 'moveDevice' ? `${op.from} → ${op.to}` : op.relPath;
        setStatus(`${i + 1}/${total}  ${op.op}  ${label}`);
        els.progress.value = ((i + 1) / total) * 100;
      },
      onError: (message) => log('err', message),
      shouldStop: () => stopRequested,
    },
  });

  const secs = Math.round((Date.now() - t0) / 1000);
  els.stop.disabled = true;
  els.progress.value = 0;

  const summary = `${result.completed} done, ${result.failed} failed in ${fmtDuration(secs)}`;
  if (result.stopped) {
    setStatus(`Stopped — ${summary}`, 'warn');
    log('warn', `stopped by request — ${summary}. State saved; re-scan to resume.`);
  } else if (result.failed > 0) {
    setStatus(`Finished with errors — ${summary}`, 'err');
    log('err', `finished with errors — ${summary}`);
  } else {
    setStatus(`Sync complete — ${summary}`, 'ok');
    log('ok', `sync complete — ${summary}`);
  }

  plan = null;
  els.planBox.textContent += '\n\n(applied — re-scan to see the current state)';
  refreshButtons();
});

els.stop.addEventListener('click', () => {
  stopRequested = true;
  log('warn', 'stopping after the current operation…');
});

// ---- boot ---------------------------------------------------------------

(async function boot() {
  if (!BleTransport.available) {
    setStatus('Web Bluetooth unavailable — use Chrome or Edge over http://localhost', 'err');
    els.connect.disabled = true;
    return;
  }
  if (!localfs.available()) {
    setStatus('File System Access API unavailable — use Chrome or Edge', 'err');
    els.pickFolder.disabled = true;
    return;
  }
  if (!window.isSecureContext) {
    setStatus('Insecure context — open via http://localhost, not file://', 'err');
    els.connect.disabled = true;
    return;
  }

  const restored = await localfs.restoreDirectory();
  if (restored) {
    rootHandle = restored;
    els.folderName.textContent = restored.name;
    log('info', `restored local folder: ${restored.name}`);
  }
  setStatus('Ready');
  refreshButtons();
})();
