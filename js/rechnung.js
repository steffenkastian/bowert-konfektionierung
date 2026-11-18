// Rechnung als PDF – Nachbau der bisherigen Rechnungen (Python/FPDF, pdf.py → createRechnung).
// Maße in mm wie in FPDF: A4, linker Rand 10 mm, Zellen-Innenabstand 1 mm, Arial ≙ Helvetica.
// Hinter die Rechnung kommen die archivierten Lieferscheine (pdf-lib fügt die PDFs zusammen).

const asset = (p) => new URL(`../${p}`, import.meta.url).href;

const RECIPIENT = [
  'Eppendorf Polymere GmbH',
  'Leistungsempfänger: Finanzbuchhaltung c/o EPPENDORF AG',
  'Eppendorf Polymere GmbH, Sebenter Weg 39, 23758 Oldenburg',
  'Barkhausenweg 1',
  '22339 Hamburg',
];
const FOOTER = [
  [20, ['BO-WERT GmbH', 'Im Dreieck 4', '23758 Oldenburg i.H.', 'Telefon 04361 / 5085732', 'Telefon 04361 / 5085734']],
  [60, ['Ag. HRB 6601 HL', 'Geschäftsführer:', 'Michael Bollmann', 'USt-ID.-Nr. DE 154 623 848', 'Telefon 04361 / 5085734']],
  [100, ['Sparkasse Holstein', 'BLZ: 213 522 40', 'Kto.-Nr.: 400 32 24', 'IBAN: DE39 2135 2240 0004 0032 24', 'BIC: NOLADE21HOL']],
  [150, ['Volksbank Eutin Raiffeisenbank eG', 'BLZ: 213 922 18', 'Kto.-Nr.: 724 742', 'IBAN: DE59 2139 2218 0000 7247 42', 'BIC: GENODEF1EUT']],
];
const FOOTER_MAIL = 'info@bowert-entsorgung.de';
export const PAYMENT_TEXT = 'Die Rechnung ist fällig in 14 Tagen.';

function loadScript(src, global) {
  return new Promise((resolve, reject) => {
    if (window[global]) { resolve(window[global]); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(window[global]);
    s.onerror = () => reject(new Error('PDF-Modul konnte nicht geladen werden (keine Verbindung?).'));
    document.head.append(s);
  });
}
let jspdfP = null;
let pdflibP = null;
let logoP = null;
const loadJsPdf = () => (jspdfP ||= loadScript(asset('vendor/jspdf/jspdf.umd.min.js'), 'jspdf').catch((e) => { jspdfP = null; throw e; }));
const loadPdfLib = () => (pdflibP ||= loadScript(asset('vendor/pdf-lib/pdf-lib.min.js'), 'PDFLib').catch((e) => { pdflibP = null; throw e; }));
function loadLogo() {
  logoP ||= fetch(asset('abrechnung/logo.jpg')).then(async (r) => {
    if (!r.ok) throw new Error('Logo konnte nicht geladen werden.');
    return new Uint8Array(await r.arrayBuffer());
  }).catch((e) => { logoP = null; throw e; });
  return logoP;
}

/** Wie formatNumber/formatNumber4 in pdf.py: ohne Tausenderpunkt, Komma als Dezimalzeichen. */
export const fmt2 = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toFixed(2).replace('.', ',');
export const fmt4 = (n) => Number(n).toFixed(4).replace('.', ',');
const invNo = (no) => `${String(no).slice(0, 4)} ${String(no).slice(4)}`;

/**
 * inv = { no, type: 'rechnung'|'storno', refNo, refDate, date, lieferdatum, items: [{ qty, text, price, total }],
 *         netto, ust, brutto, orderNrs, bestellnrs, extraLine, note }
 */
function drawInvoice(pdf, inv, logo) {
  const PT = 25.4 / 72; // mm je Punkt
  const L = 10; // linker Rand (FPDF)
  const C = 1; // Zellen-Innenabstand (FPDF c_margin)
  let y = 0;
  let size = 12;
  const font = (style = '', s = 12) => {
    size = s;
    pdf.setFont('helvetica', style === 'B' ? 'bold' : 'normal');
    pdf.setFontSize(s);
  };
  const base = (h) => y + h / 2 + 0.3 * size * PT; // FPDF: Text mittig in der Zelle
  /** addText aus pdf.py: Zelle 175 mm ab x, danach neue Zeile. */
  const addText = (text, { style = '', s = 12, align = 'L', h = 5, x = 20, underline = false } = {}) => {
    font(style, s);
    const by = base(h);
    if (text) {
      if (align === 'R') pdf.text(text, x + 175 - C, by, { align: 'right' });
      else if (align === 'C') pdf.text(text, x + 175 / 2, by, { align: 'center' });
      else pdf.text(text, x + C, by);
      if (underline) {
        pdf.setLineWidth(0.05 * s * PT);
        const uy = by + 0.1 * s * PT;
        pdf.line(x + C, uy, x + C + pdf.getTextWidth(text), uy);
      }
    }
    y += h;
  };
  /** Zeile der Tabelle mit Rahmen; texts: [[Breite, Text, Ausrichtung]]. */
  const LH = 7;
  const cellRow = (cells, { style = '' } = {}) => {
    font(style, 12);
    const wrapped = cells.map(([w, t]) => pdf.splitTextToSize(String(t ?? ''), w - 2 * C));
    const lines = Math.max(1, ...wrapped.map((w) => w.length));
    const h = LH * lines;
    let x = L;
    pdf.setLineWidth(0.2);
    cells.forEach(([w, , align], i) => {
      pdf.rect(x, y, w, h);
      wrapped[i].forEach((t, k) => {
        const by = y + k * LH + LH / 2 + 0.3 * size * PT;
        if (align === 'R') pdf.text(t, x + w - C, by, { align: 'right' });
        else pdf.text(t, x + C, by);
      });
      x += w;
    });
    y += h;
  };
  const W = [20, 25, 90, 30, 30];
  const storno = inv.type === 'storno';

  pdf.setTextColor(0);
  pdf.setDrawColor(0);

  // Kopf: Logo, Absenderzeile, Empfänger
  pdf.addImage(logo, 'JPEG', 140, 15, 50, 50 * (349 / 640));
  y = 40;
  addText('BO-WERT GmbH - Im Dreieck 4 - 23758 Oldenburg i.H.', { s: 8, x: 30, underline: true });
  addText('');
  for (const line of RECIPIENT) addText(line, { s: 10 });

  // Rechts: Bestellnummer, Auftrag, Steuer, Datum
  const joinNrs = (xs) => {
    const t = (xs || []).join(', ');
    font('', 12);
    return pdf.getTextWidth(t) > 110 ? 'siehe Lieferscheine' : t;
  };
  if (inv.bestellnrs?.length) addText(`Bestellnummer: ${joinNrs(inv.bestellnrs)}`, { align: 'R' });
  if (inv.orderNrs?.length) addText(`Auftragsnr: ${joinNrs(inv.orderNrs)}`, { align: 'R' });
  addText('Steuer-Nr.: 222 981 62 22', { align: 'R' });
  addText('Ust.-IdNr.: DE 154 623 848', { align: 'R' });
  addText(`Lieferdatum:   ${inv.lieferdatum || ''}`, { align: 'R' });
  addText(`Datum:   ${inv.date}`, { align: 'R' });

  // Titel
  y += 10;
  const ty = y;
  addText(storno ? 'S T O R N O R E C H N U N G' : 'R E C H N U N G', { style: 'B', s: 20 });
  y = ty;
  addText(`Nr. ${invNo(inv.no)}`, { style: 'B', s: 20, align: 'R' });
  y += 5;
  addText(storno
    ? `Hiermit stornieren wir die Rechnung Nr. ${invNo(inv.refNo)}${inv.refDate ? ` vom ${inv.refDate}` : ''}:`
    : 'Wir danken für Ihren Auftrag und liefern wie folgt:');

  // Tabelle
  y += 3;
  addText('EURO                EURO', { align: 'R' });
  cellRow([[W[0], 'Position'], [W[1], 'Stück'], [W[2], 'Text'], [W[3], 'Einzelpreis'], [W[4], 'Gesamtpreis']]);
  if (inv.extraLine) cellRow([[W[0] + W[1], ''], [W[2], inv.extraLine], [W[3] + W[4], '']]);
  inv.items.forEach((it, i) => {
    cellRow([[W[0], String(i + 1)], [W[1], fmt2(it.qty)], [W[2], it.text], [W[3], fmt4(it.price)], [W[4], fmt2(it.total)]]);
  });
  const wide = W[0] + W[1] + W[2] + W[3];
  cellRow([[wide, 'Gesamt Netto'], [W[4], fmt2(inv.netto)]]);
  // „zzgl. 19,00 % Ust.“ links, Nettobetrag rechts in derselben Zelle
  const uy = y;
  cellRow([[wide, 'zzgl. 19,00 % Ust.'], [W[4], fmt2(inv.ust)]]);
  font('', 12);
  pdf.text(fmt2(inv.netto), L + wide - C, uy + LH / 2 + 0.3 * 12 * PT, { align: 'right' });
  cellRow([[wide, 'Gesamtbetrag'], [W[4], fmt2(inv.brutto)]], { style: 'B' });

  // Fälligkeit + Hinweis
  y += 3;
  if (!storno) addText(PAYMENT_TEXT, { h: 10 });
  if (inv.note) {
    font('', 12);
    for (const line of pdf.splitTextToSize(inv.note, 175 - 2 * C)) addText(line, { h: 7 });
  }

  // Fußzeile (4 Spalten, 3 mm Zeilenhöhe, Schrift 8)
  for (const [x, lines] of FOOTER) {
    y = 297 - 25;
    for (const t of lines) addText(t, { s: 8, h: 3, x });
  }
  y += 2;
  addText(FOOTER_MAIL, { style: 'B', s: 8, align: 'C' });
}

/** Rechnung (ohne Lieferscheine) als PDF-Bytes. */
export async function invoicePdf(inv) {
  const [jspdf, logo] = await Promise.all([loadJsPdf(), loadLogo()]);
  const pdf = new jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
  drawInvoice(pdf, inv, logo);
  pdf.setProperties({
    title: `${inv.type === 'storno' ? 'Stornorechnung' : 'Rechnung'} ${invNo(inv.no)}`,
    author: 'BO-WERT GmbH', creator: 'BO-WERT Abrechnung',
  });
  return new Uint8Array(pdf.output('arraybuffer'));
}

/** Rechnung + Lieferscheine zu einer Datei zusammenfügen. */
export async function mergePdfs(parts) {
  const { PDFDocument } = await loadPdfLib();
  const out = await PDFDocument.create();
  for (const bytes of parts) {
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  out.setTitle('Rechnung BO-WERT GmbH');
  out.setAuthor('BO-WERT GmbH');
  out.setCreator('BO-WERT Abrechnung');
  return out.save();
}
