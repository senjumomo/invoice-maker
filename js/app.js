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
  [/^#?\/?$/, docsView, 'docs'],
  [/^#\/doc\/(\w+)$/, docView, 'docs'],
  [/^#\/new\/(\w+)(?:\/(\w+))?$/, (type, cust) => editView(null, type, cust), 'docs'],
  [/^#\/edit\/(\w+)$/, id => editView(id), 'docs'],
  [/^#\/customers$/, customersView, 'customers'],
  [/^#\/customer\/(\w+)$/, customerView, 'customers'],
  [/^#\/items$/, itemsView, 'items'],
  [/^#\/reports$/, reportsView, 'reports'],
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
  document.title = title === 'Invoice Maker' ? title : `${title} · Invoice Maker`;
}
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

// ------------------------------------------------------------------ new-document type picker
function pickDocType(onPick, title = 'New document') {
  const sh = openSheet(`<h3>${title}</h3><div class="menu">${Object.entries(DOC_TYPES).map(([k, t]) =>
    `<button data-type="${k}">${icon('doc')}<span>${t.label}</span></button>`).join('')}</div>`);
  sh.onclick = e => { const b = e.target.closest('[data-type]'); if (b) { closeSheet(); onPick(b.dataset.type); } };
}

// ------------------------------------------------------------------ documents list
const docFilter = { status: 'all', type: 'all', q: '' };
function docsView() {
  setChrome({ fab: () => pickDocType(t => location.hash = `#/new/${t}`) });
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
  const show = k => Object.entries(sums[k]).filter(([c, v]) => c === cur || Math.abs(v) > 0.004)
    .map(([c, v]) => `<div>${money(v, c)}</div>`).join('');
  const typesUsed = [...new Set(all.map(d => d.type))];
  view.innerHTML = `
    <div class="summary">
      <div class="card"><div class="label">Unpaid</div><div class="value">${show('unpaid')}</div></div>
      <div class="card"><div class="label">Overdue</div><div class="value ${Object.values(sums.overdue).some(v => v > 0.004) ? 'bad' : ''}">${show('overdue')}</div></div>
      <div class="card"><div class="label">Paid</div><div class="value good">${show('paid')}</div></div>
      <div class="card"><div class="label">Documents</div><div class="value">${all.length}</div></div>
    </div>
    <div class="search">${icon('search')}<input class="input" id="q" type="search" placeholder="Search customer, number or item" value="${esc(docFilter.q)}"></div>
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
      <div class="card list">${rows.map(({ d, t, st }) => `
      <a class="list-item" href="#/doc/${d.id}">
        <div class="main"><div class="title ellipsis">${esc(customerLabel(d))}</div>
          <div class="sub">${DOC_TYPES[d.type].label} ${esc(d.number)} · ${fmtDate(d.date)}${d.recurring?.freq && !d.recurring.ended ? ' · ' + icon('repeat', 'style="width:13px;height:13px;vertical-align:-2px"') : ''}</div></div>
        <div class="amt">${money(t.total, d.currency)}<br>${inTrash ? '' : badge(st)}</div>
      </a>`).join('')}</div>`
      : empty('doc', inTrash ? 'Trash is empty.' : all.length ? 'No documents match.' : 'No documents yet.<br>Tap + to create your first invoice.');
  };
  draw();
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
  if (!d) { location.hash = '#/'; return; }
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
  view.innerHTML = `${banner}${recur}${sent}
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
      <label class="field"><span>Method (optional)</span><input id="p_method" list="methods" value="${esc(p.method || '')}" placeholder="Cash, bank transfer, card…">
        <datalist id="methods"><option>Cash</option><option>Bank transfer</option><option>Card</option><option>Cheque</option><option>PayPal</option><option>Other</option></datalist></label>
    </div>
    <div class="sheet-actions">${d.payment ? '<button class="btn danger" data-x="unpaid">Mark unpaid</button>' : ''}<button class="btn primary" data-x="save">Save payment</button></div>`);
  sh.onclick = e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'unpaid') d.payment = null;
    else {
      const a = num($('#p_amt').value);
      d.payment = { amount: a >= t.total ? null : a, date: $('#p_date').value, method: $('#p_method').value.trim() };
    }
    S.save(); closeSheet(); toast('Payment updated'); done();
  };
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
      if (DOC_TYPES[type].paidByDefault && !d.payment) d.payment = { amount: null, date: S.today(), method: '' };
      S.save(); toast(`Converted to ${DOC_TYPES[type].label}`); docView(d.id);
    }, 'Convert to…');
    if (x === 'trash') { S.trashDoc(d.id); toast('Moved to Trash'); location.hash = '#/'; }
    if (x === 'destroy' && await confirmSheet({ title: 'Delete forever?', body: 'This document will be permanently deleted. This can’t be undone.', ok: 'Delete', danger: true })) {
      S.destroyDoc(d.id); toast('Deleted'); location.hash = '#/';
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
  if (id) { const src = S.getDoc(id); if (!src) { location.hash = '#/'; return; } d = structuredClone(src); }
  else if (pendingDraft && pendingDraft.type === newType) { d = pendingDraft; pendingDraft = null; }
  else {
    if (!DOC_TYPES[newType]) { location.hash = '#/'; return; }
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

  const draw = () => {
    const type = DOC_TYPES[d.type];
    view.innerHTML = `
    <div class="card section stack">
      <div class="row"><button class="doc-type-btn" data-act="type">${type.label}${icon('down')}</button><div class="grow"></div>
        <button class="btn ghost" data-act="style">${icon('palette')}Style</button></div>
      <div class="grid2">
        <label class="field"><span>${type.numLabel}</span><input data-f="number" value="${esc(d.number)}"></label>
        <label class="field"><span>${type.dateLabel}</span><input data-f="date" type="date" value="${esc(d.date)}"></label>
      </div>
      <div class="grid2">
        <label class="field"><span>${type.validUntil ? 'Valid until' : 'Due date'}</span><input data-f="dueDate" type="date" value="${esc(d.dueDate)}"></label>
        <label class="field"><span>P.O. # (optional)</span><input data-f="po" value="${esc(d.po)}"></label>
      </div>
    </div>

    <div class="card section stack">
      <h2>From</h2>
      <label class="field"><textarea data-f="from" rows="3" placeholder="Your company or name&#10;Address">${esc(d.from)}</textarea></label>
      ${!s.business.name ? `<p class="small muted" style="margin:6px 0 0">Tip: fill in your business details in <a href="#/settings">Settings</a> to pre-fill this on every document.</p>` : ''}
    </div>

    <div class="card section stack">
      <div class="row"><h2 class="grow" style="margin:0">${type.billToLabel || 'Bill To'}</h2>
        ${S.db().customers.length ? `<button class="btn ghost" data-act="pickCustomer">${icon('user')}Choose</button>` : ''}</div>
      <label class="field"><textarea data-f="billTo" rows="3" placeholder="Customer name&#10;Billing address">${esc(d.billTo)}</textarea></label>
      <label class="field"><span>Customer email (optional)</span><input data-f="email" type="email" value="${esc(d.email)}"></label>
      <label class="check"><input type="checkbox" data-act="toggleShip" ${d.shipTo ? 'checked' : ''}> Add ${(type.shipToLabel || 'ship to').toLowerCase()} address</label>
      <label class="field ${d.shipTo ? '' : 'hidden'}" id="shipField"><span>${type.shipToLabel || 'Ship To'}</span><textarea data-f="shipTo" rows="3">${esc(d.shipTo)}</textarea></label>
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
      <div class="grid2">
        <label class="field"><span>Discount %</span><input data-f="discount" inputmode="decimal" value="${d.discount || ''}" placeholder="0"></label>
        <label class="field"><span>Shipping</span><input data-f="shipping" inputmode="decimal" value="${d.shipping || ''}" placeholder="0.00"></label>
      </div>
      <div class="totals-box" id="totals"></div>
    </div>`}

    <div class="card section stack">
      <h2>Notes</h2>
      <label class="field"><span>Terms &amp; conditions</span><textarea data-f="terms" rows="3" placeholder="e.g. Payment due within 14 days">${esc(d.terms)}</textarea></label>
      <label class="field"><span>Footer</span><input data-f="footer" value="${esc(d.footer)}"></label>
      <label class="check"><input type="checkbox" data-f="showSignature" ${d.showSignature ? 'checked' : ''} ${s.signature ? '' : 'disabled'}> Show my signature ${s.signature ? '' : '<span class="small muted">(add one in Settings)</span>'}</label>
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
    <label class="field"><textarea data-if="desc" rows="1" placeholder="Description" style="min-height:44px">${esc(it.desc)}</textarea></label>
    <div class="grid3">
      <label class="field"><span>Qty</span><input data-if="qty" inputmode="decimal" value="${it.qty}"></label>
      ${type.noPrices ? '' : `<label class="field"><span>Unit price</span><input data-if="price" inputmode="decimal" value="${it.price || ''}" placeholder="0.00"></label>
      <div class="line-total" data-line="${i}"></div>`}
    </div>
    <div class="item-tools">
      ${type.noPrices ? '' : `<button class="tax-pill" data-act="taxes">${taxes.length ? taxes.map(t => `${esc(t.name)} ${t.rate}%`).join(' + ') : '+ Tax'}</button>`}
      <button class="tax-pill" data-act="saveItem">Save item</button>
      <div class="grow"></div>
      <button class="icon-btn" data-act="delItem" aria-label="Remove item" style="margin:0;width:36px;height:36px">${icon('trash', 'style="width:20px;height:20px;color:var(--danger)"')}</button>
    </div>
  </div>`;
}

function currencyOptions(sel) {
  const list = CURRENCIES.includes(sel) ? CURRENCIES : [sel, ...CURRENCIES];
  return list.map(c => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
}

function customerPicker(onPick) {
  const cs = [...S.db().customers].sort((a, b) => S.customerName(a).localeCompare(S.customerName(b)));
  const sh = openSheet(`<h3>Choose customer</h3>
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
function customersView() {
  setChrome({ title: 'Customers', fab: () => editCustomerSheet() });
  view.innerHTML = `
    <div class="search">${icon('search')}<input class="input" id="q" type="search" placeholder="Search customers" value="${esc(custFilter.q)}"></div>
    <div class="chips">${['all', 'unpaid', 'overdue', 'paid'].map(s => `<button class="chip ${custFilter.status === s ? 'active' : ''}" data-st="${s}">${s === 'all' ? 'All' : s === 'paid' ? 'All paid' : STATUS_LABEL[s]}</button>`).join('')}</div>
    <div id="clist"></div>`;
  const draw = () => {
    const q = custFilter.q.toLowerCase();
    const rows = S.db().customers.map(c => ({ c, ...customerStats(c) }))
      .filter(r => (r.c.billTo + ' ' + r.c.email).toLowerCase().includes(q))
      .filter(r => custFilter.status === 'all' || r.st === custFilter.status || (custFilter.status === 'unpaid' && r.st === 'overdue'))
      .sort((a, b) => S.customerName(a.c).localeCompare(S.customerName(b.c)));
    $('#clist').innerHTML = rows.length ? `<div class="card list">${rows.map(r => `
      <a class="list-item" href="#/customer/${r.c.id}"><span class="avatar">${initials(S.customerName(r.c))}</span>
        <div class="main"><div class="title ellipsis">${esc(S.customerName(r.c))}</div><div class="sub">${r.docs.length} document${r.docs.length === 1 ? '' : 's'}</div></div>
        <div class="amt">${r.balance > 0.004 ? money(r.balance) : ''}<br>${r.docs.length ? badge(r.st) : ''}</div></a>`).join('')}</div>`
      : empty('user', S.db().customers.length ? 'No customers match.' : 'No customers yet.<br>They’re added automatically when you save a document.');
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
    fab: () => pickDocType(t => location.hash = `#/new/${t}/${c.id}`) });
  $('#topActions').onclick = () => editCustomerSheet(c);
  const docs = st.docs.sort((a, b) => b.date.localeCompare(a.date));
  view.innerHTML = `
    <div class="card section">
      <div style="white-space:pre-line">${esc(c.billTo)}</div>
      ${c.email ? `<div style="margin-top:6px"><a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ''}
      ${c.phone ? `<div><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></div>` : ''}
      ${c.notes ? `<p class="small muted">${esc(c.notes)}</p>` : ''}
    </div>
    <div class="summary">
      <div class="card"><div class="label">Billed</div><div class="value">${money(st.billed)}</div></div>
      <div class="card"><div class="label">Balance</div><div class="value ${st.overdue ? 'bad' : ''}">${money(st.balance)}</div></div>
    </div>
    <div class="row" style="margin-bottom:12px"><button class="btn grow" data-act="statement">${icon('csv')}Statement (CSV)</button>
      <button class="btn grow" data-act="new">${icon('plus')}New document</button></div>
    ${docs.length ? `<div class="card list">${docs.map(d => { const t = totals(d); return `
      <a class="list-item" href="#/doc/${d.id}"><div class="main"><div class="title">${DOC_TYPES[d.type].label} ${esc(d.number)}</div><div class="sub">${fmtDate(d.date)}</div></div>
      <div class="amt">${money(t.total, d.currency)}<br>${badge(status(d, t))}</div></a>`; }).join('')}</div>` : empty('doc', 'No documents for this customer yet.')}`;
  view.onclick = e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'new') pickDocType(t => location.hash = `#/new/${t}/${c.id}`);
    if (b.dataset.act === 'statement') {
      const rows = [['Document', 'Number', 'Date', 'Due date', 'Currency', 'Total', 'Paid', 'Balance', 'Status']];
      for (const d of [...docs].reverse()) { const t = totals(d); rows.push([DOC_TYPES[d.type].label, d.number, d.date, d.dueDate, d.currency, t.total, t.paid, t.balance, STATUS_LABEL[status(d, t)]]); }
      downloadBlob(new Blob(['﻿' + toCSV(rows)], { type: 'text/csv' }), `Statement - ${S.customerName(c)}.csv`);
    }
  };
}

function editCustomerSheet(c) {
  const isNew = !c; c = c ? { ...c } : { id: S.uid(), billTo: '', shipTo: '', email: '', phone: '', notes: '' };
  const sh = openSheet(`<h3>${isNew ? 'New customer' : 'Edit customer'}</h3><div class="stack">
    <label class="field"><span>Name &amp; billing address</span><textarea id="c_bill" rows="3" placeholder="Customer name&#10;Address" autofocus>${esc(c.billTo)}</textarea></label>
    <label class="field"><span>Shipping address (optional)</span><textarea id="c_ship" rows="2">${esc(c.shipTo)}</textarea></label>
    <div class="grid2"><label class="field"><span>Email</span><input id="c_email" type="email" value="${esc(c.email)}"></label>
      <label class="field"><span>Phone</span><input id="c_phone" type="tel" value="${esc(c.phone)}"></label></div>
    <label class="field"><span>Notes</span><input id="c_notes" value="${esc(c.notes)}"></label></div>
    <div class="sheet-actions">${isNew ? '' : '<button class="btn danger" data-x="del">Delete</button>'}<button class="btn primary" data-x="save">Save</button></div>`);
  sh.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'del') {
      closeSheet();
      if (await confirmSheet({ title: 'Delete customer?', body: 'Their documents are kept, but no longer linked to this customer.', ok: 'Delete', danger: true })) { S.deleteCustomer(c.id); location.hash = '#/customers'; }
      return;
    }
    c.billTo = $('#c_bill').value.trim(); c.shipTo = $('#c_ship').value.trim(); c.email = $('#c_email').value.trim(); c.phone = $('#c_phone').value.trim(); c.notes = $('#c_notes').value.trim();
    if (!c.billTo) { toast('Enter a name'); return; }
    S.saveCustomer(c); closeSheet(); toast('Customer saved');
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
  setChrome({ title: 'Reports' });
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

// ------------------------------------------------------------------ settings
function settingsView() {
  const s = S.settings(), b = s.business;
  setChrome({ title: 'Settings' });
  view.innerHTML = `
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
      if (a === 'reset' && await confirmSheet({ title: 'Erase all data?', body: 'All documents, customers, items and settings in this browser will be deleted. This can’t be undone.', ok: 'Erase everything', danger: true })) {
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
