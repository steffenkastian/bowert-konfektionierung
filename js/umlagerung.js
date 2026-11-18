// Umlagerungsschein: füllt die Excel-Vorlage (UmlagerungsscheinBOWERT.xlsx) aus.
//
// Es wird nur das Nötigste in der Datei geändert, alles andere bleibt Byte für Byte erhalten
// (Kopf „von/an“, Lager, Spalten, Logo, Druckeinstellungen):
//   - Spalte A „Anzahl Paletten“ der passenden Teile-Nr. (Spalte B) – alle anderen A-Werte werden geleert
//   - Material, das nicht in der Liste steht, wird unten als neue Zeile angehängt
//   - Zeilen ohne Paletten werden wie in der Vorlage per Autofilter ausgeblendet
//   - C6 bleibt die Formel =HEUTE(); der gespeicherte Wert wird auf das Erstelldatum gesetzt

const SHEET = 'xl/worksheets/sheet1.xml';
const SHARED = 'xl/sharedStrings.xml';
const WORKBOOK = 'xl/workbook.xml';
const FIRST_DATA_ROW = 10; // Zeile 9/10 = Kopf (verbunden), Daten ab 11 – Filterbereich beginnt bei 9

export const digits = (v) => String(v ?? '').replace(/\D/g, '');
/** „001259501400“ → „0012 595 014 00“ (Schreibweise der Vorlage). */
export const formatPartNo = (nr) => {
  const d = digits(nr);
  return d.length === 12 ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7, 10)} ${d.slice(10)}` : String(nr ?? '').trim();
};
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function sharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => xmlText([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
}

const ROW_RE = /<row r="(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const cellRe = (ref) => new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);

function cellText(body, ref, shared) {
  const m = body?.match(cellRe(ref));
  if (!m) return '';
  const attrs = m[1];
  const inner = m[2] || '';
  if (/t="s"/.test(attrs)) return shared[Number(inner.match(/<v>(\d+)<\/v>/)?.[1])] ?? '';
  if (/t="inlineStr"/.test(attrs)) return xmlText(inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] || '');
  return xmlText(inner.match(/<v>([\s\S]*?)<\/v>/)?.[1] || '');
}

/** Liest die Materialliste der Vorlage: [{ row, nr, name }]. */
export function readTemplate(fflate, bytes) {
  const files = fflate.unzipSync(bytes);
  if (!files[SHEET] || !files[SHARED]) throw new Error('Das ist keine passende Excel-Vorlage (Tabellenblatt fehlt).');
  const dec = new TextDecoder();
  const sheet = dec.decode(files[SHEET]);
  const shared = sharedStrings(dec.decode(files[SHARED]));
  if (!/Anzahl/.test(cellText(sheet.match(/<row r="9"[\s\S]*?<\/row>/)?.[0], 'A9', shared))) {
    throw new Error('In der Vorlage fehlt die Spalte „Anzahl Paletten“ (A9).');
  }
  const rows = [];
  for (const m of sheet.matchAll(ROW_RE)) {
    const r = Number(m[1]);
    if (r <= FIRST_DATA_ROW) continue;
    const nr = cellText(m[3], `B${r}`, shared).trim();
    const name = cellText(m[3], `C${r}`, shared).trim();
    if (nr || name) rows.push({ row: r, nr, name });
  }
  return { files, sheet, rows };
}

/** Excel-Datumszahl (Tage seit 30.12.1899) für ein lokales Datum. */
const excelDate = (d) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 864e5);

/**
 * Erstellt den Umlagerungsschein.
 * items: [{ nr, description, qty }] – qty = Anzahl Paletten.
 * Gibt { bytes, matched, appended } zurück.
 */
export function fillUmlagerung(fflate, templateBytes, items, date = new Date()) {
  const { files, sheet, rows } = readTemplate(fflate, templateBytes);
  const byKey = new Map();
  for (const r of rows) { const k = digits(r.nr); if (k && !byKey.has(k)) byKey.set(k, r.row); }

  const qtyByRow = new Map();
  const appended = [];
  const matched = [];
  for (const it of items) {
    const qty = Math.round(Number(it.qty) || 0);
    if (qty <= 0) continue;
    const row = byKey.get(digits(it.nr));
    if (row) {
      qtyByRow.set(row, (qtyByRow.get(row) || 0) + qty);
      matched.push({ ...it, row });
    } else {
      const same = appended.find((a) => digits(a.nr) && digits(a.nr) === digits(it.nr));
      if (same) same.qty += qty; else appended.push({ ...it, qty });
    }
  }

  // Bestehende Zeilen: Spalte A setzen/leeren, Ein-/Ausblenden
  let lastRow = 0;
  let out = sheet.replace(ROW_RE, (whole, rStr, attrs, body) => {
    const r = Number(rStr);
    lastRow = Math.max(lastRow, r);
    if (r < FIRST_DATA_ROW) return whole;
    const qty = qtyByRow.get(r) || 0;
    let newAttrs = attrs.replace(/ hidden="1"/, '');
    if (!qty) newAttrs = newAttrs.replace(/^( spans="[^"]*")?/, (s) => `${s} hidden="1"`);
    if (r === FIRST_DATA_ROW) return `<row r="${r}"${newAttrs}${body == null ? '/>' : `>${body}</row>`}`;
    let b = body || '';
    const ref = `A${r}`;
    const existing = b.match(cellRe(ref));
    const style = existing?.[1].match(/ s="(\d+)"/)?.[1] || '6';
    const cell = qty ? `<c r="${ref}" s="${style}"><v>${qty}</v></c>` : `<c r="${ref}" s="${style}"/>`;
    if (existing) b = b.replace(existing[0], cell);
    else if (qty) {
      b = cell + b;
      newAttrs = newAttrs.replace(/ spans="\d+:(\d+)"/, ' spans="1:$1"');
    }
    return `<row r="${r}"${newAttrs}>${b}</row>`;
  });

  // Unbekannte Teile-Nr. unten anhängen (Formate wie die Zeilen darüber)
  const extra = appended.map((it, i) => {
    const r = lastRow + 1 + i;
    const inline = (ref, s, text) => `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
    return `<row r="${r}" spans="1:7" ht="15.75" customHeight="1" x14ac:dyDescent="0.2">`
      + `<c r="A${r}" s="6"><v>${it.qty}</v></c>${inline(`B${r}`, 4, formatPartNo(it.nr))}${inline(`C${r}`, 5, it.description || '')}`
      + `<c r="D${r}" s="5"/><c r="E${r}" s="5"/><c r="F${r}" s="14"/><c r="G${r}" s="26"/></row>`;
  }).join('');
  const last = lastRow + appended.length;
  out = out.replace('</sheetData>', `${extra}</sheetData>`);

  // Bereich, Filter (nur Zeilen mit Paletten sichtbar), Datum
  out = out.replace(/<dimension ref="A1:G\d+"\/>/, `<dimension ref="A1:G${last}"/>`);
  const values = [...new Set([...qtyByRow.values(), ...appended.map((a) => a.qty)])].sort((a, b) => a - b);
  out = out.replace(/<autoFilter ref="A9:G\d+"([^>]*)>([\s\S]*?)<\/autoFilter>/, (m, a, inner) => {
    const rest = inner.replace(/<filterColumn[\s\S]*?<\/filterColumn>/g, '');
    const filter = values.length
      ? `<filterColumn colId="0"><filters>${values.map((v) => `<filter val="${v}"/>`).join('')}</filters></filterColumn>` : '';
    return `<autoFilter ref="A9:G${last}"${a}>${filter}${rest}</autoFilter>`;
  });
  out = out.replace(/(<c r="C6"[^>]*><f[^>]*>[^<]*<\/f><v>)\d+(<\/v>)/, `$1${excelDate(date)}$2`);
  out = out.replace(/<selection activeCell="[A-Z]+\d+" sqref="[A-Z]+\d+"\/>/, '<selection activeCell="A9" sqref="A9"/>');

  const enc = new TextEncoder();
  const result = { ...files, [SHEET]: enc.encode(out) };
  if (files[WORKBOOK]) {
    const wb = new TextDecoder().decode(files[WORKBOOK])
      .replace(/(Schein!\$A\$9:\$G\$)\d+/, `$1${last}`);
    result[WORKBOOK] = enc.encode(wb);
  }
  return { bytes: fflate.zipSync(result, { level: 6 }), matched, appended };
}

// ---------- im Browser ----------

let loading = null;
/** fflate (ZIP) bei Bedarf laden. */
export function loadFflate() {
  loading ||= new Promise((resolve, reject) => {
    if (window.fflate) { resolve(window.fflate); return; }
    const s = document.createElement('script');
    s.src = new URL('../vendor/fflate/fflate.umd.js', import.meta.url).href;
    s.onload = () => resolve(window.fflate);
    s.onerror = () => { loading = null; reject(new Error('Excel-Modul konnte nicht geladen werden (keine Verbindung?).')); };
    document.head.append(s);
  });
  return loading;
}
