// Per-amiibo detail page — a hub, not a dead end. Ownership and device state
// come from the collection's scan cache (the source of truth); URL params are
// only a fallback for links opened outside this tab. Prev/next follow the
// collection's current display order, and every amiibo links onward to its
// series and its character variants.
//
//   amiibo.html?id=<16 hex>
//
// The drawing is in amiibopanel.js, shared with the admin. What is left here is
// what only a page has: the URL, the scan cache, the title, the back link and
// the prev/next sequence.

import { describeAmiibo, seriesSiblings, characterVariants } from './amiibo.js';
import { buildAmiiboDetail, buildAmiiboStrip } from './amiibopanel.js';
import { makeArt, dropBrokenArt } from './artwork.js';
import { toast } from './ui.js';
import { ICONS } from './icons.js';

const params = new URLSearchParams(location.search);
const id = (params.get('id') ?? '').toLowerCase();
const content = document.getElementById('content');
const art = makeArt('./data/images');

// ---- scan cache (source of truth for ownership) ---------------------------

let cache = null;
try { cache = JSON.parse(sessionStorage.getItem('collectionScan')); } catch {}

let order = null;
try { order = JSON.parse(sessionStorage.getItem('allmiibo:s:order')); } catch {}

const localIds = cache ? new Set(cache.localIds) : null;

/**
 * What this page knows about owning this amiibo.
 *
 * Returns null when nothing has been scanned and the URL says nothing either —
 * a third state, which the panel renders as NOT SCANNED rather than guessing.
 */
function readOwnership() {
  if (cache) {
    const deviceIds = cache.deviceIds ? new Set(cache.deviceIds) : null;
    const namesById = new Map(cache.namesById);
    const vehiclesById = new Map(cache.vehiclesById.map(([i, m]) => [i, new Map(m)]));
    const held = vehiclesById.get(id);
    return {
      owned: localIds.has(id),
      onDevice: deviceIds?.has(id) ?? false,
      files: namesById.get(id) ?? [],
      vehicles: held
        ? new Set([...held.keys()].filter((v) => held.get(v).local))
        : new Set(),
      hhdLocal: new Set(cache.hhdLocalUids ?? []),
      hhdDevice: new Set(cache.hhdDeviceUids ?? []),
    };
  }
  // A link opened in a fresh tab carries what it can in the query string.
  if (params.get('owned') === '1' || params.get('vehicles')) {
    return {
      owned: params.get('owned') === '1',
      onDevice: false,
      files: [],
      vehicles: new Set((params.get('vehicles') ?? '').split(',')
        .map((v) => v.trim()).filter(Boolean)),
      hhdLocal: new Set(),
      hhdDevice: new Set(),
    };
  }
  return null;
}

// ---- page chrome ------------------------------------------------------------

function wireChrome() {
  // Called rather than run at import: any of these elements being absent used
  // to throw before render() ever ran, leaving the page on "Loading…" with
  // nothing to say why.
  const backIco = document.getElementById('backIco');
  if (backIco) backIco.innerHTML = ICONS.back;
  for (const s of document.querySelectorAll('[data-ico]')) s.innerHTML = ICONS[s.dataset.ico] ?? '';

  // Back preserves the collection's state when we came from it.
  document.getElementById('backLink')?.addEventListener('click', (e) => {
    if (document.referrer.includes('collection.html') && history.length > 1) {
      e.preventDefault();
      history.back();
    }
  });
}

function wireSequence() {
  if (!order || !order.includes(id)) return;
  const i = order.indexOf(id);
  const prev = order[i - 1];
  const next = order[i + 1];
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const go = (target) => { location.href = `./amiibo.html?id=${target}`; };
  if (prev) { prevBtn.hidden = false; prevBtn.addEventListener('click', () => go(prev)); }
  if (next) { nextBtn.hidden = false; nextBtn.addEventListener('click', () => go(next)); }
  document.getElementById('pos').textContent = `${i + 1} / ${order.length}`;
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft' && prev) go(prev);
    if (e.key === 'ArrowRight' && next) go(next);
  });
}

// ---- render -----------------------------------------------------------------

function render() {
  const detail = buildAmiiboDetail(id, {
    art,
    vehicleArt: art.vehicle,
    ownership: readOwnership(),
    onCopy: async (value) => {
      try {
        await navigator.clipboard.writeText(value);
        toast('ID copied');
      } catch {
        toast("Couldn't copy — clipboard is blocked here.", { kind: 'err' });
      }
    },
    onEmptyAction: () => { location.href = './collection.html'; },
  });

  content.textContent = '';
  content.append(detail.frag);
  if (!detail.valid) return;

  document.title = `${detail.name} · allmiibo`;
  renderStrips(describeAmiibo(id));
}

function renderStrips(d) {
  const cell = { art: (someId) => art(someId, 'thumb'), href: (someId) => `./amiibo.html?id=${someId}`, isOwned: (someId) => !!localIds?.has(someId) };

  const siblings = seriesSiblings(id);
  if (siblings.length > 1) {
    document.getElementById('seriesStrip').hidden = false;
    document.getElementById('stripTitle').textContent =
      `MORE IN ${d.seriesName.toUpperCase()} (${siblings.length})`;
    const row = document.getElementById('stripRow');
    const built = buildAmiiboStrip(siblings, { current: id, ...cell });
    row.append(built.frag);
    // The panel hands the node back rather than scrolling to it itself.
    built.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }

  const variants = characterVariants(id);
  if (variants.length > 1) {
    document.getElementById('variantStrip').hidden = false;
    const built = buildAmiiboStrip(variants, { current: id, ...cell });
    document.getElementById('variantRow').append(built.frag);
  }
}

wireChrome();
render();
wireSequence();
// One capture-phase listener for every image on the page: many amiibo have no
// artwork, and a missing file is expected rather than a fault.
dropBrokenArt(document.body);
