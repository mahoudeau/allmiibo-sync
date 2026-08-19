// Allmiibo / PIXL VFS protocol: framing, chunk reassembly, command queue.
// See PROTOCOL.md for the wire format this implements.

import { ByteReader, ByteWriter, readMeta, writeMeta, utf8Length } from './bytes.js';

export const MTU = 247;
export const HEADER_LEN = 4;
export const MAX_PAYLOAD = MTU - HEADER_LEN; // 243
export const WRITE_CHUNK = MAX_PAYLOAD - 1; // 242, one byte goes to file_id

const MORE_CHUNKS = 0x8000;

export const CMD = {
  GET_VERSION: 1,
  ENTER_DFU: 2,
  DRIVE_LIST: 16,
  DRIVE_FORMAT: 17,
  OPEN_FILE: 18,
  CLOSE_FILE: 19,
  READ_FILE: 20,
  WRITE_FILE: 21,
  READ_DIR: 22,
  CREATE_FOLDER: 23,
  REMOVE: 24,
  RENAME: 25,
  UPDATE_META: 26,
};

// enum vfs_mode_t in the firmware (fw/application/src/mod/vfs/vfs.h).
export const MODE = {
  APPEND: 1 << 0,
  TRUNC: 1 << 1,
  CREATE: 1 << 2,
  READONLY: 1 << 3,
  WRITEONLY: 1 << 4,
};

export const OPEN_MODE = {
  read: MODE.READONLY, // 8
  write: MODE.WRITEONLY | MODE.CREATE | MODE.TRUNC, // 22 — creates and truncates
};

// The firmware caps these at 48 and 64 including the NUL terminator.
export const MAX_PATH_BYTES = 63;
export const MAX_NAME_BYTES = 47;

// Drive labels are fixed in firmware: 'I' internal, 'E' external.
export function driveRoot(drive) {
  return `${drive.label}:/`;
}

export class ProtocolError extends Error {
  // `timeout` is 'idle' (the device went quiet) or 'ceiling' (it kept talking
  // past maxResponseMs). The two mean different things to a caller deciding
  // whether to retry, and to anyone reading a probe report afterwards.
  constructor(message, { cmd, status, timeout } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.cmd = cmd;
    this.status = status;
    this.timeout = timeout;
  }
}

// These surface to users verbatim in sync error lists, so they carry the
// numbers and the remedy, not just the verdict. "Bytes" is the honest unit:
// the firmware caps the UTF-8 encoding, so an accented letter counts twice.
export function assertPath(path) {
  const pathBytes = utf8Length(path);
  if (pathBytes > MAX_PATH_BYTES) {
    throw new Error(
      `the device can only address paths up to ${MAX_PATH_BYTES} bytes and ` +
        `"${path}" is ${pathBytes}. Shorten the file or folder name ` +
        `(accented letters count as two bytes).`
    );
  }
  if (path.length > 3) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const nameBytes = utf8Length(name);
    if (nameBytes > MAX_NAME_BYTES) {
      throw new Error(
        `the device can only store names up to ${MAX_NAME_BYTES} bytes and ` +
          `"${name}" is ${nameBytes}. Shorten it ` +
          `(accented letters count as two bytes).`
      );
    }
  }
}

export class AllmiiboClient {
  // transport: a BleTransport (or anything emitting 'frame' with Uint8Array
  // payloads and exposing async write()).
  //
  // timeoutMs is an *idle* deadline, re-armed on every notification, not a
  // budget for the whole response. A read_dir on a large folder legitimately
  // streams for a minute on a slow link — 760 entries is ~29 KB at 243 bytes
  // per frame — and killing it part-way made a healthy device unusable. What
  // matters is whether the device has gone quiet. maxResponseMs is the
  // separate backstop for a device that trickles forever. See PROTOCOL.md §3.4.
  constructor(transport, {
    timeoutMs = 15000,
    maxResponseMs = 120000,
    log = () => {},
    keepAliveMs = 10000,
  } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.maxResponseMs = maxResponseMs;
    this.log = log;

    this._queue = [];
    this._inFlight = null;
    this._acc = null; // reassembly buffer for multi-frame responses
    this._accActive = false;
    this._settling = false; // a timeout left the device possibly still talking
    this.lastActivityAt = Date.now();

    transport.addEventListener('frame', (e) => this._onFrame(e.detail));
    transport.addEventListener('disconnected', () => this._onDisconnected());

    // The device can power itself off when the link goes quiet, and the
    // protocol has no heartbeat, so after keepAliveMs of real silence the
    // client sends the cheapest command there is (get_version, empty
    // payload, one notification back). Never fires while work is queued.
    if (keepAliveMs > 0) {
      this._keepAlive = setInterval(() => {
        if (!this.transport.connected || this.busy) return;
        if (Date.now() - this.lastActivityAt < keepAliveMs) return;
        this.getVersion().catch(() => {}); // a real drop is reported by the disconnect path
      }, Math.max(250, Math.floor(keepAliveMs / 2)));
      // In Node (tests) an interval pins the event loop open; browsers
      // return a number and skip this.
      this._keepAlive.unref?.();
    }
  }

  get busy() {
    return !!this._inFlight || this._queue.length > 0;
  }

  // ---- command plumbing -------------------------------------------------

  // The device has no request IDs, so exactly one command may be in flight.
  _send(cmd, payload, parse) {
    return new Promise((resolve, reject) => {
      this._queue.push({ cmd, payload, parse, resolve, reject });
      this._pump();
    });
  }

  // Re-armed on every frame, so the deadline measures silence rather than the
  // length of the response.
  _arm(job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      this._timedOut(new ProtocolError(
        `no response to cmd ${job.cmd} for ${this.timeoutMs}ms` +
          (job.frames ? ` (${job.frames} frames received, then silence)` : ''),
        { cmd: job.cmd, timeout: 'idle' }
      ));
    }, this.timeoutMs);
  }

  _clearTimers(job) {
    clearTimeout(job.timer);
    clearTimeout(job.ceiling);
  }

  // A timeout abandons a response the device may still be sending. There are
  // no request IDs (§3.4), so its late frames are indistinguishable from the
  // next reply — _pump waits for the link to fall quiet before writing again.
  _timedOut(err) {
    const job = this._inFlight;
    // Whatever did arrive is real directory data. The rescue tool drains a
    // folder that will not list by working from exactly these bytes, so they
    // are handed to the caller rather than dropped with the buffer.
    if (this._acc) err.partial = concat(this._acc);
    err.frames = job?.frames ?? 0;
    this._settling = true;
    this._fail(err);
  }

  _pump() {
    if (this._inFlight || this._queue.length === 0) return;

    if (this._settling) {
      const settleMs = Math.min(2000, this.timeoutMs);
      const quiet = Date.now() - this.lastActivityAt;
      if (quiet < settleMs) {
        setTimeout(() => this._pump(), settleMs - quiet);
        return;
      }
      this._settling = false;
    }

    const job = this._queue.shift();
    this._inFlight = job;
    this._acc = null;
    this._accActive = false;
    job.frames = 0;
    this.lastActivityAt = Date.now();

    if (Number.isFinite(this.maxResponseMs) && this.maxResponseMs > 0) {
      job.ceiling = setTimeout(() => {
        this._timedOut(new ProtocolError(
          `cmd ${job.cmd} was still arriving after ${this.maxResponseMs}ms ` +
            `(${job.frames} frames); giving up`,
          { cmd: job.cmd, timeout: 'ceiling' }
        ));
      }, this.maxResponseMs);
    }

    const frame = new ByteWriter(HEADER_LEN + job.payload.length)
      .u8(job.cmd)
      .u8(0)
      .u16(0)
      .bytes(job.payload)
      .toUint8Array();

    // The idle deadline measures the device's silence, so it starts when the
    // command has actually reached the device — a write stuck behind a stalled
    // predecessor must not eat into the response's time. The ceiling above is
    // armed already: it bounds the whole exchange, stalled write included.
    // Response frames can land before the write promise settles; _onFrame arms
    // the timer itself in that case, and the guard keeps a late settle from
    // re-arming a job that already finished.
    this.transport.write(frame).then(
      () => { if (this._inFlight === job) this._arm(job); },
      (err) => { if (this._inFlight === job) this._fail(err); }
    );
  }

  _fail(err) {
    const job = this._inFlight;
    if (!job) return;
    this._clearTimers(job);
    this._inFlight = null;
    this._acc = null;
    this._accActive = false;
    job.reject(err);
    this._pump();
  }

  _onDisconnected() {
    clearInterval(this._keepAlive);
    this._keepAlive = null;
    const pending = [this._inFlight, ...this._queue].filter(Boolean);
    this._inFlight = null;
    this._queue = [];
    this._acc = null;
    this._accActive = false;
    // A dropped link is not a device that may still be talking; nothing can
    // arrive to be spliced into the next command.
    this._settling = false;
    for (const job of pending) {
      this._clearTimers(job);
      job.reject(new ProtocolError('device disconnected'));
    }
  }

  // Reassembly, mirroring the official client: the first frame of a
  // multi-frame response contributes its header too, later frames contribute
  // payload only.
  _onFrame(bytes) {
    if (bytes.length < HEADER_LEN) return;

    // Every frame counts as activity, including continuation frames — that is
    // what turns timeoutMs into an idle deadline rather than a cap on how long
    // a large response may take. It also gives _pump's settle gate a real
    // "last thing seen on the link" to wait on.
    this.lastActivityAt = Date.now();
    if (this._inFlight) {
      this._inFlight.frames++;
      this._arm(this._inFlight);
    }

    const chunk = bytes[2] | (bytes[3] << 8);
    const more = (chunk & MORE_CHUNKS) !== 0;

    if (more) {
      if (!this._accActive) {
        this._acc = [bytes];
        this._accActive = true;
      } else {
        this._acc.push(bytes.subarray(HEADER_LEN));
      }
      return;
    }

    let complete;
    if (this._accActive) {
      this._acc.push(bytes.subarray(HEADER_LEN));
      complete = concat(this._acc);
    } else {
      complete = bytes;
    }
    this._acc = null;
    this._accActive = false;

    this._resolve(complete);
  }

  _resolve(frame) {
    const job = this._inFlight;
    if (!job) {
      this.log('warn', 'unsolicited frame dropped', frame);
      return;
    }
    this._clearTimers(job);
    this._inFlight = null;
    this.lastActivityAt = Date.now();

    try {
      const r = new ByteReader(frame);
      const cmd = r.u8();
      const status = r.u8();
      r.u16(); // chunk flags, already consumed by reassembly

      if (status !== 0) {
        throw new ProtocolError(`cmd ${cmd} failed with status ${status}`, { cmd, status });
      }
      job.resolve({ cmd, status, data: job.parse ? job.parse(r) : undefined });
    } catch (err) {
      job.reject(err);
    } finally {
      this._pump();
    }
  }

  // ---- read-only commands ----------------------------------------------

  async getVersion() {
    const { data } = await this._send(CMD.GET_VERSION, new Uint8Array(0), (r) => ({
      version: r.string(),
      bleAddress: r.remaining > 0 ? r.string() : '',
    }));
    return data;
  }

  async getDriveList() {
    const { data } = await this._send(CMD.DRIVE_LIST, new Uint8Array(0), (r) => {
      const drives = [];
      const count = r.u8();
      // The official client only ever reads one entry; keep going while the
      // buffer allows, so a multi-drive device is not silently truncated.
      for (let i = 0; i < count && r.remaining > 0; i++) {
        const status = r.u8();
        const label = String.fromCharCode(r.u8());
        const name = r.string();
        const totalSize = r.u32();
        // The second figure is what is *free*, not what is used — the official
        // Pixl.js client shows it as the drive's remaining space. Reading it as
        // "used" inverts the drive: an empty device reported 1,918,644 here
        // against a 1,920,401-byte total, which we turned into 1,757 bytes free
        // and refused every sync. See PROTOCOL.md §5.1.
        const freeSize = r.u32();
        drives.push({
          status,
          label,
          name,
          totalSize,
          freeSize,
          usedSize: Math.max(0, totalSize - freeSize),
        });
      }
      return { count, drives };
    });
    return data;
  }

  async readDir(path) {
    const payload = new ByteWriter(64).string(path).toUint8Array();
    const { data } = await this._send(CMD.READ_DIR, payload, (r) => {
      const entries = [];
      while (r.remaining > 0) entries.push(readDirEntry(r));
      return entries;
    });
    return data.map((e) => ({ ...e, isDir: e.type !== 0 }));
  }

  // Like readDir, but a listing that stalls part-way yields what did arrive
  // instead of throwing. `complete` is false when the device went quiet
  // mid-response — the caller then knows the folder holds more than this.
  //
  // Only a timeout is soft. A non-zero status, a disconnect or a malformed
  // frame still rejects: those say the request failed, not that it was cut off.
  async readDirPartial(path) {
    try {
      return { entries: await this.readDir(path), complete: true };
    } catch (err) {
      if (!err.partial) throw err;
      return { entries: parsePartialDir(err.partial), complete: false, error: err };
    }
  }

  async openFile(path, mode) {
    assertPath(path);
    const modeByte = OPEN_MODE[mode];
    if (modeByte === undefined) throw new Error(`unknown open mode: ${mode}`);

    // The firmware reads the mode with buff_get_u32, so send four bytes. The
    // official web client sends only one and relies on the frame buffer being
    // zeroed underneath it.
    const payload = new ByteWriter(64).string(path).u32(modeByte).toUint8Array();
    const { data } = await this._send(CMD.OPEN_FILE, payload, (r) => ({ fileId: r.u8() }));
    return data.fileId;
  }

  async closeFile(fileId) {
    await this._send(CMD.CLOSE_FILE, new Uint8Array([fileId]), null);
  }

  // The device returns the whole file in one logical (chunked) response.
  async readFileById(fileId) {
    const { data } = await this._send(CMD.READ_FILE, new Uint8Array([fileId]), (r) => r.rest());
    return data;
  }

  async readFile(path) {
    const fileId = await this.openFile(path, 'read');
    try {
      return await this.readFileById(fileId);
    } finally {
      await this.closeFile(fileId).catch(() => {});
    }
  }

  // ---- write commands ---------------------------------------------------
  // Present for completeness; the probe UI never calls these.

  async writeFile(path, data, onProgress = () => {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const fileId = await this.openFile(path, 'write');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const n = Math.min(WRITE_CHUNK, bytes.length - offset);
        const payload = new ByteWriter(n + 1)
          .u8(fileId)
          .bytes(bytes.subarray(offset, offset + n))
          .toUint8Array();
        await this._send(CMD.WRITE_FILE, payload, null);
        offset += n;
        onProgress(offset, bytes.length);
      }
    } finally {
      await this.closeFile(fileId).catch(() => {});
    }
  }

  async createFolder(path) {
    assertPath(path);
    await this._send(CMD.CREATE_FOLDER, new ByteWriter(64).string(path).toUint8Array(), null);
  }

  // Validated before sending. The firmware silently truncates an over-long
  // path (df_buffer.h buff_get_string) and remove() deletes folders
  // recursively, so an unchecked path here could erase the wrong subtree.
  async remove(path) {
    assertPath(path);
    await this._send(CMD.REMOVE, new ByteWriter(64).string(path).toUint8Array(), null);
  }

  async rename(from, to) {
    assertPath(from);
    assertPath(to);
    const payload = new ByteWriter(128).string(from).string(to).toUint8Array();
    await this._send(CMD.RENAME, payload, null);
  }

  async updateMeta(path, meta) {
    assertPath(path);
    const w = new ByteWriter(128).string(path);
    writeMeta(w, meta);
    await this._send(CMD.UPDATE_META, w.toUint8Array(), null);
  }
}

function readDirEntry(r) {
  return {
    name: r.string(),
    size: r.u32(),
    type: r.u8(), // 0 = regular file, non-zero = directory
    meta: readMeta(r),
  };
}

// Recover the entries from a directory listing the device never finished
// sending. `bytes` is the raw accumulation: the first notification with its
// header, then payload-only continuations.
//
// Two things make this safe to trust. Frames arrive in order and each carries
// its own payload, so everything before the cut is exactly what the device
// sent; and the tail is discarded rather than guessed at — parsing stops at
// the first read past the end, and the last surviving entry is dropped too,
// because a length prefix severed mid-field can decode to a plausible but
// wrong name. Nothing is lost by being cautious: the caller re-lists, and the
// entries it did keep are what let it get that far.
export function parsePartialDir(bytes) {
  const r = new ByteReader(bytes);
  const entries = [];
  try {
    r.u8(); r.u8(); r.u16(); // header: cmd, status, chunk flags
    while (r.remaining > 0) entries.push(readDirEntry(r));
  } catch {
    // Ran off the end mid-entry, which is the expected way out.
  }
  if (entries.length > 0) entries.pop();
  return entries.filter(plausibleEntry).map((e) => ({ ...e, isDir: e.type !== 0 }));
}

// A name the firmware could actually have stored. `/` is the one character
// that cannot appear (it is the separator), and vfs_obj_t.name is a 48-byte
// field, so anything longer is a misread rather than a long filename.
function plausibleEntry(e) {
  return e.name.length > 0 && !e.name.includes('/') && utf8Length(e.name) <= MAX_NAME_BYTES;
}

// Join a path segment onto a directory path, tolerating a trailing slash.
export function joinPath(dir, name) {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
