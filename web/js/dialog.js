// Themed confirm dialog on native <dialog> — free focus trap, Escape,
// backdrop, focus return. Replaces window.confirm() everywhere.

import { icon } from './icons.js';

let dlg = null;

function ensure() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'nesDialog';
  dlg.innerHTML = `
    <h2 id="dlgTitle"><span class="dIco"></span><span class="dTitle"></span></h2>
    <div class="dBody"></div>
    <div class="dDetail"></div>
    <div class="dRow">
      <button class="dCancel" value="cancel"></button>
      <button class="dConfirm" value="confirm"></button>
    </div>`;
  dlg.setAttribute('aria-labelledby', 'dlgTitle');
  document.body.append(dlg);
  return dlg;
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
  const confirmBtn = d.querySelector('.dConfirm');
  const cancelBtn = d.querySelector('.dCancel');
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
