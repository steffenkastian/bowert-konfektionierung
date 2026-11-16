// Datenhaltung: Firebase Firestore (online, für alle Mitarbeiter gemeinsam, mit Offline-Cache).
//
// Struktur:
//   orders/{id}     { nr, articleId, note, status }       Auftragsnummer → eine Artikelbezeichnung
//                   status: „neu“ (nicht begonnen) | „arbeit“ (in Arbeit) | „fertig“ (abgeschlossen)
//   articles/{id}   { name, materialIds: [], files: [] }  Artikelbezeichnung (z. B. „5er“) → Materialien
//                   files: Packhinweise (Foto/PDF) als { id, name, type, size, parts, thumb, createdAt }
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
  increment, arrayUnion, arrayRemove, getDoc, getDocFromCache, Bytes,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig, TEAM_EMAIL } from './config.js';
import { norm, natCmp } from './ui.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const COLLECTIONS = ['orders', 'articles', 'materials', 'orderlist'];
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

export const findOrderByNr = (nr) => (norm(nr) ? orders().find((o) => norm(o.nr) === norm(nr)) : undefined);
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
export const ORDER_STATUSES = ['neu', 'arbeit', 'fertig'];
export const orderStatus = (o) => (ORDER_STATUSES.includes(o?.status) ? o.status : 'neu');

/** Zeitstempel zum Status merken (z. B. für eine spätere Tagesübersicht). */
const statusStamps = (status) => ({
  status,
  ...(status === 'arbeit' ? { startedAt: now() } : {}),
  ...(status === 'fertig' ? { doneAt: now() } : {}),
});

export function setOrderStatus(id, status) {
  const o = getOrder(id);
  if (!o || !ORDER_STATUSES.includes(status) || orderStatus(o) === status) return;
  const fields = { ...statusStamps(status), updatedAt: now() };
  run(updateDoc(doc(db, 'orders', id), fields));
  Object.assign(o, fields);
  emit();
}

export function saveOrder({ id, nr, note, articleName, status = 'neu' }) {
  nr = str(nr);
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
  const fields = { nr, note: str(note), articleId: article.id, updatedAt: now() };
  if (!id) fields.createdAt = now();
  if (!ORDER_STATUSES.includes(status)) status = 'neu';
  if (!id || orderStatus(getOrder(id)) !== status) Object.assign(fields, statusStamps(status));
  batch.set(doc(db, 'orders', orderId), fields, { merge: true });
  data.orders.set(orderId, { ...data.orders.get(orderId), id: orderId, ...fields });
  run(batch.commit());
  emit();
  return data.orders.get(orderId);
}

export function deleteOrder(id) {
  run(deleteDoc(doc(db, 'orders', id)));
  data.orders.delete(id);
  emit();
}

// ---------- Artikel ----------

export function saveArticle({ id, name }) {
  name = str(name);
  if (!name) throw new Error('Bitte eine Artikelbezeichnung eingeben.');
  const dupe = findArticleByName(name);
  if (dupe && dupe.id !== id) throw new Error(`Artikel „${dupe.name}“ gibt es schon.`);
  const articleId = id || newId('articles');
  const fields = { name, updatedAt: now() };
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

// ---------- Export ----------

export function exportJSON() {
  return JSON.stringify({
    app: 'bowert-konfektionierung', version: 2, exportedAt: now(),
    orders: orders(), articles: articles(), materials: materials(), orderlist: orderlist(),
  }, null, 2);
}

function withoutId(obj) {
  const { id, ...rest } = obj;
  return rest;
}
