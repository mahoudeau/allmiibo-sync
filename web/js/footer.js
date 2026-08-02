// The site's footer: author mark + site link on the left, GitHub on the right,
// attributions underneath. Mirrors the footer of ziip.mathieu.dev.
//
// The shape lives in chrome.js so another page can mount a footer of its own;
// this file is the site's content.

import { mountFooter, ext } from './chrome.js';
import { VERSION } from './version.js';
import { RELEASES } from '../data/changelog.js';

// Two different facts, and both stay visible. The release is what a user can
// quote back at you and links to what changed; the deploy stamp beside it is
// what says which build they were actually on, since a release ships more than
// once. Putting the stamp in a tooltip would defeat the point of having it,
// which is that a screenshot answers the question without being asked.
const RELEASE = RELEASES[0].version;

const SITE_URL = 'https://mathieu.dev';
const MAKER = 'Mathieu Mahoudeau';
const REPO_URL = 'https://github.com/mahoudeau/allmiibo-sync';
const AMIIBOAPI_URL = 'https://github.com/N3evin/AmiiboAPI';
const AMIIBOAPI_FORK_URL = 'https://github.com/8bitDream/AmiiboAPI';
const PIXLJS_URL = 'https://github.com/solosky/pixl.js';

// The "MM" monogram from the mathieu.dev brand mark. currentColor, so it
// follows the text colour around it.
const AUTHOR_MARK = `<svg viewBox="0 0 48 40" fill="currentColor" class="fMark" aria-hidden="true"><path fill-rule="evenodd" d="M41.576 0L12.872 28.703v-2.95L38.625 0h-4.1l-10.9 10.898L12.725 0h-4.1l12.949 12.95-1.476 1.474L5.675 0h-4.1l16.474 16.475-1.475 1.475L0 1.376V40h2.9V8.378l2.087 2.086V40h2.9V13.364l2.086 2.087V40h2.9v-.146l10.752-10.752L34.525 40h2.951V15.253l2.086-2.087V40h2.9V10.266l2.087-2.086V40h2.898V5.434h-.153l.153-.154V1.178L12.872 35.754v-2.95L45.675 0h-4.1zm-8.849 20l1.848-1.848v3.697L32.727 20zm-19.855-1.65L14.522 20l-1.65 1.65V18.35zm16.329 5.176l1.476-1.474 3.898 3.899v2.952l-5.374-5.377zm-3.526 3.526l1.475-1.476 7.425 7.426v2.95l-8.9-8.9z"/></svg>`;

const GITHUB_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" class="fIcon" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

mountFooter({
  row: `${ext(SITE_URL, `${AUTHOR_MARK}<span>Made by <strong>${MAKER}</strong></span>`, 'fAuthor')}
      ${ext(REPO_URL, `${GITHUB_ICON}GitHub`, 'fGithub')}`,
  attrib: `Amiibo artwork and names are Nintendo's.
      Database from ${ext(AMIIBOAPI_URL, 'AmiiboAPI')} via the ${ext(AMIIBOAPI_FORK_URL, '8bitDream fork')} (MIT) ·
      protocol and name table from ${ext(PIXLJS_URL, 'pixl.js')} (GPL) ·
      not affiliated with Nintendo ·
      <a href="./legal.html">legal &amp; licensing</a> ·
      <a href="./changelog.html" title="What changed in this release">v${RELEASE}</a>
      <span class="fVer" title="Deployed build">(${VERSION})</span>`,
});
