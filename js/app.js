import * as S from './store.js';
import { DOC_TYPES, TEMPLATES, COLORS, CURRENCIES, FREQ_LABELS } from './store.js';
import { totals, status, STATUS_LABEL, money, fmtDate, num, clearFormatCache } from './calc.js';
import { paperHTML, fitPaper, esc } from './render.js';
import { downloadPDF, sharePDF, printDoc, toCSV, downloadBlob } from './export.js';
import { $, $$, icon, toast, openSheet, closeSheet, sheetOpen, confirmSheet, readImage, pickFile, initials } from './ui.js';

const view = $('#view');
let leaveGuard = null; // returns true if it's OK to leave the current view

// ------------------------------------------------------------------ router
const routes = [
  [/^#?\/?$/, lessonsView, 'today'],
  [/^#\/lessons$/, lessonsView, 'today'],
  [/^#\/invoices$/, docsView, 'invoices'],
  [/^#\/doc\/(\w+)$/, docView, 'invoices'],
  [/^#\/new\/(\w+)(?:\/(\w+))?$/, (type, cust) => editView(null, type, cust), 'invoices'],
  [/^#\/edit\/(\w+)$/, id => editView(id), 'invoices'],
  [/^#\/customers$/, customersView, 'customers'],
  [/^#\/customer\/(\w+)$/, customerView, 'customers'],
  [/^#\/items$/, itemsView, 'settings'],
  [/^#\/reports$/, reportsView, 'invoices'],
  [/^#\/settings$/, settingsView, 'settings'],
];
let lastHash = location.hash;
async function route() {
  if (leaveGuard && !(await leaveGuard())) { history.replaceState(null, '', lastHash || '#/'); return; }
  leaveGuard = null; onResize = null; closeSheet();
  lastHash = location.hash;
  const h = location.hash || '#/';
  for (const [re, fn, tab] of routes) {
    const m = h.match(re);
    if (m) {
      $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
      setChrome({});
      view.onclick = view.oninput = view.onchange = null;
      fn(...m.slice(1));
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}
function setChrome({ title = 'Invoice Maker', back = false, fab = null, actions = '', nav = true }) {
  $('#title').textContent = title;
  $('#backBtn').hidden = !back;
  $('#topActions').innerHTML = actions; $('#topActions').onclick = null;
  $('#fab').hidden = !fab; $('#fab').onclick = fab;
  document.body.classList.toggle('no-nav', !nav);
  // iOS large title on root tabs; the small nav-bar title fades in once it scrolls away.
  document.body.classList.toggle('large', nav && !back);
  $('#largeTitle').textContent = title;
  onScrollChrome();
  document.title = title === 'Invoice Maker' ? title : `${title} · Invoice Maker`;
}
function onScrollChrome() { document.body.classList.toggle('scrolled', window.scrollY > 36); }
window.addEventListener('scroll', onScrollChrome, { passive: true });
$('#backBtn').onclick = () => {
  if (history.length > 1 && sessionStorage.getItem('im-nav')) history.back();
  else location.hash = '#/';
};
window.addEventListener('hashchange', () => { sessionStorage.setItem('im-nav', '1'); route(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

const customerLabel = d => (d.billTo || '').split('\n')[0].trim() || 'No customer';
const badge = st => st === 'none' ? '' : `<span class="badge ${st}">${STATUS_LABEL[st]}</span>`;
const empty = (ico, text) => `<div class="empty">${icon(ico)}<div>${text}</div></div>`;
const live = () => S.db().docs.filter(d => !d.deletedAt);
const simple = () => S.settings().simple !== false; // tutor-friendly: fewer fields, + makes an invoice

// iOS-style swipe-to-reveal actions. Rows look like:
// <div class="swipe" data-id><div class="swipe-acts"><button data-swipe="x">…</button></div><div class="swipe-row">…</div></div>
// onAct(id, action) runs when an action button is tapped.
function enableSwipe(root, onAct) {
  let row = null, x0 = 0, y0 = 0, dx = 0, dragging = false, open = null, w = 0, suppress = false;
  const close = r => { if (r) r.style.transform = ''; if (open === r) open = null; };
  root.addEventListener('pointerdown', e => {
    const r = e.target.closest('.swipe-row');
    if (e.target.closest('[data-swipe]')) return;
    suppress = false;
    if (open && open !== r) { close(open); suppress = true; }
    if (!r || (e.pointerType === 'mouse' && e.button !== 0)) return;
    row = r; x0 = e.clientX; y0 = e.clientY; dx = 0; dragging = false;
    w = r.parentElement.querySelector('.swipe-acts').offsetWidth;
  });
  root.addEventListener('pointermove', e => {
    if (!row) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { row = null; return; } // vertical scroll wins
      if (Math.abs(mx) < 10) return;
      dragging = true; row.style.transition = 'none';
      try { row.setPointerCapture(e.pointerId); } catch {}
    }
    dx = Math.min(0, Math.max(-w - 30, (row === open ? -w : 0) + mx));
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = () => {
    if (!row) return;
    row.style.transition = '';
    if (dragging) {
      suppress = true;
      if (dx < -w / 2) { row.style.transform = `translateX(${-w}px)`; open = row; } else close(row);
    }
    row = null;
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.addEventListener('click', e => {
    const a = e.target.closest('[data-swipe]');
    if (a) { e.preventDefault(); e.stopPropagation(); const id = a.closest('.swipe').dataset.id; close(open); onAct(id, a.dataset.swipe); return; }
    if (suppress) { e.preventDefault(); e.stopPropagation(); suppress = false; return; } // the click that ends a drag
    if (open && e.target.closest('.swipe-row') === open) { e.preventDefault(); e.stopPropagation(); close(open); } // tap closes an open row
  }, true);
}

// Payment reminder: WhatsApp message to the student's number, or share the PDF with the message.
function remindSheet(d, t, st) {
  const c = S.getCustomer(d.customerId), type = DOC_TYPES[d.type];
  const name = (d.billTo || '').split('\n')[0].trim().split(/\s+/)[0] || 'there';
  const me = (d.from || '').split('\n')[0].trim();
  const due = d.dueDate ? (st === 'overdue' ? `was due on ${fmtDate(d.dueDate)}` : `is due on ${fmtDate(d.dueDate)}`) : 'is still outstanding';
  const msg = `Hi ${name}, just a friendly reminder that ${type.label.toLowerCase()} ${d.number} for ${money(t.balance, d.currency)} ${due}. Thank you!${me ? `\n${me}` : ''}`;
  const sh = openSheet(`<h3>Payment reminder</h3><div class="stack">
      <label class="field"><span>WhatsApp number</span><input id="rm_phone" type="tel" value="${esc(c?.phone || '')}" placeholder="e.g. 082 123 4567"></label>
      <label class="field"><span>Message</span><textarea id="rm_msg" rows="5">${esc(msg)}</textarea></label>
      <p class="small muted" style="margin:0">“WhatsApp” opens a chat with this message. “Share with PDF” attaches the invoice too; pick WhatsApp in the share menu.</p>
    </div>
    <div class="sheet-actions"><button class="btn" data-x="share">${icon('share')}Share with PDF</button><button class="btn primary" data-x="wa">WhatsApp</button></div>`);
  sh.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const phone = $('#rm_phone', sh).value.trim(), text = $('#rm_msg', sh).value;
    if (c && phone && !c.phone) { c.phone = phone; S.save(); }
    closeSheet();
    if (b.dataset.x === 'wa') {
      let digits = phone.replace(/\D/g, '');
      if (digits.startsWith('0') && S.settings().locale === 'en-ZA') digits = '27' + digits.slice(1); // local SA number → international
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, '_blank');
    } else {
      toast('Creating PDF…', 60000);
      try { const r = await sharePDF(d, text); toast(r === 'shared' ? 'Shared' : r === 'downloaded' ? 'Sharing isn’t supported here, so the PDF was downloaded' : 'Cancelled'); }
      catch (err) { toast(err.message); }
    }
  };
}

// ------------------------------------------------------------------ new-document type picker
function pickDocType(onPick, title = 'New document') {
  const sh = openSheet(`<h3>${title}</h3><div class="menu">${Object.entries(DOC_TYPES).map(([k, t]) =>
    `<button data-type="${k}">${icon('doc')}<span>${t.label}</span></button>`).join('')}</div>`);
  sh.onclick = e => { const b = e.target.closest('[data-type]'); if (b) { closeSheet(); onPick(b.dataset.type); } };
}

// ------------------------------------------------------------------ documents list
const docFilter = { status: 'unpaid', type: 'all', q: '' };
function docsView() {
  setChrome({ title: 'Invoices', actions: `<button class="icon-btn" aria-label="Reports">${icon('chart')}</button>`,
    fab: () => simple() ? location.hash = '#/new/invoice' : pickDocType(t => location.hash = `#/new/${t}`) });
  $('#topActions').onclick = () => location.hash = '#/reports';
  const all = live(), cur = S.settings().currency;
  // Totals per currency; the default currency is always shown first.
  const sums = { unpaid: { [cur]: 0 }, overdue: { [cur]: 0 }, paid: { [cur]: 0 } };
  const add = (k, c, v) => { sums[k][c] = (sums[k][c] || 0) + v; };
  for (const d of all) {
    const t = totals(d), st = status(d, t), c = d.currency || cur;
    if (st === 'overdue') add('overdue', c, t.balance);
    if (st === 'unpaid' || st === 'partial' || st === 'overdue') add('unpaid', c, t.balance);
    if (st === 'paid' || st === 'partial') add('paid', c, t.paid);
  }
  // Default currency only, unless some document uses another one (then show each non-zero amount).
  const show = k => {
    const rows = Object.entries(sums[k]).filter(([c, v]) => Math.abs(v) > 0.004);
    return (rows.length ? rows : [[cur, 0]]).map(([c, v]) => `<div>${money(v, c)}</div>`).join('');
  };
  const typesUsed = [...new Set(all.map(d => d.type))];
  view.innerHTML = `
    <div class="summary">
      <div class="card"><div class="label">Unpaid</div><div class="value">${show('unpaid')}</div></div>
      <div class="card"><div class="label">Overdue</div><div class="value ${Object.values(sums.overdue).some(v => v > 0.004) ? 'bad' : ''}">${show('overdue')}</div></div>
      <div class="card"><div class="label">Paid</div><div class="value good">${show('paid')}</div></div>
      <div class="card"><div class="label">Documents</div><div class="value">${all.length}</div></div>
    </div>
    <div class="search">${icon('search')}<input class="input" id="q" type="search" placeholder="Search student, number or item" value="${esc(docFilter.q)}"></div>
    <div class="chips" id="statusChips">${['all', 'unpaid', 'overdue', 'paid', 'trash'].map(s =>
      `<button class="chip ${docFilter.status === s ? 'active' : ''}" data-st="${s}">${s === 'all' ? 'All' : s === 'trash' ? 'Trash' : STATUS_LABEL[s]}</button>`).join('')}
      ${typesUsed.length > 1 ? `<select class="chip" id="typeSel"><option value="all">All types</option>${typesUsed.map(t =>
        `<option value="${t}" ${docFilter.type === t ? 'selected' : ''}>${DOC_TYPES[t].label}</option>`).join('')}</select>` : ''}
    </div>
    <div id="docList"></div>`;
  const draw = () => {
    const q = docFilter.q.trim().toLowerCase();
    const inTrash = docFilter.status === 'trash';
    let docs = S.db().docs.filter(d => inTrash ? d.deletedAt : !d.deletedAt);
    if (docFilter.type !== 'all') docs = docs.filter(d => d.type === docFilter.type);
    if (q) docs = docs.filter(d => [d.number, d.billTo, d.shipTo, d.po, ...d.items.map(i => i.desc)].join(' ').toLowerCase().includes(q));
    const rows = docs.map(d => ({ d, t: totals(d) })).map(x => ({ ...x, st: status(x.d, x.t) }))
      .filter(x => inTrash || docFilter.status === 'all' || x.st === docFilter.status || (docFilter.status === 'unpaid' && (x.st === 'partial' || x.st === 'overdue')))
      .sort((a, b) => (b.d.date || '').localeCompare(a.d.date || '') || b.d.createdAt - a.d.createdAt);
    $('#docList').innerHTML = rows.length ? `
      ${inTrash ? '<p class="small muted">Documents in Trash for more than 30 days are deleted automatically.</p>' : ''}
      <div class="card list">${rows.map(({ d, t, st }) => {
        const acts = inTrash || !DOC_TYPES[d.type].payable ? '' : st === 'paid'
          ? `<button data-swipe="unpaid" class="grey">Mark<br>unpaid</button>` : `<button data-swipe="paid" class="ok">Mark<br>paid</button>`;
        const row = `<a class="list-item ${acts ? 'swipe-row' : ''}" href="#/doc/${d.id}" draggable="false">
        <div class="main"><div class="title ellipsis">${esc(customerLabel(d))}</div>
          <div class="sub">${DOC_TYPES[d.type].label} ${esc(d.number)} · ${fmtDate(d.date)}${d.recurring?.freq && !d.recurring.ended ? ' · ' + icon('repeat', 'style="width:13px;height:13px;vertical-align:-2px"') : ''}</div></div>
        <div class="amt">${money(t.total, d.currency)}<br>${inTrash ? '' : badge(st)}</div>
      </a>`;
        return acts ? `<div class="swipe" data-id="${d.id}"><div class="swipe-acts">${acts}</div>${row}</div>` : row;
      }).join('')}</div>
      ${!inTrash && rows.some(r => DOC_TYPES[r.d.type].payable) ? '<p class="small muted hint">Swipe an invoice left to mark it paid.</p>' : ''}`
      : empty('doc', inTrash ? 'Trash is empty.' : !all.length ? 'No invoices yet.<br>Tap + to create one, or generate them from your lessons on the Today tab.'
        : docFilter.status === 'unpaid' ? 'Nothing unpaid right now.' : 'Nothing matches.');
  };
  draw();
  enableSwipe($('#docList'), (id, act) => {
    const d = S.getDoc(id); if (!d) return;
    d.payment = act === 'paid' ? { amount: null, date: S.today(), method: 'Bank transfer' } : null;
    S.save(); toast(act === 'paid' ? 'Marked as paid' : 'Marked as unpaid'); draw();
  });
  view.oninput = e => { if (e.target.id === 'q') { docFilter.q = e.target.value; draw(); } };
  view.onchange = e => { if (e.target.id === 'typeSel') { docFilter.type = e.target.value; draw(); } };
  view.onclick = e => {
    const c = e.target.closest('[data-st]');
    if (c) { docFilter.status = c.dataset.st; $$('#statusChips [data-st]').forEach(x => x.classList.toggle('active', x === c)); draw(); }
  };
}

// ------------------------------------------------------------------ document detail / preview
function docView(id) {
  const d = S.getDoc(id);
  if (!d) { location.hash = '#/invoices'; return; }
  const type = DOC_TYPES[d.type], t = totals(d), st = status(d, t);
  setChrome({ title: `${type.label} ${d.number}`, back: true, nav: false });
  const m = v => money(v, d.currency);
  let banner = '';
  if (d.deletedAt) banner = `<div class="status-banner overdue"><div class="grow">This document is in Trash.</div><button class="btn" data-act="restore">${icon('restore')}Restore</button></div>`;
  else if (st === 'paid') banner = `<div class="status-banner paid">${icon('check')}<div class="grow">Paid ${m(t.paid)}${d.payment.date ? ' on ' + fmtDate(d.payment.date) : ''}${d.payment.method ? ' via ' + esc(d.payment.method) : ''}.</div></div>`;
  else if (st === 'partial') banner = `<div class="status-banner partial"><div class="grow">Partially paid ${m(t.paid)}. Balance due ${m(t.balance)}.</div></div>`;
  else if (st === 'overdue') banner = `<div class="status-banner overdue"><div class="grow">${m(t.total)} was due on ${fmtDate(d.dueDate)}.</div></div>`;
  else if (st === 'unpaid') banner = `<div class="status-banner unpaid"><div class="grow">${m(t.total)} unpaid${d.dueDate ? ', due ' + fmtDate(d.dueDate) : ''}.</div></div>`;
  const r = d.recurring;
  const recur = r?.freq ? `<div class="status-banner unpaid">${icon('repeat')}<div class="grow">${r.ended ? 'Recurring schedule ended.' : `Repeats ${FREQ_LABELS[r.freq].toLowerCase()}. Next copy is created on ${fmtDate(r.next)}.`}</div></div>` : '';
  const sent = d.sentAt ? `<p class="small muted" style="margin:-4px 0 12px">Last sent ${new Date(d.sentAt).toLocaleString(S.settings().locale)}</p>` : '';
  const canRemind = type.payable && !d.deletedAt && ['overdue', 'unpaid', 'partial'].includes(st);
  view.innerHTML = `${banner}${recur}${sent}
    ${canRemind ? `<button class="btn block remind" data-act="remind">${icon('mail')}Send payment reminder</button>` : ''}
    <div class="action-grid">
      <button data-act="edit">${icon('edit')}Edit</button>
      <button data-act="share">${icon('share')}Share</button>
      <button data-act="pdf">${icon('pdf')}PDF</button>
      <button data-act="print">${icon('print')}Print</button>
      <button data-act="email">${icon('mail')}Email</button>
      <button data-act="payment">${icon('pay')}Payment</button>
      <button data-act="copy">${icon('copy')}Copy</button>
      <button data-act="more">${icon('more')}More</button>
    </div>
    <div class="preview-wrap" id="pw">${paperHTML(d)}</div>`;
  const pw = $('#pw');
  fitPaper(pw); $$('img', pw).forEach(i => i.onload = () => fitPaper(pw));
  const busy = async (label, fn) => { toast(label, 60000); try { await fn(); } catch (e) { toast(e.message || 'Something went wrong'); return; } };
  const actions = {
    edit: () => location.hash = `#/edit/${d.id}`,
    restore: () => { S.restoreDoc(d.id); toast('Restored'); docView(id); },
    pdf: () => busy('Creating PDF…', async () => { await downloadPDF(d); toast('PDF downloaded'); }),
    share: () => busy('Creating PDF…', async () => {
      const r = await sharePDF(d, `${type.label} ${d.number} — ${money(t.total, d.currency)}`);
      if (r === 'shared') { d.sentAt = Date.now(); S.save(); docView(id); toast('Shared'); }
      else toast(r === 'downloaded' ? 'Sharing files isn’t supported here, so the PDF was downloaded' : 'Cancelled');
    }),
    print: () => printDoc(d),
    email: () => emailSheet(d, t),
    payment: () => paymentSheet(d, t, () => docView(id)),
    copy: () => pickDocType(type => { const c = S.copyDoc(d, type); pendingDraft = c; location.hash = `#/new/${type}`; }, 'Copy as…'),
    more: () => moreSheet(d),
    remind: () => remindSheet(d, t, st),
  };
  view.onclick = e => { const b = e.target.closest('[data-act]'); if (b) actions[b.dataset.act](); };
  onResize = () => fitPaper(pw);
}
let onResize = null;
window.addEventListener('resize', () => onResize && onResize());

function emailSheet(d, t) {
  const type = DOC_TYPES[d.type];
  const subject = `${type.label} ${d.number} from ${(d.from || '').split('\n')[0]}`;
  const body = `Hello,\n\nPlease find ${type.label.toLowerCase()} ${d.number} for ${money(t.total, d.currency)}${d.dueDate && type.payable ? `, due ${fmtDate(d.dueDate)}` : ''}.\n\nThank you,\n${(d.from || '').split('\n')[0]}`;
  const sh = openSheet(`<h3>Email ${type.label.toLowerCase()}</h3>
    <div class="stack">
      <label class="field"><span>To</span><input id="em_to" type="email" value="${esc(d.email || S.getCustomer(d.customerId)?.email || '')}" placeholder="customer@example.com"></label>
      <label class="field"><span>Subject</span><input id="em_sub" value="${esc(subject)}"></label>
      <label class="field"><span>Message</span><textarea id="em_body" rows="6">${esc(body)}</textarea></label>
      <p class="small muted">“Share PDF” attaches the PDF in your mail app (on phones that support it). “Open mail app” opens a plain email; attach the PDF yourself.</p>
    </div>
    <div class="sheet-actions"><button class="btn" data-x="mailto">${icon('mail')}Open mail app</button><button class="btn primary" data-x="share">${icon('share')}Share PDF</button></div>`);
  sh.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const to = $('#em_to').value.trim(), sub = $('#em_sub').value, msg = $('#em_body').value;
    if (to) { d.email = to; const c = S.getCustomer(d.customerId); if (c && !c.email) c.email = to; }
    d.sentAt = Date.now(); S.save();
    if (b.dataset.x === 'mailto') {
      location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(sub)}&body=${encodeURIComponent(msg)}`;
      closeSheet();
    } else {
      closeSheet(); toast('Creating PDF…', 60000);
      try { const r = await sharePDF(d, msg); toast(r === 'shared' ? 'Shared' : r === 'downloaded' ? 'PDF downloaded — attach it to your email' : 'Cancelled'); }
      catch (err) { toast(err.message); }
    }
    if (location.hash === `#/doc/${d.id}`) docView(d.id);
  };
}

function paymentSheet(d, t, done) {
  const p = d.payment || {};
  const amt = d.payment ? t.paid : t.total;
  const sh = openSheet(`<h3>Payment</h3>
    <p class="muted" style="margin-top:-6px">Total ${money(t.total, d.currency)}</p>
    <div class="stack">
      <div class="grid2">
        <label class="field"><span>Amount paid</span><input id="p_amt" inputmode="decimal" value="${amt}"></label>
        <label class="field"><span>Date paid</span><input id="p_date" type="date" value="${esc(p.date || S.today())}"></label>
      </div>
      <label class="field"><span>Method</span><select id="p_method">${methodOptions(p.method || 'Bank transfer')}</select></label>
    </div>
    <div class="sheet-actions">${d.payment ? '<button class="btn danger" data-x="unpaid">Mark unpaid</button>' : ''}<button class="btn primary" data-x="save">Save payment</button></div>`);
  sh.onclick = e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'unpaid') d.payment = null;
    else {
      const a = num($('#p_amt').value);
      d.payment = { amount: a >= t.total ? null : a, date: $('#p_date').value, method: $('#p_method').value };
    }
    S.save(); closeSheet(); toast('Payment updated'); done();
  };
}

const PAY_METHODS = ['Bank transfer', 'Cash', 'Card', 'Cheque', 'Other'];
function methodOptions(sel) {
  // Keep any older free-text method so editing a payment doesn't lose it.
  const list = PAY_METHODS.includes(sel) ? PAY_METHODS : [sel, ...PAY_METHODS];
  return list.map(m => `<option ${m === sel ? 'selected' : ''}>${esc(m)}</option>`).join('');
}

function moreSheet(d) {
  const sh = openSheet(`<h3>${DOC_TYPES[d.type].label} ${esc(d.number)}</h3><div class="menu">
    <button data-x="recurring">${icon('repeat')}<span>Recurring schedule<div class="sub">Automatically create copies on a schedule</div></span></button>
    <button data-x="style">${icon('palette')}<span>Template &amp; colour</span></button>
    <button data-x="convert">${icon('swap')}<span>Convert to another type<div class="sub">e.g. turn a quote into an invoice</div></span></button>
    ${d.deletedAt ? `<button data-x="destroy" style="color:var(--danger)">${icon('trash')}<span>Delete forever</span></button>`
      : `<button data-x="trash" style="color:var(--danger)">${icon('trash')}<span>Move to Trash</span></button>`}
  </div>`);
  sh.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const x = b.dataset.x; closeSheet();
    if (x === 'recurring') recurringSheet(d);
    if (x === 'style') styleSheet(d, () => { S.save(); docView(d.id); });
    if (x === 'convert') pickDocType(type => {
      d.type = type; d.number = S.nextNumber(type);
      if (DOC_TYPES[type].paidByDefault && !d.payment) d.payment = { amount: null, date: S.today(), method: 'Bank transfer' };
      S.save(); toast(`Converted to ${DOC_TYPES[type].label}`); docView(d.id);
    }, 'Convert to…');
    if (x === 'trash') { S.trashDoc(d.id); toast('Moved to Trash'); location.hash = '#/invoices'; }
    if (x === 'destroy' && await confirmSheet({ title: 'Delete forever?', body: 'This document will be permanently deleted. This can’t be undone.', ok: 'Delete', danger: true })) {
      S.destroyDoc(d.id); toast('Deleted'); location.hash = '#/invoices';
    }
  };
}

function recurringSheet(d) {
  const r = d.recurring || {};
  const sh = openSheet(`<h3>Recurring ${DOC_TYPES[d.type].label.toLowerCase()}</h3>
    <p class="small muted" style="margin-top:-6px">A copy with a new number and date is created each period, the next time you open the app on or after that date. It isn’t emailed automatically.</p>
    <div class="stack">
      <label class="field"><span>Frequency</span><select id="r_freq"><option value="">Never (disable)</option>${Object.entries(FREQ_LABELS).map(([k, v]) => `<option value="${k}" ${r.freq === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="grid2">
        <label class="field"><span>Next copy on</span><input id="r_next" type="date" value="${esc(r.next || S.addDays(d.date, 30))}"></label>
        <label class="field"><span>Stop after (optional)</span><input id="r_stop" type="date" value="${esc(r.stop || '')}"></label>
      </div>
    </div>
    <div class="sheet-actions"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="save">Save</button></div>`);
  sh.onclick = e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'save') {
      const freq = $('#r_freq').value, next = $('#r_next').value, stop = $('#r_stop').value;
      if (freq && next < S.today()) { toast('The next date can’t be in the past'); return; }
      d.recurring = freq ? { freq, next, stop: stop || '' } : null;
      S.save(); toast(freq ? 'Recurring schedule saved' : 'Recurring disabled');
    }
    closeSheet(); docView(d.id);
  };
}

function styleSheet(target, done) {
  const sh = openSheet(`<h3>Template &amp; colour</h3>
    <div class="templates">${TEMPLATES.map(tp => `<div class="tpl ${target.template === tp.id ? 'active' : ''}" data-tpl="${tp.id}"><div class="mini"></div>${tp.name}</div>`).join('')}</div>
    <div class="section-title" style="margin-top:16px">Colour</div>
    <div class="swatches">${COLORS.map(c => `<button class="swatch ${target.color === c ? 'active' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
      <label class="swatch" style="background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red);position:relative" aria-label="Custom colour"><input type="color" id="customColor" value="${esc(target.color)}" style="opacity:0;position:absolute;inset:0;width:100%;height:100%"></label></div>
    <div class="sheet-actions"><button class="btn primary" data-x="done">Done</button></div>`, done);
  const drawMinis = () => $$('.tpl', sh).forEach(el => {
    const mini = $('.mini', el);
    const sample = { ...sampleDoc(), template: el.dataset.tpl, color: target.color };
    mini.innerHTML = paperHTML(sample);
    const p = $('.paper', mini); p.style.transform = `scale(${mini.clientWidth / p.offsetWidth})`;
  });
  drawMinis();
  sh.onclick = e => {
    const tp = e.target.closest('[data-tpl]'), co = e.target.closest('[data-color]');
    if (tp) { target.template = tp.dataset.tpl; $$('.tpl', sh).forEach(x => x.classList.toggle('active', x === tp)); }
    if (co) { target.color = co.dataset.color; $$('.swatch', sh).forEach(x => x.classList.toggle('active', x === co)); drawMinis(); }
    if (e.target.closest('[data-x="done"]')) closeSheet();
  };
  $('#customColor', sh).oninput = e => { target.color = e.target.value; $$('.swatch', sh).forEach(x => x.classList.remove('active')); drawMinis(); };
}
function sampleDoc() {
  const d = S.newDoc('invoice');
  d.billTo = 'Customer Name\n1 Example Street'; d.items = [{ desc: 'Service', qty: 2, price: 50, taxes: [] }, { desc: 'Product', qty: 1, price: 20, taxes: [] }];
  return d;
}

// ------------------------------------------------------------------ editor
let pendingDraft = null;
function editView(id, newType, custId) {
  let d;
  if (id) { const src = S.getDoc(id); if (!src) { location.hash = '#/invoices'; return; } d = structuredClone(src); }
  else if (pendingDraft && pendingDraft.type === newType) { d = pendingDraft; pendingDraft = null; }
  else {
    if (!DOC_TYPES[newType]) { location.hash = '#/invoices'; return; }
    d = S.newDoc(newType);
    const c = custId && S.getCustomer(custId);
    if (c) Object.assign(d, { customerId: c.id, billTo: c.billTo, shipTo: c.shipTo || '', email: c.email || '' });
  }
  const isNew = !!d.isNew;
  let dirty = false;
  const s = S.settings();

  const titleFor = () => `${isNew ? 'New' : 'Edit'} ${DOC_TYPES[d.type].label}`;
  setChrome({ title: titleFor(), back: true, nav: false });
  leaveGuard = async () => !dirty || await confirmSheet({ title: 'Discard changes?', body: 'Your changes to this document haven’t been saved.', ok: 'Discard', danger: true });

  let moreOpen = !!(d.po || d.shipTo || num(d.discount) || num(d.shipping));
  const draw = () => {
    const type = DOC_TYPES[d.type], easy = simple();
    const prev = $('.more-opts'); if (prev) moreOpen = prev.open;
    const shipHTML = `<label class="check"><input type="checkbox" data-act="toggleShip" ${d.shipTo ? 'checked' : ''}> <span>Add ${(type.shipToLabel || 'ship to').toLowerCase()} address</span></label>
      <label class="field ${d.shipTo ? '' : 'hidden'}" id="shipField"><span>${type.shipToLabel || 'Ship To'}</span><textarea data-f="shipTo" rows="3">${esc(d.shipTo)}</textarea></label>`;
    const poHTML = `<label class="field"><span>P.O. # (optional)</span><input data-f="po" value="${esc(d.po)}"></label>`;
    const dueHTML = `<label class="field"><span>${type.validUntil ? 'Valid until' : 'Due date'}</span><input data-f="dueDate" type="date" value="${esc(d.dueDate)}"></label>`;
    const discHTML = `<div class="grid2">
        <label class="field"><span>Discount %</span><input data-f="discount" inputmode="decimal" value="${d.discount || ''}" placeholder="0"></label>
        <label class="field"><span>Shipping</span><input data-f="shipping" inputmode="decimal" value="${d.shipping || ''}" placeholder="0.00"></label>
      </div>`;
    view.innerHTML = `
    <div class="card section stack">
      <div class="row"><button class="doc-type-btn" data-act="type">${type.label}${icon('down')}</button><div class="grow"></div>
        <button class="btn ghost" data-act="style">${icon('palette')}Style</button></div>
      <div class="grid2">
        <label class="field"><span>${type.numLabel}</span><input data-f="number" value="${esc(d.number)}"></label>
        <label class="field"><span>${type.dateLabel}</span><input data-f="date" type="date" value="${esc(d.date)}"></label>
      </div>
      ${easy ? dueHTML : `<div class="grid2">${dueHTML}${poHTML}</div>`}
    </div>

    <div class="card section stack">
      <h2>From</h2>
      <label class="field"><textarea data-f="from" rows="3" placeholder="Your company or name&#10;Address">${esc(d.from)}</textarea></label>
      ${!s.business.name ? `<p class="small muted" style="margin:6px 0 0">Tip: fill in your business details in <a href="#/settings">Settings</a> to pre-fill this on every document.</p>` : ''}
    </div>

    <div class="card section stack">
      <div class="row"><h2 class="grow" style="margin:0">${type.billToLabel || 'Bill To'}</h2>
        ${S.db().customers.length ? `<button class="btn ghost" data-act="pickCustomer">${icon('user')}Choose</button>` : ''}</div>
      <label class="field"><textarea data-f="billTo" rows="3" placeholder="Student or parent name&#10;Billing address">${esc(d.billTo)}</textarea></label>
      <label class="field"><span>Email (optional)</span><input data-f="email" type="email" value="${esc(d.email)}"></label>
      ${easy ? '' : shipHTML}
    </div>

    <div class="card section">
      <h2>Items</h2>
      <div id="items">${d.items.map((it, i) => itemRow(it, i, type)).join('')}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn grow" data-act="addItem">${icon('plus')}Add item</button>
        ${S.db().items.length ? `<button class="btn grow" data-act="addSaved">${icon('box')}Saved items</button>` : ''}
      </div>
    </div>

    ${type.noPrices ? '' : `<div class="card section">
      ${easy ? '' : discHTML}
      <div class="totals-box" id="totals"></div>
    </div>`}

    ${easy ? `<details class="card section more-opts" ${moreOpen ? 'open' : ''}><summary>More options</summary>
      <div class="stack" style="margin-top:12px">${poHTML}${shipHTML}${type.noPrices ? '' : discHTML}</div></details>` : ''}

    <div class="card section stack">
      <h2>Notes</h2>
      <label class="field"><span>Terms &amp; conditions</span><textarea data-f="terms" rows="3" placeholder="e.g. Payment due within 14 days">${esc(d.terms)}</textarea></label>
      <label class="field"><span>Footer</span><input data-f="footer" value="${esc(d.footer)}"></label>
      <label class="check"><input type="checkbox" data-f="showSignature" ${d.showSignature ? 'checked' : ''} ${s.signature ? '' : 'disabled'}> <span>Show my signature${s.signature ? '' : '<br><span class="small muted">Add one in Settings</span>'}</span></label>
      <label class="field"><span>Currency</span><select data-f="currency">${currencyOptions(d.currency)}</select></label>
    </div>

    <div class="sticky-actions">
      <button class="btn" data-act="preview">Preview</button>
      <button class="btn primary" data-act="save">${icon('check')}Save</button>
    </div>`;
    drawTotals();
  };

  const drawTotals = () => {
    const el = $('#totals'); if (!el) return;
    const t = totals(d), m = v => money(v, d.currency);
    el.innerHTML = `<div class="t-row"><span>Subtotal</span><span>${m(t.subtotal)}</span></div>
      ${t.discount ? `<div class="t-row"><span>Discount (${t.discPct}%)</span><span>−${m(t.discount)}</span></div>` : ''}
      ${t.taxLines.map(x => `<div class="t-row"><span>${esc(x.name)} (${x.rate}%)</span><span>${m(x.amount)}</span></div>`).join('')}
      ${t.shipping ? `<div class="t-row"><span>Shipping</span><span>${m(t.shipping)}</span></div>` : ''}
      <div class="t-row grand"><span>Total</span><span>${m(t.total)}</span></div>`;
    $$('[data-line]').forEach(n => { const it = d.items[+n.dataset.line]; if (it) n.textContent = m(num(it.qty) * num(it.price)); });
  };

  const itemAt = el => d.items[+el.closest('[data-i]').dataset.i];
  view.oninput = view.onchange = e => {
    const el = e.target;
    if (el.dataset.f) {
      d[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; dirty = true;
      if (el.dataset.f === 'currency') drawTotals();
      if (['discount', 'shipping'].includes(el.dataset.f)) drawTotals();
    } else if (el.dataset.if) {
      itemAt(el)[el.dataset.if] = el.value; dirty = true; drawTotals();
    }
  };
  view.onclick = async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'toggleShip') { const on = b.checked; $('#shipField').classList.toggle('hidden', !on); if (!on) { d.shipTo = ''; $('[data-f=shipTo]').value = ''; } return; }
    if (a === 'type') pickDocType(type => {
      if (type === d.type) return;
      const auto = d.number === S.nextNumber(d.type, true);
      d.type = type; if (isNew && auto) d.number = S.nextNumber(type, true);
      dirty = true; setChrome({ title: titleFor(), back: true, nav: false }); draw();
    }, 'Document type');
    if (a === 'style') styleSheet(d, () => { dirty = true; });
    if (a === 'pickCustomer') customerPicker(c => {
      Object.assign(d, { customerId: c.id, billTo: c.billTo, shipTo: c.shipTo || d.shipTo, email: c.email || d.email });
      dirty = true; draw();
    });
    if (a === 'addItem') { d.items.push({ id: S.uid(), desc: '', qty: 1, price: 0, taxes: [] }); dirty = true; draw(); $$('#items [data-if=desc]').pop()?.focus(); }
    if (a === 'addSaved') savedItemPicker(it => { d.items = d.items.filter(x => x.desc || num(x.price)); d.items.push({ id: S.uid(), desc: it.desc, qty: 1, price: it.price, taxes: structuredClone(it.taxes || []) }); dirty = true; draw(); });
    if (a === 'dupItem') {
      // Copy the line just below this one (same description, price, taxes and date), ready to change the date.
      const i = +b.closest('[data-i]').dataset.i;
      d.items.splice(i + 1, 0, { ...structuredClone(d.items[i]), id: S.uid() });
      dirty = true; draw();
      const next = $(`#items [data-i="${i + 1}"]`);
      next?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      next?.querySelector('[data-if=date]')?.focus();
    }
    if (a === 'delItem') { d.items.splice(+b.closest('[data-i]').dataset.i, 1); if (!d.items.length) d.items.push({ id: S.uid(), desc: '', qty: 1, price: 0, taxes: [] }); dirty = true; draw(); }
    if (a === 'taxes') { const it = itemAt(b); taxPicker(it, () => { dirty = true; draw(); }); }
    if (a === 'saveItem') {
      const it = itemAt(b); if (!it.desc.trim()) { toast('Add a description first'); return; }
      const ex = S.db().items.find(x => x.desc.trim().toLowerCase() === it.desc.trim().toLowerCase());
      S.saveItem({ id: ex?.id || S.uid(), desc: it.desc.trim(), price: num(it.price), taxes: structuredClone(it.taxes || []) });
      toast(ex ? 'Saved item updated' : 'Saved for reuse');
    }
    if (a === 'preview') {
      const sh = openSheet(`<div class="preview-wrap" id="pv">${paperHTML(d)}</div>`);
      sh.style.paddingTop = '8px'; fitPaper($('#pv', sh));
    }
    if (a === 'save') {
      if (!d.number.trim()) { toast('Please enter a document number'); return; }
      d.items = d.items.filter(x => x.desc.trim() || num(x.price));
      if (!d.items.length) { toast('Add at least one item'); d.items.push({ id: S.uid(), desc: '', qty: 1, price: 0, taxes: [] }); draw(); return; }
      d.items.forEach(x => { x.qty = num(x.qty); x.price = num(x.price); });
      d.discount = num(d.discount); d.shipping = num(d.shipping);
      S.saveDoc(d); dirty = false; leaveGuard = null;
      toast('Saved');
      location.replace(`#/doc/${d.id}`);
    }
  };
  draw();
}

function itemRow(it, i, type) {
  const taxes = it.taxes || [];
  return `<div class="item-row" data-i="${i}">
    <div class="row" style="align-items:flex-start;gap:4px">
      <label class="field grow"><textarea data-if="desc" rows="1" placeholder="Description" style="min-height:44px">${esc(it.desc)}</textarea></label>
      <button class="icon-btn" data-act="delItem" aria-label="Remove item" style="margin:0;flex:none">${icon('trash', 'style="width:20px;height:20px;color:var(--danger)"')}</button>
    </div>
    <div class="grid3">
      <label class="field"><span>Date (optional)</span><input data-if="date" type="date" value="${esc(it.date || '')}"></label>
      <label class="field"><span>Qty</span><input data-if="qty" inputmode="decimal" value="${it.qty}"></label>
      ${type.noPrices ? '' : `<label class="field"><span>Unit price</span><input data-if="price" inputmode="decimal" value="${it.price || ''}" placeholder="0.00"></label>`}
    </div>
    <div class="item-tools">
      ${type.noPrices ? '' : `<button class="tax-pill" data-act="taxes">${taxes.length ? taxes.map(t => `${esc(t.name)} ${t.rate}%`).join(' + ') : '+ Tax'}</button>`}
      <button class="tax-pill" data-act="dupItem">Duplicate</button>
      <button class="tax-pill" data-act="saveItem">Save item</button>
      <div class="grow"></div>
      ${type.noPrices ? '' : `<div class="line-total" data-line="${i}"></div>`}
    </div>
  </div>`;
}

function currencyOptions(sel) {
  const list = CURRENCIES.includes(sel) ? CURRENCIES : [sel, ...CURRENCIES];
  return list.map(c => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
}

function customerPicker(onPick) {
  const cs = [...S.db().customers].sort((a, b) => S.customerName(a).localeCompare(S.customerName(b)));
  const sh = openSheet(`<h3>Choose student</h3>
    <div class="search">${icon('search')}<input class="input" id="cq" type="search" placeholder="Search" autofocus></div>
    <div class="menu" id="clist"></div>`);
  const draw = q => $('#clist', sh).innerHTML = cs.filter(c => (c.billTo + c.email).toLowerCase().includes(q)).map(c =>
    `<button data-id="${c.id}"><span class="avatar">${initials(S.customerName(c))}</span><span><b>${esc(S.customerName(c))}</b><div class="sub">${esc(c.email || c.billTo.split('\n').slice(1).join(', '))}</div></span></button>`).join('') || '<p class="muted">No matches.</p>';
  draw('');
  $('#cq', sh).oninput = e => draw(e.target.value.toLowerCase());
  sh.onclick = e => { const b = e.target.closest('[data-id]'); if (b) { closeSheet(); onPick(S.getCustomer(b.dataset.id)); } };
}

function savedItemPicker(onPick) {
  const items = S.db().items.filter(i => !i.archived);
  const sh = openSheet(`<h3>Saved items</h3>
    <div class="search">${icon('search')}<input class="input" id="iq" type="search" placeholder="Search" autofocus></div>
    <div class="menu" id="ilist"></div>`);
  const draw = q => $('#ilist', sh).innerHTML = items.filter(i => i.desc.toLowerCase().includes(q)).map(i =>
    `<button data-id="${i.id}"><span class="grow"><b>${esc(i.desc.split('\n')[0])}</b><div class="sub">${money(i.price)}${(i.taxes || []).length ? ' + ' + i.taxes.map(t => esc(t.name)).join(', ') : ''}</div></span></button>`).join('') || '<p class="muted">No matches.</p>';
  draw('');
  $('#iq', sh).oninput = e => draw(e.target.value.toLowerCase());
  sh.onclick = e => { const b = e.target.closest('[data-id]'); if (b) { closeSheet(); onPick(S.db().items.find(i => i.id === b.dataset.id)); } };
}

// Select up to two taxes for one item (at most one compound).
function taxPicker(item, done) {
  const sel = new Map((item.taxes || []).map(t => [`${t.name}|${t.rate}|${!!t.compound}`, t]));
  const keyOf = t => `${t.name}|${t.rate}|${!!t.compound}`;
  const sh = openSheet('', done);
  const draw = () => {
    const known = [...S.db().taxes];
    for (const t of sel.values()) if (!known.some(k => keyOf(k) === keyOf(t))) known.push({ ...t, id: 'tmp' + keyOf(t) });
    sh.innerHTML = `<div class="grabber"></div><h3>Taxes for this item</h3>
      <p class="small muted" style="margin-top:-6px">Pick up to two. A negative rate subtracts from the total.</p>
      <div class="menu">${known.map(t => `<label class="check" style="border-bottom:1px solid var(--line)"><input type="checkbox" data-k="${esc(keyOf(t))}" ${sel.has(keyOf(t)) ? 'checked' : ''}>
        <span class="grow">${esc(t.name)} ${t.rate}%${t.compound ? ' <span class="badge unpaid">compound</span>' : ''}</span></label>`).join('') || '<p class="muted">No taxes yet. Add one below.</p>'}</div>
      <div class="section-title" style="margin-top:16px">New tax</div>
      <div class="grid2"><label class="field"><span>Name</span><input id="tx_name" placeholder="VAT"></label>
        <label class="field"><span>Rate %</span><input id="tx_rate" inputmode="decimal" placeholder="20"></label></div>
      <label class="check"><input type="checkbox" id="tx_comp"> Compound (calculated on top of the other tax)</label>
      <div class="sheet-actions"><button class="btn" data-x="add">${icon('plus')}Add tax</button><button class="btn primary" data-x="done">Done</button></div>`;
    sh.onchange = e => {
      const k = e.target.dataset.k; if (!k) return;
      if (e.target.checked) {
        const t = known.find(x => keyOf(x) === k);
        if (sel.size >= 2) { e.target.checked = false; toast('Up to two taxes per item'); return; }
        if (t.compound && [...sel.values()].some(x => x.compound)) { e.target.checked = false; toast('Only one compound tax per item'); return; }
        sel.set(k, { name: t.name, rate: num(t.rate), compound: !!t.compound });
      } else sel.delete(k);
      item.taxes = [...sel.values()];
    };
    sh.onclick = e => {
      const b = e.target.closest('[data-x]'); if (!b) return;
      if (b.dataset.x === 'done') { item.taxes = [...sel.values()]; closeSheet(); return; }
      const name = $('#tx_name').value.trim(), rate = num($('#tx_rate').value), compound = $('#tx_comp').checked;
      if (!name) { toast('Give the tax a name'); return; }
      const t = S.saveTax({ id: S.uid(), name, rate, compound });
      if (sel.size < 2 && !(compound && [...sel.values()].some(x => x.compound))) sel.set(keyOf(t), { name, rate, compound });
      item.taxes = [...sel.values()];
      draw();
    };
  };
  draw();
}

// ------------------------------------------------------------------ customers
const custFilter = { status: 'all', q: '' };
function customerStats(c) {
  const docs = live().filter(d => d.customerId === c.id);
  let billed = 0, balance = 0, overdue = 0;
  for (const d of docs) {
    const t = totals(d), st = status(d, t);
    if (!DOC_TYPES[d.type].payable) continue;
    billed += t.total; if (st !== 'paid') balance += t.balance; if (st === 'overdue') overdue += t.balance;
  }
  const st = overdue > 0 ? 'overdue' : balance > 0.004 ? 'unpaid' : 'paid';
  return { docs, billed, balance, overdue, st };
}
function studentSub(c, docs) {
  const next = nextLessonOf(c.id)[0];
  const parts = [num(c.rate) ? `${money(num(c.rate))}/h` : `${docs.length} invoice${docs.length === 1 ? '' : 's'}`];
  if (next) parts.push(`Next ${shortDay(next.date)}, ${next.start}`);
  return esc(parts.join(' · '));
}
function customersView() {
  setChrome({ title: 'Students', fab: () => editCustomerSheet() });
  view.innerHTML = `
    <div class="search">${icon('search')}<input class="input" id="q" type="search" placeholder="Search students" value="${esc(custFilter.q)}"></div>
    <div class="chips">${['all', 'unpaid', 'overdue', 'paid'].map(s => `<button class="chip ${custFilter.status === s ? 'active' : ''}" data-st="${s}">${{ all: 'All', unpaid: 'Owing', overdue: 'Overdue', paid: 'Paid up' }[s]}</button>`).join('')}</div>
    <div id="clist"></div>`;
  const draw = () => {
    const q = custFilter.q.toLowerCase();
    const rows = S.db().customers.map(c => ({ c, ...customerStats(c) }))
      .filter(r => (r.c.billTo + ' ' + r.c.email).toLowerCase().includes(q))
      .filter(r => custFilter.status === 'all' || r.st === custFilter.status || (custFilter.status === 'unpaid' && r.st === 'overdue'))
      .sort((a, b) => (b.balance > 0.004) - (a.balance > 0.004) || S.customerName(a.c).localeCompare(S.customerName(b.c))); // owing first
    $('#clist').innerHTML = rows.length ? `<div class="card list">${rows.map(r => `
      <a class="list-item" href="#/customer/${r.c.id}"><span class="avatar">${initials(S.customerName(r.c))}</span>
        <div class="main"><div class="title ellipsis">${esc(S.customerName(r.c))}</div><div class="sub">${studentSub(r.c, r.docs)}</div></div>
        <div class="amt">${r.balance > 0.004 ? money(r.balance) : ''}<br>${r.docs.length ? badge(r.st) : ''}</div></a>`).join('')}</div>`
      : empty('user', S.db().customers.length ? 'No students match.' : 'No students yet.<br>Tap + to add one.');
  };
  draw();
  view.oninput = e => { if (e.target.id === 'q') { custFilter.q = e.target.value; draw(); } };
  view.onclick = e => { const c = e.target.closest('[data-st]'); if (c) { custFilter.status = c.dataset.st; $$('[data-st]').forEach(x => x.classList.toggle('active', x === c)); draw(); } };
}

function customerView(id) {
  const c = S.getCustomer(id);
  if (!c) { location.hash = '#/customers'; return; }
  const st = customerStats(c);
  setChrome({ title: S.customerName(c), back: true, actions: `<button class="icon-btn" data-top="edit" aria-label="Edit customer">${icon('edit')}</button>`,
    fab: () => simple() ? location.hash = `#/new/invoice/${c.id}` : pickDocType(t => location.hash = `#/new/${t}/${c.id}`) });
  $('#topActions').onclick = () => editCustomerSheet(c);
  const docs = st.docs.sort((a, b) => b.date.localeCompare(a.date));
  view.innerHTML = `
    <div class="card section">
      <div style="white-space:pre-line">${esc(c.billTo)}</div>
      ${c.email ? `<div style="margin-top:6px"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ''}
      ${c.phone ? `<div><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></div>` : ''}
      ${c.notes ? `<p class="small muted">${esc(c.notes)}</p>` : ''}
    </div>
    ${lessonCard(c)}
    ${upcomingCard(c)}
    <div class="summary">
      <div class="card"><div class="label">Billed</div><div class="value">${money(st.billed)}</div></div>
      <div class="card"><div class="label">Balance</div><div class="value ${st.overdue ? 'bad' : ''}">${money(st.balance)}</div></div>
    </div>
    <div class="row" style="margin-bottom:12px"><button class="btn grow" data-act="statement">${icon('csv')}Statement (CSV)</button>
      <button class="btn grow" data-act="new">${icon('plus')}New ${simple() ? 'invoice' : 'document'}</button></div>
    ${docs.length ? `<div class="card list">${docs.map(d => { const t = totals(d); return `
      <a class="list-item" href="#/doc/${d.id}"><div class="main"><div class="title">${DOC_TYPES[d.type].label} ${esc(d.number)}</div><div class="sub">${fmtDate(d.date)}</div></div>
      <div class="amt">${money(t.total, d.currency)}<br>${badge(status(d, t))}</div></a>`; }).join('')}</div>` : empty('doc', 'No documents for this customer yet.')}`;
  view.onclick = e => {
    const b = e.target.closest('[data-act],[data-lesson]'); if (!b) return;
    if (b.dataset.act === 'new') { if (simple()) location.hash = `#/new/invoice/${c.id}`; else pickDocType(t => location.hash = `#/new/${t}/${c.id}`); }
    if (b.dataset.act === 'addLesson') lessonSheet(null, S.today(), () => customerView(c.id), c.id);
    if (b.dataset.lesson) lessonSheet(S.getLesson(b.dataset.lesson), null, () => customerView(c.id));
    if (b.dataset.act === 'billLessons') {
      const ds = S.db().lessons.filter(l => l.customerId === c.id && S.isBillable(l) && l.date <= S.today()).map(l => l.date).sort();
      generateSheet({ from: ds[0] || S.today(), to: S.today(), customerId: c.id });
    }
    if (b.dataset.act === 'editCust') editCustomerSheet(c);
    if (b.dataset.act === 'statement') {
      const rows = [['Document', 'Number', 'Date', 'Due date', 'Currency', 'Total', 'Paid', 'Balance', 'Status']];
      for (const d of [...docs].reverse()) { const t = totals(d); rows.push([DOC_TYPES[d.type].label, d.number, d.date, d.dueDate, d.currency, t.total, t.paid, t.balance, STATUS_LABEL[status(d, t)]]); }
      downloadBlob(new Blob(['﻿' + toCSV(rows)], { type: 'text/csv' }), `Statement - ${S.customerName(c)}.csv`);
    }
  };
}

function lessonCard(c) {
  const ls = S.db().lessons.filter(l => l.customerId === c.id);
  const open = ls.filter(l => S.isBillable(l) && l.date <= S.today()); // lessons that have happened
  const rate = num(c.rate);
  const owed = open.reduce((a, l) => a + (l.status === 'cancelled' ? 0 : S.lessonHours(l) * rate), 0);
  return `<div class="card list">
    <button class="list-item plain" data-act="editCust">
      <div class="main"><div class="title">Hourly rate</div><div class="sub">${esc(c.subject || 'Lesson')}</div></div>
      <div class="amt">${rate ? money(rate) + '/h' : '<span class="muted">Not set</span>'}</div></button>
    <button class="list-item plain" data-act="billLessons" ${open.length ? '' : 'disabled'}>
      <div class="main"><div class="title">Lessons not invoiced</div><div class="sub">Up to today</div></div>
      <div class="amt">${open.length ? `${open.length} · ${money(Math.round(owed * 100) / 100)}` : '<span class="muted">None</span>'}</div></button>
  </div>`;
}

function upcomingCard(c) {
  const next = nextLessonOf(c.id).slice(0, 4);
  return `<div class="row" style="margin:4px 0 8px"><div class="section-title grow" style="margin:0">Upcoming lessons</div>
      <button class="btn ghost" data-act="addLesson">${icon('plus')}Add</button></div>
    ${next.length ? `<div class="card list">${next.map(l => `<button class="list-item plain" data-lesson="${l.id}">
      <span class="lesson-bar" style="background:${studentColor(c.id)}"></span>
      <div class="main"><div class="title">${esc(shortDay(l.date))}</div><div class="sub">${esc(l.start)}–${esc(l.end)} · ${fmtHours(S.lessonHours(l))}${l.seriesId ? ' · weekly' : ''}</div></div>
      ${lessonBadge(l)}</button>`).join('')}</div>`
      : `<div class="card section muted small" style="text-align:center">No upcoming lessons.</div>`}`;
}

function editCustomerSheet(c) {
  const isNew = !c; c = c ? { ...c } : { id: S.uid(), billTo: '', shipTo: '', email: '', phone: '', notes: '', rate: '', subject: '' };
  const sh = openSheet(`<h3>${isNew ? 'New student' : 'Edit student'}</h3><div class="stack">
    <label class="field"><span>Name &amp; billing address</span><textarea id="c_bill" rows="3" placeholder="Student or parent name&#10;Address" autofocus>${esc(c.billTo)}</textarea></label>
    <label class="field"><span>Shipping address (optional)</span><textarea id="c_ship" rows="2">${esc(c.shipTo)}</textarea></label>
    <div class="grid2"><label class="field"><span>Email</span><input id="c_email" type="email" value="${esc(c.email)}"></label>
      <label class="field"><span>Phone</span><input id="c_phone" type="tel" value="${esc(c.phone)}"></label></div>
    <div class="grid2"><label class="field"><span>Hourly rate</span><input id="c_rate" inputmode="decimal" placeholder="0.00" value="${c.rate ? esc(c.rate) : ''}"></label>
      <label class="field"><span>Lesson name</span><input id="c_subject" placeholder="e.g. Maths lesson" value="${esc(c.subject || '')}"></label></div>
    <label class="field"><span>Notes</span><input id="c_notes" value="${esc(c.notes)}"></label></div>
    <div class="sheet-actions">${isNew ? '' : '<button class="btn danger" data-x="del">Delete</button>'}<button class="btn primary" data-x="save">Save</button></div>`);
  sh.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'del') {
      closeSheet();
      if (await confirmSheet({ title: 'Delete student?', body: 'Their invoices are kept, but no longer linked to this student. Their lessons are deleted.', ok: 'Delete', danger: true })) { S.deleteCustomer(c.id); location.hash = '#/customers'; }
      return;
    }
    c.billTo = $('#c_bill').value.trim(); c.shipTo = $('#c_ship').value.trim(); c.email = $('#c_email').value.trim(); c.phone = $('#c_phone').value.trim(); c.notes = $('#c_notes').value.trim();
    c.rate = num($('#c_rate').value) || ''; c.subject = $('#c_subject').value.trim();
    if (!c.billTo) { toast('Enter a name'); return; }
    S.saveCustomer(c); closeSheet(); toast('Student saved');
    if (isNew) location.hash = `#/customer/${c.id}`; else customerView(c.id);
  };
}

// ------------------------------------------------------------------ saved items & taxes
function itemsView() {
  setChrome({ title: 'Items & Taxes', fab: () => editItemSheet() });
  const items = [...S.db().items].sort((a, b) => a.desc.localeCompare(b.desc));
  const taxes = S.db().taxes;
  view.innerHTML = `
    <div class="section-title">Saved items</div>
    ${items.length ? `<div class="card list" style="margin-bottom:18px">${items.map(i => `
      <div class="list-item" data-item="${i.id}"><div class="main"><div class="title ellipsis">${esc(i.desc.split('\n')[0])}</div>
      <div class="sub">${(i.taxes || []).map(t => `${esc(t.name)} ${t.rate}%`).join(' + ') || 'No tax'}</div></div><div class="amt">${money(i.price)}</div></div>`).join('')}</div>`
      : `<div class="card" style="margin-bottom:18px">${empty('box', 'No saved items.<br>Tap + or use “Save item” while editing a document.')}</div>`}
    <div class="row"><div class="section-title grow" style="margin:0">Taxes</div><button class="btn ghost" data-act="newTax">${icon('plus')}Add tax</button></div>
    ${taxes.length ? `<div class="card list">${taxes.map(t => `<div class="list-item" data-tax="${t.id}"><div class="main"><div class="title">${esc(t.name)}</div>
      <div class="sub">${t.compound ? 'Compound' : 'Standard'}</div></div><div class="amt">${t.rate}%</div></div>`).join('')}</div>`
      : `<p class="muted small">No taxes yet.</p>`}`;
  view.onclick = e => {
    const it = e.target.closest('[data-item]'), tx = e.target.closest('[data-tax]');
    if (it) editItemSheet(S.db().items.find(x => x.id === it.dataset.item));
    if (tx) editTaxSheet(S.db().taxes.find(x => x.id === tx.dataset.tax));
    if (e.target.closest('[data-act=newTax]')) editTaxSheet();
  };
}
function editItemSheet(it) {
  const isNew = !it; it = it ? structuredClone(it) : { id: S.uid(), desc: '', price: 0, taxes: [] };
  const sh = openSheet(`<h3>${isNew ? 'New item' : 'Edit item'}</h3><div class="stack">
    <label class="field"><span>Description</span><textarea id="i_desc" rows="2" autofocus>${esc(it.desc)}</textarea></label>
    <label class="field"><span>Unit price</span><input id="i_price" inputmode="decimal" value="${it.price || ''}"></label>
    <button class="tax-pill" data-x="tax" id="i_tax">${it.taxes.length ? it.taxes.map(t => `${esc(t.name)} ${t.rate}%`).join(' + ') : '+ Tax'}</button></div>
    <div class="sheet-actions">${isNew ? '' : '<button class="btn danger" data-x="del">Delete</button>'}<button class="btn primary" data-x="save">Save</button></div>`);
  sh.onclick = e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    it.desc = $('#i_desc').value.trim(); it.price = num($('#i_price').value);
    if (b.dataset.x === 'tax') { taxPicker(it, () => editItemSheet(isNew ? { ...it, _new: 1 } : it)); return; }
    if (b.dataset.x === 'del') { S.deleteItem(it.id); closeSheet(); itemsView(); return; }
    if (!it.desc) { toast('Enter a description'); return; }
    delete it._new; S.saveItem(it); closeSheet(); toast('Item saved'); itemsView();
  };
}
function editTaxSheet(t) {
  const isNew = !t; t = t ? { ...t } : { id: S.uid(), name: '', rate: '', compound: false };
  const sh = openSheet(`<h3>${isNew ? 'New tax' : 'Edit tax'}</h3><div class="stack">
    <div class="grid2"><label class="field"><span>Name</span><input id="t_name" value="${esc(t.name)}" autofocus></label>
    <label class="field"><span>Rate %</span><input id="t_rate" inputmode="decimal" value="${t.rate}"></label></div>
    <label class="check"><input type="checkbox" id="t_comp" ${t.compound ? 'checked' : ''}> Compound tax</label>
    <p class="small muted">Changing a tax here doesn’t alter documents you’ve already saved.</p></div>
    <div class="sheet-actions">${isNew ? '' : '<button class="btn danger" data-x="del">Delete</button>'}<button class="btn primary" data-x="save">Save</button></div>`);
  sh.onclick = e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'del') { S.deleteTax(t.id); closeSheet(); itemsView(); return; }
    t.name = $('#t_name').value.trim(); t.rate = num($('#t_rate').value); t.compound = $('#t_comp').checked;
    if (!t.name) { toast('Enter a name'); return; }
    S.saveTax(t); closeSheet(); itemsView();
  };
}

// ------------------------------------------------------------------ reports
const rep = { period: 'this_month', type: 'all', status: 'all', from: '', to: '' };
function periodRange(p) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), q = Math.floor(m / 3) * 3;
  const r = (a, b) => [S.iso(a), S.iso(b)];
  return {
    this_month: r(new Date(y, m, 1), new Date(y, m + 1, 0)),
    last_month: r(new Date(y, m - 1, 1), new Date(y, m, 0)),
    this_quarter: r(new Date(y, q, 1), new Date(y, q + 3, 0)),
    last_quarter: r(new Date(y, q - 3, 1), new Date(y, q, 0)),
    this_year: r(new Date(y, 0, 1), new Date(y, 11, 31)),
    last_year: r(new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)),
    all: ['', ''], custom: [rep.from, rep.to],
  }[p];
}
function reportsView() {
  setChrome({ title: 'Reports', back: true });
  const P = { this_month: 'This month', last_month: 'Last month', this_quarter: 'This quarter', last_quarter: 'Last quarter', this_year: 'This year', last_year: 'Last year', all: 'All time', custom: 'Custom' };
  view.innerHTML = `
    <div class="chips">${Object.entries(P).map(([k, v]) => `<button class="chip ${rep.period === k ? 'active' : ''}" data-p="${k}">${v}</button>`).join('')}</div>
    <div class="card section stack">
      <div class="grid2 ${rep.period === 'custom' ? '' : 'hidden'}" id="custom">
        <label class="field"><span>From</span><input type="date" id="r_from" value="${rep.from}"></label>
        <label class="field"><span>To</span><input type="date" id="r_to" value="${rep.to}"></label></div>
      <div class="grid2">
        <label class="field"><span>Document</span><select id="r_type"><option value="all">All types</option>${Object.entries(DOC_TYPES).map(([k, t]) => `<option value="${k}" ${rep.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
        <label class="field"><span>Status</span><select id="r_status">${['all', 'paid', 'partial', 'unpaid', 'overdue'].map(s => `<option value="${s}" ${rep.status === s ? 'selected' : ''}>${s === 'all' ? 'All' : STATUS_LABEL[s]}</option>`).join('')}</select></label>
      </div>
    </div>
    <div id="rout"></div>`;
  let rows = [];
  const draw = () => {
    const [from, to] = periodRange(rep.period);
    rows = live().filter(d => (!from || d.date >= from) && (!to || d.date <= to) && (rep.type === 'all' || d.type === rep.type))
      .map(d => { const t = totals(d); return { d, t, st: status(d, t) }; })
      .filter(r => rep.status === 'all' || r.st === rep.status)
      .sort((a, b) => a.d.date.localeCompare(b.d.date));
    const byCur = {};
    for (const r of rows) {
      const c = byCur[r.d.currency] ||= { total: 0, tax: 0, paid: 0, balance: 0, sub: 0 };
      c.sub += r.t.subtotal - r.t.discount; c.tax += r.t.tax; c.total += r.t.total; c.paid += r.t.paid; if (r.st !== 'paid' && r.st !== 'none') c.balance += r.t.balance;
    }
    $('#rout').innerHTML = `${Object.entries(byCur).map(([cur, c]) => `<div class="summary">
        <div class="card"><div class="label">Total ${Object.keys(byCur).length > 1 ? cur : ''}</div><div class="value">${money(c.total, cur)}</div></div>
        <div class="card"><div class="label">Tax</div><div class="value">${money(c.tax, cur)}</div></div>
        <div class="card"><div class="label">Paid</div><div class="value good">${money(c.paid, cur)}</div></div>
        <div class="card"><div class="label">Outstanding</div><div class="value ${c.balance ? 'bad' : ''}">${money(c.balance, cur)}</div></div></div>`).join('')}
      <div class="row" style="margin-bottom:12px"><button class="btn grow" data-act="csv" ${rows.length ? '' : 'disabled'}>${icon('csv')}Export CSV</button>
        <button class="btn grow" data-act="print" ${rows.length ? '' : 'disabled'}>${icon('print')}Print</button></div>
      ${rows.length ? `<div class="card list">${rows.slice().reverse().map(({ d, t, st }) => `<a class="list-item" href="#/doc/${d.id}">
        <div class="main"><div class="title ellipsis">${esc(customerLabel(d))}</div><div class="sub">${DOC_TYPES[d.type].label} ${esc(d.number)} · ${fmtDate(d.date)}</div></div>
        <div class="amt">${money(t.total, d.currency)}<br>${badge(st)}</div></a>`).join('')}</div>` : empty('doc', 'No documents in this period.')}`;
  };
  draw();
  view.onclick = e => {
    const p = e.target.closest('[data-p]');
    if (p) { rep.period = p.dataset.p; $$('[data-p]').forEach(x => x.classList.toggle('active', x === p)); $('#custom').classList.toggle('hidden', rep.period !== 'custom'); draw(); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    const head = ['Document', 'Number', 'Customer', 'Date', 'Due date', 'Currency', 'Subtotal', 'Discount', 'Tax', 'Shipping', 'Total', 'Paid', 'Paid date', 'Balance', 'Status'];
    const line = ({ d, t, st }) => [DOC_TYPES[d.type].label, d.number, customerLabel(d), d.date, d.dueDate, d.currency, t.subtotal, t.discount, t.tax, t.shipping, t.total, t.paid, d.payment?.date || '', t.balance, STATUS_LABEL[st]];
    if (a === 'csv') downloadBlob(new Blob(['﻿' + toCSV([head, ...rows.map(line)])], { type: 'text/csv' }), `Report ${periodRange(rep.period).filter(Boolean).join(' to ') || 'all'}.csv`);
    if (a === 'print') {
      const root = $('#printRoot');
      root.innerHTML = `<div style="padding:32px;font:12px Arial,sans-serif;color:#111"><h2 style="margin:0 0 12px">Report ${periodRange(rep.period).filter(Boolean).map(fmtDate).join(' – ')}</h2>
        <table style="width:100%;border-collapse:collapse">${[head.filter((_, i) => ![5, 7, 9, 12].includes(i)), ...rows.map(r => line(r).map((v, i) => typeof v === 'number' ? money(v, r.d.currency) : i === 3 || i === 4 ? fmtDate(v) : v).filter((_, i) => ![5, 7, 9, 12].includes(i)))]
          .map((r, i) => `<tr>${r.map(v => `<${i ? 'td' : 'th'} style="border-bottom:1px solid #ccc;padding:4px 6px;text-align:left">${esc(v)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></div>`;
      const done = () => { root.innerHTML = ''; window.removeEventListener('afterprint', done); };
      window.addEventListener('afterprint', done); setTimeout(() => window.print(), 50);
    }
  };
  view.onchange = e => {
    if (e.target.id === 'r_type') rep.type = e.target.value;
    if (e.target.id === 'r_status') rep.status = e.target.value;
    if (e.target.id === 'r_from') rep.from = e.target.value;
    if (e.target.id === 'r_to') rep.to = e.target.value;
    draw();
  };
}

// ------------------------------------------------------------------ today (lessons calendar)
const STUDENT_COLORS = ['#007aff', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#30b0c7', '#ffcc00', '#5856d6', '#a2845e', '#ff3b30'];
// Each student gets the next colour in the order they were added, so the first ten never clash.
const studentColor = id => { const i = S.db().customers.findIndex(c => c.id === id); return i < 0 ? '#8e8e93' : STUDENT_COLORS[i % STUDENT_COLORS.length]; };
const r2 = n => Math.round(n * 100) / 100;
const fmtHours = h => `${r2(h)} h`;
const monthOf = date => date.slice(0, 7);
const monthStart = ym => `${ym}-01`;
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return S.iso(new Date(y, m, 0)); };
const shiftMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); return S.iso(new Date(y, m - 1 + n, 1)).slice(0, 7); };
const weekStart = d => { const dt = new Date(d + 'T00:00:00'); return S.addDays(d, -((dt.getDay() + 6) % 7)); }; // weeks start on Monday
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
const shortDay = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const lessonAmount = l => { const c = S.getCustomer(l.customerId); return l.status === 'cancelled' ? 0 : r2(S.lessonHours(l) * num(c?.rate)); };
const studentName = id => { const c = S.getCustomer(id); return c ? S.customerName(c) : 'Unknown student'; };
const nextLessonOf = cid => S.db().lessons.filter(l => l.customerId === cid && l.status !== 'cancelled' && l.date >= S.today())
  .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
const lessonBadge = l => {
  if (S.lessonInvoice(l)) return `<span class="badge paid">Invoiced</span>`;
  if (l.status === 'cancelled') return `<span class="badge unpaid">Cancelled</span>`;
  if (l.status === 'charged') return `<span class="badge partial">Late cancel</span>`;
  return `<span class="badge draft">To bill</span>`;
};
// A lesson row; unbilled lessons get swipe actions (cancel / late cancel, or restore).
const lessonRow = l => {
  const acts = S.lessonInvoice(l) ? '' : l.status === 'lesson'
    ? `<button data-swipe="charged" class="warn">Late<br>cancel</button><button data-swipe="cancelled" class="bad">Cancel</button>`
    : `<button data-swipe="lesson" class="ok">Restore</button>`;
  const row = `<div class="list-item ${acts ? 'swipe-row' : ''}" data-lesson="${l.id}">
      <span class="lesson-bar" style="background:${studentColor(l.customerId)}"></span>
      <div class="main"><div class="title ellipsis">${esc(studentName(l.customerId))}</div>
        <div class="sub">${esc(l.start)}–${esc(l.end)} · ${fmtHours(S.lessonHours(l))}${l.seriesId ? ` · ${icon('repeat', 'style="width:13px;height:13px;vertical-align:-2px"')}` : ''}${l.note ? ` · ${esc(l.note)}` : ''}</div></div>
      <div class="amt">${l.status === 'cancelled' ? '' : money(lessonAmount(l))}<br>${lessonBadge(l)}</div>
    </div>`;
  return acts ? `<div class="swipe" data-id="${l.id}"><div class="swipe-acts">${acts}</div>${row}</div>` : row;
};

const cal = { sel: S.today(), mode: 'week' };
function lessonsView() {
  const draw = () => {
    const t = S.today(), sel = cal.sel, ym = monthOf(sel);
    let days;
    if (cal.mode === 'week') days = Array.from({ length: 7 }, (_, i) => S.addDays(weekStart(sel), i));
    else {
      const start = weekStart(monthStart(ym));
      days = Array.from({ length: 42 }, (_, i) => S.addDays(start, i));
      while (days.length > 35 && days.slice(-7).every(d => monthOf(d) !== ym)) days.splice(-7);
    }
    const shown = new Set(days), byDay = {};
    for (const l of S.db().lessons) if (shown.has(l.date)) (byDay[l.date] ||= []).push(l);
    const monthLessons = S.db().lessons.filter(l => monthOf(l.date) === ym);
    const billed = monthLessons.filter(l => l.status !== 'cancelled');
    const unbilled = monthLessons.filter(S.isBillable);
    const dayLessons = S.lessonsOn(sel);

    // Month-end nudge: lessons from earlier months that haven't been invoiced.
    const past = S.db().lessons.filter(l => l.date < monthStart(monthOf(t)) && S.isBillable(l));
    let banner = '';
    if (past.length) {
      const months = [...new Set(past.map(l => monthOf(l.date)))].sort();
      const mname = m => new Date(m + '-01T00:00:00').toLocaleDateString(undefined, { month: 'long' });
      const label = months.length === 1 ? mname(months[0]) : `${mname(months[0])} – ${mname(months[months.length - 1])}`;
      banner = `<div class="status-banner partial nudge"><div class="grow"><b>${esc(label)}</b><br>${past.length} lesson${past.length > 1 ? 's' : ''} not invoiced · ${money(past.reduce((a, l) => a + lessonAmount(l), 0))}</div>
        <button class="btn primary" data-act="genPast">Generate</button></div>`;
    }

    const title = new Date(sel + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const dow = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
    const dayTitle = sel === t ? 'Today' : sel === S.addDays(t, 1) ? 'Tomorrow' : sel === S.addDays(t, -1) ? 'Yesterday'
      : new Date(sel + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const swipeable = dayLessons.some(l => !S.lessonInvoice(l));
    view.innerHTML = `${banner}
      <div class="card cal ${cal.mode}" id="cal">
        <div class="cal-head">
          <div class="cal-title">${esc(title)}</div>
          ${sel !== t ? `<button class="btn ghost" data-cal="today">Today</button>` : ''}
          <button class="icon-btn" data-cal="-1" aria-label="Previous ${cal.mode}">${icon('left')}</button>
          <button class="icon-btn" data-cal="1" aria-label="Next ${cal.mode}">${icon('right')}</button>
        </div>
        <div class="cal-grid">
          ${dow.map(d => `<div class="cal-dow">${d}</div>`).join('')}
          ${days.map(d => {
            const ls = byDay[d] || [];
            return `<button class="cal-day ${cal.mode === 'month' && monthOf(d) !== ym ? 'out' : ''} ${d === t ? 'today' : ''} ${d === sel ? 'sel' : ''}" data-day="${d}" aria-label="${d}${ls.length ? `, ${ls.length} lesson${ls.length > 1 ? 's' : ''}` : ''}">
              <span>${+d.slice(8)}</span><i class="cal-dots">${ls.slice(0, 4).map(l => `<b style="background:${studentColor(l.customerId)};${l.status === 'cancelled' ? 'opacity:.35' : ''}"></b>`).join('')}</i></button>`;
          }).join('')}
        </div>
        <button class="cal-toggle" data-cal="mode">${cal.mode === 'week' ? 'Show month' : 'Show week'}${icon(cal.mode === 'week' ? 'down' : 'up')}</button>
      </div>

      <div class="section-title">${esc(dayTitle)}</div>
      ${dayLessons.length ? `<div class="card list" id="dayList">${dayLessons.map(lessonRow).join('')}</div>`
        : `<div class="card list"><button class="list-item add-lesson" data-act="add">${icon('plus')}<span>Add a lesson</span></button></div>`}
      ${swipeable ? `<p class="small muted hint">Swipe a lesson left to cancel it.</p>` : ''}

      <div class="section-title">${esc(new Date(sel + 'T00:00:00').toLocaleDateString(undefined, { month: 'long' }))}</div>
      <div class="summary">
        <div class="card"><div class="label">Lessons</div><div class="value">${billed.length}</div></div>
        <div class="card"><div class="label">Hours</div><div class="value">${r2(billed.reduce((a, l) => a + S.lessonHours(l), 0))}</div></div>
        <div class="card"><div class="label">Total</div><div class="value">${money(billed.reduce((a, l) => a + lessonAmount(l), 0))}</div></div>
        <div class="card"><div class="label">Not invoiced</div><div class="value ${unbilled.length ? 'bad' : ''}">${money(unbilled.reduce((a, l) => a + lessonAmount(l), 0))}</div></div>
      </div>
      <button class="btn block" data-act="generate">${icon('doc')}Generate invoices for ${esc(new Date(sel + 'T00:00:00').toLocaleDateString(undefined, { month: 'long' }))}</button>`;

    const dl = $('#dayList');
    if (dl) enableSwipe(dl, (id, act) => {
      const l = S.getLesson(id); if (!l) return;
      l.status = act; S.saveLesson(l);
      toast(act === 'cancelled' ? 'Cancelled, not charged' : act === 'charged' ? 'Late cancellation, will be charged' : 'Lesson restored');
      draw();
    });
  };
  setChrome({ title: 'Today', fab: () => lessonSheet(null, cal.sel, draw) });
  draw();

  const move = n => {
    if (cal.mode === 'week') cal.sel = S.addDays(cal.sel, 7 * n);
    else { const m = shiftMonth(monthOf(cal.sel), n); cal.sel = m === monthOf(S.today()) ? S.today() : monthStart(m); }
    draw();
  };
  view.onclick = e => {
    const c = e.target.closest('[data-cal]');
    if (c) {
      const v = c.dataset.cal;
      if (v === 'today') { cal.sel = S.today(); draw(); }
      else if (v === 'mode') { cal.mode = cal.mode === 'week' ? 'month' : 'week'; draw(); }
      else move(+v);
      return;
    }
    const d = e.target.closest('[data-day]');
    if (d) { cal.sel = d.dataset.day; draw(); return; }
    const l = e.target.closest('[data-lesson]');
    if (l) { lessonSheet(S.getLesson(l.dataset.lesson), null, draw); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'add') lessonSheet(null, cal.sel, draw);
    if (a === 'generate') generateSheet({ from: monthStart(monthOf(cal.sel)), to: monthEnd(monthOf(cal.sel)) });
    if (a === 'genPast') {
      const past = S.db().lessons.filter(x => x.date < monthStart(monthOf(S.today())) && S.isBillable(x)).map(x => x.date).sort();
      generateSheet({ from: past[0], to: monthEnd(shiftMonth(monthOf(S.today()), -1)) });
    }
  };
  // Swipe left/right on the calendar to change week or month.
  let x0 = null;
  view.ontouchstart = e => { x0 = e.target.closest('#cal') ? e.touches[0].clientX : null; };
  view.ontouchend = e => {
    if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 60) move(dx < 0 ? 1 : -1);
  };
}

function lessonSheet(l, date, onDone = () => {}, presetCustomer = null) {
  const customers = [...S.db().customers].sort((a, b) => S.customerName(a).localeCompare(S.customerName(b)));
  if (!customers.length) {
    toast('Add a student first'); editCustomerSheet(); return;
  }
  const isNew = !l;
  if (isNew) {
    const cid = presetCustomer || customers[0].id, last = S.lastLessonOf(cid);
    l = { id: S.uid(), customerId: cid, date, start: last?.start || '15:00', end: last?.end || '16:00', status: 'lesson', note: '', seriesId: null, invoiceId: null };
  } else l = { ...l };
  const inv = S.lessonInvoice(l);
  const sh = openSheet(`<h3>${isNew ? 'New lesson' : 'Edit lesson'}</h3><div class="stack">
    ${inv ? `<p class="small muted" style="margin:0">Billed on <a href="#/doc/${inv.id}">${esc(DOC_TYPES[inv.type].label)} ${esc(inv.number)}</a>. Changes here won’t update that invoice.</p>` : ''}
    <label class="field"><span>Student</span><select id="l_cust">${customers.map(c => `<option value="${c.id}" ${c.id === l.customerId ? 'selected' : ''}>${esc(S.customerName(c))}</option>`).join('')}</select></label>
    <label class="field"><span>Date</span><input id="l_date" type="date" value="${esc(l.date)}"></label>
    <div class="grid2"><label class="field"><span>Start</span><input id="l_start" type="time" value="${esc(l.start)}"></label>
      <label class="field"><span>End</span><input id="l_end" type="time" value="${esc(l.end)}"></label></div>
    <p class="small muted" id="l_sum" style="margin:0 0 0 4px"></p>
    <label class="field"><span>Status</span><select id="l_status">${Object.entries(S.LESSON_STATUS).map(([k, v]) => `<option value="${k}" ${l.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="field"><span>Note (optional)</span><input id="l_note" value="${esc(l.note)}" placeholder="e.g. Algebra revision"></label>
    ${!isNew && l.seriesId ? `<label class="check"><input type="checkbox" id="l_all"> <span>Apply to all following lessons<br><span class="small muted">Moves the student, time and weekday of later lessons in this weekly series</span></span></label>` : ''}
    ${isNew ? `<label class="check"><input type="checkbox" id="l_rep"> <span>Repeat every week</span></label>
      <label class="field hidden" id="l_untilF"><span>Until</span><input id="l_until" type="date" value="${S.addDays(date, 7 * 12)}"></label>` : ''}
  </div>
  <div class="sheet-actions">${isNew ? '' : '<button class="btn danger" data-x="del">Delete</button>'}<button class="btn primary" data-x="save">Save</button></div>`);

  const sum = () => {
    const tmp = { start: $('#l_start', sh).value, end: $('#l_end', sh).value };
    const h = S.lessonHours(tmp), c = S.getCustomer($('#l_cust', sh).value);
    $('#l_sum', sh).textContent = h <= 0 ? 'End time must be after the start time.'
      : num(c?.rate) ? `${fmtHours(h)} × ${money(num(c.rate))}/h = ${money(r2(h * num(c.rate)))}` : `${fmtHours(h)} · no hourly rate set for this student yet (edit them in Students)`;
  };
  sum();
  sh.oninput = sh.onchange = e => {
    if (e.target.id === 'l_cust' && isNew) { // reuse that student's usual lesson time
      const last = S.lastLessonOf(e.target.value);
      if (last) { $('#l_start', sh).value = last.start; $('#l_end', sh).value = last.end; }
    }
    if (e.target.id === 'l_start' && isNew) { // keep the same lesson length when the start moves
      const len = Math.max(30, S.lessonHours(l) * 60), [h, m] = e.target.value.split(':').map(Number), endM = h * 60 + m + len;
      if (!isNaN(endM) && endM < 24 * 60) $('#l_end', sh).value = `${String(Math.floor(endM / 60)).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`;
    }
    if (e.target.id === 'l_rep') $('#l_untilF', sh).classList.toggle('hidden', !e.target.checked);
    if (['l_start', 'l_end'].includes(e.target.id)) { l.start = $('#l_start', sh).value; l.end = $('#l_end', sh).value; }
    sum();
  };
  sh.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'del') {
      if (l.seriesId) {
        const m = openSheet(`<h3>Delete lesson</h3><div class="menu">
          <button data-y="one">${icon('trash')}<span>Delete this lesson only</span></button>
          <button data-y="all">${icon('repeat')}<span>Delete this and all following</span></button></div>
          <div class="sheet-actions"><button class="btn" data-y="no">Cancel</button></div>`);
        m.onclick = ev => {
          const y = ev.target.closest('[data-y]')?.dataset.y; if (!y) return;
          closeSheet(); if (y === 'no') return;
          if (y === 'one') S.deleteLesson(l.id); else S.deleteSeriesFrom(l);
          toast('Deleted'); onDone();
        };
        return;
      }
      closeSheet();
      if (await confirmSheet({ title: 'Delete lesson?', ok: 'Delete', danger: true })) { S.deleteLesson(l.id); toast('Deleted'); onDone(); }
      return;
    }
    const orig = isNew ? null : { ...S.getLesson(l.id) };
    Object.assign(l, {
      customerId: $('#l_cust', sh).value, date: $('#l_date', sh).value, start: $('#l_start', sh).value, end: $('#l_end', sh).value,
      status: $('#l_status', sh).value, note: $('#l_note', sh).value.trim(),
    });
    if (!l.date) { toast('Pick a date'); return; }
    if (S.lessonHours(l) <= 0) { toast('End time must be after the start time'); return; }
    if (isNew && $('#l_rep', sh).checked) {
      const until = $('#l_until', sh).value;
      if (!until || until < l.date) { toast('Pick an end date for the repeats'); return; }
      const n = S.addWeekly(l, until); closeSheet(); toast(`${n} weekly lessons added`);
    } else if (orig && $('#l_all', sh)?.checked) { // change the weekly slot from here on
      const shift = daysBetween(orig.date, l.date);
      const later = S.db().lessons.filter(x => x.seriesId === l.seriesId && x.id !== l.id && x.date > orig.date && !S.lessonInvoice(x));
      for (const x of later) Object.assign(x, { customerId: l.customerId, start: l.start, end: l.end, date: S.addDays(x.date, shift) });
      S.saveLesson(l); closeSheet(); toast(`This and ${later.length} following lesson${later.length === 1 ? '' : 's'} updated`);
    } else { S.saveLesson(l); closeSheet(); toast('Lesson saved'); }
    cal.sel = l.date;
    onDone();
  };
}

// Builds an invoice for one student with one line per lesson (date, time, hours × hourly rate).
function invoiceFromLessons(c, lessons) {
  const d = S.newDoc('invoice');
  Object.assign(d, { customerId: c.id, billTo: c.billTo, shipTo: c.shipTo || '', email: c.email || '' });
  const what = (c.subject || '').trim() || 'Lesson';
  d.items = [...lessons].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map(l => ({
    id: S.uid(), date: l.date, qty: r2(S.lessonHours(l)), price: num(c.rate), taxes: [],
    desc: `${what}, ${l.start}–${l.end}${l.status === 'charged' ? ' (late cancellation)' : ''}${l.note ? `\n${l.note}` : ''}`,
  }));
  d.lessonIds = lessons.map(l => l.id);
  return d;
}

function generateSheet({ from, to, customerId = null }) {
  const sh = openSheet(`<h3>Generate invoices</h3>
    <div class="grid2"><label class="field"><span>From</span><input type="date" id="g_from" value="${from}"></label>
      <label class="field"><span>To</span><input type="date" id="g_to" value="${to}"></label></div>
    <div id="g_list" style="margin-top:14px"></div>
    <div class="sheet-actions"><button class="btn" data-x="no">Cancel</button><button class="btn primary" data-x="go" id="g_go">Create</button></div>`);
  let groups = [];
  const draw = () => {
    const f = $('#g_from', sh).value, t = $('#g_to', sh).value;
    const ls = S.db().lessons.filter(l => S.isBillable(l) && l.date >= f && l.date <= t && (!customerId || l.customerId === customerId));
    const by = {}; for (const l of ls) (by[l.customerId] ||= []).push(l);
    groups = Object.entries(by).map(([cid, lessons]) => ({ c: S.getCustomer(cid), lessons })).filter(g => g.c)
      .sort((a, b) => S.customerName(a.c).localeCompare(S.customerName(b.c)));
    $('#g_list', sh).innerHTML = groups.length ? `<div class="menu">${groups.map((g, i) => {
      const h = g.lessons.reduce((a, l) => a + S.lessonHours(l), 0);
      return `<label class="check"><span><b>${esc(S.customerName(g.c))}</b><div class="small muted">${g.lessons.length} lesson${g.lessons.length > 1 ? 's' : ''} · ${fmtHours(h)} · ${num(g.c.rate) ? money(g.lessons.reduce((a, l) => a + lessonAmount(l), 0)) : 'no hourly rate set'}</div></span>
        <input type="checkbox" data-g="${i}" checked></label>`;
    }).join('')}</div>` : `<p class="muted" style="text-align:center">No lessons to invoice in this period.</p>`;
    count();
  };
  const count = () => {
    const n = $$('[data-g]:checked', sh).length;
    $('#g_go', sh).disabled = !n;
    $('#g_go', sh).textContent = n === 1 ? 'Create & review' : `Create ${n || ''} invoice${n === 1 ? '' : 's'}`;
  };
  draw();
  sh.oninput = sh.onchange = e => { if (e.target.type === 'date') draw(); else count(); };
  sh.onclick = e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'no') { closeSheet(); return; }
    const picked = $$('[data-g]:checked', sh).map(x => groups[+x.dataset.g]);
    if (!picked.length) return;
    closeSheet();
    if (picked.length === 1) { // open it in the editor to check before saving
      pendingDraft = invoiceFromLessons(picked[0].c, picked[0].lessons);
      location.hash = '#/new/invoice';
      return;
    }
    for (const g of picked) S.saveDoc(invoiceFromLessons(g.c, g.lessons));
    toast(`${picked.length} invoices created`);
    location.hash = '#/invoices';
  };
}

// ------------------------------------------------------------------ settings
function settingsView() {
  const s = S.settings(), b = s.business;
  setChrome({ title: 'Settings' });
  view.innerHTML = `
    <div class="card list"><a class="list-item" href="#/items"><span class="avatar" style="background:var(--primary)">${icon('box', 'style="width:22px;height:22px"')}</span>
      <div class="main"><div class="title">Saved items &amp; taxes</div></div></a>
      <a class="list-item" href="#/reports"><span class="avatar" style="background:var(--switch-on)">${icon('chart', 'style="width:22px;height:22px"')}</span>
      <div class="main"><div class="title">Reports</div></div></a></div>
    <div class="card section stack">
      <h2>Your business</h2>
      <label class="field"><span>Business or your name</span><input data-b="name" value="${esc(b.name)}"></label>
      <label class="field"><span>Address</span><textarea data-b="address" rows="3">${esc(b.address)}</textarea></label>
      <div class="grid2"><label class="field"><span>Phone</span><input data-b="phone" type="tel" value="${esc(b.phone)}"></label>
        <label class="field"><span>Email</span><input data-b="email" type="email" value="${esc(b.email)}"></label></div>
      <div class="grid2"><label class="field"><span>Website</span><input data-b="website" value="${esc(b.website)}"></label>
        <label class="field"><span>Tax / VAT ID</span><input data-b="taxId" value="${esc(b.taxId)}"></label></div>
      <p class="small muted" style="margin:0">Used for the “From” section of new documents.</p>
    </div>

    <div class="card section stack">
      <h2>Logo &amp; signature</h2>
      <div class="image-pick"><div class="thumb" style="${s.logo ? `background-image:url(${s.logo})` : ''}">${s.logo ? '' : 'No logo'}</div>
        <div class="row grow" style="flex-wrap:wrap"><button class="btn" data-act="logo">${s.logo ? 'Change' : 'Add'} logo</button>${s.logo ? '<button class="btn ghost" data-act="rmLogo">Remove</button>' : ''}</div></div>
      <div class="image-pick"><div class="thumb" style="${s.signature ? `background-image:url(${s.signature});background-color:#fff` : ''}">${s.signature ? '' : 'No signature'}</div>
        <div class="row grow" style="flex-wrap:wrap"><button class="btn" data-act="drawSig">Draw</button><button class="btn" data-act="uploadSig">Upload</button>${s.signature ? '<button class="btn ghost" data-act="rmSig">Remove</button>' : ''}</div></div>
      <label class="check"><input type="checkbox" data-s="showSignature" ${s.showSignature ? 'checked' : ''}> Show signature on new documents</label>
    </div>

    <div class="card section stack">
      <h2>Document defaults</h2>
      <label class="check"><input type="checkbox" data-s="simple" ${s.simple !== false ? 'checked' : ''}> <span>Simple mode<br><span class="small muted">+ starts an invoice straight away, and P.O., ship-to, discount and shipping move under “More options”.</span></span></label>
      <div class="grid2">
        <label class="field"><span>Currency</span><select data-s="currency">${currencyOptions(s.currency)}</select></label>
        <label class="field"><span>Payment due in (days)</span><input data-s="dueDays" inputmode="numeric" value="${s.dueDays}"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>Paper size</span><select data-s="paper"><option value="a4" ${s.paper === 'a4' ? 'selected' : ''}>A4</option><option value="letter" ${s.paper === 'letter' ? 'selected' : ''}>US Letter</option></select></label>
        <label class="field"><span>Number &amp; date format</span><select data-s="locale">${['en-ZA', 'en-US', 'en-GB', 'en-IN', 'en-AU', 'en-CA', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'pt-BR', 'nl-NL', 'ar-AE'].concat(navigator.language).filter((v, i, a) => a.indexOf(v) === i)
          .map(l => `<option value="${l}" ${s.locale === l ? 'selected' : ''}>${l} — ${new Intl.NumberFormat(l, { style: 'currency', currency: s.currency }).format(1234.5)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Default terms &amp; conditions</span><textarea data-s="terms" rows="3">${esc(s.terms)}</textarea></label>
      <label class="field"><span>Default footer</span><input data-s="footer" value="${esc(s.footer)}"></label>
      <button class="btn" data-act="style">${icon('palette')}Default template &amp; colour</button>
      <label class="check"><input type="checkbox" data-s="paidStamp" ${s.paidStamp ? 'checked' : ''}> Show “PAID” stamp on paid documents</label>
    </div>

    <div class="card section stack">
      <h2>Appearance</h2>
      <label class="field"><span>Theme</span><select data-s="theme"><option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>Match device</option><option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option></select></label>
    </div>

    <div class="card section stack">
      <h2>Your data</h2>
      <p class="small muted" style="margin:0">Everything is stored only in this browser on this device. Back up regularly, and use the backup file to move to another phone or browser.</p>
      <div class="row"><button class="btn grow" data-act="backup">Back up</button><button class="btn grow" data-act="restore">Restore</button></div>
      <button class="btn danger" data-act="reset">Erase all data</button>
    </div>
    <p class="small muted" style="text-align:center">Invoice Maker · works offline</p>`;

  const persist = () => { if (!S.save()) toast('Storage is full — try a smaller logo or signature'); };
  view.oninput = view.onchange = e => {
    const el = e.target;
    if (el.dataset.b) { b[el.dataset.b] = el.value; persist(); }
    if (el.dataset.s) {
      const k = el.dataset.s;
      s[k] = el.type === 'checkbox' ? el.checked : k === 'dueDays' ? Math.max(0, parseInt(el.value) || 0) : el.value;
      persist();
      if (k === 'theme') applyTheme();
      if ((k === 'currency' || k === 'locale') && e.type === 'change') { clearFormatCache(); settingsView(); }
    }
  };
  view.onclick = async e => {
    const a = e.target.closest('[data-act]')?.dataset.act; if (!a) return;
    try {
      if (a === 'logo') { const f = await pickFile('image/*'); if (f) { s.logo = await readImage(f, 600); persist(); settingsView(); } }
      if (a === 'rmLogo') { s.logo = ''; persist(); settingsView(); }
      if (a === 'uploadSig') { const f = await pickFile('image/*'); if (f) { s.signature = await readImage(f, 500); persist(); settingsView(); } }
      if (a === 'rmSig') { s.signature = ''; s.showSignature = false; persist(); settingsView(); }
      if (a === 'drawSig') signatureSheet(url => { s.signature = url; s.showSignature = true; persist(); settingsView(); });
      if (a === 'style') styleSheet(s, persist);
      if (a === 'backup') { downloadBlob(new Blob([S.exportJSON()], { type: 'application/json' }), `invoice-maker-backup-${S.today()}.json`); toast('Backup downloaded'); }
      if (a === 'restore') {
        const f = await pickFile('application/json,.json'); if (!f) return;
        if (!(await confirmSheet({ title: 'Restore backup?', body: 'This replaces all data in this browser with the backup.', ok: 'Restore', danger: true }))) return;
        S.importJSON(await f.text()); clearFormatCache(); applyTheme(); toast('Backup restored'); settingsView();
      }
      if (a === 'reset' && await confirmSheet({ title: 'Erase all data?', body: 'All invoices, students, lessons, items and settings in this browser will be deleted. This can’t be undone.', ok: 'Erase everything', danger: true })) {
        S.resetAll(); clearFormatCache(); applyTheme(); toast('All data erased'); settingsView();
      }
    } catch (err) { toast(err.message || 'Something went wrong'); }
  };
}

function signatureSheet(onSave) {
  const sh = openSheet(`<h3>Draw your signature</h3><canvas class="sig-pad" id="sig"></canvas>
    <div class="sheet-actions"><button class="btn" data-x="clear">Clear</button><button class="btn primary" data-x="save">Save</button></div>`);
  const cv = $('#sig', sh), ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr; ctx.scale(dpr, dpr);
  Object.assign(ctx, { lineWidth: 2.4, lineCap: 'round', lineJoin: 'round', strokeStyle: '#10204a' });
  let drawing = false, drawn = false, last;
  const pt = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.onpointerdown = e => { drawing = true; last = pt(e); cv.setPointerCapture(e.pointerId); };
  cv.onpointermove = e => { if (!drawing) return; const p = pt(e); ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke(); last = p; drawn = true; };
  cv.onpointerup = cv.onpointercancel = () => drawing = false;
  sh.onclick = e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'clear') { ctx.clearRect(0, 0, cv.width, cv.height); drawn = false; return; }
    if (!drawn) { toast('Draw your signature first'); return; }
    // Trim whitespace around the drawing.
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let x0 = cv.width, y0 = cv.height, x1 = 0, y1 = 0;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (img[(y * cv.width + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 8 * dpr, out = document.createElement('canvas');
    out.width = x1 - x0 + pad * 2; out.height = y1 - y0 + pad * 2;
    out.getContext('2d').drawImage(cv, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height);
    closeSheet(); onSave(out.toDataURL('image/png'));
  };
}

function applyTheme() {
  const t = S.settings().theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ------------------------------------------------------------------ boot
applyTheme();
S.purgeTrash();
const made = S.runRecurring();
route();
if (made.length) setTimeout(() => toast(`${made.length} recurring document${made.length > 1 ? 's' : ''} created`), 400);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
