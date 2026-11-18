// Datenhaltung: Firebase Firestore (online, für alle Mitarbeiter gemeinsam, mit Offline-Cache).
//
// Struktur:
//   orders/{id}     { nr, articleId, note, status, after, bestellnr, menge }
//                   nr: die 6 Ziffern nach „630-“ (auf dem Lieferschein steht „630-“ davor)
//                   menge: Satz, die zum Auftrag gehören (optional)
//                   status: „neu“ (nicht begonnen) | „naechstes“ (als nächstes) | „arbeit“ (in Arbeit)
//                           | „fertig“ (abgeschlossen)
//                   after: bei „naechstes“ die ID des laufenden Auftrags, nach dem er drankommt („“ = keiner)
//   articles/{id}   { name, materialIds: [], files: [], perPallet, lsText }
//                   Artikelbezeichnung (z. B. „5er“) → Materialien; perPallet = Satz pro Palette,
//                   lsText = Text auf dem Lieferschein (leer → „Konfektionierung - <Bezeichnung>“)
//                   files: Packhinweise (Foto/PDF) als { id, name, type, size, parts, thumb, createdAt }
//   deliveries/{orderId}_{datum}  { orderId, date, entries: [{ id, at, qty, pallets }], no, … }
//                   Fertige Paletten/Satz eines Auftrags an einem Tag. Mit Nummer (no) ist es ein
//                   Lieferschein; Menge und Paletten ergeben sich immer aus den Einträgen.
//   settings/lieferschein  { next }   nächste freie Lieferscheinnummer (JJJJ + laufende Nummer)
//   files/{fileId}-{n}  { articleId, fileId, part, parts, data: Bytes }
//                   Dateiinhalt in Stücken < 1 MB (Firestore-Grenze je Dokument). Wird nicht live
//                   abgeglichen, sondern erst beim Öffnen geladen (danach im Offline-Cache).
//   materials/{id}  { nr, description, location }         Artikelnummer + optionale Beschreibung/Lagerort
//   orderlist/{id}  { materialId, qty, status }           Bestellliste: status „offen“ | „bestellt“
//                   offene Einträge haben die feste ID „offen-<materialId>“, damit mehrere Handys
//                   gleichzeitig hochzählen können, ohne doppelte Zeilen zu erzeugen.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch,
  increment, arrayUnion, arrayRemove, getDoc, getDocFromCache, Bytes, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, TEAM_EMAIL } from './config.js';
import { norm, natCmp } from './ui.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const COLLECTIONS = ['orders', 'articles', 'materials', 'orderlist', 'deliveries', 'settings'];
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
export const login = (password) => signInWithEmailAndPassword(auth, TEAM_EMAIL, password);
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
  let article = findArticleByName(articleName);
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

export function saveArticle({ id, name, perPallet = '', lsText = '' }) {
  name = str(name);
  if (!name) throw new Error('Bitte eine Artikelbezeichnung eingeben.');
  const dupe = findArticleByName(name);
  if (dupe && dupe.id !== id) throw new Error(`Artikel „${dupe.name}“ gibt es schon.`);
  const per = parseCount(perPallet, 'Satz pro Palette');
  if (per === 0) throw new Error('Satz pro Palette: bitte mindestens 1 eingeben (oder leer lassen).');
  const articleId = id || newId('articles');
  const fields = { name, perPallet: per, lsText: str(lsText), updatedAt: now() };
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
const deliveryKey = (orderId, date) => `${orderId}_${date}`;
export const deliveryFor = (orderId, date) => data.deliveries.get(deliveryKey(orderId, date));
export const entriesOf = (d) => [...(d?.entries || [])].sort((a, b) => (a.at || '').localeCompare(b.at || ''));
export const deliveryQty = (d) => (d?.entries || []).reduce((sum, e) => sum + (Number(e.qty) || 0), 0);
export const deliveryPallets = (d) => (d?.entries || []).reduce((sum, e) => sum + (Number(e.pallets) || 0), 0);
/** Lieferschein schon erstellt, danach aber Menge/Paletten geändert → neu verschicken. */
export const deliveryChanged = (d) => Boolean(d?.no)
  && (d.printedQty !== deliveryQty(d) || d.printedPallets !== deliveryPallets(d));
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
export const deliveredBefore = (d) => deliveriesOfOrder(d.orderId)
  .filter((x) => x.no && x.id !== d.id && x.date < d.date)
  .reduce((sum, x) => sum + deliveryQty(x), 0);

function checkEntry({ qty, pallets, date }) {
  const q = parseCount(qty, 'Satz');
  const p = parseCount(pallets, 'Paletten') ?? 0;
  if (!q) throw new Error('Bitte die Anzahl Satz eingeben.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Bitte ein Datum wählen.');
  return { qty: q, pallets: p };
}

function snapshotFields(o) {
  return { orderNr: o?.nr || '' };
}

/** Fertige Palette / Satz für einen Auftrag eintragen (Tag: `date`). */
export function addEntry(orderId, { date = localDate(), qty, pallets }) {
  const o = getOrder(orderId);
  if (!o) throw new Error('Auftrag nicht gefunden.');
  const v = checkEntry({ qty, pallets, date });
  const id = deliveryKey(orderId, date);
  const entry = { id: newId('deliveries'), at: now(), ...v };
  const existing = data.deliveries.get(id);
  run(setDoc(doc(db, 'deliveries', id), {
    orderId, date, ...snapshotFields(o), entries: arrayUnion(entry), updatedAt: now(),
  }, { merge: true }));
  data.deliveries.set(id, { ...existing, id, orderId, date, ...snapshotFields(o), entries: [...(existing?.entries || []), entry] });
  emit();
  return { delivery: data.deliveries.get(id), entry };
}

/** Eintrag ändern; bei anderem Datum wandert er zur Lieferung dieses Tages. */
export function updateEntry(deliveryId, entryId, { date, qty, pallets }) {
  const d = data.deliveries.get(deliveryId);
  const old = d?.entries?.find((e) => e.id === entryId);
  if (!old) throw new Error('Eintrag nicht gefunden.');
  const v = checkEntry({ qty, pallets, date });
  if (date === d.date) {
    const entries = d.entries.map((e) => (e.id === entryId ? { ...e, ...v } : e));
    run(updateDoc(doc(db, 'deliveries', d.id), { entries, updatedAt: now() }));
    d.entries = entries;
    emit();
    return d;
  }
  const batch = writeBatch(db);
  const rest = d.entries.filter((e) => e.id !== entryId);
  if (!rest.length && !d.no) {
    batch.delete(doc(db, 'deliveries', d.id));
    data.deliveries.delete(d.id);
  } else {
    batch.update(doc(db, 'deliveries', d.id), { entries: rest, updatedAt: now() });
    d.entries = rest;
  }
  const o = getOrder(d.orderId);
  const targetId = deliveryKey(d.orderId, date);
  const moved = { ...old, ...v };
  batch.set(doc(db, 'deliveries', targetId), {
    orderId: d.orderId, date, ...snapshotFields(o) , entries: arrayUnion(moved), updatedAt: now(),
  }, { merge: true });
  const target = data.deliveries.get(targetId);
  data.deliveries.set(targetId, { ...target, id: targetId, orderId: d.orderId, date, ...snapshotFields(o),
    entries: [...(target?.entries || []), moved] });
  run(batch.commit());
  emit();
  return data.deliveries.get(targetId);
}

export function removeDeliveryEntry(deliveryId, entryId) {
  const d = data.deliveries.get(deliveryId);
  if (!d) return;
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
 * Vergibt Lieferscheinnummern (fortlaufend, in einer Transaktion – auch wenn zwei Handys
 * gleichzeitig erstellen, gibt es keine doppelten Nummern). Braucht eine Internetverbindung.
 */
export async function createDeliveryNotes(ids) {
  if (!navigator.onLine) throw new Error('Für die Lieferscheinnummer wird eine Internetverbindung gebraucht.');
  const settingsRef = doc(db, 'settings', 'lieferschein');
  const created = await runTransaction(db, async (tx) => {
    const s = await tx.get(settingsRef);
    const snaps = [];
    for (const id of ids) snaps.push(await tx.get(doc(db, 'deliveries', id)));
    let next = nextFree(s.exists() ? s.data().next : null);
    const out = [];
    for (const snap of snaps) {
      if (!snap.exists()) continue;
      const d = { id: snap.id ?? snap.ref.id, ...snap.data() };
      if (d.no || !deliveryQty(d)) continue;
      const o = getOrder(d.orderId);
      const a = getArticle(o?.articleId);
      const fields = {
        no: String(next), createdAt: now(), createdOn: localDate(), updatedAt: now(),
        printedQty: deliveryQty(d), printedPallets: deliveryPallets(d),
        orderNr: o?.nr || d.orderNr || '', bestellnr: o?.bestellnr || '', text: lsTextOf(a), menge: o?.menge || null,
      };
      tx.update(snap.ref, fields);
      out.push({ id: d.id, ...fields });
      next += 1;
    }
    tx.set(settingsRef, { next, updatedAt: now() }, { merge: true });
    return out;
  });
  for (const c of created) Object.assign(data.deliveries.get(c.id) || {}, c);
  emit();
  return created;
}

/** Daten für das PDF – aktuelle Auftrags-/Artikeldaten, sonst die beim Erstellen gemerkten. */
export function noteData(d) {
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

/** Nach dem Teilen/Drucken: aktuellen Stand als „verschickt“ merken. */
export function markPrinted(ids) {
  const batch = writeBatch(db);
  let any = false;
  for (const id of ids) {
    const d = data.deliveries.get(id);
    if (!d?.no || !deliveryChanged(d)) continue;
    const fields = { printedQty: deliveryQty(d), printedPallets: deliveryPallets(d) };
    batch.update(doc(db, 'deliveries', id), fields);
    Object.assign(d, fields);
    any = true;
  }
  if (any) { run(batch.commit()); emit(); }
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
  const list = str(to).split(/[,;\s]+/).filter(Boolean);
  const bad = list.find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
  if (bad) throw new Error(`Bitte eine gültige E-Mail-Adresse eingeben („${bad}“).`);
  if (list.length > 5) throw new Error('Höchstens 5 Empfänger.');
  to = list.join(', ');
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
  }, null, 2);
}

function withoutId(obj) {
  const { id, ...rest } = obj;
  return rest;
}
