// The site's header: what goes in the bar, not how the bar is built.
//
// The shape lives in chrome.js so another page can mount the same bar with its
// own contents. This file is the site's seed — the wordmark, the nav, and which
// settings sections apply — plus the re-exports other modules already import
// from here.

import { mountHeader } from './chrome.js';

export {
  MODE_KEY, THEME_KEY, PIRATE_KEY, THEMES,
  currentMode, currentTheme, currentPirate, currentShowHhd,
  applyMode, applyTheme, applyPirate, applyShowHhd,
} from './chrome.js';

// No HOME entry — the brand mark on the left already links home. The nav is
// permanently two items; dev tools live behind Settings → DEBUG.
const PAGES = [
  { href: 'collection.html', label: 'COLLECTION', ico: 'grid' },
  { href: 'sync.html', label: 'ADVANCED SYNC', ico: 'sync', advanced: true },
  { href: 'help.html', label: 'HOW TO', ico: 'info' },
];

function activePage() {
  const file = location.pathname.split('/').pop() || 'index.html';
  return file === 'amiibo.html' ? 'collection.html' : file;
}

mountHeader({
  brand: { href: './', wordmark: 'ALLMIIBO', suffix: '-SYNC', markSize: 30 },
  nav: PAGES,
  active: activePage(),
  settings: { theme: true, pirate: true, advanced: true, hhd: true, debug: './debug.html' },
});
