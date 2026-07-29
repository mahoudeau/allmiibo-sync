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
  constructor(message, { cmd, status } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.cmd = cmd;
    this.status = status;
  }
}

export function assertPath(path) {
  if (utf8Length(path) > MAX_PATH_BYTES) {
    throw new Error(`path exceeds ${MAX_PATH_BYTES} bytes: ${path}`);
  }
  if (path.length > 3) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (utf8Length(name) > MAX_NAME_BYTES) {
      throw new Error(`filename exceeds ${MAX_NAME_BYTES} bytes: ${name}`);
    }
  }
}

export class AllmiiboClient {
  // transport: a BleTransport (or anything emitting 'frame' with Uint8Array
  // payloads and exposing async write()).
  constructor(transport, { timeoutMs = 15000, log = () => {}, keepAliveMs = 10000 } = {}) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.log = log;

    this._queue = [];
    this._inFlight = null;
    this._acc = null; // reassembly buffer for multi-frame responses
    this._accActive = false;
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

  _pump() {
    if (this._inFlight || this._queue.length === 0) return;

    const job = this._queue.shift();
    this._inFlight = job;
    this._acc = null;
    this._accActive = false;
    this.lastActivityAt = Date.now();

    job.timer = setTimeout(() => {
      this._fail(new ProtocolError(`timeout waiting for response to cmd ${job.cmd}`, { cmd: job.cmd }));
    }, this.timeoutMs);

    const frame = new ByteWriter(HEADER_LEN + job.payload.length)
      .u8(job.cmd)
      .u8(0)
      .u16(0)
      .bytes(job.payload)
      .toUint8Array();

    this.transport.write(frame).catch((err) => this._fail(err));
  }

  _fail(err) {
    const job = this._inFlight;
    if (!job) return;
    clearTimeout(job.timer);
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
    for (const job of pending) {
      clearTimeout(job.timer);
      job.reject(new ProtocolError('device disconnected'));
    }
  }

  // Reassembly, mirroring the official client: the first frame of a
  // multi-frame response contributes its header too, later frames contribute
  // payload only.
  _onFrame(bytes) {
    if (bytes.length < HEADER_LEN) return;
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
    clearTimeout(job.timer);
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
      while (r.remaining > 0) {
        entries.push({
          name: r.string(),
          size: r.u32(),
          type: r.u8(), // 0 = regular file, non-zero = directory
          meta: readMeta(r),
        });
      }
      return entries;
    });
    return data.map((e) => ({ ...e, isDir: e.type !== 0 }));
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
