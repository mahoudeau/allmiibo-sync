// 8-bit UI icons, inlined as SVG strings (currentColor).
// Set: Pixelarticons by Gerrit Halfmann, MIT — https://pixelarticons.com
// (the bluetooth glyph is hand-drawn to match; no icon font, no CDN).

export const ICONS = {
  house:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 20h16v2H4zm16-10h2v10h-2zM2 10h2v10H2zm2-2h2v2H4zm2-2h2v2H6zm2-2h2v2H8zm2-2h4v2h-4zm4 2h2v2h-2zm2 2h2v2h-2zm2 2h2v2h-2zM8 14h2v6H8zm2-2h4v2h-4zm4 2h2v6h-2z"/></svg>',
  grid:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 2h16v2H4zm0 18h16v2H4zM2 4h2v16H2zm18 0h2v16h-2zM4 8h16v2H4zm0 6h16v2H4z"/> <path d="M8 4h2v16H8zm6 0h2v16h-2z"/></svg>',
  sync:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 4h2v6h-2zm-2-2h2v2h-2zm0 2h2v8h-2zM4 8H2v5h2z"/> <path d="M4 6h16v2H4zm4 14H6v-6h2zm2 2H8v-2h2zm0-2H8v-8h2zm10-4h2v-5h-2z"/> <path d="M20 18H4v-2h16z"/></svg>',
  activity:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3h14v2H5zm0 16h14v2H5zM3 5h2v14H3zm16 0h2v14h-2zM9 7h6v2H9zm0 8h6v2H9zM7 9h2v6H7zm8 0h2v6h-2zm-4-8h2v2h-2zm0 20h2v2h-2zM1 11h2v2H1zm20 0h2v2h-2zm0-4h2v2h-2zm0 8h2v2h-2zM1 15h2v2H1zm0-8h2v2H1zm6-6h2v2H7zm8 0h2v2h-2zm0 20h2v2h-2zm-8 0h2v2H7z"/></svg>',
  flask:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 2h10v2H7zm1 2h2v16H8zm2 16h4v2h-4zm4-16h2v16h-2z"/> <path d="M8 13h8v2H8z"/></svg>',
  folder:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h6v2H4zm0 14h16v2H4zM20 8h2v10h-2zM2 6h2v12H2zm8 0h10v2H10z"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 15v4h-2v-4zm-2 4v2H5v-2zM5 15v4H3v-4zm8-12v14h-2V3z"/> <path d="M7 11v2h10v-2zm2 2v2h2v-2zm4 0v2h2v-2z"/> <path d="M15 11v2h2v-2z"/></svg>',
  upload:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 21H5v-2h14v2ZM5 19H3v-4h2v4Zm16 0h-2v-4h2v4ZM13 5h2v2h2v2h-4v8h-2V9H7V7h2V5h2V3h2v2Z"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 22H6V20H18V22ZM9 6H15V4H17V6H22V8H20V20H18V8H6V20H4V8H2V6H7V4H9V6ZM15 4H9V2H15V4Z"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 14h2v6H4zm6 0h2v6h-2zm-4-2h4v2H6zm0 8h4v2H6zm-4-4h2v2H2zm20-8h-4V6h4z"/> <path d="M10 16h12v2H10zm4-8H2V6h12zm6-4v2h-2V4zm0 6V8h-2v2zm-6-8h4v2h-4zm0 10h4v-2h-4zm-2-8h2v2h-2zm0 6h2V8h-2z"/></svg>',
  list:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 5h12v2H10zm0 4h8v2h-8zm0 4h12v2H10zm0 4h8v2h-8zm-4-6H4V9h2v2ZM4 9H2V7h2v2Zm4 0H6V7h2v2ZM6 7H4V5h2v2Zm-2 6h2v2H4zm0 4h2v2H4zm-2 0v-2h2v2zm4 0v-2h2v2z"/></svg>',
  power:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 20h12v2H6zM18 6h2v2h-2zM4 6h2v2H4zm2-2h2v2H6zm10 0h2v2h-2zM4 18h2v2H4zm14 0h2v2h-2zM2 8h2v10H2zm18 0h2v10h-2zm-9-6h2v9h-2z"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 18H8v-2h2v2Zm-2-2H6v-2h2v2Zm4-2v2h-2v-2h2Zm-6 0H4v-2h2v2Zm8 0h-2v-2h2v2Zm2-2h-2v-2h2v2Zm2-2h-2V8h2v2Zm2-2h-2V6h2v2Z"/></svg>',
  close:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 19H5V17H7V19ZM19 19H17V17H19V19ZM9 15V17H7V15H9ZM17 17H15V15H17V17ZM11 15H9V13H11V15ZM15 15H13V13H15V15ZM13 13H11V11H13V13ZM11 11H9V9H11V11ZM15 11H13V9H15V11ZM9 9H7V7H9V9ZM17 9H15V7H17V9ZM7 7H5V5H7V7ZM19 7H17V5H19V7Z"/></svg>',
  chevron:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 16h-2v-2h2v2Zm-2-2H9v-2h2v2Zm4 0h-2v-2h2v2Zm-6-2H7v-2h2v2Zm8 0h-2v-2h2v2ZM7 10H5V8h2v2Zm12 0h-2V8h2v2Z"/></svg>',
  back:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11v2H4v-2zM8 13v2H6v-2zm2 2v2H8v-2zm2 2v2h-2v-2zm-4-6V9H6v2z"/> <path d="M10 15V7H8v8zm2 2V5h-2v12z"/></svg>',
  copy:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6h12v2H8zM4 2h12v2H4zm2 6h2v12H6zM2 4h2v12H2zm6 16h12v2H8zM20 8h2v12h-2zm-4-4h2v2h-2zM4 16h2v2H4z"/></svg>',
  save:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 22H4V20H6V14H8V20H16V14H18V20H20V22ZM4 20H2V4H4V20ZM22 20H20V6H22V20ZM16 14H8V12H16V14ZM12 10H6V6H12V10ZM20 6H18V4H20V6ZM18 4H4V2H18V4Z"/></svg>',
  play:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 11h-2V9h2zm0 4h-2v-2h2zm-2 2h-2v-2h2zm0-8h-2V7h2zm-2-2H9V5h2zM9 21H7V3h2zm6-8h2v-2h-2zm-6 4h2v2H9z"/></svg>',
  bluetooth:'<svg viewBox="0 0 6 9" fill="currentColor"><rect x="2" y="0" width="1" height="1"/><rect x="2" y="1" width="1" height="1"/><rect x="3" y="1" width="1" height="1"/><rect x="0" y="2" width="1" height="1"/><rect x="2" y="2" width="1" height="1"/><rect x="4" y="2" width="1" height="1"/><rect x="1" y="3" width="1" height="1"/><rect x="2" y="3" width="1" height="1"/><rect x="3" y="3" width="1" height="1"/><rect x="2" y="4" width="1" height="1"/><rect x="1" y="5" width="1" height="1"/><rect x="2" y="5" width="1" height="1"/><rect x="3" y="5" width="1" height="1"/><rect x="0" y="6" width="1" height="1"/><rect x="2" y="6" width="1" height="1"/><rect x="4" y="6" width="1" height="1"/><rect x="2" y="7" width="1" height="1"/><rect x="3" y="7" width="1" height="1"/><rect x="2" y="8" width="1" height="1"/></svg>'
};

// <span class="ico">…</span> ready to drop into innerHTML.
export function icon(name, className = 'ico') {
  return `<span class="${className}">${ICONS[name] ?? ''}</span>`;
}
