// Lieferschein als PDF – Nachbau der bisherigen Word-Vorlage (templateOhneKarton.docx).
// Koordinaten in Punkt (1/72 Zoll), y = Grundlinie von oben, aus der alten PDF übernommen.
// Schrift: Caladea (frei, gleiche Maße wie Cambria aus der Vorlage).

const SENDER = ['BO-WERT GmbH', 'Im Dreieck 4 – 23758 Oldenburg'];
const RECIPIENT = [
  'Eppendorf Polymere GmbH',
  'Leistungsempfänger: Finanzbuchhaltung c/o EPPENDORF SE',
  'Eppendorf Polymere GmbH, Sebenter Weg 39, 23758 Oldenburg',
  'Barkhausenweg 1',
  '22 339 Hamburg',
];
const UST_ID = 'DE 154 623 848';
const BANK = [
  ['Sparkasse Holstein'],
  ['BLZ:', '213 522 40'],
  ['Kto. Nr.: 400 32 24'],
  ['IBAN:', 'DE39 2135 2240 0004 0032 24'],
  ['BIC:', 'NOLADE21HOL'],
];

const asset = (p) => new URL(`../vendor/${p}`, import.meta.url).href;

let jsPdfLoading = null;
function loadJsPdf() {
  jsPdfLoading ||= new Promise((resolve, reject) => {
    if (window.jspdf) { resolve(window.jspdf.jsPDF); return; }
    const s = document.createElement('script');
    s.src = asset('jspdf/jspdf.umd.min.js');
    s.onload = () => resolve(window.jspdf.jsPDF);
    s.onerror = () => { jsPdfLoading = null; reject(new Error('PDF-Modul konnte nicht geladen werden (keine Verbindung?).')); };
    document.head.append(s);
  });
  return jsPdfLoading;
}

const toBase64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
let fontsLoading = null;
function loadFonts() {
  fontsLoading ||= Promise.all(['Caladea-Regular.ttf', 'Caladea-Bold.ttf'].map(async (f) => {
    const r = await fetch(asset(`fonts/${f}`));
    if (!r.ok) throw new Error('Schrift für den Lieferschein konnte nicht geladen werden.');
    return toBase64(await r.arrayBuffer());
  })).catch((e) => { fontsLoading = null; throw e; });
  return fontsLoading;
}

/** Zahlen wie auf der Vorlage: ohne Tausenderpunkt, aber ohne „.0“. */
const num = (n) => String(Math.round(Number(n) || 0));

/**
 * Zeichnet einen Lieferschein.
 * n = { no, orderNr, bestellnr, deliveryDate, date, qty, pallets, text, prev, total }
 */
function drawNote(pdf, n) {
  const font = (style, size) => { pdf.setFont('Caladea', style); pdf.setFontSize(size); };
  const line = (x1, y1, x2, y2) => pdf.line(x1, y1, x2, y2);
  pdf.setLineWidth(0.48);
  pdf.setDrawColor(0);
  pdf.setTextColor(0);

  // Absender im Kasten
  pdf.rect(84.4, 72, 439.5, 47.9);
  font('normal', 20);
  pdf.text(SENDER[0], 304, 91.5, { align: 'center' });
  pdf.text(SENDER[1], 304, 115, { align: 'center' });

  // Empfänger
  font('normal', 11);
  RECIPIENT.forEach((t, i) => pdf.text(t, 90, 156.1 + i * 12.9));

  // Kopfdaten
  font('normal', 14);
  pdf.text('Auftrag:', 310.4, 236.4);
  pdf.text('Bestellnummer:', 309.8, 252.7);
  font('bold', 14);
  pdf.text(n.orderNr, 414.1, 236.4);
  pdf.text(n.bestellnr || '', 414.1, 252.7);
  font('normal', 12);
  pdf.text('Ust.-IdNr.:', 309.8, 267.3);
  pdf.text(UST_ID, 414.1, 267.3);
  pdf.text('Lieferdatum:', 309.8, 281.4);
  pdf.text('Datum:', 309.8, 295.5);
  font('normal', 11);
  pdf.text(n.deliveryDate, 414.1, 281.4);
  pdf.text(n.date, 414.1, 295.5);

  // Titel
  font('bold', 20);
  pdf.text('L I E F E R S C H E I N', 90, 330.1);
  pdf.text(`Nr. ${n.no}`, 306.1, 330.1);
  font('normal', 11);
  pdf.text('Wir danken für Ihren Auftrag und liefern wie folgt:', 90, 357.9);

  // Tabelle
  const cols = [84.4, 133.8, 187.8, 240.2, 479.6];
  const top = 372.2;
  const headBottom = 385.9;
  // Breite wie in Word (Zelle 238 pt abzüglich Innenabstand)
  const textLines = pdf.splitTextToSize(n.text || '', 226);
  const rowBottom = headBottom + Math.max(1, textLines.length) * 12.9;
  font('normal', 11);
  pdf.text('Position', 90, 383.2);
  pdf.text('Stück', 139.5, 383.2);
  pdf.text('Paletten', 193.5, 383.2);
  pdf.text('Text', 245.8, 383.2);
  pdf.text('1', (cols[0] + cols[1]) / 2, 396.5, { align: 'center' });
  pdf.text(num(n.qty), 139.5, 396.5);
  pdf.text(num(n.pallets), 193.5, 396.5);
  textLines.forEach((t, i) => pdf.text(t, 245.8, 396.5 + i * 13));
  for (const y of [top, headBottom, rowBottom]) line(cols[0], y, cols[4], y);
  for (const x of cols) line(x, top, x, rowBottom);

  // Gesamtliefermenge
  const prev = Number(n.prev) || 0;
  font('normal', 11);
  pdf.text('Gesamtliefermenge des Auftrages bisher:', 198, 497.4);
  pdf.text(num(prev), 423.7, 497.4);
  pdf.text('+', 414.1, 510.2);
  pdf.text(num(n.qty), 422.6, 510.2);
  line(414.1, 512.2, 469.5, 512.2);
  pdf.text(num(prev + Number(n.qty || 0)), 423.7, 523.3);
  if (n.total) {
    pdf.text('von', 423.7, 546.2);
    pdf.text(num(n.total), 423.7, 571);
  }

  // Bankverbindung
  pdf.text('Bankverbindung:', 90, 702.1);
  const ys = [702.1, 714.9, 727.9, 740.7, 753.7];
  BANK.forEach(([a, b], i) => {
    pdf.text(a, 198, ys[i]);
    if (b) pdf.text(b, 234.1, ys[i]);
  });
}

/** Erzeugt ein PDF (eine Seite je Lieferschein) und gibt es als Blob zurück. */
export async function deliveryPdf(notes) {
  const [JsPDF, [regular, bold]] = await Promise.all([loadJsPdf(), loadFonts()]);
  const pdf = new JsPDF({ unit: 'pt', format: 'a4', compress: true });
  pdf.addFileToVFS('Caladea-Regular.ttf', regular);
  pdf.addFont('Caladea-Regular.ttf', 'Caladea', 'normal');
  pdf.addFileToVFS('Caladea-Bold.ttf', bold);
  pdf.addFont('Caladea-Bold.ttf', 'Caladea', 'bold');
  notes.forEach((n, i) => {
    if (i) pdf.addPage('a4');
    drawNote(pdf, n);
  });
  pdf.setProperties({
    title: notes.length === 1 ? `Lieferschein ${notes[0].no}` : `Lieferscheine ${notes.map((n) => n.no).join(', ')}`,
    author: 'BO-WERT GmbH', creator: 'BO-WERT Konfektionierung',
  });
  return pdf.output('blob');
}
