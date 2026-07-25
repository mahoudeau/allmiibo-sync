// Read-only hardware probe.
//
// Deliberately issues no writes: no create, remove, rename, format, meta
// update or DFU. It connects, identifies the device, walks the filesystem and
// optionally reads one file back to exercise the download path.

import { BleTransport } from './ble.js';
import { AllmiiboClient, joinPath, driveRoot } from './protocol.js';
import { toHex } from './bytes.js';

const els = {
  connect: document.getElementById('connect'),
  disconnect: document.getElementById('disconnect'),
  probe: document.getElementById('probe'),
  copy: document.getElementById('copy'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
  tree: document.getElementById('tree'),
  maxDepth: document.getElementById('maxDepth'),
  readSample: document.getElementById('readSample'),
};

let transport = null;
let client = null;
let report = null;

const started = Date.now();

function log(level, ...parts) {
  const line = document.createElement('div');
  line.className = `line ${level}`;
  const t = ((Date.now() - started) / 1000).toFixed(2).padStart(6, ' ');
  line.textContent = `${t}s  ${parts.join(' ')}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function setConnected(isConnected) {
  els.connect.disabled = isConnected;
  els.disconnect.disabled = !isConnected;
  els.probe.disabled = !isConnected;
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
      setConnected(false);
    });

    const name = await transport.connect();
    log('ok', `connected to "${name || '(unnamed)'}"`);
    setStatus(`Connected: ${name || '(unnamed)'}`, 'ok');
    setConnected(true);
  } catch (err) {
    setStatus(err.message, 'err');
    log('err', err.message);
    setConnected(false);
  }
});

els.disconnect.addEventListener('click', () => {
  transport?.disconnect();
});

// ---- probe --------------------------------------------------------------

els.probe.addEventListener('click', async () => {
  els.probe.disabled = true;
  els.tree.textContent = '';

  report = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    deviceName: transport?.device?.name || null,
    version: null,
    drives: null,
    tree: null,
    sampleRead: null,
    stats: { dirs: 0, files: 0, totalBytes: 0, readDirCalls: 0, errors: 0 },
    errors: [],
  };

  try {
    await step('get_version', async () => {
      report.version = await client.getVersion();
      log('ok', `version: ${JSON.stringify(report.version)}`);
    });

    await step('vfs_get_drive_list', async () => {
      report.drives = await client.getDriveList();
      log('ok', `drives: ${JSON.stringify(report.drives)}`);
      if (report.drives.count > 1) {
        log('warn', `device reports ${report.drives.count} drives — the official client only reads the first`);
      }
    });

    const drives = report.drives?.drives ?? [];
    if (drives.length === 0) throw new Error('no drive reported; cannot walk filesystem');

    const maxDepth = Math.max(1, Number(els.maxDepth.value) || 4);
    report.tree = [];

    for (const drive of drives) {
      // Roots come from the drive label ('I' internal, 'E' external), not the
      // human-readable name.
      const root = driveRoot(drive);

      if (drive.status !== 0) {
        log('warn', `skipping drive ${root} ("${drive.name}") — status ${drive.status}, not available`);
        report.tree.push({ root, name: drive.name, skipped: true, status: drive.status });
        continue;
      }

      log('info', `walking ${root} ("${drive.name}", ${drive.usedSize} of ${drive.totalSize} bytes used)`);
      const children = await walk(root, 0, maxDepth);
      report.tree.push({ root, name: drive.name, children });
    }

    renderTree(report.tree);

    log(
      'ok',
      `walk complete: ${report.stats.dirs} folders, ${report.stats.files} files, ` +
        `${report.stats.totalBytes} bytes, ${report.stats.readDirCalls} read_dir calls`
    );

    if (els.readSample.checked) {
      const sample = firstFile(report.tree);
      if (!sample) {
        log('warn', 'no file found to sample');
      } else {
        await step(`vfs_read_file ${sample.path}`, async () => {
          const t0 = performance.now();
          const bytes = await client.readFile(sample.path);
          const ms = performance.now() - t0;
          report.sampleRead = {
            path: sample.path,
            reportedSize: sample.size,
            actualSize: bytes.length,
            matches: bytes.length === sample.size,
            head: toHex(bytes, 32),
            elapsedMs: Math.round(ms),
          };
          log(
            report.sampleRead.matches ? 'ok' : 'warn',
            `read ${bytes.length} bytes in ${Math.round(ms)}ms ` +
              `(read_dir reported ${sample.size}) head=${toHex(bytes, 16)}`
          );
        });
      }
    }

    setStatus('Probe complete', 'ok');
    els.copy.disabled = false;
    els.save.disabled = false;
  } catch (err) {
    report.stats.errors++;
    report.errors.push(String(err.message || err));
    setStatus(`Probe failed: ${err.message}`, 'err');
    log('err', err.message);
    els.copy.disabled = false;
    els.save.disabled = false;
  } finally {
    els.probe.disabled = !transport?.connected;
  }
});

async function step(label, fn) {
  log('info', `→ ${label}`);
  try {
    await fn();
  } catch (err) {
    report.stats.errors++;
    report.errors.push(`${label}: ${err.message}`);
    log('err', `${label}: ${err.message}`);
    throw err;
  }
}

async function walk(path, depth, maxDepth) {
  report.stats.readDirCalls++;

  let entries;
  const t0 = performance.now();
  try {
    entries = await client.readDir(path);
  } catch (err) {
    report.stats.errors++;
    report.errors.push(`read_dir ${path}: ${err.message}`);
    log('err', `read_dir ${path}: ${err.message}`);
    return [];
  }
  const ms = Math.round(performance.now() - t0);

  const files = entries.filter((e) => !e.isDir).length;
  const dirs = entries.length - files;
  log('info', `  ${path} — ${entries.length} entries (${files} files, ${dirs} folders) in ${ms}ms`);

  // VFS_MAX_FOLDER_SIZE is 32 in firmware; flag folders at or above it.
  if (entries.length >= 32) {
    log('warn', `  ${path} holds ${entries.length} entries — at or above the firmware's 32-entry guide`);
  }

  const out = [];
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;

    const childPath = joinPath(path, entry.name);
    const node = {
      name: entry.name,
      path: childPath,
      size: entry.size,
      type: entry.type,
      isDir: entry.isDir,
      meta: entry.meta,
    };

    if (entry.isDir) {
      report.stats.dirs++;
      if (depth + 1 < maxDepth) {
        node.children = await walk(childPath, depth + 1, maxDepth);
      } else {
        node.truncated = true;
        log('warn', `depth limit reached, not descending into ${childPath}`);
      }
    } else {
      report.stats.files++;
      report.stats.totalBytes += entry.size;
    }
    out.push(node);
  }
  return out;
}

// Shallowest file first, so the sample read stays cheap.
function firstFile(nodes) {
  const list = nodes ?? [];
  for (const n of list) {
    if (n.isDir === false) return n;
  }
  for (const n of list) {
    if (n.children) {
      const found = firstFile(n.children);
      if (found) return found;
    }
  }
  return null;
}

function renderTree(driveNodes) {
  const lines = [];
  const render = (list, prefix) => {
    list.forEach((n, i) => {
      const last = i === list.length - 1;
      const branch = last ? '└─ ' : '├─ ';
      const notes = n.meta?.notes ? `  “${n.meta.notes}”` : '';
      const hidden = n.meta?.flags?.hide ? '  [hidden]' : '';
      const size = n.isDir ? '' : `  ${n.size} B`;
      const trunc = n.truncated ? '  …(not descended)' : '';
      lines.push(`${prefix}${branch}${n.name}${n.isDir ? '/' : ''}${size}${notes}${hidden}${trunc}`);
      if (n.children) render(n.children, prefix + (last ? '   ' : '│  '));
    });
  };
  for (const drive of driveNodes) {
    const flag = drive.skipped ? `  [unavailable, status ${drive.status}]` : '';
    lines.push(`${drive.root}  (${drive.name})${flag}`);
    if (drive.children?.length) render(drive.children, '');
    else if (!drive.skipped) lines.push('   (empty)');
  }
  els.tree.textContent = lines.join('\n') || '(empty)';
}

// ---- report output ------------------------------------------------------

els.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  els.copy.textContent = 'Copied';
  setTimeout(() => (els.copy.textContent = 'Copy report'), 1500);
});

els.save.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'allmiibo-probe.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---- boot ---------------------------------------------------------------

if (!BleTransport.available) {
  setStatus('Web Bluetooth unavailable — use Chrome or Edge, served over http://localhost', 'err');
  els.connect.disabled = true;
} else if (!window.isSecureContext) {
  setStatus('Insecure context — open this page via http://localhost, not file://', 'err');
  els.connect.disabled = true;
} else {
  setStatus('Ready');
}
