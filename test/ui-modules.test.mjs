// The page modules touch `document` and `navigator`, so they cannot be
// imported under node:test the way the pure modules are. That left them with
// no coverage at all — and a refactor duly deleted renderSkipped() while
// leaving its call site, which surfaced only as a runtime error in the browser.
//
// This is a deliberately crude reference check: every function called by name
// must be declared somewhere reachable — in the file, imported, or a known
// global. It catches a deleted or renamed function, which is the failure this
// file exists for. It will not catch logic errors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const UI_DIR = fileURLToPath(new URL('../web/js/', import.meta.url));

const GLOBALS = new Set([
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
  'Error', 'TypeError', 'RangeError',
  'Map', 'Set', 'WeakMap', 'Promise', 'Symbol', 'RegExp', 'parseInt', 'parseFloat', 'isNaN',
  'BigInt', 'Uint8Array', 'DataView', 'ArrayBuffer', 'TextEncoder', 'TextDecoder',
  'structuredClone', 'queueMicrotask', 'Intl',
  'document', 'window', 'navigator', 'console', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'alert', 'confirm', 'prompt', 'Blob',
  'URL', 'CustomEvent', 'EventTarget', 'FileReader', 'indexedDB', 'crypto',
  'performance', 'requestAnimationFrame', 'AbortController', 'URLSearchParams',
  'location', 'localStorage', 'sessionStorage', 'history', 'matchMedia',
  'cancelAnimationFrame', 'import', 'addEventListener', 'removeEventListener',
  'MutationObserver',
  'scrollTo', 'scrollY',
  // keywords the bare-call regex would otherwise pick up
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await',
  'super', 'this', 'new', 'else', 'do', 'try', 'finally', 'yield', 'of', 'in',
  'async', 'get', 'set', 'delete', 'void', 'instanceof',
]);

// Blank out comments and every kind of string literal. Done with a scanner
// rather than regexes: template literals nest (`${a ? `${b}` : ''}`), and a
// regex that tries to match them mismatches and swallows real code — which is
// how an earlier version of this check reported a defined function as missing.
function stripped(src) {
  let out = '';
  let i = 0;
  const depth = []; // open template literals, for `${ ... }` re-entry

  // Last non-whitespace character emitted, used to tell a regex literal from
  // a division operator.
  const lastOf = (t) => {
    for (let k = t.length - 1; k >= 0; k--) if (!/\s/.test(t[k])) return t[k];
    return '';
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    const lastMeaningful = lastOf(out);

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // A regex literal, which can contain quotes: /[<>:"|?*]/ would otherwise
    // open a string and swallow the rest of the file. Distinguished from
    // division by what precedes it.
    if (c === '/' && /[=(,:[!&|?{;+\-*%^~]|^$/.test(lastMeaningful)) {
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        else if (src[i] === '\n') break;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/.test(src[i])) i++;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i++;
      out += `${quote}${quote}`;
      continue;
    }
    if (c === '`') {
      depth.push(true);
      i++;
      // Consume template text, but step back out for ${ ... } so real calls
      // inside interpolations are still seen.
      while (i < src.length && depth.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '`') { depth.pop(); i++; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          out += ' ';
          i += 2;
          let braces = 1;
          const start = i;
          while (i < src.length && braces > 0) {
            if (src[i] === '{') braces++;
            else if (src[i] === '}') braces--;
            if (braces > 0) i++;
          }
          out += stripped(src.slice(start, i));
          i++;
          continue;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function declaredNames(src) {
  const names = new Set();
  const add = (re) => {
    for (const m of src.matchAll(re)) if (m[1]) names.add(m[1]);
  };

  add(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g);
  add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
  add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
  // Class and object methods: `connect() {`, `async connect() {`, `get x() {`.
  add(/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(.*\)\s*\{/gm);
  // Destructured bindings and destructured parameters alike.
  for (const m of src.matchAll(/\{([^{}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // Imports, including `as` aliases and namespace imports.
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from/g)) {
    for (const part of m[1].replace(/[{}*]/g, ' ').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // Destructured parameters whose default is a function: `{ onProgress = () => {} }`.
  add(/([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g);
  // Parameters, roughly — enough to cover callbacks.
  for (const m of src.matchAll(/(?:\(|,)\s*([A-Za-z_$][\w$]*)\s*(?=[,)=])/g)) names.add(m[1]);
  return names;
}

function calledNames(src) {
  const called = new Set();
  // A bare `name(` not preceded by a dot, so method calls on objects are skipped.
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[2]);
  return called;
}

const files = (await readdir(UI_DIR)).filter((f) => f.endsWith('.js'));

test('the UI modules are all present', () => {
  for (const expected of ['ble.js', 'protocol.js', 'planner.js', 'collectionui.js', 'syncui.js']) {
    assert.ok(files.includes(expected), `${expected} is missing`);
  }
});

test('every UI module parses', async () => {
  // Constructing an AsyncFunction parses without executing — it catches what
  // the reference check cannot, such as a duplicate declaration.
  for (const file of files) {
    const src = await readFile(join(UI_DIR, file), 'utf8');
    // Import and re-export statements are stripped rather than parsed, because
    // a bare function body is not a module. Both forms span lines — a re-export
    // list especially — so these have to match across them.
    const body = src
      .replace(/^\s*import\s[\s\S]*?;/gm, '')
      .replace(/^\s*export\s*\{[\s\S]*?\}\s*from\s*['"][^'"]*['"]\s*;/gm, '')
      .replace(/^\s*export\s+/gm, '');
    assert.doesNotThrow(
      () => new (Object.getPrototypeOf(async function () {}).constructor)(body),
      (err) => { throw new Error(`${file} does not parse: ${err.message}`); }
    );
  }
});

test('no UI module calls a function that is not defined anywhere', async () => {
  const problems = [];

  for (const file of files) {
    const src = stripped(await readFile(join(UI_DIR, file), 'utf8'));
    const declared = declaredNames(src);

    for (const name of calledNames(src)) {
      if (GLOBALS.has(name) || declared.has(name)) continue;
      problems.push(`${file}: ${name}() is called but never defined or imported`);
    }
  }

  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('every icon() call resolves to a real ICONS key', async () => {
  const iconsSrc = await readFile(join(UI_DIR, 'icons.js'), 'utf8');
  const keys = new Set([...iconsSrc.matchAll(/^\s{2}(\w+):'<svg/gm)].map((m) => m[1]));
  const problems = [];
  for (const file of files) {
    const src = await readFile(join(UI_DIR, file), 'utf8');
    for (const m of src.matchAll(/\bicon\(\s*'(\w+)'/g)) {
      if (!keys.has(m[1])) problems.push(`${file}: icon('${m[1]}') has no ICONS entry`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});
