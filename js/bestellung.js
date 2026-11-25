// Bestell-PDF (Eppendorf) einlesen: Auftrag, Bestellnummer, Menge, Artikel, Stückliste,
// Beladungsplan und Packplan als eigene PDFs.
//
// Alles läuft im Browser: pdf.js liest den Text, pdf-lib schneidet die Pläne heraus.
// `parseOrderPages` ist reine Textauswertung (ohne PDF-Bibliothek) und dadurch leicht prüfbar.

import { loadPdfJs } from './files.js';

const asset = (p) => new URL(`../${p}`, import.meta.url).href;
let pdflibP = null;
function loadPdfLib() {
  pdflibP ||= new Promise((resolve, reject) => {
    if (window.PDFLib) { resolve(window.PDFLib); return; }
    const s = document.createElement('script');
    s.src = asset('vendor/pdf-lib/pdf-lib.min.js');
    s.onload = () => resolve(window.PDFLib);
    s.onerror = () => reject(new Error('PDF-Modul konnte nicht geladen werden (keine Verbindung?).'));
    document.head.append(s);
  }).catch((e) => { pdflibP = null; throw e; });
  return pdflibP;
}

/** „400,0000“ / „1.234,5“ → Zahl */
export const deNum = (t) => Number(String(t || '').replace(/\./g, '').replace(',', '.'));
/** „0012 526.024-01“ → „001252602401“ */
export const digitsOnly = (t) => String(t || '').replace(/\D/g, '');

/** Text einer Seite als Zeilen (nach Höhe gruppiert, von links nach rechts). */
function pageLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || it.height || 8;
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, h * 0.35));
    if (!row) { row = { y, items: [] }; rows.push(row); }
    row.items.push({ x, w: it.width || 0, s: it.str, h });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    let line = '';
    let end = null;
    for (const it of r.items) {
      if (end !== null && it.x - end > it.h * 0.15 && !line.endsWith(' ') && !it.s.startsWith(' ')) line += ' ';
      line += it.s;
      end = it.x + it.w;
    }
    return line.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

/** PDF → { pages: [{ n, lines, text }], numPages } */
export async function readPdfText(bytes) {
  const lib = await loadPdfJs();
  const task = lib.getDocument({ data: bytes.slice(0), isEvalSupported: false });
  const pdf = await task.promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const lines = pageLines(tc.items);
    pages.push({ n, lines, text: lines.join('\n') });
    page.cleanup();
  }
  task.destroy();
  return { pages, numPages: pages.length };
}

const KNOWN_PAGES = [
  ['bestellung', /\bBESTELLUNG\b|Wert der Bestellung/],
  ['laufschein', /\bLaufschein\b/],
  ['stueckliste', /Produktionsst(ü|u)cklisten?/],
  ['fremdbearbeitung', /Fremdbearbeitungsschein/],
  ['pruefblatt', /Chargen-Sublot|Pr(ü|u)fungen nach aktuellem Pr(ü|u)fplan/],
  ['auftragsblatt', /Probenbeschreibung|SA\/Pal\b/],
];

const first = (text, re) => text.match(re)?.[1]?.trim() || '';

/**
 * Wertet den Text der Seiten aus.
 * @param {{ n:number, lines:string[], text:string }[]} pages
 * @param {string} fileName  Fallback für Bestellnummer/Auftrag („630-198033 231156 084113.pdf“)
 */
export function parseOrderPages(pages, fileName = '') {
  const all = pages.map((p) => p.text).join('\n');
  const kinds = pages.map((p) => KNOWN_PAGES.find(([, re]) => re.test(p.text))?.[0] || '');
  const order = pages[kinds.indexOf('bestellung')] || pages[0];
  const oText = order?.text || '';

  // Auftragsnummer: „Charge: P231156Q“ → 231156 (sonst „Prod.-Auftrag : 630231156“)
  const nr = first(all, /Charge\s*:?\s*P(\d{6})[A-Z]?\b/)
    || first(all, /Prod\.?-?\s*Auftrag\s*:?\s*630-?(\d{6})\b/)
    || first(fileName, /\b630-\d{6}\s+(\d{6})\b/);

  // Bestellnummer: „630-198033“ auf der Bestellseite (nicht die Auftragsnummer selbst)
  const bestellnr = (oText.match(/\b\d{3}-\d{6}\b/g) || []).find((x) => x !== `630-${nr}`)
    || first(fileName, /\b(\d{3}-\d{6})\b/);

  // Menge: Positionszeile „10 400,0000 sa 000000007000 …“
  const mengeT = first(oText, /(?:^|\n)\s*\d{1,4}\s+([\d.]+,\d+)\s+sa\b/i)
    || first(all, /Auftragsmenge(?:\s*-\s*Satz)?\s*:?\s*([\d.]+,\d+)/);
  const menge = mengeT ? Math.round(deNum(mengeT)) : null;

  // Preis je Satz: „02.12.2026 1,3181 sa 527,24 EUR“
  const priceT = first(oText, /\d{2}\.\d{2}\.\d{4}\s+([\d.]+,\d{2,4})\s+sa\s+[\d.]+,\d{2}\s+EUR/i);
  const price = priceT ? deNum(priceT) : null;

  // Artikel aus den „Fremdbearbeitungsdaten“
  const artNr = digitsOnly(first(oText, /Artikel\s*:\s*([\d .-]{9,20})/) || first(all, /Artikelcode\s*:?\s*(\d{9,14})/));
  const name = first(oText, /Bezeichnung\s*:\s*([^\n]+)/);
  const perT = first(all, /SA\/Pal\s*:?\s*([\d.]+,\d+|\d+)/) || first(all, /Anzahl SA\/Palette\s*([\d.]+,\d+|\d+)/);
  const perPallet = perT ? Math.round(deNum(perT)) : null;

  // Stückliste: „35/2 0012 526.024-01 Corrugatedbox 002 NoB 0,0500 st N EK-Artikel 46 …“
  const bom = [];
  pages.forEach((p, i) => {
    if (kinds[i] !== 'stueckliste') return;
    for (const line of p.lines) {
      const m = line.match(/^(\d+\/\d+)\s+(\d{4}\s?\d{3}\.\d{3}-\d{2})\s+(.*)$/);
      if (!m) continue;
      const rest = m[3];
      const q = rest.match(/^(.*?)\s+(\d+,\d+)\s+(\S+)\s+([JN])\b(.*)$/);
      const description = (q ? q[1] : rest).replace(/\s{2,}/g, ' ').trim();
      const tail = q ? q[5] : rest;
      const type = /EK-Artikel/i.test(tail) ? 'EK' : /Fertigung/i.test(tail) ? 'Fertigung' : '';
      const nrDigits = digitsOnly(m[2]);
      if (bom.some((b) => b.nr === nrDigits)) continue; // doppelte Zeilen (z. B. Ribbon) nur einmal
      bom.push({ pos: m[1], nr: nrDigits, display: m[2], description, qty: q ? deNum(q[2]) : null, unit: q ? q[3] : '', type });
    }
  });

  // Pläne: alle Seiten, die keine bekannte ERP-Seite sind. „Packplan“ im Text → Packplan,
  // sonst (meist reine Zeichnung ohne Text) → Beladungsplan. Folgeseiten gehören dazu.
  const loadingBom = bom.find((b) => /loading\s*plan|beladungsplan/i.test(b.description));
  const packBom = bom.find((b) => /pack\s*plan/i.test(b.description));
  const plans = [];
  pages.forEach((p, i) => {
    if (kinds[i]) return;
    const kind = /Packplan/i.test(p.text) ? 'packplan' : 'beladungsplan';
    const startsNew = /Seite\s+1\s+von\b|Page\s+1\s+of\b/i.test(p.text);
    const prev = plans[plans.length - 1];
    if (prev && prev.kind === kind && prev.pages[prev.pages.length - 1] === p.n - 1 && !startsNew) prev.pages.push(p.n);
    else plans.push({ kind, pages: [p.n] });
  });
  for (const pl of plans) {
    if (pl.kind === 'packplan') {
      const fromText = first(pages[pl.pages[0] - 1].text, /Packplanname\s*:?\s*\n?\s*([^\n]+)/);
      pl.name = packBom?.description || fromText || 'Packplan';
      pl.nr = packBom?.display || first(pages[pl.pages[0] - 1].text, /(\d{4}\s?\d{3}\.\d{3}-\d{2})/);
    } else {
      const short = loadingBom?.description.replace(/^\s*(loading\s*plan|beladungsplan)\s*/i, '').trim();
      pl.name = `Beladungsplan${short ? ` ${short}` : ''}`;
      pl.nr = loadingBom?.display || '';
    }
  }
  // Gleich benannte Pläne durchnummerieren
  const seen = {};
  for (const pl of plans) {
    seen[pl.name] = (seen[pl.name] || 0) + 1;
    if (seen[pl.name] > 1) pl.name = `${pl.name} ${seen[pl.name]}`;
  }

  return { nr, bestellnr, menge, price, artNr, name, perPallet, bom, plans, pageKinds: kinds };
}

/** Schneidet Seiten (1-basiert) als eigenes PDF heraus. */
export async function extractPages(bytes, pageNumbers) {
  const { PDFDocument } = await loadPdfLib();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageNumbers.map((n) => n - 1));
  copied.forEach((p) => out.addPage(p));
  return new Blob([await out.save()], { type: 'application/pdf' });
}

/** Kleines Vorschaubild (oberer Teil der ersten Seite) als JPEG-Data-URL. */
export async function pdfThumb(bytes, pageNumber = 1, size = 200) {
  const lib = await loadPdfJs();
  const task = lib.getDocument({ data: bytes.slice(0), isEvalSupported: false });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: size / base.width });
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return c.toDataURL('image/jpeg', 0.6);
  } finally {
    task.destroy();
  }
}
