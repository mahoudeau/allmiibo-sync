// Page chrome: the header bar and the footer, as builders rather than as a
// fixed shape.
//
// These used to be baked into header.js and footer.js — the site's nav, the
// site's wordmark and the site's links, written out at import time. That made
// them unusable anywhere else: the admin wanted the theme switcher and the
// mascot colourway, but importing header.js would have prepended a nav linking
// to ./collection.html and ./sync.html, which the admin's host does not serve.
//
// So the content moved out to the caller. header.js and footer.js still exist
// and still produce byte-identical markup for the site; they now pass in what
// they used to hard-code. The admin passes its own, and when it grows a nav of
// its own that is one array literal rather than a second header.
//
// Preferences live in localStorage and are reflected as data attributes on
// <html>; each page also sets them in a tiny inline <head> script so the first
// paint is already correct. Keys:
//   allmiibo:mode   'default' | 'advanced'   -> data-mode
//   allmiibo:theme  'a' | 'b' | 'c'          -> data-theme
//   allmiibo:pirate '0'..'11'                -> which FINISHES entry to draw

import { icon } from './icons.js';
import { FINISHES, DEFAULT_FINISH, pirateMark, pirateFrames } from './sprite.js';
import * as prefs from './prefs.js';

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
export function currentShowHhd() { return prefs.get(prefs.KEYS.showHhd, true) !== false; }
export function applyShowHhd(on) {
  // Reflected on <html> so open pages can react live (the collection
  // re-renders via a MutationObserver, same channel as data-mode).
  document.documentElement.dataset.showFanmade = on ? '1' : '';
  prefs.set(prefs.KEYS.showHhd, !!on);
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

// ---- the pieces the panel is made of ------------------------------------

export function themeSwatches() {
  const cur = currentTheme();
  return THEMES.map((t) =>
    `<button type="button" class="themeSw${t.id === cur ? ' selected' : ''}" data-theme-pick="${t.id}"
       style="background:${t.bg};color:${t.fg}" title="${t.name}">${t.name}</button>`
  ).join('');
}

export function pirateSwatches() {
  const cur = currentPirate();
  return FINISHES.map((f, i) =>
    `<button type="button" class="pirateSw${i === cur ? ' selected' : ''}" data-pirate-pick="${i}"
       title="${f[0]}">${pirateMark(40, i)}</button>`
  ).join('');
}

function navLinks(nav, active) {
  // Each link carries a stable id so the guided tour can point at one.
  return nav.map((p) =>
    `<a id="nav-${p.href.replace('.html', '')}" href="./${p.href}" class="${p.href === active ? 'active' : ''}${p.advanced ? ' advanced-only' : ''}">${icon(p.ico)}<span class="lbl">${p.label}</span></a>`
  ).join('');
}

function settingsPanel({ theme, pirate, advanced, hhd, debug }) {
  const parts = [];
  if (theme) parts.push(`<h3>THEME</h3>
        <div class="swRow" id="themeRow">${themeSwatches()}</div>`);
  if (pirate) parts.push(`<h3>PIRATE</h3>
        <div class="swRow" id="pirateRow">${pirateSwatches()}</div>`);
  if (advanced) parts.push(`<hr class="sDiv">
        <h3>ADVANCED</h3>
        <div class="swRow advRow">
          <button type="button" class="advToggle" id="advToggle" aria-pressed="${currentMode() === 'advanced'}">
            ${icon('zap')}<span class="sw"><span class="knob"></span></span>
          </button>
          <span class="advHint">Extra options for collection and sync.</span>
        </div>`);
  if (hhd) parts.push(`<h3>COLLECTION</h3>
        <div class="swRow advRow">
          <button type="button" class="advToggle hideToggle" id="showHhdToggle" aria-pressed="${currentShowHhd()}">
            ${icon('copy')}<span class="sw"><span class="knob"></span></span>
          </button>
          <span class="advHint">Show the fan-made HHD card set. Off = official amiibo only.</span>
        </div>`);
  if (debug) parts.push(`<h3>DEBUG</h3>
        <a class="dbgLink" href="${debug}">${icon('bug')}DEBUG TOOLS</a>`);
  return parts.join('\n        ');
}

// ---- the header ---------------------------------------------------------

/**
 * Build and install the header bar.
 *
 * @param {object}   o
 * @param {object}   o.brand      { href, wordmark, suffix, markSize }. A null
 *                                href renders a span, not a link — the admin
 *                                must not link anywhere.
 * @param {Array}    o.nav        [{ href, label, ico, advanced? }]. Empty by
 *                                default, so a caller gets no nav unless it
 *                                asks for one.
 * @param {string}   o.active     the nav href to mark, if any
 * @param {object}   o.settings   which sections the popover shows
 * @param {Element}  o.extra      appended into the bar before the settings
 * @param {boolean}  o.blink      the idle mascot flourish
 * @returns {HTMLElement} the header, already in the document
 */
export function mountHeader({
  brand = {},
  nav = [],
  active = null,
  settings = {},
  extra = null,
  blink = true,
  host = document.body,
} = {}) {
  const b = { href: './', wordmark: 'ALLMIIBO', suffix: '-SYNC', markSize: 30, ...brand };
  const s = { theme: true, pirate: true, advanced: false, hhd: false, debug: null, ...settings };

  const mark = `<span data-pirate-mark="${b.markSize}"></span>
      <span class="wm">${b.wordmark}<span class="sfx">${b.suffix}</span></span>`;
  const brandEl = b.href
    ? `<a class="brand" href="${b.href}">
      ${mark}
    </a>`
    : `<span class="brand">
      ${mark}
    </span>`;

  const header = document.createElement('header');
  header.className = 'appHeader';
  header.innerHTML = `
  <div class="appBar">
    ${brandEl}
    ${nav.length ? `<nav class="appNav">${navLinks(nav, active)}</nav>` : '<span class="grow"></span>'}
    <div class="settingsWrap">
      <button type="button" class="advToggle" id="settingsBtn" aria-haspopup="true" aria-expanded="false">
        ${icon('cog')} SETTINGS
      </button>
      <div class="settingsPanel" id="settingsPanel" hidden>
        ${settingsPanel(s)}
      </div>
    </div>
  </div>`;

  if (extra) header.querySelector('.settingsWrap').before(extra);
  host.prepend(header);
  applyPirate(currentPirate()); // draw every [data-pirate-mark] with the stored colourway
  wireHeader(header, s);
  if (blink) idleBlink(header);
  return header;
}

function wireHeader(header, s) {
  // First paint of the attribute: a page opened with the set switched off
  // renders without it.
  if (s.hhd) document.documentElement.dataset.showFanmade = currentShowHhd() ? '1' : '';

  const hhdToggle = header.querySelector('#showHhdToggle');
  hhdToggle?.addEventListener('click', () => {
    const next = !currentShowHhd();
    applyShowHhd(next);
    hhdToggle.setAttribute('aria-pressed', String(next));
  });

  const advToggle = header.querySelector('#advToggle');
  advToggle?.addEventListener('click', async () => {
    const next = currentMode() === 'advanced' ? 'default' : 'advanced';
    applyMode(next);
    advToggle.setAttribute('aria-pressed', String(next === 'advanced'));
    if (next === 'advanced' && !stored('allmiibo:advToast', null)) {
      store('allmiibo:advToast', '1');
      const { toast } = await import('./ui.js');
      toast('Advanced on — extra options are now visible.', { iconName: 'sparkles' });
    }
  });

  const settingsBtn = header.querySelector('#settingsBtn');
  const panel = header.querySelector('#settingsPanel');
  settingsBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    settingsBtn.setAttribute('aria-expanded', String(!panel.hidden));
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !e.target.closest('.settingsWrap')) panel.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') panel.hidden = true;
  });

  header.querySelector('#themeRow')?.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-theme-pick]');
    if (!pick) return;
    applyTheme(pick.dataset.themePick);
    for (const b of document.querySelectorAll('.themeSw')) b.classList.toggle('selected', b === pick);
  });

  header.querySelector('#pirateRow')?.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pirate-pick]');
    if (!pick) return;
    applyPirate(Number(pick.dataset.piratePick));
    for (const b of document.querySelectorAll('.pirateSw')) b.classList.toggle('selected', b === pick);
  });
}

// Idle flourish: the header pirate blinks every few seconds. Two cached
// frames, one innerHTML swap, paused when the tab is hidden or motion is off.
//
// It stops when the header leaves the document. Without that the timer
// reschedules itself forever — outliving the element it animates, and reaching
// for a document that may no longer be there.
function idleBlink(header) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const mark = header.querySelector('[data-pirate-mark]');
  if (!mark) return;
  let frames = null;
  let finishOfFrames = -1;
  const blink = () => {
    if (!globalThis.document || !header.isConnected) return;
    if (globalThis.document.hidden) return schedule();
    const finish = currentPirate();
    if (finish !== finishOfFrames) {
      frames = pirateFrames(Number(mark.dataset.pirateMark), finish);
      finishOfFrames = finish;
    }
    mark.innerHTML = frames[1];
    setTimeout(() => { mark.innerHTML = frames[0]; }, 140);
    schedule();
  };
  const schedule = () => setTimeout(blink, 4000 + Math.random() * 2500);
  schedule();
}

// ---- the footer ---------------------------------------------------------

/** An external link, always noreferrer noopener. */
export function ext(href, inner, className = '') {
  return `<a href="${href}" target="_blank" rel="noreferrer noopener"${className ? ` class="${className}"` : ''}>${inner}</a>`;
}

/**
 * Build and install the footer.
 *
 * @param {string} o.row      markup for the top row, or '' for none
 * @param {string} o.attrib   markup for the attribution paragraph, or ''
 */
export function mountFooter({ row = '', attrib = '' } = {}) {
  const footer = document.createElement('footer');
  footer.className = 'siteFooter';
  footer.innerHTML = `
  <div class="fInner">
    ${row ? `<div class="fRow">
      ${row}
    </div>` : ''}
    ${attrib ? `<p class="fAttrib">
      ${attrib}
    </p>` : ''}
  </div>`;

  // Pages wrap their content in <main>; the footer sits after it.
  document.querySelector('main')?.after(footer) ?? document.body.append(footer);
  return footer;
}
