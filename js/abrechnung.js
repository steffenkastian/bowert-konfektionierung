// Abrechnung: Umsatz-Dashboard, Preise pro Satz, Rechnungen (nur in der Abrechnungs-App).
// Wird von app.js geladen und bekommt dessen Bausteine (ctx) mitgegeben.

import * as store from './store.js';
import { $, $$, esc, plural, natCmp, toast } from './ui.js';
import { renderPdf } from './files.js';
import { invoicePdf, mergePdfs, PAYMENT_TEXT } from './rechnung.js';
import { loadFflate } from './umlagerung.js';

let C = null; // Bausteine aus app.js

const eur = (n) => Number(n || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const eurShort = (n) => `${Number(n || 0).toLocaleString('de-DE', { maximumFractionDigits: 0 })} €`;
const priceText = (p) => `${Number(p).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} €`;
const invNo = store.formatInvoiceNo;

// ---------- Datum ----------

const monthOf = (iso) => iso.slice(0, 7);
const monthLabel = (m, opts = { month: 'long', year: 'numeric' }) => new Date(`${m}-15T12:00`).toLocaleDateString('de-DE', opts);
const shiftMonth = (m, n) => { const d = new Date(`${m}-15T12:00`); d.setMonth(d.getMonth() + n); return store.localDate(d).slice(0, 7); };
const daysIn = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
const monthStart = (m) => `${m}-01`;
const monthEnd = (m) => `${m}-${String(daysIn(m)).padStart(2, '0')}`;
const isMonth = (v) => /^\d{4}-\d{2}$/.test(v || '');

// ======================================================================
// Balkendiagramm (HTML statt Canvas: scharf, responsiv, per Tastatur/Tippen bedienbar)
// ======================================================================

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => v <= x);
}

/** bars: [{ value, short (Achsbeschriftung), aria, readout (HTML), active? }] */
function barChart(id, bars, { label, summary }) {
  const max = niceMax(Math.max(0, ...bars.map((b) => b.value || 0)));
  const ticks = [max, max / 2, 0];
  return `<figure class="chart" id="${id}">
    <div class="chart-plot" role="group" aria-label="${esc(label)}">
      ${ticks.map((t) => `<div class="chart-grid" style="bottom:${(t / max) * 100}%"><span>${eurShort(t)}</span></div>`).join('')}
      <div class="chart-bars">
        ${bars.map((b, i) => `<button type="button" class="chart-col${b.mark ? ' is-mark' : ''}" data-i="${i}" aria-label="${esc(b.aria)}">
          <span class="chart-bar${b.value > 0 ? '' : ' is-zero'}" style="height:${Math.max(0, (b.value || 0) / max) * 100}%"></span></button>`).join('')}
      </div>
    </div>
    <div class="chart-x" aria-hidden="true">${bars.map((b) => `<span>${esc(b.short || '')}</span>`).join('')}</div>
    <figcaption class="chart-readout" aria-live="polite">${summary}</figcaption>
  </figure>`;
}

function bindBarChart(root, id, bars, summary) {
  const fig = $(`#${id}`, root);
  if (!fig) return;
  const out = $('.chart-readout', fig);
  let pinned = null;
  const show = (i) => {
    $$('.chart-col', fig).forEach((c) => c.classList.toggle('is-active', Number(c.dataset.i) === i));
    out.innerHTML = i == null ? summary : bars[i].readout;
  };
  fig.addEventListener('pointerover', (e) => { const c = e.target.closest('.chart-col'); if (c && e.pointerType === 'mouse') show(Number(c.dataset.i)); });
  fig.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') show(pinned); });
  fig.addEventListener('focusin', (e) => { const c = e.target.closest('.chart-col'); if (c) show(Number(c.dataset.i)); });
  fig.addEventListener('click', (e) => {
    const c = e.target.closest('.chart-col');
    if (!c) return;
    const i = Number(c.dataset.i);
    pinned = pinned === i ? null : i;
    show(pinned);
  });
}

// ======================================================================
// Umsatz (Dashboard)
// ======================================================================

function viewRevenue(query) {
  const params = new URLSearchParams(query || '');
  const today = store.localDate();
  const thisMonth = monthOf(today);
  const month = isMonth(params.get('monat')) && params.get('monat') <= thisMonth ? params.get('monat') : thisMonth;
  const year = month.slice(0, 4);

  const rows = store.revenueRows();
  const sum = (list) => list.reduce((s, r) => s + (r.amount || 0), 0);
  const inMonth = rows.filter((r) => monthOf(r.date) === month);
  const monthSum = sum(inMonth);
  const monthQty = inMonth.reduce((s, r) => s + r.qty, 0);
  const missing = inMonth.filter((r) => r.amount == null);
  const missingArticles = [...new Set(missing.map((r) => r.articleId))].map((id) => store.getArticle(id)).filter(Boolean);
  const todaySum = sum(rows.filter((r) => r.date === today));
  const yearSum = sum(rows.filter((r) => r.date.startsWith(year)));
  const prevSum = sum(rows.filter((r) => monthOf(r.date) === shiftMonth(month, -1)));

  // Tage des Monats
  const n = daysIn(month);
  const dayBars = Array.from({ length: n }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, '0')}`;
    const list = inMonth.filter((r) => r.date === date);
    const value = sum(list);
    const qty = list.reduce((s, r) => s + r.qty, 0);
    const wd = new Date(`${date}T12:00`).getDay();
    const label = new Date(`${date}T12:00`).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
    return {
      value,
      mark: date === today,
      short: [1, 5, 10, 15, 20, 25, 30].includes(i + 1) ? String(i + 1) : '',
      aria: `${label}: ${eur(value)}, ${C.fmtN(qty)} Satz`,
      readout: `<b>${esc(label)}</b> · ${eur(value)} · ${C.fmtN(qty)} Satz${list.some((r) => r.amount == null) ? ' · <span class="warn-text">Preis fehlt</span>' : ''}${qty ? ` · <a href="#/lieferscheine?datum=${date}">Lieferscheine</a>` : ''}`,
      weekend: wd === 0 || wd === 6,
      date, qty,
    };
  });
  const best = dayBars.reduce((m, b) => (b.value > (m?.value || 0) ? b : m), null);
  const workDays = dayBars.filter((b) => b.value > 0).length;
  const daySummary = monthSum
    ? `${plural(workDays, 'Tag', 'Tage')} mit Umsatz · Ø ${eur(monthSum / Math.max(1, workDays))} · bester Tag ${esc(best.aria.split(':')[0])} (${eur(best.value)})`
    : 'Noch kein Umsatz in diesem Monat.';

  // Letzte 12 Monate
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(month, i - 11));
  const monthBars = months.map((m) => {
    const list = rows.filter((r) => monthOf(r.date) === m);
    const value = sum(list);
    const qty = list.reduce((s, r) => s + r.qty, 0);
    return {
      value, mark: m === month,
      short: monthLabel(m, { month: 'narrow' }),
      aria: `${monthLabel(m)}: ${eur(value)}`,
      readout: `<b>${esc(monthLabel(m))}</b> · ${eur(value)} · ${C.fmtN(qty)} Satz${m !== month ? ` · <a href="#/umsatz?monat=${m}">anzeigen</a>` : ''}`,
    };
  });
  const yearMonths = monthBars.filter((b, i) => months[i].startsWith(year));
  const monthSummary = `${year}: ${eur(yearSum)} · Ø ${eur(yearSum / Math.max(1, yearMonths.filter((b) => b.value > 0).length))} pro Monat`;

  // Je Artikel
  const byArticle = new Map();
  for (const r of inMonth) {
    const g = byArticle.get(r.articleId) || { articleId: r.articleId, qty: 0, amount: 0, missing: 0, prices: new Set() };
    g.qty += r.qty;
    if (r.amount == null) g.missing += r.qty; else { g.amount += r.amount; g.prices.add(r.price); }
    byArticle.set(r.articleId, g);
  }
  const artRows = [...byArticle.values()].sort((a, b) => b.amount - a.amount || natCmp(store.getArticle(a.articleId)?.name, store.getArticle(b.articleId)?.name));

  const deltaPct = prevSum ? Math.round(((monthSum - prevSum) / prevSum) * 100) : null;

  return {
    title: 'Umsatz',
    tab: 'umsatz',
    html: `
      <div class="day-nav">
        <a class="icon-btn" href="#/umsatz?monat=${shiftMonth(month, -1)}" aria-label="Vorheriger Monat">${C.icon.back}</a>
        <div class="day-pick"><span>Monat</span><b>${esc(monthLabel(month))}</b></div>
        ${month < thisMonth ? `<a class="icon-btn" href="#/umsatz${shiftMonth(month, 1) === thisMonth ? '' : `?monat=${shiftMonth(month, 1)}`}" aria-label="Nächster Monat">${C.icon.chevron}</a>`
          : `<span class="icon-btn" style="visibility:hidden" aria-hidden="true"></span>`}
      </div>
      <div class="card kpis">
        <div class="kpi kpi-main"><span>Umsatz ${esc(monthLabel(month, { month: 'long' }))}</span><b>${eur(monthSum)}</b>
          <small>${C.fmtN(monthQty)} Satz${deltaPct != null ? ` · ${deltaPct >= 0 ? '+' : '−'}${Math.abs(deltaPct)} % zum Vormonat` : ''}</small></div>
        <div class="kpi"><span>${month === thisMonth ? 'Heute' : 'Vormonat'}</span><b>${eur(month === thisMonth ? todaySum : prevSum)}</b></div>
        <div class="kpi"><span>Jahr ${year}</span><b>${eur(yearSum)}</b></div>
      </div>
      <p class="hint kpi-note">Netto, nach Liefertag: fertig gemeldete Satz × Preis pro Satz.</p>
      ${missing.length ? `<p class="notice">${C.fmtN(missing.reduce((s, r) => s + r.qty, 0))} Satz ohne Preis – nicht im Umsatz:
        ${missingArticles.map((a) => `<a href="#/artikel/${a.id}">${esc(a.name)}</a>`).join(', ') || 'Aufträge ohne Artikel'}</p>` : ''}

      ${C.sectionTitle('Umsatz pro Tag')}
      <div class="card chart-card">${barChart('ch-days', dayBars, { label: `Umsatz pro Tag im ${monthLabel(month)}`, summary: daySummary })}</div>

      ${C.sectionTitle('Umsatz pro Monat')}
      <div class="card chart-card">${barChart('ch-months', monthBars, { label: 'Umsatz der letzten 12 Monate', summary: monthSummary })}</div>

      ${C.sectionTitle('Je Artikel', artRows.length)}
      ${artRows.length ? `<div class="card table-card"><table class="tbl">
        <thead><tr><th>Artikel</th><th class="num">Satz</th><th class="num">Umsatz</th></tr></thead>
        <tbody>${artRows.map((g) => {
          const a = store.getArticle(g.articleId);
          const p = [...g.prices];
          return `<tr><td>${a ? `<a href="#/artikel/${a.id}">${esc(a.name)}</a>` : '<span class="muted">ohne Artikel</span>'}
              <small>${p.length ? p.map(priceText).join(' / ') : ''}${g.missing ? `${p.length ? ' · ' : ''}<span class="warn-text">Preis fehlt</span>` : ''}</small></td>
            <td class="num">${C.fmtN(g.qty)}</td><td class="num">${eur(g.amount)}</td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td>Summe</td><td class="num">${C.fmtN(monthQty)}</td><td class="num">${eur(monthSum)}</td></tr></tfoot>
      </table></div>` : '<p class="hint">In diesem Monat nichts fertig gemeldet.</p>'}

      <details class="card table-card days-table">
        <summary>Tage als Tabelle</summary>
        <table class="tbl"><thead><tr><th>Tag</th><th class="num">Satz</th><th class="num">Umsatz</th></tr></thead>
        <tbody>${dayBars.filter((b) => b.qty).map((b) => `<tr><td><a href="#/lieferscheine?datum=${b.date}">${esc(b.aria.split(':')[0])}</a></td>
          <td class="num">${C.fmtN(b.qty)}</td><td class="num">${eur(b.value)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Keine Einträge</td></tr>'}</tbody></table>
      </details>

      <div class="btn-row2 dash-links">
        <a class="btn btn-secondary" href="#/preise">Preise pflegen</a>
        <a class="btn btn-secondary" href="#/rechnungen">Rechnungen</a>
      </div>`,
    mount(root) {
      bindBarChart(root, 'ch-days', dayBars, daySummary);
      bindBarChart(root, 'ch-months', monthBars, monthSummary);
    },
  };
}

// ======================================================================
// Preise
// ======================================================================

function viewPrices() {
  const nextMonth = `${shiftMonth(monthOf(store.localDate()), 1)}-01`;
  const pctText = (p) => `${String(p).replace('.', ',')} %`;
  return {
    title: 'Preise',
    back: '#/umsatz',
    tab: 'umsatz',
    html: `
      <p class="hint" style="margin:0 4px 12px">Nettopreis pro Satz. Ändert sich ein Preis, mit „gültig ab“ eintragen – frühere Lieferungen behalten ihren alten Preis.</p>
      <div id="price-rows"></div>
      ${C.sectionTitle('Alle Preise erhöhen')}
      <form class="card form" id="raise" novalidate>
        <div class="two-col">
          <div class="field"><label for="pct">Prozent</label>
            <input id="pct" class="input" inputmode="decimal" autocomplete="off" placeholder="z. B. 11"></div>
          <div class="field"><label for="pct-from">gültig ab</label>
            <input id="pct-from" class="input" type="date" value="${nextMonth}"></div>
        </div>
        <div id="raise-preview"></div>
        <p class="hint" id="raise-hint" style="margin:-6px 2px 14px">Jeder Artikel mit Preis bekommt ab dem Datum einen neuen Preis: Preis vom Vortag + Prozent, auf 4 Nachkommastellen gerundet. Frühere Lieferungen bleiben beim alten Preis.</p>
        <p class="form-error" id="raise-err" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit" id="raise-btn" disabled>Preise erhöhen</button>
      </form>`,
    mount(root) {
      const drawList = () => {
        const list = store.articles().sort((a, b) => natCmp(a.name, b.name));
        const used = new Set(store.revenueRows().map((r) => r.articleId));
        const missing = list.filter((a) => store.currentPrice(a.id) == null && used.has(a.id));
        $('#price-rows', root).innerHTML = `
          ${missing.length ? `<p class="notice">${plural(missing.length, 'Artikel', 'Artikel')} mit Lieferungen, aber ohne Preis.</p>` : ''}
          ${list.length ? `<ul class="card list">${list.map((a) => {
            const p = store.currentPrice(a.id);
            const later = store.priceList(a.id).filter((x) => x.from > store.localDate());
            return C.row({
              href: `#/artikel/${a.id}`,
              title: esc(a.name),
              sub: esc([p != null ? `${priceText(p)} pro Satz` : '', ...later.map((x) => `ab ${C.fmtDay(x.from)}: ${priceText(x.price)}`)]
                .filter(Boolean).join(' · ') || 'kein Preis'),
              tag: p == null ? `<span class="tag ${used.has(a.id) ? 'tag-warn' : ''}">Preis fehlt</span>` : '',
            });
          }).join('')}</ul>` : C.emptyBox('Noch keine Artikel', 'Artikel legst du unter „Artikel“ an.')}`;
      };

      const pct = $('#pct', root);
      const from = $('#pct-from', root);
      const btn = $('#raise-btn', root);
      const box = $('#raise-preview', root);
      const err = $('#raise-err', root);
      const reset = () => { btn.disabled = true; btn.textContent = 'Preise erhöhen'; box.innerHTML = ''; };
      const preview = () => {
        err.textContent = '';
        reset();
        if (!pct.value.trim()) return;
        let plan;
        let p;
        try {
          plan = store.priceRaisePlan(pct.value, from.value);
          p = store.parsePercent(pct.value);
        } catch (ex) { err.textContent = ex.message; return; }
        box.innerHTML = plan.length ? `
          <div class="table-card raise-table"><table class="tbl">
            <thead><tr><th>Artikel</th><th class="num">bisher</th><th class="num">ab ${C.fmtDay(from.value)}</th></tr></thead>
            <tbody>${plan.map((x) => `<tr><td>${esc(x.name)}${x.later ? `<small class="warn-text">ab ${C.fmtDay(x.later.from)} gilt weiter ${priceText(x.later.price)}</small>` : ''}</td>
              <td class="num">${priceText(x.old)}</td><td class="num"><b>${priceText(x.price)}</b></td></tr>`).join('')}</tbody></table></div>`
          : '<p class="notice">Kein Artikel hat vor diesem Datum einen Preis.</p>';
        btn.disabled = !plan.length;
        if (plan.length) btn.textContent = `${plural(plan.length, 'Preis', 'Preise')} um ${pctText(p)} ${p > 0 ? 'erhöhen' : 'senken'}`;
      };
      pct.addEventListener('input', preview);
      from.addEventListener('change', preview);
      $('#raise', root).addEventListener('submit', (e) => {
        e.preventDefault();
        try {
          const plan = store.priceRaisePlan(pct.value, from.value);
          const p = store.parsePercent(pct.value);
          const day = C.fmtDay(from.value);
          if (!confirm(`${plural(plan.length, 'Preis', 'Preise')} ab ${day} um ${pctText(p)} ${p > 0 ? 'erhöhen' : 'senken'}?`)) return;
          const res = store.raiseAllPrices(pct.value, from.value);
          toast(`${plural(res.count, 'Preis', 'Preise')} ab ${day} geändert`, 'ok', {
            label: 'Rückgängig', run: () => { res.undo(); toast('Preisänderung zurückgenommen'); },
          });
          pct.value = '';
          reset();
        } catch (ex) { err.textContent = ex.message; }
      });
      drawList();
      return drawList;
    },
  };
}

/** Preisbereich auf der Artikelseite. */
export function articlePriceBox(a) {
  const list = store.priceList(a.id).reverse();
  const cur = store.currentPrice(a.id);
  const firstDelivery = store.deliveries().filter((d) => store.articleOf(d) === a.id).map((d) => d.date).sort()[0];
  const defFrom = list.length ? store.localDate() : (firstDelivery || store.localDate());
  return `${C.sectionTitle('Preis pro Satz (netto)')}
    <section class="card box price-box" id="preis">
      <p class="price-now">${cur != null ? `<b>${priceText(cur)}</b> <span class="muted">pro Satz</span>` : '<span class="warn-text">Noch kein Preis</span>'}</p>
      ${list.length ? `<ul class="price-list">${list.map((x) => `<li><span>ab ${C.fmtDay(x.from)}</span><b>${priceText(x.price)}</b>
        <button type="button" class="icon-btn small" data-del-price="${x.from}" aria-label="Preis ab ${C.fmtDay(x.from)} löschen">${C.icon.trash}</button></li>`).join('')}</ul>` : ''}
      <form id="price-form" novalidate>
        <div class="two-col">
          <div class="field"><label for="price">${cur != null ? 'Neuer Preis' : 'Preis'}</label>
            <input id="price" class="input" inputmode="decimal" autocomplete="off" placeholder="z. B. 0,4525"></div>
          <div class="field"><label for="price-from">gültig ab</label>
            <input id="price-from" class="input" type="date" value="${defFrom}"></div>
        </div>
        <p class="form-error" id="price-err" role="alert"></p>
        <button class="btn btn-secondary btn-block" type="submit">Preis speichern</button>
      </form>
    </section>`;
}

export function bindArticlePriceBox(root, a) {
  const form = $('#price-form', root);
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      store.setPrice(a.id, { price: $('#price', root).value, from: $('#price-from', root).value });
      toast('Preis gespeichert');
    } catch (ex) { $('#price-err', root).textContent = ex.message; }
  });
  $('.price-list', root)?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-del-price]');
    if (!b || !confirm(`Preis ab ${C.fmtDay(b.dataset.delPrice)} löschen?`)) return;
    try { store.removePrice(a.id, b.dataset.delPrice); toast('Preis gelöscht'); } catch (ex) { toast(ex.message, 'error'); }
  });
}

// ======================================================================
// Rechnungen
// ======================================================================

const STATUS_TAG = (inv) => (inv.type === 'storno' ? '<span class="tag">Storno</span>'
  : inv.status === 'storniert' ? '<span class="tag tag-warn">storniert</span>' : '');

/** Noch nicht abgerechnete Lieferscheine je Monat (für die Übersicht). */
function openByMonth() {
  const map = new Map();
  for (const d of store.deliveries()) {
    if (!d.no || store.invoiceOf(d) || !store.deliveryQty(d)) continue;
    const m = monthOf(d.date);
    const g = map.get(m) || { month: m, count: 0, orders: new Set(), amount: 0, missing: false };
    g.count += 1;
    g.orders.add(d.orderId);
    const p = store.priceAt(store.articleOf(d), d.date);
    if (p == null) g.missing = true; else g.amount += store.deliveryQty(d) * p;
    map.set(m, g);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function viewInvoices() {
  const list = store.invoices().sort((a, b) => String(b.no).localeCompare(String(a.no)));
  const open = openByMonth();
  // Archiv nach Monat des Rechnungsdatums
  const months = new Map();
  for (const inv of list) {
    const m = monthOf(inv.date);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(inv);
  }
  return {
    title: 'Rechnungen',
    tab: 'rechnungen',
    html: `
      ${open.length ? `${C.sectionTitle('Noch nicht abgerechnet', open.length)}
        <ul class="card list">${open.map((g) => C.row({
          href: `#/rechnung/neu?von=${monthStart(g.month)}&bis=${monthEnd(g.month)}`,
          title: esc(monthLabel(g.month)),
          sub: esc(`${plural(g.orders.size, 'Auftrag', 'Aufträge')} · ${plural(g.count, 'Lieferschein', 'Lieferscheine')} · ${eur(g.amount)} netto`),
          tag: g.missing ? '<span class="tag tag-warn">Preis fehlt</span>' : '<span class="tag">abrechnen</span>',
        })).join('')}</ul>` : ''}
      <a class="btn btn-primary btn-block" href="#/rechnung/neu">${C.icon.plus}<span>Rechnungen erstellen</span></a>
      <div id="inv-archive">${list.length ? [...months.entries()].map(([m, invs]) => `
        ${C.sectionTitle(monthLabel(m), invs.length, `<button type="button" class="link-btn" data-zip="${m}">${C.icon.download}<span>ZIP</span></button>`)}
        <ul class="card list">${invs.map((inv) => C.row({
          href: `#/rechnung/${inv.id}`,
          title: `${inv.type === 'storno' ? 'Storno ' : ''}Nr. ${esc(invNo(inv.no))}`,
          sub: esc(`${inv.orderNrs.length === 1 ? `Auftrag ${inv.orderNrs[0]}` : `${inv.orderNrs.length} Aufträge`} · ${C.fmtDay(inv.date)} · ${eur(inv.brutto)}`),
          tag: STATUS_TAG(inv),
        })).join('')}</ul>`).join('')
        : `${C.sectionTitle('Archiv', 0)}<p class="hint">Noch keine Rechnungen erstellt.</p>`}</div>`,
    mount(root) {
      // am eigenen Container (nicht an #main), sonst sammeln sich beim Neuzeichnen alte Klick-Handler an
      $('#inv-archive', root).addEventListener('click', async (e) => {
        const b = e.target.closest('[data-zip]');
        if (!b || b.disabled) return;
        const invs = months.get(b.dataset.zip) || [];
        const label = b.innerHTML;
        b.disabled = true;
        try {
          const file = await zipInvoices(invs, `Rechnungen_${b.dataset.zip}.zip`, (i) => { b.innerHTML = `<span class="spinner small"></span><span>${i}/${invs.length}</span>`; });
          await C.shareOrDownload(file);
        } catch (ex) {
          if (ex.name !== 'AbortError') toast(`ZIP fehlgeschlagen: ${ex.message}`, 'error');
        } finally { if (b.isConnected) { b.disabled = false; b.innerHTML = label; } }
      });
    },
  };
}

// ---------- Rechnungen erstellen: je Auftrag eine ----------

/** Aktuelle Fassung noch nicht im Archiv (v: 0 = Altbestand nur mit printedQty). */
const needsArchive = (d) => { const l = store.lastSent(d); return !l || l.v === 0 || store.deliveryChanged(d); };

/** Offene Lieferscheine des Zeitraums je Auftrag, mit Rechnungsdaten und Problemen. */
function orderBatches(notes) {
  const byOrder = new Map();
  for (const d of notes) {
    if (!byOrder.has(d.orderId)) byOrder.set(d.orderId, []);
    byOrder.get(d.orderId).push(d);
  }
  return [...byOrder.entries()].map(([orderId, list]) => {
    const calc = store.buildInvoice(list);
    const order = store.getOrder(orderId);
    const n0 = store.noteData(list[0]);
    return {
      orderId, order, list, calc, nr: n0.orderNr, bestellnr: n0.bestellnr,
      article: store.getArticle(store.articleOf(list[0])),
      qty: list.reduce((s, d) => s + store.deliveryQty(d), 0),
      ok: calc.missing.length === 0,
    };
  }).sort((a, b) => natCmp(a.nr, b.nr));
}

function viewInvoiceNew(query) {
  const params = new URLSearchParams(query || '');
  const today = store.localDate();
  const prev = shiftMonth(monthOf(today), -1);
  const from = C.isIsoDate(params.get('von')) ? params.get('von') : monthStart(prev);
  const to = C.isIsoDate(params.get('bis')) ? params.get('bis') : monthEnd(prev);
  const { notes, withoutNo } = store.billable(from, to);
  const batches = orderBatches(notes);
  const blocked = batches.filter((b) => !b.ok);
  const defDate = to < today ? to : today;
  const quick = (label, f, t) => `<a class="filter-chip${f === from && t === to ? ' is-on' : ''}" href="#/rechnung/neu?von=${f}&bis=${t}">${esc(label)}</a>`;

  const view = {
    title: 'Rechnungen erstellen',
    back: '#/rechnungen',
    tab: 'rechnungen',
    form: true,
    html: `
      <form class="card form" id="range" novalidate>
        <div class="two-col">
          <div class="field"><label for="von">Von</label><input id="von" class="input" type="date" value="${from}"></div>
          <div class="field"><label for="bis">Bis</label><input id="bis" class="input" type="date" value="${to}"></div>
        </div>
        <div class="chips">
          ${quick(monthLabel(prev), monthStart(prev), monthEnd(prev))}
          ${quick(monthLabel(monthOf(today)), monthStart(monthOf(today)), monthEnd(monthOf(today)))}
        </div>
      </form>
      ${withoutNo.length ? `<p class="notice">${plural(withoutNo.length, 'Lieferung', 'Lieferungen')} ohne Lieferschein
        (${C.fmtN(withoutNo.reduce((s, d) => s + store.deliveryQty(d), 0))} Satz) – wird nicht berechnet. Erst den Lieferschein erstellen:
        ${[...new Set(withoutNo.map((d) => d.date))].map((d) => `<a href="#/lieferscheine?datum=${d}">${C.fmtDay(d)}</a>`).join(', ')}</p>` : ''}
      ${blocked.length ? `<p class="notice">${plural(blocked.length, 'Auftrag wird', 'Aufträge werden')} übersprungen – Preis fehlt:
        ${[...new Map(blocked.map((b) => [b.article?.id, b.article])).values()].map((a) => (a ? `<a href="#/artikel/${a.id}">${esc(a.name)}</a>` : 'ohne Artikel')).join(', ')}</p>` : ''}
      ${batches.length ? `
        ${C.sectionTitle('Je Auftrag eine Rechnung', batches.length)}
        <div class="card pick-list" id="pick">
          <label class="pick-head"><input type="checkbox" id="all"><span><b>Alle auswählen</b></span></label>
          ${batches.map((b) => `<div class="pick-order${b.ok ? '' : ' is-blocked'}">
            <label class="pick-row pick-row2"><input type="checkbox" data-o="${esc(b.orderId)}" ${b.ok ? 'checked' : 'disabled'}>
              <span class="pick-main"><b>Auftrag ${esc(b.nr)}</b>
                <small>${esc(b.article?.name || 'ohne Artikel')} · ${b.bestellnr ? `Bestellnr. ${esc(b.bestellnr)}` : '<span class="warn-text">ohne Bestellnr.</span>'}</small>
                <small>${esc(`${plural(b.list.length, 'Lieferschein', 'Lieferscheine')} (${b.list.map((d) => d.no).join(', ')})`)}</small>
                ${b.ok ? '' : `<small class="warn-text">Preis fehlt${b.article ? ` – <a href="#/artikel/${b.article.id}">eintragen</a>` : ''}</small>`}</span>
              <span class="pick-sum"><b>${b.ok ? eur(b.calc.netto) : '–'}</b><small>${C.fmtN(b.qty)} Satz</small></span></label>
            ${b.ok ? `<button type="button" class="icon-btn small" data-prev="${esc(b.orderId)}" aria-label="Vorschau Auftrag ${esc(b.nr)}" title="Vorschau">${C.icon.pdf}</button>` : ''}
          </div>`).join('')}
        </div>
        <div id="calc"></div>
        <form class="card form" id="f" novalidate>
          <div class="two-col">
            ${C.field({ id: 'no', label: 'Erste Rechnungsnummer', value: store.nextInvoiceNo(), attrs: 'inputmode="numeric" autocomplete="off"' })}
            <div class="field"><label for="date">Rechnungsdatum</label><input id="date" class="input" type="date" value="${defDate}"></div>
          </div>
          <p class="hint" id="no-hint" style="margin-top:-8px"></p>
          <div class="field" style="margin-top:14px"><label for="extra">Zeile über den Positionen <span class="opt">optional</span></label>
            <input id="extra" class="input" autocomplete="off" placeholder="z. B. Abrechnungsmonat: ${esc(monthLabel(monthOf(from)))}"></div>
          <div class="field"><label for="note">Hinweis unter der Rechnung <span class="opt">optional</span></label>
            <textarea id="note" class="input textarea" rows="2" placeholder="z. B. Preiserhöhung …"></textarea>
            <p class="hint">Darüber steht immer: „${esc(PAYMENT_TEXT)}“</p></div>
          <p class="form-error" id="err" role="alert"></p>
          <button class="btn btn-primary btn-block" type="submit" id="create">${C.icon.check}<span>Rechnungen erstellen</span></button>
          <p class="hint center" id="create-hint" style="margin:10px 8px 0"></p>
        </form>
        <div id="pdf-box" class="file-view is-pdf" hidden></div>`
      : C.emptyBox('Nichts abzurechnen', `Im Zeitraum ${C.fmtDay(from)} – ${C.fmtDay(to)} gibt es keine offenen Lieferscheine.`)}`,
    mount(root) {
      const range = () => {
        const f = $('#von', root).value;
        const t = $('#bis', root).value;
        if (C.isIsoDate(f) && C.isIsoDate(t) && f <= t) C.replace(`#/rechnung/neu?von=${f}&bis=${t}`);
      };
      $('#von', root).addEventListener('change', range);
      $('#bis', root).addEventListener('change', range);
      if (!batches.length) return;

      const chosen = () => batches.filter((b) => $(`[data-o="${CSS.escape(b.orderId)}"]`, root)?.checked);
      const startNo = () => Number($('#no', root).value.replace(/\D/g, '')) || 0;
      const fields = () => ({
        date: $('#date', root).value, from, to,
        extraLine: $('#extra', root).value.trim(), note: $('#note', root).value.trim(),
      });
      const draw = () => {
        const list = chosen();
        const okAll = batches.filter((b) => b.ok);
        const all = $('#all', root);
        all.checked = list.length === okAll.length && okAll.length > 0;
        all.indeterminate = list.length > 0 && list.length < okAll.length;
        const netto = store.round2(list.reduce((s, b) => s + b.calc.netto, 0));
        const brutto = store.round2(list.reduce((s, b) => s + b.calc.brutto, 0));
        $('#calc', root).innerHTML = `<div class="card kpis calc-sum">
          <div class="kpi"><span>Rechnungen</span><b>${list.length}</b></div>
          <div class="kpi"><span>Netto / Brutto</span><b>${eur(netto)}</b><small>${eur(brutto)} brutto</small></div></div>`;
        const s = startNo();
        $('#no-hint', root).textContent = list.length && String(s).length === 8
          ? `Nummern ${invNo(s)}${list.length > 1 ? ` – ${invNo(s + list.length - 1)}` : ''} (in der Reihenfolge der Aufträge). Bitte prüfen – derselbe Nummernkreis wird auch für andere BO-WERT-Rechnungen benutzt.`
          : 'Bitte prüfen – derselbe Nummernkreis wird auch für andere BO-WERT-Rechnungen benutzt.';
        const btn = $('#create', root);
        btn.disabled = !list.length;
        btn.innerHTML = `${C.icon.check}<span>${list.length === 1 ? 'Rechnung erstellen & herunterladen' : `${list.length || ''} Rechnungen erstellen & als ZIP herunterladen`}</span>`;
        $('#create-hint', root).textContent = list.length ? `Je Rechnung eine PDF: Rechnung + Lieferscheine des Auftrags.` : 'Bitte mindestens einen Auftrag auswählen.';
      };
      $('#pick', root).addEventListener('change', (e) => {
        if (e.target.id === 'all') $$('[data-o]', root).forEach((c) => { if (!c.disabled) c.checked = e.target.checked; });
        draw();
      });
      $('#no', root).addEventListener('input', draw);
      draw();

      // Vorschau einer einzelnen Rechnung (nur die Rechnungsseite)
      const box = $('#pdf-box', root);
      $('#pick', root).addEventListener('click', async (e) => {
        const p = e.target.closest('[data-prev]');
        if (!p) return;
        const b = batches.find((x) => x.orderId === p.dataset.prev);
        const idx = Math.max(0, chosen().indexOf(b));
        box.hidden = false;
        box.innerHTML = '<div class="loading"><span class="spinner"></span>Vorschau wird erstellt …</div>';
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        try {
          const bytes = await invoicePdf({ no: String(startNo() + idx).padStart(8, '0'), type: 'rechnung', ...fields(), ...b.calc });
          if (C.currentView() !== view) return;
          box.innerHTML = `<p class="archive-label">Vorschau Auftrag ${esc(b.nr)} (nur Rechnungsseite)</p>`;
          await renderPdf(new Blob([bytes], { type: 'application/pdf' }), box, () => C.currentView() === view);
        } catch (ex) { box.innerHTML = `<p class="empty-inline pad">${esc(ex.message)}</p>`; }
      });

      $('#f', root).addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('#create', root);
        const err = $('#err', root);
        err.textContent = '';
        const list = chosen();
        if (!list.length) { err.textContent = 'Bitte mindestens einen Auftrag auswählen.'; return; }
        const progress = (t) => { btn.innerHTML = `<span class="spinner small"></span><span>${esc(t)}</span>`; };
        btn.disabled = true;
        const created = [];
        try {
          const start = startNo();
          for (let i = 0; i < list.length; i++) store.checkInvoiceNo(start + i); // alle Nummern frei?
          // Lieferscheine, deren aktuelle Fassung noch nicht im Archiv liegt, zuerst archivieren
          const toArchive = list.flatMap((b) => b.list).filter(needsArchive);
          for (let i = 0; i < toArchive.length; i += 40) {
            progress(`Lieferscheine archivieren … ${Math.min(i + 40, toArchive.length)}/${toArchive.length}`);
            await store.archiveNotes(await Promise.all(toArchive.slice(i, i + 40).map(C.notePdf)), '');
          }
          for (let i = 0; i < list.length; i++) {
            progress(`Rechnung ${i + 1} von ${list.length} …`);
            const inv = await store.createInvoice({ no: String(start + i), ...fields(), list: list[i].list });
            const bytes = await invoicePdf(inv);
            pageCache.set(inv.id, bytes);
            await store.saveInvoicePdf(inv.id, bytes);
            created.push(inv);
          }
        } catch (ex) {
          console.error(ex);
          err.textContent = created.length
            ? `Nach ${plural(created.length, 'Rechnung', 'Rechnungen')} abgebrochen: ${ex.message}`
            : ex.message;
        }
        if (created.length) {
          try {
            const file = created.length === 1
              ? await invoiceFile(created[0])
              : await zipInvoices(created, `Rechnungen_${from}_${to}.zip`, (i) => progress(`ZIP wird erstellt … ${i}/${created.length}`));
            await C.shareOrDownload(file, { title: file.name.replace(/\.(pdf|zip)$/, '') });
          } catch (ex) {
            if (ex.name !== 'AbortError') toast(`Download fehlgeschlagen: ${ex.message} – die Rechnungen sind gespeichert.`, 'error');
          }
          toast(created.length === 1 ? `Rechnung ${invNo(created[0].no)} erstellt`
            : `${created.length} Rechnungen erstellt (${invNo(created[0].no)} – ${invNo(created[created.length - 1].no)})`);
          if (!err.textContent) C.replace(created.length === 1 ? `#/rechnung/${created[0].id}` : '#/rechnungen');
          else C.replace(`#/rechnung/neu?von=${from}&bis=${to}`);
          return;
        }
        draw();
      });
    },
  };
  return view;
}

// ---------- PDF: Rechnung (+ Lieferscheine) ----------

const fileName = (inv) => `${inv.type === 'storno' ? 'Stornorechnung' : 'Rechnung'}_${String(inv.no).slice(0, 4)}-${String(inv.no).slice(4)}`
  + `${inv.orderNrs?.length === 1 ? `_${inv.orderNrs[0]}` : ''}.pdf`;

const pageCache = new Map(); // gerade erzeugte Rechnungsseiten (spart das Nachladen beim ZIP)

/** Rechnungsseite aus dem Archiv – fehlt sie (z. B. Abbruch beim Erstellen), aus den eingefrorenen Daten erzeugen und ablegen. */
async function invoicePage(inv) {
  if (pageCache.has(inv.id)) return pageCache.get(inv.id);
  let bytes = await store.loadInvoicePdf(inv.id).catch(() => null);
  if (!bytes) {
    const ref = inv.refNo ? store.getInvoice(inv.refNo) : null;
    bytes = await invoicePdf({ ...inv, refDate: ref?.date });
    await store.saveInvoicePdf(inv.id, bytes);
  }
  return bytes;
}

/** Eine Datei: Rechnung, dahinter genau die archivierten Lieferscheine (Storno: nur die Stornorechnung). */
async function invoiceFile(inv) {
  const parts = [await invoicePage(inv)];
  if (inv.type !== 'storno') {
    for (const r of inv.deliveries) parts.push(await store.loadArchivedPdf(r.id, r.v));
  }
  const bytes = parts.length > 1 ? await mergePdfs(parts) : parts[0];
  return new File([bytes], fileName(inv), { type: 'application/pdf' });
}

/** Mehrere Rechnungen (je eine PDF mit Lieferscheinen) als ZIP. */
async function zipInvoices(invs, name, onProgress = () => {}) {
  const fflate = await loadFflate();
  const entries = {};
  for (let i = 0; i < invs.length; i++) {
    onProgress(i + 1);
    const f = await invoiceFile(invs[i]);
    entries[f.name] = [new Uint8Array(await f.arrayBuffer()), { level: 0 }];
  }
  return new File([fflate.zipSync(entries)], name, { type: 'application/zip' });
}

// ---------- Eine Rechnung ----------

let previewInv = null;

function viewInvoice(id) {
  const inv = store.getInvoice(id);
  if (!inv) return C.notFound('Rechnung');
  const storno = inv.type === 'storno';
  const kv = (k, v) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`;
  const ref = storno ? store.getInvoice(inv.refNo) : null;
  const stornoInv = inv.stornoNo ? store.getInvoice(inv.stornoNo) : null;
  const view = {
    title: storno ? 'Stornorechnung' : 'Rechnung',
    back: '#/rechnungen',
    tab: 'rechnungen',
    html: `
      <div class="detail-head">
        <span class="eyebrow">${storno ? 'Stornorechnung' : 'Rechnung'}</span>
        <div class="detail-title">Nr. ${esc(invNo(inv.no))} ${STATUS_TAG(inv)}</div>
        <div class="detail-sub">${esc(C.dayLabel(inv.date))}</div>
      </div>
      ${inv.status === 'storniert' ? `<p class="notice">Storniert mit ${stornoInv ? `<a href="#/rechnung/${stornoInv.id}">Stornorechnung ${esc(invNo(inv.stornoNo))}</a>` : `Stornorechnung ${esc(invNo(inv.stornoNo))}`}. Die Lieferscheine sind wieder frei zum Abrechnen.</p>` : ''}
      ${storno ? `<p class="notice notice-soft">Storniert die ${ref ? `<a href="#/rechnung/${ref.id}">Rechnung ${esc(invNo(inv.refNo))}</a>` : `Rechnung ${esc(invNo(inv.refNo))}`}.</p>` : ''}
      <div class="card kvs">
        ${kv('Zeitraum', `${C.fmtDay(inv.from)} – ${C.fmtDay(inv.to)}`)}
        ${kv('Lieferdatum', C.fmtDay(inv.lieferdatum))}
        ${kv(inv.orderNrs.length > 1 ? 'Aufträge' : 'Auftrag', esc(inv.orderNrs.join(', ')))}
        ${kv('Bestellnummer', esc(inv.bestellnrs.join(', ')) || '<span class="muted">–</span>')}
        ${kv('Netto', eur(inv.netto))}
        ${kv('USt. 19 %', eur(inv.ust))}
        ${kv('Gesamtbetrag', `<b>${eur(inv.brutto)}</b>`)}
      </div>
      ${C.sectionTitle('Positionen', inv.items.length)}
      <div class="card table-card"><table class="tbl">
        <thead><tr><th>Text</th><th class="num">Satz</th><th class="num">Betrag</th></tr></thead>
        <tbody>${inv.items.map((i) => `<tr><td>${esc(i.text)}<small>${priceText(i.price)} pro Satz</small></td>
          <td class="num">${C.fmtN(i.qty)}</td><td class="num">${eur(i.total)}</td></tr>`).join('')}</tbody></table></div>
      <button type="button" class="btn btn-primary btn-block" id="download">${C.icon.download}<span>PDF herunterladen${storno ? '' : ` (mit ${plural(inv.deliveries.length, 'Lieferschein', 'Lieferscheinen')})`}</span></button>
      <button type="button" class="btn btn-secondary btn-block" id="preview">${previewInv === inv.id ? 'Vorschau schließen' : 'Vorschau'}</button>
      <div id="pdf-box" class="file-view is-pdf" ${previewInv === inv.id ? '' : 'hidden'}></div>
      ${C.sectionTitle('Lieferscheine', inv.deliveries.length)}
      <ul class="card list">${inv.deliveries.map((r) => C.row({
        href: `#/lieferschein/${r.id}`,
        title: `Nr. ${esc(r.no)}`,
        sub: esc(`${C.fmtDay(r.date)} · Auftrag ${r.orderNr} · ${C.fmtN(r.qty)} Satz${r.v > 1 ? ` · Fassung ${r.v}` : ''}`),
      })).join('')}</ul>
      ${!storno && inv.status !== 'storniert' ? `
        <button type="button" class="btn btn-danger btn-block" id="storno-open">Rechnung stornieren</button>
        <form class="card form" id="storno" hidden novalidate>
          <p style="margin-top:0">Es wird eine <b>Stornorechnung</b> mit eigener Nummer erstellt (negative Beträge). Die Lieferscheine werden wieder frei und können neu abgerechnet werden.</p>
          <div class="two-col">
            ${C.field({ id: 'sno', label: 'Nummer der Stornorechnung', value: store.nextInvoiceNo(), attrs: 'inputmode="numeric" autocomplete="off"' })}
            <div class="field"><label for="sdate">Datum</label><input id="sdate" class="input" type="date" value="${store.localDate()}"></div>
          </div>
          <p class="form-error" id="serr" role="alert"></p>
          <button class="btn btn-danger btn-block" type="submit">Stornieren & Stornorechnung herunterladen</button>
        </form>` : ''}`,
    mount(root) {
      const box = $('#pdf-box', root);
      const showPreview = async () => {
        box.innerHTML = '<div class="loading"><span class="spinner"></span>PDF wird geladen …</div>';
        try {
          const file = await invoiceFile(inv);
          if (C.currentView() !== view) return;
          box.innerHTML = '';
          await renderPdf(file, box, () => C.currentView() === view);
        } catch (ex) { box.innerHTML = `<p class="empty-inline pad">${esc(ex.message)}</p>`; }
      };
      if (previewInv === inv.id) showPreview();
      $('#preview', root).addEventListener('click', (e) => {
        previewInv = previewInv === inv.id ? null : inv.id;
        box.hidden = previewInv !== inv.id;
        e.currentTarget.textContent = previewInv === inv.id ? 'Vorschau schließen' : 'Vorschau';
        if (previewInv === inv.id) showPreview();
      });
      $('#download', root).addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const label = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner small"></span><span>PDF wird erstellt …</span>';
        try {
          const file = await invoiceFile(inv);
          await C.shareOrDownload(file, { title: file.name.replace(/\.pdf$/, '') });
        } catch (ex) {
          if (ex.name !== 'AbortError') toast(`PDF fehlgeschlagen: ${ex.message}`, 'error');
        } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = label; } }
      });
      $('#storno-open', root)?.addEventListener('click', (e) => {
        e.currentTarget.hidden = true;
        $('#storno', root).hidden = false;
        $('#sno', root).focus();
      });
      $('#storno', root)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!confirm(`Rechnung ${invNo(inv.no)} wirklich stornieren?`)) return;
        const btn = e.currentTarget.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const s = await store.cancelInvoice(inv.id, { no: $('#sno', root).value, date: $('#sdate', root).value });
          const file = await invoiceFile(s);
          toast(`Rechnung ${invNo(inv.no)} storniert`);
          C.replace(`#/rechnung/${s.id}`);
          await C.shareOrDownload(file, { title: file.name.replace(/\.pdf$/, '') }).catch(() => {});
        } catch (ex) {
          $('#serr', root).textContent = ex.message;
          btn.disabled = false;
        }
      });
    },
  };
  return view;
}

// ======================================================================

/** Routen der Abrechnung; ctx = Bausteine aus app.js. */
export function billingRoutes(ctx, route, ID, Q) {
  C = ctx;
  return [
    [route(`umsatz${Q}`), (q) => viewRevenue(q)],
    [route('preise'), () => viewPrices()],
    [route('rechnungen'), () => viewInvoices()],
    [route(`rechnung/neu${Q}`), (q) => viewInvoiceNew(q)],
    [route(`rechnung/${ID}`), (id) => viewInvoice(id)],
  ];
}
