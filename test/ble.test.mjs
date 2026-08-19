// BleTransport write serialisation: node --test test/
//
// Chrome permits one GATT operation per device at a time — a second write
// issued while one is pending fails instantly with "GATT operation already in
// progress" instead of queueing. The tester's backup log showed what that
// costs: one stalled write poisoned ~50 downloads in a row, each dead in 1ms.
// The transport therefore chains every write behind the last.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BleTransport } from '../web/js/ble.js';

// A transport with a hand-rolled characteristic in place of a real GATT one.
function rigged() {
  const t = new BleTransport();
  const calls = [];
  let release;
  t.rx = {
    writeValueWithResponse(u) {
      calls.push(u);
      return new Promise((res) => { release = res; });
    },
  };
  return { t, calls, release: () => release() };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('a second write waits for the first instead of overlapping it', async () => {
  const { t, calls, release } = rigged();

  const a = t.write(new Uint8Array([1]));
  const b = t.write(new Uint8Array([2]));
  await tick();
  assert.equal(calls.length, 1, 'the second write reached GATT while the first was pending');

  release(); // the stalled first write finally settles
  await tick();
  assert.equal(calls.length, 2, 'the queued write was never issued');
  release();
  await Promise.all([a, b]);
});

test('a failed write does not poison the writes queued behind it', async () => {
  const t = new BleTransport();
  const calls = [];
  let n = 0;
  t.rx = {
    async writeValueWithResponse(u) {
      calls.push(u);
      if (++n === 1) throw new Error('GATT operation already in progress.');
    },
  };

  await assert.rejects(() => t.write(new Uint8Array([1])), /already in progress/);
  await t.write(new Uint8Array([2]));
  assert.equal(calls.length, 2);
});

test('writing with no connection rejects rather than queueing forever', async () => {
  const t = new BleTransport();
  await assert.rejects(() => t.write(new Uint8Array([1])), /not connected/);
});
