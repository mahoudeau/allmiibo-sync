// prefs.js is pure apart from localStorage, so it tests under node with a
// tiny shim. The contract that matters: JSON round-trips, raw-key exemption
// (the inline first-paint scripts read mode/theme/pirate as raw strings),
// safe fallbacks, and the one-shot legacy migration.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const prefs = await import('../web/js/prefs.js');

beforeEach(() => store.clear());

test('get falls back when the key is absent or corrupt', () => {
  assert.equal(prefs.get(prefs.KEYS.view, 'cards'), 'cards');
  store.set(prefs.KEYS.types, '{not json');
  assert.deepEqual(prefs.get(prefs.KEYS.types, []), []);
});

test('JSON values round-trip', () => {
  prefs.set(prefs.KEYS.syncOpts, { dump: { force: true } });
  assert.deepEqual(prefs.get(prefs.KEYS.syncOpts), { dump: { force: true } });
  prefs.set(prefs.KEYS.openSeries, [5, 30]);
  assert.deepEqual(prefs.get(prefs.KEYS.openSeries), [5, 30]);
});

test('mode/theme/pirate stay raw strings for the pre-paint scripts', () => {
  prefs.set(prefs.KEYS.theme, 'b');
  assert.equal(store.get('allmiibo:theme'), 'b'); // not '"b"'
  assert.equal(prefs.get(prefs.KEYS.theme), 'b');
});

test('migration maps legacy keys once and only once', () => {
  store.set('collectionView', 'compact');
  store.set('collectionSort', 'name');
  prefs.migrate();
  assert.equal(prefs.get(prefs.KEYS.view), 'list'); // compact -> list
  assert.equal(prefs.get(prefs.KEYS.sort), 'name');
  assert.ok(!store.has('collectionView'));
  assert.ok(!store.has('collectionSort'));
  // second run must not clobber newer values
  prefs.set(prefs.KEYS.view, 'cards');
  store.set('collectionView', 'compact');
  prefs.migrate();
  assert.equal(prefs.get(prefs.KEYS.view), 'cards');
});

test('absent view preference means cards (the new default)', () => {
  assert.equal(prefs.get(prefs.KEYS.view, 'cards'), 'cards');
});
