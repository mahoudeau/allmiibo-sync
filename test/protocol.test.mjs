// Protocol tests against a simulated device. No hardware, no dependencies:
// node --test test/
//
// The framing and chunk-reassembly rules under test come from PROTOCOL.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AllmiiboClient,
  CMD,
  WRITE_CHUNK,
  HEADER_LEN,
  OPEN_MODE,
  driveRoot,
} from '../web/js/protocol.js';
import { ByteWriter } from '../web/js/bytes.js';

const MORE = 0x8000;

// A transport that records host writes and lets a test push device frames back.
class FakeTransport extends EventTarget {
  constructor() {
    super();
    this.writes = [];
    this.onWrite = null;
  }

  async write(frame) {
    this.writes.push(frame);
    if (this.onWrite) await this.onWrite(frame, this);
  }

  emitFrame(bytes) {
    this.dispatchEvent(new CustomEvent('frame', { detail: bytes }));
  }

  // Split a full response into notifications of at most `size` payload bytes,
  // setting the continuation flag on every frame but the last.
  respondChunked(cmd, status, payload, size) {
    const parts = [];
    for (let off = 0; off < payload.length; off += size) {
      parts.push(payload.subarray(off, Math.min(off + size, payload.length)));
    }
    if (parts.length === 0) parts.push(new Uint8Array(0));

    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      const frame = new ByteWriter(HEADER_LEN + part.length)
        .u8(cmd)
        .u8(status)
        .u16(last ? 0 : MORE)
        .bytes(part)
        .toUint8Array();
      this.emitFrame(frame);
    });
  }

  respond(cmd, status, payload = new Uint8Array(0)) {
    this.respondChunked(cmd, status, payload, Math.max(payload.length, 1));
  }
}

function client(transport) {
  return new AllmiiboClient(transport, { timeoutMs: 1000 });
}

test('request framing: cmd byte, zeroed status and chunk, then payload', async () => {
  const t = new FakeTransport();
  const c = client(t);

  t.onWrite = (frame) => t.respond(CMD.GET_VERSION, 0, new ByteWriter(32).string('1.2.3').toUint8Array());
  await c.getVersion();

  const sent = t.writes[0];
  assert.equal(sent[0], CMD.GET_VERSION);
  assert.equal(sent[1], 0, 'status must be zero on requests');
  assert.equal(sent[2] | (sent[3] << 8), 0, 'chunk must be zero on requests');
});

test('get_version parses version and optional ble address', async () => {
  const t = new FakeTransport();
  const c = client(t);

  const payload = new ByteWriter(64).string('PIXL 1.4.2').string('AA:BB:CC:DD:EE:FF').toUint8Array();
  t.onWrite = () => t.respond(CMD.GET_VERSION, 0, payload);

  assert.deepEqual(await c.getVersion(), {
    version: 'PIXL 1.4.2',
    bleAddress: 'AA:BB:CC:DD:EE:FF',
  });
});

test('get_version tolerates a missing ble address', async () => {
  const t = new FakeTransport();
  const c = client(t);

  t.onWrite = () => t.respond(CMD.GET_VERSION, 0, new ByteWriter(32).string('1.0.0').toUint8Array());

  assert.deepEqual(await c.getVersion(), { version: '1.0.0', bleAddress: '' });
});

test('drive list parses a single drive entry', async () => {
  const t = new FakeTransport();
  const c = client(t);

  // Values as reported by real hardware (Pixl.js 2.11.2).
  const payload = new ByteWriter(64)
    .u8(1)
    .u8(0)
    .u8('E'.charCodeAt(0))
    .string('External Flash')
    .u32(1_920_401)
    .u32(966_601)
    .toUint8Array();
  t.onWrite = () => t.respond(CMD.DRIVE_LIST, 0, payload);

  const { count, drives } = await c.getDriveList();
  assert.equal(count, 1);
  assert.deepEqual(drives[0], {
    status: 0,
    label: 'E',
    name: 'External Flash',
    totalSize: 1_920_401,
    freeSize: 966_601,
    usedSize: 953_800,
  });
});

test('the second drive figure is free space, not used space', async () => {
  const t = new FakeTransport();
  const c = client(t);

  // A nearly empty device: the official client shows this as 1.82 MB free of
  // 1.83 MB. Read as "used" it would leave 1,757 bytes free and refuse to sync.
  const payload = new ByteWriter(64)
    .u8(1).u8(0).u8('E'.charCodeAt(0)).string('External Flash')
    .u32(1_920_401).u32(1_918_644)
    .toUint8Array();
  t.onWrite = () => t.respond(CMD.DRIVE_LIST, 0, payload);

  const { drives } = await c.getDriveList();
  assert.equal(drives[0].freeSize, 1_918_644);
  assert.equal(drives[0].usedSize, 1_757);
});

test('the drive root comes from the label, not the human-readable name', () => {
  assert.equal(driveRoot({ label: 'E', name: 'External Flash' }), 'E:/');
  assert.equal(driveRoot({ label: 'I', name: 'Internal Flash' }), 'I:/');
});

test('open_file sends the mode as a little-endian u32', async () => {
  const t = new FakeTransport();
  const c = client(t);

  t.onWrite = () => t.respond(CMD.OPEN_FILE, 0, new Uint8Array([1]));
  await c.openFile('E:/a.bin', 'read');

  const frame = t.writes[0];
  const mode = frame.subarray(frame.length - 4);
  assert.deepEqual([...mode], [OPEN_MODE.read, 0, 0, 0]);
  assert.equal(OPEN_MODE.read, 8, 'VFS_MODE_READONLY');
  assert.equal(OPEN_MODE.write, 22, 'VFS_MODE_WRITEONLY | CREATE | TRUNC');
});

test('read_dir parses entries and classifies type 0 as a regular file', async () => {
  const t = new FakeTransport();
  const c = client(t);

  const w = new ByteWriter(256);
  w.string('mario.bin').u32(540).u8(0).u8(0); // file, no metadata
  w.string('Zelda').u32(0).u8(1).u8(0); // directory, no metadata
  t.onWrite = () => t.respond(CMD.READ_DIR, 0, w.toUint8Array());

  const entries = await c.readDir('0:/');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'mario.bin');
  assert.equal(entries[0].size, 540);
  assert.equal(entries[0].isDir, false);
  assert.equal(entries[1].name, 'Zelda');
  assert.equal(entries[1].isDir, true);
});

test('read_dir decodes notes and the hidden flag', async () => {
  const t = new FakeTransport();
  const c = client(t);

  const meta = new ByteWriter(64);
  const notes = new TextEncoder().encode('spare tag');
  meta.u8(1).u8(notes.length).bytes(notes).u8(2).u8(1); // notes + hidden
  const metaBytes = meta.toUint8Array();

  const w = new ByteWriter(256);
  w.string('link.bin').u32(572).u8(0).u8(metaBytes.length).bytes(metaBytes);
  t.onWrite = () => t.respond(CMD.READ_DIR, 0, w.toUint8Array());

  const [entry] = await c.readDir('0:/');
  assert.equal(entry.meta.notes, 'spare tag');
  assert.equal(entry.meta.flags.hide, true);
});

test('a response split across notifications is reassembled in order', async () => {
  const t = new FakeTransport();
  const c = client(t);

  // 2000 bytes forces several notifications at a 243-byte payload ceiling.
  const contents = new Uint8Array(2000).map((_, i) => i & 0xff);

  t.onWrite = (frame) => {
    const cmd = frame[0];
    if (cmd === CMD.OPEN_FILE) t.respond(CMD.OPEN_FILE, 0, new Uint8Array([7]));
    else if (cmd === CMD.READ_FILE) t.respondChunked(CMD.READ_FILE, 0, contents, 243);
    else if (cmd === CMD.CLOSE_FILE) t.respond(CMD.CLOSE_FILE, 0);
  };

  const got = await c.readFile('0:/big.bin');
  assert.equal(got.length, contents.length);
  assert.deepEqual(got, contents);
});

test('reassembly state resets, so a chunked response is followed by a clean one', async () => {
  const t = new FakeTransport();
  const c = client(t);

  const contents = new Uint8Array(600).fill(0xab);
  t.onWrite = (frame) => {
    const cmd = frame[0];
    if (cmd === CMD.OPEN_FILE) t.respond(CMD.OPEN_FILE, 0, new Uint8Array([3]));
    else if (cmd === CMD.READ_FILE) t.respondChunked(CMD.READ_FILE, 0, contents, 243);
    else if (cmd === CMD.CLOSE_FILE) t.respond(CMD.CLOSE_FILE, 0);
    else if (cmd === CMD.GET_VERSION) {
      t.respond(CMD.GET_VERSION, 0, new ByteWriter(32).string('after').toUint8Array());
    }
  };

  await c.readFile('0:/big.bin');
  assert.equal((await c.getVersion()).version, 'after');
});

test('a non-zero status rejects with the status attached', async () => {
  const t = new FakeTransport();
  const c = client(t);

  t.onWrite = () => t.respond(CMD.OPEN_FILE, 5, new Uint8Array([0]));

  await assert.rejects(() => c.openFile('0:/missing.bin', 'read'), (err) => {
    assert.equal(err.name, 'ProtocolError');
    assert.equal(err.status, 5);
    return true;
  });
});

test('commands are serialised — the next request waits for the previous reply', async () => {
  const t = new FakeTransport();
  const c = client(t);

  const order = [];
  let release = null;

  t.onWrite = (frame) => {
    order.push(`write:${frame[0]}`);
    if (frame[0] === CMD.GET_VERSION) {
      // Hold the first response open until the test releases it.
      release = () => t.respond(CMD.GET_VERSION, 0, new ByteWriter(16).string('v').toUint8Array());
    } else {
      t.respond(CMD.DRIVE_LIST, 0, new Uint8Array([0]));
    }
  };

  const first = c.getVersion();
  const second = c.getDriveList();

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['write:1'], 'second command must not be written yet');

  release();
  await first;
  await second;
  assert.deepEqual(order, ['write:1', 'write:16']);
});

test('a file write is split into 242-byte chunks, each prefixed with the file id', async () => {
  const t = new FakeTransport();
  const c = client(t);

  const data = new Uint8Array(500).fill(0x5a);
  t.onWrite = (frame) => {
    const cmd = frame[0];
    if (cmd === CMD.OPEN_FILE) t.respond(CMD.OPEN_FILE, 0, new Uint8Array([9]));
    else t.respond(cmd, 0);
  };

  await c.writeFile('0:/out.bin', data);

  const writes = t.writes.filter((f) => f[0] === CMD.WRITE_FILE);
  assert.equal(writes.length, Math.ceil(500 / WRITE_CHUNK));
  assert.equal(writes[0].length - HEADER_LEN - 1, WRITE_CHUNK);
  assert.equal(writes[0][HEADER_LEN], 9, 'payload starts with the file id');
  assert.equal(writes.at(-1).length - HEADER_LEN - 1, 500 % WRITE_CHUNK, 'final chunk holds the remainder');
});

test('a file is closed even when the read fails', async () => {
  const t = new FakeTransport();
  const c = client(t);

  t.onWrite = (frame) => {
    const cmd = frame[0];
    if (cmd === CMD.OPEN_FILE) t.respond(CMD.OPEN_FILE, 0, new Uint8Array([4]));
    else if (cmd === CMD.READ_FILE) t.respond(CMD.READ_FILE, 9);
    else if (cmd === CMD.CLOSE_FILE) t.respond(CMD.CLOSE_FILE, 0);
  };

  await assert.rejects(() => c.readFile('0:/bad.bin'));
  assert.ok(
    t.writes.some((f) => f[0] === CMD.CLOSE_FILE),
    'close_file must still be issued'
  );
});

test('oversized paths and filenames are rejected before hitting the wire', async () => {
  const t = new FakeTransport();
  const c = client(t);

  await assert.rejects(() => c.openFile('0:/' + 'a'.repeat(70), 'read'), /path exceeds 63 bytes/);
  assert.equal(t.writes.length, 0);

  // 50-byte filename inside a short path: under the path cap, over the name cap.
  await assert.rejects(() => c.openFile('0:/' + 'b'.repeat(50), 'read'), /filename exceeds 47 bytes/);
  assert.equal(t.writes.length, 0);
});

test('every path-taking command validates before reaching the wire', async () => {
  const t = new FakeTransport();
  const c = client(t);
  const tooLong = `E:/${'z'.repeat(70)}`;

  // The firmware truncates silently rather than erroring, so a command sent
  // with an over-long path acts on a *different* path than intended.
  await assert.rejects(() => c.remove(tooLong), /exceeds/);
  await assert.rejects(() => c.createFolder(tooLong), /exceeds/);
  await assert.rejects(() => c.openFile(tooLong, 'write'), /exceeds/);
  await assert.rejects(() => c.rename(tooLong, 'E:/ok.bin'), /exceeds/);
  await assert.rejects(() => c.rename('E:/ok.bin', tooLong), /exceeds/);
  await assert.rejects(() => c.updateMeta(tooLong, { notes: '', flags: {} }), /exceeds/);

  assert.equal(t.writes.length, 0, 'nothing may be transmitted');
});

test('notes longer than 90 bytes are rejected', async () => {
  const t = new FakeTransport();
  const c = client(t);

  await assert.rejects(
    () => c.updateMeta('0:/a.bin', { notes: 'x'.repeat(91), flags: {} }),
    /90 bytes or fewer/
  );
});

test('a disconnect rejects both in-flight and queued commands', async () => {
  const t = new FakeTransport();
  const c = client(t);

  t.onWrite = () => {}; // never respond

  const first = c.getVersion();
  const second = c.getDriveList();
  t.dispatchEvent(new CustomEvent('disconnected'));

  await assert.rejects(() => first, /disconnected/);
  await assert.rejects(() => second, /disconnected/);
});

test('after real silence the client pings get_version, but never while busy', async () => {
  const t = new FakeTransport();
  t.connected = true; // the keep-alive checks the link before pinging
  t.onWrite = (frame) => {
    // answer everything as a version reply so the queue keeps draining
    t.respond(frame[0], 0, new ByteWriter(32).string('1.2.3').toUint8Array());
  };
  const c = new AllmiiboClient(t, { keepAliveMs: 120 });
  try {
    // Active phase: constant traffic for longer than the idle threshold.
    const t0 = Date.now();
    while (Date.now() - t0 < 300) await c.getVersion();
    const activeWrites = t.writes.length;

    // Idle phase: no calls from us — the ping must fire on its own.
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(t.writes.length > activeWrites, 'idle silence produced no keep-alive ping');
    assert.equal(t.writes[t.writes.length - 1][0], CMD.GET_VERSION);

    // Disconnect tears the timer down: no writes appear afterwards.
    t.dispatchEvent(new CustomEvent('disconnected'));
    const after = t.writes.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(t.writes.length, after, 'keep-alive survived disconnect');
  } finally {
    t.dispatchEvent(new CustomEvent('disconnected')); // always clear the interval
  }
});
