// A browser-shaped environment for testing the pages.
//
// The UI is roughly 4,900 lines across a dozen files and none of it could be
// executed by a test: ui-modules.test.mjs can only check that a called function
// is declared somewhere. It cannot tell you that a selector matches nothing,
// that an element you styled has no children, or that a page renders blank.
// Every UI bug in this project's history lived in exactly that gap.
//
// linkedom gives us a real DOM to run the modules against. It is a
// devDependency: the site still ships nothing, and only `npm test` needs it.
//
// What this deliberately does NOT do is emulate a browser faithfully. There is
// no layout, so anything about pixels, sizes or scrolling is untestable here and
// still needs a human. What it does cover is structure and wiring, which is
// where the mistakes actually happen.
//
// One sharp edge worth knowing before writing a test. Browsers reflect many IDL
// properties onto attributes, so `details.open = true` makes `details[open]`
// match. linkedom reflects some (`src`, `width`, `id`, `class`, `hidden`) and
// not others — `open` and `loading` are stored as plain properties and match no
// attribute selector. A test asserting `$$('details[open]')` therefore fails
// against code that is perfectly correct in a browser. Assert on the property
// (`el.open`) unless the markup itself carries the attribute.

import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const REPO = new URL('../../', import.meta.url);

/** Read a page from the repository. */
export function pageHtml(relPath) {
  return readFileSync(new URL(relPath, REPO), 'utf8');
}

/**
 * Build a document from a page and install it as the globals a module expects.
 *
 * Returns a teardown that puts the globals back, so one test file can load
 * several pages without leaking state between them.
 */
export function mountPage(relPath, { url = 'http://localhost/', storage = {} } = {}) {
  return mountHtml(pageHtml(relPath), { url, storage });
}

export function mountHtml(html, { url = 'http://localhost/', storage = {} } = {}) {
  const dom = parseHTML(html, url);
  const saved = new Map();
  const store = new Map(Object.entries(storage));

  // A localStorage that behaves like the real one for the three things the
  // pages do with it: get, set, and throwing nothing when unavailable.
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    get length() { return store.size; },
  };

  // linkedom has no <dialog> behaviour, so web/js/dialog.js throws on
  // showModal() and every flow guarded by a confirm becomes undrivable. This is
  // the smallest shim that makes those flows testable: open/close, the `open`
  // attribute the CSS keys off, a returnValue and the close event the promise
  // resolves on. It is not a focus trap and it is not modal — nothing here can
  // test either of those.
  // Scrolling does not exist without layout, so this is a no-op that exists
  // only so calling it is not a crash. Nothing can assert on it: a test that
  // cares where the page scrolled to needs a real browser.
  const elProto = dom.window.Element?.prototype ?? dom.window.HTMLElement?.prototype;
  if (elProto && !elProto.scrollIntoView) {
    elProto.scrollIntoView = function scrollIntoView() {};
  }

  // linkedom's <select>.value is `querySelector('option[selected]')?.value` with
  // no setter at all, and `option.selected` is a plain property that never
  // reaches that attribute. So reading a select returns undefined and writing
  // one throws — which would mean contorting every <select> in the application
  // to be testable, rather than fixing the double. This is the browser's own
  // behaviour: the selected option's value, falling back to the first, and a
  // setter that selects by value.
  const selectProto = dom.window.HTMLSelectElement?.prototype;
  const existing = selectProto && Object.getOwnPropertyDescriptor(selectProto, 'value');
  if (selectProto && existing && !existing.set) {
    Object.defineProperty(selectProto, 'value', {
      configurable: true,
      get() {
        const opts = [...this.querySelectorAll('option')];
        const chosen = opts.find((o) => o.hasAttribute('selected'));
        return (chosen ?? opts[0])?.value ?? '';
      },
      set(v) {
        for (const o of this.querySelectorAll('option')) {
          if (o.value === String(v)) o.setAttribute('selected', '');
          else o.removeAttribute('selected');
        }
      },
    });
  }

  const proto = dom.window.HTMLElement?.prototype;
  if (proto && !proto.showModal) {
    proto.showModal = function showModal() {
      this.open = true;
      this.setAttribute('open', '');
    };
    proto.close = function close(value) {
      this.open = false;
      this.removeAttribute('open');
      if (value !== undefined) this.returnValue = value;
      this.dispatchEvent(new dom.window.Event('close'));
    };
  }

  const globals = {
    window: dom.window,
    document: dom.document,
    localStorage,
    sessionStorage: { ...localStorage },
    navigator: dom.window.navigator ?? { userAgent: 'node' },
    location: dom.window.location ?? new URL(url),
    HTMLElement: dom.HTMLElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent ?? dom.Event,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    addEventListener: dom.window.addEventListener?.bind(dom.window) ?? (() => {}),
    removeEventListener: dom.window.removeEventListener?.bind(dom.window) ?? (() => {}),
  };

  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  return {
    dom,
    document: dom.document,
    window: dom.window,
    localStorage,
    $: (sel) => dom.document.querySelector(sel),
    $$: (sel) => [...dom.document.querySelectorAll(sel)],
    byId: (id) => dom.document.getElementById(id),
    /** Visible in the [hidden]-toggling sense the pages use, not layout. */
    isHidden: (el) => Boolean(el?.hidden) || el?.getAttribute?.('hidden') !== null,
    restore() {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

/**
 * A fetch stub that answers from a routing table.
 *
 * Keys are `METHOD /path` or just `/path` for GET. Values are either a plain
 * object, serialised as a 200 JSON response, or `{ status, body }`. Anything
 * unrouted throws with the path, so a forgotten route fails loudly rather than
 * silently returning undefined.
 */
export function stubFetch(routes) {
  const calls = [];
  const impl = async (input, init = {}) => {
    const path = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ path, method, body: init.body, headers: init.headers ?? {} });

    const route = routes[`${method} ${path}`] ?? routes[path];
    if (route === undefined) {
      throw new Error(`no stub for ${method} ${path}`);
    }
    const { status = 200, body = route } = route.status ? route : { body: route };
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null, getSetCookie: () => [] },
      async text() { return text; },
      async json() { return JSON.parse(text); },
    };
  };
  impl.calls = calls;
  return impl;
}
