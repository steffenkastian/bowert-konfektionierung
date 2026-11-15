// Datenhaltung der Konfektionierungs-App.
//
// Alle Daten liegen im localStorage des Geräts. Struktur (version 1):
//   materials: [{ id, nr, name, location }]          Verpackungsmaterial-Stammdaten (Lagerort gilt überall)
//   articles:  [{ id, code, name, items: [{ materialId, qty }] }]
//   orders:    [{ id, nr, note, articleIds: [] }]
//   meta:      { lastBackup }
// Später kommt hier z. B. `pallets: [{ id, orderId, articleId, at }]` für die Tagesübersicht dazu.

import { norm, natCmp } from './ui.js';

const KEY = 'konf.data.v1';
const BEFORE_IMPORT_KEY = 'konf.data.v1.vor-import';
export const DATA_VERSION = 1;

const now = () => new Date().toISOString();
const str = (v) => (v == null ? '' : String(v).trim());
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function emptyData() {
  return { version: DATA_VERSION, orders: [], articles: [], materials: [], meta: { lastBackup: null } };
}

/** Bringt gespeicherte oder importierte Daten in eine saubere, in sich stimmige Form. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Keine gültigen Daten.');
  const list = (v) => (Array.isArray(v) ? v : []);
  const uniqueIds = () => {
    const seen = new Set();
    return (x) => x && typeof x.id === 'string' && x.id && !seen.has(x.id) && seen.add(x.id);
  };
  const stamp = (x) => ({ createdAt: x.createdAt || now(), updatedAt: x.updatedAt || now() });

  const materials = list(raw.materials).filter(uniqueIds()).map((m) => ({
    id: m.id, nr: str(m.nr), name: str(m.name), location: str(m.location), ...stamp(m),
  }));
  const materialIds = new Set(materials.map((m) => m.id));

  const articles = list(raw.articles).filter(uniqueIds()).map((a) => {
    const seenItems = new Set();
    const items = list(a.items)
      .filter((it) => it && materialIds.has(it.materialId) && !seenItems.has(it.materialId) && seenItems.add(it.materialId))
      .map((it) => ({ materialId: it.materialId, qty: str(it.qty) }));
    return { id: a.id, code: str(a.code), name: str(a.name), items, ...stamp(a) };
  });
  const articleIds = new Set(articles.map((a) => a.id));

  const orders = list(raw.orders).filter(uniqueIds()).map((o) => ({
    id: o.id,
    nr: str(o.nr),
    note: str(o.note),
    articleIds: [...new Set(list(o.articleIds).filter((id) => articleIds.has(id)))],
    ...stamp(o),
  }));

  return {
    version: DATA_VERSION,
    orders,
    articles,
    materials,
    meta: { lastBackup: raw.meta?.lastBackup ?? null },
  };
}

let storageError = null;
let data = load();

function load() {
  let raw;
  try {
    raw = localStorage.getItem(KEY);
  } catch (e) {
    storageError = e;
    return emptyData();
  }
  if (!raw) return emptyData();
  try {
    return sanitize(JSON.parse(raw));
  } catch (e) {
    // Defekte Daten nicht stillschweigend überschreiben, sondern beiseitelegen.
    console.error('Gespeicherte Daten unlesbar', e);
    try { localStorage.setItem(`${KEY}.defekt-${Date.now()}`, raw); } catch { /* ignorieren */ }
    return emptyData();
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch (e) {
    console.error(e);
    throw new Error('Speichern fehlgeschlagen – der Gerätespeicher ist voll oder gesperrt.');
  }
}

export const storageProblem = () => storageError;

// ---------- Lesen ----------

export const orders = () => data.orders;
export const articles = () => data.articles;
export const materials = () => data.materials;
export const meta = () => data.meta;

export const getOrder = (id) => data.orders.find((o) => o.id === id);
export const getArticle = (id) => data.articles.find((a) => a.id === id);
export const getMaterial = (id) => data.materials.find((m) => m.id === id);

export const findOrderByNr = (nr) => (norm(nr) ? data.orders.find((o) => norm(o.nr) === norm(nr)) : undefined);
export const findArticleByCode = (code) => (norm(code) ? data.articles.find((a) => norm(a.code) === norm(code)) : undefined);
export const findMaterialByNr = (nr) => (norm(nr) ? data.materials.find((m) => norm(m.nr) === norm(nr)) : undefined);

export const ordersWithArticle = (articleId) => data.orders.filter((o) => o.articleIds.includes(articleId));
export const articlesWithMaterial = (materialId) =>
  data.articles.filter((a) => a.items.some((it) => it.materialId === materialId));

export const locations = () =>
  [...new Set(data.materials.map((m) => m.location).filter(Boolean))].sort(natCmp);

export const isEmpty = () => !data.orders.length && !data.articles.length && !data.materials.length;

// ---------- Aufträge ----------

/**
 * Speichert einen Auftrag. `articleCodes` sind ArtikelIDs als Text –
 * noch unbekannte ArtikelIDs werden dabei als neue Artikel angelegt.
 */
export function saveOrder({ id, nr, note, articleCodes }) {
  nr = str(nr);
  if (!nr) throw new Error('Bitte eine Auftragsnummer eingeben.');
  const dupe = findOrderByNr(nr);
  if (dupe && dupe.id !== id) throw new Error(`Auftrag ${dupe.nr} gibt es schon.`);

  const articleIds = [];
  for (const code of articleCodes.map(str).filter(Boolean)) {
    let a = findArticleByCode(code);
    if (!a) {
      a = { id: uid(), code, name: '', items: [], createdAt: now(), updatedAt: now() };
      data.articles.push(a);
    }
    if (!articleIds.includes(a.id)) articleIds.push(a.id);
  }

  let o = id ? getOrder(id) : null;
  if (o) {
    Object.assign(o, { nr, note: str(note), articleIds, updatedAt: now() });
  } else {
    o = { id: uid(), nr, note: str(note), articleIds, createdAt: now(), updatedAt: now() };
    data.orders.push(o);
  }
  persist();
  return o;
}

export function deleteOrder(id) {
  data.orders = data.orders.filter((o) => o.id !== id);
  persist();
}

// ---------- Artikel ----------

export function saveArticle({ id, code, name }) {
  code = str(code);
  if (!code) throw new Error('Bitte eine ArtikelID eingeben.');
  const dupe = findArticleByCode(code);
  if (dupe && dupe.id !== id) throw new Error(`ArtikelID ${dupe.code} gibt es schon.`);

  let a = id ? getArticle(id) : null;
  if (a) {
    Object.assign(a, { code, name: str(name), updatedAt: now() });
  } else {
    a = { id: uid(), code, name: str(name), items: [], createdAt: now(), updatedAt: now() };
    data.articles.push(a);
  }
  persist();
  return a;
}

export function deleteArticle(id) {
  data.articles = data.articles.filter((a) => a.id !== id);
  for (const o of data.orders) o.articleIds = o.articleIds.filter((x) => x !== id);
  persist();
}

/**
 * Hinterlegt ein Verpackungsmaterial an einem Artikel.
 * Gibt es die Materialnummer schon, wird das bestehende Material verwendet
 * (und dessen Bezeichnung/Lagerort aktualisiert) – sonst wird es neu angelegt.
 * `replaceMaterialId`: beim Bearbeiten das bisher verknüpfte Material.
 */
export function saveArticleItem(articleId, { nr, name, location, qty, replaceMaterialId }) {
  const a = getArticle(articleId);
  if (!a) throw new Error('Artikel nicht gefunden.');
  nr = str(nr); name = str(name); location = str(location); qty = str(qty);
  if (!nr && !name) throw new Error('Bitte Materialnummer oder Bezeichnung eingeben.');

  let m = findMaterialByNr(nr);
  if (!m && !nr) {
    const prev = replaceMaterialId && getMaterial(replaceMaterialId);
    m = prev && !prev.nr ? prev : data.materials.find((x) => !x.nr && norm(x.name) === norm(name));
  }
  if (m) {
    if (name) m.name = name;
    m.location = location;
    m.updatedAt = now();
  } else {
    m = { id: uid(), nr, name, location, createdAt: now(), updatedAt: now() };
    data.materials.push(m);
  }

  const existing = a.items.findIndex((it) => it.materialId === m.id);
  const previous = replaceMaterialId ? a.items.findIndex((it) => it.materialId === replaceMaterialId) : -1;
  if (existing >= 0) {
    a.items[existing].qty = qty;
    if (previous >= 0 && previous !== existing) a.items.splice(previous, 1);
  } else if (previous >= 0) {
    a.items[previous] = { materialId: m.id, qty };
  } else {
    a.items.push({ materialId: m.id, qty });
  }
  a.updatedAt = now();
  persist();
  return m;
}

export function removeArticleItem(articleId, materialId) {
  const a = getArticle(articleId);
  if (!a) return;
  a.items = a.items.filter((it) => it.materialId !== materialId);
  a.updatedAt = now();
  persist();
}

// ---------- Material ----------

export function saveMaterial({ id, nr, name, location }) {
  nr = str(nr); name = str(name); location = str(location);
  if (!nr && !name) throw new Error('Bitte Materialnummer oder Bezeichnung eingeben.');
  const dupe = findMaterialByNr(nr);
  if (dupe && dupe.id !== id) throw new Error(`Materialnummer ${dupe.nr} gibt es schon.`);

  let m = id ? getMaterial(id) : null;
  if (m) {
    Object.assign(m, { nr, name, location, updatedAt: now() });
  } else {
    m = { id: uid(), nr, name, location, createdAt: now(), updatedAt: now() };
    data.materials.push(m);
  }
  persist();
  return m;
}

export function deleteMaterial(id) {
  data.materials = data.materials.filter((m) => m.id !== id);
  for (const a of data.articles) a.items = a.items.filter((it) => it.materialId !== id);
  persist();
}

// ---------- Datensicherung ----------

export function exportJSON() {
  return JSON.stringify({ app: 'bowert-konfektionierung', exportedAt: now(), ...data }, null, 2);
}

export function markBackup() {
  data.meta.lastBackup = now();
  persist();
}

/** Prüft eine Backup-Datei und liefert die bereinigten Daten (ohne sie zu übernehmen). */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Die Datei ist kein gültiges Backup.');
  }
  if (!raw || !Array.isArray(raw.orders) || !Array.isArray(raw.articles) || !Array.isArray(raw.materials)) {
    throw new Error('Die Datei ist kein Backup dieser App.');
  }
  if (Number(raw.version) > DATA_VERSION) {
    throw new Error('Das Backup stammt aus einer neueren App-Version. Bitte App neu laden.');
  }
  const clean = sanitize(raw);
  clean.meta.lastBackup = raw.exportedAt ?? clean.meta.lastBackup;
  return clean;
}

/** Ersetzt alle Daten (Import). Der vorherige Stand wird zur Sicherheit aufgehoben. */
export function replaceAll(next) {
  try { localStorage.setItem(BEFORE_IMPORT_KEY, JSON.stringify(data)); } catch { /* ignorieren */ }
  data = next;
  persist();
}
