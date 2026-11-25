// Packhinweise: Fotos verkleinern, Vorschaubilder erzeugen, PDFs anzeigen.

const MAX_SIDE = 2200;              // Fotos: längste Seite in Pixel (reicht zum Lesen von Packschemata)
const QUALITY = 0.85;
const THUMB = 200;                  // Vorschaubild (quadratisch, wird am Artikel mitgespeichert)
const MAX_BYTES = 15 * 1024 * 1024; // Obergrenze je Datei
export const ACCEPT = 'image/*,application/pdf,.pdf';

export const isPdf = (f) => f.type === 'application/pdf';

export function fileSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

const stripExt = (name) => name.replace(/\.[a-z0-9]{2,5}$/i, '').trim();
/** Kamera-Dateinamen („IMG_1234“, „image“, „PXL_2026…“) durch „Foto 16.11.“ ersetzen. */
function photoName(file) {
  const base = stripExt(file.name || '');
  if (base && !/^(image|photo|foto|img|pxl|dsc|dcim|mvimg|screenshot)?[\s_-]*[\d_\s-]*$/i.test(base)) return base;
  const d = new Date();
  return `Foto ${d.getDate()}.${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`„${file.name}“ lässt sich nicht als Bild lesen.`));
    };
    img.src = url;
  });
}

function canvasFor(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // transparente PNGs bekommen weißen statt schwarzen Hintergrund
  ctx.fillRect(0, 0, w, h);
  return { c, ctx };
}

const toBlob = (canvas, quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht verarbeitet werden.'))), 'image/jpeg', quality));

/** Bereitet eine gewählte Datei zum Hochladen vor → { blob, name, type, thumb }. */
export async function prepareUpload(file) {
  const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (pdf) {
    if (file.size > MAX_BYTES) throw new Error(`„${file.name}“ ist zu groß (${fileSize(file.size)}, max. ${fileSize(MAX_BYTES)}).`);
    return { blob: file, name: stripExt(file.name) || 'Packhinweis', type: 'application/pdf', thumb: '' };
  }
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error(`„${file.name}“: Bitte ein Foto oder eine PDF-Datei wählen.`);
  }

  const img = await loadImage(file);
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;

  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const big = canvasFor(w, h);
  big.ctx.drawImage(img, 0, 0, w, h);
  let blob = await toBlob(big.c, QUALITY);
  let type = 'image/jpeg';
  // Kleine, schon passende Bilder (z. B. Screenshots) unverändert lassen, wenn das kleiner ist.
  if (scale === 1 && file.size <= blob.size && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    blob = file;
    type = file.type;
  }
  if (blob.size > MAX_BYTES) throw new Error(`„${file.name}“ ist zu groß.`);

  // Quadratisches Vorschaubild (Bildmitte)
  const side = Math.min(w0, h0);
  const t = canvasFor(THUMB, THUMB);
  t.ctx.drawImage(img, (w0 - side) / 2, (h0 - side) / 2, side, side, 0, 0, THUMB, THUMB);
  const thumb = t.c.toDataURL('image/jpeg', 0.6);

  return { blob, name: photoName(file), type, thumb };
}

// ---------- PDF anzeigen (pdf.js, wird erst bei Bedarf geladen) ----------

let pdfjs = null;
export async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
  }
  return pdfjs;
}

/**
 * Zeichnet alle Seiten eines PDFs untereinander in `box`. Gibt eine Funktion zum Aufräumen zurück.
 * `isAlive` verhindert, dass nach dem Verlassen der Ansicht weitergezeichnet wird.
 */
export async function renderPdf(blob, box, isAlive = () => true) {
  const lib = await loadPdfJs();
  const task = lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false });
  const pdf = await task.promise;
  const width = box.clientWidth || 360;
  // Etwas schärfer als nötig, damit man mit zwei Fingern reinzoomen kann – aber speicherschonend.
  const ratio = Math.min(window.devicePixelRatio || 1, 2) * 1.5;
  for (let n = 1; n <= pdf.numPages && isAlive(); n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / base.width) * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = 'pdf-page';
    canvas.setAttribute('aria-label', `Seite ${n} von ${pdf.numPages}`);
    box.append(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();
  }
  return () => task.destroy();
}
