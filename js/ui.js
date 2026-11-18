// Kleine UI-Helfer: DOM, Escaping, Sortierung, Icons, Hinweise, Vorschlagslisten.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Für Vergleiche: getrimmt, klein geschrieben. */
export const norm = (v) => String(v ?? '').trim().toLocaleLowerCase('de');
/** Nur Buchstaben und Ziffern – damit findet „202878“ auch „630-202878X“. */
export const compact = (v) => norm(v).replace(/[^\p{L}\p{N}]/gu, '');

/** Natürliche Sortierung: „R2“ vor „R10“. */
export const natCmp = (a, b) =>
  String(a ?? '').localeCompare(String(b ?? ''), 'de', { numeric: true, sensitivity: 'base' });

/** Lagerorte sortieren, leere ans Ende. */
export const locCmp = (a, b) => (!a && !b ? 0 : !a ? 1 : !b ? -1 : natCmp(a, b));

/**
 * Liefert eine Bewertungsfunktion für einen Suchbegriff:
 * 3 = exakt, 2 = beginnt mit, 1 = enthält, 0 = kein Treffer.
 */
export function matcher(query) {
  const n = norm(query);
  const c = compact(query);
  return (value) => {
    if (!n || !value) return 0;
    const nv = norm(value);
    const cv = compact(value);
    if (nv === n || (c && cv === c)) return 3;
    if (nv.startsWith(n) || (c && cv.startsWith(c))) return 2;
    if (nv.includes(n) || (c && cv.includes(c))) return 1;
    return 0;
  };
}

/** „2“ → „2×“, freie Angaben wie „1 je 10 Stk“ bleiben wie sie sind. */
export const qtyLabel = (q) => (!q ? '' : /^\d+([.,]\d+)?$/.test(q) ? `${q}×` : q);

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

let toastTimer = 0;
/** Kurzer Hinweis unten. Optional mit Aktion, z. B. { label: 'Rückgängig', run: () => … }. */
export function toast(message, kind = 'ok', action = null) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  el.dataset.kind = kind;
  el.classList.toggle('has-action', Boolean(action));
  el.classList.add('show');
  if (action) {
    el.querySelector('button').onclick = () => {
      el.classList.remove('show');
      action.run();
    };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5000 : action ? 4000 : 2200);
}

// ---------- Icons (inline SVG, Strich-Stil) ----------

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
export const icon = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>'),
  orders: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9zM9 11h6M9 15h6"/>'),
  article: svg('<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>'),
  material: svg('<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>'),
  more: svg('<circle cx="5" cy="12" r="1.7" class="fill"/><circle cx="12" cy="12" r="1.7" class="fill"/><circle cx="19" cy="12" r="1.7" class="fill"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
  back: svg('<path d="m15 5-7 7 7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: svg('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  logout: svg('<path d="M10 17l5-5-5-5M15 12H3M13 4h6v16h-6"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  take: svg('<path d="M4 8h16v12H4z"/><path d="M4 8l2-4h12l2 4M12 17v-6M9.5 13.5 12 11l2.5 2.5"/>'),
  cart: svg('<path d="M3 4h2l2.4 11h10.2L20 7H6.2"/><circle cx="9" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  share: svg('<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v8h14v-8"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  send: svg('<path d="M3.5 11.5 20.5 4l-6 16.5-3.2-6.8z"/><path d="m11.3 13.7 9.2-9.7"/>'),
  delivery: svg('<path d="M3 6h11v10H3zM14 9.5h4l3 3.5v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17.5" cy="17.5" r="1.8"/>'),
  next: svg('<path d="M4 12h11M10 6.5l5.5 5.5-5.5 5.5M20 5v14"/>'),
  camera: svg('<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/>'),
  pdf: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12.5h6M9 16h6"/>'),
  clip: svg('<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5"/>'),
  chart: svg('<path d="M4 20h16"/><path d="M7 16v-4M12 16V6M17 16V9"/>'),
  invoice: svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
  cloudOff: svg('<path d="m3 3 18 18M8.5 8.6A5 5 0 0 0 6.5 18H17m3.4-1.7A4 4 0 0 0 17 10h-.6A6 6 0 0 0 10 6.3"/>'),
};

// ---------- Vorschlagsliste unter Eingabefeldern ----------
// Zuverlässiger und besser lesbar als <datalist> auf iOS/Android.

/**
 * @param {HTMLInputElement} input  muss in einem `.suggest-wrap` liegen
 * @param {{source: (q: string) => Array<{label: string, sub?: string}>, onPick: (item: any) => void, max?: number}} opts
 */
export function attachSuggest(input, { source, onPick, max = 8 }) {
  const wrap = input.closest('.suggest-wrap');
  const list = document.createElement('div');
  list.className = 'suggest';
  list.hidden = true;
  list.setAttribute('role', 'listbox');
  wrap.append(list);

  let items = [];
  const close = () => { list.hidden = true; };
  const update = () => {
    items = document.activeElement === input ? source(input.value).slice(0, max) : [];
    if (!items.length) return close();
    list.innerHTML = items.map((it, i) => `
      <button type="button" class="suggest-item" role="option" data-i="${i}">
        <span class="suggest-label">${esc(it.label)}</span>
        ${it.sub ? `<span class="suggest-sub">${esc(it.sub)}</span>` : ''}
      </button>`).join('');
    list.hidden = false;
  };

  input.addEventListener('input', update);
  input.addEventListener('focus', update);
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // Fokus im Eingabefeld halten, damit der Tipp auf einen Vorschlag ankommt.
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.suggest-item');
    if (!btn) return;
    const item = items[Number(btn.dataset.i)];
    close();
    onPick(item);
  });
  return { close, refresh: update };
}
