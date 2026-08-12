// How a collection is filtered, counted and ordered.
//
// Lifted out of collectionui.js so more than one page can present the same
// library the same way. The collection page and the admin should agree on what
// "owned" means, what the sort modes do, and which amiibo a search matches;
// two implementations of that would drift, and the drift would show up as the
// two pages disagreeing about the same data.
//
// Everything here is pure and DOM-free: it takes a collection built by
// buildCollection() in amiibo.js and answers questions about it. The rendering
// stays with each page, because the collection page draws owned/missing badges
// and the admin draws edit affordances, and those are genuinely different.

/** The filter pills, in order. `needsDevice` ones are hidden until one is scanned. */
export const FILTERS = Object.freeze([
  { value: 'all', label: 'ALL' },
  { value: 'owned', label: 'OWNED' },
  { value: 'missing', label: 'MISSING' },
  { value: 'notondevice', label: 'NOT ON DEVICE', needsDevice: true },
]);

export const SORT_MODES = Object.freeze(['release', 'release-desc', 'name', 'completion']);

/**
 * Normalise a stored filter value.
 *
 * "not on device" is meaningless without a device, and a stale preference must
 * not leave the page filtered by something the user cannot see or clear.
 */
export function normaliseFilter(stored, { hasDevice = false } = {}) {
  if (stored === 'notondevice' && !hasDevice) return 'all';
  return FILTERS.some((f) => f.value === stored) ? stored : 'all';
}

/** How many amiibo fall into each filter, for the pill counts. */
export function filterCounts(collection) {
  const counts = { all: 0, owned: 0, missing: 0, notondevice: 0 };
  if (!collection) return counts;
  for (const g of collection.series) {
    for (const i of g.items) {
      counts.all++;
      if (i.hasLocal || i.hasDevice) counts.owned++;
      else counts.missing++;
      // Strictly false, not falsy: undefined means no device has been scanned,
      // which is not the same as "this one is missing from it".
      if (i.hasDevice === false) counts.notondevice++;
    }
  }
  return counts;
}

/**
 * Whether one item survives the current filter and search.
 *
 * `text` is the row's precomputed haystack, already lowercased. Building it once
 * per row and testing a substring here is what keeps filtering off the
 * rebuild path.
 */
export function matchesFilter(item, text, { filter = 'all', query = '' } = {}) {
  if (filter === 'owned' && !item.hasLocal && !item.hasDevice) return false;
  if (filter === 'missing' && (item.hasLocal || item.hasDevice)) return false;
  if (filter === 'notondevice' && item.hasDevice !== false) return false;
  if (query && !text.includes(query)) return false;
  return true;
}

/**
 * Earliest release in a series, memoised onto the group.
 *
 * @param {object} group
 * @param {object} releases  id -> ISO date, i.e. AMIIBO_RELEASE
 */
export function seriesDate(group, releases) {
  if (group._date === undefined) {
    const dates = group.items.map((i) => releases[i.id]).filter(Boolean).sort();
    group._date = dates[0] ?? null;
  }
  return group._date;
}

/**
 * How complete a series is, 0 to 1, or -1 when nothing in it is known.
 *
 * Only catalogued entries count, so a folder full of unrecognised dumps cannot
 * report a series as more than complete.
 */
export function completionRatio(group) {
  const known = group.items.filter((i) => i.inDatabase || i.special).length;
  if (!known) return -1;
  return group.items.filter(
    (i) => (i.hasLocal || i.hasDevice) && (i.inDatabase || i.special)
  ).length / known;
}

/**
 * Series in display order. Returns a new array; the input is not reordered.
 *
 * Release order is the default and the fiddly one: a series with no dated entry
 * sorts after every dated one rather than being treated as ancient, and ties
 * fall back to the series byte so the order is stable rather than incidental.
 */
export function sortSeries(groups, mode, releases) {
  const out = [...groups];
  if (mode === 'name') {
    out.sort((a, b) => a.seriesName.localeCompare(b.seriesName));
  } else if (mode === 'completion') {
    out.sort((a, b) =>
      completionRatio(b) - completionRatio(a) || a.seriesName.localeCompare(b.seriesName));
  } else if (mode === 'release-desc') {
    out.sort((a, b) => {
      const da = seriesDate(a, releases);
      const db = seriesDate(b, releases);
      if (da && db && da !== db) return db.localeCompare(da);
      if (!da !== !db) return da ? -1 : 1; // undated still last
      return b.series - a.series;
    });
  } else {
    out.sort((a, b) => {
      const da = seriesDate(a, releases);
      const db = seriesDate(b, releases);
      if (da && db && da !== db) return da.localeCompare(db);
      if (!da !== !db) return da ? -1 : 1;
      return a.series - b.series;
    });
  }
  return out;
}

/**
 * The searchable text for one amiibo, lowercased.
 *
 * Built once per row and reused on every keystroke. Includes the ID so a paste
 * of one finds it, and the filenames so searching for what is on disk works.
 */
export function searchText(item, { seriesName = '', fileNames = [] } = {}) {
  return [item.name ?? '', item.id, seriesName, ...fileNames].join(' ').toLowerCase();
}
