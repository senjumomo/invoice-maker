// Builds the printable document HTML (.paper) for a doc.
import { DOC_TYPES, settings } from './store.js';
import { totals, money, fmtDate, status } from './calc.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function paperHTML(doc) {
  const s = settings(), type = DOC_TYPES[doc.type], t = totals(doc), st = status(doc, t);
  const m = v => money(v, doc.currency);
  const noPrices = type.noPrices;
  const [fromName, ...fromRest] = (doc.from || '').split('\n');
  const info = [
    [type.numLabel, doc.number],
    [type.dateLabel, fmtDate(doc.date)],
    doc.po && ['P.O. #', doc.po],
    doc.dueDate && [type.validUntil ? 'Valid Until' : 'Due Date', fmtDate(doc.dueDate)],
  ].filter(Boolean);

  const rows = t.lines.map(l => {
    const tx = (l.taxes || []).map(x => `${esc(x.name)} ${x.rate}%`).join(', ');
    return `<tr>
      <td class="num">${esc(fmtQty(l.qty))}</td>
      <td>${esc(l.desc)}${tx ? `<div class="taxnote">${tx}</div>` : ''}</td>
      ${noPrices ? '' : `<td class="num">${m(l.price)}</td><td class="num">${m(l.amount)}</td>`}
    </tr>`;
  }).join('');

  const showPaid = doc.payment && t.paid > 0;
  const totalsRows = noPrices ? '' : `<table class="p-totals">
      <tr><td>Subtotal</td><td>${m(t.subtotal)}</td></tr>
      ${t.discount ? `<tr><td>Discount (${t.discPct}%)</td><td>−${m(t.discount)}</td></tr>` : ''}
      ${t.taxLines.map(x => `<tr><td>${esc(x.name)} (${x.rate}%)</td><td>${m(x.amount)}</td></tr>`).join('')}
      ${t.shipping ? `<tr><td>Shipping</td><td>${m(t.shipping)}</td></tr>` : ''}
      <tr class="grand"><td>Total</td><td>${m(t.total)}</td></tr>
      ${showPaid ? `<tr><td>Paid</td><td>−${m(t.paid)}</td></tr><tr class="due"><td>Balance Due</td><td>${m(t.balance)}</td></tr>` : ''}
    </table>`;

  const stamp = s.paidStamp && st === 'paid' && !noPrices
    ? `<div class="p-stamp">PAID${doc.payment?.date ? `<small>${esc(fmtDate(doc.payment.date))}</small>` : ''}</div>` : '';

  const sig = doc.showSignature && s.signature
    ? `<div class="p-sign"><img src="${s.signature}" alt=""><div class="line">Authorized signature</div></div>` : '';

  return `<div class="paper tpl-${esc(doc.template || 'classic')} ${s.paper === 'letter' ? 'letter' : ''}" style="--accent:${esc(doc.color || '#1f4fd8')}">
    <div class="p-head">
      <div>
        ${s.logo ? `<img class="p-logo" src="${s.logo}" alt="">` : ''}
        <div class="p-from" style="${s.logo ? 'margin-top:12px' : ''}"><div class="name">${esc(fromName)}</div>${esc(fromRest.join('\n'))}</div>
      </div>
      <div class="p-title">${esc(type.label)}</div>
    </div>
    <div class="p-meta">
      <div class="p-parties">
        <div class="p-party"><div class="p-label">${esc(type.billToLabel || 'Bill To')}</div><div class="body">${esc(doc.billTo)}</div></div>
        ${doc.shipTo ? `<div class="p-party"><div class="p-label">${esc(type.shipToLabel || 'Ship To')}</div><div class="body">${esc(doc.shipTo)}</div></div>` : ''}
      </div>
      <table class="p-info">${info.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    </div>
    <table class="p-items">
      <thead><tr><th class="num">Qty</th><th>Description</th>${noPrices ? '' : '<th class="num">Unit Price</th><th class="num">Amount</th>'}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${totalsRows}
    ${doc.terms || sig ? `<div class="p-bottom">
      <div class="p-terms">${doc.terms ? `<div class="p-label">Terms &amp; Conditions</div>${esc(doc.terms)}` : ''}</div>${sig}
    </div>` : ''}
    ${doc.footer ? `<div class="p-footer">${esc(doc.footer)}</div>` : ''}
    ${stamp}
  </div>`;
}

function fmtQty(q) { const n = Number(q); return Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, ''); }

// Scale a .paper inside a wrapper so it fits the wrapper's width.
export function fitPaper(wrap) {
  const paper = wrap.querySelector('.paper');
  if (!paper) return;
  const host = wrap.parentElement, cs = getComputedStyle(host);
  const avail = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const scale = Math.min(1, avail / paper.offsetWidth);
  paper.style.transform = `scale(${scale})`;
  wrap.style.width = paper.offsetWidth * scale + 'px';
  wrap.style.height = paper.offsetHeight * scale + 'px';
}
