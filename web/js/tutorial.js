// Guided tour: a spotlight over one control at a time, with a bubble
// explaining it.
//
// The shape is borrowed from a React tutorial overlay — step definitions
// pointing at element ids, a clamped spotlight, placement chosen from the space
// actually available, dismissal remembered per device — rebuilt here with no
// dependencies, since this project has none.
//
// Two things this has to get right, because both were wrong in the version
// that inspired it before they were fixed:
//
//   - A step whose target is missing or hidden is SKIPPED, not shown pointing
//     at nothing. Half the controls here live behind advanced mode, and the
//     device-side steps do not exist until a device is connected, so absent
//     targets are the normal case rather than a bug.
//   - The target is always scrolled to a comfortable position rather than only
//     when it is technically off screen: a control near the top of the viewport
//     is visible but leaves no room for a bubble under it.

import { icon } from './icons.js';
import * as prefs from './prefs.js';
import { motionOK } from './ui.js';

const SEEN_KEY = 'allmiibo:tourSeen';

// Bumped when the steps change enough that a returning user should be offered
// the tour again. Stored as a number, so a device that has seen v1 still gets
// v2 once.
export const TOUR_VERSION = 1;

// A bubble needs roughly this much room to sit on one side of the spotlight.
const BUBBLE_ROOM = 220;
const PAD = 8;

/**
 * Tours by page. `target` is an element id; `on` narrows a step to a page.
 * Order is the order shown.
 */
export const TOURS = {
  collection: [
    {
      target: 'hero',
      title: 'YOUR COLLECTION',
      body: 'Every amiibo in the database, grouped by series. None of it needs a device. '
        + 'Point the page at a folder of dumps and it fills in.',
    },
    {
      target: 'folderChip',
      title: 'START WITH A FOLDER',
      body: 'Choose the folder your dumps live in. It is read where it sits. Nothing is '
        + 'copied, moved or changed until you ask for a sync.',
    },
    {
      target: 'deviceChip',
      title: 'ADD THE DEVICE',
      body: 'Connect over Bluetooth to see what is already on it. The link runs at about '
        + '2 kB/s, so reading a full library takes a few minutes.',
    },
    {
      target: 'search',
      title: 'FIND ONE FAST',
      body: 'Search by name. Your sort order and filters are remembered between visits.',
    },
    {
      target: 'filters',
      title: 'SEE WHAT IS MISSING',
      body: 'Filter down to what you do not own, or own but have not put on the device. '
        + 'With both a folder and a device connected, a sync panel appears below with the '
        + 'difference between them.',
    },
    {
      // Only exists once both sides are connected. Absent on a first visit, and
      // the step above says so rather than leaving a gap.
      target: ['syncPanel', 'syncBtn'],
      title: 'SEND WHAT IS MISSING',
      body: 'The everyday sync. It compares both sides and transfers only the difference. '
        + 'You see the full plan before anything is written.',
    },
    {
      // Last on every tour: where to go for anything this did not cover.
      target: 'nav-help',
      title: 'MORE IN HOW TO',
      body: 'The How To page has the full walkthrough: folder layouts, what each '
        + 'operation does, all-in-one files, and what to try when something goes wrong. '
        + 'Replay this tour any time with NEED HELP? on either page.',
    },
  ],

  sync: [
    {
      target: 'step1',
      title: 'BOTH SIDES FIRST',
      body: 'A folder on this computer, and the device over Bluetooth. Every operation on '
        + 'this page runs between those two.',
    },
    {
      target: 'ops',
      title: 'PICK AN OPERATION',
      body: 'BACKUP copies the device into your folder. SYNC sends each side the other\u2019s '
        + 'changes. Advanced mode adds MATCH, which fills gaps by amiibo and ignores how '
        + 'either side is filed, plus REPLACE, CHECK, and the two PACK tools.',
    },
    {
      target: 'scan',
      title: 'SCANNING ONLY READS',
      body: 'A scan writes nothing. It reads both sides, works out what would move, and '
        + 'lists every upload, download and rename for you to look over. Applying it is a '
        + 'separate press, and progress is saved as it goes, so a dropped connection '
        + 'resumes instead of starting again.',
    },
    {
      // The three below appear after a scan, so a first-run tour stops here and
      // the step above carries their explanation.
      target: 'review',
      title: 'READ THE PLAN',
      body: 'Everything that would move, plus anything blocked and why. If your folder '
        + 'holds an all-in-one file, what it contributed is spelled out here too.',
    },
    {
      target: 'apply',
      title: 'THEN APPLY',
      body: 'Now it writes. Stop at any point and scan again to pick up where it left off.',
    },
    {
      target: 'logDrawer',
      title: 'KEEP THE RECEIPT',
      body: 'Every operation is logged with its timing, and the whole run saves as JSON. '
        + 'That is what makes an odd result diagnosable afterwards.',
    },
    {
      // Last on every tour: where to go for anything this did not cover.
      target: 'nav-help',
      title: 'MORE IN HOW TO',
      body: 'The How To page has the full walkthrough: folder layouts, what each '
        + 'operation does, all-in-one files, and what to try when something goes wrong. '
        + 'Replay this tour any time with NEED HELP? on either page.',
    },
  ],
};

let state = null;

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

// A target counts only if it is actually on the page and actually visible.
// Advanced-only controls and device-only panels are hidden, not absent.
function visibleTarget(id) {
  const node = document.getElementById(id);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  if (node.closest('[hidden]')) return null;
  const style = window.getComputedStyle(node);
  if (style.visibility === 'hidden' || style.display === 'none') return null;
  return node;
}

// A step may name several candidate targets; the first one actually visible
// wins. That lets a step about a panel which only appears later still land on
// something sensible when the panel is open.
function resolve(step) {
  const ids = Array.isArray(step.target) ? step.target : [step.target];
  for (const id of ids) {
    const node = visibleTarget(id);
    if (node) return node;
  }
  return null;
}

function build() {
  const root = el('div', 'tour');
  root.innerHTML = `
    <div class="tourVeil"></div>
    <div class="tourSpot"></div>
    <div class="tourBubble" role="dialog" aria-modal="true" aria-labelledby="tourTitle" tabindex="-1">
      <div class="tourStep"></div>
      <h2 id="tourTitle"></h2>
      <p></p>
      <div class="tourRow">
        <button class="tourSkip" type="button">SKIP</button>
        <div class="tourDots"></div>
        <button class="tourBack" type="button">BACK</button>
        <button class="tourNext" type="button"></button>
      </div>
    </div>`;
  document.body.append(root);
  return root;
}

function place() {
  const { root, steps, at } = state;
  const step = steps[at];
  const node = resolve(step);
  const spot = root.querySelector('.tourSpot');
  const bubble = root.querySelector('.tourBubble');

  if (!node) {
    // The target went away mid-tour — a panel collapsed, advanced mode turned
    // off. Centre the bubble rather than pointing at nothing.
    spot.style.opacity = '0';
    bubble.style.top = '50%';
    bubble.style.left = '50%';
    bubble.style.transform = 'translate(-50%, -50%)';
    return;
  }

  const rect = node.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;

  // Clamp to the viewport so a tall target does not push the bubble off screen.
  const top = Math.max(0, rect.top - PAD);
  const bottom = Math.min(vh, rect.bottom + PAD);

  spot.style.opacity = '1';
  spot.style.top = `${top}px`;
  spot.style.left = `${Math.max(0, rect.left - PAD)}px`;
  spot.style.width = `${Math.min(vw, rect.width + PAD * 2)}px`;
  spot.style.height = `${Math.max(0, bottom - top)}px`;

  const below = vh - bottom;
  const above = top;
  const under = below >= BUBBLE_ROOM || below >= above;

  bubble.style.transform = 'none';
  bubble.style.left = `${Math.max(12, Math.min(vw - 12 - bubble.offsetWidth, rect.left))}px`;
  bubble.style.top = under ? `${bottom + 12}px` : `${Math.max(12, above - bubble.offsetHeight - 12)}px`;
}

function scrollTo(step) {
  const node = resolve(step);
  if (!node) return Promise.resolve();

  // Put the target in the upper third, which leaves room for a bubble beneath
  // it. Being merely on screen is not enough.
  const rect = node.getBoundingClientRect();
  const want = Math.round(window.innerHeight * 0.28);
  const delta = rect.top - want;
  if (Math.abs(delta) <= 8) return Promise.resolve();

  window.scrollBy({ top: delta, behavior: motionOK() ? 'smooth' : 'auto' });
  return new Promise((resolve) => setTimeout(resolve, motionOK() ? 320 : 0));
}

async function render() {
  const { root, steps, at } = state;
  const step = steps[at];

  root.querySelector('#tourTitle').textContent = step.title;
  root.querySelector('.tourBubble p').textContent = step.body;
  root.querySelector('.tourStep').textContent = `${at + 1} / ${steps.length}`;
  root.querySelector('.tourBack').hidden = at === 0;
  const next = root.querySelector('.tourNext');
  const last = at === steps.length - 1;
  next.innerHTML = last ? `${icon('checkDouble')}DONE` : `NEXT${icon('chevronRight')}`;
  root.querySelector('.tourSkip').hidden = last;

  root.querySelector('.tourDots').innerHTML = steps
    .map((_, i) => `<span class="tourDot${i === at ? ' on' : ''}"></span>`)
    .join('');

  // Placed before the scroll as well as after it. Without the first call the
  // bubble paints once at the document origin and then jumps, because scrolling
  // is awaited and an unpositioned absolute element sits at the top left. The
  // overlay also stays hidden until a placement has actually been computed, so
  // the very first step cannot flash into view mid-flight.
  place();
  await scrollTo(step);
  place();
  root.classList.add('ready');
  // Focus the bubble rather than the button. Keyboard users still get Enter,
  // Escape and the arrows from the handler below, and the app's focus ring stays
  // for controls actually tabbed to instead of being painted on every step.
  root.querySelector('.tourBubble').focus();
}

function go(delta) {
  const next = state.at + delta;
  if (next < 0) return;
  if (next >= state.steps.length) return stop({ completed: true });
  state.at = next;
  render();
}

function stop({ completed = false } = {}) {
  if (!state) return;
  const { root, onScroll } = state;
  window.removeEventListener('resize', onScroll);
  window.removeEventListener('scroll', onScroll, true);
  document.removeEventListener('keydown', state.onKey, true);
  root.remove();
  document.documentElement.classList.remove('tourOn');
  const finished = state.page;
  state = null;
  // Remembered either way: someone who skipped it does not want it again on
  // the next visit any more than someone who finished it.
  markSeen(finished, completed);
}

/**
 * Start the tour for a page.
 *
 * @param {string} page  a key of TOURS
 * @returns {boolean} whether a tour actually started — false when every step's
 *   target is missing, which is the case on an unsupported browser where the
 *   page is mostly a warning notice.
 */
export function start(page) {
  if (state) stop();
  const defined = TOURS[page] ?? [];
  const steps = defined.filter((s) => resolve(s));
  if (!steps.length) return false;

  const root = build();
  document.documentElement.classList.add('tourOn');

  const onScroll = () => place();
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); stop(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'Enter' && document.activeElement?.classList.contains('tourBubble')) {
      e.preventDefault();
      go(1);
    }
  };

  state = { root, steps, at: 0, page, onScroll, onKey };

  root.querySelector('.tourNext').addEventListener('click', () => go(1));
  root.querySelector('.tourBack').addEventListener('click', () => go(-1));
  root.querySelector('.tourSkip').addEventListener('click', () => stop());
  root.querySelector('.tourVeil').addEventListener('click', () => stop());
  window.addEventListener('resize', onScroll);
  window.addEventListener('scroll', onScroll, true);
  document.addEventListener('keydown', onKey, true);

  render();
  return true;
}

export { stop };

// ---- what has been seen -------------------------------------------------

function seen() {
  const raw = prefs.get(SEEN_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function markSeen(page, completed) {
  const all = seen();
  all[page] = { version: TOUR_VERSION, completed: !!completed };
  prefs.set(SEEN_KEY, all);
}

/** Whether this page's tour has been offered at the current version. */
export function alreadySeen(page) {
  return seen()[page]?.version >= TOUR_VERSION;
}

/** Forget every tour, so they offer themselves again. */
export function reset() {
  prefs.remove(SEEN_KEY);
}

/**
 * Offer the tour on a first visit. Deliberately not on an unsupported browser
 * or mid-operation: a spotlight over controls that cannot be used is worse
 * than no tour at all.
 */
export function offer(page, { when = () => true } = {}) {
  if (alreadySeen(page) || !when()) return false;
  return start(page);
}
