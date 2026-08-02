// Debug-page UI for the rescue engine. The loop itself lives in rescue.js so
// it can be tested without a browser; this file is buttons, status and a report.
//
// A raw path box rather than the folder picker: pickDeviceFolder lists as it
// navigates and simply refuses to enter a folder that will not open, which is
// every folder this tool exists for.

import { BleTransport } from './ble.js';
import { AllmiiboClient, driveRoot } from './protocol.js';
import { statusCtl, progressCtl, busy, idle, toast } from './ui.js';
import { confirmDialog } from './dialog.js';
import { rescueFolder, findRescueStaging, driveRootOf } from './rescue.js';

const els = {
  connect: document.getElementById('r_connect'),
  disconnect: document.getElementById('r_disconnect'),
  path: document.getElementById('r_path'),
  rescue: document.getElementById('r_rescue'),
  stop: document.getElementById('r_stop'),
  erase: document.getElementById('r_erase'),
  force: document.getElementById('r_force'),
  status: document.getElementById('r_status'),
  pbar: document.getElementById('r_pbar'),
  results: document.getElementById('r_results'),
  log: document.getElementById('r_log'),
  copy: document.getElementById('r_copy'),
  save: document.getElementById('r_save'),
};

const status = statusCtl(els.status);
const pbar = progressCtl(els.pbar);
const started = Date.now();

let transport = null;
let client = null;
let report = null;
let stopRequested = false;

function log(level, ...parts) {
  const line = document.createElement('div');
  line.className = `line ${level}`;
  const t = ((Date.now() - started) / 1000).toFixed(2).padStart(6, ' ');
  line.textContent = `${t}s  ${parts.join(' ')}`;
  els.log.append(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function setConnected(on) {
  els.connect.disabled = on;
  els.disconnect.disabled = !on;
  els.rescue.disabled = !on;
  refreshErase();
}

// Erasing is only offered once a rescue has run, because "nothing was moved"
// and "nothing could be read" look identical from the outside otherwise.
function refreshErase() {
  const connected = !!transport?.connected;
  els.erase.disabled = !connected || (!report && !els.force.checked);
}

els.force.addEventListener('change', refreshErase);

function renderResults(r) {
  if (!r) { els.results.textContent = '(not yet run)'; return; }
  const lines = [
    `folder      ${r.path}`,
    `staging     ${r.staging}`,
    `passes      ${r.passes}`,
    `moved       ${r.rescued.length}`,
    `failed      ${r.failed.length}`,
    `subfolders  ${r.folders.length ? r.folders.join(', ') : '(none)'}`,
    `outcome     ${outcomeOf(r)}`,
  ];
  if (r.failed.length) {
    lines.push('', 'could not be moved:');
    for (const f of r.failed) lines.push(`  ${f.name}  (${f.error})`);
  }
  if (r.rescued.length) {
    lines.push('', 'moved:');
    for (const m of r.rescued.slice(0, 200)) lines.push(`  ${m.from}  →  ${m.to}`);
    if (r.rescued.length > 200) lines.push(`  … and ${r.rescued.length - 200} more (full list in the report JSON)`);
  }
  els.results.textContent = lines.join('\n');
}

function outcomeOf(r) {
  if (!r.recoverable) return 'nothing readable — see the log';
  if (r.complete) return r.rescued.length ? 'folder lists cleanly again' : 'folder was already fine';
  if (r.stalled) return 'stalled — everything reachable is out';
  return 'incomplete';
}

// ---- connection ---------------------------------------------------------

els.connect.addEventListener('click', async () => {
  try {
    status.set('Requesting device…');
    transport = new BleTransport();
    client = new AllmiiboClient(transport, { log });

    transport.addEventListener('disconnected', () => {
      status.set('Disconnected', 'warn');
      log('warn', 'device disconnected');
      setConnected(false);
    });

    const name = await transport.connect();
    log('ok', `connected to "${name || '(unnamed)'}"`);
    status.set(`Connected: ${name || '(unnamed)'}`, 'ok');
    setConnected(true);

    // Tell them straight away if a previous run left files parked, so a second
    // rescue does not look like it silently did nothing.
    const drives = await client.getDriveList().catch(() => null);
    const root = drives?.drives?.[0] ? driveRoot(drives.drives[0]) : 'E:/';
    const staged = await findRescueStaging(client, root);
    if (staged.present) {
      log('warn', `${staged.path} already holds about ${staged.files} rescued file(s) ` +
        `in ${staged.batches} folder(s) — a new rescue carries on from there`);
    }
  } catch (err) {
    status.set(err.message, 'err');
    log('err', err.message);
    setConnected(false);
  }
});

els.disconnect.addEventListener('click', () => transport?.disconnect());
els.stop.addEventListener('click', () => { stopRequested = true; });

// ---- rescue -------------------------------------------------------------

els.rescue.addEventListener('click', async () => {
  const path = els.path.value.trim().replace(/\/+$/, '');
  try {
    driveRootOf(path);
  } catch {
    status.set(`Not a device path: ${path}`, 'err');
    return;
  }

  stopRequested = false;
  busy(els.rescue, 'RESCUING');
  els.stop.hidden = false;
  try {
    report = await rescueFolder({
      client,
      path,
      shouldStop: () => stopRequested,
      on: {
        status: (t) => status.set(t),
        log,
        progress: (done, total, label, detail) => pbar.set(done, total, label, detail),
      },
    });
    pbar.done();
    renderResults(report);
    els.copy.disabled = false;
    els.save.disabled = false;

    if (!report.recoverable) {
      status.set('Nothing in that folder could be read', 'err');
    } else if (report.complete) {
      status.set(report.rescued.length
        ? `${report.rescued.length} moved — ${path} lists cleanly again`
        : `${path} lists fine; nothing to rescue`, 'ok');
    } else {
      status.set(`${report.rescued.length} moved — the rest is unreachable`, 'warn');
    }
  } catch (err) {
    pbar.hide();
    if (err.stopped) {
      status.set('Rescue stopped. Everything moved so far is safe.', 'warn');
    } else {
      status.set(`Rescue failed: ${err.message}`, 'err');
      log('err', err.message);
    }
  } finally {
    els.stop.hidden = true;
    idle(els.rescue);
    refreshErase();
  }
});

// ---- erase --------------------------------------------------------------

els.erase.addEventListener('click', async () => {
  const path = els.path.value.trim().replace(/\/+$/, '');
  const rescued = report?.rescued.length ?? 0;

  const ok = await confirmDialog({
    title: `ERASE ${path}?`,
    // The zero-rescued wording is the one that matters: that is the case where
    // the user destroys contents nobody has been able to enumerate, and the
    // dialog must not imply a backup exists.
    body: rescued
      ? `${rescued} files are safe in ${report.staging} and already out of this folder. ` +
        `Anything still in ${path} could not be read, so it was never moved — and erasing takes it ` +
        `with the folder.`
      : `Nothing has been moved out of ${path}. If the device could not read its contents, ` +
        `erasing destroys files no one has seen.`,
    detail: [
      `${path} and everything inside it`,
      'Removing a folder on the device deletes its contents too',
      'This cannot be undone',
    ],
    confirmLabel: rescued ? 'ERASE THE REST' : 'ERASE UNREAD',
    danger: true,
  });
  if (!ok) { log('warn', 'erase cancelled'); return; }

  busy(els.erase, 'ERASING');
  try {
    await client.remove(path);
    log('ok', `removed ${path}`);
    status.set(`${path} erased`, 'ok');
    toast(`${path} erased`, { kind: 'ok' });
  } catch (err) {
    status.set(`Erase failed: ${err.message}`, 'err');
    log('err', err.message);
  } finally {
    idle(els.erase);
  }
});

// ---- report output ------------------------------------------------------

els.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(reportJson(), null, 2));
  els.copy.textContent = 'Copied';
  setTimeout(() => (els.copy.textContent = 'Copy report'), 1500);
});

els.save.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(reportJson(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'allmiibo-repair.json';
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 2000);
});

function reportJson() {
  return {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    deviceName: transport?.device?.name ?? null,
    ...report,
    outcome: report ? outcomeOf(report) : null,
  };
}

// ---- boot ---------------------------------------------------------------

// debug.html#repair?path=E:/amiibo — the sync page links here with the folder
// it could not read already filled in.
const hash = location.hash.slice(1);
const q = hash.includes('?') ? new URLSearchParams(hash.slice(hash.indexOf('?') + 1)) : null;
if (q?.get('path')) els.path.value = q.get('path');

if (!BleTransport.available) {
  status.set('Web Bluetooth unavailable — use Chrome or Edge, served over http://localhost', 'err');
  els.connect.disabled = true;
} else if (!window.isSecureContext) {
  status.set('Insecure context — open this page via http://localhost, not file://', 'err');
  els.connect.disabled = true;
} else {
  status.set('Ready');
}
