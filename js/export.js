// PDF, print, share and file download helpers.
import { paperHTML } from './render.js';
import { DOC_TYPES, settings } from './store.js';

const HTML2PDF = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
let libPromise;
function loadLib() {
  if (window.html2pdf) return Promise.resolve();
  libPromise ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = HTML2PDF; s.onload = res; s.onerror = () => { libPromise = null; rej(new Error('Could not load the PDF library. Check your connection.')); };
    document.head.appendChild(s);
  });
  return libPromise;
}

export function fileName(doc) {
  const who = (doc.billTo || '').split('\n')[0].trim().replace(/[^\w\- ]+/g, '').slice(0, 40);
  return `${DOC_TYPES[doc.type].label} ${doc.number}${who ? ' - ' + who : ''}.pdf`;
}

export async function pdfBlob(doc) {
  await loadLib();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;';
  host.innerHTML = paperHTML(doc);
  document.body.appendChild(host);
  const el = host.firstElementChild;
  try {
    await Promise.all([...el.querySelectorAll('img')].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
    const letter = settings().paper === 'letter';
    return await window.html2pdf().set({
      margin: 0, image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', windowWidth: el.offsetWidth },
      jsPDF: { unit: 'px', format: letter ? [816, 1056] : [794, 1123], orientation: 'portrait', hotfixes: ['px_scaling'] },
      pagebreak: { mode: ['css', 'legacy'] },
    }).from(el).outputPdf('blob');
  } finally { host.remove(); }
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function downloadPDF(doc) { downloadBlob(await pdfBlob(doc), fileName(doc)); }

// Returns 'shared' | 'downloaded' | 'cancelled'
export async function sharePDF(doc, text) {
  const blob = await pdfBlob(doc);
  const file = new File([blob], fileName(doc), { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name, text }); return 'shared'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  downloadBlob(blob, file.name);
  return 'downloaded';
}

export function printDoc(doc) {
  const root = document.getElementById('printRoot');
  root.innerHTML = paperHTML(doc);
  const style = document.createElement('style');
  style.textContent = `@page { size: ${settings().paper === 'letter' ? 'letter' : 'A4'}; margin: 0 }`;
  root.appendChild(style);
  const done = () => { root.innerHTML = ''; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

export function toCSV(rows) {
  return rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}
