// Shared header, injected on every page — one source instead of six copies.
// Brand (pirate mark + wordmark), primary nav with the active page marked,
// the Advanced toggle, and Settings (theme + pirate colourway).
//
// Preferences live in localStorage and are reflected as data attributes on
// <html>; each page also sets them in a tiny inline <head> script so the
// first paint is already correct. Keys:
//   allmiibo:mode   'default' | 'advanced'   -> data-mode
//   allmiibo:theme  'a' | 'b' | 'c'          -> data-theme
//   allmiibo:pirate '0'..'11'                -> which FINISHES entry to draw

import { icon } from './icons.js';
import { FINISHES, DEFAULT_FINISH, pirateMark } from './sprite.js';

export const MODE_KEY = 'allmiibo:mode';
export const THEME_KEY = 'allmiibo:theme';
export const PIRATE_KEY = 'allmiibo:pirate';

export const THEMES = [
  { id: 'c', name: 'SHELL', bg: '#2b2b2a', fg: '#c9c7c3' },
  { id: 'a', name: 'INDIGO', bg: '#0f0f18', fg: '#f4f4f4' },
  { id: 'b', name: 'BLACK', bg: '#0a0a0a', fg: '#eaeaea' },
];

function stored(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

export function currentMode() { return stored(MODE_KEY, 'default') === 'advanced' ? 'advanced' : 'default'; }
export function currentTheme() {
  const t = stored(THEME_KEY, 'c');
  return THEMES.some((x) => x.id === t) ? t : 'c';
}
export function currentPirate() {
  const i = Number(stored(PIRATE_KEY, DEFAULT_FINISH));
  return Number.isInteger(i) && i >= 0 && i < FINISHES.length ? i : DEFAULT_FINISH;
}

export function applyMode(mode) {
  document.documentElement.dataset.mode = mode;
  store(MODE_KEY, mode);
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store(THEME_KEY, theme);
}
export function applyPirate(i) {
  store(PIRATE_KEY, String(i));
  for (const el of document.querySelectorAll('[data-pirate-mark]')) {
    el.innerHTML = pirateMark(Number(el.dataset.pirateMark), i);
  }
}

// No HOME entry — the brand mark on the left already links home.
const PAGES = [
  { href: 'collection.html', label: 'COLLECTION', ico: 'grid' },
  { href: 'sync.html', label: 'SYNC', ico: 'sync' },
  { href: 'probe.html', label: 'PROBE', ico: 'activity', advanced: true },
  { href: 'write-test.html', label: 'WRITE TEST', ico: 'flask', advanced: true },
];

function activePage() {
  const file = location.pathname.split('/').pop() || 'index.html';
  return file === 'amiibo.html' ? 'collection.html' : file;
}

function navLinks() {
  const active = activePage();
  return PAGES.map((p) =>
    `<a href="./${p.href}" class="${p.href === active ? 'active' : ''}${p.advanced ? ' advanced-only' : ''}">${icon(p.ico)}<span class="lbl">${p.label}</span></a>`
  ).join('');
}

function themeSwatches() {
  const cur = currentTheme();
  return THEMES.map((t) =>
    `<button type="button" class="themeSw${t.id === cur ? ' selected' : ''}" data-theme-pick="${t.id}"
       style="background:${t.bg};color:${t.fg}" title="${t.name}">${t.name}</button>`
  ).join('');
}

function pirateSwatches() {
  const cur = currentPirate();
  return FINISHES.map((f, i) =>
    `<button type="button" class="pirateSw${i === cur ? ' selected' : ''}" data-pirate-pick="${i}"
       title="${f[0]}">${pirateMark(40, i)}</button>`
  ).join('');
}

const header = document.createElement('header');
header.className = 'appHeader';
header.innerHTML = `
  <div class="appBar">
    <a class="brand" href="./index.html">
      <span data-pirate-mark="30"></span>
      <span class="wm">ALLMIIBO<span class="sfx">-SYNC</span></span>
    </a>
    <nav class="appNav">${navLinks()}</nav>
    <div class="settingsWrap">
      <button type="button" class="advToggle" id="settingsBtn" aria-haspopup="true" aria-expanded="false">
        ${icon('settings')} SETTINGS
      </button>
      <div class="settingsPanel" id="settingsPanel" hidden>
        <h3>MODE</h3>
        <div class="swRow">
          <button type="button" class="advToggle" id="advToggle" aria-pressed="${currentMode() === 'advanced'}">
            ADVANCED <span class="sw"><span class="knob"></span></span>
          </button>
        </div>
        <h3>THEME</h3>
        <div class="swRow" id="themeRow">${themeSwatches()}</div>
        <h3>PIRATE</h3>
        <div class="swRow" id="pirateRow">${pirateSwatches()}</div>
      </div>
    </div>
  </div>`;

document.body.prepend(header);
applyPirate(currentPirate()); // draw every [data-pirate-mark] with the stored colourway

document.getElementById('advToggle').addEventListener('click', () => {
  const next = currentMode() === 'advanced' ? 'default' : 'advanced';
  applyMode(next);
  document.getElementById('advToggle').setAttribute('aria-pressed', String(next === 'advanced'));
});

const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
settingsBtn.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  settingsBtn.setAttribute('aria-expanded', String(!settingsPanel.hidden));
});
document.addEventListener('click', (e) => {
  if (!settingsPanel.hidden && !e.target.closest('.settingsWrap')) settingsPanel.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') settingsPanel.hidden = true;
});

document.getElementById('themeRow').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-theme-pick]');
  if (!pick) return;
  applyTheme(pick.dataset.themePick);
  for (const b of document.querySelectorAll('.themeSw')) b.classList.toggle('selected', b === pick);
});

document.getElementById('pirateRow').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pirate-pick]');
  if (!pick) return;
  applyPirate(Number(pick.dataset.piratePick));
  for (const b of document.querySelectorAll('.pirateSw')) b.classList.toggle('selected', b === pick);
});
