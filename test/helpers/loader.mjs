// Resolves the browser's absolute module specifiers to files on disk.
//
// The admin is served with the site's shared modules under /js/, so it imports
// them as "/js/sprite.js". That is correct in a browser and meaningless to
// Node, which would treat it as a filesystem root. This hook maps that one
// prefix onto web/js/ so the real module can be imported under node:test.
//
// Registered per test file with module.register(); see helpers/dom.mjs.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

// fileURLToPath, not URL.pathname: on Windows pathname is "/C:/dir/" with a
// leading slash, so join() builds an invalid path and every import 404s.
const REPO = fileURLToPath(new URL('../../', import.meta.url));

export function resolve(specifier, context, next) {
  if (specifier.startsWith('/js/')) {
    return next(pathToFileURL(join(REPO, 'web', specifier)).href, context);
  }
  if (specifier.startsWith('/css/') || specifier.startsWith('/data/')) {
    return next(pathToFileURL(join(REPO, 'web', specifier)).href, context);
  }
  return next(specifier, context);
}
