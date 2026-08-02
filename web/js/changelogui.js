// The changelog page. Renders web/data/changelog.js; the same data generates
// CHANGELOG.md, so nothing here decides what a release says.
//
// Exported rather than run on import, so a test can render into its own
// document and check that nothing from `internal` reaches the page.

import { RELEASES, CATEGORIES } from '../data/changelog.js';
import { ICONS } from './icons.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** '2026-08-02' -> '2 August 2026'. Parsed by hand: a Date would apply the
 *  viewer's timezone and shift the day for anyone west of UTC. */
export function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// The only markup entries may use. A full markdown parser would be a runtime
// dependency in a project that has none, and a changelog needs exactly two
// things: a bold lead phrase, and code for paths and filenames.
export function inlineHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

const list = (items) =>
  `<ul>${items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`;

// An entry list is flat strings, or { group, items } where a release is big
// enough that a single list would be unreadable. Consecutive plain strings
// share one <ul> rather than each getting its own.
function body(items) {
  const out = [];
  let run = [];
  const flush = () => { if (run.length) { out.push(list(run)); run = []; } };
  for (const item of items) {
    if (typeof item === 'string') run.push(item);
    else { flush(); out.push(`<h3>${inlineHtml(item.group)}</h3>${list(item.items)}`); }
  }
  flush();
  return out.join('');
}

function releaseHtml(release) {
  const parts = [];
  for (const cat of CATEGORIES) {
    const items = release[cat.key];
    if (!items?.length) continue;
    parts.push(`<p class="clCat">${ICONS[cat.ico] ?? ''}${cat.label}</p>${body(items)}`);
  }
  return `<section class="helpSec" id="v${release.version}">
    <h2>${release.version} <span class="muted">· ${formatDate(release.date).toUpperCase()}</span></h2>
    <p class="clTitle">${inlineHtml(release.title)}</p>
    ${parts.join('')}
  </section>`;
}

/** The index at the top: one row per release, version linking to its section.
 *  A table rather than a run of links, so the dates and titles line up and you
 *  can read down a column. */
function indexHtml(releases) {
  const rows = releases.map((r) => `<tr>
        <td><a href="#v${r.version}">${r.version}</a></td>
        <td class="muted">${formatDate(r.date)}</td>
        <td>${inlineHtml(r.title)}</td>
      </tr>`).join('');
  return `<div class="clIndexWrap"><table class="clIndex">
      <thead><tr><th>Version</th><th>Date</th><th>Release</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

export function renderChangelog(root, releases = RELEASES) {
  root.innerHTML = indexHtml(releases) + releases.map(releaseHtml).join('');
}

// Not run under test, where the module is imported for renderChangelog alone.
const mount = typeof document !== 'undefined' && document.getElementById('clBody');
if (mount) renderChangelog(mount);
