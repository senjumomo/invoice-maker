// Small UI helpers shared by views.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ICONS = {
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  pdf: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><path d="M7 14h10v7H7z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  pay: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/>',
  palette: '<path d="M12 3a9 9 0 100 18c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.2-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 005-5c0-4-4-7.5-9-7.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  restore: '<path d="M3 12a9 9 0 103-6.7L3 8"/><path d="M3 3v5h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  box: '<path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7M12 11v10"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  csv: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M9.5 12l5 6M14.5 12l-5 6"/>',
};
export const icon = (name, attrs = '') => `<svg viewBox="0 0 24 24" ${attrs}>${ICONS[name] || ''}</svg>`;

let toastTimer;
export function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Bottom sheet. Returns the sheet element; onClose fires when dismissed.
let closeCb = null;
export function openSheet(html, onClose) {
  const sh = $('#sheet'), bd = $('#sheetBackdrop');
  sh.innerHTML = `<div class="grabber"></div>${html}`;
  sh.hidden = false; bd.hidden = false;
  closeCb = onClose || null;
  bd.onclick = closeSheet;
  const f = sh.querySelector('[autofocus]');
  if (f) setTimeout(() => f.focus(), 60);
  return sh;
}
export function closeSheet() {
  const sh = $('#sheet');
  if (sh.hidden) return;
  sh.hidden = true; $('#sheetBackdrop').hidden = true; sh.innerHTML = '';
  const cb = closeCb; closeCb = null; cb && cb();
}
export const sheetOpen = () => !$('#sheet').hidden;

export function confirmSheet({ title, body = '', ok = 'OK', danger = false }) {
  return new Promise(res => {
    let result = false;
    const sh = openSheet(`<h3>${title}</h3>${body ? `<p class="muted">${body}</p>` : ''}
      <div class="sheet-actions"><button class="btn" data-x="no">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-x="yes">${ok}</button></div>`, () => res(result));
    sh.onclick = e => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      result = b.dataset.x === 'yes'; closeSheet();
    };
  });
}

// Read an image file, downscale it, return a data URL (keeps localStorage small).
export function readImage(file, max = 640) {
  return new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type)) return rej(new Error('Please choose an image file'));
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/png'));
      };
      img.onerror = () => rej(new Error('Could not read that image'));
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

export function pickFile(accept) {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => res(i.files[0] || null);
    i.click();
  });
}

export function initials(name) {
  return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}
