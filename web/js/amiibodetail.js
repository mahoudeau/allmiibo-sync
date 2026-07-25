// Per-amiibo detail page: full-resolution artwork and everything the database
// and the ID itself can say. Reached from the collection; stateless — owned /
// on-device flags travel in the query string.
//
//   amiibo.html?id=<16 hex>[&owned=1][&device=1][&vehicles=Warp Star,...]

import {
  describeAmiibo,
  characterName,
  hasVehicles,
  KNOWN_VEHICLES,
  amiiboVersion,
} from './amiibo.js';
import { AMIIBO_RELEASE } from '../data/amiibo-db.js';

const params = new URLSearchParams(location.search);
const id = (params.get('id') ?? '').toLowerCase();
const content = document.getElementById('content');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  if (!/^[0-9a-f]{16}$/.test(id)) {
    content.textContent = '';
    content.append(el('div', 'status err', 'No valid amiibo id in the URL.'));
    return;
  }

  const d = describeAmiibo(id);
  const name = d.name ?? characterName(id) ?? `Unknown amiibo`;
  document.title = name;

  content.textContent = '';

  // ---- portrait: full → med → thumb → placeholder ------------------------
  const portrait = el('div', 'portrait');
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

  // ---- facts --------------------------------------------------------------
  const facts = el('div', 'facts');
  facts.append(el('h1', null, name));

  const release = AMIIBO_RELEASE[id];
  facts.append(
    el('div', 'series', `${d.seriesName}${release ? ` · ${release.slice(0, 4)}` : ''}`)
  );

  const badges = el('div', 'badges');
  const tag = (text, cls = 'tag') => {
    const t = el('span', cls, text);
    badges.append(t);
  };
  tag(d.typeName);
  if (params.get('owned') === '1') tag('in your collection', 'tag ok-tag');
  if (params.get('device') === '1') tag('on the device', 'tag dev');
  if (!d.name) tag('not in the database', 'tag new');
  badges.append();
  facts.append(badges);

  const grid = el('dl', 'factGrid');
  const fact = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    grid.append(el('dt', null, label), el('dd', null, String(value)));
  };
  fact('Character', characterName(id) ?? '—');
  fact('Series', d.seriesName);
  fact('Type', d.typeName);
  fact('Released', release ?? 'unknown');
  fact('Format', `v${amiiboVersion(id)}${amiiboVersion(id) === 3 ? ' (NTAG I2C 2K)' : ''}`);
  facts.append(grid);

  const idLine = el('div');
  idLine.style.marginTop = '1rem';
  idLine.append(el('span', 'idmono', `${id.slice(0, 8)} ${id.slice(8)}`));
  facts.append(idLine);

  // ---- vehicles (Kirby Air Riders) ---------------------------------------
  if (hasVehicles(id)) {
    const block = el('div', 'vehiclesBlock');
    block.append(el('h2', null, 'Vehicle pairings'));
    const owned = new Set(
      (params.get('vehicles') ?? '').split(',').map((v) => v.trim()).filter(Boolean)
    );
    const chips = el('div', 'vehicles');
    for (const vehicle of [...new Set([...KNOWN_VEHICLES, ...owned])].sort()) {
      const chip = el('span', `chip${owned.has(vehicle) ? ' have' : ''}`, vehicle);
      chip.title = owned.has(vehicle) ? `${vehicle} — held` : `${vehicle} — not in your dumps`;
      chips.append(chip);
    }
    block.append(chips);
    facts.append(block);
  }

  content.append(portrait, facts);
}

render();
