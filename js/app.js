// BO-WERT Konfektionierung – Auftrag → Artikel → Verpackungsmaterial mit Lagerort.

import * as store from './store.js';
import {
  $, $$, esc, norm, natCmp, locCmp, matcher, qtyLabel, plural,
  formatDate, daysSince, toast, icon, attachSuggest,
} from './ui.js';

const APP_VERSION = '1.0.0';
// SHA-256 des Passworts. Achtung: reiner Sichtschutz – auf GitHub Pages ist der Code öffentlich.
const PASS_HASH = '105664c1c5f377a29af73aa479297afe1e02b6cf8cf7925ae468729aa47f5837';
const AUTH_KEY = 'konf.auth';
const PREFS_KEY = 'konf.ui';
const LIST_LIMIT = 40;
const CODE_ATTRS = 'autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"';

// ======================================================================
// Geräte-Einstellungen & Sitzungszustand
// ======================================================================

const prefs = (() => {
  const defaults = { recent: [], numericSearch: false, orderMode: 'artikel', materialSort: 'location' };
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
// Login
// ======================================================================

let sessionAuthed = false;

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isAuthed() {
  if (sessionAuthed) return true;
  try { return localStorage.getItem(AUTH_KEY) === PASS_HASH; } catch { return false; }
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#pw').value = '';
  $('#login-msg').textContent = '';
  $('#pw').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  // Bittet den Browser, die Daten nicht automatisch zu löschen.
  navigator.storage?.persist?.().catch(() => {});
  render();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('#pw');
  const msg = $('#login-msg');
  let ok = false;
  try {
    // Klein geschrieben vergleichen – Handy-Tastaturen schreiben gern „Bowert“.
    ok = (await sha256(pw.value.trim().toLowerCase())) === PASS_HASH;
  } catch {
    msg.textContent = 'Anmeldung nicht möglich: Die Seite muss über https geöffnet werden.';
    return;
  }
  if (!ok) {
    msg.textContent = 'Das Passwort stimmt nicht.';
    pw.select();
    const card = $('.login-card');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    return;
  }
  sessionAuthed = true;
  try { localStorage.setItem(AUTH_KEY, PASS_HASH); } catch { /* dann nur für diese Sitzung */ }
  pw.blur();
  showApp();
});

function logout() {
  sessionAuthed = false;
  try { localStorage.removeItem(AUTH_KEY); } catch { /* egal */ }
  showLogin();
}

// ======================================================================
// Navigation (Hash-Routing mit eigener Verlaufs-Spur für „Zurück“)
// ======================================================================

let stack = [];
let pendingReplace = false;
let navWasBack = false;
let renderedHash = null;
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
  navWasBack = false;
  if (pendingReplace) {
    stack[stack.length - 1] = h;
    pendingReplace = false;
  } else if (stack.length > 1 && stack[stack.length - 2] === h) {
    stack.pop();
    navWasBack = true;
  } else {
    stack.push(h);
  }
  render();
  window.scrollTo(0, navWasBack ? scrollPos.get(h) || 0 : 0);
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
  [route('artikel/neu'), () => viewArticleEdit(null)],
  [route(`artikel/${ID}/bearbeiten`), (id) => viewArticleEdit(id)],
  [route(`artikel/${ID}/material/neu`), (aid) => viewItemEdit(aid, null)],
  [route(`artikel/${ID}/material/${ID}`), (aid, mid) => viewItemEdit(aid, mid)],
  [route(`artikel/${ID}`), (id) => viewArticle(id)],
  [route(`material${Q}`), (q) => viewMaterials(q)],
  [route('material/neu'), () => viewMaterialEdit(null)],
  [route(`material/${ID}`), (id) => viewMaterialEdit(id)],
  [route('mehr'), () => viewMore()],
];

function render() {
  if (!isAuthed()) { showLogin(); return; }
  const h = currentHash();
  let view = null;
  for (const [re, make] of routes) {
    const m = h.match(re);
    if (m) { view = make(...m.slice(1)); break; }
  }
  mount(view || notFound());
  renderedHash = h;
}

function mount(view) {
  $('#title').textContent = view.title;
  document.title = `${view.title} · Konfektionierung`;
  const backBtn = $('#back');
  backBtn.hidden = !view.back;
  backBtn.onclick = () => back(view.back);
  $('#brand').hidden = Boolean(view.back);
  $('#topbar-action').innerHTML = view.action || '';
  const main = $('#main');
  main.innerHTML = view.html;
  for (const tab of $$('.tab')) {
    const active = tab.dataset.tab === view.tab;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  view.mount?.(main);
}

// ======================================================================
// Bausteine
// ======================================================================

const sectionTitle = (text, count) =>
  `<h2 class="section-title">${esc(text)}${count != null ? ` <span class="count">${count}</span>` : ''}</h2>`;

const editAction = (href, label) =>
  `<a class="icon-btn" href="${href}" aria-label="${esc(label)}" title="${esc(label)}">${icon.edit}</a>`;

const locBadge = (loc) =>
  loc ? `<span class="loc">${esc(loc)}</span>` : '<span class="loc loc-none">kein Lagerort</span>';

/** Listenzeile; title/sub/tag werden bereits escaped übergeben. */
function row({ href, title, sub = '', lead = '', tag = '' }) {
  return `<li><a class="row" href="${href}">${lead}
    <span class="row-main"><span class="row-title">${title}</span>${sub ? `<span class="row-sub">${sub}</span>` : ''}</span>
    ${tag}${icon.chevron}</a></li>`;
}

function materialRow(m, { qty = '', href = '', extra = '', note = '' } = {}) {
  const tag = href ? 'a' : 'div';
  const meta = [m.nr ? `Nr. ${esc(m.nr)}` : 'ohne Nr.', qty ? `<b>${esc(qtyLabel(qty))}</b>` : '', extra]
    .filter(Boolean).join(' · ');
  return `<li><${tag} class="mat"${href ? ` href="${href}"` : ''}>
    ${locBadge(m.location)}
    <span class="mat-body">
      <span class="mat-name">${esc(m.name || '(ohne Bezeichnung)')}</span>
      <span class="mat-meta">${meta}</span>
      ${note ? `<span class="mat-note">${note}</span>` : ''}
    </span>
    ${href ? icon.chevron : ''}
  </${tag}></li>`;
}

function materialList(a, { editable = false } = {}) {
  const rows = a.items
    .map((it) => ({ m: store.getMaterial(it.materialId), qty: it.qty }))
    .filter((r) => r.m);
  if (!rows.length) {
    return `<p class="empty-inline">Noch kein Verpackungsmaterial hinterlegt.
      <a href="#/artikel/${a.id}/material/neu">Material hinzufügen</a></p>`;
  }
  return `<ul class="mats">${rows.map((r) => materialRow(r.m, {
    qty: r.qty,
    href: editable ? `#/artikel/${a.id}/material/${r.m.id}` : '',
  })).join('')}</ul>`;
}

function articleBlock(a, opts) {
  return `<section class="art">
    <a class="art-head" href="#/artikel/${a.id}">
      <span class="art-code">Artikel ${esc(a.code)}</span>${a.name ? `<span class="art-name">${esc(a.name)}</span>` : ''}
    </a>
    ${materialList(a, opts)}
  </section>`;
}

const orderArticles = (o) => o.articleIds.map(store.getArticle).filter(Boolean);

function orderCard(o, { primary = false } = {}) {
  const arts = orderArticles(o);
  return `<article class="card">
    <a class="card-head" href="#/auftrag/${o.id}"${primary ? ' data-primary' : ''}>
      <span class="card-head-main">
        <span class="eyebrow">Auftrag</span>
        <span class="card-title">${esc(o.nr)}</span>
        ${o.note ? `<span class="card-sub">${esc(o.note)}</span>` : ''}
      </span>${icon.chevron}
    </a>
    ${arts.length ? arts.map((a) => articleBlock(a)).join('')
      : `<p class="empty-inline pad">Kein Artikel zugeordnet. <a href="#/auftrag/${o.id}/bearbeiten">Artikel zuordnen</a></p>`}
  </article>`;
}

function articleCard(a, { primary = false } = {}) {
  const ords = store.ordersWithArticle(a.id);
  const shown = ords.slice(0, 6).map((o) => `<a href="#/auftrag/${o.id}">${esc(o.nr)}</a>`).join(', ');
  return `<article class="card">
    <a class="card-head" href="#/artikel/${a.id}"${primary ? ' data-primary' : ''}>
      <span class="card-head-main">
        <span class="eyebrow">Artikel</span>
        <span class="card-title">${esc(a.code)}</span>
        ${a.name ? `<span class="card-sub">${esc(a.name)}</span>` : ''}
      </span>${icon.chevron}
    </a>
    <div class="art">${materialList(a)}</div>
    ${ords.length ? `<p class="card-foot">Aufträge: ${shown}${ords.length > 6 ? ` +${ords.length - 6}` : ''}</p>` : ''}
  </article>`;
}

function orderRow(o) {
  const codes = orderArticles(o).map((a) => a.code);
  const sub = [codes.length ? `Artikel ${codes.join(', ')}` : '', o.note].filter(Boolean).join(' · ');
  return row({
    href: `#/auftrag/${o.id}`,
    title: esc(o.nr),
    sub: esc(sub),
    tag: codes.length ? '' : '<span class="tag">kein Artikel</span>',
  });
}

function articleRow(a) {
  const n = store.ordersWithArticle(a.id).length;
  const sub = [a.name, plural(a.items.length, 'Material', 'Materialien'), plural(n, 'Auftrag', 'Aufträge')]
    .filter(Boolean).join(' · ');
  return row({
    href: `#/artikel/${a.id}`,
    title: esc(a.code),
    sub: esc(sub),
    tag: a.items.length ? '' : '<span class="tag">kein Material</span>',
  });
}

const usageText = (m) => {
  const n = store.articlesWithMaterial(m.id).length;
  return n ? `in ${plural(n, 'Artikel', 'Artikeln')}` : '<span class="warn-text">nicht verwendet</span>';
};

function field({ id, label, value = '', placeholder = '', optional = false, attrs = '', hint = '', suggest = false }) {
  const input = `<input id="${id}" class="input" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" ${attrs}>`;
  return `<div class="field">
    <label for="${id}">${esc(label)}${optional ? ' <span class="opt">optional</span>' : ''}</label>
    ${suggest ? `<div class="suggest-wrap">${input}</div>` : input}
    ${hint ? `<p class="hint">${hint}</p>` : ''}
  </div>`;
}

const deleteButton = (label) =>
  `<button type="button" class="btn btn-danger btn-block" id="del">${icon.trash}<span>${esc(label)}</span></button>`;

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

const filterChip = (label, href) =>
  `<a class="filter-chip" href="${href}">${esc(label)}${icon.close}</a>`;

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
        // Tastatur neu öffnen, damit der Wechsel sofort greift.
        input.blur();
        input.focus();
      });
      draw();
      if (matchMedia('(pointer: fine)').matches) input.focus();
    },
  };
}

function rank(list, score, tiebreak) {
  return list
    .map((x) => ({ x, s: score(x) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || tiebreak(a.x, b.x));
}

function searchResults(q) {
  if (!q.trim()) return searchHome();
  const m = matcher(q);
  const orders = rank(store.orders(), (o) => Math.max(m(o.nr) * 10, m(o.note)), (a, b) => natCmp(a.nr, b.nr));
  const arts = rank(store.articles(), (a) => Math.max(m(a.code) * 10, m(a.name)), (a, b) => natCmp(a.code, b.code));
  const mats = rank(store.materials(), (x) => Math.max(m(x.nr) * 10, m(x.name) * 2, m(x.location) * 2),
    (a, b) => locCmp(a.location, b.location));

  if (!orders.length && !arts.length && !mats.length) {
    return emptyBox('Nichts gefunden', `Kein Auftrag, Artikel oder Material passt zu „${esc(q.trim())}“.`,
      `<a class="btn btn-primary" href="#/auftrag/neu?nr=${encodeURIComponent(q.trim())}">${icon.plus}
        <span>Auftrag „${esc(q.trim())}“ anlegen</span></a>`);
  }

  const out = [];
  let primaryUsed = false;
  // Ein exakter Treffer (oder ein einziger) wird mit Enter direkt geöffnet.
  const isPrimary = (r, total) => {
    if (primaryUsed || !(total === 1 || r.s >= 30)) return false;
    primaryUsed = true;
    return true;
  };

  // Wenige Treffer: komplett aufgeklappt (mit Material + Lagerort). Viele: exakte Treffer aufgeklappt, Rest als Liste.
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
      const used = store.articlesWithMaterial(x.id).map((a) => esc(a.code));
      return materialRow(x, {
        href: `#/material/${x.id}`,
        note: used.length ? `für Artikel ${used.join(', ')}` : '',
      });
    }).join('')}</ul></div>`);
  }
  return out.join('');
}

function searchHome() {
  if (store.isEmpty()) {
    return `<div class="card intro">
      <h2>So funktioniert’s</h2>
      <ol class="steps">
        <li><b>Auftrag anlegen</b> und die ArtikelID(s) zuordnen.</li>
        <li><b>Material hinterlegen:</b> beim Artikel die Verpackungsmaterialien mit Lagerort eintragen.</li>
        <li><b>Im Lager nachschlagen:</b> Auftragsnummer hier eintippen – sofort sehen, was gebraucht wird und wo es liegt.</li>
      </ol>
      <a class="btn btn-primary btn-block" href="#/auftrag/neu">${icon.plus}<span>Ersten Auftrag anlegen</span></a>
    </div>`;
  }
  const recent = prefs.recent.map(store.getOrder).filter(Boolean);
  const noMaterial = store.articles().filter((a) => !a.items.length).length;
  const noLocation = store.materials().filter((m) => !m.location).length;
  const todo = [
    noMaterial && row({ href: '#/artikel?offen=1', title: esc(`${plural(noMaterial, 'Artikel', 'Artikel')} ohne Material`), sub: 'Verpackungsmaterial hinterlegen' }),
    noLocation && row({ href: '#/material?offen=1', title: esc(`${plural(noLocation, 'Material', 'Materialien')} ohne Lagerort`), sub: 'Lagerort eintragen' }),
  ].filter(Boolean);
  return `
    ${recent.length
      ? `${sectionTitle('Zuletzt angesehen')}<ul class="card list">${recent.map(orderRow).join('')}</ul>`
      : '<p class="hint center">Auftragsnummer, ArtikelID, Materialnummer oder Lagerort eintippen.</p>'}
    ${todo.length ? `${sectionTitle('Noch offen')}<ul class="card list">${todo.join('')}</ul>` : ''}
    <a class="btn btn-secondary btn-block" href="#/auftrag/neu">${icon.plus}<span>Neuer Auftrag</span></a>`;
}

// ======================================================================
// Aufträge
// ======================================================================

function viewOrders() {
  return {
    title: 'Aufträge',
    tab: 'auftraege',
    html: `${filterField('Aufträge filtern …', 'auftraege')}<div id="list"></div>
      <a class="fab" href="#/auftrag/neu" aria-label="Neuer Auftrag">${icon.plus}</a>`,
    mount(root) {
      const draw = () => {
        const q = state.filter.auftraege;
        const m = matcher(q);
        let list = [...store.orders()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (q.trim()) {
          list = list.filter((o) => m(o.nr) || m(o.note) || orderArticles(o).some((a) => m(a.code) || m(a.name)));
        }
        $('#list', root).innerHTML = list.length
          ? `<ul class="card list">${list.map(orderRow).join('')}</ul>`
          : store.orders().length
            ? emptyBox('Keine Treffer', 'Filter anpassen oder löschen.')
            : emptyBox('Noch keine Aufträge', 'Tippe auf <b>+</b>, um den ersten Auftrag anzulegen.');
      };
      bindFilter(root, 'auftraege', draw);
      draw();
    },
  };
}

function viewOrder(id) {
  const o = store.getOrder(id);
  if (!o) return notFound('Auftrag');
  rememberOrder(o.id);
  const arts = orderArticles(o);
  const multi = arts.length > 1;

  const body = () => {
    if (!arts.length) {
      return emptyBox('Kein Artikel zugeordnet', 'Ordne dem Auftrag eine oder mehrere ArtikelIDs zu.',
        `<a class="btn btn-primary" href="#/auftrag/${o.id}/bearbeiten">Artikel zuordnen</a>`);
    }
    if (multi && prefs.orderMode === 'lagerort') return pickList(arts);
    return arts.map((a) => `<div class="card">${articleBlock(a, { editable: true })}</div>`).join('');
  };

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
      ${multi ? `<div class="seg" role="group" aria-label="Ansicht">
        <button type="button" data-mode="artikel">Nach Artikel</button>
        <button type="button" data-mode="lagerort">Nach Lagerort</button>
      </div>` : ''}
      <div id="order-body">${body()}</div>`,
    mount(root) {
      const seg = $('.seg', root);
      if (!seg) return;
      const sync = () => $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === prefs.orderMode)));
      sync();
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        prefs.orderMode = b.dataset.mode;
        savePrefs();
        sync();
        $('#order-body', root).innerHTML = body();
      });
    },
  };
}

/** Alle Materialien eines Auftrags zusammengefasst, nach Lagerort sortiert (Laufweg). */
function pickList(arts) {
  const byMaterial = new Map();
  for (const a of arts) {
    for (const it of a.items) {
      const m = store.getMaterial(it.materialId);
      if (!m) continue;
      if (!byMaterial.has(m.id)) byMaterial.set(m.id, { m, uses: [] });
      byMaterial.get(m.id).uses.push(`${esc(a.code)}${it.qty ? ` (${esc(qtyLabel(it.qty))})` : ''}`);
    }
  }
  const rows = [...byMaterial.values()]
    .sort((x, y) => locCmp(x.m.location, y.m.location) || natCmp(x.m.name, y.m.name));
  if (!rows.length) return emptyBox('Noch kein Material', 'Für die Artikel dieses Auftrags ist noch nichts hinterlegt.');
  return `<div class="card"><ul class="mats pad">${rows.map((r) => materialRow(r.m, {
    href: `#/material/${r.m.id}`,
    note: `für Artikel ${r.uses.join(', ')}`,
  })).join('')}</ul></div>`;
}

function viewOrderEdit(id, query) {
  const o = id ? store.getOrder(id) : null;
  if (id && !o) return notFound('Auftrag');
  const params = new URLSearchParams(query || '');
  const presetNr = params.get('nr') || '';
  const codes = o ? orderArticles(o).map((a) => a.code) : [];

  return {
    title: o ? 'Auftrag bearbeiten' : 'Neuer Auftrag',
    back: o ? `#/auftrag/${o.id}` : '#/auftraege',
    tab: 'auftraege',
    html: `
      <form class="card form" id="f" novalidate>
        ${field({ id: 'nr', label: 'Auftragsnummer', value: o?.nr ?? presetNr, placeholder: 'z. B. 630-202878', attrs: `${CODE_ATTRS} enterkeyhint="next"` })}
        ${field({ id: 'note', label: 'Notiz', optional: true, value: o?.note, placeholder: 'z. B. Kunde, Bestellnummer, Menge', attrs: 'autocomplete="off" enterkeyhint="next"' })}
        <div class="field">
          <label for="art-input">Artikel</label>
          <ul class="chips" id="chips"></ul>
          <div class="add-row">
            <div class="suggest-wrap"><input id="art-input" class="input" placeholder="ArtikelID eingeben" ${CODE_ATTRS} enterkeyhint="done"></div>
            <button type="button" class="btn btn-secondary btn-square" id="art-add" aria-label="Artikel hinzufügen">${icon.plus}</button>
          </div>
          <p class="hint">Unbekannte ArtikelIDs werden beim Speichern neu angelegt.</p>
        </div>
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Speichern</button>
      </form>
      ${o ? deleteButton('Auftrag löschen') : ''}`,
    mount(root) {
      const nr = $('#nr', root);
      const note = $('#note', root);
      const artInput = $('#art-input', root);
      const err = $('#err', root);

      const draw = () => {
        $('#chips', root).innerHTML = codes.map((c, i) => {
          const a = store.findArticleByCode(c);
          const sub = a
            ? [a.name, plural(a.items.length, 'Material', 'Materialien')].filter(Boolean).join(' · ')
            : 'neu – wird beim Speichern angelegt';
          return `<li class="chip">
            <span class="chip-main"><span class="chip-code">Artikel ${esc(c)}</span><span class="chip-sub">${esc(sub)}</span></span>
            <button type="button" class="icon-btn" data-remove="${i}" aria-label="Artikel ${esc(c)} entfernen">${icon.close}</button>
          </li>`;
        }).join('');
      };
      const add = (raw) => {
        const code = raw.trim();
        if (!code) return;
        const finalCode = store.findArticleByCode(code)?.code ?? code;
        if (!codes.some((c) => norm(c) === norm(finalCode))) codes.push(finalCode);
        artInput.value = '';
        draw();
        suggest.refresh();
      };
      const suggest = attachSuggest(artInput, {
        source: (q) => {
          const m = matcher(q);
          return store.articles()
            .filter((a) => !codes.some((c) => norm(c) === norm(a.code)))
            .map((a) => ({ a, s: q.trim() ? Math.max(m(a.code) * 10, m(a.name)) : 1 }))
            .filter((r) => r.s > 0)
            .sort((x, y) => y.s - x.s || natCmp(x.a.code, y.a.code))
            .map(({ a }) => ({
              label: `Artikel ${a.code}`,
              sub: [a.name, plural(a.items.length, 'Material', 'Materialien')].filter(Boolean).join(' · '),
              code: a.code,
            }));
        },
        onPick: (it) => add(it.code),
      });

      $('#chips', root).addEventListener('click', (e) => {
        const b = e.target.closest('[data-remove]');
        if (!b) return;
        codes.splice(Number(b.dataset.remove), 1);
        draw();
      });
      $('#art-add', root).addEventListener('click', () => { add(artInput.value); artInput.focus(); });
      artInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); add(artInput.value); }
      });
      nextOnEnter(nr, note, artInput);

      $('#f', root).addEventListener('submit', (e) => {
        e.preventDefault();
        add(artInput.value); // noch nicht übernommene Eingabe nicht verlieren
        try {
          const saved = store.saveOrder({ id: o?.id, nr: nr.value, note: note.value, articleCodes: codes });
          toast('Auftrag gespeichert');
          if (o) back(`#/auftrag/${saved.id}`);
          else replace(`#/auftrag/${saved.id}`);
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
      $('#del', root)?.addEventListener('click', () => {
        if (!confirm(`Auftrag ${o.nr} löschen?\n\nArtikel und Materialien bleiben erhalten.`)) return;
        try {
          store.deleteOrder(o.id);
          toast('Auftrag gelöscht');
          replace('#/auftraege');
        } catch (ex) {
          toast(ex.message, 'error');
        }
      });

      draw();
      if (!o) (presetNr ? artInput : nr).focus();
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
        let list = store.articles().filter((a) => !onlyOpen || !a.items.length);
        if (q.trim()) {
          list = list.filter((a) => m(a.code) || m(a.name)
            || a.items.some((it) => { const x = store.getMaterial(it.materialId); return x && (m(x.nr) || m(x.name)); }));
        }
        list = [...list].sort((a, b) => natCmp(a.code, b.code));
        $('#list', root).innerHTML = list.length
          ? `<ul class="card list">${list.map(articleRow).join('')}</ul>`
          : store.articles().length
            ? emptyBox('Keine Treffer', onlyOpen ? 'Alle Artikel haben Material hinterlegt.' : 'Filter anpassen oder löschen.')
            : emptyBox('Noch keine Artikel', 'Artikel entstehen automatisch beim Anlegen eines Auftrags – oder tippe auf <b>+</b>.');
      };
      bindFilter(root, 'artikel', draw);
      draw();
    },
  };
}

function viewArticle(id) {
  const a = store.getArticle(id);
  if (!a) return notFound('Artikel');
  const ords = store.ordersWithArticle(a.id);
  return {
    title: 'Artikel',
    back: '#/artikel',
    tab: 'artikel',
    action: editAction(`#/artikel/${a.id}/bearbeiten`, 'Artikel bearbeiten'),
    html: `
      <div class="detail-head">
        <span class="eyebrow">Artikel</span>
        <div class="detail-title">${esc(a.code)}</div>
        ${a.name ? `<div class="detail-sub">${esc(a.name)}</div>` : ''}
      </div>
      ${sectionTitle('Verpackungsmaterial', a.items.length)}
      ${a.items.length ? `<div class="card art">${materialList(a, { editable: true })}</div>` : ''}
      <a class="btn btn-primary btn-block" href="#/artikel/${a.id}/material/neu">${icon.plus}<span>Material hinzufügen</span></a>
      ${sectionTitle('Aufträge mit diesem Artikel', ords.length)}
      ${ords.length ? `<ul class="card list">${ords.map(orderRow).join('')}</ul>`
        : '<p class="hint">Noch keinem Auftrag zugeordnet.</p>'}`,
  };
}

function viewArticleEdit(id) {
  const a = id ? store.getArticle(id) : null;
  if (id && !a) return notFound('Artikel');
  return {
    title: a ? 'Artikel bearbeiten' : 'Neuer Artikel',
    back: a ? `#/artikel/${a.id}` : '#/artikel',
    tab: 'artikel',
    html: `
      <form class="card form" id="f" novalidate>
        ${field({ id: 'code', label: 'ArtikelID', value: a?.code, placeholder: 'z. B. 32', attrs: `${CODE_ATTRS} enterkeyhint="next"` })}
        ${field({ id: 'name', label: 'Bezeichnung', optional: true, value: a?.name, placeholder: 'z. B. Filter 5+10 ml, 10 St. im Btl.', attrs: 'autocomplete="off" enterkeyhint="done"' })}
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Speichern</button>
      </form>
      ${a ? deleteButton('Artikel löschen') : ''}`,
    mount(root) {
      const code = $('#code', root);
      const name = $('#name', root);
      nextOnEnter(code, name);
      $('#f', root).addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          const saved = store.saveArticle({ id: a?.id, code: code.value, name: name.value });
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
        if (!confirm(`Artikel ${a.code} löschen?${extra}\n\nDie Materialien bleiben in der Materialliste erhalten.`)) return;
        try {
          store.deleteArticle(a.id);
          toast('Artikel gelöscht');
          replace('#/artikel');
        } catch (ex) {
          toast(ex.message, 'error');
        }
      });
      if (!a) code.focus();
    },
  };
}

/** Material an einem Artikel hinzufügen bzw. bearbeiten. */
function viewItemEdit(articleId, materialId) {
  const a = store.getArticle(articleId);
  if (!a) return notFound('Artikel');
  const item = materialId ? a.items.find((it) => it.materialId === materialId) : null;
  if (materialId && !item) return notFound('Material');
  const m = item ? store.getMaterial(item.materialId) : null;

  const existingList = () => {
    const rows = a.items.map((it) => store.getMaterial(it.materialId)).filter(Boolean);
    return rows.length
      ? `${sectionTitle('Bereits hinterlegt', rows.length)}<div class="card"><ul class="mats pad">${
        a.items.map((it) => {
          const x = store.getMaterial(it.materialId);
          return x ? materialRow(x, { qty: it.qty }) : '';
        }).join('')}</ul></div>`
      : '';
  };

  return {
    title: item ? 'Material bearbeiten' : 'Material hinzufügen',
    back: `#/artikel/${a.id}`,
    tab: 'artikel',
    html: `
      <p class="context">für Artikel <b>${esc(a.code)}</b>${a.name ? ` · ${esc(a.name)}` : ''}</p>
      <form class="card form" id="f" novalidate>
        ${field({ id: 'm-nr', label: 'Materialnummer', value: m?.nr, placeholder: 'z. B. 001240007100', attrs: `${CODE_ATTRS} enterkeyhint="next"`, suggest: true })}
        ${field({ id: 'm-name', label: 'Bezeichnung', value: m?.name, placeholder: 'z. B. Lagerbeutel 70x100', attrs: 'autocomplete="off" enterkeyhint="next"', suggest: true })}
        ${field({ id: 'm-loc', label: 'Lagerort', value: m?.location, placeholder: 'z. B. R3-F2', attrs: `${CODE_ATTRS} enterkeyhint="next"`, suggest: true })}
        ${field({ id: 'm-qty', label: 'Menge', optional: true, value: item?.qty, placeholder: 'z. B. 2 oder „1 je 10 St.“', attrs: 'autocomplete="off" enterkeyhint="done"' })}
        <p class="info" id="shared-info" hidden></p>
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Speichern</button>
        ${item ? '' : '<button class="btn btn-secondary btn-block" type="button" id="save-next">Speichern &amp; nächstes Material</button>'}
      </form>
      ${item ? deleteButton('Vom Artikel entfernen') : '<div id="existing"></div>'}`,
    mount(root) {
      const nr = $('#m-nr', root);
      const name = $('#m-name', root);
      const loc = $('#m-loc', root);
      const qty = $('#m-qty', root);
      const info = $('#shared-info', root);
      const err = $('#err', root);
      // Zuletzt automatisch übernommene Werte – nur diese dürfen wieder überschrieben/geleert werden.
      let auto = { name: m?.name ?? null, loc: m?.location ?? null, clearable: false };

      const updateInfo = () => {
        const match = store.findMaterialByNr(nr.value);
        if (!match) { info.hidden = true; return; }
        const others = store.articlesWithMaterial(match.id).filter((x) => x.id !== a.id).length;
        info.hidden = false;
        info.textContent = others
          ? `Bekanntes Material – auch in ${plural(others, 'anderem Artikel', 'anderen Artikeln')} verwendet. Bezeichnung und Lagerort gelten überall.`
          : 'Bekanntes Material aus der Materialliste.';
      };
      const fill = (mat) => {
        nr.value = mat.nr;
        name.value = mat.name;
        loc.value = mat.location;
        auto = { name: mat.name, loc: mat.location, clearable: true };
        updateInfo();
      };

      nr.addEventListener('input', () => {
        const match = store.findMaterialByNr(nr.value);
        if (match) {
          if (!name.value || name.value === auto.name) name.value = match.name;
          if (!loc.value || loc.value === auto.loc) loc.value = match.location;
          auto = { name: match.name, loc: match.location, clearable: true };
        } else if (auto.clearable) {
          if (name.value === auto.name) name.value = '';
          if (loc.value === auto.loc) loc.value = '';
          auto = { name: null, loc: null, clearable: false };
        }
        updateInfo();
      });

      // `exact`: Feldwert, bei dem das Material schon übernommen ist – dann keinen Vorschlag mehr zeigen.
      const materialSuggestions = (q, fieldScore, exact) => {
        if (!q.trim()) return [];
        const mm = matcher(q);
        const inArticle = new Set(a.items.map((it) => it.materialId));
        return rank(store.materials(), (x) => fieldScore(mm, x), (x, y) => natCmp(x.name, y.name))
          .filter(({ x }) => norm(exact(x)) !== norm(q))
          .map(({ x }) => ({
            label: x.nr ? `${x.nr} – ${x.name || '(ohne Bezeichnung)'}` : x.name,
            sub: [x.location ? `Lagerort ${x.location}` : 'kein Lagerort', inArticle.has(x.id) ? 'schon im Artikel' : '']
              .filter(Boolean).join(' · '),
            mat: x,
          }));
      };
      attachSuggest(nr, {
        source: (q) => materialSuggestions(q, (mm, x) => Math.max(mm(x.nr) * 10, mm(x.name)), (x) => x.nr),
        onPick: (it) => { fill(it.mat); qty.focus(); },
      });
      attachSuggest(name, {
        source: (q) => materialSuggestions(q, (mm, x) => Math.max(mm(x.name) * 10, mm(x.nr)), (x) => x.name),
        onPick: (it) => { fill(it.mat); qty.focus(); },
      });
      attachSuggest(loc, {
        source: (q) => {
          const mm = matcher(q);
          return store.locations()
            .filter((l) => !q.trim() || mm(l))
            .filter((l) => norm(l) !== norm(q))
            .map((l) => ({ label: l, value: l }));
        },
        onPick: (it) => { loc.value = it.value; qty.focus(); },
      });
      nextOnEnter(nr, name, loc, qty);

      const drawExisting = () => {
        const box = $('#existing', root);
        if (box) box.innerHTML = existingList();
      };
      const save = (andNext) => {
        err.textContent = '';
        try {
          store.saveArticleItem(a.id, {
            nr: nr.value, name: name.value, location: loc.value, qty: qty.value, replaceMaterialId: m?.id,
          });
        } catch (ex) {
          err.textContent = ex.message;
          return;
        }
        if (andNext) {
          toast('Gespeichert – nächstes Material');
          for (const el of [nr, name, loc, qty]) el.value = '';
          auto = { name: null, loc: null, clearable: false };
          info.hidden = true;
          drawExisting();
          nr.focus();
        } else {
          toast('Material gespeichert');
          back(`#/artikel/${a.id}`);
        }
      };
      $('#f', root).addEventListener('submit', (e) => { e.preventDefault(); save(false); });
      $('#save-next', root)?.addEventListener('click', () => save(true));
      $('#del', root)?.addEventListener('click', () => {
        if (!confirm(`„${m.name || m.nr}“ vom Artikel ${a.code} entfernen?\n\nDas Material bleibt in der Materialliste erhalten.`)) return;
        try {
          store.removeArticleItem(a.id, m.id);
          toast('Material entfernt');
          back(`#/artikel/${a.id}`);
        } catch (ex) {
          toast(ex.message, 'error');
        }
      });

      updateInfo();
      drawExisting();
      if (!item) nr.focus();
    },
  };
}

// ======================================================================
// Material (Stammdaten)
// ======================================================================

function viewMaterials(query) {
  const onlyOpen = new URLSearchParams(query || '').get('offen') === '1';
  const sorts = [['location', 'Lagerort'], ['name', 'Bezeichnung'], ['nr', 'Nummer']];
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
        if (q.trim()) list = list.filter((x) => m(x.nr) || m(x.name) || m(x.location));
        list = [...list].sort((x, y) => (key === 'location'
          ? locCmp(x.location, y.location) || natCmp(x.name, y.name)
          : natCmp(x[key], y[key]) || natCmp(x.name, y.name)));
        $('#list', root).innerHTML = list.length
          ? `<div class="card"><ul class="mats pad">${list.map((x) => materialRow(x, { href: `#/material/${x.id}`, extra: usageText(x) })).join('')}</ul></div>`
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
    },
  };
}

function viewMaterialEdit(id) {
  const m = id ? store.getMaterial(id) : null;
  if (id && !m) return notFound('Material');
  const used = m ? store.articlesWithMaterial(m.id) : [];
  return {
    title: m ? 'Material' : 'Neues Material',
    back: '#/material',
    tab: 'material',
    html: `
      <form class="card form" id="f" novalidate>
        ${field({ id: 'nr', label: 'Materialnummer', value: m?.nr, placeholder: 'z. B. 001240007100', attrs: `${CODE_ATTRS} enterkeyhint="next"` })}
        ${field({ id: 'name', label: 'Bezeichnung', value: m?.name, placeholder: 'z. B. Lagerbeutel 70x100', attrs: 'autocomplete="off" enterkeyhint="next"' })}
        ${field({ id: 'loc', label: 'Lagerort', value: m?.location, placeholder: 'z. B. R3-F2', attrs: `${CODE_ATTRS} enterkeyhint="done"`, suggest: true,
          hint: used.length > 1 ? `Gilt für alle ${used.length} Artikel, die dieses Material verwenden.` : '' })}
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">Speichern</button>
      </form>
      ${m ? `${sectionTitle('Verwendet in', used.length)}
        ${used.length ? `<ul class="card list">${used.map(articleRow).join('')}</ul>` : '<p class="hint">Wird in keinem Artikel verwendet.</p>'}
        ${deleteButton('Material löschen')}` : ''}`,
    mount(root) {
      const nr = $('#nr', root);
      const name = $('#name', root);
      const loc = $('#loc', root);
      attachSuggest(loc, {
        source: (q) => {
          const mm = matcher(q);
          return store.locations()
            .filter((l) => (!q.trim() || mm(l)) && norm(l) !== norm(q))
            .map((l) => ({ label: l, value: l }));
        },
        onPick: (it) => { loc.value = it.value; },
      });
      nextOnEnter(nr, name, loc);
      $('#f', root).addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          store.saveMaterial({ id: m?.id, nr: nr.value, name: name.value, location: loc.value });
          toast('Material gespeichert');
          back('#/material');
        } catch (ex) {
          $('#err', root).textContent = ex.message;
        }
      });
      $('#del', root)?.addEventListener('click', () => {
        const extra = used.length ? `\n\nEs wird aus ${plural(used.length, 'Artikel', 'Artikeln')} entfernt.` : '';
        if (!confirm(`Material „${m.name || m.nr}“ löschen?${extra}`)) return;
        try {
          store.deleteMaterial(m.id);
          toast('Material gelöscht');
          replace('#/material');
        } catch (ex) {
          toast(ex.message, 'error');
        }
      });
      if (!m) nr.focus();
    },
  };
}

// ======================================================================
// Mehr: Datensicherung, App-Installation, Abmelden
// ======================================================================

const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function viewMore() {
  const meta = store.meta();
  const stale = !store.isEmpty() && daysSince(meta.lastBackup) > 7;
  return {
    title: 'Mehr',
    tab: 'mehr',
    html: `
      ${sectionTitle('Datenbestand')}
      <div class="card stats">
        <a href="#/auftraege"><b>${store.orders().length}</b><span>Aufträge</span></a>
        <a href="#/artikel"><b>${store.articles().length}</b><span>Artikel</span></a>
        <a href="#/material"><b>${store.materials().length}</b><span>Materialien</span></a>
      </div>

      ${sectionTitle('Datensicherung')}
      <div class="card box">
        <p>Die Daten werden <b>nur auf diesem Gerät</b> gespeichert. Sichere sie regelmäßig –
          mit der Backup-Datei kannst du sie auch auf ein anderes Handy übertragen.</p>
        <p class="backup-state${stale ? ' is-stale' : ''}">${icon.info}
          <span>Letztes Backup: <b>${meta.lastBackup ? esc(formatDate(meta.lastBackup)) : 'noch keins'}</b></span></p>
        <button type="button" class="btn btn-primary btn-block" id="export">${icon.download}<span>Backup speichern</span></button>
        <button type="button" class="btn btn-secondary btn-block" id="import">${icon.upload}<span>Backup einspielen</span></button>
        <input type="file" id="import-file" accept=".json,application/json" hidden>
      </div>

      ${isInstalled() ? '' : `${sectionTitle('Als App aufs Handy')}
      <div class="card box">
        <p><b>iPhone (Safari):</b> „Teilen“ ${icon.upload} → „Zum Home-Bildschirm“.</p>
        <p><b>Android (Chrome):</b> Menü ⋮ → „App installieren“ oder „Zum Startbildschirm hinzufügen“.</p>
        <p class="hint">Als App startet sie schneller und funktioniert auch ohne Empfang. Auf dem iPhone
          hat die App einen <b>eigenen Speicher</b>: am besten zuerst installieren und dann Daten eintragen –
          oder vorhandene Daten per Backup übertragen.</p>
      </div>`}

      <button type="button" class="btn btn-secondary btn-block" id="logout">${icon.logout}<span>Abmelden</span></button>
      <p class="version">BO-WERT Konfektionierung · v${APP_VERSION}</p>`,
    mount(root) {
      $('#export', root).addEventListener('click', exportBackup);
      const file = $('#import-file', root);
      $('#import', root).addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files[0];
        file.value = '';
        if (!f) return;
        try {
          const next = store.parseBackup(await f.text());
          const summary = `${plural(next.orders.length, 'Auftrag', 'Aufträge')}, ${next.articles.length} Artikel, ${plural(next.materials.length, 'Material', 'Materialien')}`;
          if (!confirm(`Backup einspielen?\n\n${summary}\n\nDie aktuellen Daten auf diesem Gerät werden dabei ersetzt.`)) return;
          store.replaceAll(next);
          toast('Backup eingespielt');
          render();
        } catch (ex) {
          toast(ex.message, 'error');
        }
      });
      $('#logout', root).addEventListener('click', logout);
    },
  };
}

async function exportBackup() {
  const name = `konfektionierung-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([store.exportJSON()], name, { type: 'application/json' });
  try {
    // Am Handy: Teilen-Menü (Dateien, Mail, Messenger). Sonst: normaler Download.
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Konfektionierung – Backup' });
    } else {
      const url = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    store.markBackup();
    toast('Backup erstellt');
    render();
  } catch (ex) {
    if (ex.name !== 'AbortError') toast(`Backup fehlgeschlagen: ${ex.message}`, 'error');
  }
}

// ======================================================================
// Start
// ======================================================================

for (const tab of $$('.tab')) tab.insertAdjacentHTML('afterbegin', icon[tab.dataset.icon]);
$('#back').innerHTML = icon.back;

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

history.scrollRestoration = 'manual';
if (!location.hash) history.replaceState(null, '', '#/suche');
stack = [currentHash()];
window.addEventListener('hashchange', onHashChange);

if (store.storageProblem()) {
  toast('Speichern ist in diesem Browser nicht möglich (privater Modus?).', 'error');
}
if (isAuthed()) showApp(); else showLogin();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service Worker:', e));
}
