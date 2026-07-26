// Shared UI toolkit: the small, DOM-touching helpers every page uses.
// No framework, no deps — functions that wire the components in app.css.

import { icon } from './icons.js';

// ---- basics --------------------------------------------------------------

export function debounce(fn, ms = 150) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  return wrapped;
}

export const motionOK = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDuration(seconds) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  return `~${Math.round(seconds / 60)} min`;
}

// ---- toast ---------------------------------------------------------------

let toastStack = null;

export function toast(message, { kind = 'ok', iconName, timeout } = {}) {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toastStack';
    toastStack.setAttribute('role', 'status');
    toastStack.setAttribute('aria-live', 'polite');
    document.body.append(toastStack);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  if (kind === 'err') t.setAttribute('role', 'alert');
  const ico = iconName ?? { ok: 'check', warn: 'warning', err: 'cancel', info: 'info' }[kind];
  t.innerHTML = `${icon(ico)}<span></span>`;
  t.lastChild.textContent = message;
  const ms = timeout ?? (kind === 'err' ? 0 : 2600);
  if (ms === 0) {
    const close = document.createElement('button');
    close.className = 'tClose';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = icon('close');
    close.addEventListener('click', () => dismiss());
    t.append(close);
  }
  toastStack.append(t);
  while (toastStack.children.length > 3) toastStack.firstChild.remove();
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    t.classList.add('out');
    const drop = () => t.remove();
    motionOK() ? t.addEventListener('animationend', drop, { once: true }) : drop();
  };
  if (ms > 0) {
    let timer = setTimeout(dismiss, ms);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1200); });
  }
  return dismiss;
}

// ---- status line ----------------------------------------------------------

// Wraps a .status element: adds a polite live region and throttles the
// announcements so scan loops don't flood screen readers.
export function statusCtl(el) {
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  let lastSpoken = 0;
  return {
    set(text, kind = '') {
      el.className = `status ${kind}`;
      const now = Date.now();
      if (now - lastSpoken >= 1000 || kind === 'err' || kind === 'ok') {
        el.textContent = text;
        lastSpoken = now;
      } else {
        // update visually without re-announcing: swap aria-live off briefly
        el.setAttribute('aria-live', 'off');
        el.textContent = text;
        el.setAttribute('aria-live', 'polite');
      }
    },
  };
}

// ---- progress -------------------------------------------------------------

// Controls a .pbar element (see app.css): indeterminate march, determinate,
// and dual-level (overall ops + current-file bytes).
export function progressCtl(el) {
  const fill = el.querySelector('.track:not(.sub) .fill');
  const sub = el.querySelector('.track.sub');
  const subFill = sub?.querySelector('.fill');
  const left = el.querySelector('.pLbl .left');
  const right = el.querySelector('.pLbl .right');
  const show = () => { el.hidden = false; };
  return {
    busy(label = '', detail = '') {
      show();
      el.classList.add('busy');
      el.classList.remove('active');
      fill.style.width = '100%';
      if (left) left.textContent = label;
      if (right) right.textContent = detail;
      if (sub) sub.hidden = true;
      el.removeAttribute('aria-valuenow');
    },
    set(done, total, label = '', detail = '') {
      show();
      el.classList.remove('busy');
      el.classList.add('active');
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      el.setAttribute('aria-valuenow', String(pct));
      if (left) left.textContent = label;
      if (right) right.textContent = detail;
    },
    setFile(written, total) {
      if (!sub || !subFill) return;
      sub.hidden = false;
      subFill.style.width = total > 0 ? `${Math.round((written / total) * 100)}%` : '0%';
    },
    done() {
      fill.style.width = '100%';
      el.classList.remove('busy', 'active');
      if (sub) sub.hidden = true;
      setTimeout(() => { el.hidden = true; }, 400);
    },
    hide() {
      el.hidden = true;
      el.classList.remove('busy', 'active');
      if (sub) sub.hidden = true;
    },
  };
}

// ---- buttons --------------------------------------------------------------

const busyState = new WeakMap();

export function busy(btn, label) {
  if (busyState.has(btn)) return;
  busyState.set(btn, btn.innerHTML);
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.classList.add('loading');
  btn.innerHTML = `${icon('loader')}${label ?? btn.textContent.trim()}`;
}

export function idle(btn) {
  const original = busyState.get(btn);
  if (original === undefined) return;
  busyState.delete(btn);
  btn.disabled = false;
  btn.removeAttribute('aria-busy');
  btn.classList.remove('loading');
  btn.innerHTML = original;
}

// ---- flourish -------------------------------------------------------------

// Tick a number from its current value to `to`. Integers only, ends exact.
export function countUp(el, to, ms = 500) {
  const from = parseInt(el.textContent.replace(/\D/g, ''), 10) || 0;
  if (!motionOK() || from === to) { el.textContent = String(to); return; }
  const t0 = performance.now();
  const frame = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const stepped = Math.floor(k * 8) / 8; // 8 quantized frames
    el.textContent = String(Math.round(from + (to - from) * stepped));
    if (k < 1) requestAnimationFrame(frame);
    else el.textContent = String(to);
  };
  requestAnimationFrame(frame);
}

// Pixel burst: ten 4px squares fly outward from the anchor. NES confetti.
export function burst(anchorEl) {
  if (!motionOK()) return;
  const b = document.createElement('div');
  b.className = 'burst';
  const colors = ['var(--ok)', 'var(--warn)', 'var(--accent2)'];
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('i');
    const angle = (i / 10) * Math.PI * 2;
    p.style.setProperty('--dx', String(Math.round(Math.cos(angle) * 12) * 3));
    p.style.setProperty('--dy', String(Math.round(Math.sin(angle) * 9) * 3));
    p.style.background = colors[i % colors.length];
    b.append(p);
  }
  anchorEl.style.position ||= 'relative';
  anchorEl.append(b);
  b.addEventListener('animationend', () => b.remove(), { once: true });
  setTimeout(() => b.remove(), 900); // safety net
}

// ---- segmented control -----------------------------------------------------

// Wires a .segCtl (radios + sliding thumb). Returns { get value, set }.
export function segCtl(el, { onChange } = {}) {
  const radios = [...el.querySelectorAll('input[type=radio]')];
  const apply = () => {
    const i = radios.findIndex((r) => r.checked);
    el.style.setProperty('--seg', String(Math.max(0, i)));
  };
  for (const r of radios) {
    r.addEventListener('change', () => {
      apply();
      onChange?.(r.value);
    });
  }
  apply();
  return {
    get value() { return radios.find((r) => r.checked)?.value; },
    set(value) {
      const r = radios.find((x) => x.value === value);
      if (r && !r.checked) { r.checked = true; apply(); }
    },
  };
}
