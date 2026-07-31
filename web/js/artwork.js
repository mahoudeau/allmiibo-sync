// Where the artwork lives, in one place.
//
// There were three conventions for building the same URLs. The collection page
// held a mutable `artDir` upgraded from thumb to med after a HEAD probe; the
// admin had its own root-relative arrow function; and the detail page inlined
// four literal paths. The literals are the reason this module exists: the site
// is served from './' and the admin from '/', so a relative path that is
// correct on one is broken on the other, and the detail renderer could not be
// shared until they were behind a hook.
//
// The tiers on disk are produced by tools/fetch-amiibo-images.mjs: `thumb` 96px,
// `med` 256px, `full` the original. Many amiibo have no artwork at all — that is
// expected, not a fault, which is what dropBrokenArt is for.

export const TIERS = Object.freeze(['full', 'med', 'thumb']);

/**
 * An art-URL builder rooted at a base.
 *
 * A function with helpers hanging off it, because the common call is
 * `art(id)` and making that `art.tier(id, 'thumb')` would be worse everywhere
 * to be tidier nowhere.
 *
 *   const art = makeArt('./data/images');   // the site
 *   const art = makeArt('/data/images');    // the admin
 *
 * @param {string} base  no trailing slash
 */
export function makeArt(base) {
  const art = (id, tier = 'thumb') => `${base}/${tier}/${id}.png`;
  art.base = base;
  // Vehicles are named by slug, not by ID: the four Kirby Air Riders machines
  // are pairings, not amiibo. The slug rule lived inline on the detail page.
  art.vehicle = (name) =>
    `${base}/vehicles/${String(name).toLowerCase().replace(/\s+/g, '-')}.png`;
  return art;
}

/**
 * Which tier this deployment actually has, from one HEAD request.
 *
 * Only worth doing where many images are drawn at one size — the collection
 * grid asks once and uses the answer for ~950 cells. A page drawing a single
 * portrait should use the full→med→thumb ladder instead: one request that
 * succeeds beats one probe plus one request.
 *
 * @returns {Promise<'med'|'thumb'>}
 */
export async function bestTier(base, probeId = '0000000000000002') {
  try {
    const res = await fetch(`${base}/med/${probeId}.png`, { method: 'HEAD' });
    return res.ok ? 'med' : 'thumb';
  } catch {
    return 'thumb';
  }
}

/**
 * One capture-phase listener for every image under a root.
 *
 * An <img> error does not bubble, so the alternative is a handler per image —
 * ~950 of them on the collection page. Removing the broken image leaves the
 * cell's initial placeholder showing, which is the intended fallback.
 *
 * @returns {() => void} removes the listener
 */
export function dropBrokenArt(root) {
  const onError = (e) => {
    if (e.target.tagName === 'IMG') e.target.remove();
  };
  root.addEventListener('error', onError, true);
  return () => root.removeEventListener('error', onError, true);
}

/**
 * Set an <img> to the best tier it can actually load.
 *
 * Steps down full → med → thumb on each error and calls `onExhausted` when
 * none of them exist. Used for a single large portrait, where one image is
 * worth three requests in the worst case; never for a grid.
 */
export function tierLadder(img, art, id, onExhausted) {
  let tier = 0;
  img.src = art(id, TIERS[tier]);
  img.addEventListener('error', () => {
    tier++;
    if (tier < TIERS.length) img.src = art(id, TIERS[tier]);
    else onExhausted?.();
  });
}
