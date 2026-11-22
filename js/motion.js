// Motion and feedback: screen transitions, rolling numbers, smaller cents, haptics,
// the "done" checkmark, collapsing rows and pull-to-refresh.
import { $, $$, reduced } from './ui.js';

// ---- screen transitions
// depth: 0 = a tab, 1 = a detail page, 2 = an editor. Going deeper slides in from the right,
// going back slides out to the right, switching tabs cross-fades.
let lastDepth = 0;
export function transition(depth, run) {
  const dir = depth > lastDepth ? 'forward' : depth < lastDepth ? 'back' : 'fade';
  lastDepth = depth;
  const root = document.documentElement, view = $('#view');
  const after = () => {
    if (reduced() || dir === 'back') return;
    view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); // stagger the new content in
    clearTimeout(view._enterT); view._enterT = setTimeout(() => view.classList.remove('enter'), 900);
  };
  if (document.startViewTransition && !reduced() && !document.hidden) {
    root.dataset.dir = dir;
    const t = document.startViewTransition(() => { run(); after(); });
    // A skipped transition (page hidden, another navigation) still updates the page; it just isn't animated.
    t.ready.catch(() => {}); t.updateCallbackDone.catch(() => {});
    t.finished.catch(() => {}).finally(() => { if (root.dataset.dir === dir) delete root.dataset.dir; });
  } else {
    run(); after();
    if (!reduced()) { view.classList.remove('in-forward', 'in-back', 'in-fade'); void view.offsetWidth; view.classList.add('in-' + dir); }
  }
}

// ---- smaller cents: "R 2 100,00" → "R 2 100<small>,00</small>"
const CENTS = /([.,]\d{2})(?!\d)(?=\D*$)/;
export const cents = s => String(s).replace(CENTS, '<small class="cents">$1</small>');
export function centsify(root) {
  for (const el of $$('.amt, .summary .value, .t-row.grand > span:last-child, .lesson-amt', root)) {
    if (el.dataset.c) continue; el.dataset.c = '1';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const hits = []; while (walker.nextNode()) if (CENTS.test(walker.currentNode.nodeValue) && !walker.currentNode.parentElement.closest('.cents')) hits.push(walker.currentNode);
    for (const n of hits) {
      const m = n.nodeValue.match(CENTS), i = m.index;
      const small = document.createElement('small'); small.className = 'cents'; small.textContent = m[1];
      const rest = document.createTextNode(n.nodeValue.slice(i + m[1].length));
      n.nodeValue = n.nodeValue.slice(0, i);
      n.after(small, rest);
    }
  }
}

// ---- rolling numbers: rollNum() renders a number that counts from its last shown value
const rollPrev = new Map(), rollFmt = new Map();
export function rollNum(key, value, format = String) {
  rollFmt.set(key, format);
  const from = reduced() ? value : rollPrev.has(key) ? rollPrev.get(key) : 0;
  return `<span data-roll="${key}" data-from="${from}" data-v="${value}">${cents(format(from))}</span>`;
}
export function runRolls(root) {
  for (const el of $$('[data-roll]:not([data-done])', root)) {
    el.dataset.done = '1';
    const key = el.dataset.roll, from = +el.dataset.from, to = +el.dataset.v, fmt = rollFmt.get(key) || String;
    rollPrev.set(key, to);
    if (from === to) { el.innerHTML = cents(fmt(to)); continue; }
    const t0 = performance.now(), dur = 700;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.innerHTML = cents(fmt(k === 1 ? to : from + (to - from) * e));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

// ---- feedback
export const haptic = (ms = 10) => { try { navigator.vibrate?.(ms); } catch {} };
export function celebrate(text) {
  const h = document.createElement('div');
  h.className = 'hud'; h.setAttribute('role', 'status');
  h.innerHTML = `<svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="23"/><path d="M15 27l7 7 15-16"/></svg><div></div>`;
  h.lastChild.textContent = text;
  document.body.appendChild(h); haptic(15);
  setTimeout(() => h.classList.add('out'), 1100);
  setTimeout(() => h.remove(), 1500);
}
// Shrinks a row away before the list re-renders without it.
export function collapse(el) {
  return new Promise(res => {
    if (!el || reduced()) return res();
    el.style.height = el.offsetHeight + 'px'; el.style.overflow = 'hidden'; void el.offsetHeight;
    el.style.transition = 'height .28s cubic-bezier(.4,0,.2,1), opacity .2s';
    el.style.height = '0'; el.style.opacity = '0';
    setTimeout(res, 290);
  });
}
export function pop(el) { if (!el || reduced()) return; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }

// ---- pull to refresh on the root tabs (Today, Students, Invoices)
export function pullToRefresh(onRefresh) {
  const ptr = $('#ptr'), view = $('#view');
  let y0 = null, pull = 0;
  const reset = () => {
    view.style.transition = ptr.style.transition = 'transform .45s cubic-bezier(.32,.72,0,1), opacity .3s';
    view.style.transform = ''; ptr.style.transform = ''; ptr.style.opacity = '0';
    setTimeout(() => { view.style.transition = ptr.style.transition = ''; ptr.classList.remove('spin'); }, 460);
  };
  addEventListener('touchstart', e => {
    y0 = document.body.classList.contains('large') && scrollY <= 0 && $('#sheet').hidden ? e.touches[0].clientY : null; pull = 0;
  }, { passive: true });
  addEventListener('touchmove', e => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0 || scrollY > 0) { if (pull) { pull = 0; view.style.transform = ''; ptr.style.opacity = '0'; } return; }
    pull = Math.min(120, dy * .45);
    view.style.transform = `translateY(${pull}px)`;
    ptr.style.opacity = String(Math.min(1, pull / 70));
    ptr.style.transform = `translateY(${pull * .5}px) rotate(${pull * 4}deg)`;
    if (pull >= 70 && !ptr.classList.contains('ready')) { ptr.classList.add('ready'); haptic(8); }
    if (pull < 70) ptr.classList.remove('ready');
  }, { passive: true });
  addEventListener('touchend', () => {
    if (y0 == null) return; y0 = null;
    if (pull >= 70) {
      ptr.classList.remove('ready'); ptr.classList.add('spin');
      view.style.transition = 'transform .3s'; view.style.transform = 'translateY(56px)';
      setTimeout(() => { onRefresh(); reset(); }, 600);
    } else reset();
    pull = 0;
  });
}
