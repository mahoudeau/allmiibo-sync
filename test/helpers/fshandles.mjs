// In-memory stand-ins for the File System Access API handles localfs.js
// drives. Two switches matter:
//
//   caseInsensitive — name lookup ignores letter case, the way APFS and NTFS
//     do underneath Chrome. This is what makes a case-only move resolve to
//     the file it is moving, which is the trap the mover has to survive.
//   nativeMove — expose FileSystemFileHandle.move(), the real rename. Off by
//     default so tests can exercise the copy-and-delete fallback.
//
// Only what localfs.js touches is implemented; anything else throws.

class Inode {
  constructor(kind) {
    this.kind = kind;
    this.data = new Uint8Array(0); // files
    this.children = new Map();     // dirs: key -> { name, inode }
  }
}

function notFound(name) {
  const err = new Error(`${name} not found`);
  err.name = 'NotFoundError';
  return err;
}

class MemFileHandle {
  constructor(fs, parent, key) {
    this.kind = 'file';
    this._fs = fs;
    this._parent = parent; // parent Inode
    this._key = key;
    if (fs.nativeMove) {
      this.move = async (dirHandle, newName) => {
        const entry = this._parent.children.get(this._key);
        if (!entry) throw notFound(this._key);
        this._parent.children.delete(this._key);
        const destDir = dirHandle._inode;
        const destKey = fs.key(newName);
        destDir.children.set(destKey, { name: newName, inode: entry.inode });
        this._parent = destDir;
        this._key = destKey;
      };
    }
  }

  get _entry() {
    const e = this._parent.children.get(this._key);
    if (!e) throw notFound(this._key);
    return e;
  }

  get name() {
    return this._entry.name;
  }

  async getFile() {
    const { inode } = this._entry;
    const data = inode.data;
    return {
      size: data.length,
      lastModified: 0,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      text: async () => new TextDecoder().decode(data),
    };
  }

  async createWritable() {
    const { inode } = this._entry;
    let staged = new Uint8Array(0);
    return {
      write: async (bytes) => {
        staged = typeof bytes === 'string'
          ? new TextEncoder().encode(bytes)
          : new Uint8Array(bytes);
      },
      close: async () => { inode.data = staged; },
    };
  }

  async isSameEntry(other) {
    return other instanceof MemFileHandle && other._entry.inode === this._entry.inode;
  }
}

class MemDirHandle {
  constructor(fs, inode, name = '') {
    this.kind = 'directory';
    this.name = name;
    this._fs = fs;
    this._inode = inode;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const key = this._fs.key(name);
    let entry = this._inode.children.get(key);
    if (!entry) {
      if (!create) throw notFound(name);
      entry = { name, inode: new Inode('directory') };
      this._inode.children.set(key, entry);
    }
    if (entry.inode.kind !== 'directory') throw new TypeError(`${name} is a file`);
    return new MemDirHandle(this._fs, entry.inode, entry.name);
  }

  async getFileHandle(name, { create = false } = {}) {
    const key = this._fs.key(name);
    let entry = this._inode.children.get(key);
    if (!entry) {
      if (!create) throw notFound(name);
      entry = { name, inode: new Inode('file') };
      this._inode.children.set(key, entry);
    }
    if (entry.inode.kind !== 'file') throw new TypeError(`${name} is a directory`);
    return new MemFileHandle(this._fs, this._inode, key);
  }

  async removeEntry(name, { recursive = false } = {}) {
    const key = this._fs.key(name);
    const entry = this._inode.children.get(key);
    if (!entry) throw notFound(name);
    if (entry.inode.kind === 'directory' && entry.inode.children.size > 0 && !recursive) {
      const err = new Error(`${name} is not empty`);
      err.name = 'InvalidModificationError';
      throw err;
    }
    this._inode.children.delete(key);
  }

  async *entries() {
    for (const [key, entry] of [...this._inode.children]) {
      yield [
        entry.name,
        entry.inode.kind === 'directory'
          ? new MemDirHandle(this._fs, entry.inode, entry.name)
          : new MemFileHandle(this._fs, this._inode, key),
      ];
    }
  }

  async isSameEntry(other) {
    return other instanceof MemDirHandle && other._inode === this._inode;
  }
}

/**
 * A root directory handle over an empty in-memory tree.
 * `seed` pre-populates it: { 'splatoon/Inkling.bin': Uint8Array | string }.
 */
export function memRoot({ caseInsensitive = false, nativeMove = false, seed = {} } = {}) {
  const fs = {
    caseInsensitive,
    nativeMove,
    key: (name) => (caseInsensitive ? name.toLowerCase() : name),
  };
  const root = new MemDirHandle(fs, new Inode('directory'), '');
  for (const [path, content] of Object.entries(seed)) {
    const parts = path.split('/');
    const name = parts.pop();
    let dir = root._inode;
    for (const part of parts) {
      const key = fs.key(part);
      let entry = dir.children.get(key);
      if (!entry) {
        entry = { name: part, inode: new Inode('directory') };
        dir.children.set(key, entry);
      }
      dir = entry.inode;
    }
    const inode = new Inode('file');
    inode.data = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    dir.children.set(fs.key(name), { name, inode });
  }
  return root;
}

/** Flatten a mem tree back to { relPath: byteLength } for easy assertions. */
export async function listTree(dirHandle, prefix = '') {
  const out = {};
  for await (const [name, handle] of dirHandle.entries()) {
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      out[relPath] = 'dir';
      Object.assign(out, await listTree(handle, relPath));
    } else {
      out[relPath] = (await handle.getFile()).size;
    }
  }
  return out;
}
