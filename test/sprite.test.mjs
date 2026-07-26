// The mascot module is pure string-building, so unlike the page modules it
// can be tested directly: the pixel maps must stay rectangular (a ragged row
// silently shifts every pixel after it) and the finish table must stay sound.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIRATE_BODY, DOCK32, BASE_COLORS, FINISHES, DEFAULT_FINISH,
  grid, finishColors, pirateMark,
} from '../web/js/sprite.js';

const rows = (map) => map.replace(/^\n+|\n+$/g, '').split('\n').map((r) => r.trim());

test('the pirate and dock maps are rectangular and 32 wide', () => {
  for (const [name, map] of [['PIRATE_BODY', PIRATE_BODY], ['DOCK32', DOCK32]]) {
    const widths = new Set(rows(map).map((r) => r.length));
    assert.deepEqual([...widths], [32], `${name} has ragged rows: ${[...widths]}`);
  }
});

test('every map character is either transparent or a known colour', () => {
  const known = new Set(Object.keys(BASE_COLORS).concat(['.', 'b', 'H', 'E', 'F']));
  for (const row of rows(PIRATE_BODY + DOCK32)) {
    for (const c of row) assert.ok(known.has(c), `unknown map char "${c}"`);
  }
});

test('all 12 finishes render, and SILVER is the default', () => {
  assert.equal(FINISHES.length, 12);
  assert.equal(FINISHES[DEFAULT_FINISH][0], 'SILVER');
  for (let i = 0; i < FINISHES.length; i++) {
    const svg = pirateMark(52, i);
    assert.match(svg, /^<svg viewBox="0 0 32 \d+"/);
    assert.ok((svg.match(/<rect/g) ?? []).length > 400, `${FINISHES[i][0]} renders too few pixels`);
  }
});

test('finish overrides land on the right channels', () => {
  const silver = finishColors(DEFAULT_FINISH);
  assert.equal(silver.b, '#C9C7C4');           // coat
  assert.equal(silver.H, '#c7281d');           // red hat override
  assert.equal(silver.F, '#f3efe6');           // white feather override
  const navy = finishColors(1);
  assert.equal(navy.H, navy.b, 'hat follows the coat when not overridden');
  // Out-of-range input falls back to the default finish rather than crashing.
  assert.deepEqual(finishColors(99), silver);
});

test('grid preserves aspect ratio and skips transparent cells', () => {
  const svg = grid('AB\n.A', { A: '#111', B: '#222' }, 10);
  assert.match(svg, /viewBox="0 0 2 2"/);
  assert.equal((svg.match(/<rect/g) ?? []).length, 3);
});

test('the HHD mark is our own art: a parseable svg with the card-stack palette', async () => {
  const { hhdMark } = await import('../web/js/sprite.js');
  const svg = hhdMark(10);
  assert.match(svg, /^<svg /);
  for (const c of ['#1a1a1a', '#e8e4d0', '#c9a24a']) assert.ok(svg.includes(c), c);
});
