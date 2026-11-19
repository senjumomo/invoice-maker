import { DOC_TYPES, settings, today } from './store.js';

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
export const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };

// Per-line taxes: normal taxes apply to the (discounted) line amount; compound taxes
// apply to the line amount plus the normal taxes on that line.
export function totals(doc) {
  const discPct = Math.min(100, Math.max(0, num(doc.discount)));
  const taxMap = new Map();
  let subtotal = 0, discount = 0;
  const lines = doc.items.map(it => {
    const amount = r2(num(it.qty) * num(it.price));
    subtotal += amount;
    const base = amount * (1 - discPct / 100);
    discount += amount - base;
    let normal = 0;
    const taxes = it.taxes || [];
    for (const t of taxes.filter(t => !t.compound)) {
      const v = base * num(t.rate) / 100; normal += v; addTax(taxMap, t, v);
    }
    for (const t of taxes.filter(t => t.compound)) addTax(taxMap, t, (base + normal) * num(t.rate) / 100);
    return { ...it, amount };
  });
  const taxLines = [...taxMap.values()].map(t => ({ ...t, amount: r2(t.amount) }));
  const tax = r2(taxLines.reduce((a, t) => a + t.amount, 0));
  subtotal = r2(subtotal); discount = r2(discount);
  const shipping = r2(num(doc.shipping));
  const total = r2(subtotal - discount + tax + shipping);
  const paid = paidAmount(doc, total);
  return { lines, subtotal, discount, discPct, taxLines, tax, shipping, total, paid, balance: r2(total - paid) };
}
function addTax(map, t, v) {
  const k = `${t.name}|${t.rate}|${t.compound ? 1 : 0}`;
  const e = map.get(k) || { name: t.name, rate: num(t.rate), compound: !!t.compound, amount: 0 };
  e.amount += v; map.set(k, e);
}
export function paidAmount(doc, total) {
  if (!doc.payment) return 0;
  return doc.payment.amount == null ? total : r2(num(doc.payment.amount));
}

// paid | partial | overdue | unpaid | none (for non-payable doc types without a payment)
export function status(doc, t = totals(doc)) {
  const type = DOC_TYPES[doc.type];
  if (doc.payment) {
    if (t.paid >= t.total - 0.004) return 'paid';
    if (t.paid > 0) return 'partial';
  }
  if (!type.payable) return 'none';
  if (doc.dueDate && doc.dueDate < today()) return 'overdue';
  return 'unpaid';
}
export const STATUS_LABEL = { paid: 'Paid', partial: 'Partially paid', overdue: 'Overdue', unpaid: 'Unpaid', none: '' };

const fmtCache = new Map();
export function money(v, currency = settings().currency) {
  const key = currency + settings().locale;
  if (!fmtCache.has(key)) {
    try { fmtCache.set(key, new Intl.NumberFormat(settings().locale, { style: 'currency', currency })); }
    catch { fmtCache.set(key, new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })); }
  }
  return fmtCache.get(key).format(v || 0);
}
export function clearFormatCache() { fmtCache.clear(); }

export function fmtDate(s) {
  if (!s) return '';
  try { return new Date(s + 'T00:00:00').toLocaleDateString(settings().locale, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return s; }
}
