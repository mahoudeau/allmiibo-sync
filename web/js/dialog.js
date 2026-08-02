// Themed confirm dialog on native <dialog> — free focus trap, Escape,
// backdrop, focus return. Replaces window.confirm() everywhere.

import { icon } from './icons.js';

let dlg = null;

function ensure() {
  // Reused only while it is still in the document it will be shown in. A
  // detached node, or one belonging to a document that has since been replaced,
  // would otherwise be shown forever where nobody can see it, and every confirm
  // after that would resolve against nothing. Both clauses are needed: a node
  // in a discarded document still reports itself as connected.
  if (dlg?.isConnected && dlg.ownerDocument === document) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'nesDialog';
  dlg.innerHTML = `
    <h2 id="dlgTitle"><span class="dIco"></span><span class="dTitle"></span></h2>
    <div class="dBody"></div>
    <div class="dDetail"></div>
    <div class="dChoices" hidden></div>
    <div class="dRow">
      <button class="dCancel" value="cancel"></button>
      <button class="dConfirm" value="confirm"></button>
    </div>`;
  dlg.setAttribute('aria-labelledby', 'dlgTitle');
  document.body.append(dlg);
  return dlg;
}

/**
 * Pick one of several options, or cancel.
 *
 * A confirm dialog answers yes/no; this answers "which". Used where the choice
 * is the first thing the flow needs and asking it as a sequence of yes/no
 * questions would be worse — an update covering data, pictures or both is one
 * question with three answers, not two questions.
 *
 * @param {object} opts
 * @param {{value: string, label: string, hint?: string}[]} opts.options
 * @returns {Promise<string|null>} the chosen value, or null if cancelled
 */
export function chooseDialog({
  title,
  body = '',
  options = [],
  cancelLabel = 'CANCEL',
  icon: iconName = 'sync',
} = {}) {
  const d = ensure();
  d.querySelector('.dIco').innerHTML = icon(iconName);
  d.querySelector('.dTitle').textContent = title;
  d.querySelector('.dBody').textContent = body;
  d.querySelector('.dDetail').hidden = true;
  d.querySelector('.dDetail').textContent = '';

  const box = d.querySelector('.dChoices');
  box.textContent = '';
  box.hidden = false;

  // The confirm button has no meaning here: choosing IS confirming, and a
  // second click to agree with the click you just made is the routine
  // confirmation NN/g warns about.
  const confirmBtn = d.querySelector('.dConfirm');
  const cancelBtn = d.querySelector('.dCancel');
  confirmBtn.hidden = true;
  cancelBtn.textContent = cancelLabel;

  return new Promise((resolve) => {
    let picked = null;
    const done = () => {
      d.removeEventListener('close', done);
      box.hidden = true;
      confirmBtn.hidden = false;
      resolve(d.returnValue === 'confirm' ? picked : null);
    };
    d.addEventListener('close', done);

    for (const opt of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dChoice';
      b.dataset.value = opt.value;
      const label = document.createElement('span');
      label.className = 'cLabel';
      label.textContent = opt.label;
      b.append(label);
      if (opt.hint) {
        const hint = document.createElement('span');
        hint.className = 'cHint';
        hint.textContent = opt.hint;
        b.append(hint);
      }
      b.onclick = () => { picked = opt.value; d.close('confirm'); };
      box.append(b);
    }

    cancelBtn.onclick = () => d.close('cancel');
    d.returnValue = 'cancel';
    d.showModal();
    box.querySelector('.dChoice')?.focus();
  });
}

// confirmDialog({ title, body, detail, confirmLabel, cancelLabel, danger, icon })
// -> Promise<boolean>. `detail` may be a string[] rendered as mono lines.
export function confirmDialog({
  title,
  body = '',
  detail = null,
  confirmLabel = 'APPLY',
  cancelLabel = 'CANCEL',
  danger = false,
  icon: iconName = 'warning',
} = {}) {
  const d = ensure();
  d.querySelector('.dIco').innerHTML = icon(danger ? 'skull' : iconName);
  d.querySelector('.dTitle').textContent = title;
  d.querySelector('.dBody').textContent = body;
  const detailEl = d.querySelector('.dDetail');
  detailEl.textContent = '';
  detailEl.hidden = !detail;
  if (Array.isArray(detail)) {
    for (const line of detail) {
      const div = document.createElement('div');
      div.textContent = line;
      detailEl.append(div);
    }
  } else if (detail) {
    detailEl.textContent = detail;
  }
  d.querySelector('.dChoices').hidden = true;
  const confirmBtn = d.querySelector('.dConfirm');
  const cancelBtn = d.querySelector('.dCancel');
  confirmBtn.hidden = false;
  confirmBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  confirmBtn.classList.toggle('danger', danger);

  return new Promise((resolve) => {
    const done = () => {
      d.removeEventListener('close', done);
      resolve(d.returnValue === 'confirm');
    };
    d.addEventListener('close', done);
    confirmBtn.onclick = () => d.close('confirm');
    cancelBtn.onclick = () => d.close('cancel');
    d.returnValue = 'cancel';
    d.showModal();
    cancelBtn.focus(); // safe default
  });
}
