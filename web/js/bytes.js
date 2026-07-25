// Little-endian byte reader/writer and the protocol's type codecs.
// No dependencies — TextEncoder/TextDecoder are built into the browser.

const utf8Encode = new TextEncoder();
const utf8Decode = new TextDecoder('utf-8');

export class ByteWriter {
  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.len = 0;
  }

  _need(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v) {
    this._need(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v) {
    this._need(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    return this;
  }

  u32(v) {
    this._need(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
    return this;
  }

  bytes(src) {
    const u = src instanceof Uint8Array ? src : new Uint8Array(src);
    this._need(u.length);
    this.buf.set(u, this.len);
    this.len += u.length;
    return this;
  }

  // u16 byte-length prefix followed by UTF-8 bytes.
  string(s) {
    const u = utf8Encode.encode(s);
    return this.u16(u.length).bytes(u);
  }

  toUint8Array() {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  constructor(source) {
    this.u = source instanceof Uint8Array ? source : new Uint8Array(source);
    this.pos = 0;
  }

  get remaining() {
    return this.u.length - this.pos;
  }

  _take(n) {
    if (this.pos + n > this.u.length) {
      throw new Error(`read past end of buffer (want ${n}, have ${this.remaining})`);
    }
    const out = this.u.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  u8() {
    return this._take(1)[0];
  }

  u16() {
    const b = this._take(2);
    return b[0] | (b[1] << 8);
  }

  u32() {
    const b = this._take(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }

  bytes(n) {
    return this._take(n).slice();
  }

  rest() {
    return this.bytes(this.remaining);
  }

  string() {
    return utf8Decode.decode(this._take(this.u16()));
  }
}

// Metadata TLV: u8 total_length, then tag/value pairs.
//   tag 1 = notes (u8 length + UTF-8), tag 2 = flags (u8, bit 0 = hidden)
export function readMeta(r) {
  const meta = { notes: '', flags: { hide: false } };
  const total = r.u8();
  if (total === 0) return meta;

  const inner = new ByteReader(r.bytes(total));
  while (inner.remaining > 0) {
    const tag = inner.u8();
    if (tag === 1) {
      const n = inner.u8();
      if (n > 0) meta.notes = utf8Decode.decode(inner.bytes(n));
    } else if (tag === 2) {
      meta.flags.hide = (inner.u8() & 1) !== 0;
    } else {
      // Unknown tag with no length field — cannot safely skip further.
      break;
    }
  }
  return meta;
}

export function writeMeta(w, meta) {
  const notes = utf8Encode.encode(meta.notes || '');
  if (notes.length > 90) {
    throw new Error(`notes must be 90 bytes or fewer (got ${notes.length})`);
  }

  const inner = new ByteWriter(128);
  if (notes.length > 0) inner.u8(1).u8(notes.length).bytes(notes);
  inner.u8(2).u8(meta.flags?.hide ? 1 : 0);

  const payload = inner.toUint8Array();
  w.u8(payload.length).bytes(payload);
  return w;
}

export function utf8Length(s) {
  return utf8Encode.encode(s).length;
}

export function toHex(bytes, limit = Infinity) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = Math.min(u.length, limit);
  let out = '';
  for (let i = 0; i < n; i++) out += u[i].toString(16).padStart(2, '0');
  return n < u.length ? `${out}… (${u.length} bytes)` : out;
}
