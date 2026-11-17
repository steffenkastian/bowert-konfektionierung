// BO-WERT Konfektionierung
// Auftragsnummer → Artikelbezeichnung → Materialien (Artikelnummer, Beschreibung, Lagerort) + Bestellliste.

import * as store from './store.js';
import {
  $, $$, esc, norm, natCmp, locCmp, matcher, plural, formatDate, toast, icon, attachSuggest,
} from './ui.js';
import { ACCEPT, prepareUpload, renderPdf, fileSize, isPdf } from './files.js';

const APP_VERSION = '2.3.0';
const PREFS_KEY = 'konf.ui';
const LIST_LIMIT = 40;
const CODE_ATTRS = 'autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"';

// ======================================================================
// Geräte-Einstellungen & Sitzungszustand
// ======================================================================

const prefs = (() => {
  const defaults = { recent: [], numericSearch: false, materialSort: 'location', orderFilter: 'alle' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return defaults;
  }
})();

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* egal */ }
}

function rememberOrder(id) {
  prefs.recent = [id, ...prefs.recent.filter((x) => x !== id)].slice(0, 8);
  savePrefs();
}

const state = { query: '', filter: { auftraege: '', artikel: '', material: '' } };

// ======================================================================
// Anmeldung (Firebase Auth – das Passwort wird vom Server geprüft)
// ======================================================================

function showScreen(name) {
  $('#splash').hidden = name !== 'splash';
  $('#login').hidden = name !== 'login';
  $('#app').hidden = name !== 'app';
}

function showLogin() {
  showScreen('login');
  $('#pw').value = '';
  $('#pw').focus();
}

const AUTH_ERRORS = {
  'auth/invalid-credential': 'Das Passwort stimmt nicht.',
  'auth/invalid-login-credentials': 'Das Passwort stimmt nicht.',
  'auth/wrong-password': 'Das Passwort stimmt nicht.',
  'auth/user-not-found': 'Das Team-Konto ist noch nicht eingerichtet.',
  'auth/network-request-failed': 'Keine Internetverbindung. Für die Anmeldung wird einmal Internet gebraucht.',
  'auth/too-many-requests': 'Zu viele Versuche. Bitte kurz warten.',
  'auth/operation-not-allowed': 'Die Anmeldung ist in Firebase noch nicht aktiviert.',
  'auth/configuration-not-found': 'Die Anmeldung ist in Firebase noch nicht aktiviert.',
};

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#pw');
  const msg = $('#login-msg');
  const button = $('#login-form button[type=submit]');
  msg.textContent = '';
  button.disabled = true;
  try {
    // Klein geschrieben – Handy-Tastaturen schreiben gern „Bowert“.
    await store.login(pw.value.trim().toLowerCase());
    pw.blur();
  } catch (ex) {
    msg.textContent = AUTH_ERRORS[ex.code] || `Anmeldung fehlgeschlagen (${ex.code || ex.message}).`;
    pw.select();
    const card = $('.login-card');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  } finally {
    button.disabled = false;
  }
});

async function logout() {
  await store.logout();
}

// ======================================================================
// Navigation (Hash-Routing mit eigener Verlaufs-Spur für „Zurück“)
// ======================================================================

let stack = [];
let pendingReplace = false;
let renderedHash = null;
let currentView = null;
const scrollPos = new Map();

const currentHash = () => location.hash || '#/suche';
const go = (hash) => { location.hash = hash; };

function replace(hash) {
  if (currentHash() === hash) { render(); return; }
  pendingReplace = true;
  location.replace(hash);
}

function back(fallback) {
  if (stack.length > 1) history.back();
  else replace(fallback);
}

function onHashChange() {
  if (renderedHash) scrollPos.set(renderedHash, window.scrollY);
  const h = currentHash();
  let wasBack = false;
  if (pendingReplace) {
    stack[stack.length - 1] = h;
    pendingReplace = false;
  } else if (stack.length > 1 && stack[stack.length - 2] === h) {
    stack.pop();
    wasBack = true;
  } else {
    stack.push(h);
  }
  render();
  window.scrollTo(0, wasBack ? scrollPos.get(h) || 0 : 0);
}

const ID = '([^/?]+)';
const Q = '(?:\\?(.*))?';
const route = (pattern) => new RegExp(`^#/${pattern}$`);
const routes = [
  [route(`suche${Q}`), () => viewSearch()],
  [route(`auftraege${Q}`), () => viewOrders()],
  [route(`auftrag/neu${Q}`), (q) => viewOrderEdit(null, q)],
  [route(`auftrag/${ID}/bearbeiten`), (id) => viewOrderEdit(id)],
  [route(`auftrag/${ID}`), (id) => viewOrder(id)],
  [route(`artikel${Q}`), (q) => viewArticles(q)],
  [route(`artikel/neu${Q}`), (q) => viewArticleEdit(null, q)],
  [route(`artikel/${ID}/bearbeiten`), (id) => viewArticleEdit(id)],
  [route(`artikel/${ID}/material/neu`), (id) => viewAddMaterial(id)],
  [route(`artikel/${ID}/datei/${ID}`), (id, fid) => viewFile(id, fid)],
  [route(`artikel/${ID}`), (id) => viewArticle(id)],
  [route(`material${Q}`), (q) => viewMaterials(q)],
  [route('material/neu'), () => viewMaterial(null)],
  [route(`material/${ID}${Q}`), (id, q) => viewMaterial(id, q)],
  [route('bestellliste'), () => viewOrderList()],
  [route('mehr'), () => viewMore()],
];

function render() {
  if ($('#app').hidden) return;
  const h = currentHash();
  let view = null;
  if (!store.isReady()) {
    view = { title: 'Konfektionierung', loading: true, html:'<div class="loading"><span class="spinner"></span>Daten werden geladen …</div>' };
  } else {
    for (const [re, make] of routes) {
      const m = h.match(re);
      if (m) { view = make(...m.slice(1)); break; }
    }
  }
  mount(view || notFound());
  renderedHash = h;
}

function mount(view) {
  currentView = view;
  $('#title').textContent = view.title;
  document.title = `${view.title} · Konfektionierung`;
  const backBtn = $('#back');
  backBtn.hidden = !view.back;
  backBtn.onclick = () => back(view.back);
  $('#brand').hidden = Boolean(view.back);
  $('#topbar-action').innerHTML = view.action
    ?? (view.back ? '' : `<a class="icon-btn" href="#/mehr" aria-label="Mehr: Datensicherung, Abmelden" title="Mehr">${icon.gear}</a>`);
  const main = $('#main');
  main.innerHTML = view.html;
  for (const tab of $$('.tab')) {
    const active = tab.dataset.tab === view.tab;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  const onData = view.mount?.(main);
  view.onData = typeof onData === 'function' ? onData : null;
  updateChrome();
}

/** Daten haben sich geändert (eigene Eingabe oder ein anderes Handy). */
let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    if ($('#app').hidden) return;
    updateChrome();
    if (!currentView || currentView.loading) { render(); return; }
    if (currentView.onData) { currentView.onData(); return; }
    if (currentView.form) return; // Formulare nicht unter den Fingern neu aufbauen
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  });
}

/** Badge an der Bestellliste + Sync-Anzeige. */
function updateChrome() {
  const open = store.orderlist().filter((e) => e.status === 'offen').length;
  const badge = $('#orderlist-badge');
  badge.textContent = open;
  badge.hidden = !open;
  const sync = $('#sync');
  const { pending } = store.syncState();
  if (!navigator.onLine) {
    sync.hidden = false;
    sync.innerHTML = `${icon.cloudOff}<span>Offline</span>`;
    sync.title = 'Keine Verbindung – Änderungen werden gespeichert und später übertragen.';
  } else if (pending) {
    sync.hidden = false;
    sync.innerHTML = '<span class="spinner small"></span><span>Sync</span>';
    sync.title = 'Änderungen werden übertragen …';
  } else {
    sync.hidden = true;
  }
}

// ======================================================================
// Bausteine
// ======================================================================

const sectionTitle = (text, count, extra = '') =>
  `<h2 class="section-title"><span>${esc(text)}</span>${count != null ? `<span class="count">${count}</span>` : ''}${extra}</h2>`;

const editAction = (href, label) =>
  `<a class="icon-btn" href="${href}" aria-label="${esc(label)}" title="${esc(label)}">${icon.edit}</a>`;

const locBadge = (loc) =>
  loc ? `<span class="loc">${esc(loc)}</span>` : '<span class="loc loc-none">kein Lagerort</span>';

const materialTitle = (m) => m.description || `Nr. ${m.nr}`;

// Auftragsstatus
const STATUS_LABEL = { neu: 'Nicht begonnen', naechstes: 'Als nächstes', arbeit: 'In Arbeit', fertig: 'Abgeschlossen' };
const STATUS_RANK = { arbeit: 0, naechstes: 1, neu: 2, fertig: 3 };
const statusPill = (o) => {
  const s = store.orderStatus(o);
  return `<span class="status st-${s}">${STATUS_LABEL[s]}</span>`;
};
const statusSeg = (current) => `<div class="seg status-seg" role="group" aria-label="Status">
  ${store.ORDER_STATUSES.map((s) => `<button type="button" class="st-${s}" data-status="${s}" aria-pressed="${s === current}">${STATUS_LABEL[s]}</button>`).join('')}
</div>`;
const byStatusThenNewest = (a, b) => STATUS_RANK[store.orderStatus(a)] - STATUS_RANK[store.orderStatus(b)]
  || (store.orderStatus(a) === 'naechstes' ? (a.queuedAt || '').localeCompare(b.queuedAt || '') : 0)
  || (b.createdAt || '').localeCompare(a.createdAt || '');

/** Laufende Aufträge (optional ohne einen bestimmten). */
const runningOrders = (exceptId = '') =>
  store.orders().filter((o) => store.orderStatus(o) === 'arbeit' && o.id !== exceptId).sort(byStatusThenNewest);
/** Bei „Als nächstes“: der Auftrag, nach dem dieser drankommt. */
const predecessor = (o) => (store.orderStatus(o) === 'naechstes' && o.after ? store.getOrder(o.after) : null);
/** Kurztext „→ danach 630-…“ bzw. „nach 630-…“ für Listen. */
function nextRef(o) {
  const nexts = store.orderStatus(o) === 'naechstes' ? [] : store.nextOrders(o.id);
  if (nexts.length) return `→ danach ${nexts[0].nr}${nexts.length > 1 ? ` +${nexts.length - 1}` : ''}`;
  const pre = predecessor(o);
  return pre ? `nach ${pre.nr}` : '';
}
const orderSummary = (o) => [store.getArticle(o.articleId)?.name, o.note].filter(Boolean).join(' · ');

/** Listenzeile; title/sub/tag werden bereits escaped übergeben. */
function row({ href, title, sub = '', tag = '' }) {
  return `<li><a class="row" href="${href}">
    <span class="row-main"><span class="row-title">${title}</span>${sub ? `<span class="row-sub">${sub}</span>` : ''}</span>
    ${tag}${icon.chevron}</a></li>`;
}

function takeButton(m) {
  const q = store.openQty(m.id);
  return `<button type="button" class="take${q ? ' has' : ''}" data-take="${m.id}"
    aria-label="${esc(materialTitle(m))} entnehmen und auf die Bestellliste setzen">
    ${icon.take}<span>Entnehmen</span>${q ? `<b class="take-count">${q}</b>` : ''}</button>`;
}

/** Material-Zeile: Lagerort · Beschreibung/Nummer · „Entnehmen“. */
function materialRow(m, { articleId = '', note = '', take = true } = {}) {
  const href = `#/material/${m.id}${articleId ? `?artikel=${articleId}` : ''}`;
  return `<li class="mat">
    ${locBadge(m.location)}
    <a class="mat-body" href="${href}">
      <span class="mat-name">${esc(materialTitle(m))}</span>
      ${m.description ? `<span class="mat-meta">Nr. ${esc(m.nr)}</span>` : ''}
      ${note ? `<span class="mat-note">${note}</span>` : ''}
    </a>
    ${take ? takeButton(m) : ''}
  </li>`;
}

const sortedMaterials = (a) =>
  store.articleMaterials(a).sort((x, y) => locCmp(x.location, y.location) || natCmp(x.nr, y.nr));

function materialList(a, opts = {}) {
  const mats = sortedMaterials(a);
  if (!mats.length) {
    return `<p class="empty-inline">Noch kein Material hinterlegt.
      <a href="#/artikel/${a.id}/material/neu">Material hinzufügen</a></p>`;
  }
  return `<ul class="mats">${mats.map((m) => materialRow(m, { articleId: a.id, ...opts })).join('')}</ul>`;
}

/** Packhinweise (Fotos/PDFs) als Kachelreihe; mit `add` zusätzlich eine „Hinzufügen“-Kachel. */
function fileStrip(a, { add = false } = {}) {
  const files = store.articleFiles(a);
  if (!files.length && !add) return '';
  const tiles = files.map((f) => `<li><a class="file-tile" href="#/artikel/${a.id}/datei/${f.id}">
      <span class="file-thumb${f.thumb ? '' : ' is-doc'}">${f.thumb ? `<img src="${esc(f.thumb)}" alt="" loading="lazy">` : icon.pdf}</span>
      <span class="file-name">${esc(f.name)}</span></a></li>`).join('');
  const addTile = add ? `<li><button type="button" class="file-tile file-add" data-upload="${a.id}">
      <span class="file-thumb">${icon.camera}</span><span class="file-name">Foto / PDF</span></button></li>` : '';
  return `<ul class="files" aria-label="Packhinweise">${tiles}${addTile}</ul>`;
}

/** Kompakte Packhinweis-Reihe für Auftrags-/Artikelkarten (nur wenn vorhanden). */
const filesBlock = (a) => (store.articleFiles(a).length
  ? `<div class="files-block"><span class="files-label">${icon.clip}Packhinweise</span>${fileStrip(a)}</div>` : '');

function articleBlock(a, opts) {
  return `<section class="art">
    <a class="art-head" href="#/artikel/${a.id}"><span class="eyebrow">Artikel</span><span class="art-name">${esc(a.name)}</span></a>
    ${filesBlock(a)}
    ${materialList(a, opts)}
  </section>`;
}

function orderCard(o, { primary = false } = {}) {
  const a = store.getArticle(o.articleId);
  return `<article class="card">
    <a class="card-head" href="#/auftrag/${o.id}"${primary ? ' data-primary' : ''}>
      <span class="card-head-main">
        <span class="eyebrow-row"><span class="eyebrow">Auftrag</span>${statusPill(o)}</span>
        <span class="card-title">${esc(o.nr)}</span>
        ${o.note ? `<span class="card-sub">${esc(o.note)}</span>` : ''}
        ${nextRef(o) ? `<span class="next-ref">${esc(nextRef(o))}</span>` : ''}
      </span>${icon.chevron}
    </a>
    ${a ? articleBlock(a)
      : `<p class="empty-inline pad">Kein Artikel zugeordnet. <a href="#/auftrag/${o.id}/bearbeiten">Artikel zuordnen</a></p>`}
  </article>`;
}

function articleCard(a, { primary = false } = {}) {
  const ords = store.ordersWithArticle(a.id);
  const shown = ords.slice(0, 6).map((o) => `<a href="#/auftrag/${o.id}">${esc(o.nr)}</a>`).join(', ');
  return `<article class="card">
    <a class="card-head" href="#/artikel/${a.id}"${primary ? ' data-primary' : ''}>
      <span class="card-head-main"><span class="eyebrow">Artikel</span><span class="card-title">${esc(a.name)}</span></span>
      ${icon.chevron}
    </a>
    <div class="art">${filesBlock(a)}${materialList(a)}</div>
    ${ords.length ? `<p class="card-foot">Aufträge: ${shown}${ords.length > 6 ? ` +${ords.length - 6}` : ''}</p>` : ''}
  </article>`;
}

function orderRow(o) {
  const a = store.getArticle(o.articleId);
  const sub = [a?.name, o.note].filter(Boolean).join(' · ');
  const ref = nextRef(o);
  return row({
    href: `#/auftrag/${o.id}`,
    title: esc(o.nr),
    sub: (a ? esc(sub) : `<span class="warn-text">kein Artikel</span>${o.note ? ` · ${esc(o.note)}` : ''}`)
      + (ref ? `<span class="next-ref">${esc(ref)}</span>` : ''),
    tag: statusPill(o),
  });
}

function articleRow(a) {
  const nMat = (a.materialIds || []).length;
  const nOrd = store.ordersWithArticle(a.id).length;
  const nFiles = store.articleFiles(a).length;
  return row({
    href: `#/artikel/${a.id}`,
    title: esc(a.name),
    sub: esc([plural(nMat, 'Material', 'Materialien'), plural(nOrd, 'Auftrag', 'Aufträge'),
      nFiles ? plural(nFiles, 'Packhinweis', 'Packhinweise') : ''].filter(Boolean).join(' · ')),
    tag: nMat ? '' : '<span class="tag">kein Material</span>',
  });
}

function field({ id, label, value = '', placeholder = '', optional = false, attrs = '', hint = '', suggest = false }) {
  const input = `<input id="${id}" class="input" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" ${attrs}>`;
  return `<div class="field">
    <label for="${id}">${esc(label)}${optional ? ' <span class="opt">optional</span>' : ''}</label>
    ${suggest ? `<div class="suggest-wrap">${input}</div>` : input}
    <p class="hint" ${hint ? '' : 'hidden'}>${hint}</p>
  </div>`;
}

const deleteButton = (label, id = 'del') =>
  `<button type="button" class="btn btn-danger btn-block" id="${id}">${icon.trash}<span>${esc(label)}</span></button>`;

function filterField(placeholder, key) {
  return `<label class="filter">${icon.search}
    <input id="filter" type="search" placeholder="${esc(placeholder)}" value="${esc(state.filter[key])}"
      autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="${esc(placeholder)}">
  </label>`;
}

function bindFilter(root, key, draw) {
  const input = $('#filter', root);
  input.addEventListener('input', () => { state.filter[key] = input.value; draw(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
}

const filterChip = (label, href) => `<a class="filter-chip" href="${href}">${esc(label)}${icon.close}</a>`;

function emptyBox(title, text, button = '') {
  return `<div class="card empty"><h2>${esc(title)}</h2>${text ? `<p>${text}</p>` : ''}${button}</div>`;
}

/** Enter im Feld springt ins nächste Feld statt das Formular abzuschicken. */
function nextOnEnter(...inputs) {
  inputs.forEach((el, i) => {
    const next = inputs[i + 1];
    if (!next) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); next.focus(); }
    });
  });
}

function locationSuggest(input) {
  attachSuggest(input, {
    source: (q) => {
      const mm = matcher(q);
      return store.locations()
        .filter((l) => (!q.trim() || mm(l)) && norm(l) !== norm(q))
        .map((l) => ({ label: l, value: l }));
    },
    onPick: (it) => { input.value = it.value; input.dispatchEvent(new Event('input', { bubbles: true })); },
  });
}

function rank(list, score, tiebreak) {
  return list
    .map((x) => ({ x, s: score(x) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || tiebreak(a.x, b.x));
}

function notFound(kind = 'Seite') {
  return {
    title: 'Nicht gefunden',
    back: '#/suche',
    html: emptyBox(`${kind} nicht gefunden`, 'Der Eintrag wurde vielleicht gelöscht.',
      '<a class="btn btn-primary" href="#/suche">Zur Suche</a>'),
  };
}

// ======================================================================
// Suche (Startseite)
// ======================================================================

function viewSearch() {
  return {
    title: 'Konfektionierung',
    tab: 'suche',
    html: `
      <div class="searchbar">
        <label class="search-field">
          ${icon.search}
          <input id="q" type="search" value="${esc(state.query)}" placeholder="Auftrag, Artikel, Material …"
            aria-label="Suche nach Auftrag, Artikel, Material oder Lagerort"
            autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search"
            ${prefs.numericSearch ? 'inputmode="numeric"' : ''}>
          <button type="button" class="icon-btn search-clear" id="q-clear" aria-label="Eingabe löschen"
            ${state.query ? '' : 'hidden'}>${icon.close}</button>
        </label>
        <button type="button" class="kbd-toggle" id="kbd"
          aria-label="${prefs.numericSearch ? 'Buchstaben-Tastatur verwenden' : 'Zahlen-Tastatur verwenden'}">
          ${prefs.numericSearch ? 'ABC' : '123'}
        </button>
      </div>
      <div id="results" aria-live="polite"></div>`,
    mount(root) {
      const input = $('#q', root);
      const clear = $('#q-clear', root);
      const kbd = $('#kbd', root);
      const draw = () => { $('#results', root).innerHTML = searchResults(state.query); };

      input.addEventListener('input', () => {
        state.query = input.value;
        clear.hidden = !input.value;
        draw();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const primary = $('#results [data-primary]', root);
        if (primary) go(primary.getAttribute('href'));
        else input.blur();
      });
      clear.addEventListener('click', () => {
        input.value = '';
        state.query = '';
        clear.hidden = true;
        draw();
        input.focus();
      });
      kbd.addEventListener('click', () => {
        prefs.numericSearch = !prefs.numericSearch;
        savePrefs();
        if (prefs.numericSearch) input.setAttribute('inputmode', 'numeric');
        else input.removeAttribute('inputmode');
        kbd.textContent = prefs.numericSearch ? 'ABC' : '123';
        kbd.setAttribute('aria-label', prefs.numericSearch ? 'Buchstaben-Tastatur verwenden' : 'Zahlen-Tastatur verwenden');
        input.blur();
        input.focus();
      });
      draw();
      if (matchMedia('(pointer: fine)').matches) input.focus();
      return draw;
    },
  };
}

function searchResults(q) {
  if (!q.trim()) return searchHome();
  const m = matcher(q);
  const orders = rank(store.orders(), (o) => Math.max(m(o.nr) * 10, m(o.note)), (a, b) => natCmp(a.nr, b.nr));
  const arts = rank(store.articles(), (a) => m(a.name) * 10, (a, b) => natCmp(a.name, b.name));
  const mats = rank(store.materials(), (x) => Math.max(m(x.nr) * 10, m(x.description) * 2, m(x.location) * 2),
    (a, b) => locCmp(a.location, b.location));

  if (!orders.length && !arts.length && !mats.length) {
    return emptyBox('Nichts gefunden', `Kein Auftrag, Artikel oder Material passt zu „${esc(q.trim())}“.`,
      `<a class="btn btn-primary" href="#/auftrag/neu?nr=${encodeURIComponent(q.trim())}">${icon.plus}
        <span>Auftrag „${esc(q.trim())}“ anlegen</span></a>`);
  }

  const out = [];
  let primaryUsed = false;
  // Ein exakter (oder einziger) Treffer wird mit Enter direkt geöffnet.
  const isPrimary = (r, total) => {
    if (primaryUsed || !(total === 1 || r.s >= 30)) return false;
    primaryUsed = true;
    return true;
  };
  // Wenige Treffer: aufgeklappt mit Material + Lagerort. Viele: exakte aufgeklappt, Rest als Liste.
  const section = (title, results, card, compactRow) => {
    if (!results.length) return;
    out.push(sectionTitle(title, results.length));
    const expandAll = results.length <= 3;
    const expanded = expandAll ? results : results.filter((r) => r.s >= 30);
    const rest = expandAll ? [] : results.filter((r) => r.s < 30);
    out.push(expanded.map((r) => card(r.x, { primary: isPrimary(r, results.length) })).join(''));
    if (rest.length) {
      out.push(`<ul class="card list">${rest.slice(0, LIST_LIMIT).map((r) => compactRow(r.x)).join('')}</ul>`);
      if (rest.length > LIST_LIMIT) out.push(`<p class="hint center">… und ${rest.length - LIST_LIMIT} weitere. Suche genauer eingeben.</p>`);
    }
  };
  section('Aufträge', orders, orderCard, orderRow);
  section('Artikel', arts, articleCard, articleRow);
  if (mats.length) {
    out.push(sectionTitle('Material', mats.length));
    out.push(`<div class="card"><ul class="mats pad">${mats.slice(0, LIST_LIMIT).map(({ x }) => {
      const used = store.articlesWithMaterial(x.id).map((a) => esc(a.name));
      return materialRow(x, { note: used.length ? `für ${used.join(', ')}` : '' });
    }).join('')}</ul></div>`);
  }
  return out.join('');
}

function searchHome() {
  if (store.isEmpty()) {
    return `<div class="card intro">
      <h2>So funktioniert’s</h2>
      <ol class="steps">
        <li><b>Auftrag anlegen</b> und eine Artikelbezeichnung zuordnen (z. B. „5er“, „200er“).</li>
        <li><b>Material hinterlegen:</b> beim Artikel die Artikelnummern der Materialien eintragen – Beschreibung und Lagerort optional.</li>
        <li><b>Im Lager:</b> Auftragsnummer eintippen, sehen was wo liegt, und mit <b>Entnehmen</b> auf die Bestellliste setzen.</li>
      </ol>
      <a class="btn btn-primary btn-block" href="#/auftrag/neu">${icon.plus}<span>Ersten Auftrag anlegen</span></a>
    </div>`;
  }
  const working = store.orders().filter((o) => store.orderStatus(o) === 'arbeit').sort(byStatusThenNewest);
  const queued = store.orders().filter((o) => store.orderStatus(o) === 'naechstes').sort(byStatusThenNewest);
  const recent = prefs.recent.map(store.getOrder)
    .filter((o) => o && !['arbeit', 'naechstes'].includes(store.orderStatus(o))).slice(0, 5);
  const open = store.orderlist().filter((e) => e.status === 'offen');
  const noMaterial = store.articles().filter((a) => !(a.materialIds || []).length).length;
  const noLocation = store.materials().filter((m) => !m.location).length;
  const todo = [
    open.length && row({ href: '#/bestellliste', title: esc(`${plural(open.length, 'Position', 'Positionen')} auf der Bestellliste`), sub: 'Entnommenes Material nachbestellen' }),
    noMaterial && row({ href: '#/artikel?offen=1', title: esc(`${plural(noMaterial, 'Artikel', 'Artikel')} ohne Material`), sub: 'Materialien hinterlegen' }),
    noLocation && row({ href: '#/material?offen=1', title: esc(`${plural(noLocation, 'Material', 'Materialien')} ohne Lagerort`), sub: 'Lagerort eintragen' }),
  ].filter(Boolean);
  return `
    ${working.length ? `${sectionTitle('In Arbeit', working.length)}<ul class="card list">${working.map(orderRow).join('')}</ul>` : ''}
    ${queued.length ? `${sectionTitle('Als nächstes', queued.length)}<ul class="card list">${queued.map(orderRow).join('')}</ul>` : ''}
    ${recent.length ? `${sectionTitle('Zuletzt angesehen')}<ul class="card list">${recent.map(orderRow).join('')}</ul>` : ''}
    ${!working.length && !queued.length && !recent.length ? '<p class="hint center">Auftragsnummer, Artikelbezeichnung, Artikelnummer oder Lagerort eintippen.</p>' : ''}
    ${todo.length ? `${sectionTitle('Zu erledigen')}<ul class="card list">${todo.join('')}</ul>` : ''}
    <a class="btn btn-secondary btn-block" href="#/auftrag/neu">${icon.plus}<span>Neuer Auftrag</span></a>`;
}

// ======================================================================
// Aufträge
// ======================================================================

function viewOrders() {
  return {
    title: 'Aufträge',
    tab: 'auftraege',
    html: `${filterField('Aufträge filtern …', 'auftraege')}<div class="chips-row" id="status-filter"></div><div id="list"></div>
      <a class="fab" href="#/auftrag/neu" aria-label="Neuer Auftrag">${icon.plus}</a>`,
    mount(root) {
      const draw = () => {
        const q = state.filter.auftraege;
        const m = matcher(q);
        const all = store.orders();
        const count = (s) => all.filter((o) => s === 'alle' || store.orderStatus(o) === s).length;
        const current = prefs.orderFilter || 'alle';
        $('#status-filter', root).innerHTML = ['alle', ...store.ORDER_STATUSES].map((s) => `
          <button type="button" class="chip-btn${s !== 'alle' ? ` st-${s}` : ''}" data-filter="${s}" aria-pressed="${s === current}">
            ${s === 'alle' ? 'Alle' : STATUS_LABEL[s]} <b>${count(s)}</b></button>`).join('');
        let list = all.filter((o) => current === 'alle' || store.orderStatus(o) === current).sort(byStatusThenNewest);
        if (q.trim()) list = list.filter((o) => m(o.nr) || m(o.note) || m(store.getArticle(o.articleId)?.name));
        $('#list', root).innerHTML = list.length
          ? `<ul class="card list">${list.map(orderRow).join('')}</ul>`
          : all.length
            ? emptyBox('Keine Treffer', 'Filter anpassen oder löschen.')
            : emptyBox('Noch keine Aufträge', 'Tippe auf <b>+</b>, um den ersten Auftrag anzulegen.');
      };
      $('#status-filter', root).addEventListener('click', (e) => {
        const b = e.target.closest('[data-filter]');
        if (!b) return;
        prefs.orderFilter = b.dataset.filter;
        savePrefs();
        draw();
      });
      bindFilter(root, 'auftraege', draw);
      draw();
      return draw;
    },
  };
}

function viewOrder(id) {
  const o = store.getOrder(id);
  if (!o) return notFound('Auftrag');
  rememberOrder(o.id);
  const a = store.getArticle(o.articleId);
  return {
    title: 'Auftrag',
    back: '#/auftraege',
    tab: 'auftraege',
    action: editAction(`#/auftrag/${o.id}/bearbeiten`, 'Auftrag bearbeiten'),
    html: `
      <div class="detail-head">
        <span class="eyebrow">Auftrag</span>
        <div class="detail-title">${esc(o.nr)}</div>
        ${o.note ? `<div class="detail-sub">${esc(o.note)}</div>` : ''}
      </div>
      ${statusSeg(store.orderStatus(o))}
      <div id="after-pick"></div>
      ${afterInfo(o)}
      ${nextBox(o)}
      ${a ? `<div class="card">${articleBlock(a)}</div>
        <a class="btn btn-secondary btn-block" href="#/artikel/${a.id}/material/neu">${icon.plus}<span>Material zu „${esc(a.name)}“ hinzufügen</span></a>`
        : emptyBox('Kein Artikel zugeordnet', 'Ordne dem Auftrag eine Artikelbezeichnung zu.',
          `<a class="btn btn-primary" href="#/auftrag/${o.id}/bearbeiten">Artikel zuordnen</a>`)}`,
    mount(root) {
      const pick = $('#after-pick', root);
      $('.status-seg', root).addEventListener('click', (e) => {
        const b = e.target.closest('[data-status]');
        if (!b) return;
        const status = b.dataset.status;
        if (status === 'naechstes') { queueOrder(o, pick); return; }
        const nexts = store.nextOrders(o.id);
        const wasRunning = store.orderStatus(o) === 'arbeit';
        store.setOrderStatus(o.id, status);
        if (status === 'fertig' && wasRunning && nexts.length) {
          const n = nexts[0];
          toast(`${o.nr} abgeschlossen`, 'ok', { label: `${n.nr} starten`, run: () => startOrder(n) });
        } else {
          toast(`Auftrag ${o.nr}: ${STATUS_LABEL[status]}`);
        }
      });
      pick.addEventListener('click', (e) => {
        const b = e.target.closest('[data-after]');
        if (!b) return;
        setQueued(o, b.dataset.after);
      });

      $('.next-box', root)?.addEventListener('click', (e) => {
        const start = e.target.closest('[data-start]');
        const unlink = e.target.closest('[data-unlink]');
        if (start) {
          const n = store.getOrder(start.dataset.start);
          if (!n) return;
          const stillRunning = store.orderStatus(o) === 'arbeit';
          startOrder(n);
          go(`#/auftrag/${n.id}`);
          if (stillRunning) {
            toast(`${n.nr} gestartet`, 'ok', { label: `${o.nr} abschließen`, run: () => {
              store.setOrderStatus(o.id, 'fertig');
              toast(`${o.nr} abgeschlossen`);
            } });
          }
        }
        if (unlink) {
          const n = store.getOrder(unlink.dataset.unlink);
          if (!n) return;
          store.setOrderStatus(n.id, 'neu');
          toast(`${n.nr}: wieder „Nicht begonnen“`, 'ok', { label: 'Rückgängig', run: () => setQueued(n, o.id, false) });
        }
      });

      const input = $('#next-in', root);
      if (input) {
        const hint = $('#next-hint', root);
        const candidates = () => store.orders().filter((x) => x.id !== o.id
          && ['neu', 'naechstes'].includes(store.orderStatus(x)) && !(store.orderStatus(x) === 'naechstes' && x.after === o.id));
        const choose = (x) => { input.value = ''; hint.hidden = true; input.blur(); setQueued(x, o.id); };
        const newHref = () => `#/auftrag/neu?nr=${encodeURIComponent(input.value.trim())}&nach=${o.id}`;
        attachSuggest(input, {
          source: (q) => {
            const m = matcher(q);
            return rank(candidates(), (x) => (q.trim() ? m(x.nr) || m(x.note) || m(store.getArticle(x.articleId)?.name) : 1), byStatusThenNewest)
              .map(({ x }) => ({ label: x.nr, sub: [orderSummary(x), STATUS_LABEL[store.orderStatus(x)]].filter(Boolean).join(' · '), order: x }));
          },
          onPick: (it) => choose(it.order),
          max: 8,
        });
        input.addEventListener('input', () => {
          const q = input.value.trim();
          hint.hidden = !q || Boolean(store.findOrderByNr(q));
          hint.innerHTML = `Auftrag „${esc(q)}“ gibt es noch nicht. <a href="${esc(newHref())}">Neu anlegen</a>`;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const q = input.value.trim();
          if (!q) return;
          const x = store.findOrderByNr(q);
          if (x && x.id !== o.id) choose(x);
          else if (!x) go(newHref());
        });
      }

      // Daten von anderen Handys: neu zeichnen, außer man tippt gerade einen Auftrag ein.
      return () => {
        if (input && document.activeElement === input) return;
        const y = window.scrollY;
        render();
        window.scrollTo(0, y);
      };
    },
  };
}

/** Hinweis am Auftrag „Als nächstes“: nach welchem Auftrag er drankommt. */
function afterInfo(o) {
  if (store.orderStatus(o) !== 'naechstes') return '';
  const pre = predecessor(o);
  if (!pre) return '<p class="context">Kommt als nächstes dran (ohne festen Vorgänger).</p>';
  const queue = store.nextOrders(pre.id);
  const pos = queue.findIndex((x) => x.id === o.id);
  return `<a class="card after-info" href="#/auftrag/${pre.id}">
    ${icon.next}<span class="after-main"><span class="after-label">${pos > 0 ? `${pos + 1}. nach` : 'Kommt nach'}</span>
    <b>${esc(pre.nr)}</b>${orderSummary(pre) ? `<span class="after-sub">${esc(orderSummary(pre))}</span>` : ''}</span>
    ${statusPill(pre)}</a>`;
}

/** Am laufenden Auftrag: welcher Auftrag danach kommt (+ festlegen). */
function nextBox(o) {
  const running = store.orderStatus(o) === 'arbeit';
  const nexts = store.orderStatus(o) === 'naechstes' ? [] : store.nextOrders(o.id);
  if (!running && !nexts.length) return '';
  const items = nexts.map((n, i) => `<li class="next-item">
      <a class="next-main" href="#/auftrag/${n.id}">
        <span class="next-nr">${nexts.length > 1 ? `<span class="next-pos">${i + 1}.</span>` : ''}${esc(n.nr)}</span>
        ${orderSummary(n) ? `<span class="next-sub">${esc(orderSummary(n))}</span>` : ''}
      </a>
      <button type="button" class="btn btn-next" data-start="${n.id}">Starten</button>
      <button type="button" class="icon-btn next-x" data-unlink="${n.id}" aria-label="${esc(n.nr)} nicht mehr als nächstes" title="Entfernen">${icon.close}</button>
    </li>`).join('');
  return `<section class="card next-box">
    <div class="next-head">${icon.next}<span>Als nächstes</span></div>
    ${items ? `<ul class="next-list">${items}</ul>` : ''}
    ${running ? `<div class="next-add"><div class="suggest-wrap"><input id="next-in" class="input" placeholder="${nexts.length ? 'Weiteren Auftrag danach …' : 'Nächsten Auftrag wählen …'}" aria-label="Nächsten Auftrag wählen" ${CODE_ATTRS} enterkeyhint="done"></div>
      <p class="hint" id="next-hint" hidden></p></div>` : ''}
  </section>`;
}

function setQueued(o, after, notify = true) {
  store.setOrderStatus(o.id, 'naechstes', { after });
  if (!notify) return;
  const pre = after ? store.getOrder(after) : null;
  toast(pre ? `${o.nr} kommt nach ${pre.nr}` : `${o.nr}: Als nächstes`);
}

function startOrder(n) {
  store.setOrderStatus(n.id, 'arbeit');
  toast(`Auftrag ${n.nr}: In Arbeit`);
}

/** „Als nächstes“ gewählt: an den laufenden Auftrag koppeln (bei mehreren nachfragen). */
function queueOrder(o, pick) {
  const running = runningOrders(o.id);
  if (running.length === 1) { setQueued(o, running[0].id); return; }
  if (!running.length) { setQueued(o, ''); return; }
  pick.innerHTML = `<div class="card after-pick">
    <p class="after-q">Nach welchem laufenden Auftrag?</p>
    ${running.map((r) => `<button type="button" class="btn btn-secondary btn-block" data-after="${r.id}">
      <span><b>${esc(r.nr)}</b>${orderSummary(r) ? ` · ${esc(orderSummary(r))}` : ''}</span></button>`).join('')}
    <button type="button" class="btn btn-secondary btn-block" data-after="">Keinem bestimmten</button>
  </div>`;
  pick.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function viewOrderEdit(id, query) {
  const o = id ? store.getOrder(id) : null;
  if (id && !o) return notFound('Auftrag');
  const params = new URLSearchParams(query || '');
  const presetNr = params.get('nr') || '';
  const presetAfter = store.getOrder(params.get('nach') || '')?.id || '';
  const currentArticle = o ? store.getArticle(o.articleId) : null;
  const initialStatus = presetAfter ? 'naechstes' : store.orderStatus(o);
  // „Kommt nach“: laufende Aufträge + ein evtl. schon gewählter (auch wenn er nicht mehr läuft)
  const afterOptions = runningOrders(o?.id);
  const keepAfter = presetAfter || o?.after || '';
  if (keepAfter && !afterOptions.some((x) => x.id === keepAfter) && store.getOrder(keepAfter)) afterOptions.push(store.getOrder(keepAfter));
  const initialAfter = presetAfter || (o && store.orderStatus(o) === 'naechstes' ? o.after || ''
    : afterOptions.length === 1 ? afterOptions[0].id : '');

  return {
    title: o ? 'Auftrag bearbeiten' : 'Neuer Auftrag',
    back: o ? `#/auftrag/${o.id}` : presetAfter ? `#/auftrag/${presetAfter}` : '#/auftraege',
    tab: 'auftraege',
    form: true,
    html: `
      <form class="card form" id="f" novalidate>
        ${field({ id: 'nr', label: 'Auftragsnummer', value: o?.nr ?? presetNr, placeholder: 'z. B. 630-202878', attrs: `${CODE_ATTRS} enterkeyhint="next"` })}
        ${field({ id: 'art', label: 'Artikelbezeichnung', value: currentArticle?.name, placeholder: 'suchen, z. B. 5er oder 200er', attrs: 'autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="next"', suggest: true })}
        <div id="art-preview"></div>
        ${field({ id: 'note', label: 'Notiz', optional: true, value: o?.note, placeholder: 'z. B. Kunde, Menge', attrs: 'autocomplete="off" enterkeyhint="done"' })}
        <div class="field"><span class="label">Status</span>${statusSeg(initialStatus)}</div>
        <div class="field" id="after-field"${initialStatus === 'naechstes' ? '' : ' hidden'}>
          <label for="after">Kommt nach</label>
          <select id="after" class="input">
            <option value="">– keinem bestimmten Auftrag –</option>
            ${afterOptions.map((x) => `<option value="${x.id}"${x.id === initialAfter ? ' selected' : ''}>${esc(x.nr)}${orderSummary(x) ? ` · ${esc(orderSummary(x))}` : ''} (${STATUS_LABEL[store.orderStatus(x)]})</option>`).join('')}
          </select>
        </div>
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Speichern</button>
      </form>
      ${o ? deleteButton('Auftrag löschen') : ''}`,
    mount(root) {
      const nr = $('#nr', root);
      const art = $('#art', root);
      const note = $('#note', root);
      const hint = art.closest('.field').querySelector('.hint');

      // Vorschau: welche Materialien hängen an der gewählten Artikelbezeichnung?
      const preview = () => {
        const a = store.findArticleByName(art.value);
        const box = $('#art-preview', root);
        if (a) {
          const mats = sortedMaterials(a);
          hint.hidden = true;
          box.innerHTML = mats.length
            ? `<ul class="mats preview">${mats.map((m) => materialRow(m, { take: false })).join('')}</ul>`
            : '<p class="hint preview-empty">Für diesen Artikel ist noch kein Material hinterlegt.</p>';
        } else {
          box.innerHTML = '';
          hint.hidden = !art.value.trim();
          hint.textContent = `„${art.value.trim()}“ ist neu und wird beim Speichern angelegt.`;
        }
      };
      attachSuggest(art, {
        source: (q) => {
          const m = matcher(q);
          return rank(store.articles(), (a) => (q.trim() ? m(a.name) : 1), (x, y) => natCmp(x.name, y.name))
            .filter(({ x }) => norm(x.name) !== norm(q))
            .map(({ x }) => ({
              label: x.name,
              sub: plural((x.materialIds || []).length, 'Material', 'Materialien'),
              name: x.name,
            }));
        },
        onPick: (it) => { art.value = it.name; preview(); note.focus(); },
        max: 12,
      });
      art.addEventListener('input', preview);
      nextOnEnter(nr, art, note);

      let status = initialStatus;
      const seg = $('.status-seg', root);
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-status]');
        if (!b) return;
        status = b.dataset.status;
        $$('[data-status]', seg).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('#after-field', root).hidden = status !== 'naechstes';
      });

      $('#f', root).addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          const after = status === 'naechstes' ? $('#after', root).value : '';
          const saved = store.saveOrder({ id: o?.id, nr: nr.value, note: note.value, articleName: art.value, status, after });
          toast(presetAfter && after === presetAfter ? `${saved.nr} kommt nach ${store.getOrder(after)?.nr}` : 'Auftrag gespeichert');
          if (o || (presetAfter && after === presetAfter)) back(o ? `#/auftrag/${saved.id}` : `#/auftrag/${presetAfter}`);
          else replace(`#/auftrag/${saved.id}`);
        } catch (ex) {
          $('#err', root).textContent = ex.message;
        }
      });
      $('#del', root)?.addEventListener('click', () => {
        if (!confirm(`Auftrag ${o.nr} löschen?\n\nArtikel und Materialien bleiben erhalten.`)) return;
        store.deleteOrder(o.id);
        toast('Auftrag gelöscht');
        replace('#/auftraege');
      });

      preview();
      if (!o) (presetNr ? art : nr).focus();
    },
  };
}

// ======================================================================
// Artikel
// ======================================================================

function viewArticles(query) {
  const onlyOpen = new URLSearchParams(query || '').get('offen') === '1';
  return {
    title: 'Artikel',
    tab: 'artikel',
    html: `${filterField('Artikel filtern …', 'artikel')}
      ${onlyOpen ? filterChip('Nur Artikel ohne Material', '#/artikel') : ''}
      <div id="list"></div>
      <a class="fab" href="#/artikel/neu" aria-label="Neuer Artikel">${icon.plus}</a>`,
    mount(root) {
      const draw = () => {
        const q = state.filter.artikel;
        const m = matcher(q);
        let list = store.articles().filter((a) => !onlyOpen || !(a.materialIds || []).length);
        if (q.trim()) {
          list = list.filter((a) => m(a.name)
            || store.articleMaterials(a).some((x) => m(x.nr) || m(x.description)));
        }
        list.sort((a, b) => natCmp(a.name, b.name));
        $('#list', root).innerHTML = list.length
          ? `<ul class="card list">${list.map(articleRow).join('')}</ul>`
          : store.articles().length
            ? emptyBox('Keine Treffer', onlyOpen ? 'Alle Artikel haben Material hinterlegt.' : 'Filter anpassen oder löschen.')
            : emptyBox('Noch keine Artikel', 'Artikel entstehen beim Anlegen eines Auftrags – oder tippe auf <b>+</b>.');
      };
      bindFilter(root, 'artikel', draw);
      draw();
      return draw;
    },
  };
}

function viewArticle(id) {
  const a = store.getArticle(id);
  if (!a) return notFound('Artikel');
  const ords = store.ordersWithArticle(a.id);
  const nMat = (a.materialIds || []).length;
  const nFiles = store.articleFiles(a).length;
  return {
    title: 'Artikel',
    back: '#/artikel',
    tab: 'artikel',
    action: editAction(`#/artikel/${a.id}/bearbeiten`, 'Artikel umbenennen'),
    html: `
      <div class="detail-head">
        <span class="eyebrow">Artikel</span>
        <div class="detail-title">${esc(a.name)}</div>
      </div>
      ${sectionTitle('Materialien', nMat)}
      ${nMat ? `<div class="card art">${materialList(a)}</div>` : ''}
      <a class="btn btn-primary btn-block" href="#/artikel/${a.id}/material/neu">${icon.plus}<span>Material hinzufügen</span></a>
      ${sectionTitle('Packhinweise', nFiles)}
      <div class="card files-card">${fileStrip(a, { add: true })}
        ${nFiles ? '' : '<p class="hint">Foto oder PDF mit Packschema, Lagenbild o. Ä. – erscheint dann bei jedem Auftrag mit diesem Artikel.</p>'}</div>
      ${sectionTitle('Aufträge mit diesem Artikel', ords.length)}
      ${ords.length ? `<ul class="card list">${ords.map(orderRow).join('')}</ul>`
        : '<p class="hint">Noch keinem Auftrag zugeordnet.</p>'}`,
  };
}

function viewArticleEdit(id, query) {
  const a = id ? store.getArticle(id) : null;
  if (id && !a) return notFound('Artikel');
  const preset = new URLSearchParams(query || '').get('name') || '';
  return {
    title: a ? 'Artikel umbenennen' : 'Neuer Artikel',
    back: a ? `#/artikel/${a.id}` : '#/artikel',
    tab: 'artikel',
    form: true,
    html: `
      <form class="card form" id="f" novalidate>
        ${field({ id: 'name', label: 'Artikelbezeichnung', value: a?.name ?? preset, placeholder: 'z. B. 5er, 200er', attrs: 'autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done"' })}
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Speichern</button>
      </form>
      ${a ? deleteButton('Artikel löschen') : ''}`,
    mount(root) {
      const name = $('#name', root);
      $('#f', root).addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          const saved = store.saveArticle({ id: a?.id, name: name.value });
          toast('Artikel gespeichert');
          if (a) back(`#/artikel/${saved.id}`);
          else replace(`#/artikel/${saved.id}`);
        } catch (ex) {
          $('#err', root).textContent = ex.message;
        }
      });
      $('#del', root)?.addEventListener('click', () => {
        const n = store.ordersWithArticle(a.id).length;
        const extra = n ? `\n\nEr wird aus ${plural(n, 'Auftrag', 'Aufträgen')} entfernt.` : '';
        if (!confirm(`Artikel „${a.name}“ löschen?${extra}\n\nDie Materialien bleiben erhalten.`)) return;
        store.deleteArticle(a.id);
        toast('Artikel gelöscht');
        replace('#/artikel');
      });
      if (!a) name.focus();
    },
  };
}

/** Material (per Artikelnummer) einem Artikel zuordnen. */
function viewAddMaterial(articleId) {
  const a = store.getArticle(articleId);
  if (!a) return notFound('Artikel');
  return {
    title: 'Material hinzufügen',
    back: `#/artikel/${a.id}`,
    tab: 'artikel',
    form: true,
    html: `
      <p class="context">für Artikel <b>${esc(a.name)}</b></p>
      <form class="card form" id="f" novalidate>
        ${field({ id: 'm-nr', label: 'Artikelnummer', value: '', placeholder: 'z. B. 001240007100', attrs: `${CODE_ATTRS} enterkeyhint="next"`, suggest: true })}
        ${field({ id: 'm-desc', label: 'Beschreibung', optional: true, placeholder: 'z. B. Lagerbeutel 70x100', attrs: 'autocomplete="off" enterkeyhint="next"', suggest: true })}
        ${field({ id: 'm-loc', label: 'Lagerort', optional: true, placeholder: 'z. B. R3-F2', attrs: `${CODE_ATTRS} enterkeyhint="done"`, suggest: true })}
        <p class="info" id="shared-info" hidden></p>
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Speichern</button>
        <button class="btn btn-secondary btn-block" type="button" id="save-next">Speichern &amp; nächstes Material</button>
      </form>
      <div id="existing"></div>`,
    mount(root) {
      const nr = $('#m-nr', root);
      const desc = $('#m-desc', root);
      const loc = $('#m-loc', root);
      const info = $('#shared-info', root);
      const err = $('#err', root);
      // Zuletzt automatisch übernommene Werte – nur diese dürfen wieder überschrieben/geleert werden.
      let auto = { desc: null, loc: null };

      const updateInfo = () => {
        const match = store.findMaterialByNr(nr.value);
        if (!match) { info.hidden = true; return; }
        const others = store.articlesWithMaterial(match.id).filter((x) => x.id !== a.id).length;
        const inThis = (a.materialIds || []).includes(match.id);
        info.hidden = false;
        info.textContent = [
          'Bekanntes Material.',
          inThis ? 'Ist diesem Artikel schon zugeordnet.' : '',
          others ? `Auch in ${plural(others, 'anderem Artikel', 'anderen Artikeln')} verwendet – Beschreibung und Lagerort gelten überall.` : '',
        ].filter(Boolean).join(' ');
      };
      const fill = (m) => {
        nr.value = m.nr;
        desc.value = m.description || '';
        loc.value = m.location || '';
        auto = { desc: desc.value, loc: loc.value };
        updateInfo();
      };
      nr.addEventListener('input', () => {
        const match = store.findMaterialByNr(nr.value);
        if (match) {
          if (!desc.value || desc.value === auto.desc) desc.value = match.description || '';
          if (!loc.value || loc.value === auto.loc) loc.value = match.location || '';
          auto = { desc: match.description || '', loc: match.location || '' };
        } else {
          if (auto.desc !== null && desc.value === auto.desc) desc.value = '';
          if (auto.loc !== null && loc.value === auto.loc) loc.value = '';
          auto = { desc: null, loc: null };
        }
        updateInfo();
      });

      const suggestMaterials = (q, score, exact) => {
        if (!q.trim()) return [];
        const mm = matcher(q);
        return rank(store.materials(), (x) => score(mm, x), (x, y) => natCmp(x.nr, y.nr))
          .filter(({ x }) => norm(exact(x)) !== norm(q))
          .map(({ x }) => ({
            label: x.description ? `${x.nr} – ${x.description}` : x.nr,
            sub: [x.location ? `Lagerort ${x.location}` : 'kein Lagerort',
              (a.materialIds || []).includes(x.id) ? 'schon im Artikel' : ''].filter(Boolean).join(' · '),
            mat: x,
          }));
      };
      attachSuggest(nr, {
        source: (q) => suggestMaterials(q, (mm, x) => Math.max(mm(x.nr) * 10, mm(x.description)), (x) => x.nr),
        onPick: (it) => fill(it.mat),
      });
      attachSuggest(desc, {
        source: (q) => suggestMaterials(q, (mm, x) => Math.max(mm(x.description) * 10, mm(x.nr)), (x) => x.description),
        onPick: (it) => fill(it.mat),
      });
      locationSuggest(loc);
      nextOnEnter(nr, desc, loc);

      const drawExisting = () => {
        const mats = sortedMaterials(a);
        $('#existing', root).innerHTML = mats.length
          ? `${sectionTitle('Bereits zugeordnet', mats.length)}<div class="card"><ul class="mats pad">${mats.map((m) => materialRow(m, { take: false })).join('')}</ul></div>`
          : '';
      };
      const save = (andNext) => {
        err.textContent = '';
        try {
          store.addMaterialToArticle(a.id, { nr: nr.value, description: desc.value, location: loc.value });
        } catch (ex) {
          err.textContent = ex.message;
          return;
        }
        if (andNext) {
          toast('Gespeichert – nächstes Material');
          for (const el of [nr, desc, loc]) el.value = '';
          auto = { desc: null, loc: null };
          info.hidden = true;
          drawExisting();
          nr.focus();
        } else {
          toast('Material gespeichert');
          back(`#/artikel/${a.id}`);
        }
      };
      $('#f', root).addEventListener('submit', (e) => { e.preventDefault(); save(false); });
      $('#save-next', root).addEventListener('click', () => save(true));
      drawExisting();
      nr.focus();
    },
  };
}

// ======================================================================
// Material
// ======================================================================

// ======================================================================
// Packhinweise
// ======================================================================

function viewFile(articleId, fileId) {
  const a = store.getArticle(articleId);
  const f = store.getArticleFile(a, fileId);
  if (!f) return notFound('Packhinweis');
  const pdf = isPdf(f);
  const view = {
    title: 'Packhinweis',
    back: `#/artikel/${a.id}`,
    tab: 'artikel',
    action: `<button type="button" class="icon-btn" id="rename" aria-label="Umbenennen" title="Umbenennen">${icon.edit}</button>`,
    html: `
      <div class="detail-head">
        <span class="eyebrow">Packhinweis · <a href="#/artikel/${a.id}">${esc(a.name)}</a></span>
        <div class="detail-title" id="file-title">${esc(f.name)}</div>
        <div class="detail-sub">${pdf ? 'PDF' : 'Foto'} · ${fileSize(f.size)} · ${formatDate(f.createdAt)}</div>
      </div>
      <div class="file-view${pdf ? ' is-pdf' : ''}" id="file-box"><div class="loading"><span class="spinner"></span>Wird geladen …</div></div>
      <p class="hint center" id="zoom-hint" hidden>Mit zwei Fingern vergrößern.</p>
      <button type="button" class="btn btn-secondary btn-block" id="share" hidden>${icon.share}<span>${pdf ? 'In anderer App öffnen / teilen' : 'Teilen / speichern'}</span></button>
      ${deleteButton('Packhinweis löschen')}`,
    mount(root) {
      let url = '';
      let file = null;
      let cleanup = null;
      let deleting = false;
      const alive = () => currentView === view;
      const box = $('#file-box', root);
      const cur = () => store.getArticleFile(store.getArticle(a.id), f.id) || f;

      store.loadFile(f).then(async (blob) => {
        if (!alive()) return;
        const ext = pdf ? 'pdf' : (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
        file = new File([blob], `${cur().name.replace(/[\\/:*?"<>|]+/g, '-')}.${ext}`, { type: blob.type });
        url = URL.createObjectURL(blob);
        $('#share', root).hidden = false;
        if (!pdf) {
          box.innerHTML = `<img class="file-img" src="${url}" alt="${esc(f.name)}">`;
          $('#zoom-hint', root).hidden = false;
          return;
        }
        box.innerHTML = '';
        try {
          cleanup = await renderPdf(blob, box, alive);
          if (alive()) $('#zoom-hint', root).hidden = false;
        } catch (ex) {
          console.error(ex);
          box.innerHTML = '<p class="empty-inline pad">PDF kann hier nicht angezeigt werden – über den Knopf unten in einer anderen App öffnen.</p>';
        }
      }).catch((ex) => {
        console.error(ex);
        if (alive()) box.innerHTML = `<p class="empty-inline pad">${esc(ex.message)}</p>`;
      });

      // Beim Verlassen der Ansicht Speicher freigeben
      const leave = () => {
        if (alive()) return;
        window.removeEventListener('hashchange', leave);
        if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
        cleanup?.();
      };
      window.addEventListener('hashchange', leave);

      $('#share', root).addEventListener('click', async () => {
        if (!file) return;
        try {
          if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file], title: file.name });
          } else {
            const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
            document.body.append(link);
            link.click();
            link.remove();
          }
        } catch (ex) {
          if (ex.name !== 'AbortError') toast(`Teilen nicht möglich: ${ex.message}`, 'error');
        }
      });
      $('#rename').addEventListener('click', () => {
        const name = prompt('Name des Packhinweises:', cur().name);
        if (name == null || !name.trim()) return;
        store.renameArticleFile(a.id, f.id, name);
        toast('Umbenannt');
      });
      $('#del', root).addEventListener('click', () => {
        if (!confirm(`Packhinweis „${cur().name}“ löschen?`)) return;
        deleting = true;
        store.removeArticleFile(a.id, f.id);
        toast('Packhinweis gelöscht');
        back(`#/artikel/${a.id}`);
      });

      // Datenänderungen (auch von anderen Handys): Datei nicht neu laden, nur den Namen nachziehen.
      return () => {
        if (deleting || !alive()) return;
        if (!store.getArticleFile(store.getArticle(a.id), f.id)) {
          toast('Packhinweis wurde gelöscht');
          replace(`#/artikel/${a.id}`);
          return;
        }
        $('#file-title', root).textContent = cur().name;
      };
    },
  };
  return view;
}

/**
 * Datei-Auswahl für Packhinweise: ein festes, unsichtbares Eingabefeld außerhalb der Ansichten,
 * damit die Auswahl nicht verloren geht, falls die Ansicht währenddessen neu gezeichnet wird.
 */
const uploadInput = Object.assign(document.createElement('input'), {
  type: 'file', accept: ACCEPT, multiple: true, hidden: true, id: 'upload',
});
document.body.append(uploadInput);
let uploadTarget = null;

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-upload]');
  if (!b) return;
  uploadTarget = b.dataset.upload;
  uploadInput.click();
});

uploadInput.addEventListener('change', async () => {
  const chosen = [...uploadInput.files];
  uploadInput.value = '';
  const articleId = uploadTarget;
  if (!chosen.length || !store.getArticle(articleId)) return;
  toast(chosen.length > 1 ? `${chosen.length} Dateien werden vorbereitet …` : 'Wird vorbereitet …');
  let ok = 0;
  const errors = [];
  for (const file of chosen) {
    try {
      await store.addArticleFile(articleId, await prepareUpload(file));
      ok += 1;
    } catch (ex) {
      console.error(ex);
      errors.push(ex.message);
    }
  }
  if (errors.length) toast(errors.join(' '), 'error');
  else toast(`${plural(ok, 'Packhinweis', 'Packhinweise')} gespeichert${navigator.onLine ? '' : ' – wird hochgeladen, sobald Empfang da ist'}`);
});

function viewMaterials(query) {
  const onlyOpen = new URLSearchParams(query || '').get('offen') === '1';
  const sorts = [['location', 'Lagerort'], ['description', 'Beschreibung'], ['nr', 'Nummer']];
  return {
    title: 'Material',
    tab: 'material',
    html: `${filterField('Material oder Lagerort filtern …', 'material')}
      ${onlyOpen ? filterChip('Nur Material ohne Lagerort', '#/material') : ''}
      <div class="seg" role="group" aria-label="Sortieren nach">
        ${sorts.map(([k, l]) => `<button type="button" data-sort="${k}">${l}</button>`).join('')}
      </div>
      <div id="list"></div>
      <a class="fab" href="#/material/neu" aria-label="Neues Material">${icon.plus}</a>`,
    mount(root) {
      const seg = $('.seg', root);
      const syncSeg = () => $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === prefs.materialSort)));
      const draw = () => {
        const q = state.filter.material;
        const m = matcher(q);
        const key = prefs.materialSort;
        let list = store.materials().filter((x) => !onlyOpen || !x.location);
        if (q.trim()) list = list.filter((x) => m(x.nr) || m(x.description) || m(x.location));
        list.sort((x, y) => (key === 'location'
          ? locCmp(x.location, y.location) || natCmp(x.nr, y.nr)
          : natCmp(x[key] || '~', y[key] || '~') || natCmp(x.nr, y.nr)));
        $('#list', root).innerHTML = list.length
          ? `<div class="card"><ul class="mats pad">${list.map((x) => {
            const used = store.articlesWithMaterial(x.id).map((a) => esc(a.name));
            return materialRow(x, { note: used.length ? `für ${used.join(', ')}` : '<span class="warn-text">keinem Artikel zugeordnet</span>' });
          }).join('')}</ul></div>`
          : store.materials().length
            ? emptyBox('Keine Treffer', onlyOpen ? 'Alle Materialien haben einen Lagerort.' : 'Filter anpassen oder löschen.')
            : emptyBox('Noch kein Material', 'Material legst du am einfachsten direkt beim Artikel an – oder tippe auf <b>+</b>.');
      };
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        prefs.materialSort = b.dataset.sort;
        savePrefs();
        syncSeg();
        draw();
      });
      bindFilter(root, 'material', draw);
      syncSeg();
      draw();
      return draw;
    },
  };
}

/** Material ansehen/bearbeiten (Artikelnummer, Beschreibung, Lagerort) + Entnehmen. */
function viewMaterial(id, query) {
  const m = id ? store.getMaterial(id) : null;
  if (id && !m) return notFound('Material');
  const fromArticle = store.getArticle(new URLSearchParams(query || '').get('artikel') || '');
  const used = m ? store.articlesWithMaterial(m.id) : [];
  const inFromArticle = fromArticle && m && (fromArticle.materialIds || []).includes(m.id);
  return {
    title: m ? 'Material' : 'Neues Material',
    back: fromArticle ? `#/artikel/${fromArticle.id}` : '#/material',
    tab: 'material',
    form: true,
    html: `
      ${m ? `<div class="detail-head mat-head">
        ${locBadge(m.location)}
        <div><span class="eyebrow">Artikelnummer</span><div class="detail-title small">${esc(m.nr)}</div>
          ${m.description ? `<div class="detail-sub">${esc(m.description)}</div>` : ''}</div>
      </div>
      <div class="take-big" id="take-box">${takeButton(m)}</div>` : ''}
      <form class="card form" id="f" novalidate>
        ${field({ id: 'nr', label: 'Artikelnummer', value: m?.nr, placeholder: 'z. B. 001240007100', attrs: `${CODE_ATTRS} enterkeyhint="next"` })}
        ${field({ id: 'desc', label: 'Beschreibung', optional: true, value: m?.description, placeholder: 'z. B. Lagerbeutel 70x100', attrs: 'autocomplete="off" enterkeyhint="next"' })}
        ${field({ id: 'loc', label: 'Lagerort', optional: true, value: m?.location, placeholder: 'z. B. R3-F2', attrs: `${CODE_ATTRS} enterkeyhint="done"`, suggest: true,
          hint: used.length > 1 ? `Gilt für alle ${used.length} Artikel, die dieses Material verwenden.` : '' })}
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Speichern</button>
      </form>
      ${m ? `${sectionTitle('Verwendet in', used.length)}
        ${used.length ? `<ul class="card list">${used.map(articleRow).join('')}</ul>` : '<p class="hint">Keinem Artikel zugeordnet.</p>'}
        ${inFromArticle ? `<button type="button" class="btn btn-secondary btn-block" id="unlink">${icon.close}<span>Aus Artikel „${esc(fromArticle.name)}“ entfernen</span></button>` : ''}
        ${deleteButton('Material ganz löschen')}` : ''}`,
    mount(root) {
      const nr = $('#nr', root);
      const desc = $('#desc', root);
      const loc = $('#loc', root);
      locationSuggest(loc);
      nextOnEnter(nr, desc, loc);
      $('#f', root).addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          store.saveMaterial({ id: m?.id, nr: nr.value, description: desc.value, location: loc.value });
          toast('Material gespeichert');
          back(fromArticle ? `#/artikel/${fromArticle.id}` : '#/material');
        } catch (ex) {
          $('#err', root).textContent = ex.message;
        }
      });
      $('#unlink', root)?.addEventListener('click', () => {
        store.removeMaterialFromArticle(fromArticle.id, m.id);
        toast(`Aus „${fromArticle.name}“ entfernt`);
        back(`#/artikel/${fromArticle.id}`);
      });
      $('#del', root)?.addEventListener('click', () => {
        const extra = used.length ? `\n\nEs wird aus ${plural(used.length, 'Artikel', 'Artikeln')} entfernt.` : '';
        if (!confirm(`Material ${m.nr} ganz löschen?${extra}`)) return;
        store.deleteMaterial(m.id);
        toast('Material gelöscht');
        replace('#/material');
      });
      if (!m) nr.focus();
      // Nur den Entnehmen-Zähler auffrischen, nicht das Formular.
      if (m) return () => { const box = $('#take-box', root); if (box && store.getMaterial(m.id)) box.innerHTML = takeButton(store.getMaterial(m.id)); };
      return null;
    },
  };
}

// ======================================================================
// Bestellliste
// ======================================================================

function viewOrderList() {
  return {
    title: 'Bestellliste',
    tab: 'bestellliste',
    action: `<button type="button" class="icon-btn" id="share" aria-label="Bestellliste teilen" title="Teilen">${icon.share}</button>
      <a class="icon-btn" href="#/mehr" aria-label="Mehr" title="Mehr">${icon.gear}</a>`,
    html: '<div id="list"></div>',
    mount(root) {
      const draw = () => {
        const all = store.orderlist().filter((e) => store.getMaterial(e.materialId));
        const byLoc = (x, y) => locCmp(store.getMaterial(x.materialId).location, store.getMaterial(y.materialId).location);
        const open = all.filter((e) => e.status === 'offen').sort(byLoc);
        const ordered = all.filter((e) => e.status === 'bestellt').sort((x, y) => (y.orderedAt || '').localeCompare(x.orderedAt || ''));
        if (!all.length) {
          $('#list', root).innerHTML = emptyBox('Bestellliste ist leer',
            'Tippe überall, wo ein Lagerort steht, auf <b>Entnehmen</b> – das Material landet dann hier zum Nachbestellen.');
          return;
        }
        $('#list', root).innerHTML = `
          ${sectionTitle('Nachbestellen', open.length, open.length > 1 ? '<button type="button" class="link-btn" id="all-ordered">Alle bestellt</button>' : '')}
          ${open.length ? `<ul class="card ol">${open.map(openEntry).join('')}</ul>` : '<p class="hint">Nichts offen.</p>'}
          ${ordered.length ? `${sectionTitle('Bestellt', ordered.length)}<ul class="card ol">${ordered.map(orderedEntry).join('')}</ul>` : ''}`;
      };
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        if (b) {
          const { act, id } = b.dataset;
          if (act === 'plus') store.changeQty(id, 1);
          if (act === 'minus') store.changeQty(id, -1);
          if (act === 'ordered') { store.markOrdered([id]); toast('Als bestellt markiert'); }
          if (act === 'reopen') store.reopenEntry(id);
          if (act === 'done') {
            store.removeEntry(id);
            toast('Erledigt – aus der Liste entfernt');
          }
          return;
        }
        if (e.target.closest('#all-ordered')) {
          const open = store.orderlist().filter((x) => x.status === 'offen').map((x) => x.id);
          if (confirm(`${plural(open.length, 'Position', 'Positionen')} als bestellt markieren?`)) {
            store.markOrdered(open);
            toast('Alle als bestellt markiert');
          }
        }
      });
      $('#share').addEventListener('click', shareOrderList);
      draw();
      return draw;
    },
  };
}

function entryMain(e) {
  const m = store.getMaterial(e.materialId);
  return `${locBadge(m.location)}
    <a class="mat-body" href="#/material/${m.id}">
      <span class="mat-name">${esc(materialTitle(m))}</span>
      ${m.description ? `<span class="mat-meta">Nr. ${esc(m.nr)}</span>` : ''}
      <span class="mat-note muted">${e.status === 'bestellt' ? `bestellt ${esc(formatDate(e.orderedAt))}` : `seit ${esc(formatDate(e.createdAt))}`}</span>
    </a>`;
}

function openEntry(e) {
  return `<li class="ol-item">
    <div class="ol-top">${entryMain(e)}</div>
    <div class="ol-actions">
      <div class="stepper" role="group" aria-label="Menge">
        <button type="button" data-act="minus" data-id="${e.id}" aria-label="weniger">${icon.minus}</button>
        <b>${e.qty || 1}</b>
        <button type="button" data-act="plus" data-id="${e.id}" aria-label="mehr">${icon.plus}</button>
      </div>
      <button type="button" class="btn btn-secondary btn-small" data-act="ordered" data-id="${e.id}">${icon.check}<span>Bestellt</span></button>
    </div>
  </li>`;
}

function orderedEntry(e) {
  return `<li class="ol-item is-ordered">
    <div class="ol-top">${entryMain(e)}<b class="ol-qty">${e.qty || 1}×</b></div>
    <div class="ol-actions">
      <button type="button" class="btn btn-ghost btn-small" data-act="reopen" data-id="${e.id}">${icon.undo}<span>Zurück</span></button>
      <button type="button" class="btn btn-secondary btn-small" data-act="done" data-id="${e.id}">${icon.check}<span>Eingetroffen</span></button>
    </div>
  </li>`;
}

async function shareOrderList() {
  const open = store.orderlist().filter((e) => e.status === 'offen' && store.getMaterial(e.materialId));
  if (!open.length) { toast('Nichts zum Nachbestellen'); return; }
  const lines = open.map((e) => {
    const m = store.getMaterial(e.materialId);
    return `• ${e.qty || 1}× ${m.nr}${m.description ? ` – ${m.description}` : ''}${m.location ? ` (${m.location})` : ''}`;
  });
  const text = `Bestellliste Konfektionierung – ${new Date().toLocaleDateString('de-DE')}\n\n${lines.join('\n')}`;
  try {
    if (matchMedia('(pointer: coarse)').matches && navigator.share) {
      await navigator.share({ title: 'Bestellliste', text });
    } else {
      await navigator.clipboard.writeText(text);
      toast('Bestellliste kopiert');
    }
  } catch (ex) {
    if (ex.name !== 'AbortError') toast('Teilen nicht möglich', 'error');
  }
}

// ======================================================================
// Mehr: Datenbestand, Export, App-Installation, Abmelden
// ======================================================================

const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function viewMore() {
  return {
    title: 'Mehr',
    back: '#/suche',
    html: `
      ${sectionTitle('Datenbestand')}
      <div class="card stats">
        <a href="#/auftraege"><b>${store.orders().length}</b><span>Aufträge</span></a>
        <a href="#/artikel"><b>${store.articles().length}</b><span>Artikel</span></a>
        <a href="#/material"><b>${store.materials().length}</b><span>Materialien</span></a>
      </div>

      ${sectionTitle('Speicherung')}
      <div class="card box">
        <p>Die Daten liegen <b>online</b> (Firebase, Rechenzentrum Frankfurt). Alle Mitarbeiter sehen dieselben Daten,
          Änderungen erscheinen sofort auf allen Handys.</p>
        <p>Ohne Empfang funktioniert die App weiter – Änderungen werden übertragen, sobald wieder Verbindung besteht.</p>
        <button type="button" class="btn btn-secondary btn-block" id="export">${icon.download}<span>Sicherungskopie herunterladen</span></button>
      </div>

      ${isInstalled() ? '' : `${sectionTitle('Als App aufs Handy')}
      <div class="card box">
        <p><b>iPhone (Safari):</b> „Teilen“ ${icon.share} → „Zum Home-Bildschirm“.</p>
        <p><b>Android (Chrome):</b> Menü ⋮ → „App installieren“ oder „Zum Startbildschirm hinzufügen“.</p>
        <p class="hint">Danach einmal mit dem Passwort anmelden.</p>
      </div>`}

      <button type="button" class="btn btn-secondary btn-block" id="logout">${icon.logout}<span>Abmelden</span></button>
      <p class="version">BO-WERT Konfektionierung · v${APP_VERSION}</p>`,
    mount(root) {
      $('#export', root).addEventListener('click', exportBackup);
      $('#logout', root).addEventListener('click', logout);
    },
  };
}

async function exportBackup() {
  const name = `konfektionierung-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([store.exportJSON()], name, { type: 'application/json' });
  try {
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Konfektionierung – Sicherung' });
    } else {
      const url = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  } catch (ex) {
    if (ex.name !== 'AbortError') toast(`Sicherung fehlgeschlagen: ${ex.message}`, 'error');
  }
}

// ======================================================================
// Start
// ======================================================================

for (const tab of $$('.tab')) tab.insertAdjacentHTML('afterbegin', icon[tab.dataset.icon]);
$('#back').innerHTML = icon.back;

// „Entnehmen“ – funktioniert überall, wo ein Lagerort steht.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-take]');
  if (!b) return;
  e.preventDefault();
  const m = store.getMaterial(b.dataset.take);
  if (!m) return;
  const qty = store.takeMaterial(m.id);
  navigator.vibrate?.(25);
  for (const btn of $$(`[data-take="${m.id}"]`)) btn.outerHTML = takeButton(m);
  toast(`${materialTitle(m)}: ${qty}× auf der Bestellliste`, 'ok', {
    label: 'Rückgängig',
    run: () => store.changeOpenQty(m.id, -1),
  });
});

// Erneutes Tippen auf den aktiven Tab: Suche fokussieren bzw. nach oben scrollen.
$('.tabbar').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab || tab.getAttribute('href') !== currentHash()) return;
  e.preventDefault();
  const q = $('#q');
  if (q) { q.focus(); q.select(); } else window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Beim Tippen am Handy Tab-Leiste ausblenden, damit sie nicht über der Tastatur klebt.
const isTextInput = (el) => el?.matches?.('input:not([type=file]), textarea, select');
document.addEventListener('focusin', (e) => {
  if (isTextInput(e.target)) document.body.classList.add('typing');
});
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (!isTextInput(document.activeElement)) document.body.classList.remove('typing');
  }, 60);
});

window.addEventListener('online', updateChrome);
window.addEventListener('offline', updateChrome);

history.scrollRestoration = 'manual';
if (!location.hash) history.replaceState(null, '', '#/suche');
stack = [currentHash()];
window.addEventListener('hashchange', onHashChange);

store.onChange(scheduleRefresh);
store.onError((ex) => {
  console.error(ex);
  if (ex.code === 'permission-denied') toast('Keine Berechtigung – bitte neu anmelden.', 'error');
  else toast(`Fehler beim Speichern: ${ex.message}`, 'error');
});

store.watchAuth((user) => {
  if (user) {
    store.startSync();
    showScreen('app');
    render();
  } else {
    store.stopSync();
    showLogin();
  }
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service Worker:', e));
  // Neue Version aktiv → einmal neu laden, damit alle Dateien zusammenpassen.
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
}
