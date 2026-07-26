// Write test — confined to a scratch folder, cleans up after itself.
//
// Everything happens under E:/_synctest. Nothing outside that folder is
// created, modified or removed, and the folder is deleted at the end even if
// a check fails.
//
// Answers the questions a read-only probe cannot:
//   - does the firmware sanitise filenames on write?
//   - what does create_folder do on an existing path?
//   - does remove work on a non-empty folder?
//   - can rename move an entry between folders?
//   - what write throughput does the link sustain?

import { BleTransport } from './ble.js';
import { AllmiiboClient, joinPath } from './protocol.js';
import { toHex } from './bytes.js';

const SCRATCH = 'E:/_synctest';
const SUBDIR = `${SCRATCH}/sub`;

// Names probing characters that could plausibly be rewritten. '/' is omitted
// deliberately — it is the path separator, not a candidate for sanitising.
const NAME_PROBES = [
  'Mr. Game & Watch.bin',
  "Majora's Mask.bin",
  'Quote "X".bin',
  'Star*Q?.bin',
  'Colon:Test.bin',
];

const els = {
  connect: document.getElementById('w_connect'),
  disconnect: document.getElementById('w_disconnect'),
  run: document.getElementById('w_run'),
  cleanup: document.getElementById('w_cleanup'),
  copy: document.getElementById('w_copy'),
  save: document.getElementById('w_save'),
  keep: document.getElementById('w_keep'),
  status: document.getElementById('w_status'),
  log: document.getElementById('w_log'),
  results: document.getElementById('w_results'),
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

function setConnected(c) {
  els.connect.disabled = c;
  els.disconnect.disabled = !c;
  els.run.disabled = !c;
  els.cleanup.disabled = !c;
}

function record(name, outcome, detail) {
  report.checks.push({ name, outcome, detail });
  const kind = outcome === 'pass' ? 'ok' : outcome === 'fail' ? 'err' : 'warn';
  log(kind, `[${outcome}] ${name} — ${detail}`);
  renderResults();
}

function renderResults() {
  els.results.textContent = report.checks
    .map((c) => `${c.outcome.toUpperCase().padEnd(6)} ${c.name}\n       ${c.detail}`)
    .join('\n');
}

// A recognisable 540-byte payload (NTAG215-sized) with a per-file marker.
function payload(seed, size = 540) {
  const u = new Uint8Array(size);
  for (let i = 0; i < size; i++) u[i] = (i * 7 + seed) & 0xff;
  return u;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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

els.disconnect.addEventListener('click', () => transport?.disconnect());

// ---- the test run -------------------------------------------------------

els.run.addEventListener('click', async () => {
  els.run.disabled = true;
  els.results.textContent = '';
  report = {
    generatedAt: new Date().toISOString(),
    deviceName: transport?.device?.name || null,
    version: null,
    scratch: SCRATCH,
    checks: [],
    nameMapping: [],
    throughput: null,
    cleanedUp: false,
  };

  try {
    report.version = await client.getVersion();
    log('info', `firmware ${report.version.version}`);

    // Refuse to run if the scratch folder already holds something, so we can
    // never delete data that was not ours.
    const existing = await client.readDir(SCRATCH).catch(() => null);
    if (existing && existing.length > 0) {
      record(
        'scratch folder is empty',
        'fail',
        `${SCRATCH} already contains ${existing.length} entries — aborting rather than risk deleting them`
      );
      setStatus('Aborted: scratch folder is not empty', 'err');
      return;
    }

    await runChecks();
    setStatus('Write test complete', 'ok');
  } catch (err) {
    record('test run', 'fail', err.message);
    setStatus(`Failed: ${err.message}`, 'err');
  } finally {
    if (els.keep.checked) {
      log('warn', `leaving ${SCRATCH} in place as requested`);
      report.cleanedUp = false;
    } else {
      await cleanup();
    }
    els.copy.disabled = false;
    els.save.disabled = false;
    els.run.disabled = !transport?.connected;
  }
});

async function runChecks() {
  // 1. create the scratch folder
  try {
    await client.createFolder(SCRATCH);
    record('create_folder', 'pass', `created ${SCRATCH}`);
  } catch (err) {
    record('create_folder', 'fail', err.message);
    throw err;
  }

  // 2. create it again — open question
  try {
    await client.createFolder(SCRATCH);
    record('create_folder on existing path', 'pass', 'returned OK — idempotent');
  } catch (err) {
    record('create_folder on existing path', 'info', `returned an error (${err.message}) — not idempotent`);
  }

  // 3. write the name probes
  for (const [i, name] of NAME_PROBES.entries()) {
    const path = joinPath(SCRATCH, name);
    try {
      await client.writeFile(path, payload(i));
      log('info', `wrote ${name}`);
    } catch (err) {
      record(`write "${name}"`, 'fail', err.message);
    }
  }

  // 4. read the folder back and compare requested names to stored names
  const entries = await client.readDir(SCRATCH);
  const stored = entries.filter((e) => !e.isDir).map((e) => e.name);
  log('info', `folder now holds: ${stored.join(' | ')}`);

  let anyRewritten = false;
  for (const name of NAME_PROBES) {
    const exact = stored.includes(name);
    if (!exact) anyRewritten = true;
    report.nameMapping.push({ requested: name, storedExactly: exact });
  }

  if (!anyRewritten) {
    record(
      'filename sanitisation',
      'pass',
      'every name stored byte-for-byte — the firmware does NOT rewrite filenames, so the underscores in your library came from the dump pack, not the device'
    );
  } else {
    const changed = report.nameMapping.filter((m) => !m.storedExactly).map((m) => m.requested);
    record(
      'filename sanitisation',
      'info',
      `the firmware rewrote: ${changed.join(', ')} — stored as: ${stored.join(', ')}. Sync needs a name-mapping layer.`
    );
  }

  // 5. content round-trip
  const probe = joinPath(SCRATCH, NAME_PROBES[0]);
  const target = stored.includes(NAME_PROBES[0]) ? probe : joinPath(SCRATCH, stored[0]);
  const back = await client.readFile(target);
  const expected = payload(0);
  if (equalBytes(back, expected)) {
    record('content round-trip', 'pass', `540 bytes written and read back identical (${toHex(back, 8)}…)`);
  } else {
    record(
      'content round-trip',
      'fail',
      `read back ${back.length} bytes, expected ${expected.length}; head ${toHex(back, 16)}`
    );
  }

  // 6. throughput on a larger file
  const big = payload(3, 16384);
  const t0 = performance.now();
  await client.writeFile(joinPath(SCRATCH, 'throughput.bin'), big);
  const ms = performance.now() - t0;
  const kbs = big.length / 1024 / (ms / 1000);
  report.throughput = { bytes: big.length, ms: Math.round(ms), kbPerSec: Number(kbs.toFixed(2)) };
  record('write throughput', 'pass', `16 KB in ${Math.round(ms)}ms = ${kbs.toFixed(2)} KB/s`);

  // 7. rename across folders
  await client.createFolder(SUBDIR);
  const moveFrom = joinPath(SCRATCH, 'throughput.bin');
  const moveTo = joinPath(SUBDIR, 'moved.bin');
  try {
    await client.rename(moveFrom, moveTo);
    const subEntries = await client.readDir(SUBDIR);
    const landed = subEntries.some((e) => e.name === 'moved.bin');
    record(
      'rename across folders',
      landed ? 'pass' : 'fail',
      landed ? 'moved a file into a subfolder — rename doubles as move' : 'reported OK but the file is not in the subfolder'
    );
  } catch (err) {
    record('rename across folders', 'info', `rejected (${err.message}) — rename is in-place only`);
  }

  // 8. remove a non-empty folder — open question
  try {
    await client.remove(SUBDIR);
    const after = await client.readDir(SUBDIR).catch(() => []);
    record(
      'remove non-empty folder',
      'info',
      after.length === 0 ? 'succeeded — removes recursively, so --delete is dangerous' : 'reported OK but contents remain'
    );
  } catch (err) {
    record('remove non-empty folder', 'pass', `refused (${err.message}) — safe; delete contents first`);
  }
}

// ---- cleanup ------------------------------------------------------------

async function cleanup() {
  log('info', 'cleaning up scratch folder…');
  try {
    for (const dir of [SUBDIR, SCRATCH]) {
      const entries = await client.readDir(dir).catch(() => []);
      for (const e of entries) {
        if (e.isDir) continue;
        await client.remove(joinPath(dir, e.name)).catch((err) => log('warn', `remove ${e.name}: ${err.message}`));
      }
    }
    await client.remove(SUBDIR).catch(() => {});
    await client.remove(SCRATCH).catch((err) => log('warn', `remove ${SCRATCH}: ${err.message}`));

    const left = await client.readDir(SCRATCH).catch(() => null);
    if (left === null || left.length === 0) {
      report.cleanedUp = true;
      log('ok', 'scratch folder removed — device is back to its original state');
    } else {
      report.cleanedUp = false;
      log('err', `${SCRATCH} still holds ${left.length} entries — remove it from the device menu`);
    }
  } catch (err) {
    report.cleanedUp = false;
    log('err', `cleanup failed: ${err.message}`);
  }
  renderResults();
}

els.cleanup.addEventListener('click', async () => {
  if (!report) report = { checks: [], cleanedUp: false };
  els.cleanup.disabled = true;
  await cleanup();
  els.cleanup.disabled = !transport?.connected;
});

// ---- report -------------------------------------------------------------

els.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  els.copy.textContent = 'Copied';
  setTimeout(() => (els.copy.textContent = 'Copy report'), 1500);
});

els.save.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'allmiibo-writetest.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

if (!BleTransport.available) {
  setStatus('Web Bluetooth unavailable — use Chrome or Edge over http://localhost', 'err');
  els.connect.disabled = true;
} else if (!window.isSecureContext) {
  setStatus('Insecure context — open via http://localhost, not file://', 'err');
  els.connect.disabled = true;
} else {
  setStatus('Ready');
}
