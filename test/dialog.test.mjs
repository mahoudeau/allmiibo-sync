// The confirm dialog's double-confirmation: node --test test/
//
// Destructive flows pass `twice: true`, and the contract under test is the
// arithmetic of consent: yes means both dialogs said yes, and a no anywhere is
// a no. One click — or an "OK" carried by muscle memory — must never be enough
// to erase files.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountHtml } from './helpers/dom.mjs';

const page = mountHtml('<!doctype html><html><body></body></html>');
const { confirmDialog } = await import('../web/js/dialog.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
const dlg = () => page.$('dialog.nesDialog');
const answer = async (value) => {
  await tick();
  dlg().querySelector(value === 'confirm' ? '.dConfirm' : '.dCancel').onclick();
};

test('without twice, one confirmation is still enough', async () => {
  const p = confirmDialog({ title: 'APPLY?', confirmLabel: 'APPLY' });
  await answer('confirm');
  assert.equal(await p, true);
});

test('cancelling the first dialog never shows a second', async () => {
  const p = confirmDialog({ title: 'ERASE?', confirmLabel: 'ERASE', danger: true, twice: true });
  await answer('cancel');
  assert.equal(await p, false);
  assert.equal(dlg().open, false, 'a second dialog was left showing');
});

test('confirming the first but cancelling the second is a no', async () => {
  const p = confirmDialog({ title: 'ERASE?', confirmLabel: 'ERASE', danger: true, twice: true });
  await answer('confirm');
  await tick();
  assert.equal(dlg().open, true, 'the second dialog never appeared');
  assert.equal(dlg().querySelector('.dTitle').textContent, 'ARE YOU SURE?');
  await answer('cancel');
  assert.equal(await p, false);
});

test('erasing takes two deliberate yeses', async () => {
  const p = confirmDialog({ title: 'ERASE?', confirmLabel: 'ERASE', danger: true, twice: true });
  await answer('confirm');
  await tick();
  // The second dialog keeps the verb from the first, so the button still says
  // what it does rather than a generic OK.
  assert.equal(dlg().querySelector('.dConfirm').textContent, 'ERASE');
  await answer('confirm');
  assert.equal(await p, true);
});

test('teardown', () => page.restore());
