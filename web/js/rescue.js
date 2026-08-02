// Recovering a folder the device will not finish listing.
//
// `read_dir` is the only way to learn a filename, and `open_file` needs a full
// path — so a listing that returns nothing leaves its contents unreachable by
// any client, and erasing that folder destroys data no one can read. That is
// the honest ceiling on what recovery can do, and it is why the erase step is
// worded the way it is.
//
// A listing that returns *some* frames before the device goes quiet is a
// different matter. Those bytes are real entries (protocol.js keeps them on a
// timeout rather than dropping them with the reassembly buffer), and a name is
// all `open_file` needs. Move those files out and the listing gets shorter, so
// the next attempt reads further. Repeat until it completes or stops making
// progress.
//
// Moving rather than downloading, for three reasons: `rename` is one command
// against read + verify + delete's three; a failed rename leaves the file
// exactly where it was, so there is never a moment when a file exists nowhere;
// and it needs no local folder, so someone who only wants their device working
// again never has to pick one. Getting the files onto a disk afterwards is an
// ordinary BACKUP of a tree that now lists perfectly well.

import { STAGING_PREFIX } from './planner.js';

export const STAGING = STAGING_PREFIX.replace(/\/$/, ''); // 'r_'

// Small enough that nothing we create can reproduce the problem we are fixing.
// PROTOCOL.md §7.2 records 100-entry folders listing without error on hardware;
// half that leaves room for a slower device than any we have measured.
export const BATCH_SIZE = 50;

// A zero-progress pass means the device stalls at the same entry every time, so
// everything reachable is already out. More attempts cannot find more.
const MAX_PASSES = 50;

/** 'E:/amiibo/deep' -> 'E:/'. */
export function driveRootOf(path) {
  const m = /^([A-Za-z]:\/)/.exec(path);
  if (!m) throw new Error(`not a device path: ${path}`);
  return m[1];
}

const batchOf = (counter) => Math.ceil(counter / BATCH_SIZE);
const stagedName = (counter) => `${String(counter).padStart(4, '0')}.bin`;

// Four digits, and a counter that runs across batches rather than restarting in
// each: every rescued file then has a name unique on its own, which keeps the
// report's from/to mapping unambiguous and makes merging batches later safe.
function stagedPath(driveRoot, counter) {
  return `${driveRoot}${STAGING}/${batchOf(counter)}/${stagedName(counter)}`;
}

/**
 * Report what the staging folder holds, cheaply enough to run on every connect.
 *
 * Two listings, not one per batch: the counter is continuous, so the last batch
 * is the only one that can be short.
 */
export async function findRescueStaging(client, driveRoot = 'E:/') {
  const root = await client.readDir(driveRoot).catch(() => null);
  if (!root) return { present: false, batches: 0, files: 0 };
  if (!root.some((e) => e.isDir && e.name === STAGING)) {
    return { present: false, batches: 0, files: 0 };
  }

  const batches = (await client.readDir(`${driveRoot}${STAGING}`).catch(() => []))
    .filter((e) => e.isDir && /^\d+$/.test(e.name))
    .map((e) => Number(e.name))
    .sort((a, b) => a - b);
  if (batches.length === 0) return { present: true, batches: 0, files: 0 };

  const last = batches[batches.length - 1];
  const lastEntries = await client.readDir(`${driveRoot}${STAGING}/${last}`).catch(() => []);
  const inLast = lastEntries.filter((e) => !e.isDir).length;
  return {
    present: true,
    batches: batches.length,
    files: (batches.length - 1) * BATCH_SIZE + inLast,
    path: `${driveRoot}${STAGING}`,
  };
}

// Where to resume. An aborted run leaves a staging tree behind; continuing at
// the next free number is safer than reusing one, since a rename onto an
// existing name is not something the protocol lets us reason about.
async function resumePoint(client, driveRoot) {
  const found = await findRescueStaging(client, driveRoot);
  if (!found.present) return { nextCounter: 1, existingBatches: new Set(), rootExists: false };

  const batches = (await client.readDir(`${driveRoot}${STAGING}`).catch(() => []))
    .filter((e) => e.isDir && /^\d+$/.test(e.name))
    .map((e) => Number(e.name));
  const existingBatches = new Set(batches);
  if (batches.length === 0) return { nextCounter: 1, existingBatches, rootExists: true };

  const last = Math.max(...batches);
  const names = (await client.readDir(`${driveRoot}${STAGING}/${last}`).catch(() => []))
    .filter((e) => !e.isDir)
    .map((e) => Number.parseInt(e.name, 10))
    .filter((n) => Number.isFinite(n));
  const highest = names.length ? Math.max(...names) : (last - 1) * BATCH_SIZE;
  return { nextCounter: highest + 1, existingBatches, rootExists: true };
}

/**
 * Drain a folder that will not list, one pass at a time, until it lists cleanly
 * or stops yielding anything new.
 *
 * One call does the whole job: the caller never has to run it again to get
 * further. Stopping is always safe — every file is either moved or untouched.
 *
 * @param {object}   ctx
 * @param {object}   ctx.client      AllmiiboClient
 * @param {string}   ctx.path        full device path of the stuck folder
 * @param {object}   [ctx.on]        {status, log, progress} — syncflow's shape
 * @param {Function} [ctx.shouldStop]
 */
export async function rescueFolder({ client, path, on = {}, shouldStop = () => false }) {
  const status = on.status ?? (() => {});
  const log = on.log ?? (() => {});
  const progress = on.progress ?? (() => {});

  const driveRoot = driveRootOf(path);
  const report = {
    path,
    staging: `${driveRoot}${STAGING}`,
    rescued: [],       // {from, to, size}
    failed: [],        // {name, error}
    folders: [],       // subfolders seen and deliberately left alone
    passes: 0,
    complete: false,   // the folder lists cleanly now
    stalled: false,    // a pass found nothing new
    recoverable: true, // false when the very first listing yielded nothing
  };

  const { nextCounter, existingBatches, rootExists } = await resumePoint(client, driveRoot);
  let counter = nextCounter;
  const batches = existingBatches;
  let rootMade = rootExists;
  if (counter > 1) log('info', `resuming into ${report.staging} at ${stagedName(counter)}`);

  // create_folder is not idempotent and "already exists" is indistinguishable
  // from a real failure (§9.3), so only ever create what a listing showed absent.
  const ensureBatch = async (batch) => {
    if (!rootMade) {
      await client.createFolder(`${driveRoot}${STAGING}`);
      rootMade = true;
    }
    if (batches.has(batch)) return;
    await client.createFolder(`${driveRoot}${STAGING}/${batch}`);
    batches.add(batch);
  };

  while (report.passes < MAX_PASSES) {
    if (shouldStop()) throw Object.assign(new Error('Stopped.'), { stopped: true });
    report.passes++;

    status(`Reading ${path}…`);
    const { entries, complete } = await client.readDirPartial(path);

    if (complete) {
      report.complete = true;
      log('ok', report.passes === 1
        ? `${path} listed cleanly — ${entries.length} entries, nothing to rescue`
        : `${path} lists cleanly again after ${report.rescued.length} moved`);
      break;
    }

    const files = entries.filter((e) => !e.isDir);
    for (const e of entries) {
      if (e.isDir && !report.folders.includes(e.name)) {
        report.folders.push(e.name);
        // Moving a folder rewrites every path beneath it, and it may be just as
        // unlistable as its parent. Point the tool at it separately.
        log('warn', `${e.name}/ is a folder — left alone; rescue it on its own`);
      }
    }

    if (files.length === 0) {
      if (report.passes === 1) {
        report.recoverable = false;
        log('err', `nothing in ${path} could be read: the device sent no usable entries. ` +
          'read_dir is the only way to learn a filename, so nothing in there is recoverable.');
      } else {
        report.stalled = true;
        log('warn', `pass ${report.passes} found nothing new — the device stalls at the same point`);
      }
      break;
    }

    log('info', `pass ${report.passes}: ${files.length} entries recovered from a stalled listing`);
    let movedThisPass = 0;

    for (const [i, e] of files.entries()) {
      if (shouldStop()) throw Object.assign(new Error('Stopped.'), { stopped: true });

      const from = `${path}/${e.name}`;
      const to = stagedPath(driveRoot, counter);
      progress(i + 1, files.length, 'Rescuing', `${report.rescued.length + 1} moved`);

      try {
        await ensureBatch(batchOf(counter));
        // One retry: eight minutes into a run, a single dropped reply is not a
        // reason to lose the rest.
        await client.rename(from, to).catch(() => client.rename(from, to));
      } catch (err) {
        // Still in the source folder, so the next pass will see it again — but
        // it will also stall on it again, which is what ends the loop.
        report.failed.push({ name: e.name, error: err.message });
        log('warn', `could not move ${e.name}: ${err.message}`);
        continue;
      }

      report.rescued.push({ from, to, size: e.size });
      counter++;
      movedThisPass++;
    }

    if (movedThisPass === 0) {
      report.stalled = true;
      log('warn', `pass ${report.passes} moved nothing — stopping`);
      break;
    }
  }

  if (report.passes >= MAX_PASSES && !report.complete) {
    report.stalled = true;
    log('warn', `stopped after ${MAX_PASSES} passes`);
  }

  status(report.rescued.length
    ? `${report.rescued.length} files moved to ${report.staging}`
    : 'Nothing was moved');
  return report;
}
