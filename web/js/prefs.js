// One tiny surface for every stored preference. All keys live under the
// allmiibo: namespace; values are JSON except the three the inline first-paint
// <head> scripts read as raw strings (mode/theme/pirate) — those stay raw so
// the pre-paint scripts on every page keep working byte-identically.

const RAW_KEYS = new Set(['allmiibo:mode', 'allmiibo:theme', 'allmiibo:pirate']);

export const KEYS = {
  mode: 'allmiibo:mode',            // 'default' | 'advanced'   (raw)
  theme: 'allmiibo:theme',          // 'a' | 'b' | 'c'          (raw)
  pirate: 'allmiibo:pirate',        // '0'..'11'                (raw)
  view: 'allmiibo:view',            // 'cards' | 'list' — default 'cards'
  srcMode: 'allmiibo:srcMode',      // 'local' | 'device' — hero add-source mode
  sort: 'allmiibo:sort',            // 'release' | 'name' | 'completion'
  filter: 'allmiibo:filter',        // 'all' | 'owned' | 'missing' | 'notondevice'
  types: 'allmiibo:types',          // string[] of type names, [] = all
  openSeries: 'allmiibo:openSeries',// number[] of series the user opened
  // 'dump' | 'smart' | 'identity' | 'replace' | 'wipe' | 'check'
  // | 'organise-device' | 'organise-local' | 'bundle-local' | 'bundle-device'
  syncOp: 'allmiibo:syncOp',
  syncOpts: 'allmiibo:syncOpts',    // { [op]: { ...checkbox state } } — per-op, never shared
  deviceRoot: 'allmiibo:deviceRoot',// 'E:/amiibo'
  advancedToast: 'allmiibo:advToast', // one-time "advanced on" toast shown
  showHhd: 'allmiibo:showHhd',      // show the fan-made HHD card set (boolean, default true)
};

export function get(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return RAW_KEYS.has(key) ? raw : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(key, RAW_KEYS.has(key) ? String(value) : JSON.stringify(value));
  } catch {}
}

export function remove(key) {
  try { localStorage.removeItem(key); } catch {}
}

// One-shot migration from the pre-namespace keys; guarded so it never reruns.
export function migrate() {
  try {
    if (localStorage.getItem('allmiibo:prefsv')) return;
    const view = localStorage.getItem('collectionView'); // 'cards' | 'compact'
    if (view) set(KEYS.view, view === 'cards' ? 'cards' : 'list');
    const sort = localStorage.getItem('collectionSort'); // 'release' | 'name'
    if (sort === 'name' || sort === 'release') set(KEYS.sort, sort);
    localStorage.removeItem('collectionView');
    localStorage.removeItem('collectionSort');
    localStorage.setItem('allmiibo:prefsv', '1');
  } catch {}
}
