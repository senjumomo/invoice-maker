# Invoice Maker

A mobile-first web app for creating invoices, quotes, receipts and other business documents. It runs entirely in the browser: there's no server or account, it works offline, and it can be installed to a phone's home screen.

## Features

- **11 document types:** invoice, tax invoice, proforma invoice, receipt, sales receipt, credit memo, credit note, quote, estimate, purchase order and delivery note. Each type gets its own automatic numbering, and a document can be copied or converted to another type (for example, quote → invoice).
- **Items:** line items with quantity and unit price, up to two taxes per item (including compound taxes), a discount % and shipping. Items you use often can be saved and reused.
- **Customers:** customers are created automatically from the "Bill To" field, with balances, paid/unpaid/overdue filters and a CSV statement for each customer.
- **Today:** the home screen shows the week's lessons with the month calendar a tap away. Log lessons (student, date, start and end time), set weekly repeats, and swipe a lesson to cancel it (charged or not). A banner flags past months with lessons not yet invoiced.
- **Lesson invoicing:** each student has an hourly rate, and **Generate invoices** builds one invoice per student for a period, with one line per lesson. Billed lessons are marked so they're never invoiced twice.
- **Students:** owing students sort to the top, with their rate and next lesson. Each student's page lists upcoming lessons, and a weekly slot can be moved from any lesson onward.
- **Simple mode** (on by default): + starts an invoice straight away, and rarely used fields (P.O., ship-to, discount, shipping) sit under "More options". Turn it off in Settings for the full set of document types and fields.
- **Payments:** documents can be marked as paid or partly paid (or swiped as paid in the list), with a date and method. Unpaid invoices have a WhatsApp payment reminder. Overdue documents are tracked, and paid documents can show an optional PAID stamp.
- **Recurring documents:** daily, weekly, every 2 weeks, monthly, every 2 months, quarterly or yearly. A new copy is created when you open the app on or after the due date.
- **Output:** PDF download, sharing through the phone's share sheet (which attaches the PDF in Gmail, WhatsApp and similar apps), printing, and email drafts.
- **Look:** 10 templates, a choice of accent colour, your logo, a drawn or uploaded signature, A4 or US Letter paper, and any currency and locale.
- **Reports:** filter by period, type and status, see totals for tax, paid and outstanding amounts, and export to CSV or print.
- **Data:** everything is stored in the browser's `localStorage`. You can back up and restore with a JSON file, which is also how you move your data to another device.

## Running it

It's plain HTML, CSS and JavaScript modules with no build step. Serve the folder over HTTP with any static server:

```bash
npx http-server -p 8642 -c-1 .
```

Opening `index.html` straight from disk won't work, because ES modules and the service worker need HTTP.

### Hosting on GitHub Pages

In the repo, go to **Settings → Pages → Build and deployment**, set the source to *Deploy from a branch*, and pick `main` / `(root)`. The app will be served at `https://<user>.github.io/invoice-maker/`. Open that address on your phone and choose **Add to Home screen** to install it.

## Project layout

```
index.html            app shell
css/app.css           app UI (light and dark themes)
css/paper.css         printable document templates
js/app.js             router and all screens
js/store.js           data model and localStorage persistence, numbering, recurring
js/calc.js            totals, tax and payment status
js/render.js          document → HTML for preview, PDF and print
js/export.js          PDF (html2pdf.js, loaded on demand), share, print, CSV
js/ui.js              bottom sheets, toasts, icons, image helpers
sw.js                 offline cache
```

## Notes

- Data stays in the browser it was created in. Clearing site data deletes it, so take regular backups from Settings.
- The PDF library is loaded from cdnjs the first time you create a PDF, and is then cached so it works offline.
- When you release changes, increase `CACHE` in `sw.js` so the old offline cache gets cleared.
