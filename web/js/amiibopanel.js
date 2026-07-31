// One amiibo, drawn: the portrait, the facts beside it, and a strip of onward
// links.
//
// Lifted out of amiibodetail.js so the admin can show the same thing it shows a
// visitor, rather than a second view of the same data that drifts. Same reason
// collectiongrid.js exists, same shape: the module builds elements and takes
// everything page-specific through hooks.
//
// What arrives through options, and why each one has to:
//
//   art        the site is served from './' and the admin from '/', so a
//              literal path is correct on exactly one of them. This was four
//              inline literals and is the reason the split was needed at all.
//   ownership  resolved by the caller from wherever it knows — the collection's
//              scan cache, URL params, or nothing. The module never reads
//              sessionStorage or location, so it has no opinion about tabs.
//   sections   the admin's editor panel is 24rem wide; 91 card tiles in it
//              would be absurd. A caller asks for what it wants.
//   onCopy     the clipboard and the toast are page furniture.
//   adorn      the admin hangs an edit affordance on each section. One hook
//              beats a second renderer with an `editable` flag running through
//              it.
//
// It does not set document.title, does not scroll, and does not read the URL.
// In an admin panel each of those is wrong, and the page can do all three with
// what it gets back.

import {
  describeAmiibo,
  characterName,
  hasVehicles,
  isHhdItemCards,
  KNOWN_VEHICLES,
  amiiboVersion,
} from './amiibo.js';
import { AMIIBO_NAMES, AMIIBO_RELEASE } from '../data/amiibo-db.js';
import { ICONS } from './icons.js';
import { hhdMark } from './sprite.js';
import { HHD_CARDS } from '../data/hhd-cards.js';
import { TIERS } from './artwork.js';

const ID_RE = /^[0-9a-f]{16}$/;

/** The sections a full detail page draws, in order. */
export const DETAIL_SECTIONS = Object.freeze([
  'portrait', 'title', 'badges', 'hhdNote', 'files', 'id', 'format', 'cards', 'vehicles',
]);

/** The display name for any ID, database first, then the ID's own character. */
export function nameOf(id) {
  return AMIIBO_NAMES[id] ?? characterName(id) ?? id;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Build the detail view for one amiibo.
 *
 * @param {string} id  16 lowercase hex; anything else renders the empty state
 * @param {object} o
 * @param {(id: string, tier?: string) => string} o.art        required
 * @param {(name: string) => string} [o.vehicleArt]            omit to skip vehicle images
 * @param {object|null} [o.ownership]  { owned, onDevice, files, vehicles, hhdLocal, hhdDevice }
 *                                     null means "nothing has been scanned"
 * @param {string[]} [o.sections]
 * @param {(id: string) => void} [o.onCopy]      omit to leave out the COPY button
 * @param {() => void} [o.onEmptyAction]         the invalid-id state's button
 * @param {(part: string, node: Element) => void} [o.adorn]
 * @param {Document} [o.doc]
 *
 * @returns {{ valid: boolean, name: string, portrait: Element|null,
 *             facts: Element|null, frag: DocumentFragment,
 *             parts: Record<string, Element> }}
 */
export function buildAmiiboDetail(id, {
  art,
  vehicleArt = null,
  ownership = null,
  sections = DETAIL_SECTIONS,
  onCopy = null,
  onEmptyAction = null,
  adorn = null,
  doc = globalThis.document,
} = {}) {
  if (typeof art !== 'function') throw new TypeError('buildAmiiboDetail needs an art hook');

  const want = new Set(sections);
  const parts = {};
  const frag = doc.createDocumentFragment();
  const mark = (key, node) => { parts[key] = node; adorn?.(key, node); return node; };

  if (!ID_RE.test(id)) {
    const box = el(doc, 'div', 'empty');
    box.style.gridColumn = '1 / -1';
    box.innerHTML = `<span class="ico">${ICONS.skull}</span>
      <div class="eTitle">THAT'S NOT AN AMIIBO</div>
      <p>No amiibo has this ID.</p>`;
    if (onEmptyAction) {
      const btn = el(doc, 'button', 'primary', 'BROWSE THE COLLECTION');
      btn.addEventListener('click', onEmptyAction);
      box.append(btn);
    }
    frag.append(box);
    return { valid: false, name: '', portrait: null, facts: null, frag, parts };
  }

  const d = describeAmiibo(id);
  const hhd = isHhdItemCards(id);
  const name = hhd ? 'Happy Home Designer cards' : d.name ?? characterName(id) ?? 'Unknown amiibo';

  // ---- portrait: full -> med -> thumb -> placeholder ----------------------
  let portrait = null;
  if (want.has('portrait')) {
    portrait = el(doc, 'div', 'portrait');
    if (hhd) {
      // A fan-made set has no official artwork — this stack of cards is ours.
      portrait.classList.add('hhdMark');
      portrait.innerHTML = hhdMark(14);
    } else {
      const img = doc.createElement('img');
      img.alt = name;
      let tier = 0;
      img.src = art(id, TIERS[tier]);
      img.addEventListener('error', () => {
        tier++;
        if (tier < TIERS.length) img.src = art(id, TIERS[tier]);
        else {
          img.remove();
          portrait.append(el(doc, 'span', 'noArt', (name[0] ?? '?').toUpperCase()));
        }
      });
      portrait.append(img);
    }
    mark('portrait', portrait);
  }

  // ---- facts --------------------------------------------------------------
  const facts = el(doc, 'div', 'facts');

  if (want.has('title')) {
    facts.append(mark('title', el(doc, 'h1', null, name)));
    const release = AMIIBO_RELEASE[id];
    facts.append(mark('subtitle', el(doc, 'div', 'subtitle', hhd
      ? 'Animal Crossing · Card set'
      : [d.seriesName, d.typeName, release?.slice(0, 4)].filter(Boolean).join(' · '))));
  }

  // Ownership. `null` is a third state, not a falsy second one: "nothing has
  // been scanned" and "scanned, and you do not have this" look the same to a
  // boolean and must not look the same on screen.
  if (want.has('badges')) {
    const badges = el(doc, 'div', 'badges');
    const tag = (text, cls = 'tag') => badges.append(el(doc, 'span', cls, text));
    if (ownership) {
      if (ownership.owned) tag('OWNED', 'tag ok-tag');
      if (ownership.onDevice) {
        const t = el(doc, 'span', 'tag dev');
        t.innerHTML = `${ICONS.bluetooth ? `<span class="ico">${ICONS.bluetooth}</span>` : ''}ON DEVICE`;
        badges.append(t);
      }
    } else {
      tag('NOT SCANNED', 'tag unknown');
    }
    if (!d.name && !hhd) tag('NOT IN DATABASE', 'tag new');
    facts.append(mark('badges', badges));
  }

  if (hhd && want.has('hhdNote')) {
    facts.append(mark('hhdNote', el(doc, 'p', 'subtitle',
      'A fan-made set of 91 item-unlock cards for Animal Crossing: Happy Home Designer — not official Nintendo cards. They all share one fabricated amiibo ID, so this single entry stands for the whole set; the cards themselves are told apart by their NFC UID and listed below.')));
  }

  // Your files — the "where is my dump" answer.
  const files = ownership?.files ?? [];
  if (want.has('files') && files.length) {
    const block = el(doc, 'div', 'fileBlock');
    block.append(el(doc, 'h2', null, `YOUR FILES (${files.length})`));
    const ul = el(doc, 'ul');
    for (const f of files.slice(0, 12)) ul.append(el(doc, 'li', null, f));
    if (files.length > 12) ul.append(el(doc, 'li', null, `… and ${files.length - 12} more`));
    block.append(ul);
    facts.append(mark('files', block));
  }

  if (want.has('id')) {
    const idRow = el(doc, 'div', 'idRow');
    idRow.append(el(doc, 'span', 'idmono', `${id.slice(0, 8)} ${id.slice(8)}`));
    if (onCopy) {
      const copyBtn = el(doc, 'button', null, 'COPY');
      copyBtn.addEventListener('click', () => onCopy(id));
      idRow.append(copyBtn);
    }
    facts.append(mark('id', idRow));
  }

  // Format detail is trivia — advanced only.
  if (want.has('format')) {
    const v = amiiboVersion(id);
    facts.append(mark('format', el(doc, 'div', 'subtitle advanced-only',
      `Format v${v}${v === 3 ? ' (NTAG I2C 2K)' : ''}`)));
  }

  // ---- the fan-made card set ---------------------------------------------
  if (hhd && want.has('cards')) {
    const held = ownership?.hhdLocal ?? new Set();
    const onDev = ownership?.hhdDevice ?? new Set();
    const block = el(doc, 'div', 'cardsBlock');
    const have = HHD_CARDS.filter((c) => held.has(c.uid)).length;
    block.append(el(doc, 'h2', null, `THE CARDS (${have}/${HHD_CARDS.length})`));
    const grid = el(doc, 'div', 'cardGrid');
    for (const c of HHD_CARDS) {
      const tile = el(doc, 'span', `cTile${held.has(c.uid) ? ' have' : ''}`);
      const top = el(doc, 'span', 'cTop');
      top.append(el(doc, 'span', 'cNum', String(c.card).padStart(2, '0')));
      top.append(el(doc, 'span', 'cCount', `${c.count} items`));
      tile.append(top);
      tile.append(el(doc, 'span', 'cTeaser', `${c.teaser}…`));
      if (onDev.has(c.uid)) {
        const dot = el(doc, 'span', 'cDev');
        dot.innerHTML = `<span class="ico">${ICONS.bluetooth}</span>`;
        dot.title = 'On device';
        tile.append(dot);
      }
      grid.append(tile);
    }
    block.append(grid);
    block.append(el(doc, 'p', 'vNote open',
      'Solid = you have a dump of that card. Each card lists a taste of what it unlocks.'));
    facts.append(mark('cards', block));
  }

  // ---- Kirby Air Riders vehicle pairings ---------------------------------
  if (hasVehicles(id) && want.has('vehicles')) {
    const block = el(doc, 'div', 'vehiclesBlock');
    const h = el(doc, 'h2', null, 'VEHICLES ');
    const why = el(doc, 'button', 'why', '?');
    why.setAttribute('aria-label', 'What are vehicle pairings?');
    h.append(why);
    block.append(h);

    const owned = ownership?.vehicles ?? new Set();
    const chips = el(doc, 'div', 'vehicles');
    for (const vehicle of [...new Set([...KNOWN_VEHICLES, ...owned])].sort()) {
      const card = el(doc, 'span', `vCard${owned.has(vehicle) ? ' have' : ''}`);
      const artSlot = el(doc, 'span', 'vArt');
      artSlot.dataset.initial = vehicle[0];
      if (vehicleArt) {
        const img = doc.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = vehicleArt(vehicle);
        artSlot.append(img);
      }
      card.append(artSlot, el(doc, 'span', 'vName', vehicle));
      chips.append(card);
    }
    block.append(chips);
    const note = el(doc, 'p', 'vNote',
      'Every rider fits every machine. Solid = you have a dump of that pairing.');
    why.addEventListener('click', () => note.classList.toggle('open'));
    block.append(note);
    facts.append(mark('vehicles', block));
  }

  if (portrait) frag.append(portrait);
  frag.append(facts);
  return { valid: true, name, portrait, facts, frag, parts };
}

/**
 * A row of onward links.
 *
 * Returns the marked cell rather than scrolling to it: scrolling is a page's
 * decision, and an admin panel scrolling itself sideways on every selection
 * would be hostile.
 *
 * @returns {{ frag: DocumentFragment, current: Element|null }}
 */
export function buildAmiiboStrip(ids, {
  current = null,
  art,
  href,
  isOwned = null,
  doc = globalThis.document,
} = {}) {
  if (typeof art !== 'function') throw new TypeError('buildAmiiboStrip needs an art hook');
  if (typeof href !== 'function') throw new TypeError('buildAmiiboStrip needs an href hook');

  const frag = doc.createDocumentFragment();
  let currentEl = null;

  for (const id of ids) {
    const a = el(doc, 'a', `${id === current ? 'current' : ''}${isOwned?.(id) ? ' owned' : ''}`);
    a.href = href(id);
    const slot = el(doc, 'span', 'sArt');
    slot.dataset.initial = (nameOf(id)[0] ?? '?').toUpperCase();
    const img = doc.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = art(id);
    slot.append(img);
    a.append(slot, el(doc, 'span', 'sNm', nameOf(id)));
    if (id === current) currentEl = a;
    frag.append(a);
  }

  return { frag, current: currentEl };
}
