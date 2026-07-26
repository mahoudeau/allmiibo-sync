// Per-amiibo detail page — a hub, not a dead end. Ownership and device state
// come from the collection's scan cache (the source of truth); URL params are
// only a fallback for links opened outside this tab. Prev/next follow the
// collection's current display order, and every amiibo links onward to its
// series and its character variants.
//
//   amiibo.html?id=<16 hex>

import {
  describeAmiibo,
  characterName,
  hasVehicles,
  isHhdItemCards,
  KNOWN_VEHICLES,
  amiiboVersion,
} from './amiibo.js';
import { AMIIBO_NAMES, AMIIBO_RELEASE } from '../data/amiibo-db.js';
import { toast } from './ui.js';
import { ICONS } from './icons.js';
import { hhdMark } from './sprite.js';
import { HHD_CARDS } from '../data/hhd-cards.js';

const params = new URLSearchParams(location.search);
const id = (params.get('id') ?? '').toLowerCase();
const content = document.getElementById('content');

// ---- scan cache (source of truth for ownership) ---------------------------

let cache = null;
try { cache = JSON.parse(sessionStorage.getItem('collectionScan')); } catch {}
const localIds = cache ? new Set(cache.localIds) : null;
const deviceIds = cache?.deviceIds ? new Set(cache.deviceIds) : null;
const namesById = cache ? new Map(cache.namesById) : new Map();
const vehiclesById = cache ? new Map(cache.vehiclesById.map(([i, m]) => [i, new Map(m)])) : new Map();
const hhdLocalUids = new Set(cache?.hhdLocalUids ?? []);
const hhdDeviceUids = new Set(cache?.hhdDeviceUids ?? []);

let order = null;
try { order = JSON.parse(sessionStorage.getItem('allmiibo:s:order')); } catch {}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const nameOf = (someId) => AMIIBO_NAMES[someId] ?? characterName(someId) ?? someId;

// ---- top nav ----------------------------------------------------------------

document.getElementById('backIco').innerHTML = ICONS.back;
for (const s of document.querySelectorAll('[data-ico]')) s.innerHTML = ICONS[s.dataset.ico] ?? '';

// Back preserves the collection's state when we came from it.
document.getElementById('backLink').addEventListener('click', (e) => {
  if (document.referrer.includes('collection.html') && history.length > 1) {
    e.preventDefault();
    history.back();
  }
});

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

// ---- render -------------------------------------------------------------------

function render() {
  if (!/^[0-9a-f]{16}$/.test(id) ) {
    content.textContent = '';
    const box = el('div', 'empty');
    box.style.gridColumn = '1 / -1';
    box.innerHTML = `<span class="ico">${ICONS.skull}</span>
      <div class="eTitle">THAT'S NOT AN AMIIBO</div>
      <p>No amiibo has this ID.</p>`;
    const btn = el('button', 'primary', 'BROWSE THE COLLECTION');
    btn.addEventListener('click', () => { location.href = './collection.html'; });
    box.append(btn);
    content.append(box);
    return;
  }

  const d = describeAmiibo(id);
  const hhd = isHhdItemCards(id);
  const name = hhd ? 'Happy Home Designer cards' : d.name ?? characterName(id) ?? 'Unknown amiibo';
  document.title = `${name} · allmiibo`;

  content.textContent = '';

  // ---- portrait: full → med → thumb → placeholder ------------------------
  const portrait = el('div', 'portrait');
  if (hhd) {
    // A fan-made set has no official artwork — this stack of cards is ours.
    portrait.classList.add('hhdMark');
    portrait.innerHTML = hhdMark(14);
  } else {
    const img = document.createElement('img');
    img.alt = name;
    const tiers = ['full', 'med', 'thumb'];
    let tier = 0;
    img.src = `./data/images/${tiers[tier]}/${id}.png`;
    img.addEventListener('error', () => {
      tier++;
      if (tier < tiers.length) img.src = `./data/images/${tiers[tier]}/${id}.png`;
      else {
        img.remove();
        portrait.append(el('span', 'noArt', (name[0] ?? '?').toUpperCase()));
      }
    });
    portrait.append(img);
  }

  // ---- facts ----------------------------------------------------------------
  const facts = el('div', 'facts');
  facts.append(el('h1', null, name));

  const release = AMIIBO_RELEASE[id];
  facts.append(el('div', 'subtitle', hhd
    ? 'Animal Crossing · Card set'
    : [d.seriesName, d.typeName, release?.slice(0, 4)].filter(Boolean).join(' · ')));

  // Ownership: the scan cache is authoritative; URL params only fill in for
  // links opened in a fresh tab; and with neither we say so instead of guessing.
  const badges = el('div', 'badges');
  const tag = (text, cls = 'tag') => badges.append(el('span', cls, text));
  if (localIds) {
    if (localIds.has(id)) tag('OWNED', 'tag ok-tag');
    if (deviceIds?.has(id)) {
      const t = el('span', 'tag dev');
      t.innerHTML = `${ICONS.bluetooth ? `<span class="ico">${ICONS.bluetooth}</span>` : ''}ON DEVICE`;
      badges.append(t);
    }
  } else if (params.get('owned') === '1') {
    tag('OWNED', 'tag ok-tag');
  } else {
    tag('NOT SCANNED', 'tag unknown');
  }
  if (!d.name && !hhd) tag('NOT IN DATABASE', 'tag new');
  facts.append(badges);

  if (hhd) {
    facts.append(el('p', 'subtitle',
      'A fan-made set of 91 item-unlock cards for Animal Crossing: Happy Home Designer — not official Nintendo cards. They all share one fabricated amiibo ID, so this single entry stands for the whole set; the cards themselves are told apart by their NFC UID and listed below.'));
  }

  // Your files — the "where is my dump" answer.
  const files = namesById.get(id);
  if (files?.length) {
    const block = el('div', 'fileBlock');
    block.append(el('h2', null, `YOUR FILES (${files.length})`));
    const ul = el('ul');
    for (const f of files.slice(0, 12)) ul.append(el('li', null, f));
    if (files.length > 12) ul.append(el('li', null, `… and ${files.length - 12} more`));
    block.append(ul);
    facts.append(block);
  }

  // ID + copy
  const idRow = el('div', 'idRow');
  idRow.append(el('span', 'idmono', `${id.slice(0, 8)} ${id.slice(8)}`));
  const copyBtn = el('button', null, 'COPY');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(id);
      toast('ID copied');
    } catch {
      toast("Couldn't copy — clipboard is blocked here.", { kind: 'err' });
    }
  });
  idRow.append(copyBtn);
  facts.append(idRow);

  // Format detail is trivia — advanced only.
  const fmt = el('div', 'subtitle advanced-only',
    `Format v${amiiboVersion(id)}${amiiboVersion(id) === 3 ? ' (NTAG I2C 2K)' : ''}`);
  facts.append(fmt);

  // ---- HHD item cards ------------------------------------------------------
  if (hhd) {
    const block = el('div', 'cardsBlock');
    const have = HHD_CARDS.filter((c) => hhdLocalUids.has(c.uid)).length;
    block.append(el('h2', null, `THE CARDS (${have}/${HHD_CARDS.length})`));
    const grid = el('div', 'cardGrid');
    for (const c of HHD_CARDS) {
      const local = hhdLocalUids.has(c.uid);
      const onDev = hhdDeviceUids.has(c.uid);
      const tile = el('span', `cTile${local ? ' have' : ''}`);
      const top = el('span', 'cTop');
      top.append(el('span', 'cNum', String(c.card).padStart(2, '0')));
      top.append(el('span', 'cCount', `${c.count} items`));
      tile.append(top);
      tile.append(el('span', 'cTeaser', `${c.teaser}…`));
      if (onDev) {
        const dot = el('span', 'cDev');
        dot.innerHTML = `<span class="ico">${ICONS.bluetooth}</span>`;
        dot.title = 'On device';
        tile.append(dot);
      }
      grid.append(tile);
    }
    block.append(grid);
    block.append(el('p', 'vNote open',
      'Solid = you have a dump of that card. Each card lists a taste of what it unlocks.'));
    facts.append(block);
  }

  // ---- vehicles (Kirby Air Riders) ---------------------------------------
  if (hasVehicles(id)) {
    const block = el('div', 'vehiclesBlock');
    const h = el('h2', null, 'VEHICLES ');
    const why = el('button', 'why', '?');
    why.setAttribute('aria-label', 'What are vehicle pairings?');
    h.append(why);
    block.append(h);

    const held = vehiclesById.get(id);
    const owned = held
      ? new Set([...held.keys()].filter((v) => held.get(v).local))
      : new Set((params.get('vehicles') ?? '').split(',').map((v) => v.trim()).filter(Boolean));
    const chips = el('div', 'vehicles');
    for (const vehicle of [...new Set([...KNOWN_VEHICLES, ...owned])].sort()) {
      const card = el('span', `vCard${owned.has(vehicle) ? ' have' : ''}`);
      const art = el('span', 'vArt');
      art.dataset.initial = vehicle[0];
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = `./data/images/vehicles/${vehicle.toLowerCase().replace(/\s+/g, '-')}.png`;
      img.addEventListener('error', () => img.remove());
      art.append(img);
      card.append(art, el('span', 'vName', vehicle));
      chips.append(card);
    }
    block.append(chips);
    const note = el('p', 'vNote',
      'Every rider fits every machine. Solid = you have a dump of that pairing.');
    why.addEventListener('click', () => note.classList.toggle('open'));
    block.append(note);
    facts.append(block);
  }

  content.append(portrait, facts);
  renderStrips(d);
}

// ---- onward navigation -----------------------------------------------------------

function idsInSeries(seriesByte) {
  return Object.keys(AMIIBO_NAMES)
    .filter((x) => x.slice(12, 14) === seriesByte)
    .sort((a, b) => (AMIIBO_RELEASE[a] ?? '9999').localeCompare(AMIIBO_RELEASE[b] ?? '9999') || a.localeCompare(b));
}

function stripCell(someId, current) {
  const a = el('a', `${someId === current ? 'current' : ''}${localIds?.has(someId) ? ' owned' : ''}`);
  a.href = `./amiibo.html?id=${someId}`;
  const art = el('span', 'sArt');
  art.dataset.initial = (nameOf(someId)[0] ?? '?').toUpperCase();
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = `./data/images/thumb/${someId}.png`;
  img.addEventListener('error', () => img.remove());
  art.append(img);
  a.append(art, el('span', 'sNm', nameOf(someId)));
  return a;
}

function renderStrips(d) {
  const seriesByte = id.slice(12, 14);
  const siblings = idsInSeries(seriesByte);
  if (siblings.length > 1) {
    const strip = document.getElementById('seriesStrip');
    strip.hidden = false;
    document.getElementById('stripTitle').textContent =
      `MORE IN ${d.seriesName.toUpperCase()} (${siblings.length})`;
    const row = document.getElementById('stripRow');
    for (const s of siblings) row.append(stripCell(s, id));
    row.querySelector('.current')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  // Same character = same head (first 8 hex chars).
  const head = id.slice(0, 8);
  const variants = Object.keys(AMIIBO_NAMES).filter((x) => x.slice(0, 8) === head);
  if (variants.length > 1) {
    const strip = document.getElementById('variantStrip');
    strip.hidden = false;
    const row = document.getElementById('variantRow');
    for (const v of variants) row.append(stripCell(v, id));
  }
}

render();
wireSequence();
