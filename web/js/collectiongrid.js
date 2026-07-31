// The collection grid: series as collapsible groups, amiibo as cells inside.
//
// Lifted out of collectionui.js so the admin presents the library the same way
// the collection page does, rather than growing a second list that drifts.
// collectionview.js already holds the filtering and ordering; this holds the
// shape those decisions are drawn into.
//
// What stays with each page is the cell. The collection page draws owned and
// missing badges, dump counts, vehicle tallies; the admin draws a curated mark
// and an edit affordance. Those are genuinely different, so `cell` is a hook.
// Everything around it — the <details> per series, the summary with its art and
// year, the sub-headers over a large mixed series, the hidden-toggling filter —
// is identical on both, and is here.
//
// No imports: this module knows about elements, not about the database, the
// icon set or the preferences. Everything it draws that is particular to a page
// arrives through the options. That also makes it testable, which the code it
// came from was not.

/**
 * Build the series groups for a collection.
 *
 * @param {Array} groups  series groups, already in display order
 * @param {object} hooks
 * @param {(item, group) => Element} hooks.cell        one amiibo
 * @param {(group) => Element|null} [hooks.pill]       the summary's right-hand badge
 * @param {(group) => string|null} [hooks.art]         src for the summary thumbnail
 * @param {(group) => string|null} [hooks.year]        the year beside the name
 * @param {(group) => boolean} [hooks.isOpen]          starts expanded?
 * @param {(event) => void} [hooks.onToggle]           open/close listener
 * @param {string} [hooks.chevron]                     markup for the chevron
 * @param {(item, group) => string} [hooks.searchText] the row's search haystack
 * @param {number} [hooks.subheadsOver]                sub-header threshold
 * @param {Document} [hooks.doc]
 *
 * @returns {{ frag: DocumentFragment, rows: Array, groupEls: Map }}
 *   `rows` is the flat index the filter walks: { el, groupEl, item, group, text }.
 */
export function buildSeriesGrid(groups, {
  cell,
  pill = null,
  art = null,
  year = null,
  isOpen = null,
  onToggle = null,
  chevron = '',
  searchText = null,
  subheadsOver = 100,
  doc = globalThis.document,
} = {}) {
  if (typeof cell !== 'function') throw new TypeError('buildSeriesGrid needs a cell hook');

  const rows = [];
  const groupEls = new Map();
  const frag = doc.createDocumentFragment();

  for (const group of groups) {
    const details = doc.createElement('details');
    details.className = 'series';
    details.dataset.series = String(group.series);
    details.open = isOpen ? !!isOpen(group) : false;
    if (onToggle) details.addEventListener('toggle', onToggle);

    const summary = doc.createElement('summary');
    const head = doc.createElement('span');
    head.className = 'seriesHead';

    const src = art?.(group);
    if (src) {
      const headArt = doc.createElement('img');
      headArt.className = 'seriesArt';
      headArt.loading = 'lazy';
      headArt.alt = '';
      headArt.width = 28;
      headArt.height = 28;
      headArt.src = src;
      head.append(headArt);
    }

    const label = doc.createElement('span');
    label.textContent = group.seriesName;
    head.append(label);

    const y = year?.(group);
    if (y) {
      const yEl = doc.createElement('span');
      yEl.className = 'year';
      yEl.textContent = y;
      head.append(yEl);
    }

    const grow = doc.createElement('span');
    grow.className = 'grow';
    summary.append(head, grow);

    const badge = pill?.(group);
    if (badge) summary.append(badge);

    if (chevron) {
      const chev = doc.createElement('span');
      chev.className = 'chev';
      chev.innerHTML = chevron;
      summary.append(chev);
    }
    details.append(summary);

    const box = doc.createElement('div');
    box.className = 'items';

    // A giant mixed series (Animal Crossing) gets type sub-headers so the card
    // flood is skimmable. Sorting by type only happens when they are used, so
    // every other series keeps the database's own order.
    const types = new Set(group.items.map((i) => i.typeName));
    const useSubheads = group.items.length > subheadsOver && types.size > 1;
    const items = useSubheads
      ? [...group.items].sort(
        (a, b) => a.typeName.localeCompare(b.typeName) || a.name.localeCompare(b.name))
      : group.items;

    let currentType = null;
    for (const item of items) {
      if (useSubheads && item.typeName !== currentType) {
        currentType = item.typeName;
        const n = items.filter((i) => i.typeName === currentType).length;
        const sh = doc.createElement('div');
        sh.className = 'subHead';
        sh.textContent = `${currentType.toUpperCase()}S · ${n}`;
        box.append(sh);
      }
      const el = cell(item, group);
      box.append(el);
      rows.push({
        el,
        groupEl: details,
        item,
        group,
        text: searchText
          ? searchText(item, group)
          : `${item.name} ${group.seriesName} ${item.id}`.toLowerCase(),
      });
    }

    details.append(box);
    groupEls.set(group.series, { el: details });
    frag.append(details);
  }

  return { frag, rows, groupEls };
}

/**
 * Show and hide prebuilt cells for the current filter.
 *
 * Nothing is rebuilt: this only toggles [hidden], which is what keeps typing in
 * the search box cheap over ~950 cells. A group with no visible cell hides
 * itself, and while a filter is active every surviving group is forced open —
 * otherwise a match inside a collapsed series looks like no match at all.
 *
 * @returns {{ shown: number, order: string[], filtering: boolean }}
 */
export function applyGridFilter({
  rows, groupEls, root, keep, filter = 'all', query = '',
}) {
  const visible = new Map();
  const order = [];

  for (const r of rows) {
    const show = keep(r.item, r.text, { filter, query });
    r.el.hidden = !show;
    if (show) {
      order.push(r.item.id);
      visible.set(r.groupEl, (visible.get(r.groupEl) ?? 0) + 1);
    }
  }

  const filtering = filter !== 'all' || !!query;
  let shown = 0;
  for (const { el } of groupEls.values()) {
    const n = visible.get(el) ?? 0;
    el.hidden = n === 0;
    shown += n;
    if (filtering && n > 0) el.open = true;
  }

  // Sub-headers count a whole type, so they lie about a filtered subset.
  if (root) {
    for (const sh of root.querySelectorAll('.subHead')) sh.hidden = filtering;
  }

  return { shown, order, filtering };
}

/**
 * Reorder groups in place, without rebuilding any of them.
 *
 * Appending an element that is already a child moves it, so this is 31 moves
 * rather than ~950 cell constructions.
 */
export function reorderGroups(root, groups, groupEls) {
  for (const group of groups) {
    const g = groupEls.get(group.series);
    if (g) root.append(g.el);
  }
}
