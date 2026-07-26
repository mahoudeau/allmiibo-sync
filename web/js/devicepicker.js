// Device folder browser: navigate the device's directories in a themed
// dialog and pick one. The device-side twin of the OS directory picker.

import { icon, ICONS } from './icons.js';
import { toast } from './ui.js';

let dlg = null;

function ensure() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'nesDialog devPicker';
  dlg.innerHTML = `
    <h2><span class="dIco">${icon('bluetooth')}</span><span class="dTitle"></span></h2>
    <p class="dHint"></p>
    <div class="dPath"></div>
    <div class="dMeta"></div>
    <ul class="dList"></ul>
    <div class="dRow">
      <button class="dCancel" value="cancel">CANCEL</button>
      <button class="dUse primary" value="use">USE THIS FOLDER</button>
    </div>`;
  document.body.append(dlg);
  return dlg;
}

// pickDeviceFolder({ client, startPath }) -> Promise<string|null>
export async function pickDeviceFolder({
  client,
  startPath = 'E:/amiibo',
  title = 'PICK THE DEVICE FOLDER',
  hint = 'Where your amiibo live on the device, usually E:/amiibo.',
} = {}) {
  const d = ensure();
  d.querySelector('.dTitle').textContent = title;
  d.querySelector('.dHint').textContent = hint;
  let current = startPath.replace(/\/+$/, '');

  const load = async (path) => {
    const entries = await client.readDir(path.endsWith(':/') || path.endsWith('/') ? path : `${path}/`);
    const dirs = entries.filter((e) => e.isDir && e.name !== '.' && e.name !== '..');
    const files = entries.filter((e) => !e.isDir);
    return { dirs, files };
  };

  // Fall back to the drive root when the preferred start doesn't exist.
  let listing;
  try {
    listing = await load(current);
  } catch {
    try {
      const drives = await client.getDriveList();
      current = `${drives.drives[0]?.label ?? 'E'}:/`.replace(/\/$/, '') + '/';
      current = current.replace(/\/+$/, '/');
      listing = await load(current);
    } catch (err) {
      toast(`Couldn't read the device: ${err.message}`, { kind: 'err' });
      return null;
    }
  }

  const atRoot = (p) => /^[A-Z]:\/?$/i.test(p.replace(/\/+$/, '')) || /^[A-Z]:\/$/i.test(p);
  const parentOf = (p) => {
    const clean = p.replace(/\/+$/, '');
    const i = clean.lastIndexOf('/');
    return i <= 2 ? clean.slice(0, 3) : clean.slice(0, i);
  };

  const render = () => {
    d.querySelector('.dPath').textContent = current;
    d.querySelector('.dMeta').textContent =
      `${listing.files.length} file${listing.files.length === 1 ? '' : 's'} · ${listing.dirs.length} folder${listing.dirs.length === 1 ? '' : 's'}`;
    const ul = d.querySelector('.dList');
    ul.textContent = '';
    if (!atRoot(current)) {
      const up = document.createElement('li');
      up.innerHTML = `<button class="dRowBtn">${icon('chevronUp')}<span>UP</span></button>`;
      up.querySelector('button').addEventListener('click', () => go(parentOf(current)));
      ul.append(up);
    }
    for (const dir of listing.dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const li = document.createElement('li');
      li.innerHTML = `<button class="dRowBtn">${icon('folder')}<span class="nm"></span>${icon('chevronRight')}</button>`;
      li.querySelector('.nm').textContent = dir.name;
      li.querySelector('button').addEventListener('click', () =>
        go(`${current.replace(/\/+$/, '')}/${dir.name}`));
      ul.append(li);
    }
    if (!listing.dirs.length && atRoot(current)) {
      const li = document.createElement('li');
      li.className = 'dEmpty';
      li.textContent = 'No folders here.';
      ul.append(li);
    }
  };

  const go = async (path) => {
    try {
      const next = await load(path);
      current = path;
      listing = next;
      render();
    } catch (err) {
      toast(`Can't open ${path}: ${err.message}`, { kind: 'err' });
    }
  };

  render();

  return new Promise((resolve) => {
    const done = () => {
      d.removeEventListener('close', done);
      resolve(d.returnValue === 'use' ? current.replace(/\/+$/, '') : null);
    };
    d.addEventListener('close', done);
    d.querySelector('.dUse').onclick = () => d.close('use');
    d.querySelector('.dCancel').onclick = () => d.close('cancel');
    d.returnValue = 'cancel';
    d.showModal();
  });
}
