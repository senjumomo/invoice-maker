// Local persistence. Everything lives in this browser's localStorage under one key.
const KEY = 'invoice-maker.v1';

export const DOC_TYPES = {
  invoice:          { label: 'Invoice',          numLabel: 'Invoice #',          dateLabel: 'Invoice Date',  prefix: 'INV', payable: true },
  tax_invoice:      { label: 'Tax Invoice',      numLabel: 'Invoice #',          dateLabel: 'Invoice Date',  prefix: 'TAX', payable: true },
  proforma_invoice: { label: 'Proforma Invoice', numLabel: 'Invoice #',          dateLabel: 'Invoice Date',  prefix: 'PRO', payable: true },
  receipt:          { label: 'Receipt',          numLabel: 'Receipt #',          dateLabel: 'Receipt Date',  prefix: 'REC', payable: false, paidByDefault: true },
  sales_receipt:    { label: 'Sales Receipt',    numLabel: 'Receipt #',          dateLabel: 'Receipt Date',  prefix: 'SR',  payable: false, paidByDefault: true },
  credit_memo:      { label: 'Credit Memo',      numLabel: 'Credit Memo #',      dateLabel: 'Date',          prefix: 'CM',  payable: false },
  credit_note:      { label: 'Credit Note',      numLabel: 'Credit Note #',      dateLabel: 'Date',          prefix: 'CN',  payable: false },
  quote:            { label: 'Quote',            numLabel: 'Quote #',            dateLabel: 'Quote Date',    prefix: 'QUO', payable: false, validUntil: true },
  estimate:         { label: 'Estimate',         numLabel: 'Estimate #',         dateLabel: 'Estimate Date', prefix: 'EST', payable: false, validUntil: true },
  purchase_order:   { label: 'Purchase Order',   numLabel: 'P.O. #',             dateLabel: 'Order Date',    prefix: 'PO',  payable: true, billToLabel: 'Vendor', shipToLabel: 'Ship To' },
  delivery_note:    { label: 'Delivery Note',    numLabel: 'Delivery Note #',    dateLabel: 'Delivery Date', prefix: 'DN',  payable: false, billToLabel: 'Deliver To', noPrices: true },
};

export const TEMPLATES = [
  { id: 'classic', name: 'Classic' },
  { id: 'modern', name: 'Modern' },
  { id: 'minimal', name: 'Minimal' },
  { id: 'bold', name: 'Bold' },
  { id: 'clean', name: 'Clean' },
  { id: 'elegant', name: 'Elegant' },
  { id: 'corporate', name: 'Corporate' },
  { id: 'fresh', name: 'Fresh' },
  { id: 'luxe', name: 'Luxe' },
  { id: 'wave', name: 'Wave' },
];
export const COLORS = ['#1f4fd8', '#0e7c86', '#18794e', '#6d28d9', '#be185d', '#c2410c', '#b45309', '#334155', '#111827'];

export const CURRENCIES = ['ZAR','USD','EUR','GBP','CAD','AUD','NZD','INR','PKR','AED','SAR','NGN','KES','SGD','MYR','PHP','JPY','CNY','HKD','CHF','SEK','NOK','DKK','PLN','MXN','BRL','TRY'];

const defaults = () => ({
  version: 2,
  settings: {
    business: { name: '', address: '', email: '', phone: '', website: '', taxId: '' },
    logo: '', signature: '',
    currency: 'ZAR', locale: 'en-ZA', paper: 'a4',
    template: 'classic', color: COLORS[0],
    dueDays: 14, terms: '', footer: 'Thank you for your business!',
    paidStamp: true, showSignature: false, theme: 'auto',
    counters: {},
  },
  docs: [], customers: [], items: [], taxes: [],
});

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const d = JSON.parse(raw), base = defaults();
    return migrate({ ...base, ...d, settings: { ...base.settings, ...d.settings, business: { ...base.settings.business, ...(d.settings || {}).business } } });
  } catch { return defaults(); }
}

// One-time switch to rands: early versions defaulted to US dollars.
// Moves the default and every USD document to ZAR (amounts stay the same).
function migrate(s) {
  if (s.version < 2) {
    if (s.settings.currency === 'USD') { s.settings.currency = 'ZAR'; s.settings.locale = 'en-ZA'; }
    for (const d of s.docs) if (d.currency === 'USD') d.currency = 'ZAR';
    s.version = 2;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  }
  return s;
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
  catch (e) { console.error(e); return false; }
}

export const db = () => state;
export const settings = () => state.settings;

export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
export function today() { const d = new Date(); return iso(d); }
export function iso(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
export function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); }

// ---- documents ----
export function nextNumber(type, peek = false) {
  const c = state.settings.counters;
  const used = new Set(state.docs.filter(d => d.type === type).map(d => d.number));
  let n = (c[type] || 0) + 1, num;
  do { num = `${DOC_TYPES[type].prefix}-${String(n).padStart(4, '0')}`; n++; } while (used.has(num));
  if (!peek) c[type] = n - 1;
  return num;
}

export function newDoc(type = 'invoice') {
  const s = state.settings, t = DOC_TYPES[type];
  const b = s.business;
  return {
    id: uid(), type, number: nextNumber(type, true), date: today(),
    dueDate: (t.payable || t.validUntil) ? addDays(today(), Number(s.dueDays) || 0) : '',
    po: '', from: [b.name, b.address, b.phone, b.email, b.website, b.taxId && `Tax ID: ${b.taxId}`].filter(Boolean).join('\n'),
    customerId: '', billTo: '', shipTo: '', email: '',
    items: [{ id: uid(), desc: '', qty: 1, price: 0, taxes: [] }],
    discount: 0, shipping: 0,
    terms: s.terms, footer: s.footer, currency: s.currency,
    template: s.template, color: s.color, showSignature: s.showSignature,
    payment: t.paidByDefault ? { amount: null, date: today(), method: 'Bank transfer' } : null,
    recurring: null, sentAt: null, deletedAt: null, createdAt: Date.now(), updatedAt: Date.now(), isNew: true,
  };
}

export function getDoc(id) { return state.docs.find(d => d.id === id); }

export function saveDoc(doc) {
  if (doc.isNew) {
    delete doc.isNew;
    // Reserve the number if it matches the next auto number.
    if (doc.number === nextNumber(doc.type, true)) nextNumber(doc.type);
    state.docs.unshift(doc);
  } else {
    const i = state.docs.findIndex(d => d.id === doc.id);
    if (i >= 0) state.docs[i] = doc; else state.docs.unshift(doc);
  }
  doc.updatedAt = Date.now();
  upsertCustomerFromDoc(doc);
  save();
  return doc;
}

export function copyDoc(doc, type = doc.type) {
  const c = structuredClone(doc);
  Object.assign(c, {
    id: uid(), type, number: nextNumber(type, true), date: today(),
    dueDate: doc.dueDate ? addDays(today(), Number(state.settings.dueDays) || 0) : '',
    payment: DOC_TYPES[type].paidByDefault ? { amount: null, date: today(), method: 'Bank transfer' } : null,
    recurring: null, sentAt: null, deletedAt: null, createdAt: Date.now(), updatedAt: Date.now(), isNew: true,
  });
  c.items = c.items.map(it => ({ ...it, id: uid() }));
  return c;
}

export function trashDoc(id) { const d = getDoc(id); if (d) { d.deletedAt = Date.now(); save(); } }
export function restoreDoc(id) { const d = getDoc(id); if (d) { d.deletedAt = null; save(); } }
export function destroyDoc(id) { state.docs = state.docs.filter(d => d.id !== id); save(); }
export function purgeTrash() {
  const cutoff = Date.now() - 30 * 864e5;
  const before = state.docs.length;
  state.docs = state.docs.filter(d => !d.deletedAt || d.deletedAt > cutoff);
  if (state.docs.length !== before) save();
}

// ---- customers ----
export function getCustomer(id) { return state.customers.find(c => c.id === id); }
export function saveCustomer(c) {
  const i = state.customers.findIndex(x => x.id === c.id);
  if (i >= 0) state.customers[i] = c; else state.customers.push(c);
  save(); return c;
}
export function deleteCustomer(id) {
  state.customers = state.customers.filter(c => c.id !== id);
  state.docs.forEach(d => { if (d.customerId === id) d.customerId = ''; });
  save();
}
export function customerName(c) { return (c.billTo || '').split('\n')[0].trim() || 'Unnamed customer'; }

function upsertCustomerFromDoc(doc) {
  const billTo = (doc.billTo || '').trim();
  if (!billTo) return;
  let c = doc.customerId && getCustomer(doc.customerId);
  if (!c) {
    const name = billTo.split('\n')[0].trim().toLowerCase();
    c = state.customers.find(x => customerName(x).toLowerCase() === name);
  }
  if (!c) { c = { id: uid(), billTo: '', shipTo: '', email: '', phone: '', notes: '' }; state.customers.push(c); }
  c.billTo = billTo; if (doc.shipTo) c.shipTo = doc.shipTo; if (doc.email) c.email = doc.email;
  doc.customerId = c.id;
}

// ---- saved items & taxes ----
export function saveItem(it) {
  const i = state.items.findIndex(x => x.id === it.id);
  if (i >= 0) state.items[i] = it; else state.items.push(it);
  save(); return it;
}
export function deleteItem(id) { state.items = state.items.filter(i => i.id !== id); save(); }
export function saveTax(t) {
  const i = state.taxes.findIndex(x => x.id === t.id);
  if (i >= 0) state.taxes[i] = t; else state.taxes.push(t);
  save(); return t;
}
export function deleteTax(id) { state.taxes = state.taxes.filter(t => t.id !== id); save(); }

// ---- recurring ----
const FREQ = { daily: [0, 1], weekly: [0, 7], biweekly: [0, 14], monthly: [1, 0], bimonthly: [2, 0], quarterly: [3, 0], yearly: [12, 0] };
export const FREQ_LABELS = { daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', bimonthly: 'Every 2 months', quarterly: 'Quarterly', yearly: 'Yearly' };
export function advance(dateStr, freq) {
  const [m, d] = FREQ[freq]; const dt = new Date(dateStr + 'T00:00:00');
  if (m) { const day = dt.getDate(); dt.setDate(1); dt.setMonth(dt.getMonth() + m); dt.setDate(Math.min(day, new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate())); }
  else dt.setDate(dt.getDate() + d);
  return iso(dt);
}
// Creates any recurring documents that have come due. Returns created docs.
export function runRecurring() {
  const created = [], t = today();
  for (const src of [...state.docs]) {
    const r = src.recurring;
    if (!r || !r.freq || src.deletedAt) continue;
    let guard = 0;
    while (r.next && r.next <= t && (!r.stop || r.next <= r.stop) && guard++ < 60) {
      const c = copyDoc(src);
      const dueGap = src.dueDate ? Math.round((new Date(src.dueDate) - new Date(src.date)) / 864e5) : null;
      c.date = r.next; c.dueDate = dueGap != null ? addDays(r.next, dueGap) : '';
      c.recurringFrom = src.id; c.number = nextNumber(c.type);
      c.items.forEach(it => { delete it.date; }); // item dates belong to the original period
      delete c.isNew; state.docs.unshift(c); created.push(c);
      r.next = advance(r.next, r.freq);
    }
    if (r.stop && r.next > r.stop) r.ended = true;
  }
  if (created.length) save();
  return created;
}

// ---- backup ----
export function exportJSON() { return JSON.stringify(state, null, 1); }
export function importJSON(text) {
  const d = JSON.parse(text);
  if (!d || !Array.isArray(d.docs) || !d.settings) throw new Error('Not an Invoice Maker backup file');
  localStorage.setItem(KEY, JSON.stringify(d));
  state = load();
}
export function resetAll() { state = defaults(); save(); }
