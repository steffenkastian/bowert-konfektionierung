// Datenhaltung: Firebase Firestore (online, für alle Mitarbeiter gemeinsam, mit Offline-Cache).
//
// Struktur:
//   orders/{id}     { nr, articleId, note, status, after, bestellnr, menge, labels, labelsAt }
//                   labels: Etiketten „“ (noch nichts) | „bestellt“ | „gedruckt“
//                   nr: die 6 Ziffern nach „630-“ (auf dem Lieferschein steht „630-“ davor)
//                   menge: Satz, die zum Auftrag gehören (optional)
//                   status: „neu“ (nicht begonnen) | „naechstes“ (als nächstes) | „arbeit“ (in Arbeit)
//                           | „fertig“ (abgeschlossen)
//                   after: bei „naechstes“ die ID des laufenden Auftrags, nach dem er drankommt („“ = keiner)
//   articles/{id}   { name, artNr, materialIds: [], files: [], perPallet, lsText }
//                   artNr = Artikelnummer (optional, eindeutig)
//                   Artikelbezeichnung (z. B. „5er“) → Materialien; perPallet = Satz pro Palette,
//                   lsText = Text auf dem Lieferschein (leer → „Konfektionierung - <Bezeichnung>“)
//                   files: Packhinweise (Foto/PDF) als { id, name, type, size, parts, thumb, createdAt }
//   deliveries/{orderId}_offen     { orderId, date, entries: [{ id, at, qty, pallets }] }
//                   Gesammelte fertige Paletten/Satz eines Auftrags, noch ohne Lieferschein.
//   deliveries/{orderId}_{datum}[_2…]  { …, no, createdOn }
//                   „Lieferscheine erstellen“ macht aus allem Gesammelten einen Lieferschein mit dem Datum
//                   dieses Tages (weitere am selben Tag: _2, _3 …); danach wird neu gesammelt.
//                   Menge und Paletten ergeben sich immer aus den Einträgen.
//                   (Ältere Lieferungen ohne Nummer unter {orderId}_{datum} zählen ebenfalls als gesammelt.)
//   settings/lieferschein  { next, to }   nächste freie Lieferscheinnummer (JJJJ + laufende Nummer),
//                   Empfänger für den automatischen Versand
//   archive/{deliveryId}_v{n}  { deliveryId, no, version, note, pdf: Bytes, sentTo, sentAt }
//                   Genau das PDF, das verschickt/geteilt wurde, plus die eingefrorenen Daten (für die
//                   Abrechnung). Wird nicht live abgeglichen, sondern bei Bedarf geladen.
//                   Am Lieferschein: versions: [{ v, at, qty, pallets, sentTo }], snap = Daten der letzten Fassung
//   files/{fileId}-{n}  { articleId, fileId, part, parts, data: Bytes }
//                   Dateiinhalt in Stücken < 1 MB (Firestore-Grenze je Dokument). Wird nicht live
//                   abgeglichen, sondern erst beim Öffnen geladen (danach im Offline-Cache).
//   materials/{id}  { nr, description, location }         Artikelnummer + optionale Beschreibung/Lagerort
//   orderlist/{id}  { materialId, qty, status }           Bestellliste: status „offen“ | „bestellt“
//                   offene Einträge haben die feste ID „offen-<materialId>“, damit mehrere Handys
//                   gleichzeitig hochzählen können, ohne doppelte Zeilen zu erzeugen.
//
// Nur Abrechnungs-Konto (für das Team-Konto in firestore.rules gesperrt):
//   prices/{articleId}  { list: [{ from: 'JJJJ-MM-TT', price }] }   Nettopreis pro Satz ab Datum
//   invoices/{nr}       Rechnung bzw. Storno mit eingefrorenen Daten (Positionen, Summen, Lieferscheine + Fassung)
//   invoicePdfs/{nr}    { pdf: Bytes }  die erstellte Rechnung; die Lieferscheine kommen aus dem Archiv dahinter
//   billing/settings    { nextInvoiceNo }
// Abgerechnete Lieferscheine tragen invoice: { id, no } und sind gesperrt (auch in den Regeln).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch,
  increment, arrayUnion, arrayRemove, getDoc, getDocFromCache, Bytes, runTransaction, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, TEAM_EMAIL, BILLING_EMAIL, IS_BILLING } from './config.js';
import { norm, natCmp } from './ui.js';

// Eigener App-Name für die Abrechnung → eigene Anmeldung und eigener Offline-Cache im selben Browser.
const app = IS_BILLING ? initializeApp(firebaseConfig, 'abrechnung') : initializeApp(firebaseConfig);
export { IS_BILLING };
export const ACCOUNT_EMAIL = IS_BILLING ? BILLING_EMAIL : TEAM_EMAIL;
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const COLLECTIONS = ['orders', 'articles', 'materials', 'orderlist', 'deliveries', 'settings',
  ...(IS_BILLING ? ['prices', 'invoices', 'billing'] : [])];
const data = Object.fromEntries(COLLECTIONS.map((c) => [c, new Map()]));
const meta = {};
const loaded = new Set();
const listeners = new Set();
let unsubscribers = [];
let errorHandler = (e) => console.error(e);

const now = () => new Date().toISOString();
const str = (v) => (v == null ? '' : String(v).trim());
const newId = (col) => doc(collection(db, col)).id;

function emit() { listeners.forEach((fn) => fn()); }

/** Schreibvorgänge nicht abwarten (offline bleiben sie bis zur Verbindung offen), Fehler aber melden. */
const run = (promise) => { promise.catch((e) => errorHandler(e)); };

export const onChange = (fn) => listeners.add(fn);
export const onError = (fn) => { errorHandler = fn; };

// ---------- Anmeldung ----------

export const watchAuth = (cb) => onAuthStateChanged(auth, cb);
export const login = (password) => signInWithEmailAndPassword(auth, ACCOUNT_EMAIL, password);
/** Angemeldet, aber mit dem falschen Konto für diese App (z. B. alte Sitzung)? */
export const isRightAccount = (user) => user?.email === ACCOUNT_EMAIL;
/** Anmelde-Token für den Mail-Dienst (wird dort bei Google geprüft). */
export function idToken() {
  if (!auth.currentUser) return Promise.reject(new Error('Nicht angemeldet.'));
  return auth.currentUser.getIdToken();
}
export async function logout() {
  stopSync();
  await signOut(auth);
}

// ---------- Live-Abgleich ----------

export function startSync() {
  stopSync();
  for (const name of COLLECTIONS) {
    unsubscribers.push(onSnapshot(collection(db, name), { includeMetadataChanges: true }, (snap) => {
      const map = data[name];
      map.clear();
      for (const d of snap.docs) map.set(d.id, { id: d.id, ...d.data() });
      meta[name] = snap.metadata;
      loaded.add(name);
      if (name === 'orders' && !snap.metadata.fromCache) migrateOrderNumbers();
      emit();
    }, (err) => errorHandler(err)));
  }
}

export function stopSync() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
}

export const isReady = () => loaded.size === COLLECTIONS.length;
export const syncState = () => ({
  pending: Object.values(meta).some((m) => m?.hasPendingWrites),
  fromCache: Object.values(meta).some((m) => m?.fromCache),
});

// ---------- Lesen ----------

export const orders = () => [...data.orders.values()];
export const articles = () => [...data.articles.values()];
export const materials = () => [...data.materials.values()];
export const orderlist = () => [...data.orderlist.values()];

export const getOrder = (id) => data.orders.get(id);
export const getArticle = (id) => data.articles.get(id);
export const getMaterial = (id) => data.materials.get(id);

export const ORDER_PREFIX = '630-';
/** „630-231084“ → „231084“ (in der App werden nur die 6 Ziffern gepflegt). */
export const shortNr = (nr) => str(nr).replace(/^630\s*-?\s*(?=\d)/, '');
export const fullNr = (nr) => (str(nr) ? `${ORDER_PREFIX}${shortNr(nr)}` : '');
export const findOrderByNr = (nr) => (norm(shortNr(nr)) ? orders().find((o) => norm(shortNr(o.nr)) === norm(shortNr(nr))) : undefined);

/** Einmalig: alte Einträge „630-xxxxxx“ auf die 6 Ziffern kürzen. */
let migrated = false;
function migrateOrderNumbers() {
  if (migrated) return;
  migrated = true;
  for (const o of orders()) {
    const short = shortNr(o.nr);
    if (short === o.nr || orders().some((x) => x.id !== o.id && norm(x.nr) === norm(short))) continue;
    run(updateDoc(doc(db, 'orders', o.id), { nr: short }));
    o.nr = short;
  }
}

/** Ganze Zahl ≥ 0 aus einer Eingabe („1.200“ → 1200); leer → null. */
export function parseCount(v, label = 'Menge') {
  const t = str(v).replace(/[.\s]/g, '');
  if (!t) return null;
  if (!/^\d+$/.test(t)) throw new Error(`${label}: bitte eine ganze Zahl eingeben.`);
  return Number(t);
}
export const findArticleByName = (name) => (norm(name) ? articles().find((a) => norm(a.name) === norm(name)) : undefined);
export const findArticleByNr = (nr) => (norm(nr) ? articles().find((a) => norm(a.artNr) === norm(nr)) : undefined);
/** Artikel zu einer Eingabe – Bezeichnung oder Artikelnummer. */
export const findArticle = (q) => findArticleByName(q) || findArticleByNr(q);
export const findMaterialByNr = (nr) => (norm(nr) ? materials().find((m) => norm(m.nr) === norm(nr)) : undefined);

export const articleMaterials = (a) => (a?.materialIds || []).map(getMaterial).filter(Boolean);
export const ordersWithArticle = (articleId) => orders().filter((o) => o.articleId === articleId);
export const articlesWithMaterial = (materialId) =>
  articles().filter((a) => (a.materialIds || []).includes(materialId));

export const locations = () => [...new Set(materials().map((m) => m.location).filter(Boolean))].sort(natCmp);
export const isEmpty = () => !data.orders.size && !data.articles.size && !data.materials.size;

// ---------- Aufträge ----------

/** Speichert einen Auftrag. Eine noch unbekannte Artikelbezeichnung wird dabei neu angelegt. */
export const ORDER_STATUSES = ['neu', 'naechstes', 'arbeit', 'fertig'];
export const orderStatus = (o) => (ORDER_STATUSES.includes(o?.status) ? o.status : 'neu');

/** Zeitstempel zum Status merken (z. B. für eine spätere Tagesübersicht). */
const statusStamps = (status) => ({
  status,
  ...(status === 'naechstes' ? { queuedAt: now() } : {}),
  ...(status === 'arbeit' ? { startedAt: now() } : {}),
  ...(status === 'fertig' ? { doneAt: now() } : {}),
});

/** Status setzen; bei „naechstes“ mit `after` = laufender Auftrag, nach dem er drankommt. */
export function setOrderStatus(id, status, { after = '' } = {}) {
  const o = getOrder(id);
  if (!o || !ORDER_STATUSES.includes(status) || id === after) return;
  if (orderStatus(o) === status && (status !== 'naechstes' || (o.after || '') === after)) return;
  const fields = { ...statusStamps(status), updatedAt: now() };
  if (status === 'naechstes') fields.after = after;
  run(updateDoc(doc(db, 'orders', id), fields));
  Object.assign(o, fields);
  emit();
}

/** Aufträge, die nach dem (laufenden) Auftrag `id` drankommen sollen – in der Reihenfolge der Planung. */
export const nextOrders = (id) => orders()
  .filter((o) => o.after === id && orderStatus(o) === 'naechstes')
  .sort((a, b) => (a.queuedAt || '').localeCompare(b.queuedAt || ''));

/** Etiketten eines Auftrags: '' → 'bestellt' → 'gedruckt' → '' */
export const LABEL_STATES = ['', 'bestellt', 'gedruckt'];
export const labelState = (o) => (LABEL_STATES.includes(o?.labels) ? o.labels : '');
export const nextLabelState = (o) => LABEL_STATES[(LABEL_STATES.indexOf(labelState(o)) + 1) % LABEL_STATES.length];
export function setOrderLabels(id, state) {
  const o = getOrder(id);
  if (!o || !LABEL_STATES.includes(state)) return;
  const fields = { labels: state, labelsAt: now(), updatedAt: now() };
  run(updateDoc(doc(db, 'orders', id), fields));
  Object.assign(o, fields);
  emit();
}

export function saveOrder({ id, nr, note, articleName, status = 'neu', after = '', bestellnr = '', menge = '' }) {
  nr = shortNr(nr).replace(/\s/g, '');
  if (nr && !/^\d{6}$/.test(nr)) throw new Error('Die Auftragsnummer hat 6 Ziffern (ohne „630-“), z. B. 231084.');
  const satz = parseCount(menge, 'Satz im Auftrag');
  articleName = str(articleName);
  if (!nr) throw new Error('Bitte eine Auftragsnummer eingeben.');
  if (!articleName) throw new Error('Bitte eine Artikelbezeichnung wählen oder eingeben.');
  const dupe = findOrderByNr(nr);
  if (dupe && dupe.id !== id) throw new Error(`Auftrag ${dupe.nr} gibt es schon.`);

  const batch = writeBatch(db);
  let article = findArticle(articleName);
  if (!article) {
    article = { id: newId('articles'), name: articleName, materialIds: [], createdAt: now(), updatedAt: now() };
    batch.set(doc(db, 'articles', article.id), withoutId(article));
    data.articles.set(article.id, article);
  }
  const orderId = id || newId('orders');
  const fields = { nr, note: str(note), articleId: article.id, bestellnr: str(bestellnr), menge: satz, updatedAt: now() };
  if (!id) fields.createdAt = now();
  if (!ORDER_STATUSES.includes(status)) status = 'neu';
  const prev = id ? getOrder(id) : null;
  const relinked = status === 'naechstes' && (prev?.after || '') !== after;
  if (!prev || orderStatus(prev) !== status || relinked) Object.assign(fields, statusStamps(status));
  if (status === 'naechstes') fields.after = after === orderId ? '' : after;
  batch.set(doc(db, 'orders', orderId), fields, { merge: true });
  data.orders.set(orderId, { ...data.orders.get(orderId), id: orderId, ...fields });
  run(batch.commit());
  emit();
  return data.orders.get(orderId);
}

export function deleteOrder(id) {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'orders', id));
  // Wer nach diesem Auftrag drankommen sollte, bleibt „als nächstes“, nur ohne Vorgänger.
  for (const n of nextOrders(id)) {
    batch.update(doc(db, 'orders', n.id), { after: '', updatedAt: now() });
    n.after = '';
  }
  run(batch.commit());
  data.orders.delete(id);
  emit();
}

// ---------- Artikel ----------

export const lsTextOf = (a) => str(a?.lsText) || (a ? `Konfektionierung - ${a.name}` : '');

export function saveArticle({ id, name, artNr = '', perPallet = '', lsText = '' }) {
  name = str(name);
  artNr = str(artNr);
  if (!name) throw new Error('Bitte eine Artikelbezeichnung eingeben.');
  const dupe = findArticleByName(name);
  if (dupe && dupe.id !== id) throw new Error(`Artikel „${dupe.name}“ gibt es schon.`);
  const nrDupe = findArticleByNr(artNr);
  if (nrDupe && nrDupe.id !== id) throw new Error(`Die Artikelnummer ${artNr} hat schon „${nrDupe.name}“.`);
  const per = parseCount(perPallet, 'Satz pro Palette');
  if (per === 0) throw new Error('Satz pro Palette: bitte mindestens 1 eingeben (oder leer lassen).');
  const articleId = id || newId('articles');
  const fields = { name, artNr, perPallet: per, lsText: str(lsText), updatedAt: now() };
  if (!id) Object.assign(fields, { materialIds: [], createdAt: now() });
  run(setDoc(doc(db, 'articles', articleId), fields, { merge: true }));
  data.articles.set(articleId, { materialIds: [], ...data.articles.get(articleId), id: articleId, ...fields });
  emit();
  return data.articles.get(articleId);
}

export function deleteArticle(id) {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'articles', id));
  for (const f of articleFiles(getArticle(id))) deleteFileParts(batch, f);
  for (const o of ordersWithArticle(id)) {
    batch.update(doc(db, 'orders', o.id), { articleId: '', updatedAt: now() });
    o.articleId = '';
  }
  run(batch.commit());
  data.articles.delete(id);
  emit();
}

/**
 * Ordnet einem Artikel ein Material (per Artikelnummer) zu. Gibt es die Nummer schon,
 * wird das bestehende Material verwendet und Beschreibung/Lagerort aktualisiert.
 */
export function addMaterialToArticle(articleId, { nr, description, location }) {
  const a = getArticle(articleId);
  if (!a) throw new Error('Artikel nicht gefunden.');
  nr = str(nr);
  if (!nr) throw new Error('Bitte die Artikelnummer des Materials eingeben.');

  const batch = writeBatch(db);
  let m = findMaterialByNr(nr);
  const fields = { nr, description: str(description), location: str(location), updatedAt: now() };
  if (m) {
    batch.set(doc(db, 'materials', m.id), fields, { merge: true });
    Object.assign(m, fields);
  } else {
    m = { id: newId('materials'), ...fields, createdAt: now() };
    batch.set(doc(db, 'materials', m.id), withoutId(m));
    data.materials.set(m.id, m);
  }
  batch.update(doc(db, 'articles', a.id), { materialIds: arrayUnion(m.id), updatedAt: now() });
  a.materialIds = [...new Set([...(a.materialIds || []), m.id])];
  run(batch.commit());
  emit();
  return m;
}

export function removeMaterialFromArticle(articleId, materialId) {
  const a = getArticle(articleId);
  if (!a) return;
  run(updateDoc(doc(db, 'articles', articleId), { materialIds: arrayRemove(materialId), updatedAt: now() }));
  a.materialIds = (a.materialIds || []).filter((x) => x !== materialId);
  emit();
}

// ---------- Packhinweise (Fotos / PDFs je Artikel) ----------

const FILE_PART = 900_000; // Bytes je Dokument (Firestore erlaubt knapp 1 MiB)
const partId = (fileId, i) => `${fileId}-${i}`;
const fileCache = new Map(); // fileId → Blob (zuletzt geöffnete Dateien im Speicher)

export const articleFiles = (a) => a?.files || [];
export const getArticleFile = (a, fileId) => articleFiles(a).find((f) => f.id === fileId);

function cacheFile(id, blob) {
  fileCache.delete(id);
  fileCache.set(id, blob);
  while (fileCache.size > 12) fileCache.delete(fileCache.keys().next().value);
}

function deleteFileParts(batch, f) {
  for (let i = 0; i < (f.parts || 1); i++) batch.delete(doc(db, 'files', partId(f.id, i)));
}

/**
 * Hängt eine Datei an einen Artikel. Erst die Datenstücke, dann der Eintrag am Artikel –
 * Firestore überträgt Schreibvorgänge in dieser Reihenfolge, andere Handys sehen die Datei
 * also erst, wenn ihr Inhalt vollständig da ist. Offline wird später hochgeladen.
 */
export async function addArticleFile(articleId, { blob, name, type, thumb = '' }) {
  const a = getArticle(articleId);
  if (!a) throw new Error('Artikel nicht gefunden.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const id = newId('files');
  const parts = Math.max(1, Math.ceil(bytes.length / FILE_PART));
  for (let i = 0; i < parts; i++) {
    const data = Bytes.fromUint8Array(bytes.subarray(i * FILE_PART, (i + 1) * FILE_PART));
    run(setDoc(doc(db, 'files', partId(id, i)), { articleId, fileId: id, part: i, parts, data, createdAt: now() }));
  }
  const meta = { id, name: str(name) || 'Packhinweis', type, size: bytes.length, parts, thumb, createdAt: now() };
  run(updateDoc(doc(db, 'articles', articleId), { files: arrayUnion(meta), updatedAt: now() }));
  a.files = [...articleFiles(a), meta];
  cacheFile(id, blob);
  emit();
  return meta;
}

export function renameArticleFile(articleId, fileId, name) {
  const a = getArticle(articleId);
  name = str(name);
  if (!a || !name) return;
  const files = articleFiles(a).map((f) => (f.id === fileId ? { ...f, name } : f));
  run(updateDoc(doc(db, 'articles', articleId), { files, updatedAt: now() }));
  a.files = files;
  emit();
}

export function removeArticleFile(articleId, fileId) {
  const a = getArticle(articleId);
  const f = getArticleFile(a, fileId);
  if (!f) return;
  const batch = writeBatch(db);
  batch.update(doc(db, 'articles', articleId), { files: arrayRemove(f), updatedAt: now() });
  deleteFileParts(batch, f);
  run(batch.commit());
  a.files = articleFiles(a).filter((x) => x.id !== fileId);
  fileCache.delete(fileId);
  emit();
}

/** Lädt den Inhalt einer Datei (Speicher → Offline-Cache → Server). */
export async function loadFile(f) {
  if (fileCache.has(f.id)) return fileCache.get(f.id);
  const chunks = await Promise.all(Array.from({ length: f.parts || 1 }, async (_, i) => {
    const ref = doc(db, 'files', partId(f.id, i));
    let snap = await getDocFromCache(ref).catch(() => null);
    if (!snap?.exists()) {
      try {
        snap = await getDoc(ref);
      } catch (ex) {
        if (ex.code === 'unavailable' || !navigator.onLine) {
          throw new Error('Ohne Empfang nicht verfügbar – die Datei wurde auf diesem Handy noch nie geöffnet.');
        }
        throw ex;
      }
    }
    if (!snap.exists()) throw new Error('Datei nicht gefunden – evtl. wird sie gerade noch hochgeladen.');
    return snap.data().data.toUint8Array();
  }));
  const blob = new Blob(chunks, { type: f.type });
  cacheFile(f.id, blob);
  return blob;
}

// ---------- Material ----------

export function saveMaterial({ id, nr, description, location }) {
  nr = str(nr);
  if (!nr) throw new Error('Bitte die Artikelnummer eingeben.');
  const dupe = findMaterialByNr(nr);
  if (dupe && dupe.id !== id) throw new Error(`Artikelnummer ${dupe.nr} gibt es schon.`);
  const materialId = id || newId('materials');
  const fields = { nr, description: str(description), location: str(location), updatedAt: now() };
  if (!id) fields.createdAt = now();
  run(setDoc(doc(db, 'materials', materialId), fields, { merge: true }));
  data.materials.set(materialId, { ...data.materials.get(materialId), id: materialId, ...fields });
  emit();
  return data.materials.get(materialId);
}

export function deleteMaterial(id) {
  const batch = writeBatch(db);
  batch.delete(doc(db, 'materials', id));
  for (const a of articlesWithMaterial(id)) {
    batch.update(doc(db, 'articles', a.id), { materialIds: arrayRemove(id), updatedAt: now() });
    a.materialIds = a.materialIds.filter((x) => x !== id);
  }
  for (const e of orderlist().filter((x) => x.materialId === id)) {
    batch.delete(doc(db, 'orderlist', e.id));
    data.orderlist.delete(e.id);
  }
  run(batch.commit());
  data.materials.delete(id);
  emit();
}

// ---------- Bestellliste ----------

const openId = (materialId) => `offen-${materialId}`;
export const openQty = (materialId) => data.orderlist.get(openId(materialId))?.qty || 0;

/** „Entnehmen“: Material landet auf der Bestellliste (bzw. Menge +1). Gibt die neue Menge zurück. */
export function takeMaterial(materialId) {
  const id = openId(materialId);
  const existing = data.orderlist.get(id);
  const fields = { materialId, status: 'offen', qty: increment(1), updatedAt: now() };
  if (!existing) fields.createdAt = now();
  run(setDoc(doc(db, 'orderlist', id), fields, { merge: true }));
  data.orderlist.set(id, {
    ...existing, id, materialId, status: 'offen', qty: (existing?.qty || 0) + 1,
    createdAt: existing?.createdAt || now(), updatedAt: now(),
  });
  emit();
  return data.orderlist.get(id).qty;
}

/** Menge eines Eintrags ändern; bei 0 wird er entfernt. */
export function changeQty(entryId, delta) {
  const e = data.orderlist.get(entryId);
  if (!e) return;
  const qty = (e.qty || 0) + delta;
  if (qty <= 0) { removeEntry(entryId); return; }
  run(updateDoc(doc(db, 'orderlist', entryId), { qty: increment(delta), updatedAt: now() }));
  e.qty = qty;
  emit();
}

export const changeOpenQty = (materialId, delta) => changeQty(openId(materialId), delta);

export function removeEntry(entryId) {
  run(deleteDoc(doc(db, 'orderlist', entryId)));
  data.orderlist.delete(entryId);
  emit();
}

/** Offene Einträge als „bestellt“ markieren (werden zu eigenen Einträgen mit Bestelldatum). */
export function markOrdered(entryIds) {
  const batch = writeBatch(db);
  for (const id of entryIds) {
    const e = data.orderlist.get(id);
    if (!e || e.status !== 'offen') continue;
    const next = { id: newId('orderlist'), materialId: e.materialId, qty: e.qty, status: 'bestellt',
      createdAt: e.createdAt || now(), orderedAt: now(), updatedAt: now() };
    batch.set(doc(db, 'orderlist', next.id), withoutId(next));
    batch.delete(doc(db, 'orderlist', id));
    data.orderlist.delete(id);
    data.orderlist.set(next.id, next);
  }
  run(batch.commit());
  emit();
}

/** Bestellten Eintrag zurück auf „offen“ (Menge wird zu einem evtl. offenen Eintrag addiert). */
export function reopenEntry(entryId) {
  const e = data.orderlist.get(entryId);
  if (!e) return;
  const id = openId(e.materialId);
  const existing = data.orderlist.get(id);
  const batch = writeBatch(db);
  batch.set(doc(db, 'orderlist', id), {
    materialId: e.materialId, status: 'offen', qty: increment(e.qty || 1),
    createdAt: existing?.createdAt || e.createdAt || now(), updatedAt: now(),
  }, { merge: true });
  batch.delete(doc(db, 'orderlist', entryId));
  run(batch.commit());
  data.orderlist.delete(entryId);
  data.orderlist.set(id, { ...existing, id, materialId: e.materialId, status: 'offen',
    qty: (existing?.qty || 0) + (e.qty || 1), createdAt: existing?.createdAt || e.createdAt, updatedAt: now() });
  emit();
}

// ---------- Paletten & Lieferscheine ----------

const pad2 = (n) => String(n).padStart(2, '0');
/** Datum als „JJJJ-MM-TT“ in Ortszeit. */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const DEFAULT_NEXT_NO = 20261197;

export const deliveries = () => [...data.deliveries.values()];
export const getDelivery = (id) => data.deliveries.get(id);
/** Gesammelte Paletten eines Auftrags (noch ohne Lieferschein) liegen unter fester ID – mehrere Handys sammeln mit. */
const collectKey = (orderId) => `${orderId}_offen`;
/** Alle gesammelten Lieferungen (ohne Nummer) – auch ältere, die noch unter einem Tag liegen. */
export const collected = () => deliveries().filter((d) => !d.no && deliveryQty(d));
export const collectedOf = (orderId) => collected().filter((d) => d.orderId === orderId);
export const entriesOf = (d) => [...(d?.entries || [])].sort((a, b) => (a.at || '').localeCompare(b.at || ''));
export const deliveryQty = (d) => (d?.entries || []).reduce((sum, e) => sum + (Number(e.qty) || 0), 0);
export const deliveryPallets = (d) => (d?.entries || []).reduce((sum, e) => sum + (Number(e.pallets) || 0), 0);
/** Lieferschein schon erstellt, danach aber Menge/Paletten geändert → neu verschicken. */
/** Zuletzt verschickte Fassung. Lieferscheine aus v3.0/3.1 (vor dem Archiv) haben nur printedQty. */
export function lastSent(d) {
  const v = d?.versions;
  if (v?.length) return [...v].sort((a, b) => a.v - b.v)[v.length - 1];
  return d?.printedQty != null ? { v: 0, qty: d.printedQty, pallets: d.printedPallets, legacy: true } : null;
}
/** Verschickt, danach aber Menge/Paletten geändert → korrigierte Fassung senden. */
export const deliveryChanged = (d) => {
  const l = d?.no && lastSent(d);
  return Boolean(l) && (l.qty !== deliveryQty(d) || l.pallets !== deliveryPallets(d));
};
/** offen (ohne Nummer) | erstellt (noch nicht verschickt) | geaendert | verschickt */
export function deliveryState(d) {
  if (!d?.no) return 'offen';
  if (!lastSent(d)) return 'erstellt';
  return deliveryChanged(d) ? 'geaendert' : 'verschickt';
}
const byDateNo = (a, b) => a.date.localeCompare(b.date) || String(a.no || '').localeCompare(String(b.no || ''));
export const deliveriesOfOrder = (orderId) => deliveries().filter((d) => d.orderId === orderId).sort(byDateNo);
export const deliveriesOn = (date) => deliveries().filter((d) => d.date === date);

/** Satz eines Auftrags: auf Lieferscheinen (geliefert) und noch ohne Lieferschein (offen). */
export function orderProgress(orderId) {
  let delivered = 0;
  let open = 0;
  for (const d of deliveriesOfOrder(orderId)) {
    if (d.no) delivered += deliveryQty(d); else open += deliveryQty(d);
  }
  return { delivered, open, done: delivered + open, total: getOrder(orderId)?.menge || 0 };
}

/** „Gesamtliefermenge des Auftrages bisher“: Lieferscheine dieses Auftrags vor diesem Tag. */
/** (Mehrere Lieferscheine am selben Tag: nach Nummer; noch ohne Nummer: alle bisherigen.) */
export const deliveredBefore = (d) => deliveriesOfOrder(d.orderId)
  .filter((x) => x.no && x.id !== d.id && (!d.no || x.date < d.date || (x.date === d.date && Number(x.no) < Number(d.no))))
  .reduce((sum, x) => sum + deliveryQty(x), 0);

/** Abgerechnet → gesperrt (erst nach Storno der Rechnung wieder änderbar). */
export const invoiceOf = (d) => d?.invoice || null;
export function assertEditable(d) {
  const inv = invoiceOf(d);
  if (inv) throw new Error(`Lieferschein ${d.no} ist abgerechnet (Rechnung ${formatInvoiceNo(inv.no)}) und kann nicht mehr geändert werden.`);
}

function checkEntry({ qty, pallets }) {
  const q = parseCount(qty, 'Satz');
  const p = parseCount(pallets, 'Paletten') ?? 0;
  if (!q) throw new Error('Bitte die Anzahl Satz eingeben.');
  return { qty: q, pallets: p };
}

function snapshotFields(o) {
  return { orderNr: o?.nr || '' };
}

/**
 * Fertige Palette / Satz für einen Auftrag eintragen. Sie wird gesammelt, bis „Lieferscheine erstellen“
 * gedrückt wird – der Lieferschein bekommt dann das Datum dieses Tages. (date = Tag des letzten Eintrags.)
 */
export function addEntry(orderId, { qty, pallets }) {
  const o = getOrder(orderId);
  if (!o) throw new Error('Auftrag nicht gefunden.');
  const v = checkEntry({ qty, pallets });
  const id = collectKey(orderId);
  const date = localDate();
  const entry = { id: newId('deliveries'), at: now(), ...v };
  const existing = data.deliveries.get(id);
  run(setDoc(doc(db, 'deliveries', id), {
    orderId, date, ...snapshotFields(o), entries: arrayUnion(entry), updatedAt: now(),
  }, { merge: true }));
  data.deliveries.set(id, { ...existing, id, orderId, date, ...snapshotFields(o), entries: [...(existing?.entries || []), entry] });
  emit();
  return { delivery: data.deliveries.get(id), entry };
}

/** Menge/Paletten eines Eintrags ändern (bei einem Lieferschein: danach neu verschicken). */
export function updateEntry(deliveryId, entryId, { qty, pallets }) {
  const d = data.deliveries.get(deliveryId);
  const old = d?.entries?.find((e) => e.id === entryId);
  if (!old) throw new Error('Eintrag nicht gefunden.');
  assertEditable(d);
  const v = checkEntry({ qty, pallets });
  const entries = d.entries.map((e) => (e.id === entryId ? { ...e, ...v } : e));
  run(updateDoc(doc(db, 'deliveries', d.id), { entries, updatedAt: now() }));
  d.entries = entries;
  emit();
  return d;
}

export function removeDeliveryEntry(deliveryId, entryId) {
  const d = data.deliveries.get(deliveryId);
  if (!d) return;
  assertEditable(d);
  const rest = (d.entries || []).filter((e) => e.id !== entryId);
  if (!rest.length && !d.no) {
    run(deleteDoc(doc(db, 'deliveries', d.id)));
    data.deliveries.delete(d.id);
  } else {
    run(updateDoc(doc(db, 'deliveries', d.id), { entries: rest, updatedAt: now() }));
    d.entries = rest;
  }
  emit();
}

export function deleteDelivery(id) {
  const d = data.deliveries.get(id);
  assertEditable(d);
  for (const v of d?.versions || []) run(deleteDoc(doc(db, 'archive', `${id}_v${v.v}`)));
  run(deleteDoc(doc(db, 'deliveries', id)));
  data.deliveries.delete(id);
  emit();
}

/** Nächste freie Lieferscheinnummer; im neuen Jahr beginnt sie mit JJJJ0001. */
function nextFree(stored, year = new Date().getFullYear()) {
  let next = Number(stored) || DEFAULT_NEXT_NO;
  if (Math.floor(next / 10000) < year) next = year * 10000 + 1;
  return next;
}
export const nextDeliveryNo = () => nextFree(data.settings.get('lieferschein')?.next);

export function setNextDeliveryNo(value) {
  const n = parseCount(value, 'Lieferscheinnummer');
  if (!n || String(n).length !== 8) throw new Error('Die Lieferscheinnummer hat 8 Ziffern, z. B. 20261197.');
  const used = deliveries().filter((d) => Number(d.no) >= n).map((d) => d.no).sort();
  if (used.length) throw new Error(`Nummer ${used[0]} ist schon vergeben – bitte eine höhere wählen.`);
  run(setDoc(doc(db, 'settings', 'lieferschein'), { next: n, updatedAt: now() }, { merge: true }));
  data.settings.set('lieferschein', { ...data.settings.get('lieferschein'), id: 'lieferschein', next: n });
  emit();
}

/**
 * Macht aus den gesammelten Paletten Lieferscheine mit dem heutigen Datum (je Auftrag einer, alles Gesammelte
 * zusammen) und vergibt die Nummern fortlaufend – in einer Transaktion, damit es auch bei zwei Handys keine
 * doppelten Nummern gibt. Danach wird für den Auftrag neu gesammelt. Ist heute schon ein Lieferschein für den
 * Auftrag erstellt, entsteht ein weiterer ({orderId}_{datum}_2 …). Braucht eine Internetverbindung.
 * ids: gesammelte Lieferungen (ohne Nummer). Gibt die neuen Lieferscheine zurück ({ id, no, … }).
 */
export async function createDeliveryNotes(ids) {
  if (!navigator.onLine) throw new Error('Für die Lieferscheinnummer wird eine Internetverbindung gebraucht.');
  const settingsRef = doc(db, 'settings', 'lieferschein');
  const today = localDate();
  const res = await runTransaction(db, async (tx) => {
    // Erst alles lesen (Transaktion: Lesen vor Schreiben)
    const s = await tx.get(settingsRef);
    const groups = new Map();
    for (const id of [...new Set(ids)]) {
      const snap = await tx.get(doc(db, 'deliveries', id));
      if (!snap.exists()) continue;
      const d = { id, ...snap.data() };
      if (d.no || !d.orderId) continue;
      if (!groups.has(d.orderId)) groups.set(d.orderId, []);
      groups.get(d.orderId).push(d);
    }
    const plan = [];
    for (const [orderId, sources] of [...groups].sort(([a], [b]) => natCmpOrders(a, b))) {
      const entries = sources.flatMap((d) => d.entries || []).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
      if (!deliveryQty({ entries })) continue;
      let targetId = '';
      for (let i = 1; !targetId; i += 1) {
        const cand = `${orderId}_${today}${i > 1 ? `_${i}` : ''}`;
        if (sources.some((d) => d.id === cand) || !(await tx.get(doc(db, 'deliveries', cand))).exists()) targetId = cand;
      }
      plan.push({ orderId, sources, entries, targetId });
    }
    // Dann schreiben
    let next = nextFree(s.exists() ? s.data().next : null);
    const out = [];
    for (const { orderId, sources, entries, targetId } of plan) {
      const o = getOrder(orderId);
      const a = getArticle(o?.articleId);
      const fields = {
        orderId, date: today, entries,
        no: String(next), createdAt: now(), createdOn: today, updatedAt: now(),
        orderNr: o?.nr || sources[0].orderNr || '', bestellnr: o?.bestellnr || '', text: lsTextOf(a), menge: o?.menge || null,
      };
      tx.set(doc(db, 'deliveries', targetId), fields);
      for (const d of sources) if (d.id !== targetId) tx.delete(doc(db, 'deliveries', d.id));
      out.push({ id: targetId, sourceIds: sources.map((d) => d.id), ...fields });
      next += 1;
    }
    tx.set(settingsRef, { next, updatedAt: now() }, { merge: true });
    return out;
  });
  for (const c of res) {
    const { sourceIds, ...fields } = c;
    for (const id of sourceIds) { data.deliveries.delete(id); madeInto.set(id, c.id); }
    data.deliveries.set(c.id, fields);
  }
  emit();
  return res;
}
/** Gesammelt-ID → daraus erstellter Lieferschein (nur für diese Sitzung, damit offene Ansichten folgen können). */
const madeInto = new Map();
export const createdFrom = (id) => madeInto.get(id) || '';
/** Reihenfolge der Nummern: nach Auftragsnummer. */
const natCmpOrders = (a, b) => String(getOrder(a)?.nr || '').localeCompare(String(getOrder(b)?.nr || ''), 'de', { numeric: true });

/**
 * Daten für das PDF. Ist die Fassung schon verschickt und unverändert, gelten die eingefrorenen Daten
 * (snap) – so entsteht später exakt derselbe Lieferschein. Sonst aktuelle Auftrags-/Artikeldaten.
 */
export function noteData(d) {
  if (d.snap && !deliveryChanged(d) && d.snap.qty === deliveryQty(d)) return { ...d.snap, id: d.id };
  const o = getOrder(d.orderId);
  const a = getArticle(o?.articleId);
  return {
    id: d.id,
    no: d.no,
    orderNr: fullNr(o?.nr || d.orderNr),
    bestellnr: o ? str(o.bestellnr) : str(d.bestellnr),
    deliveryDate: d.date,
    date: d.createdOn || localDate(),
    qty: deliveryQty(d),
    pallets: deliveryPallets(d),
    text: a ? lsTextOf(a) : d.text || '',
    prev: deliveredBefore(d),
    total: o ? o.menge || 0 : d.menge || 0,
  };
}

/**
 * Verschickte/geteilte Fassung archivieren: genau dieses PDF + eingefrorene Daten.
 * notes: [{ id, note, pdf: Uint8Array }], sentTo: Empfänger oder '' (geteilt/gedruckt).
 */
export function archiveNotes(notes, sentTo = '', { replaceVersions = false, legacy = false } = {}) {
  const batch = writeBatch(db);
  for (const { id, note, pdf } of notes) {
    const d = data.deliveries.get(id);
    if (!d?.no || invoiceOf(d)) continue;
    const versions = replaceVersions ? [] : [...(d.versions || [])];
    const v = (versions.reduce((m, x) => Math.max(m, x.v), 0)) + 1;
    const meta = { v, at: now(), qty: note.qty, pallets: note.pallets, sentTo: str(sentTo), ...(legacy ? { legacy: true } : {}) };
    const frozen = { ...note };
    delete frozen.id;
    batch.set(doc(db, 'archive', `${id}_v${v}`), {
      deliveryId: id, no: d.no, version: v, note: frozen, pdf: Bytes.fromUint8Array(pdf), sentTo: str(sentTo), sentAt: now(),
    });
    const all = [...versions, meta];
    batch.update(doc(db, 'deliveries', id), { versions: all, snap: frozen, updatedAt: now() });
    Object.assign(d, { versions: all, snap: frozen });
  }
  const done = batch.commit();
  run(done);
  emit();
  return done;
}

/** Archiviertes PDF einer Fassung laden. */
export async function loadArchivedPdf(deliveryId, v) {
  const ref = doc(db, 'archive', `${deliveryId}_v${v}`);
  let snap = await getDocFromCache(ref).catch(() => null);
  if (!snap?.exists()) snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Archivierte Fassung nicht gefunden.');
  return snap.data().pdf.toUint8Array();
}

/** Lieferscheine aus der Zeit vor dem Archiv (nur printedQty, unverändert) → einmalig archivieren. */
export const legacyToArchive = () => deliveries()
  .filter((d) => d.no && !d.versions?.length && d.printedQty != null && !deliveryChanged(d));

export const lsMailTo = () => data.settings.get('lieferschein')?.to || '';
export function setLsMailTo(to) {
  const list = parseRecipients(to);
  run(setDoc(doc(db, 'settings', 'lieferschein'), { to: list, updatedAt: now() }, { merge: true }));
  data.settings.set('lieferschein', { ...data.settings.get('lieferschein'), id: 'lieferschein', to: list });
  emit();
}

function parseRecipients(to) {
  const list = str(to).split(/[,;\s]+/).filter(Boolean);
  const bad = list.find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
  if (bad) throw new Error(`Bitte eine gültige E-Mail-Adresse eingeben („${bad}“).`);
  if (list.length > 5) throw new Error('Höchstens 5 Empfänger.');
  return list.join(', ');
}

// ---------- Umlagerungsschein ----------
// settings/umlagerung { xlsx: Bytes, name, size, uploadedAt, to }  – Excel-Vorlage + Mail-Empfänger

export const umlagerungSettings = () => data.settings.get('umlagerung') || {};
export function umlagerungTemplate() {
  const x = umlagerungSettings().xlsx;
  return x?.toUint8Array ? x.toUint8Array() : null;
}

export function saveUmlagerungTemplate(bytes, name) {
  if (bytes.length > 900_000) throw new Error('Die Vorlage ist zu groß (max. 900 KB).');
  const fields = { xlsx: Bytes.fromUint8Array(bytes), name: str(name) || 'Vorlage.xlsx', size: bytes.length, uploadedAt: now() };
  run(setDoc(doc(db, 'settings', 'umlagerung'), fields, { merge: true }));
  data.settings.set('umlagerung', { ...umlagerungSettings(), id: 'umlagerung', ...fields });
  emit();
}

export function setUmlagerungMail(to) {
  to = parseRecipients(to);
  run(setDoc(doc(db, 'settings', 'umlagerung'), { to, updatedAt: now() }, { merge: true }));
  data.settings.set('umlagerung', { ...umlagerungSettings(), id: 'umlagerung', to });
  emit();
}

// ---------- Mailversand (Google Apps Script im Gmail-Arbeitskonto) ----------
// settings/mail { url }  – Web-App-URL des Skripts (mail/Code.gs)

export const mailService = () => data.settings.get('mail')?.url || '';
export function setMailService(url) {
  url = str(url);
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw new Error('Bitte die Web-App-URL aus Apps Script einfügen (https://script.google.com/macros/s/…/exec).');
  }
  run(setDoc(doc(db, 'settings', 'mail'), { url, updatedAt: now() }, { merge: true }));
  data.settings.set('mail', { ...data.settings.get('mail'), id: 'mail', url });
  emit();
}

// ---------- Export ----------

export function exportJSON() {
  return JSON.stringify({
    app: 'bowert-konfektionierung', version: 2, exportedAt: now(),
    orders: orders(), articles: articles(), materials: materials(), orderlist: orderlist(),
    deliveries: deliveries().map((d) => ({ ...d, qty: deliveryQty(d), pallets: deliveryPallets(d) })),
    ...(IS_BILLING ? { prices: [...data.prices.values()], invoices: invoices() } : {}),
  }, null, 2);
}

function withoutId(obj) {
  const { id, ...rest } = obj;
  return rest;
}

// ======================================================================
// Abrechnung: Preise, Umsatz, Rechnungen (nur in der Abrechnungs-App)
// ======================================================================

export const VAT_RATE = 0.19;
const DEFAULT_INVOICE_NO = 20260548;
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const deDate = (iso) => String(iso || '').split('-').reverse().join('.');

// ---------- Preise ----------

/** „0,4525“ / „0.4525“ / „1.234,50 €“ → Zahl (max. 4 Nachkommastellen). */
export function parsePrice(v) {
  let t = str(v).replace(/[€\s]/g, '');
  if (!t) throw new Error('Bitte einen Preis eingeben.');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,4})?$/.test(t)) throw new Error('Preis bitte als Zahl mit höchstens 4 Nachkommastellen, z. B. 0,4525.');
  const n = Number(t);
  if (!(n > 0)) throw new Error('Der Preis muss größer als 0 sein.');
  return n;
}

/** Preisliste eines Artikels, älteste zuerst. */
export const priceList = (articleId) => [...(data.prices?.get(articleId)?.list || [])].sort((a, b) => a.from.localeCompare(b.from));
/** Preis, der an einem Tag galt (oder null). */
export function priceAt(articleId, date) {
  let p = null;
  for (const x of priceList(articleId)) if (x.from <= date) p = x.price;
  return p;
}
export const currentPrice = (articleId) => priceAt(articleId, localDate());

function writePrices(articleId, list) {
  list.sort((a, b) => a.from.localeCompare(b.from));
  run(setDoc(doc(db, 'prices', articleId), { list, updatedAt: now() }));
  data.prices.set(articleId, { id: articleId, list });
  emit();
}

/** Lieferscheine dieses Artikels, deren Preis sich durch die Änderung verschieben würde und die schon abgerechnet sind. */
function billedAffected(articleId, list) {
  const at = (date) => { let p = null; for (const x of list) if (x.from <= date) p = x.price; return p; };
  return deliveries().find((d) => invoiceOf(d) && articleOf(d) === articleId && at(d.date) !== priceAt(articleId, d.date));
}

export function setPrice(articleId, { from, price }) {
  if (!getArticle(articleId)) throw new Error('Artikel nicht gefunden.');
  if (!isDate(from)) throw new Error('Bitte das Datum wählen, ab dem der Preis gilt.');
  const p = parsePrice(price);
  const list = [...priceList(articleId).filter((x) => x.from !== from), { from, price: p }].sort((a, b) => a.from.localeCompare(b.from));
  const hit = billedAffected(articleId, list);
  if (hit) throw new Error(`Das würde den schon abgerechneten Lieferschein ${hit.no} (${deDate(hit.date)}) ändern. Bitte ein späteres Datum wählen.`);
  writePrices(articleId, list);
}

const dayBefore = (iso) => { const d = new Date(`${iso}T12:00`); d.setDate(d.getDate() - 1); return localDate(d); };
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

/** „11“, „11,5“, „-3“ → Zahl (Prozent). */
export function parsePercent(v) {
  const t = str(v).replace(/[%\s]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) throw new Error('Bitte den Prozentsatz als Zahl eingeben, z. B. 11 oder 2,5.');
  const n = Number(t);
  if (!n || n <= -50 || n > 100) throw new Error('Der Prozentsatz muss zwischen -50 und 100 liegen (nicht 0).');
  return n;
}

/**
 * Vorschau einer Preiserhöhung: neuer Preis = Preis am Vortag × (1 + p/100), auf 4 Nachkommastellen gerundet.
 * Basis ist der Vortag, damit ein zweiter Klick mit demselben Datum nicht doppelt erhöht.
 */
export function priceRaisePlan(percent, from) {
  const p = parsePercent(percent);
  if (!isDate(from)) throw new Error('Bitte das Datum wählen, ab dem die neuen Preise gelten.');
  const base = dayBefore(from);
  return articles()
    .map((a) => {
      const old = priceAt(a.id, base);
      if (old == null) return null;
      const later = priceList(a.id).find((x) => x.from > from);
      return { articleId: a.id, name: a.name, old, price: round4(old * (1 + p / 100)), later };
    })
    .filter(Boolean)
    .sort((x, y) => natCmp(x.name, y.name));
}

/** Alle Preise ab `from` um `percent` % ändern (alles oder nichts). Gibt eine Funktion zum Rückgängigmachen zurück. */
export function raiseAllPrices(percent, from) {
  const plan = priceRaisePlan(percent, from);
  if (!plan.length) throw new Error('Kein Artikel hat vor diesem Datum einen Preis.');
  const lists = plan.map((x) => ({
    articleId: x.articleId,
    before: priceList(x.articleId),
    after: [...priceList(x.articleId).filter((y) => y.from !== from), { from, price: x.price }]
      .sort((a, b) => a.from.localeCompare(b.from)),
  }));
  for (const l of lists) {
    const hit = billedAffected(l.articleId, l.after);
    if (hit) throw new Error(`Ab ${deDate(from)} ist schon abgerechnet (Lieferschein ${hit.no} vom ${deDate(hit.date)}). Bitte ein späteres Datum wählen.`);
  }
  writePriceLists(lists.map((l) => [l.articleId, l.after]));
  return { count: lists.length, undo: () => writePriceLists(lists.map((l) => [l.articleId, l.before])) };
}

function writePriceLists(pairs) {
  const batch = writeBatch(db);
  for (const [articleId, list] of pairs) {
    batch.set(doc(db, 'prices', articleId), { list, updatedAt: now() });
    data.prices.set(articleId, { id: articleId, list });
  }
  run(batch.commit());
  emit();
}

export function removePrice(articleId, from) {
  const list = priceList(articleId).filter((x) => x.from !== from);
  const hit = billedAffected(articleId, list);
  if (hit) throw new Error(`Der Preis wurde schon abgerechnet (Lieferschein ${hit.no}) und kann nicht gelöscht werden.`);
  writePrices(articleId, list);
}

// ---------- Umsatz ----------

export const articleOf = (d) => getOrder(d.orderId)?.articleId || '';

/** Je Lieferung (Auftrag + Tag): Satz × Preis am Liefertag. amount = null, wenn der Preis fehlt. */
export function revenueRows() {
  const out = [];
  for (const d of deliveries()) {
    const qty = deliveryQty(d);
    if (!qty) continue;
    const articleId = articleOf(d);
    const price = articleId ? priceAt(articleId, d.date) : null;
    out.push({ d, date: d.date, articleId, qty, price, amount: price == null ? null : qty * price });
  }
  return out;
}

// ---------- Rechnungen ----------

export const invoices = () => [...(data.invoices?.values() || [])];
export const getInvoice = (id) => data.invoices?.get(id);
/** 20260548 → „2026 0548“ */
export const formatInvoiceNo = (no) => { const t = String(no || ''); return t.length === 8 ? `${t.slice(0, 4)} ${t.slice(4)}` : t; };

/** Vorschlag für die nächste Nummer (der Nummernkreis wird auch außerhalb der App benutzt → beim Erstellen prüfen). */
export function nextInvoiceNo(year = new Date().getFullYear()) {
  const used = invoices().map((i) => Number(i.no)).filter(Boolean);
  let next = Math.max(Number(data.billing?.get('settings')?.nextInvoiceNo) || DEFAULT_INVOICE_NO, ...used.map((n) => n + 1));
  if (Math.floor(next / 10000) < year) next = year * 10000 + 1;
  return next;
}

export function checkInvoiceNo(value) {
  const n = parseCount(value, 'Rechnungsnummer');
  if (!n || String(n).length !== 8) throw new Error('Die Rechnungsnummer hat 8 Ziffern, z. B. 20260548 (= 2026 0548).');
  if (data.invoices.has(String(n))) throw new Error(`Rechnung ${formatInvoiceNo(n)} gibt es schon.`);
  return String(n);
}

/** Lieferscheine eines Zeitraums, die noch nicht abgerechnet sind (+ Lieferungen ohne Lieferschein). */
export function billable(from, to) {
  const inRange = deliveries().filter((d) => d.date >= from && d.date <= to && deliveryQty(d) && !invoiceOf(d));
  return {
    notes: inRange.filter((d) => d.no).sort((a, b) => String(a.no).localeCompare(String(b.no))),
    withoutNo: inRange.filter((d) => !d.no).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Positionen je Artikel (und Preis), Summen, Kopfdaten – aus den gewählten Lieferscheinen. */
export function buildInvoice(list) {
  const groups = new Map();
  const missing = new Map();
  for (const d of list) {
    const articleId = articleOf(d);
    const n = noteData(d);
    const price = articleId ? priceAt(articleId, d.date) : null;
    if (price == null) { missing.set(articleId || d.id, getArticle(articleId)?.name || n.text || `Lieferschein ${d.no}`); continue; }
    const key = `${articleId}|${price}`;
    const g = groups.get(key) || { articleId, text: n.text, price, qty: 0 };
    g.qty += n.qty;
    groups.set(key, g);
  }
  const items = [...groups.values()]
    .sort((a, b) => natCmp(a.text, b.text) || a.price - b.price)
    .map((g) => ({ ...g, total: round2(g.qty * g.price) }));
  const netto = round2(items.reduce((s, i) => s + i.total, 0));
  const ust = round2(netto * VAT_RATE);
  const notes = list.map(noteData);
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  return {
    items, netto, ust, brutto: round2(netto + ust),
    missing: [...missing.values()],
    lieferdatum: list.reduce((m, d) => (d.date > m ? d.date : m), ''),
    orderNrs: uniq(notes.map((n) => n.orderNr)),
    bestellnrs: uniq(notes.map((n) => n.bestellnr)),
  };
}

/**
 * Rechnung festschreiben (Transaktion): Nummer prüfen, Lieferscheine sperren, Daten einfrieren.
 * Die Lieferscheine müssen vorher in ihrer aktuellen Fassung archiviert sein.
 */
export async function createInvoice({ no, date, from, to, list, extraLine = '', note = '' }) {
  if (!navigator.onLine) throw new Error('Zum Erstellen der Rechnung wird eine Internetverbindung gebraucht.');
  no = checkInvoiceNo(no);
  if (!isDate(date)) throw new Error('Bitte das Rechnungsdatum wählen.');
  if (!list.length) throw new Error('Keine Lieferscheine ausgewählt.');
  const { missing, ...calc } = buildInvoice(list);
  if (missing.length) throw new Error(`Preis fehlt: ${missing.join(', ')}`);
  const refs = list.map((d) => {
    const l = lastSent(d);
    // v: 0 = Altbestand nur mit printedQty (ohne PDF im Archiv); nachträglich archivierte Fassungen (legacy) zählen
    if (!l || l.v === 0 || deliveryChanged(d)) throw new Error(`Lieferschein ${d.no} ist noch nicht archiviert.`);
    const n = noteData(d);
    return { id: d.id, v: l.v, no: d.no, date: d.date, qty: n.qty, pallets: n.pallets, orderNr: n.orderNr, bestellnr: n.bestellnr };
  }).sort((a, b) => String(a.no).localeCompare(String(b.no)));
  const invoice = {
    no, type: 'rechnung', status: 'gueltig', date, from, to, ...calc,
    extraLine: str(extraLine), note: str(note), deliveries: refs, createdAt: now(),
  };
  const invRef = doc(db, 'invoices', no);
  await runTransaction(db, async (tx) => {
    if ((await tx.get(invRef)).exists()) throw new Error(`Rechnung ${formatInvoiceNo(no)} gibt es schon.`);
    const snaps = [];
    for (const r of refs) snaps.push(await tx.get(doc(db, 'deliveries', r.id)));
    snaps.forEach((snap, i) => {
      const d = snap.exists() ? snap.data() : null;
      if (!d) throw new Error(`Lieferschein ${refs[i].no} wurde gelöscht.`);
      if (d.invoice) throw new Error(`Lieferschein ${refs[i].no} ist schon abgerechnet (Rechnung ${formatInvoiceNo(d.invoice.no)}).`);
      if (deliveryQty(d) !== refs[i].qty) throw new Error(`Lieferschein ${refs[i].no} wurde gerade geändert – bitte neu laden.`);
    });
    tx.set(invRef, invoice);
    for (const r of refs) tx.update(doc(db, 'deliveries', r.id), { invoice: { id: no, no }, updatedAt: now() });
    tx.set(doc(db, 'billing', 'settings'), { nextInvoiceNo: Number(no) + 1, updatedAt: now() }, { merge: true });
  });
  data.invoices.set(no, { id: no, ...invoice });
  for (const r of refs) Object.assign(data.deliveries.get(r.id) || {}, { invoice: { id: no, no } });
  emit();
  return data.invoices.get(no);
}

/** Storno: eigene Storno-Rechnung (negativ), Original „storniert“, Lieferscheine wieder frei. */
export async function cancelInvoice(id, { no, date }) {
  if (!navigator.onLine) throw new Error('Zum Stornieren wird eine Internetverbindung gebraucht.');
  const orig = getInvoice(id);
  if (!orig || orig.type !== 'rechnung' || orig.status === 'storniert') throw new Error('Diese Rechnung kann nicht storniert werden.');
  no = checkInvoiceNo(no);
  if (!isDate(date)) throw new Error('Bitte das Datum wählen.');
  const neg = (n) => round2(-n);
  const storno = {
    no, type: 'storno', status: 'gueltig', refNo: orig.no, date, from: orig.from, to: orig.to,
    items: orig.items.map((i) => ({ ...i, qty: -i.qty, total: neg(i.total) })),
    netto: neg(orig.netto), ust: neg(orig.ust), brutto: neg(orig.brutto),
    lieferdatum: orig.lieferdatum, orderNrs: orig.orderNrs, bestellnrs: orig.bestellnrs,
    extraLine: '', note: '', deliveries: orig.deliveries, createdAt: now(),
  };
  const sRef = doc(db, 'invoices', no);
  await runTransaction(db, async (tx) => {
    if ((await tx.get(sRef)).exists()) throw new Error(`Rechnung ${formatInvoiceNo(no)} gibt es schon.`);
    const snaps = [];
    for (const r of orig.deliveries) snaps.push(await tx.get(doc(db, 'deliveries', r.id)));
    tx.set(sRef, storno);
    tx.update(doc(db, 'invoices', orig.id), { status: 'storniert', stornoNo: no, updatedAt: now() });
    snaps.forEach((snap, i) => {
      if (snap.exists() && snap.data().invoice?.id === orig.id) {
        tx.update(doc(db, 'deliveries', orig.deliveries[i].id), { invoice: deleteField(), updatedAt: now() });
      }
    });
    tx.set(doc(db, 'billing', 'settings'), { nextInvoiceNo: Number(no) + 1, updatedAt: now() }, { merge: true });
  });
  data.invoices.set(no, { id: no, ...storno });
  Object.assign(data.invoices.get(orig.id), { status: 'storniert', stornoNo: no });
  for (const r of orig.deliveries) {
    const d = data.deliveries.get(r.id);
    if (d?.invoice?.id === orig.id) delete d.invoice;
  }
  emit();
  return data.invoices.get(no);
}

/** PDF der Rechnung (nur die Rechnungsseiten) ablegen / laden. */
export function saveInvoicePdf(id, bytes) {
  if (bytes.length > 950_000) throw new Error('Das Rechnungs-PDF ist zu groß zum Archivieren.');
  const p = setDoc(doc(db, 'invoicePdfs', id), { pdf: Bytes.fromUint8Array(bytes), size: bytes.length, at: now() });
  run(p);
  return p;
}
export async function loadInvoicePdf(id) {
  const ref = doc(db, 'invoicePdfs', id);
  let snap = await getDocFromCache(ref).catch(() => null);
  if (!snap?.exists()) snap = await getDoc(ref);
  return snap.exists() ? snap.data().pdf.toUint8Array() : null;
}
