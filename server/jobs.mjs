// Work that outlives the request that asked for it.
//
// Fetching artwork is the case this exists for. A handful of pictures fits
// inside an HTTP request; ten thousand does not, at any timeout worth setting —
// and doing it inline means a closed tab or a proxy giving up abandons the work
// halfway with nothing to report. So the request starts a job and returns an
// id, and the client polls that id for progress.
//
// Deliberately in-process and deliberately not persisted. A restart loses the
// job record, which is survivable because the work itself is idempotent: the
// artwork fetch skips anything already on disk, so running it again resumes
// where it stopped rather than starting over. Persisting job state would buy
// nothing and would need its own cleanup, its own corruption story and its own
// tests.

import { randomUUID } from 'node:crypto';

/** How long a finished job stays readable, so a slow poller still sees it. */
export const KEEP_FINISHED_MS = 10 * 60 * 1000;

export class Jobs {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]  injectable clock, so tests need no timers
   */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.byId = new Map();
    this.runningKind = new Map();
  }

  /**
   * Start a job, unless one of the same kind is already running.
   *
   * The kind is the lock: two artwork fetches at once would race on the same
   * files and double the requests upstream for no gain.
   *
   * A busy kind REFUSES rather than handing back the running job's id. Joining
   * looks friendlier and is wrong — the second caller's decisions are not the
   * first's, so answering with the first job's progress silently throws the
   * second request's instructions away. Accepting a delete and returning the
   * result of a job that declined one is exactly that bug. The running id comes
   * back so the caller can watch it and retry after.
   *
   * @param {string} kind
   * @param {(report: (p: object) => void, signal: AbortSignal) => Promise<any>} run
   * @returns {{ id: string, busy: boolean }}
   */
  start(kind, run) {
    const existing = this.runningKind.get(kind);
    if (existing && this.byId.get(existing)?.state === 'running') {
      return { id: existing, busy: true };
    }

    const id = randomUUID();
    const controller = new AbortController();
    const job = {
      id,
      kind,
      state: 'running',
      done: 0,
      total: 0,
      phase: null,
      message: null,
      result: null,
      error: null,
      startedAt: this.now(),
      endedAt: null,
    };
    this.byId.set(id, job);
    this.runningKind.set(kind, id);

    const report = (p) => {
      if (job.state !== 'running') return;
      Object.assign(job, p);
    };

    // Not awaited: that is the whole point. Errors are captured onto the job
    // rather than becoming an unhandled rejection that takes the process down.
    Promise.resolve()
      .then(() => run(report, controller.signal))
      .then(
        (result) => { job.result = result; job.state = 'done'; },
        (err) => { job.error = err?.message ?? String(err); job.state = 'failed'; },
      )
      .finally(() => {
        job.endedAt = this.now();
        if (this.runningKind.get(kind) === id) this.runningKind.delete(kind);
        this.prune();
      });

    job.abort = () => controller.abort();
    return { id, busy: false };
  }

  /** A job's public shape. Never the abort handle. */
  get(id) {
    const job = this.byId.get(id);
    if (!job) return null;
    const { abort, ...rest } = job;
    return rest;
  }

  /** The running job of a kind, if there is one. */
  running(kind) {
    const id = this.runningKind.get(kind);
    const job = id ? this.byId.get(id) : null;
    return job?.state === 'running' ? this.get(id) : null;
  }

  /** Forget finished jobs nobody is going to ask about any more. */
  prune() {
    const cutoff = this.now() - KEEP_FINISHED_MS;
    for (const [id, job] of this.byId) {
      if (job.state !== 'running' && job.endedAt !== null && job.endedAt < cutoff) {
        this.byId.delete(id);
      }
    }
  }

  /** Stop everything, for a server shutting down or a test finishing. */
  abortAll() {
    for (const job of this.byId.values()) job.abort?.();
  }
}
